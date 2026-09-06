import {
  emitAuditEvent,
  type AuditActorType,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";
import {
  CANONICALISATION_SCHEMA_VERSION,
  buildCanonicalManifest,
  digestCanonicalManifest,
  serializeCanonicalManifest,
  sha256Digest,
  type CanonicalAttachment,
  type CanonicalContentPart,
  type CanonicalManifest,
  type Sha256Digest,
} from "./content-digest.js";
import type { VersionLifecycle } from "./version.js";

/** Authorization contracts only; ADR-0003's evaluator has not landed. */
export const CONTENT_REVISION_REQUIRED_CAPABILITIES = Object.freeze({
  create: "document.edit_draft",
  addAttachment: "document.edit_draft",
  replaceAttachment: "document.edit_draft",
  removeAttachment: "document.edit_draft",
  submit: "document.submit",
} as const);

interface RevisionAuditContext {
  actor: Readonly<{ type: AuditActorType; id: string | null }>;
  configurationVersionId: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface CreateContentRevisionInput extends RevisionAuditContext {
  tenantId: string;
  revisionId: string;
  documentVersionId: string;
  createdByUserId: string;
  contentBytes: Uint8Array;
}

export interface AddContentAttachmentInput {
  tenantId: string;
  revisionId: string;
  attachmentId: string;
  expectedRevisionRowVersion: number;
  filename: string;
  bytes: Uint8Array;
}

export type ReplaceContentAttachmentInput = AddContentAttachmentInput;

export interface RemoveContentAttachmentInput {
  tenantId: string;
  revisionId: string;
  attachmentId: string;
  expectedRevisionRowVersion: number;
}

export interface SubmitContentRevisionInput extends RevisionAuditContext {
  tenantId: string;
  documentVersionId: string;
  revisionId: string;
  expectedVersionRowVersion: number;
  expectedRevisionRowVersion: number;
}

export interface CreatedContentRevision {
  id: string;
  documentId: string;
  documentVariantId: string;
  documentVersionId: string;
  revisionSequence: number;
  contentRef: string;
  canonicalManifest: string;
  canonicalisationSchemaVersion: typeof CANONICALISATION_SCHEMA_VERSION;
  contentDigest: Sha256Digest;
  rowVersion: number;
  versionRowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

export interface GovernedAttachment {
  id: string;
  contentRevisionId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  storageRef: string;
  digest: Sha256Digest;
  rowVersion: number;
}

export interface ChangedContentRevision {
  id: string;
  canonicalManifest: string;
  canonicalisationSchemaVersion: typeof CANONICALISATION_SCHEMA_VERSION;
  contentDigest: Sha256Digest;
  rowVersion: number;
}

export interface ChangedContentAttachment extends ChangedContentRevision {
  attachment: GovernedAttachment;
}

export interface SubmittedContentRevision extends ChangedContentRevision {
  documentVersionId: string;
  submittedAt: Date;
  versionRowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  document_variant_id: string;
  lifecycle_state: VersionLifecycle;
  row_version: number;
}

interface RevisionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  document_variant_id: string;
  document_version_id: string;
  lifecycle_state: VersionLifecycle;
  canonical_manifest: unknown;
  submitted_at: Date | null;
  row_version: number;
}

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  content_revision_id: string;
  filename: string;
  media_type: string;
  byte_size: string | number;
  storage_ref: string;
  digest: Sha256Digest;
  row_version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const AUDIT_CONTEXT_KEYS = [
  "actor",
  "configurationVersionId",
  "occurredAt",
  "requestId",
  "correlationId",
  "sourceChannel",
] as const;

export class ContentRevisionNotFoundError extends Error {
  constructor() {
    super("content revision not found");
    this.name = "ContentRevisionNotFoundError";
  }
}

export class ContentAttachmentNotFoundError extends Error {
  constructor() {
    super("content attachment not found");
    this.name = "ContentAttachmentNotFoundError";
  }
}

export class ContentRevisionConcurrencyError extends Error {
  constructor() {
    super("content revision row_version is stale");
    this.name = "ContentRevisionConcurrencyError";
  }
}

export class ContentRevisionLifecycleError extends Error {
  constructor(message = "document version lifecycle does not permit this content change") {
    super(message);
    this.name = "ContentRevisionLifecycleError";
  }
}

export class ContentRevisionSubmittedError extends Error {
  constructor() {
    super("submitted content revision is immutable");
    this.name = "ContentRevisionSubmittedError";
  }
}

function requireRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  field: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${field} must contain exactly these keys: ${wanted.join(", ")}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${field} must not contain symbol keys`);
  }
}

function validateExactInput(input: unknown, expected: readonly string[]): void {
  requireRecord(input, "input");
  requireExactKeys(input, "input", expected);
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be positive`);
}

function requireFilename(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("filename cannot be blank");
  }
}

function copyBytes(value: Uint8Array, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be a Uint8Array`);
  return new Uint8Array(value);
}

function validateContext(input: RevisionAuditContext & { tenantId: string }): void {
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

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

/** Inspect magic bytes first, then accept strict UTF-8 as plain text. */
export function inspectContentMediaType(bytes: Uint8Array): string {
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  try {
    const text = TEXT_DECODER.decode(bytes);
    if (!text.includes("\u0000")) return "text/plain";
  } catch {
    // Invalid UTF-8 remains governed as an opaque binary file.
  }
  return "application/octet-stream";
}

function storageReference(tenantId: string, digest: Sha256Digest): string {
  return `t/${tenantId.toLowerCase()}/blob/${digest.slice("sha-256:".length)}`;
}

function inspectBytes(
  tenantId: string,
  bytes: Uint8Array,
): {
  mediaType: string;
  byteSize: number;
  digest: Sha256Digest;
  storageRef: string;
} {
  const digest = sha256Digest(bytes);
  return {
    mediaType: inspectContentMediaType(bytes),
    byteSize: bytes.byteLength,
    digest,
    storageRef: storageReference(tenantId, digest),
  };
}

async function lockVersion(
  transaction: AuditTransaction,
  tenantId: string,
  documentVersionId: string,
): Promise<VersionRow> {
  const { rows } = await transaction.query<VersionRow>(
    `select version.id, variant.document_id, version.document_variant_id,
            version.lifecycle_state, version.row_version
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where version.tenant_id = $1::uuid and version.id = $2::uuid
      for update of version`,
    [tenantId, documentVersionId],
  );
  const version = rows[0];
  if (!version) throw new ContentRevisionNotFoundError();
  return version;
}

async function lockRevision(
  transaction: AuditTransaction,
  tenantId: string,
  revisionId: string,
): Promise<RevisionRow> {
  const { rows } = await transaction.query<RevisionRow>(
    `select revision.id, variant.document_id, version.document_variant_id,
            revision.document_version_id, version.lifecycle_state,
            revision.canonical_manifest, revision.submitted_at, revision.row_version
       from content_revision revision
       join document_version version
         on version.tenant_id = revision.tenant_id
        and version.id = revision.document_version_id
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where revision.tenant_id = $1::uuid and revision.id = $2::uuid
      for update of revision, version`,
    [tenantId, revisionId],
  );
  const revision = rows[0];
  if (!revision) throw new ContentRevisionNotFoundError();
  return revision;
}

function requireEditableRevision(row: RevisionRow, expectedRowVersion: number): void {
  if (row.row_version !== expectedRowVersion) throw new ContentRevisionConcurrencyError();
  if (row.submitted_at !== null) throw new ContentRevisionSubmittedError();
  if (row.lifecycle_state !== "DRAFT") throw new ContentRevisionLifecycleError();
}

function attachmentFromRow(row: AttachmentRow): GovernedAttachment {
  const byteSize = Number(row.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("content attachment byte_size is outside JavaScript's safe integer range");
  }
  return {
    id: row.id,
    contentRevisionId: row.content_revision_id,
    filename: row.filename,
    mediaType: row.media_type,
    byteSize,
    storageRef: row.storage_ref,
    digest: row.digest,
    rowVersion: row.row_version,
  };
}

async function listAttachments(
  transaction: AuditTransaction,
  tenantId: string,
  revisionId: string,
): Promise<GovernedAttachment[]> {
  const { rows } = await transaction.query<AttachmentRow>(
    `select id, content_revision_id, filename, media_type, byte_size,
            storage_ref, digest, row_version
       from content_attachment
      where tenant_id = $1::uuid and content_revision_id = $2::uuid
      order by filename, id`,
    [tenantId, revisionId],
  );
  return rows.map(attachmentFromRow);
}

function contentPartsFromStoredManifest(
  storedManifest: unknown,
  revisionId: string,
): readonly CanonicalContentPart[] {
  if (typeof storedManifest !== "string") {
    throw new Error("stored canonical manifest must be exact canonical JSON text");
  }
  const parsed: unknown = JSON.parse(storedManifest);
  requireRecord(parsed, "stored canonical manifest");
  if (parsed.contentRevisionId !== revisionId || !Array.isArray(parsed.contentParts)) {
    throw new Error("stored canonical manifest does not describe this content revision");
  }
  return parsed.contentParts as readonly CanonicalContentPart[];
}

function manifestWithAttachments(
  revision: RevisionRow,
  attachments: readonly GovernedAttachment[],
): CanonicalManifest {
  return buildCanonicalManifest({
    contentRevisionId: revision.id,
    contentParts: contentPartsFromStoredManifest(revision.canonical_manifest, revision.id),
    attachments: attachments.map<CanonicalAttachment>((attachment) => ({
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      digest: attachment.digest,
    })),
  });
}

async function updateWorkingManifest(
  transaction: AuditTransaction,
  tenantId: string,
  revision: RevisionRow,
  attachments: readonly GovernedAttachment[],
): Promise<ChangedContentRevision> {
  const manifest = manifestWithAttachments(revision, attachments);
  const canonicalManifest = serializeCanonicalManifest(manifest);
  const contentDigest = digestCanonicalManifest(manifest);
  const { rows } = await transaction.query<
    Record<string, unknown> & { id: string; row_version: number }
  >(
    `update content_revision
        set canonical_manifest = $3::jsonb,
            canonicalisation_schema_version = $4::integer,
            content_digest = $5::text,
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $6::integer
      returning id, row_version`,
    [
      tenantId,
      revision.id,
      JSON.stringify(canonicalManifest),
      CANONICALISATION_SCHEMA_VERSION,
      contentDigest,
      revision.row_version,
    ],
  );
  const changed = rows[0];
  if (!changed) throw new ContentRevisionConcurrencyError();
  return {
    id: changed.id,
    canonicalManifest,
    canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
    contentDigest,
    rowVersion: changed.row_version,
  };
}

/** Save one file-centric drafting snapshot. Requires document.edit_draft. */
export async function createContentRevision(
  transaction: AuditTransaction,
  input: CreateContentRevisionInput,
): Promise<CreatedContentRevision> {
  validateExactInput(input, [
    "tenantId",
    "revisionId",
    "documentVersionId",
    "createdByUserId",
    "contentBytes",
    ...AUDIT_CONTEXT_KEYS,
  ]);
  validateContext(input);
  requireUuid(input.revisionId, "revisionId");
  requireUuid(input.documentVersionId, "documentVersionId");
  requireUuid(input.createdByUserId, "createdByUserId");
  const bytes = copyBytes(input.contentBytes, "contentBytes");
  const version = await lockVersion(transaction, input.tenantId, input.documentVersionId);
  if (version.lifecycle_state === "CHANGES_REQUESTED") {
    const returned = await transaction.query<Record<string, unknown> & { row_version: number }>(
      `update document_version
          set lifecycle_state = 'DRAFT', row_version = row_version + 1
        where tenant_id = $1::uuid and id = $2::uuid and row_version = $3::integer
        returning row_version`,
      [input.tenantId, input.documentVersionId, version.row_version],
    );
    const transitioned = returned.rows[0];
    if (!transitioned) throw new ContentRevisionConcurrencyError();
    version.lifecycle_state = "DRAFT";
    version.row_version = transitioned.row_version;
  }
  if (version.lifecycle_state !== "DRAFT") throw new ContentRevisionLifecycleError();

  const inspected = inspectBytes(input.tenantId, bytes);
  const manifest = buildCanonicalManifest({
    contentRevisionId: input.revisionId,
    contentParts: [{ partId: "body", mediaType: inspected.mediaType, digest: inspected.digest }],
    attachments: [],
  });
  const canonicalManifest = serializeCanonicalManifest(manifest);
  const contentDigest = digestCanonicalManifest(manifest);
  const { rows } = await transaction.query<
    Record<string, unknown> & {
      id: string;
      revision_sequence: number;
      row_version: number;
    }
  >(
    `insert into content_revision (
       tenant_id, id, document_version_id, revision_sequence, content_ref,
       canonical_manifest, canonicalisation_schema_version, content_digest, created_by
     )
     select $1::uuid, $2::uuid, $3::uuid,
            coalesce(max(revision_sequence), 0) + 1,
            $4::text, $5::jsonb, $6::integer, $7::text, $8::uuid
       from content_revision
      where tenant_id = $1::uuid and document_version_id = $3::uuid
     returning id, revision_sequence, row_version`,
    [
      input.tenantId,
      input.revisionId,
      input.documentVersionId,
      inspected.storageRef,
      JSON.stringify(canonicalManifest),
      CANONICALISATION_SCHEMA_VERSION,
      contentDigest,
      input.createdByUserId,
    ],
  );
  const revision = rows[0];
  if (!revision || rows.length !== 1) {
    throw new Error(`content revision insert returned ${rows.length} rows`);
  }
  const emittedEvent = await emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType: "content_revision.created",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "CONTENT_REVISION", id: revision.id },
    documentId: version.document_id,
    documentVariantId: version.document_variant_id,
    documentVersionId: input.documentVersionId,
    action: "CREATE_CONTENT_REVISION",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: null,
    safeAfter: {
      documentVersionId: input.documentVersionId,
      revisionSequence: revision.revision_sequence,
      canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
      contentDigest,
    },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `content_revision.created:${revision.id}`,
  });
  return {
    id: revision.id,
    documentId: version.document_id,
    documentVariantId: version.document_variant_id,
    documentVersionId: input.documentVersionId,
    revisionSequence: revision.revision_sequence,
    contentRef: inspected.storageRef,
    canonicalManifest,
    canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
    contentDigest,
    rowVersion: revision.row_version,
    versionRowVersion: version.row_version,
    emittedEvent,
  };
}

/** Incorporate a governed file into the working manifest. Requires document.edit_draft. */
export async function addContentAttachment(
  transaction: AuditTransaction,
  input: AddContentAttachmentInput,
): Promise<ChangedContentAttachment> {
  validateExactInput(input, [
    "tenantId",
    "revisionId",
    "attachmentId",
    "expectedRevisionRowVersion",
    "filename",
    "bytes",
  ]);
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.revisionId, "revisionId");
  requireUuid(input.attachmentId, "attachmentId");
  requirePositiveInteger(input.expectedRevisionRowVersion, "expectedRevisionRowVersion");
  requireFilename(input.filename);
  const bytes = copyBytes(input.bytes, "bytes");
  const revision = await lockRevision(transaction, input.tenantId, input.revisionId);
  requireEditableRevision(revision, input.expectedRevisionRowVersion);
  const inspected = inspectBytes(input.tenantId, bytes);
  const { rows } = await transaction.query<AttachmentRow>(
    `insert into content_attachment (
       tenant_id, id, content_revision_id, filename, media_type,
       byte_size, storage_ref, digest
     ) values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
               $6::bigint, $7::text, $8::text)
     returning id, content_revision_id, filename, media_type, byte_size,
               storage_ref, digest, row_version`,
    [
      input.tenantId,
      input.attachmentId,
      input.revisionId,
      input.filename,
      inspected.mediaType,
      inspected.byteSize,
      inspected.storageRef,
      inspected.digest,
    ],
  );
  const attachmentRow = rows[0];
  if (!attachmentRow || rows.length !== 1) {
    throw new Error(`content attachment insert returned ${rows.length} rows`);
  }
  const attachment = attachmentFromRow(attachmentRow);
  const changed = await updateWorkingManifest(
    transaction,
    input.tenantId,
    revision,
    await listAttachments(transaction, input.tenantId, input.revisionId),
  );
  return { ...changed, attachment };
}

/** Replace governed bytes and remeasure every stored property. Requires document.edit_draft. */
export async function replaceContentAttachment(
  transaction: AuditTransaction,
  input: ReplaceContentAttachmentInput,
): Promise<ChangedContentAttachment> {
  validateExactInput(input, [
    "tenantId",
    "revisionId",
    "attachmentId",
    "expectedRevisionRowVersion",
    "filename",
    "bytes",
  ]);
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.revisionId, "revisionId");
  requireUuid(input.attachmentId, "attachmentId");
  requirePositiveInteger(input.expectedRevisionRowVersion, "expectedRevisionRowVersion");
  requireFilename(input.filename);
  const bytes = copyBytes(input.bytes, "bytes");
  const revision = await lockRevision(transaction, input.tenantId, input.revisionId);
  requireEditableRevision(revision, input.expectedRevisionRowVersion);
  const inspected = inspectBytes(input.tenantId, bytes);
  const { rows } = await transaction.query<AttachmentRow>(
    `update content_attachment
        set filename = $4::text, media_type = $5::text, byte_size = $6::bigint,
            storage_ref = $7::text, digest = $8::text, row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and content_revision_id = $3::uuid
      returning id, content_revision_id, filename, media_type, byte_size,
                storage_ref, digest, row_version`,
    [
      input.tenantId,
      input.attachmentId,
      input.revisionId,
      input.filename,
      inspected.mediaType,
      inspected.byteSize,
      inspected.storageRef,
      inspected.digest,
    ],
  );
  const attachmentRow = rows[0];
  if (!attachmentRow) throw new ContentAttachmentNotFoundError();
  const attachment = attachmentFromRow(attachmentRow);
  const changed = await updateWorkingManifest(
    transaction,
    input.tenantId,
    revision,
    await listAttachments(transaction, input.tenantId, input.revisionId),
  );
  return { ...changed, attachment };
}

/** Remove a governed file and rebuild the complete manifest. Requires document.edit_draft. */
export async function removeContentAttachment(
  transaction: AuditTransaction,
  input: RemoveContentAttachmentInput,
): Promise<ChangedContentRevision> {
  validateExactInput(input, [
    "tenantId",
    "revisionId",
    "attachmentId",
    "expectedRevisionRowVersion",
  ]);
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.revisionId, "revisionId");
  requireUuid(input.attachmentId, "attachmentId");
  requirePositiveInteger(input.expectedRevisionRowVersion, "expectedRevisionRowVersion");
  const revision = await lockRevision(transaction, input.tenantId, input.revisionId);
  requireEditableRevision(revision, input.expectedRevisionRowVersion);
  const { rows } = await transaction.query<Record<string, unknown> & { id: string }>(
    `delete from content_attachment
      where tenant_id = $1::uuid and id = $2::uuid and content_revision_id = $3::uuid
      returning id`,
    [input.tenantId, input.attachmentId, input.revisionId],
  );
  if (!rows[0]) throw new ContentAttachmentNotFoundError();
  return updateWorkingManifest(
    transaction,
    input.tenantId,
    revision,
    await listAttachments(transaction, input.tenantId, input.revisionId),
  );
}

/** Atomically finalize the manifest and latch the revision. Requires document.submit. */
export async function submitContentRevision(
  transaction: AuditTransaction,
  input: SubmitContentRevisionInput,
): Promise<SubmittedContentRevision> {
  validateExactInput(input, [
    "tenantId",
    "documentVersionId",
    "revisionId",
    "expectedVersionRowVersion",
    "expectedRevisionRowVersion",
    ...AUDIT_CONTEXT_KEYS,
  ]);
  validateContext(input);
  requireUuid(input.documentVersionId, "documentVersionId");
  requireUuid(input.revisionId, "revisionId");
  requirePositiveInteger(input.expectedVersionRowVersion, "expectedVersionRowVersion");
  requirePositiveInteger(input.expectedRevisionRowVersion, "expectedRevisionRowVersion");
  const revision = await lockRevision(transaction, input.tenantId, input.revisionId);
  if (revision.document_version_id !== input.documentVersionId) {
    throw new ContentRevisionNotFoundError();
  }
  requireEditableRevision(revision, input.expectedRevisionRowVersion);
  const version = await lockVersion(transaction, input.tenantId, input.documentVersionId);
  if (version.row_version !== input.expectedVersionRowVersion) {
    throw new ContentRevisionConcurrencyError();
  }
  if (version.lifecycle_state !== "DRAFT") throw new ContentRevisionLifecycleError();

  const manifest = manifestWithAttachments(
    revision,
    await listAttachments(transaction, input.tenantId, input.revisionId),
  );
  const canonicalManifest = serializeCanonicalManifest(manifest);
  const contentDigest = digestCanonicalManifest(manifest);
  const { rows } = await transaction.query<
    Record<string, unknown> & { id: string; submitted_at: Date; row_version: number }
  >(
    `update content_revision
        set canonical_manifest = $3::jsonb,
            canonicalisation_schema_version = $4::integer,
            content_digest = $5::text,
            submitted_at = $6::timestamptz,
            row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $7::integer
      returning id, submitted_at, row_version`,
    [
      input.tenantId,
      input.revisionId,
      JSON.stringify(canonicalManifest),
      CANONICALISATION_SCHEMA_VERSION,
      contentDigest,
      input.occurredAt.toISOString(),
      input.expectedRevisionRowVersion,
    ],
  );
  const submitted = rows[0];
  if (!submitted) throw new ContentRevisionConcurrencyError();
  const versionResult = await transaction.query<
    Record<string, unknown> & { id: string; row_version: number }
  >(
    `update document_version
        set lifecycle_state = 'IN_REVIEW', row_version = row_version + 1
      where tenant_id = $1::uuid and id = $2::uuid and row_version = $3::integer
      returning id, row_version`,
    [input.tenantId, input.documentVersionId, input.expectedVersionRowVersion],
  );
  const changedVersion = versionResult.rows[0];
  if (!changedVersion) throw new ContentRevisionConcurrencyError();
  const emittedEvent = await emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType: "version.submitted",
    eventSchemaVersion: 1,
    occurredAt: input.occurredAt,
    actor: input.actor,
    subject: { type: "DOCUMENT_VERSION", id: input.documentVersionId },
    documentId: revision.document_id,
    documentVariantId: revision.document_variant_id,
    documentVersionId: input.documentVersionId,
    action: "SUBMIT_DOCUMENT_VERSION",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: { lifecycleState: "DRAFT" },
    safeAfter: {
      lifecycleState: "IN_REVIEW",
      contentRevisionId: input.revisionId,
      canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
      contentDigest,
    },
    configurationVersionId: input.configurationVersionId,
    dedupeKey: `version.submitted:${input.documentVersionId}:${input.revisionId}`,
  });
  return {
    id: submitted.id,
    documentVersionId: input.documentVersionId,
    canonicalManifest,
    canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
    contentDigest,
    submittedAt: submitted.submitted_at,
    rowVersion: submitted.row_version,
    versionRowVersion: changedVersion.row_version,
    emittedEvent,
  };
}
