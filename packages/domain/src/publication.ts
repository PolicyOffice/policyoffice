import {
  emitAuditEvents,
  type AuditActorType,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";
import {
  DocumentVersionConcurrencyError,
  DocumentVersionLifecycleError,
  DocumentVersionNotFoundError,
  type VersionLifecycle,
} from "./version.js";

export const PUBLICATION_REQUIRED_CAPABILITIES = Object.freeze({
  publish: "document.publish",
  withdraw: "document.withdraw",
} as const);

export const PUBLICATION_LIFECYCLE_TRANSITIONS = Object.freeze({
  publish: Object.freeze({ from: "APPROVED", to: "PUBLISHED" }),
  immediateEffect: Object.freeze({ from: "PUBLISHED", to: "EFFECTIVE" }),
  withdraw: Object.freeze([
    Object.freeze({ from: "PUBLISHED", to: "WITHDRAWN" }),
    Object.freeze({ from: "EFFECTIVE", to: "WITHDRAWN" }),
  ]),
} as const);

interface PublicationAuditContext {
  actor: Readonly<{ type: AuditActorType; id: string | null }>;
  configurationVersionId: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface PublishDocumentVersionInput extends PublicationAuditContext {
  tenantId: string;
  versionId: string;
  expectedRowVersion: number;
  effectiveFrom: Date;
}

export interface WithdrawDocumentVersionInput extends PublicationAuditContext {
  tenantId: string;
  versionId: string;
  expectedRowVersion: number;
  withdrawalReason: string;
}

export interface PublishedDocumentVersion {
  id: string;
  documentId: string;
  documentVariantId: string;
  lifecycleState: "PUBLISHED" | "EFFECTIVE";
  publishedAt: Date;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  rowVersion: number;
  immediate: boolean;
  predecessorVersionId: string | null;
  documentActivated: boolean;
  emittedEvents: readonly EmittedAuditEvent[];
}

export interface WithdrawnDocumentVersion {
  id: string;
  documentId: string;
  documentVariantId: string;
  previousLifecycleState: "PUBLISHED" | "EFFECTIVE";
  lifecycleState: "WITHDRAWN";
  effectiveFrom: Date;
  previousEffectiveUntil: Date | null;
  effectiveUntil: Date;
  withdrawnAt: Date;
  withdrawalReason: string;
  rowVersion: number;
  emittedEvent: EmittedAuditEvent;
}

export interface EffectiveDocumentVersion {
  id: string;
  documentId: string;
  documentVariantId: string;
  lifecycleState: VersionLifecycle;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

interface PublishedVersionRow extends Record<string, unknown> {
  version_id: string;
  document_id: string;
  document_variant_id: string;
  configuration_version_id: string;
  lifecycle_state: "PUBLISHED" | "EFFECTIVE";
  published_at: Date;
  effective_from: Date;
  effective_until: Date | null;
  row_version: number;
  immediate: boolean;
  predecessor_version_id: string | null;
  predecessor_previous_state: VersionLifecycle | null;
  predecessor_previous_until: Date | null;
  predecessor_row_version: number | null;
  document_activated: boolean;
}

interface WithdrawnVersionRow extends Record<string, unknown> {
  version_id: string;
  document_id: string;
  document_variant_id: string;
  configuration_version_id: string;
  previous_lifecycle_state: "PUBLISHED" | "EFFECTIVE";
  lifecycle_state: "WITHDRAWN";
  effective_from: Date;
  previous_effective_until: Date | null;
  effective_until: Date;
  withdrawn_at: Date;
  withdrawal_reason: string;
  row_version: number;
}

interface EffectiveVersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  document_variant_id: string;
  lifecycle_state: VersionLifecycle;
  effective_from: Date;
  effective_until: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set<AuditActorType>(["USER", "BODY", "API_CLIENT", "SYSTEM"]);
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

export class DocumentVersionScheduleConflictError extends Error {
  readonly constraint = "one_effective_version_per_variant";

  constructor() {
    super("another document version already claims the proposed effective interval");
    this.name = "DocumentVersionScheduleConflictError";
  }
}

export class DocumentVersionPublicationDateError extends Error {
  constructor() {
    super("retroactive publication is not supported");
    this.name = "DocumentVersionPublicationDateError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function validateContext(input: PublicationAuditContext & { tenantId: string }): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!ACTOR_TYPES.has(input.actor.type)) throw new TypeError("actor.type is not supported");
  if (input.actor.id !== null) requireUuid(input.actor.id, "actor.id");
  requireDate(input.occurredAt, "occurredAt");
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
}

function validateExpectedRowVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("expectedRowVersion must be a positive integer");
  }
}

function databaseError(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; constraint?: unknown };
    if (
      candidate.code === "40001" &&
      candidate.constraint === "document_version_row_version_current"
    ) {
      throw new DocumentVersionConcurrencyError();
    }
    if (
      candidate.constraint === "document_version_publication_lifecycle" ||
      candidate.constraint === "document_version_withdrawal_lifecycle" ||
      candidate.constraint === "document_version_predecessor_lifecycle"
    ) {
      throw new DocumentVersionLifecycleError();
    }
    if (candidate.constraint === "document_version_retroactive_publication_unsupported") {
      throw new DocumentVersionPublicationDateError();
    }
    if (candidate.constraint === "one_effective_version_per_variant") {
      throw new DocumentVersionScheduleConflictError();
    }
  }
  throw error;
}

function instant(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function auditBase(
  input: PublicationAuditContext & { tenantId: string },
): Pick<
  AuditEventInput,
  | "tenantId"
  | "eventSchemaVersion"
  | "actor"
  | "outcome"
  | "requestId"
  | "correlationId"
  | "sourceChannel"
  | "configurationVersionId"
> {
  return {
    tenantId: input.tenantId,
    eventSchemaVersion: 1,
    actor: input.actor,
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    configurationVersionId: input.configurationVersionId,
  };
}

function publicationEvents(
  input: PublishDocumentVersionInput,
  row: PublishedVersionRow,
): AuditEventInput[] {
  const base = auditBase(input);
  const coordinates = {
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
  } as const;
  const events: AuditEventInput[] = [
    {
      ...base,
      ...coordinates,
      eventType: "version.published",
      occurredAt: row.published_at,
      subject: { type: "DOCUMENT_VERSION", id: row.version_id },
      documentVersionId: row.version_id,
      action: "PUBLISH_DOCUMENT_VERSION",
      safeBefore: { lifecycleState: "APPROVED" },
      safeAfter: {
        lifecycleState: "PUBLISHED",
        publishedAt: row.published_at.toISOString(),
        effectiveFrom: row.effective_from.toISOString(),
        effectiveUntil: instant(row.effective_until),
        predecessorVersionId: row.predecessor_version_id,
      },
      dedupeKey: `version.published:${row.version_id}`,
    },
  ];

  if (!row.immediate) return events;

  if (row.predecessor_version_id !== null) {
    events.push({
      ...base,
      ...coordinates,
      eventType: "version.superseded",
      occurredAt: row.effective_from,
      subject: { type: "DOCUMENT_VERSION", id: row.predecessor_version_id },
      documentVersionId: row.predecessor_version_id,
      action: "SUPERSEDE_DOCUMENT_VERSION",
      safeBefore: {
        lifecycleState: row.predecessor_previous_state,
        effectiveUntil: instant(row.predecessor_previous_until),
      },
      safeAfter: {
        lifecycleState: "SUPERSEDED",
        effectiveUntil: row.effective_from.toISOString(),
        supersededByVersionId: row.version_id,
      },
      dedupeKey: `version.superseded:${row.predecessor_version_id}`,
    });
  }

  events.push({
    ...base,
    ...coordinates,
    eventType: "version.effective",
    occurredAt: row.effective_from,
    subject: { type: "DOCUMENT_VERSION", id: row.version_id },
    documentVersionId: row.version_id,
    action: "MAKE_DOCUMENT_VERSION_EFFECTIVE",
    safeBefore: { lifecycleState: "PUBLISHED" },
    safeAfter: {
      lifecycleState: "EFFECTIVE",
      effectiveFrom: row.effective_from.toISOString(),
      effectiveUntil: instant(row.effective_until),
    },
    dedupeKey: `version.effective:${row.version_id}`,
  });

  if (row.document_activated) {
    events.push({
      ...base,
      eventType: "document.activated",
      occurredAt: row.effective_from,
      subject: { type: "DOCUMENT", id: row.document_id },
      documentId: row.document_id,
      action: "ACTIVATE_DOCUMENT",
      safeBefore: { lifecycleStatus: "PLANNED" },
      safeAfter: { lifecycleStatus: "ACTIVE", effectiveVersionId: row.version_id },
      dedupeKey: `document.activated:${row.document_id}`,
    });
  }

  return events;
}

/**
 * Requires document.publish. The SQL function is the only privileged effectivity writer;
 * the caller-supplied transaction keeps its result atomic with these canonical events.
 */
export async function publishDocumentVersion(
  transaction: AuditTransaction,
  input: PublishDocumentVersionInput,
): Promise<PublishedDocumentVersion> {
  validateContext(input);
  requireUuid(input.versionId, "versionId");
  validateExpectedRowVersion(input.expectedRowVersion);
  requireDate(input.effectiveFrom, "effectiveFrom");
  if (input.effectiveFrom < input.occurredAt) throw new DocumentVersionPublicationDateError();

  let rows: PublishedVersionRow[];
  try {
    ({ rows } = await transaction.query<PublishedVersionRow>(
      `select *
         from publish_document_version($1::uuid, $2::uuid, $3::integer,
                                       $4::timestamptz, $5::timestamptz)`,
      [
        input.tenantId,
        input.versionId,
        input.expectedRowVersion,
        input.effectiveFrom.toISOString(),
        input.occurredAt.toISOString(),
      ],
    ));
  } catch (error) {
    databaseError(error);
  }
  const row = rows[0];
  if (!row) throw new DocumentVersionNotFoundError();

  const emittedEvents = await emitAuditEvents(transaction, publicationEvents(input, row));
  return {
    id: row.version_id,
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    lifecycleState: row.lifecycle_state,
    publishedAt: row.published_at,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    rowVersion: row.row_version,
    immediate: row.immediate,
    predecessorVersionId: row.predecessor_version_id,
    documentActivated: row.document_activated,
    emittedEvents,
  };
}

/** Requires document.withdraw. Withdrawal time is always assigned by PostgreSQL. */
export async function withdrawDocumentVersion(
  transaction: AuditTransaction,
  input: WithdrawDocumentVersionInput,
): Promise<WithdrawnDocumentVersion> {
  validateContext(input);
  requireUuid(input.versionId, "versionId");
  validateExpectedRowVersion(input.expectedRowVersion);
  if (input.withdrawalReason.trim().length === 0) {
    throw new TypeError("withdrawalReason is required");
  }

  let rows: WithdrawnVersionRow[];
  try {
    ({ rows } = await transaction.query<WithdrawnVersionRow>(
      `select *
         from withdraw_document_version($1::uuid, $2::uuid, $3::integer, $4::text)`,
      [input.tenantId, input.versionId, input.expectedRowVersion, input.withdrawalReason],
    ));
  } catch (error) {
    databaseError(error);
  }
  const row = rows[0];
  if (!row) throw new DocumentVersionNotFoundError();

  const [emittedEvent] = await emitAuditEvents(transaction, [
    {
      ...auditBase(input),
      eventType: "version.withdrawn",
      occurredAt: row.withdrawn_at,
      subject: { type: "DOCUMENT_VERSION", id: row.version_id },
      documentId: row.document_id,
      documentVariantId: row.document_variant_id,
      documentVersionId: row.version_id,
      action: "WITHDRAW_DOCUMENT_VERSION",
      safeBefore: {
        lifecycleState: row.previous_lifecycle_state,
        effectiveUntil: instant(row.previous_effective_until),
      },
      safeAfter: {
        lifecycleState: "WITHDRAWN",
        effectiveUntil: row.effective_until.toISOString(),
        withdrawnAt: row.withdrawn_at.toISOString(),
        withdrawalReason: row.withdrawal_reason,
      },
      dedupeKey: `version.withdrawn:${row.version_id}`,
    },
  ]);
  if (!emittedEvent) throw new Error("withdrawal audit insert returned no event");

  return {
    id: row.version_id,
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    previousLifecycleState: row.previous_lifecycle_state,
    lifecycleState: row.lifecycle_state,
    effectiveFrom: row.effective_from,
    previousEffectiveUntil: row.previous_effective_until,
    effectiveUntil: row.effective_until,
    withdrawnAt: row.withdrawn_at,
    withdrawalReason: row.withdrawal_reason,
    rowVersion: row.row_version,
    emittedEvent,
  };
}

/** Resolve current or historical normativity through the same range-containment query. */
export async function resolveEffectiveVersion(
  transaction: AuditTransaction,
  input: Readonly<{ tenantId: string; documentVariantId: string; at: Date }>,
): Promise<EffectiveDocumentVersion | null> {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.documentVariantId, "documentVariantId");
  requireDate(input.at, "at");
  const { rows } = await transaction.query<EffectiveVersionRow>(
    `select version.id,
            variant.document_id,
            version.document_variant_id,
            version.lifecycle_state,
            version.effective_from,
            version.effective_until
       from document_version version
       join document_variant variant
         on variant.tenant_id = version.tenant_id
        and variant.id = version.document_variant_id
      where version.tenant_id = $1::uuid
        and version.document_variant_id = $2::uuid
        and version.effective_range @> $3::timestamptz
        and version.lifecycle_state not in ('WITHDRAWN', 'CANCELLED')
      limit 1`,
    [input.tenantId, input.documentVariantId, input.at.toISOString()],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        documentId: row.document_id,
        documentVariantId: row.document_variant_id,
        lifecycleState: row.lifecycle_state,
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
      }
    : null;
}
