import {
  emitAuditEvent,
  type AuditActorType,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";

export const VERSION_LIFECYCLE_STATES = [
  "DRAFT",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "PUBLISHED",
  "EFFECTIVE",
  "SUPERSEDED",
  "WITHDRAWN",
  "REJECTED",
  "CANCELLED",
] as const;
export type VersionLifecycle = (typeof VERSION_LIFECYCLE_STATES)[number];

/** The structural state-machine edges specified by document-lifecycle.md. */
export const DIRECT_VERSION_LIFECYCLE_TRANSITIONS = Object.freeze([
  Object.freeze({ from: "DRAFT", to: "IN_REVIEW" }),
  Object.freeze({ from: "IN_REVIEW", to: "CHANGES_REQUESTED" }),
  Object.freeze({ from: "CHANGES_REQUESTED", to: "DRAFT" }),
  Object.freeze({ from: "IN_REVIEW", to: "APPROVED" }),
  Object.freeze({ from: "IN_REVIEW", to: "REJECTED" }),
  Object.freeze({ from: "DRAFT", to: "CANCELLED" }),
  Object.freeze({ from: "IN_REVIEW", to: "CANCELLED" }),
  Object.freeze({ from: "CHANGES_REQUESTED", to: "CANCELLED" }),
  Object.freeze({ from: "APPROVED", to: "CANCELLED" }),
  Object.freeze({ from: "APPROVED", to: "PUBLISHED" }),
  Object.freeze({ from: "PUBLISHED", to: "EFFECTIVE" }),
  Object.freeze({ from: "PUBLISHED", to: "WITHDRAWN" }),
  Object.freeze({ from: "EFFECTIVE", to: "SUPERSEDED" }),
  Object.freeze({ from: "EFFECTIVE", to: "WITHDRAWN" }),
] as const);

export const MATERIALITY_CLASSES = ["EDITORIAL", "NON_MATERIAL", "MATERIAL", "EMERGENCY"] as const;
export type Materiality = (typeof MATERIALITY_CLASSES)[number];

/**
 * The exhaustive storage split makes a new column a deliberate governance choice rather
 * than mutable by omission (INV-VER-003, INV-VER-007, INV-VER-008).
 */
export const DOCUMENT_VERSION_COLUMN_CLASSIFICATION = Object.freeze({
  identity: Object.freeze(["tenant_id", "id", "created_at"]),
  governed: Object.freeze([
    "document_variant_id",
    "version_sequence",
    "document_type_id",
    "title",
    "classification_id",
    "materiality",
    "change_summary",
    "effective_from",
    "effective_until",
    "content_digest",
    "approved_revision_id",
    "configuration_version_id",
  ]),
  administrative: Object.freeze([
    "display_label",
    "lifecycle_state",
    "approved_at",
    "published_at",
    "superseded_by_version_id",
    "withdrawn_at",
    "withdrawal_reason",
    "updated_at",
    "row_version",
  ]),
  generated: Object.freeze(["effective_range"]),
} as const);

/** Authorization contracts only; ADR-0003's evaluator has not landed. */
export const VERSION_REQUIRED_CAPABILITIES = Object.freeze({
  create: "document.edit_draft",
  changeMateriality: "document.edit_draft",
  changeMetadata: "document.manage",
  cancel: "document.cancel_version",
} as const);

interface VersionAuditContext {
  actor: Readonly<{ type: AuditActorType; id: string | null }>;
  configurationVersionId: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface CreateDocumentVersionInput extends VersionAuditContext {
  tenantId: string;
  versionId: string;
  documentVariantId: string;
  displayLabel: string | null;
  classificationId: string;
  materiality: Materiality | null;
  changeSummary: string | null;
}

export interface CreatedDocumentVersion {
  id: string;
  documentId: string;
  documentVariantId: string;
  versionSequence: number;
  displayLabel: string | null;
  lifecycleState: "DRAFT";
  documentTypeId: string;
  title: string;
  classificationId: string;
  materiality: Materiality | null;
  changeSummary: string | null;
  configurationVersionId: string;
  rowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

export interface ChangeVersionMaterialityInput extends VersionAuditContext {
  tenantId: string;
  versionId: string;
  expectedRowVersion: number;
  materiality: Materiality | null;
}

export interface ChangeVersionMetadataInput extends VersionAuditContext {
  tenantId: string;
  versionId: string;
  expectedRowVersion: number;
  displayLabel: string | null;
}

export interface ChangedDocumentVersion {
  id: string;
  rowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

interface VariantSnapshotRow extends Record<string, unknown> {
  document_id: string;
  document_type_id: string;
  canonical_title: string;
}

interface CreatedVersionRow extends Record<string, unknown> {
  id: string;
  version_sequence: number;
  display_label: string | null;
  lifecycle_state: "DRAFT";
  document_type_id: string;
  title: string;
  classification_id: string;
  materiality: Materiality | null;
  change_summary: string | null;
  configuration_version_id: string;
  row_version: number;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  document_variant_id: string;
  display_label: string | null;
  lifecycle_state: VersionLifecycle;
  materiality: Materiality | null;
  row_version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);
const MATERIALITIES = new Set<Materiality>(MATERIALITY_CLASSES);

export class DocumentVersionNotFoundError extends Error {
  constructor() {
    super("document version not found");
    this.name = "DocumentVersionNotFoundError";
  }
}

export class DocumentVersionConcurrencyError extends Error {
  constructor() {
    super("document version row_version is stale");
    this.name = "DocumentVersionConcurrencyError";
  }
}

export class DocumentVersionNoChangeError extends Error {
  constructor() {
    super("document version change does not alter stored state");
    this.name = "DocumentVersionNoChangeError";
  }
}

export class DocumentVersionLifecycleError extends Error {
  constructor(message = "document version lifecycle does not permit this change") {
    super(message);
    this.name = "DocumentVersionLifecycleError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireNullableText(value: string | null, field: string): void {
  if (value !== null && value.trim().length === 0) throw new TypeError(`${field} cannot be blank`);
}

function requireMateriality(value: Materiality | null): void {
  if (value !== null && !MATERIALITIES.has(value)) {
    throw new TypeError("materiality is not supported");
  }
}

function validateExpectedRowVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("expectedRowVersion must be a positive integer");
  }
}

function validateContext(input: VersionAuditContext & { tenantId: string }): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.valueOf())) {
    throw new TypeError("occurredAt must be a valid Date");
  }
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
}

async function lockedVersion(
  transaction: AuditTransaction,
  tenantId: string,
  versionId: string,
): Promise<VersionRow> {
  const { rows } = await transaction.query<VersionRow>(
    `select version.id, variant.document_id, version.document_variant_id,
            version.display_label, version.lifecycle_state, version.materiality,
            version.row_version
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where version.tenant_id = $1::uuid and version.id = $2::uuid
      for update of version`,
    [tenantId, versionId],
  );
  const row = rows[0];
  if (!row) throw new DocumentVersionNotFoundError();
  return row;
}

function requireCurrentVersion(row: VersionRow, expectedRowVersion: number): void {
  if (row.row_version !== expectedRowVersion) throw new DocumentVersionConcurrencyError();
}

async function emitVersionEvent(
  transaction: AuditTransaction,
  input: VersionAuditContext & { tenantId: string; versionId: string },
  row: Readonly<{ document_id: string; document_variant_id: string }>,
  eventType: "version.materiality_changed" | "version.metadata_changed",
  action: string,
  rowVersion: number,
  safeBefore: Readonly<Record<string, string | null>>,
  safeAfter: Readonly<Record<string, string | null>>,
): Promise<EmittedAuditEvent> {
  return emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "DOCUMENT_VERSION", id: input.versionId },
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    documentVersionId: input.versionId,
    action,
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore,
    safeAfter,
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `${eventType}:${input.versionId}:${rowVersion}`,
  });
}

/** Open one DRAFT candidate under the variant lock. Requires document.edit_draft. */
export async function createDocumentVersion(
  transaction: AuditTransaction,
  input: CreateDocumentVersionInput,
): Promise<CreatedDocumentVersion> {
  validateContext(input);
  requireUuid(input.versionId, "versionId");
  requireUuid(input.documentVariantId, "documentVariantId");
  requireUuid(input.classificationId, "classificationId");
  requireNullableText(input.displayLabel, "displayLabel");
  requireNullableText(input.changeSummary, "changeSummary");
  requireMateriality(input.materiality);

  const snapshot = await transaction.query<VariantSnapshotRow>(
    `select variant.document_id, document.document_type_id, document.canonical_title
       from document_variant variant
       join document
         on document.tenant_id = variant.tenant_id
        and document.id = variant.document_id
      where variant.tenant_id = $1::uuid and variant.id = $2::uuid
      for update of variant`,
    [input.tenantId, input.documentVariantId],
  );
  const variant = snapshot.rows[0];
  if (!variant) throw new DocumentVersionNotFoundError();

  const { rows } = await transaction.query<CreatedVersionRow>(
    `insert into document_version (
       tenant_id, id, document_variant_id, version_sequence, display_label,
       lifecycle_state, document_type_id, title, classification_id, materiality,
       change_summary, configuration_version_id
     )
     select $1::uuid, $2::uuid, $3::uuid,
            coalesce(max(version_sequence), 0) + 1,
            $4::text, 'DRAFT', $5::uuid, $6::text, $7::uuid, $8::materiality,
            $9::text, $10::uuid
       from document_version
      where tenant_id = $1::uuid and document_variant_id = $3::uuid
     returning id, version_sequence, display_label, lifecycle_state, document_type_id,
               title, classification_id, materiality, change_summary,
               configuration_version_id, row_version`,
    [
      input.tenantId,
      input.versionId,
      input.documentVariantId,
      input.displayLabel,
      variant.document_type_id,
      variant.canonical_title,
      input.classificationId,
      input.materiality,
      input.changeSummary,
      input.configurationVersionId,
    ],
  );
  const version = rows[0];
  if (!version || rows.length !== 1) {
    throw new Error(`document version insert returned ${rows.length} rows`);
  }

  const emittedEvent = await emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType: "version.created",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "DOCUMENT_VERSION", id: version.id },
    documentId: variant.document_id,
    documentVariantId: input.documentVariantId,
    documentVersionId: version.id,
    action: "CREATE_DOCUMENT_VERSION",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: null,
    safeAfter: {
      documentVariantId: input.documentVariantId,
      versionSequence: version.version_sequence,
      lifecycleState: version.lifecycle_state,
      documentTypeId: version.document_type_id,
      title: version.title,
      classificationId: version.classification_id,
      materiality: version.materiality,
      configurationVersionId: version.configuration_version_id,
    },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `version.created:${version.id}`,
  });

  return {
    id: version.id,
    documentId: variant.document_id,
    documentVariantId: input.documentVariantId,
    versionSequence: version.version_sequence,
    displayLabel: version.display_label,
    lifecycleState: version.lifecycle_state,
    documentTypeId: version.document_type_id,
    title: version.title,
    classificationId: version.classification_id,
    materiality: version.materiality,
    changeSummary: version.change_summary,
    configurationVersionId: version.configuration_version_id,
    rowVersion: version.row_version,
    emittedEvent,
  };
}

/** Change the human proposal only while the version is DRAFT. Requires document.edit_draft. */
export async function changeVersionMateriality(
  transaction: AuditTransaction,
  input: ChangeVersionMaterialityInput,
): Promise<ChangedDocumentVersion> {
  validateContext(input);
  requireUuid(input.versionId, "versionId");
  validateExpectedRowVersion(input.expectedRowVersion);
  requireMateriality(input.materiality);
  const current = await lockedVersion(transaction, input.tenantId, input.versionId);
  requireCurrentVersion(current, input.expectedRowVersion);
  if (current.lifecycle_state !== "DRAFT") throw new DocumentVersionLifecycleError();
  if (current.materiality === input.materiality) throw new DocumentVersionNoChangeError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document_version
        set materiality = $3::materiality, row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $4::integer
      returning id, row_version`,
    [input.tenantId, input.versionId, input.materiality, input.expectedRowVersion],
  );
  const changed = rows[0];
  if (!changed) throw new DocumentVersionConcurrencyError();
  const emittedEvent = await emitVersionEvent(
    transaction,
    input,
    current,
    "version.materiality_changed",
    "CHANGE_VERSION_MATERIALITY",
    changed.row_version,
    { materiality: current.materiality },
    { materiality: input.materiality },
  );
  return { id: changed.id, rowVersion: changed.row_version, emittedEvent };
}

/** Change presentation-only metadata in place. Requires document.manage. */
export async function changeVersionMetadata(
  transaction: AuditTransaction,
  input: ChangeVersionMetadataInput,
): Promise<ChangedDocumentVersion> {
  validateContext(input);
  requireUuid(input.versionId, "versionId");
  validateExpectedRowVersion(input.expectedRowVersion);
  requireNullableText(input.displayLabel, "displayLabel");
  const current = await lockedVersion(transaction, input.tenantId, input.versionId);
  requireCurrentVersion(current, input.expectedRowVersion);
  if (current.display_label === input.displayLabel) throw new DocumentVersionNoChangeError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document_version
        set display_label = $3::text, row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $4::integer
      returning id, row_version`,
    [input.tenantId, input.versionId, input.displayLabel, input.expectedRowVersion],
  );
  const changed = rows[0];
  if (!changed) throw new DocumentVersionConcurrencyError();
  const emittedEvent = await emitVersionEvent(
    transaction,
    input,
    current,
    "version.metadata_changed",
    "CHANGE_VERSION_METADATA",
    changed.row_version,
    { displayLabel: current.display_label },
    { displayLabel: input.displayLabel },
  );
  return { id: changed.id, rowVersion: changed.row_version, emittedEvent };
}
