import {
  emitAuditEvents,
  type AuditEventInput,
  type AuditSourceChannel,
  type AuditTransaction,
  type EmittedAuditEvent,
} from "./audit.js";
import {
  DocumentVersionLifecycleError,
  DocumentVersionNotFoundError,
  type VersionLifecycle,
} from "./version.js";

/** System narration is never attributed to the user who originally published the version. */
export const EFFECTIVITY_SYSTEM_ACTOR = Object.freeze({ type: "SYSTEM", id: null } as const);

export const EFFECTIVITY_TRANSITION_OUTCOMES = [
  "TRANSITIONED",
  "ALREADY_TRANSITIONED",
  "WITHDRAWN",
  "CANCELLED",
  "NOT_DUE",
  "INELIGIBLE",
] as const;

export type EffectivityTransitionOutcome = (typeof EFFECTIVITY_TRANSITION_OUTCOMES)[number];

export interface TransitionDocumentVersionEffectiveInput {
  tenantId: string;
  versionId: string;
  instant: Date;
  requestId: string;
  correlationId: string;
  sourceChannel: AuditSourceChannel;
}

export interface EffectiveInstantTransition {
  outcome: EffectivityTransitionOutcome;
  versionId: string;
  documentId: string;
  documentVariantId: string;
  previousLifecycleState: VersionLifecycle;
  lifecycleState: VersionLifecycle;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  rowVersion: number;
  predecessorVersionId: string | null;
  documentActivated: boolean;
  policyGap: boolean;
  policyGapAt: Date | null;
  emittedEvents: readonly EmittedAuditEvent[];
}

interface EffectiveInstantRow extends Record<string, unknown> {
  transition_outcome: EffectivityTransitionOutcome;
  version_id: string;
  document_id: string;
  document_variant_id: string;
  configuration_version_id: string;
  previous_lifecycle_state: VersionLifecycle;
  lifecycle_state: VersionLifecycle;
  effective_from: Date | null;
  effective_until: Date | null;
  row_version: number;
  predecessor_version_id: string | null;
  predecessor_previous_state: VersionLifecycle | null;
  predecessor_effective_until: Date | null;
  predecessor_row_version: number | null;
  document_activated: boolean;
  policy_gap: boolean;
  policy_gap_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_CHANNELS = new Set<AuditSourceChannel>(["WEB", "API", "JOB", "IMPORT"]);

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

function validateInput(input: TransitionDocumentVersionEffectiveInput): void {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.versionId, "versionId");
  requireDate(input.instant, "instant");
  requireUuid(input.requestId, "requestId");
  requireUuid(input.correlationId, "correlationId");
  if (!SOURCE_CHANNELS.has(input.sourceChannel)) {
    throw new TypeError("sourceChannel is not supported");
  }
}

function instant(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function requiredEffectiveFrom(row: EffectiveInstantRow): Date {
  if (row.effective_from === null) {
    throw new Error("an effective-instant transition returned no effective_from");
  }
  return row.effective_from;
}

function transitionEvents(
  input: TransitionDocumentVersionEffectiveInput,
  row: EffectiveInstantRow,
): AuditEventInput[] {
  const base = {
    tenantId: input.tenantId,
    eventSchemaVersion: 1,
    actor: EFFECTIVITY_SYSTEM_ACTOR,
    requestId: input.requestId,
    correlationId: input.correlationId,
    sourceChannel: input.sourceChannel,
    configurationVersionId: row.configuration_version_id,
  } as const;
  const coordinates = {
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
  } as const;
  const events: AuditEventInput[] = [];

  if (
    row.transition_outcome === "TRANSITIONED" &&
    row.predecessor_version_id !== null &&
    row.predecessor_previous_state === "EFFECTIVE"
  ) {
    const effectiveFrom = requiredEffectiveFrom(row);
    events.push({
      ...base,
      ...coordinates,
      eventType: "version.superseded",
      occurredAt: effectiveFrom,
      subject: { type: "DOCUMENT_VERSION", id: row.predecessor_version_id },
      documentVersionId: row.predecessor_version_id,
      action: "SUPERSEDE_DOCUMENT_VERSION",
      outcome: "SUCCESS",
      safeBefore: {
        lifecycleState: "EFFECTIVE",
        effectiveUntil: instant(row.predecessor_effective_until),
      },
      safeAfter: {
        lifecycleState: "SUPERSEDED",
        effectiveUntil: effectiveFrom.toISOString(),
        supersededByVersionId: row.version_id,
      },
      dedupeKey: `version.superseded:${row.predecessor_version_id}`,
    });
  }

  if (row.transition_outcome === "TRANSITIONED") {
    const effectiveFrom = requiredEffectiveFrom(row);
    events.push({
      ...base,
      ...coordinates,
      eventType: "version.effective",
      occurredAt: effectiveFrom,
      subject: { type: "DOCUMENT_VERSION", id: row.version_id },
      documentVersionId: row.version_id,
      action: "MAKE_DOCUMENT_VERSION_EFFECTIVE",
      outcome: "SUCCESS",
      safeBefore: { lifecycleState: "PUBLISHED" },
      safeAfter: {
        lifecycleState: "EFFECTIVE",
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveUntil: instant(row.effective_until),
      },
      dedupeKey: `version.effective:${row.version_id}`,
    });
  }

  if (row.document_activated) {
    const effectiveFrom = requiredEffectiveFrom(row);
    events.push({
      ...base,
      eventType: "document.activated",
      occurredAt: effectiveFrom,
      subject: { type: "DOCUMENT", id: row.document_id },
      documentId: row.document_id,
      action: "ACTIVATE_DOCUMENT",
      outcome: "SUCCESS",
      safeBefore: { lifecycleStatus: "PLANNED" },
      safeAfter: { lifecycleStatus: "ACTIVE", effectiveVersionId: row.version_id },
      dedupeKey: `document.activated:${row.document_id}`,
    });
  }

  if (row.policy_gap && row.policy_gap_at !== null) {
    events.push({
      ...base,
      ...coordinates,
      eventType: "governance.policy_gap",
      occurredAt: row.policy_gap_at,
      subject: { type: "DOCUMENT_VARIANT", id: row.document_variant_id },
      documentVersionId: row.version_id,
      action: "DETECT_POLICY_GAP",
      outcome: "FAILURE",
      reasonCode: "WITHDRAWAL_LEFT_NO_EFFECTIVE_VERSION",
      safeAfter: {
        severity: "HIGH",
        gapAt: row.policy_gap_at.toISOString(),
        triggeringVersionId: row.version_id,
      },
      dedupeKey: `governance.policy_gap:${row.version_id}`,
    });
  }

  return events;
}

/**
 * Narrate the effective instant selected by publication. The SQL entry point serializes on
 * the variant and re-reads every authoritative fact; this wrapper only emits its canonical
 * events through the one ledger path, on the same caller transaction.
 */
export async function transitionDocumentVersionEffective(
  transaction: AuditTransaction,
  input: TransitionDocumentVersionEffectiveInput,
): Promise<EffectiveInstantTransition> {
  validateInput(input);

  let rows: EffectiveInstantRow[];
  try {
    ({ rows } = await transaction.query<EffectiveInstantRow>(
      `select *
         from transition_document_version_effective(
           $1::uuid, $2::uuid, $3::timestamptz
         )`,
      [input.tenantId, input.versionId, input.instant.toISOString()],
    ));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { constraint?: unknown }).constraint === "document_version_predecessor_lifecycle"
    ) {
      throw new DocumentVersionLifecycleError();
    }
    throw error;
  }

  const row = rows[0];
  if (!row) throw new DocumentVersionNotFoundError();
  const events = transitionEvents(input, row);
  const emittedEvents = events.length === 0 ? [] : await emitAuditEvents(transaction, events);

  return {
    outcome: row.transition_outcome,
    versionId: row.version_id,
    documentId: row.document_id,
    documentVariantId: row.document_variant_id,
    previousLifecycleState: row.previous_lifecycle_state,
    lifecycleState: row.lifecycle_state,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    rowVersion: row.row_version,
    predecessorVersionId: row.predecessor_version_id,
    documentActivated: row.document_activated,
    policyGap: row.policy_gap,
    policyGapAt: row.policy_gap_at,
    emittedEvents,
  };
}
