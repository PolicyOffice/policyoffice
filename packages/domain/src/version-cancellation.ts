import {
  emitAuditEvents,
  type AuditActorType,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";
import {
  AuthzContext,
  decide as decideAuthorization,
  type DecisionReason,
} from "./authorization.js";
import {
  DocumentVersionConcurrencyError,
  DocumentVersionLifecycleError,
  DocumentVersionNotFoundError,
  VERSION_REQUIRED_CAPABILITIES,
  type VersionLifecycle,
} from "./version.js";

interface CancellationAuditContext {
  readonly actor: Readonly<{ type: AuditActorType; id: string | null }>;
  readonly configurationVersionId: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly correlationId: string;
  readonly sourceChannel: AuditSourceChannel;
}

export interface CancelDocumentVersionInput extends CancellationAuditContext {
  readonly tenantId: string;
  readonly versionId: string;
  readonly expectedRowVersion: number;
  readonly cancellationReason: string;
}

export interface CancelledDocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly documentVariantId: string;
  readonly previousLifecycleState: "DRAFT" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED";
  readonly lifecycleState: "CANCELLED";
  readonly cancelledAt: Date;
  readonly cancellationReason: string;
  readonly rowVersion: number;
  readonly cancelledApprovalRunId: string | null;
  readonly emittedEvents: readonly EmittedAuditEvent[];
}

interface LockedVersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  document_variant_id: string;
  lifecycle_state: VersionLifecycle;
  row_version: number;
}

interface ActiveRunRow extends Record<string, unknown> {
  id: string;
  status: "RUNNING" | "BLOCKED";
}

interface CancelledVersionRow extends Record<string, unknown> {
  id: string;
  lifecycle_state: "CANCELLED";
  cancelled_at: Date;
  cancellation_reason: string;
  row_version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);
const CANCELLABLE_STATES = new Set<VersionLifecycle>([
  "DRAFT",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
]);

export class DocumentVersionCancellationUnauthorizedError extends Error {
  constructor(readonly because: DecisionReason) {
    super("the principal cannot cancel this document version");
    this.name = "DocumentVersionCancellationUnauthorizedError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function validateInput(
  authorizationContext: AuthzContext,
  input: CancelDocumentVersionInput,
): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.versionId, "versionId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!Number.isInteger(input.expectedRowVersion) || input.expectedRowVersion < 1) {
    throw new TypeError("expectedRowVersion must be a positive integer");
  }
  if (input.cancellationReason.trim().length === 0) {
    throw new TypeError("cancellationReason is required");
  }
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.valueOf())) {
    throw new TypeError("occurredAt must be a valid Date");
  }
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
  if (!(authorizationContext instanceof AuthzContext)) {
    throw new TypeError("authorizationContext must be an AuthzContext");
  }
  if (authorizationContext.tenantId !== input.tenantId) {
    throw new DocumentVersionCancellationUnauthorizedError("WRONG_TENANT");
  }
  if (
    authorizationContext.principal.type !== input.actor.type ||
    authorizationContext.principal.id !== input.actor.id
  ) {
    throw new DocumentVersionCancellationUnauthorizedError("NO_GRANT");
  }
}

async function lockVersion(
  transaction: AuditTransaction,
  tenantId: string,
  versionId: string,
): Promise<LockedVersionRow> {
  const result = await transaction.query<LockedVersionRow>(
    `select version.id, variant.document_id, version.document_variant_id,
            version.lifecycle_state, version.row_version
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where version.tenant_id = $1::uuid and version.id = $2::uuid
      for update of version`,
    [tenantId, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new DocumentVersionNotFoundError();
  return row;
}

async function lockActiveRun(
  transaction: AuditTransaction,
  tenantId: string,
  versionId: string,
): Promise<ActiveRunRow | null> {
  const result = await transaction.query<ActiveRunRow>(
    `select run.id, run.status
       from approval_run run
       join content_revision revision
         on revision.tenant_id = run.tenant_id
        and revision.id = run.content_revision_id
      where run.tenant_id = $1::uuid
        and revision.document_version_id = $2::uuid
        and run.status in ('RUNNING', 'BLOCKED')
      for update of run`,
    [tenantId, versionId],
  );
  return result.rows[0] ?? null;
}

function auditBase(input: CancelDocumentVersionInput) {
  return {
    tenantId: input.tenantId,
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    documentVersionId: input.versionId,
    outcome: "SUCCESS" as const,
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    configurationVersionId: input.configurationVersionId,
  };
}

/** Cancel one pre-release version and every open artifact in its active run atomically. */
export async function cancelDocumentVersion(
  transaction: AuditTransaction,
  authorizationContext: AuthzContext,
  input: CancelDocumentVersionInput,
): Promise<CancelledDocumentVersion> {
  validateInput(authorizationContext, input);
  const version = await lockVersion(transaction, input.tenantId, input.versionId);
  const authorization = await decideAuthorization(
    authorizationContext,
    VERSION_REQUIRED_CAPABILITIES.cancel,
    { tenantId: input.tenantId, type: "DOCUMENT_VERSION", id: input.versionId },
  );
  if (!authorization.allowed) {
    throw new DocumentVersionCancellationUnauthorizedError(authorization.because);
  }
  if (version.row_version !== input.expectedRowVersion) {
    throw new DocumentVersionConcurrencyError();
  }
  if (!CANCELLABLE_STATES.has(version.lifecycle_state)) {
    throw new DocumentVersionLifecycleError();
  }

  const cancellationReason = input.cancellationReason.trim();
  const activeRun = await lockActiveRun(transaction, input.tenantId, input.versionId);
  if (activeRun) {
    await transaction.query(
      `update approval_task task
          set status = 'CANCELLED', row_version = task.row_version + 1
        from approval_stage stage
       where task.tenant_id = $1::uuid
         and stage.tenant_id = task.tenant_id
         and stage.id = task.approval_stage_id
         and stage.approval_run_id = $2::uuid
         and task.status in ('PENDING', 'UNRESOLVABLE')`,
      [input.tenantId, activeRun.id],
    );
    await transaction.query(
      `update approval_stage
          set status = 'CANCELLED', row_version = row_version + 1
        where tenant_id = $1::uuid
          and approval_run_id = $2::uuid
          and status in ('PENDING', 'IN_PROGRESS', 'BLOCKED')`,
      [input.tenantId, activeRun.id],
    );
    await transaction.query(
      `update approval_run
          set status = 'CANCELLED', completed_at = $3::timestamptz,
              cancelled_reason = $4::text, row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid and status = $5::run_status`,
      [
        input.tenantId,
        activeRun.id,
        input.occurredAt.toISOString(),
        cancellationReason,
        activeRun.status,
      ],
    );
  }

  const cancelledResult = await transaction.query<CancelledVersionRow>(
    `update document_version
        set lifecycle_state = 'CANCELLED', cancelled_at = $3::timestamptz,
            cancellation_reason = $4::text, row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid
        and lifecycle_state = $5::version_lifecycle
      returning id, lifecycle_state, cancelled_at, cancellation_reason, row_version`,
    [
      input.tenantId,
      input.versionId,
      input.occurredAt.toISOString(),
      cancellationReason,
      version.lifecycle_state,
    ],
  );
  const cancelled = cancelledResult.rows[0];
  if (!cancelled) throw new DocumentVersionLifecycleError();

  const base = auditBase(input);
  const events: AuditEventInput[] = [
    {
      ...base,
      eventType: "version.cancelled",
      subject: { type: "DOCUMENT_VERSION", id: input.versionId },
      documentId: version.document_id,
      documentVariantId: version.document_variant_id,
      action: "CANCEL_DOCUMENT_VERSION",
      safeBefore: { lifecycleState: version.lifecycle_state },
      safeAfter: {
        lifecycleState: "CANCELLED",
        cancelledAt: cancelled.cancelled_at.toISOString(),
        cancellationReason,
      },
      dedupeKey: `version.cancelled:${input.versionId}`,
    },
  ];
  if (activeRun) {
    events.push({
      ...base,
      eventType: "approval_run.cancelled",
      subject: { type: "APPROVAL_RUN", id: activeRun.id },
      documentId: version.document_id,
      documentVariantId: version.document_variant_id,
      action: "CANCEL_APPROVAL_RUN",
      safeBefore: { status: activeRun.status },
      safeAfter: { status: "CANCELLED", cancellationReason },
      dedupeKey: `approval_run.cancelled:${activeRun.id}`,
    });
  }
  const emittedEvents = await emitAuditEvents(transaction, events);

  return Object.freeze({
    id: cancelled.id,
    documentId: version.document_id,
    documentVariantId: version.document_variant_id,
    previousLifecycleState:
      version.lifecycle_state as CancelledDocumentVersion["previousLifecycleState"],
    lifecycleState: cancelled.lifecycle_state,
    cancelledAt: cancelled.cancelled_at,
    cancellationReason: cancelled.cancellation_reason,
    rowVersion: cancelled.row_version,
    cancelledApprovalRunId: activeRun?.id ?? null,
    emittedEvents: Object.freeze(emittedEvents),
  });
}
