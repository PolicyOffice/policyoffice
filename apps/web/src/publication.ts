import { randomUUID } from "node:crypto";
import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  AuthzContext,
  DocumentVersionConcurrencyError,
  DocumentVersionLifecycleError,
  DocumentVersionNotFoundError,
  DocumentVersionPublicationDateError,
  DocumentVersionScheduleConflictError,
  PUBLICATION_REQUIRED_CAPABILITIES,
  decide,
  publishDocumentVersion,
} from "../../../packages/domain/src/index";

export interface PublicationHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface PublicationFormRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly versionId: string;
}

export interface PublishDocumentVersionRequest extends PublicationFormRequest {
  readonly expectedRowVersion: number;
  /** Null means the caller explicitly chose the authoritative request instant. */
  readonly effectiveFrom: Date | null;
}

export interface PublicationFormPayload {
  readonly documentCode: string;
  readonly versionTitle: string;
  readonly displayLabel: string | null;
  readonly expectedRowVersion: number;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface PublicationFormRow extends Record<string, unknown> {
  document_code: string;
  version_title: string;
  display_label: string | null;
  row_version: number;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: RESPONSE_HEADERS });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...RESPONSE_HEADERS, location } });
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

async function versionBelongsToDocument(
  transaction: ApplicationTransaction,
  tenantId: string,
  documentId: string,
  versionId: string,
): Promise<boolean> {
  const { rows } = await transaction.query<{ document_id: string } & Record<string, unknown>>(
    `select variant.document_id
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where version.tenant_id = $1::uuid and version.id = $2::uuid
        and variant.document_id = $3::uuid`,
    [tenantId, versionId, documentId],
  );
  return rows[0]?.document_id === documentId;
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

/** Read the exact APPROVED row version that the publication form will submit. */
export function createPublicationFormHandler(
  options: PublicationHandlerOptions,
): (request: PublicationFormRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId) || !UUID.test(request.versionId)) {
      return notFound();
    }
    const instant = clock();
    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
      async (transaction) => {
        const context = authorizationContext(transaction, options.tenantId, instant);
        const decision = await decide(context, PUBLICATION_REQUIRED_CAPABILITIES.publish, {
          tenantId: options.tenantId,
          type: "DOCUMENT_VERSION",
          id: request.versionId,
        });
        if (!decision.allowed) return notFound();

        const { rows } = await transaction.query<PublicationFormRow>(
          `select document.document_code,
                  version.title as version_title,
                  version.display_label,
                  version.row_version
             from document_version version
             join document_variant variant
               on variant.tenant_id = version.tenant_id
              and variant.id = version.document_variant_id
             join document
               on document.tenant_id = variant.tenant_id
              and document.id = variant.document_id
            where version.tenant_id = $1::uuid
              and version.id = $2::uuid
              and document.id = $3::uuid
              and version.lifecycle_state = 'APPROVED'`,
          [options.tenantId, request.versionId, request.documentId],
        );
        const row = rows[0];
        if (!row || rows.length !== 1) return notFound();
        return Response.json(
          {
            documentCode: row.document_code,
            versionTitle: row.version_title,
            displayLabel: row.display_label,
            expectedRowVersion: row.row_version,
          } satisfies PublicationFormPayload,
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );
    return response ?? notFound();
  };
}

/** Authorize once at the request boundary, then delegate the atomic transition and events. */
export function createPublishDocumentVersionHandler(
  options: PublicationHandlerOptions,
): (request: PublishDocumentVersionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId) || !UUID.test(request.versionId)) {
      return notFound();
    }
    const instant = clock();
    try {
      const response = await withTenantTransaction(
        { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
        async (transaction) => {
          if (transaction.context.principal.type !== "USER") return notFound();
          const context = authorizationContext(transaction, options.tenantId, instant);
          const decision = await decide(context, PUBLICATION_REQUIRED_CAPABILITIES.publish, {
            tenantId: options.tenantId,
            type: "DOCUMENT_VERSION",
            id: request.versionId,
          });
          if (!decision.allowed) return notFound();
          if (
            !(await versionBelongsToDocument(
              transaction,
              options.tenantId,
              request.documentId,
              request.versionId,
            ))
          ) {
            return notFound();
          }

          const configurationVersionId = await activeConfigurationVersionId(
            transaction,
            options.tenantId,
            instant,
          );
          await publishDocumentVersion(transaction, {
            tenantId: options.tenantId,
            versionId: request.versionId,
            expectedRowVersion: request.expectedRowVersion,
            effectiveFrom: request.effectiveFrom ?? instant,
            actor: { type: "USER", id: transaction.context.principal.id },
            configurationVersionId,
            occurredAt: instant,
            requestId: idFactory(),
            correlationId: idFactory(),
            sourceChannel: "WEB",
          });
          return redirect(`/author/documents/${request.documentId}/versions/${request.versionId}`);
        },
      );
      return response ?? notFound();
    } catch (error) {
      if (error instanceof DocumentVersionNotFoundError) return notFound();
      if (error instanceof DocumentVersionConcurrencyError) return failure(409, "conflict");
      if (error instanceof DocumentVersionLifecycleError) {
        return failure(409, "invalid_lifecycle");
      }
      if (error instanceof DocumentVersionPublicationDateError) {
        return failure(422, "retroactive_effective_from");
      }
      if (error instanceof DocumentVersionScheduleConflictError) {
        return failure(409, "schedule_conflict");
      }
      if (error instanceof TypeError) return failure(400, "invalid_request");
      throw error;
    }
  };
}
