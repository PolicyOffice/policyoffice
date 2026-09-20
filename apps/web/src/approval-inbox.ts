import { randomUUID } from "node:crypto";
import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  APPROVAL_DECISION_REQUIRED_CAPABILITIES,
  BODY_RESOLUTION_REQUIRED_CAPABILITIES,
  ApprovalBodyResolutionEvidenceError,
  ApprovalBodyResolutionRequiredError,
  ApprovalBodyResolutionUnauthorizedError,
  ApprovalRunNotRunningError,
  ApprovalStageNotInProgressError,
  ApprovalTaskNotFoundError,
  ApprovalTaskNotHeldError,
  ApprovalTaskNotPendingError,
  ApprovalVersionNotInReviewError,
  AuthzContext,
  decide,
  getApprovalInboxItem,
  listApprovalInbox,
  recordApprovalDecision,
  recordBodyResolution,
  type ApprovalDecisionKind,
  type ApprovalInboxItem,
} from "../../../packages/domain/src/index";

export interface ApprovalInboxHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface ApprovalInboxRequest {
  readonly sessionToken: string | undefined;
}

export interface ApprovalCandidateRequest extends ApprovalInboxRequest {
  readonly taskId: string;
}

export interface ApprovalDecisionRequest extends ApprovalCandidateRequest {
  readonly decision: string;
  readonly reasonCode: string | null;
  readonly resolutionReference: string | null;
  readonly resolutionDate: string | null;
  readonly minutesAttachmentId: string | null;
  readonly attendingMembers: readonly string[] | null;
}

export interface ApprovalCandidatePayload {
  readonly item: ApprovalInboxItem;
  readonly canDecide: boolean;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = new Set<ApprovalDecisionKind>(["APPROVE", "REQUEST_CHANGES", "REJECT"]);

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...RESPONSE_HEADERS, location } });
}

function parseDecision(value: string): ApprovalDecisionKind | null {
  return DECISIONS.has(value as ApprovalDecisionKind) ? (value as ApprovalDecisionKind) : null;
}

async function activeConfigurationVersionId(
  transaction: ApplicationTransaction,
  tenantId: string,
  instant: Date,
): Promise<string> {
  const { rows } = await transaction.query<IdRow>(
    `select id
       from configuration_version
      where tenant_id = $1::uuid and effective_from <= $2::timestamptz
      order by effective_from desc, sequence desc
      limit 1`,
    [tenantId, instant.toISOString()],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error("active configuration is unavailable");
  return row.id;
}

function authorizationContext(
  transaction: ApplicationTransaction,
  tenantId: string,
  instant: Date,
): AuthzContext {
  return new AuthzContext({
    tenantId,
    principal: transaction.context.principal,
    instant,
    load: authorizationDataLoader(transaction),
  });
}

function isStaleApprovalError(error: unknown): boolean {
  return (
    error instanceof ApprovalTaskNotFoundError ||
    error instanceof ApprovalTaskNotHeldError ||
    error instanceof ApprovalTaskNotPendingError ||
    error instanceof ApprovalStageNotInProgressError ||
    error instanceof ApprovalRunNotRunningError ||
    error instanceof ApprovalVersionNotInReviewError ||
    error instanceof ApprovalBodyResolutionRequiredError ||
    error instanceof ApprovalBodyResolutionUnauthorizedError
  );
}

/** Session-owned work needs no broad read capability and is filtered below the UI. */
export function createApprovalInboxHandler(
  options: ApprovalInboxHandlerOptions,
): (request: ApprovalInboxRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  return async (request) => {
    if (!request.sessionToken) return notFound();
    const instant = clock();
    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
      async (transaction) => {
        const context = authorizationContext(transaction, options.tenantId, instant);
        const items = await listApprovalInbox(transaction, context);
        return Response.json({ items }, { status: 200, headers: RESPONSE_HEADERS });
      },
    );
    return response ?? notFound();
  };
}

/** Resolve one owned candidate and separately decide whether controls may be shown. */
export function createApprovalCandidateHandler(
  options: ApprovalInboxHandlerOptions,
): (request: ApprovalCandidateRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.taskId)) return notFound();
    const instant = clock();
    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
      async (transaction) => {
        const context = authorizationContext(transaction, options.tenantId, instant);
        const item = await getApprovalInboxItem(transaction, context, request.taskId);
        if (!item) return notFound();
        const resource =
          item.task.participant.type === "USER"
            ? ({
                tenantId: options.tenantId,
                type: "DOCUMENT_VERSION" as const,
                id: item.version.id,
              } as const)
            : ({
                tenantId: options.tenantId,
                type: "GOVERNANCE_BODY" as const,
                id: item.task.participant.id,
              } as const);
        const capability =
          item.task.participant.type === "USER"
            ? APPROVAL_DECISION_REQUIRED_CAPABILITIES.record
            : BODY_RESOLUTION_REQUIRED_CAPABILITIES.record;
        const authorization = await decide(context, capability, resource);
        return Response.json(
          { item, canDecide: authorization.allowed } satisfies ApprovalCandidatePayload,
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );
    return response ?? notFound();
  };
}

/** Authorize at the route boundary, then delegate the atomic transition to the domain. */
export function createApprovalDecisionHandler(
  options: ApprovalInboxHandlerOptions,
): (request: ApprovalDecisionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.taskId)) return notFound();
    const decision = parseDecision(request.decision);
    if (!decision) return redirect(`/approvals/${request.taskId}?error=invalid`);

    const instant = clock();
    try {
      const response = await withTenantTransaction(
        { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
        async (transaction) => {
          if (transaction.context.principal.type !== "USER") return notFound();
          const context = authorizationContext(transaction, options.tenantId, instant);
          const item = await getApprovalInboxItem(transaction, context, request.taskId);
          if (!item) return notFound();
          if (
            item.task.status !== "PENDING" ||
            item.stage.status !== "IN_PROGRESS" ||
            item.run.status !== "RUNNING"
          ) {
            return notFound();
          }

          const principalId = transaction.context.principal.id;
          const resource =
            item.task.participant.type === "USER"
              ? ({
                  tenantId: options.tenantId,
                  type: "DOCUMENT_VERSION" as const,
                  id: item.version.id,
                } as const)
              : ({
                  tenantId: options.tenantId,
                  type: "GOVERNANCE_BODY" as const,
                  id: item.task.participant.id,
                } as const);
          const capability =
            item.task.participant.type === "USER"
              ? APPROVAL_DECISION_REQUIRED_CAPABILITIES.record
              : BODY_RESOLUTION_REQUIRED_CAPABILITIES.record;
          const authorization = await decide(context, capability, resource);
          if (!authorization.allowed) return notFound();

          const configurationVersionId = await activeConfigurationVersionId(
            transaction,
            options.tenantId,
            instant,
          );
          const requestId = idFactory();
          const correlationId = idFactory();

          if (item.task.participant.type === "USER") {
            await recordApprovalDecision(transaction, {
              tenantId: options.tenantId,
              approvalTaskId: item.task.id,
              decidingUserId: principalId,
              decision,
              reasonCode: request.reasonCode,
              actor: { type: "USER", id: principalId },
              configurationVersionId,
              occurredAt: instant,
              requestId,
              correlationId,
              sourceChannel: "WEB",
            });
          } else {
            await recordBodyResolution(transaction, context, {
              tenantId: options.tenantId,
              approvalTaskId: item.task.id,
              recordedByUserId: principalId,
              decision,
              reasonCode: request.reasonCode,
              resolutionReference: request.resolutionReference,
              resolutionDate: request.resolutionDate,
              minutesAttachmentId: request.minutesAttachmentId,
              attendingMembers: request.attendingMembers,
              configurationVersionId,
              occurredAt: instant,
              requestId,
              correlationId,
              sourceChannel: "WEB",
            });
          }

          return redirect(`/approvals?recorded=${decision}`);
        },
      );
      return response ?? notFound();
    } catch (error) {
      if (isStaleApprovalError(error)) return notFound();
      if (error instanceof ApprovalBodyResolutionEvidenceError || error instanceof TypeError) {
        return redirect(`/approvals/${request.taskId}?error=invalid`);
      }
      throw error;
    }
  };
}
