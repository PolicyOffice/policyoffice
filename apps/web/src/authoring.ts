import { randomUUID } from "node:crypto";
import {
  withTenantTransaction,
  type ApplicationTransaction,
} from "@policyoffice/db/application-transaction";
import { authorizationDataLoader } from "@policyoffice/db/authorization";
import {
  AuthzContext,
  CONTENT_REVISION_REQUIRED_CAPABILITIES,
  ContentRevisionNotFoundError,
  DOCUMENT_REQUIRED_CAPABILITIES,
  MATERIALITY_CLASSES,
  VERSION_REQUIRED_CAPABILITIES,
  createContentRevision,
  createDocument,
  createDocumentVersion,
  decide,
  submitContentRevision,
  type Materiality,
  type VersionLifecycle,
} from "../../../packages/domain/src/index";

export interface AuthoringHandlerOptions {
  readonly tenantId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface CreateDocumentRequest {
  readonly sessionToken: string | undefined;
  readonly documentCode: string;
  readonly canonicalTitle: string;
  readonly documentTypeCode: string;
  readonly owningOrgUnitCode: string;
  readonly spaceCode: string | null;
}

export interface CreateVersionRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly displayLabel: string | null;
  readonly classificationCode: string;
  readonly materiality: string | null;
  readonly changeSummary: string | null;
}

export interface CreateVersionFormRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
}

export interface SaveContentRevisionRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly versionId: string;
  readonly contentBytes: Uint8Array;
}

export interface DraftWorkspaceRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly versionId: string;
}

export interface CreateVersionFormPayload {
  readonly documentCode: string;
  readonly canonicalTitle: string;
  readonly lifecycleStatus: string;
}

export interface DraftWorkspacePayload {
  readonly lifecycleState: VersionLifecycle;
  readonly canSubmit: boolean;
}

export interface SubmitContentRevisionRequest {
  readonly sessionToken: string | undefined;
  readonly documentId: string;
  readonly versionId: string;
  /** The author-selected revision returned by a completed save; this handler never selects one. */
  readonly revisionId: string;
  readonly expectedVersionRowVersion: number;
  readonly expectedRevisionRowVersion: number;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface VersionDocumentRow extends Record<string, unknown> {
  document_id: string;
}

interface CreateVersionFormRow extends Record<string, unknown> {
  document_code: string;
  canonical_title: string;
  lifecycle_status: string;
}

interface DraftWorkspaceRow extends Record<string, unknown> {
  lifecycle_state: VersionLifecycle;
}

const RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: RESPONSE_HEADERS });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...RESPONSE_HEADERS, location } });
}

function requiredText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function parseMateriality(value: string | null): Materiality | null | undefined {
  if (value === null) return null;
  return MATERIALITY_CLASSES.find((candidate) => candidate === value);
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

async function activeIdByCode(
  transaction: ApplicationTransaction,
  table: "document_type" | "information_classification",
  tenantId: string,
  code: string,
): Promise<string | null> {
  const { rows } = await transaction.query<IdRow>(
    `select id from ${table}
      where tenant_id = $1::uuid and code = $2::text and status = 'ACTIVE'`,
    [tenantId, code],
  );
  return rows[0]?.id ?? null;
}

async function activeOrgUnitId(
  transaction: ApplicationTransaction,
  tenantId: string,
  code: string,
): Promise<string | null> {
  const { rows } = await transaction.query<IdRow>(
    `select id from org_unit
      where tenant_id = $1::uuid and code = $2::text and status = 'ACTIVE'`,
    [tenantId, code],
  );
  return rows[0]?.id ?? null;
}

async function activeSpaceId(
  transaction: ApplicationTransaction,
  tenantId: string,
  code: string | null,
): Promise<string | null | undefined> {
  if (code === null) return null;
  const { rows } = await transaction.query<IdRow>(
    `select id from space
      where tenant_id = $1::uuid and code = $2::text and status = 'ACTIVE'`,
    [tenantId, code],
  );
  return rows[0]?.id;
}

async function baselineVariantId(
  transaction: ApplicationTransaction,
  tenantId: string,
  documentId: string,
): Promise<string | null> {
  const { rows } = await transaction.query<IdRow>(
    `select id from document_variant
      where tenant_id = $1::uuid and document_id = $2::uuid
        and variant_type = 'BASELINE' and status = 'ACTIVE'`,
    [tenantId, documentId],
  );
  return rows[0]?.id ?? null;
}

async function versionBelongsToDocument(
  transaction: ApplicationTransaction,
  tenantId: string,
  documentId: string,
  versionId: string,
): Promise<boolean> {
  const { rows } = await transaction.query<VersionDocumentRow>(
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

/** Read the document only after making the same decision as the start-version route. */
export function createVersionFormHandler(
  options: AuthoringHandlerOptions,
): (request: CreateVersionFormRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId)) return notFound();
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
        const decision = await decide(context, VERSION_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "DOCUMENT",
          id: request.documentId,
        });
        if (!decision.allowed) return notFound();

        const { rows } = await transaction.query<CreateVersionFormRow>(
          `select document_code, canonical_title, lifecycle_status
             from document
            where tenant_id = $1::uuid and id = $2::uuid`,
          [options.tenantId, request.documentId],
        );
        const document = rows[0];
        if (!document) return notFound();
        return Response.json(
          {
            documentCode: document.document_code,
            canonicalTitle: document.canonical_title,
            lifecycleStatus: document.lifecycle_status,
          } satisfies CreateVersionFormPayload,
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );
    return response ?? notFound();
  };
}

/** Read the workspace after the save decision; expose submit only after its own decision. */
export function createDraftWorkspaceHandler(
  options: AuthoringHandlerOptions,
): (request: DraftWorkspaceRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId) || !UUID.test(request.versionId)) {
      return notFound();
    }
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
        const saveDecision = await decide(context, CONTENT_REVISION_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "DOCUMENT_VERSION",
          id: request.versionId,
        });
        if (!saveDecision.allowed) return notFound();

        const { rows } = await transaction.query<DraftWorkspaceRow>(
          `select version.lifecycle_state
             from document_version version
             join document_variant variant
               on variant.tenant_id = version.tenant_id
              and variant.id = version.document_variant_id
            where version.tenant_id = $1::uuid and version.id = $2::uuid
              and variant.document_id = $3::uuid`,
          [options.tenantId, request.versionId, request.documentId],
        );
        const version = rows[0];
        if (!version) return notFound();

        const submitDecision = await decide(
          context,
          CONTENT_REVISION_REQUIRED_CAPABILITIES.submit,
          {
            tenantId: options.tenantId,
            type: "DOCUMENT_VERSION",
            id: request.versionId,
          },
        );
        return Response.json(
          {
            lifecycleState: version.lifecycle_state,
            canSubmit: submitDecision.allowed,
          } satisfies DraftWorkspacePayload,
          { status: 200, headers: RESPONSE_HEADERS },
        );
      },
    );
    return response ?? notFound();
  };
}

/** Create the stable document identity. Authorization is deliberately local to this route. */
export function createDocumentHandler(
  options: AuthoringHandlerOptions,
): (request: CreateDocumentRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

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
        if (!decision.allowed) return notFound();
        if (transaction.context.principal.type !== "USER") return notFound();

        const documentCode = requiredText(request.documentCode);
        const canonicalTitle = requiredText(request.canonicalTitle);
        const documentTypeCode = requiredText(request.documentTypeCode);
        const owningOrgUnitCode = requiredText(request.owningOrgUnitCode);
        const spaceCode = request.spaceCode === null ? null : requiredText(request.spaceCode);
        if (!documentCode || !canonicalTitle || !documentTypeCode || !owningOrgUnitCode) {
          return redirect("/author/documents/new?error=invalid");
        }

        const configurationVersionId = await activeConfigurationVersionId(
          transaction,
          options.tenantId,
          instant,
        );
        const documentTypeId = await activeIdByCode(
          transaction,
          "document_type",
          options.tenantId,
          documentTypeCode,
        );
        const owningOrgUnitId = await activeOrgUnitId(
          transaction,
          options.tenantId,
          owningOrgUnitCode,
        );
        const spaceId = await activeSpaceId(transaction, options.tenantId, spaceCode);
        if (!documentTypeId || !owningOrgUnitId || spaceId === undefined) {
          return redirect("/author/documents/new?error=invalid");
        }

        const documentId = idFactory();
        await createDocument(transaction, {
          tenantId: options.tenantId,
          documentId,
          baselineVariantId: idFactory(),
          documentCode,
          canonicalTitle,
          documentTypeId,
          ownerUserId: transaction.context.principal.id,
          owningOrgUnitId,
          spaceId,
          isGoverningFramework: false,
          actor: { type: "USER", id: transaction.context.principal.id },
          configurationVersionId,
          occurredAt: instant,
          requestId: idFactory(),
          correlationId: idFactory(),
          sourceChannel: "WEB",
        });
        return redirect(`/author/documents/${documentId}`);
      },
    );
    return response ?? notFound();
  };
}

/** Start one DRAFT version. Authorization is deliberately local to this route. */
export function createVersionHandler(
  options: AuthoringHandlerOptions,
): (request: CreateVersionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId)) return notFound();

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
        const decision = await decide(context, VERSION_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "DOCUMENT",
          id: request.documentId,
        });
        if (!decision.allowed) return notFound();
        if (transaction.context.principal.type !== "USER") return notFound();

        const classificationCode = requiredText(request.classificationCode);
        const materiality = parseMateriality(request.materiality);
        if (!classificationCode || materiality === undefined) {
          return redirect(`/author/documents/${request.documentId}?error=invalid`);
        }

        const configurationVersionId = await activeConfigurationVersionId(
          transaction,
          options.tenantId,
          instant,
        );
        const documentVariantId = await baselineVariantId(
          transaction,
          options.tenantId,
          request.documentId,
        );
        const classificationId = await activeIdByCode(
          transaction,
          "information_classification",
          options.tenantId,
          classificationCode,
        );
        if (!documentVariantId || !classificationId) return notFound();

        const versionId = idFactory();
        await createDocumentVersion(transaction, {
          tenantId: options.tenantId,
          versionId,
          documentVariantId,
          displayLabel: request.displayLabel,
          classificationId,
          materiality,
          changeSummary: request.changeSummary,
          actor: { type: "USER", id: transaction.context.principal.id },
          configurationVersionId,
          occurredAt: instant,
          requestId: idFactory(),
          correlationId: idFactory(),
          sourceChannel: "WEB",
        });
        return redirect(`/author/documents/${request.documentId}/versions/${versionId}`);
      },
    );
    return response ?? notFound();
  };
}

/** Save one immutable drafting snapshot. Authorization is deliberately local to this route. */
export function createContentRevisionHandler(
  options: AuthoringHandlerOptions,
): (request: SaveContentRevisionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return async (request) => {
    if (!request.sessionToken || !UUID.test(request.documentId) || !UUID.test(request.versionId)) {
      return notFound();
    }
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
        const decision = await decide(context, CONTENT_REVISION_REQUIRED_CAPABILITIES.create, {
          tenantId: options.tenantId,
          type: "DOCUMENT_VERSION",
          id: request.versionId,
        });
        if (!decision.allowed) return notFound();
        if (transaction.context.principal.type !== "USER") return notFound();
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
        if (
          !(request.contentBytes instanceof Uint8Array) ||
          request.contentBytes.byteLength === 0
        ) {
          return redirect(`/author/documents/${request.documentId}/versions/${request.versionId}`);
        }

        const configurationVersionId = await activeConfigurationVersionId(
          transaction,
          options.tenantId,
          instant,
        );
        const saved = await createContentRevision(transaction, {
          tenantId: options.tenantId,
          revisionId: idFactory(),
          documentVersionId: request.versionId,
          createdByUserId: transaction.context.principal.id,
          contentBytes: request.contentBytes,
          actor: { type: "USER", id: transaction.context.principal.id },
          configurationVersionId,
          occurredAt: instant,
          requestId: idFactory(),
          correlationId: idFactory(),
          sourceChannel: "WEB",
        });
        const params = new URLSearchParams({
          revisionId: saved.id,
          revisionRowVersion: String(saved.rowVersion),
          versionRowVersion: String(saved.versionRowVersion),
        });
        return redirect(
          `/author/documents/${request.documentId}/versions/${request.versionId}?${params}`,
        );
      },
    );
    return response ?? notFound();
  };
}

/** Submit the author-selected saved revision. Authorization is deliberately local to this route. */
export function createSubmitContentRevisionHandler(
  options: AuthoringHandlerOptions,
): (request: SubmitContentRevisionRequest) => Promise<Response> {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return async (request) => {
    if (
      !request.sessionToken ||
      !UUID.test(request.documentId) ||
      !UUID.test(request.versionId) ||
      !UUID.test(request.revisionId)
    ) {
      return notFound();
    }
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
        const decision = await decide(context, CONTENT_REVISION_REQUIRED_CAPABILITIES.submit, {
          tenantId: options.tenantId,
          type: "DOCUMENT_VERSION",
          id: request.versionId,
        });
        if (!decision.allowed) return notFound();
        if (transaction.context.principal.type !== "USER") return notFound();
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
        if (
          !positiveInteger(request.expectedVersionRowVersion) ||
          !positiveInteger(request.expectedRevisionRowVersion)
        ) {
          return redirect(`/author/documents/${request.documentId}/versions/${request.versionId}`);
        }

        const configurationVersionId = await activeConfigurationVersionId(
          transaction,
          options.tenantId,
          instant,
        );
        try {
          await submitContentRevision(transaction, {
            tenantId: options.tenantId,
            documentVersionId: request.versionId,
            revisionId: request.revisionId,
            expectedVersionRowVersion: request.expectedVersionRowVersion,
            expectedRevisionRowVersion: request.expectedRevisionRowVersion,
            actor: { type: "USER", id: transaction.context.principal.id },
            configurationVersionId,
            occurredAt: instant,
            requestId: idFactory(),
            correlationId: idFactory(),
            sourceChannel: "WEB",
          });
        } catch (error) {
          if (error instanceof ContentRevisionNotFoundError) return notFound();
          throw error;
        }
        return redirect(`/author/documents/${request.documentId}/versions/${request.versionId}`);
      },
    );
    return response ?? notFound();
  };
}
