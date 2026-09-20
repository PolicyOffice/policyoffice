import type { AuditTransaction } from "./audit.js";
import { resolveEffectiveVersion } from "./publication.js";

export const READER_VIEW_REQUIRED_CAPABILITIES = Object.freeze({
  read: "document.read",
  readHistory: "document.read_history",
} as const);

export type ReaderReleasedLifecycle = "PUBLISHED" | "EFFECTIVE" | "SUPERSEDED" | "WITHDRAWN";

export interface ReaderAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: string;
  readonly digest: string;
}

export interface ReaderVersion {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly title: string;
  readonly lifecycleState: ReaderReleasedLifecycle;
  readonly changeSummary: string | null;
  readonly publishedAt: Date;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly approvedRevisionId: string;
  readonly contentDigest: string;
  readonly governsAtRequestInstant: boolean;
  readonly documentType: Readonly<{
    id: string;
    name: string;
  }>;
  readonly classification: Readonly<{
    id: string;
    code: string;
    name: string;
    handlingInstructions: string;
  }>;
  readonly supersededBy: Readonly<{
    id: string;
    displayLabel: string | null;
    title: string;
  }> | null;
  readonly attachments: readonly ReaderAttachment[];
}

export interface ReaderDocumentView {
  readonly document: Readonly<{
    id: string;
    code: string;
    title: string;
    baselineVariantId: string;
    owner: Readonly<{ id: string; name: string }> | null;
    owningScope: Readonly<{ id: string; code: string; name: string }>;
    documentType: Readonly<{ id: string; name: string }>;
  }>;
  readonly version: ReaderVersion | null;
  readonly laterPublishedVersion: Readonly<{
    id: string;
    displayLabel: string | null;
    title: string;
    bindsFrom: Date;
  }> | null;
}

interface ReaderDocumentRow extends Record<string, unknown> {
  document_id: string;
  document_code: string;
  document_title: string;
  baseline_variant_id: string;
  owner_user_id: string | null;
  owner_name: string | null;
  org_unit_id: string;
  org_unit_code: string;
  org_unit_name: string;
  document_type_id: string;
  document_type_name: string;
}

interface ReaderVersionRow extends Record<string, unknown> {
  version_id: string;
  display_label: string | null;
  version_title: string;
  lifecycle_state: ReaderReleasedLifecycle;
  change_summary: string | null;
  published_at: Date;
  effective_from: Date;
  effective_until: Date | null;
  approved_revision_id: string;
  content_digest: string;
  governs_at_request_instant: boolean;
  version_document_type_id: string;
  version_document_type_name: string;
  classification_id: string;
  classification_code: string;
  classification_name: string;
  handling_instructions: string;
  successor_id: string | null;
  successor_display_label: string | null;
  successor_title: string | null;
}

interface ReaderAttachmentRow extends Record<string, unknown> {
  id: string;
  filename: string;
  media_type: string;
  byte_size: string;
  digest: string;
}

interface LaterPublishedVersionRow extends Record<string, unknown> {
  id: string;
  display_label: string | null;
  title: string;
  effective_from: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOCUMENT_QUERY = `
select document.id as document_id,
       document.document_code,
       document.canonical_title as document_title,
       baseline.id as baseline_variant_id,
       document.owner_user_id,
       owner.display_name as owner_name,
       scope.id as org_unit_id,
       scope.code as org_unit_code,
       scope.name as org_unit_name,
       type.id as document_type_id,
       type.name as document_type_name
  from document
  join document_variant baseline
    on baseline.tenant_id = document.tenant_id
   and baseline.document_id = document.id
   and baseline.variant_type = 'BASELINE'
  join org_unit scope
    on scope.tenant_id = document.tenant_id
   and scope.id = document.owning_org_unit_id
  join document_type type
    on type.tenant_id = document.tenant_id
   and type.id = document.document_type_id
  left join app_user owner
    on owner.tenant_id = document.tenant_id
   and owner.id = document.owner_user_id
 where document.tenant_id = $1::uuid
   and document.id = $2::uuid`;

const VERSION_QUERY = `
select version.id as version_id,
       version.display_label,
       version.title as version_title,
       version.lifecycle_state,
       version.change_summary,
       version.published_at,
       version.effective_from,
       version.effective_until,
       revision.id as approved_revision_id,
       revision.content_digest,
       (
         version.effective_range @> $4::timestamptz
         and version.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
       ) as governs_at_request_instant,
       type.id as version_document_type_id,
       type.name as version_document_type_name,
       classification.id as classification_id,
       classification.code as classification_code,
       classification.name as classification_name,
       classification.handling_instructions,
       successor.id as successor_id,
       successor.display_label as successor_display_label,
       successor.title as successor_title
  from document_variant variant
  join document_version version
    on version.tenant_id = variant.tenant_id
   and version.document_variant_id = variant.id
  join content_revision revision
    on revision.tenant_id = version.tenant_id
   and revision.id = version.approved_revision_id
  join document_type type
    on type.tenant_id = version.tenant_id
   and type.id = version.document_type_id
  join information_classification classification
    on classification.tenant_id = version.tenant_id
   and classification.id = version.classification_id
  left join document_version successor
    on successor.tenant_id = version.tenant_id
   and successor.id = version.superseded_by_version_id
 where variant.tenant_id = $1::uuid
   and variant.document_id = $2::uuid
   and version.id = $3::uuid
   and version.lifecycle_state in ('PUBLISHED', 'EFFECTIVE', 'SUPERSEDED', 'WITHDRAWN')`;

const ATTACHMENTS_QUERY = `
select id, filename, media_type, byte_size::text, digest
  from content_attachment
 where tenant_id = $1::uuid
   and content_revision_id = $2::uuid
 order by filename, id`;

const LATER_PUBLISHED_QUERY = `
select id, display_label, title, effective_from
  from document_version
 where tenant_id = $1::uuid
   and document_variant_id = $2::uuid
   and lifecycle_state = 'PUBLISHED'
   and effective_from > $3::timestamptz
 order by effective_from, version_sequence
 limit 1`;

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function documentFromRow(row: ReaderDocumentRow): ReaderDocumentView["document"] {
  return Object.freeze({
    id: row.document_id,
    code: row.document_code,
    title: row.document_title,
    baselineVariantId: row.baseline_variant_id,
    owner:
      row.owner_user_id === null || row.owner_name === null
        ? null
        : Object.freeze({ id: row.owner_user_id, name: row.owner_name }),
    owningScope: Object.freeze({
      id: row.org_unit_id,
      code: row.org_unit_code,
      name: row.org_unit_name,
    }),
    documentType: Object.freeze({
      id: row.document_type_id,
      name: row.document_type_name,
    }),
  });
}

async function readerVersionById(
  transaction: AuditTransaction,
  tenantId: string,
  documentId: string,
  versionId: string,
  requestInstant: Date,
): Promise<ReaderVersion | null> {
  const { rows } = await transaction.query<ReaderVersionRow>(VERSION_QUERY, [
    tenantId,
    documentId,
    versionId,
    requestInstant.toISOString(),
  ]);
  const row = rows[0];
  if (!row) return null;
  const attachments = await transaction.query<ReaderAttachmentRow>(ATTACHMENTS_QUERY, [
    tenantId,
    row.approved_revision_id,
  ]);
  return Object.freeze({
    id: row.version_id,
    displayLabel: row.display_label,
    title: row.version_title,
    lifecycleState: row.lifecycle_state,
    changeSummary: row.change_summary,
    publishedAt: row.published_at,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    approvedRevisionId: row.approved_revision_id,
    contentDigest: row.content_digest,
    governsAtRequestInstant: row.governs_at_request_instant,
    documentType: Object.freeze({
      id: row.version_document_type_id,
      name: row.version_document_type_name,
    }),
    classification: Object.freeze({
      id: row.classification_id,
      code: row.classification_code,
      name: row.classification_name,
      handlingInstructions: row.handling_instructions,
    }),
    supersededBy:
      row.successor_id === null || row.successor_title === null
        ? null
        : Object.freeze({
            id: row.successor_id,
            displayLabel: row.successor_display_label,
            title: row.successor_title,
          }),
    attachments: Object.freeze(
      attachments.rows.map((attachment) =>
        Object.freeze({
          id: attachment.id,
          filename: attachment.filename,
          mediaType: attachment.media_type,
          byteSize: attachment.byte_size,
          digest: attachment.digest,
        }),
      ),
    ),
  });
}

async function laterPublishedVersion(
  transaction: AuditTransaction,
  tenantId: string,
  variantId: string,
  at: Date,
): Promise<ReaderDocumentView["laterPublishedVersion"]> {
  const { rows } = await transaction.query<LaterPublishedVersionRow>(LATER_PUBLISHED_QUERY, [
    tenantId,
    variantId,
    at.toISOString(),
  ]);
  const row = rows[0];
  return row
    ? Object.freeze({
        id: row.id,
        displayLabel: row.display_label,
        title: row.title,
        bindsFrom: row.effective_from,
      })
    : null;
}

/** Resolve one document through its baseline range without inventing applicability. */
export async function resolveReaderDocument(
  transaction: AuditTransaction,
  input: Readonly<{
    tenantId: string;
    documentId: string;
    at: Date;
    requestInstant: Date;
  }>,
): Promise<ReaderDocumentView | null> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.documentId, "documentId");
  requireDate(input.at, "at");
  requireDate(input.requestInstant, "requestInstant");
  const { rows } = await transaction.query<ReaderDocumentRow>(DOCUMENT_QUERY, [
    input.tenantId,
    input.documentId,
  ]);
  const document = rows[0];
  if (!document) return null;
  const resolved = await resolveEffectiveVersion(transaction, {
    tenantId: input.tenantId,
    documentVariantId: document.baseline_variant_id,
    at: input.at,
  });
  const [version, future] = await Promise.all([
    resolved === null
      ? null
      : readerVersionById(
          transaction,
          input.tenantId,
          input.documentId,
          resolved.id,
          input.requestInstant,
        ),
    laterPublishedVersion(
      transaction,
      input.tenantId,
      document.baseline_variant_id,
      input.requestInstant,
    ),
  ]);
  if (resolved !== null && version === null) {
    throw new Error("resolved effective version is unavailable to the reader model");
  }
  return Object.freeze({
    document: documentFromRow(document),
    version,
    laterPublishedVersion: future,
  });
}

/** Resolve one exact released version; pre-release versions are deliberately absent. */
export async function getReaderDocumentVersion(
  transaction: AuditTransaction,
  input: Readonly<{
    tenantId: string;
    documentId: string;
    versionId: string;
    requestInstant: Date;
  }>,
): Promise<ReaderDocumentView | null> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.documentId, "documentId");
  requireUuid(input.versionId, "versionId");
  requireDate(input.requestInstant, "requestInstant");
  const { rows } = await transaction.query<ReaderDocumentRow>(DOCUMENT_QUERY, [
    input.tenantId,
    input.documentId,
  ]);
  const document = rows[0];
  if (!document) return null;
  const version = await readerVersionById(
    transaction,
    input.tenantId,
    input.documentId,
    input.versionId,
    input.requestInstant,
  );
  if (!version) return null;
  return Object.freeze({
    document: documentFromRow(document),
    version,
    laterPublishedVersion: null,
  });
}
