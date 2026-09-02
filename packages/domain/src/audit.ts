/**
 * The permanent event names in docs/domain/audit-event-catalogue.md.
 *
 * They are contracts, not proof that the corresponding transition is implemented. The
 * separate IMPLEMENTED_AUDIT_EVENT_TYPES list records that distinction so later work
 * cannot mistake a catalogued event for an emission that already exists.
 */
export const AUDIT_EVENT_TYPES = [
  "access.denied",
  "access.expired",
  "access.granted",
  "access.revoked",
  "access_request.approved",
  "access_request.rejected",
  "access_request.submitted",
  "alignment.raised",
  "alignment.resolved",
  "approval.approved",
  "approval.changes_requested",
  "approval.corrected",
  "approval.escalated",
  "approval.rejected",
  "approval.reminded",
  "approval_run.blocked",
  "approval_run.cancelled",
  "approval_run.completed",
  "approval_run.started",
  "approval_stage.completed",
  "approval_stage.started",
  "approval_task.assigned",
  "approval_task.delegated",
  "approval_task.reassigned",
  "approval_task.unresolvable",
  "assignment.cancelled",
  "assignment.created",
  "assignment.exempted",
  "assignment.overdue",
  "attestation.acknowledged",
  "attestation.declined",
  "attestation.reminded",
  "attestation_statement.created",
  "audit.exported",
  "body_membership.changed",
  "breakglass.ended",
  "breakglass.started",
  "campaign.cancelled",
  "campaign.closed",
  "campaign.created",
  "campaign.launched",
  "campaign.preflight_failed",
  "configuration.changed",
  "configuration.weakened",
  "content_revision.created",
  "document.activated",
  "document.created",
  "document.metadata_changed",
  "document.owner_changed",
  "document.restored",
  "document.retired",
  "document.sensitive_viewed",
  "document.type_changed",
  "document_type.changed",
  "evidence.accessed",
  "evidence_pack.downloaded",
  "evidence_pack.expired",
  "evidence_pack.failed",
  "evidence_pack.generated",
  "evidence_pack.requested",
  "export.generated",
  "governance.conflict_detected",
  "governance.digest_mismatch",
  "governance.policy_gap",
  "governance_body.created",
  "governance_body.dissolved",
  "group.created",
  "group.membership_changed",
  "integration.changed",
  "legal_entity.closed",
  "legal_entity.created",
  "legal_hold.applied",
  "legal_hold.released",
  "org_membership.changed",
  "org_unit.changed",
  "org_unit.created",
  "org_unit.deactivated",
  "profile.applied",
  "retention.blocked_by_hold",
  "retention.changed",
  "retention.disposed",
  "review.cancelled",
  "review.completed",
  "review.due",
  "review.escalated",
  "review.overdue",
  "review.scheduled",
  "review.started",
  "security_setting.changed",
  "session.revoked",
  "user.deactivated",
  "user.provisioned",
  "user.reactivated",
  "user.updated",
  "variant.created",
  "variant.retired",
  "version.approved",
  "version.cancelled",
  "version.created",
  "version.effective",
  "version.materiality_changed",
  "version.published",
  "version.rejected",
  "version.submitted",
  "version.superseded",
  "version.withdrawn",
  "waiver.approved",
  "waiver.expired",
  "waiver.rejected",
  "waiver.revoked",
  "waiver.submitted",
  "workflow_template.published",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Production transitions that currently emit through the sole write path. */
export const IMPLEMENTED_AUDIT_EVENT_TYPES: readonly AuditEventType[] = ["configuration.changed"];

export interface AuditEventSchema {
  readonly safeBeforeKeys: readonly string[];
  readonly safeAfterKeys: readonly string[];
  readonly requiredSafeBeforeKeys: readonly string[];
  readonly requiredSafeAfterKeys: readonly string[];
  readonly safeAfterRequired: boolean;
}

const ENVELOPE_ONLY_SCHEMA: AuditEventSchema = Object.freeze({
  safeBeforeKeys: Object.freeze([]),
  safeAfterKeys: Object.freeze([]),
  requiredSafeBeforeKeys: Object.freeze([]),
  requiredSafeAfterKeys: Object.freeze([]),
  safeAfterRequired: false,
});

const CONFIGURATION_SNAPSHOT_KEYS = Object.freeze([
  "configurationVersionId",
  "effectiveFrom",
  "payloadDigest",
  "sequence",
  "weakening",
]);

const CONFIGURATION_CHANGED_SCHEMA_V1: AuditEventSchema = Object.freeze({
  safeBeforeKeys: CONFIGURATION_SNAPSHOT_KEYS,
  safeAfterKeys: CONFIGURATION_SNAPSHOT_KEYS,
  requiredSafeBeforeKeys: CONFIGURATION_SNAPSHOT_KEYS,
  requiredSafeAfterKeys: CONFIGURATION_SNAPSHOT_KEYS,
  safeAfterRequired: true,
});

/**
 * INV-AUD-008: placeholder schemas are finalized when an event type first becomes
 * implemented. From that point onward its shape is published and any change adds a new
 * version, leaving every emitted version interpretable forever.
 */
const auditEventSchemas = Object.fromEntries(
  AUDIT_EVENT_TYPES.map((eventType) => [eventType, Object.freeze({ 1: ENVELOPE_ONLY_SCHEMA })]),
) as unknown as Record<AuditEventType, Readonly<Record<number, AuditEventSchema>>>;
auditEventSchemas["configuration.changed"] = Object.freeze({
  1: CONFIGURATION_CHANGED_SCHEMA_V1,
});

export const AUDIT_EVENT_SCHEMAS = Object.freeze(auditEventSchemas);

export const AUDIT_ACTOR_TYPES = ["USER", "BODY", "API_CLIENT", "SYSTEM"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ["SUCCESS", "FAILURE"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_SOURCE_CHANNELS = ["WEB", "API", "JOB", "IMPORT"] as const;
export type AuditSourceChannel = (typeof AUDIT_SOURCE_CHANNELS)[number];

export type SafeAuditValue = string | number | boolean | null;
export type SafeAuditSnapshot = Readonly<Record<string, SafeAuditValue>>;

export interface AuditEventInput {
  tenantId: string;
  eventType: AuditEventType;
  eventSchemaVersion: number;
  occurredAt: Date;
  actor: Readonly<{ type: AuditActorType; id: string | null }>;
  originatingActorId?: string | null;
  elevationSessionId?: string | null;
  subject: Readonly<{ type: string; id: string }>;
  documentId?: string | null;
  documentVariantId?: string | null;
  documentVersionId?: string | null;
  action: string;
  outcome: AuditOutcome;
  reasonCode?: string | null;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
  safeBefore?: SafeAuditSnapshot | null;
  safeAfter?: SafeAuditSnapshot | null;
  configurationVersionId: string;
  correctsEventId?: string | null;
  dedupeKey?: string | null;
}

export interface EmittedAuditEvent {
  eventId: string;
  sequence: bigint;
  recordedAt: Date;
}

/** The narrow transaction seam keeps the domain package independent of pg and Drizzle. */
export interface AuditTransaction {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export class InvalidAuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuditEventError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const eventTypes = new Set<string>(AUDIT_EVENT_TYPES);
const actorTypes = new Set<string>(AUDIT_ACTOR_TYPES);
const outcomes = new Set<string>(AUDIT_OUTCOMES);
const sourceChannels = new Set<string>(AUDIT_SOURCE_CHANNELS);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidAuditEventError(`${field} is required`);
  }
}

function requiredUuid(value: unknown, field: string): asserts value is string {
  requiredString(value, field);
  if (!UUID.test(value)) throw new InvalidAuditEventError(`${field} must be a UUID`);
}

function optionalUuid(value: unknown, field: string): void {
  if (value !== undefined && value !== null) requiredUuid(value, field);
}

function snapshot(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  required: boolean,
): asserts value is SafeAuditSnapshot | null | undefined {
  if (value === undefined || value === null) {
    if (required) throw new InvalidAuditEventError(`${field} is required`);
    return;
  }
  if (!record(value)) throw new InvalidAuditEventError(`${field} must be an object`);

  const allowed = new Set(allowedKeys);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new InvalidAuditEventError(`${field}.${key} is not declared by this event schema`);
    }
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new InvalidAuditEventError(`${field}.${key} must be a scalar`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new InvalidAuditEventError(`${field}.${key} is required by this event schema`);
    }
  }
}

function validateConfigurationChangedSnapshots(input: Record<string, unknown>): void {
  if (input.eventType !== "configuration.changed" || !record(input.safeAfter)) return;

  requiredUuid(input.safeAfter.configurationVersionId, "safeAfter.configurationVersionId");
  requiredString(input.safeAfter.effectiveFrom, "safeAfter.effectiveFrom");
  if (Number.isNaN(Date.parse(input.safeAfter.effectiveFrom))) {
    throw new InvalidAuditEventError("safeAfter.effectiveFrom must be an instant");
  }
  requiredString(input.safeAfter.payloadDigest, "safeAfter.payloadDigest");
  if (typeof input.safeAfter.weakening !== "boolean") {
    throw new InvalidAuditEventError("safeAfter.weakening must be a boolean");
  }
  const afterSequence = input.safeAfter.sequence;
  if (!Number.isInteger(afterSequence) || Number(afterSequence) < 1) {
    throw new InvalidAuditEventError("safeAfter.sequence must be a positive integer");
  }
  if (afterSequence === 1 && input.safeBefore !== undefined && input.safeBefore !== null) {
    throw new InvalidAuditEventError("safeBefore must be null for the first configuration version");
  }
  if (Number(afterSequence) > 1) {
    if (!record(input.safeBefore)) {
      throw new InvalidAuditEventError(
        "safeBefore is required after the first configuration version",
      );
    }
    requiredUuid(input.safeBefore.configurationVersionId, "safeBefore.configurationVersionId");
    requiredString(input.safeBefore.effectiveFrom, "safeBefore.effectiveFrom");
    if (Number.isNaN(Date.parse(input.safeBefore.effectiveFrom))) {
      throw new InvalidAuditEventError("safeBefore.effectiveFrom must be an instant");
    }
    requiredString(input.safeBefore.payloadDigest, "safeBefore.payloadDigest");
    if (typeof input.safeBefore.weakening !== "boolean") {
      throw new InvalidAuditEventError("safeBefore.weakening must be a boolean");
    }
    if (input.safeBefore.sequence !== Number(afterSequence) - 1) {
      throw new InvalidAuditEventError(
        "safeBefore.sequence must immediately precede safeAfter.sequence",
      );
    }
  }
}

/** Validate at the domain boundary, before PostgreSQL repeats the level-1 checks. */
export function validateAuditEvent(input: unknown): asserts input is AuditEventInput {
  if (!record(input)) throw new InvalidAuditEventError("audit event must be an object");

  requiredUuid(input.tenantId, "tenantId");
  requiredString(input.eventType, "eventType");
  if (!EVENT_NAME.test(input.eventType) || !eventTypes.has(input.eventType)) {
    throw new InvalidAuditEventError("eventType is not in the audit event catalogue");
  }
  if (!Number.isInteger(input.eventSchemaVersion) || Number(input.eventSchemaVersion) < 1) {
    throw new InvalidAuditEventError("eventSchemaVersion must be a positive integer");
  }
  const schemas = AUDIT_EVENT_SCHEMAS[input.eventType as AuditEventType];
  const schema = schemas[Number(input.eventSchemaVersion)];
  if (!schema) {
    throw new InvalidAuditEventError(
      `${input.eventType} schema version ${String(input.eventSchemaVersion)} is not registered`,
    );
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.valueOf())) {
    throw new InvalidAuditEventError("occurredAt must be a valid Date");
  }

  if (!record(input.actor)) throw new InvalidAuditEventError("actor is required");
  requiredString(input.actor.type, "actor.type");
  if (!actorTypes.has(input.actor.type)) {
    throw new InvalidAuditEventError("actor.type is not supported");
  }
  optionalUuid(input.actor.id, "actor.id");
  optionalUuid(input.originatingActorId, "originatingActorId");
  optionalUuid(input.elevationSessionId, "elevationSessionId");

  if (!record(input.subject)) throw new InvalidAuditEventError("subject is required");
  requiredString(input.subject.type, "subject.type");
  requiredUuid(input.subject.id, "subject.id");
  optionalUuid(input.documentId, "documentId");
  optionalUuid(input.documentVariantId, "documentVariantId");
  optionalUuid(input.documentVersionId, "documentVersionId");

  requiredString(input.action, "action");
  requiredString(input.outcome, "outcome");
  if (!outcomes.has(input.outcome)) throw new InvalidAuditEventError("outcome is not supported");
  if (input.reasonCode !== undefined && input.reasonCode !== null) {
    requiredString(input.reasonCode, "reasonCode");
  }
  requiredUuid(input.requestId, "requestId");
  requiredUuid(input.correlationId, "correlationId");
  requiredString(input.sourceChannel, "sourceChannel");
  if (!sourceChannels.has(input.sourceChannel)) {
    throw new InvalidAuditEventError("sourceChannel is not supported");
  }
  requiredUuid(input.configurationVersionId, "configurationVersionId");
  optionalUuid(input.correctsEventId, "correctsEventId");
  if (input.dedupeKey !== undefined && input.dedupeKey !== null) {
    requiredString(input.dedupeKey, "dedupeKey");
  }
  snapshot(
    input.safeBefore,
    "safeBefore",
    schema.safeBeforeKeys,
    schema.requiredSafeBeforeKeys,
    false,
  );
  snapshot(
    input.safeAfter,
    "safeAfter",
    schema.safeAfterKeys,
    schema.requiredSafeAfterKeys,
    schema.safeAfterRequired,
  );
  validateConfigurationChangedSnapshots(input);
}

interface StoredAuditEventRow extends Record<string, unknown> {
  event_id: string;
  sequence: string;
  recorded_at: Date;
}

function databaseInput(event: AuditEventInput): Record<string, unknown> {
  return {
    event_type: event.eventType,
    event_schema_version: event.eventSchemaVersion,
    occurred_at: event.occurredAt.toISOString(),
    actor_type: event.actor.type,
    actor_id: event.actor.id,
    originating_actor_id: event.originatingActorId ?? null,
    elevation_session_id: event.elevationSessionId ?? null,
    subject_type: event.subject.type,
    subject_id: event.subject.id,
    document_id: event.documentId ?? null,
    document_variant_id: event.documentVariantId ?? null,
    document_version_id: event.documentVersionId ?? null,
    action: event.action,
    outcome: event.outcome,
    reason_code: event.reasonCode ?? null,
    request_id: event.requestId,
    correlation_id: event.correlationId,
    source_channel: event.sourceChannel,
    safe_before: event.safeBefore ?? null,
    safe_after: event.safeAfter ?? null,
    configuration_version_id: event.configurationVersionId,
    corrects_event_id: event.correctsEventId ?? null,
    dedupe_key: event.dedupeKey ?? null,
  };
}

/**
 * The sole INSERT path. Allocation and insertion are one statement, and the caller's
 * transaction makes the event atomic with the governed state change (INV-AUD-004).
 * A batch increments the tenant cursor once, so bulk imports take one row lock.
 */
export async function emitAuditEvents(
  transaction: AuditTransaction,
  events: readonly AuditEventInput[],
): Promise<EmittedAuditEvent[]> {
  const firstEvent = events[0];
  if (!firstEvent) throw new InvalidAuditEventError("at least one event is required");
  for (const event of events) validateAuditEvent(event);

  const tenantId = firstEvent.tenantId;
  if (events.some((event) => event.tenantId !== tenantId)) {
    throw new InvalidAuditEventError("one audit batch cannot cross tenants");
  }

  const { rows } = await transaction.query<StoredAuditEventRow>(
    `with input as (
       select raw.ordinality,
              item.*
         from jsonb_array_elements($3::jsonb) with ordinality as raw(value, ordinality)
         cross join lateral jsonb_to_record(raw.value) as item(
           event_type text,
           event_schema_version integer,
           occurred_at timestamptz,
           actor_type text,
           actor_id uuid,
           originating_actor_id uuid,
           elevation_session_id uuid,
           subject_type text,
           subject_id uuid,
           document_id uuid,
           document_variant_id uuid,
           document_version_id uuid,
           action text,
           outcome text,
           reason_code text,
           request_id uuid,
           correlation_id uuid,
           source_channel text,
           safe_before jsonb,
           safe_after jsonb,
           configuration_version_id uuid,
           corrects_event_id uuid,
           dedupe_key text
         )
     ), allocated as (
       insert into tenant_event_sequence (tenant_id, next_sequence)
       values ($1, 1 + $2::bigint)
       on conflict (tenant_id) do update
         set next_sequence = tenant_event_sequence.next_sequence + $2::bigint
       returning next_sequence - $2::bigint as base
     ), inserted as (
       insert into audit_event (
         tenant_id, sequence, event_type, event_schema_version, occurred_at,
         actor_type, actor_id, originating_actor_id, elevation_session_id,
         subject_type, subject_id, document_id, document_variant_id, document_version_id,
         action, outcome, reason_code, request_id, correlation_id, source_channel,
         safe_before, safe_after, configuration_version_id, corrects_event_id, dedupe_key
       )
       select $1,
              allocated.base + input.ordinality - 1,
              input.event_type, input.event_schema_version, input.occurred_at,
              input.actor_type, input.actor_id, input.originating_actor_id,
              input.elevation_session_id, input.subject_type, input.subject_id,
              input.document_id, input.document_variant_id, input.document_version_id,
              input.action, input.outcome, input.reason_code, input.request_id,
              input.correlation_id, input.source_channel, input.safe_before,
              input.safe_after, input.configuration_version_id, input.corrects_event_id,
              input.dedupe_key
         from input cross join allocated
        order by input.ordinality
       returning event_id, sequence, recorded_at
     )
     select event_id, sequence, recorded_at from inserted order by sequence`,
    [tenantId, events.length, JSON.stringify(events.map(databaseInput))],
  );

  if (rows.length !== events.length) {
    throw new Error(`audit insert returned ${rows.length} rows for ${events.length} events`);
  }
  return rows.map((row) => ({
    eventId: row.event_id,
    sequence: BigInt(row.sequence),
    recordedAt: row.recorded_at,
  }));
}

export async function emitAuditEvent(
  transaction: AuditTransaction,
  event: AuditEventInput,
): Promise<EmittedAuditEvent> {
  const emitted = await emitAuditEvents(transaction, [event]);
  const first = emitted[0];
  if (!first) throw new Error("audit insert returned no event");
  return first;
}
