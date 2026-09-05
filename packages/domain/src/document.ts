import {
  emitAuditEvent,
  type AuditActorType,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
  type SafeAuditSnapshot,
} from "./audit.js";

export const DOCUMENT_LIFECYCLE_STATES = ["PLANNED", "ACTIVE", "RETIRED"] as const;
export type DocumentLifecycle = (typeof DOCUMENT_LIFECYCLE_STATES)[number];

export const VARIANT_TYPES = ["BASELINE", "REPLACEMENT", "SUPPLEMENT", "TRANSLATION"] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

/**
 * The evaluator from ADR-0003 has not landed. These constants are the authorization
 * contract callers must establish before entering each domain operation; no temporary
 * evaluator is introduced here.
 */
export const DOCUMENT_REQUIRED_CAPABILITIES = Object.freeze({
  listRegister: "document.read",
  create: "document.create",
  changeMetadata: "document.manage",
  changeOwner: "document.manage",
  changeType: "document.manage",
  retire: "document.retire",
  restore: "document.restore",
} as const);

/** INV-DOC-007: Active is absent because only version effectivity may derive it. */
export const DIRECT_DOCUMENT_LIFECYCLE_TRANSITIONS = Object.freeze([
  Object.freeze({ from: "PLANNED", to: "RETIRED", capability: "document.retire" }),
] as const);

interface DocumentAuditContext {
  actor: Readonly<{ type: AuditActorType; id: string | null }>;
  configurationVersionId: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface CreateDocumentInput extends DocumentAuditContext {
  tenantId: string;
  documentId: string;
  baselineVariantId: string;
  documentCode: string;
  canonicalTitle: string;
  documentTypeId: string;
  ownerUserId: string | null;
  owningOrgUnitId: string;
  spaceId: string | null;
  isGoverningFramework: boolean;
}

export interface CreatedDocument {
  id: string;
  baselineVariantId: string;
  documentCode: string;
  canonicalTitle: string;
  documentTypeId: string;
  ownerUserId: string | null;
  owningOrgUnitId: string;
  spaceId: string | null;
  lifecycleStatus: "PLANNED";
  isGoverningFramework: boolean;
  rowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

export interface ChangeDocumentMetadataInput extends DocumentAuditContext {
  tenantId: string;
  documentId: string;
  expectedRowVersion: number;
  documentCode?: string;
  canonicalTitle?: string;
  owningOrgUnitId?: string;
  spaceId?: string | null;
  isGoverningFramework?: boolean;
}

export interface ChangeDocumentOwnerInput extends DocumentAuditContext {
  tenantId: string;
  documentId: string;
  expectedRowVersion: number;
  ownerUserId: string | null;
}

export interface ChangeDocumentTypeInput extends DocumentAuditContext {
  tenantId: string;
  documentId: string;
  expectedRowVersion: number;
  documentTypeId: string;
}

export interface RetireDocumentInput extends DocumentAuditContext {
  tenantId: string;
  documentId: string;
  expectedRowVersion: number;
  retirementReason: string;
}

export interface ChangedDocument {
  id: string;
  rowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

export interface DocumentRegisterRow {
  id: string;
  documentCode: string;
  canonicalTitle: string;
  documentTypeId: string;
  ownerUserId: string | null;
  ownershipException: boolean;
  owningOrgUnitId: string;
  spaceId: string | null;
  lifecycleStatus: DocumentLifecycle;
  isGoverningFramework: boolean;
  retiredAt: Date | null;
  retirementReason: string | null;
  rowVersion: number;
}

interface DocumentRow extends Record<string, unknown> {
  id: string;
  document_code: string;
  canonical_title: string;
  document_type_id: string;
  owner_user_id: string | null;
  owning_org_unit_id: string;
  space_id: string | null;
  lifecycle_status: DocumentLifecycle;
  is_governing_framework: boolean;
  retired_at: Date | null;
  retirement_reason: string | null;
  row_version: number;
}

interface CreatedDocumentRow extends DocumentRow {
  baseline_variant_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

export class DocumentNotFoundError extends Error {
  constructor() {
    super("document not found");
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentConcurrencyError extends Error {
  constructor() {
    super("document row_version is stale");
    this.name = "DocumentConcurrencyError";
  }
}

export class DocumentNoChangeError extends Error {
  constructor() {
    super("document change does not alter stored state");
    this.name = "DocumentNoChangeError";
  }
}

export class DocumentLifecycleError extends Error {
  constructor() {
    super("document lifecycle transition is not available");
    this.name = "DocumentLifecycleError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireNullableUuid(value: string | null, field: string): void {
  if (value !== null) requireUuid(value, field);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function validateContext(input: DocumentAuditContext & { tenantId: string }): void {
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

function validateExpectedRowVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("expectedRowVersion must be a positive integer");
  }
}

async function lockedDocument(
  transaction: AuditTransaction,
  tenantId: string,
  documentId: string,
): Promise<DocumentRow> {
  const { rows } = await transaction.query<DocumentRow>(
    `select id, document_code, canonical_title, document_type_id, owner_user_id,
            owning_org_unit_id, space_id, lifecycle_status, is_governing_framework,
            retired_at, retirement_reason, row_version
       from document
      where tenant_id = $1::uuid and id = $2::uuid
      for update`,
    [tenantId, documentId],
  );
  const row = rows[0];
  if (!row) throw new DocumentNotFoundError();
  return row;
}

function requireCurrentVersion(row: DocumentRow, expectedRowVersion: number): void {
  if (row.row_version !== expectedRowVersion) throw new DocumentConcurrencyError();
}

async function emitDocumentEvent(
  transaction: AuditTransaction,
  input: DocumentAuditContext & { tenantId: string; documentId: string },
  eventType:
    | "document.created"
    | "document.metadata_changed"
    | "document.owner_changed"
    | "document.type_changed"
    | "document.retired",
  action: string,
  rowVersion: number,
  safeBefore: SafeAuditSnapshot | null,
  safeAfter: SafeAuditSnapshot,
  documentVariantId: string | null = null,
): Promise<EmittedAuditEvent> {
  return emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType,
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "DOCUMENT", id: input.documentId },
    documentId: input.documentId,
    documentVariantId,
    action,
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore,
    safeAfter,
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `${eventType}:${input.documentId}:${rowVersion}`,
  });
}

/**
 * Create the stable identity and its sole baseline in one SQL statement, then append the
 * one event for the pair in the caller's transaction (INV-APL-011, INV-AUD-004).
 */
export async function createDocument(
  transaction: AuditTransaction,
  input: CreateDocumentInput,
): Promise<CreatedDocument> {
  validateContext(input);
  requireUuid(input.documentId, "documentId");
  requireUuid(input.baselineVariantId, "baselineVariantId");
  requireUuid(input.documentTypeId, "documentTypeId");
  requireNullableUuid(input.ownerUserId, "ownerUserId");
  requireUuid(input.owningOrgUnitId, "owningOrgUnitId");
  requireNullableUuid(input.spaceId, "spaceId");
  requireText(input.documentCode, "documentCode");
  requireText(input.canonicalTitle, "canonicalTitle");
  if (typeof input.isGoverningFramework !== "boolean") {
    throw new TypeError("isGoverningFramework must be a boolean");
  }

  const { rows } = await transaction.query<CreatedDocumentRow>(
    `with inserted_document as (
       insert into document (
         tenant_id, id, document_code, canonical_title, document_type_id,
         owner_user_id, owning_org_unit_id, space_id, lifecycle_status,
         is_governing_framework
       ) values (
         $1::uuid, $2::uuid, $4::text, $5::text, $6::uuid,
         $7::uuid, $8::uuid, $9::uuid, 'PLANNED', $10::boolean
       )
       returning id, document_code, canonical_title, document_type_id, owner_user_id,
                 owning_org_unit_id, space_id, lifecycle_status, is_governing_framework,
                 retired_at, retirement_reason, row_version
     ), inserted_variant as (
       insert into document_variant (
         tenant_id, id, document_id, variant_type, source_variant_id, locale, status
       )
       select $1::uuid, $3::uuid, inserted_document.id, 'BASELINE', null, null, 'ACTIVE'
         from inserted_document
       returning id
     )
     select inserted_document.*, inserted_variant.id as baseline_variant_id
       from inserted_document cross join inserted_variant`,
    [
      input.tenantId,
      input.documentId,
      input.baselineVariantId,
      input.documentCode,
      input.canonicalTitle,
      input.documentTypeId,
      input.ownerUserId,
      input.owningOrgUnitId,
      input.spaceId,
      input.isGoverningFramework,
    ],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error(`document insert returned ${rows.length} rows`);

  const emittedEvent = await emitDocumentEvent(
    transaction,
    input,
    "document.created",
    "CREATE_DOCUMENT",
    row.row_version,
    null,
    {
      documentCode: row.document_code,
      documentTypeId: row.document_type_id,
      owningOrgUnitId: row.owning_org_unit_id,
      spaceId: row.space_id,
      ownerUserId: row.owner_user_id,
      lifecycleStatus: row.lifecycle_status,
      baselineVariantId: row.baseline_variant_id,
    },
    row.baseline_variant_id,
  );

  return {
    id: row.id,
    baselineVariantId: row.baseline_variant_id,
    documentCode: row.document_code,
    canonicalTitle: row.canonical_title,
    documentTypeId: row.document_type_id,
    ownerUserId: row.owner_user_id,
    owningOrgUnitId: row.owning_org_unit_id,
    spaceId: row.space_id,
    lifecycleStatus: "PLANNED",
    isGoverningFramework: row.is_governing_framework,
    rowVersion: row.row_version,
    emittedEvent,
  };
}

/** Change only non-obligation register metadata. Requires document.manage. */
export async function changeDocumentMetadata(
  transaction: AuditTransaction,
  input: ChangeDocumentMetadataInput,
): Promise<ChangedDocument> {
  validateContext(input);
  requireUuid(input.documentId, "documentId");
  validateExpectedRowVersion(input.expectedRowVersion);
  if (input.documentCode !== undefined) requireText(input.documentCode, "documentCode");
  if (input.canonicalTitle !== undefined) requireText(input.canonicalTitle, "canonicalTitle");
  if (input.owningOrgUnitId !== undefined) {
    requireUuid(input.owningOrgUnitId, "owningOrgUnitId");
  }
  if (input.spaceId !== undefined) requireNullableUuid(input.spaceId, "spaceId");
  if (input.isGoverningFramework !== undefined && typeof input.isGoverningFramework !== "boolean") {
    throw new TypeError("isGoverningFramework must be a boolean");
  }

  const current = await lockedDocument(transaction, input.tenantId, input.documentId);
  requireCurrentVersion(current, input.expectedRowVersion);
  const desired = {
    documentCode: input.documentCode ?? current.document_code,
    canonicalTitle: input.canonicalTitle ?? current.canonical_title,
    owningOrgUnitId: input.owningOrgUnitId ?? current.owning_org_unit_id,
    spaceId: input.spaceId === undefined ? current.space_id : input.spaceId,
    isGoverningFramework: input.isGoverningFramework ?? current.is_governing_framework,
  };
  const before: Record<string, string | boolean | null> = {};
  const after: Record<string, string | boolean | null> = {};
  const changes = [
    ["documentCode", current.document_code, desired.documentCode],
    ["canonicalTitle", current.canonical_title, desired.canonicalTitle],
    ["owningOrgUnitId", current.owning_org_unit_id, desired.owningOrgUnitId],
    ["spaceId", current.space_id, desired.spaceId],
    ["isGoverningFramework", current.is_governing_framework, desired.isGoverningFramework],
  ] as const;
  for (const [key, prior, next] of changes) {
    if (prior !== next) {
      before[key] = prior;
      after[key] = next;
    }
  }
  if (Object.keys(after).length === 0) throw new DocumentNoChangeError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document
        set document_code = $3::text,
            canonical_title = $4::text,
            owning_org_unit_id = $5::uuid,
            space_id = $6::uuid,
            is_governing_framework = $7::boolean,
            updated_at = now(),
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $8::integer
      returning id, row_version`,
    [
      input.tenantId,
      input.documentId,
      desired.documentCode,
      desired.canonicalTitle,
      desired.owningOrgUnitId,
      desired.spaceId,
      desired.isGoverningFramework,
      input.expectedRowVersion,
    ],
  );
  const row = rows[0];
  if (!row) throw new DocumentConcurrencyError();
  const emittedEvent = await emitDocumentEvent(
    transaction,
    input,
    "document.metadata_changed",
    "CHANGE_DOCUMENT_METADATA",
    row.row_version,
    before,
    after,
  );
  return { id: row.id, rowVersion: row.row_version, emittedEvent };
}

/** Change the accountable owner, including deliberate vacancy. Requires document.manage. */
export async function changeDocumentOwner(
  transaction: AuditTransaction,
  input: ChangeDocumentOwnerInput,
): Promise<ChangedDocument> {
  validateContext(input);
  requireUuid(input.documentId, "documentId");
  requireNullableUuid(input.ownerUserId, "ownerUserId");
  validateExpectedRowVersion(input.expectedRowVersion);
  const current = await lockedDocument(transaction, input.tenantId, input.documentId);
  requireCurrentVersion(current, input.expectedRowVersion);
  if (current.owner_user_id === input.ownerUserId) throw new DocumentNoChangeError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document
        set owner_user_id = $3::uuid, updated_at = now(), row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $4::integer
      returning id, row_version`,
    [input.tenantId, input.documentId, input.ownerUserId, input.expectedRowVersion],
  );
  const row = rows[0];
  if (!row) throw new DocumentConcurrencyError();
  const emittedEvent = await emitDocumentEvent(
    transaction,
    input,
    "document.owner_changed",
    "CHANGE_DOCUMENT_OWNER",
    row.row_version,
    { ownerUserId: current.owner_user_id },
    { ownerUserId: input.ownerUserId },
  );
  return { id: row.id, rowVersion: row.row_version, emittedEvent };
}

/** Change the authoritative document type, never a submitted version snapshot. */
export async function changeDocumentType(
  transaction: AuditTransaction,
  input: ChangeDocumentTypeInput,
): Promise<ChangedDocument> {
  validateContext(input);
  requireUuid(input.documentId, "documentId");
  requireUuid(input.documentTypeId, "documentTypeId");
  validateExpectedRowVersion(input.expectedRowVersion);
  const current = await lockedDocument(transaction, input.tenantId, input.documentId);
  requireCurrentVersion(current, input.expectedRowVersion);
  if (current.document_type_id === input.documentTypeId) throw new DocumentNoChangeError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document
        set document_type_id = $3::uuid, updated_at = now(), row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $4::integer
      returning id, row_version`,
    [input.tenantId, input.documentId, input.documentTypeId, input.expectedRowVersion],
  );
  const row = rows[0];
  if (!row) throw new DocumentConcurrencyError();
  const emittedEvent = await emitDocumentEvent(
    transaction,
    input,
    "document.type_changed",
    "CHANGE_DOCUMENT_TYPE",
    row.row_version,
    { documentTypeId: current.document_type_id },
    { documentTypeId: input.documentTypeId },
  );
  return { id: row.id, rowVersion: row.row_version, emittedEvent };
}

/** Retire a planned document with a reason. Requires document.retire. */
export async function retireDocument(
  transaction: AuditTransaction,
  input: RetireDocumentInput,
): Promise<ChangedDocument> {
  validateContext(input);
  requireUuid(input.documentId, "documentId");
  validateExpectedRowVersion(input.expectedRowVersion);
  requireText(input.retirementReason, "retirementReason");
  const current = await lockedDocument(transaction, input.tenantId, input.documentId);
  requireCurrentVersion(current, input.expectedRowVersion);
  if (current.lifecycle_status !== "PLANNED") throw new DocumentLifecycleError();

  const { rows } = await transaction.query<{ id: string; row_version: number }>(
    `update document
        set lifecycle_status = 'RETIRED',
            retired_at = $3::timestamptz,
            retirement_reason = $4::text,
            updated_at = now(),
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $5::integer
      returning id, row_version`,
    [
      input.tenantId,
      input.documentId,
      input.occurredAt.toISOString(),
      input.retirementReason,
      input.expectedRowVersion,
    ],
  );
  const row = rows[0];
  if (!row) throw new DocumentConcurrencyError();
  const emittedEvent = await emitDocumentEvent(
    transaction,
    input,
    "document.retired",
    "RETIRE_DOCUMENT",
    row.row_version,
    { lifecycleStatus: current.lifecycle_status },
    {
      lifecycleStatus: "RETIRED",
      retiredAt: input.occurredAt.toISOString(),
      retirementReason: input.retirementReason,
    },
  );
  return { id: row.id, rowVersion: row.row_version, emittedEvent };
}

/** Tenant-scoped register projection; null ownership is made explicit, never hidden. */
export async function listDocumentRegister(
  transaction: AuditTransaction,
  tenantId: string,
): Promise<DocumentRegisterRow[]> {
  requireUuid(tenantId, "tenantId");
  const { rows } = await transaction.query<DocumentRow & { ownership_exception: boolean }>(
    `select id, document_code, canonical_title, document_type_id, owner_user_id,
            owner_user_id is null as ownership_exception,
            owning_org_unit_id, space_id, lifecycle_status, is_governing_framework,
            retired_at, retirement_reason, row_version
       from document
      where tenant_id = $1::uuid
      order by document_code, id`,
    [tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    documentCode: row.document_code,
    canonicalTitle: row.canonical_title,
    documentTypeId: row.document_type_id,
    ownerUserId: row.owner_user_id,
    ownershipException: row.ownership_exception,
    owningOrgUnitId: row.owning_org_unit_id,
    spaceId: row.space_id,
    lifecycleStatus: row.lifecycle_status,
    isGoverningFramework: row.is_governing_framework,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason,
    rowVersion: row.row_version,
  }));
}
