import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  AuthzContext,
  DOCUMENT_REQUIRED_CAPABILITIES,
  PUBLICATION_REQUIRED_CAPABILITIES,
  decide,
  listDocumentRegister,
} from "../../../packages/domain/src/index";

export interface DocumentRegisterRequest {
  readonly sessionToken: string | undefined;
}

export interface DocumentRegisterHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
}

export interface PublicationCandidate {
  readonly documentId: string;
  readonly versionId: string;
  readonly documentCode: string;
  readonly versionTitle: string;
  readonly displayLabel: string | null;
}

interface PublicationCandidateRow extends Record<string, unknown> {
  document_id: string;
  version_id: string;
  document_code: string;
  version_title: string;
  display_label: string | null;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

async function publicationCandidates(
  transaction: ApplicationTransaction,
  context: AuthzContext,
  tenantId: string,
): Promise<readonly PublicationCandidate[]> {
  const { rows } = await transaction.query<PublicationCandidateRow>(
    `select document.id as document_id,
            version.id as version_id,
            document.document_code,
            version.title as version_title,
            version.display_label
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
       join document
         on document.tenant_id = variant.tenant_id
        and document.id = variant.document_id
      where version.tenant_id = $1::uuid
        and version.lifecycle_state = 'APPROVED'
      order by document.document_code, version.version_sequence`,
    [tenantId],
  );
  const visible: PublicationCandidate[] = [];
  for (const row of rows) {
    const decision = await decide(context, PUBLICATION_REQUIRED_CAPABILITIES.publish, {
      tenantId,
      type: "DOCUMENT_VERSION",
      id: row.version_id,
    });
    if (decision.allowed) {
      visible.push({
        documentId: row.document_id,
        versionId: row.version_id,
        documentCode: row.document_code,
        versionTitle: row.version_title,
        displayLabel: row.display_label,
      });
    }
  }
  return visible;
}

/** Authorize the create form itself without accidentally requiring document.read. */
export function createDocumentFormHandler(
  options: DocumentRegisterHandlerOptions,
): (request: DocumentRegisterRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    if (!request.sessionToken) return notFound();
    const instant = clock();
    const response = await withTenantTransaction(
      { tenantId: options.tenantId, sessionToken: request.sessionToken, instant },
      async (transaction) => {
        const context = new AuthzContext({
          tenantId: options.tenantId,
          principal: transaction.context.principal,
          instant,
          load: authorizationDataLoader(transaction),
        });
        const decision = await decide(context, DOCUMENT_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "TENANT",
          id: null,
        });
        return decision.allowed
          ? Response.json({ allowed: true }, { status: 200, headers: RESPONSE_HEADERS })
          : notFound();
      },
    );
    return response ?? notFound();
  };
}

/** The framework-neutral request boundary exercised directly against app_role in tests. */
export function createDocumentRegisterHandler(
  options: DocumentRegisterHandlerOptions,
): (request: DocumentRegisterRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    // Session expiry and grant validity must observe one fixed request instant.
    const instant = clock();
    if (request.sessionToken === undefined) return notFound();

    const response = await withTenantTransaction(
      {
        tenantId: options.tenantId,
        sessionToken: request.sessionToken,
        instant,
      },
      async (transaction) => {
        const context = new AuthzContext({
          tenantId: options.tenantId,
          principal: transaction.context.principal,
          instant,
          load: authorizationDataLoader(transaction),
        });
        const decision = await decide(context, DOCUMENT_REQUIRED_CAPABILITIES.listRegister, {
          tenantId: options.tenantId,
          type: "TENANT",
          id: null,
        });
        if (!decision.allowed) return notFound();

        const createDecision = await decide(context, DOCUMENT_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "TENANT",
          id: null,
        });

        const documents = await listDocumentRegister(transaction, options.tenantId);
        const candidates = await publicationCandidates(transaction, context, options.tenantId);
        return Response.json(
          { documents, canCreate: createDecision.allowed, publicationCandidates: candidates },
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );

    return response ?? notFound();
  };
}
