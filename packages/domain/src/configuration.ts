import {
  emitAuditEvent,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
  type SafeAuditSnapshot,
} from "./audit.js";

/**
 * Authorization contract for every caller of recordConfigurationChange. ADR-0003's
 * evaluator has not landed yet, so the caller must establish this capability before it
 * enters the domain command; this command never invents authority.
 */
export const CONFIGURATION_MANAGEMENT_CAPABILITY = "tenant.manage_configuration" as const;

export interface ConfigurationChangeInput {
  tenantId: string;
  configurationVersionId: string;
  effectiveFrom: Date;
  changedBy: string;
  changeReason: string;
  weakening: boolean;
  payloadDigest: string;
  occurredAt: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface RecordedConfigurationVersion {
  id: string;
  sequence: number;
  effectiveFrom: Date;
  changedBy: string;
  changeReason: string;
  weakening: boolean;
  payloadDigest: string;
  emittedEvent: EmittedAuditEvent;
}

interface ConfigurationChangeRow extends Record<string, unknown> {
  id: string;
  sequence: number;
  effective_from: Date;
  changed_by: string;
  change_reason: string;
  weakening: boolean;
  payload_digest: string;
  previous_id: string | null;
  previous_sequence: number | null;
  previous_effective_from: Date | null;
  previous_weakening: boolean | null;
  previous_payload_digest: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function requireInstant(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function snapshot(
  id: string | null,
  sequence: number | null,
  effectiveFrom: Date | null,
  payloadDigest: string | null,
  weakening: boolean | null,
): SafeAuditSnapshot | null {
  if (id === null) return null;
  if (sequence === null || effectiveFrom === null || payloadDigest === null || weakening === null) {
    throw new Error("configuration history returned an incomplete prior version");
  }
  return {
    configurationVersionId: id,
    sequence,
    effectiveFrom: effectiveFrom.toISOString(),
    payloadDigest,
    weakening,
  };
}

function validateInput(input: ConfigurationChangeInput): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.configurationVersionId, "configurationVersionId");
  requireUuid(input.changedBy, "changedBy");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  requireInstant(input.effectiveFrom, "effectiveFrom");
  requireInstant(input.occurredAt, "occurredAt");
  requireText(input.changeReason, "changeReason");
  requireText(input.payloadDigest, "payloadDigest");
  if (typeof input.weakening !== "boolean") throw new TypeError("weakening must be a boolean");
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
}

/**
 * Append one immutable configuration version and its audit event in the caller's
 * transaction. The tenant advisory lock makes sequence allocation deterministic even
 * when the tenant has no prior row; a rollback removes both the row and the event.
 */
export async function recordConfigurationChange(
  transaction: AuditTransaction,
  input: ConfigurationChangeInput,
): Promise<RecordedConfigurationVersion> {
  validateInput(input);

  // The lock must be acquired in its own statement. PostgreSQL takes a READ COMMITTED
  // snapshot before a statement begins, so waiting for the lock inside the INSERT would
  // still read the pre-wait history and two writers could both choose the same sequence.
  await transaction.query(
    `select pg_advisory_xact_lock(
       hashtextextended($1::uuid::text || ':configuration_version', 0)
     )`,
    [input.tenantId],
  );

  const { rows } = await transaction.query<ConfigurationChangeRow>(
    `with previous as materialized (
       select prior.id,
              prior.sequence,
              prior.effective_from,
              prior.weakening,
              prior.payload_digest
         from (select true) as one
         left join lateral (
           select id, sequence, effective_from, weakening, payload_digest
             from configuration_version
            where tenant_id = $1::uuid
            order by sequence desc
            limit 1
         ) prior on true
     ), inserted as (
       insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       )
       select $1::uuid, $2::uuid, coalesce(previous.sequence, 0) + 1,
              $3::timestamptz, $4::uuid, $5::text, $6::boolean, $7::text
         from previous
       returning id, sequence, effective_from, changed_by, change_reason,
                 weakening, payload_digest
     )
     select inserted.*,
            previous.id as previous_id,
            previous.sequence as previous_sequence,
            previous.effective_from as previous_effective_from,
            previous.weakening as previous_weakening,
            previous.payload_digest as previous_payload_digest
       from inserted cross join previous`,
    [
      input.tenantId,
      input.configurationVersionId,
      input.effectiveFrom.toISOString(),
      input.changedBy,
      input.changeReason,
      input.weakening,
      input.payloadDigest,
    ],
  );
  const row = rows[0];
  if (!row || rows.length !== 1) {
    throw new Error(`configuration insert returned ${rows.length} rows`);
  }

  const before = snapshot(
    row.previous_id,
    row.previous_sequence,
    row.previous_effective_from,
    row.previous_payload_digest,
    row.previous_weakening,
  );
  const after = snapshot(
    row.id,
    row.sequence,
    row.effective_from,
    row.payload_digest,
    row.weakening,
  );
  if (after === null) throw new Error("configuration insert returned no version");

  const emittedEvent = await emitAuditEvent(transaction, {
    tenantId: input.tenantId,
    eventType: "configuration.changed",
    eventSchemaVersion: 2,
    occurredAt: input.occurredAt,
    actor: { type: "USER", id: input.changedBy },
    subject: { type: "CONFIGURATION_VERSION", id: row.id },
    action: "CREATE_CONFIGURATION_VERSION",
    outcome: "SUCCESS",
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    safeBefore: before,
    safeAfter: after,
    configurationVersionId: row.id,
    dedupeKey: `configuration.changed:${row.id}`,
  });

  return {
    id: row.id,
    sequence: row.sequence,
    effectiveFrom: row.effective_from,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    weakening: row.weakening,
    payloadDigest: row.payload_digest,
    emittedEvent,
  };
}
