import { describe, expect, it, vi } from "vitest";
import {
  EFFECTIVITY_SYSTEM_ACTOR,
  transitionDocumentVersionEffective,
  type AuditTransaction,
  type EffectivityTransitionOutcome,
} from "../packages/domain/src/index.js";

const TENANT = "91000000-0000-0000-0000-000000000001";
const VERSION = "91000000-0000-0000-0001-000000000001";
const DOCUMENT = "91000000-0000-0000-0002-000000000001";
const VARIANT = "91000000-0000-0000-0003-000000000001";
const CONFIGURATION = "91000000-0000-0000-0004-000000000001";
const REQUEST = "91000000-0000-0000-0005-000000000001";
const CORRELATION = "91000000-0000-0000-0006-000000000001";
const EFFECTIVE_FROM = new Date("2027-01-15T09:42:17.231Z");

function transitionRow(outcome: EffectivityTransitionOutcome, policyGap = false) {
  const states = {
    ALREADY_TRANSITIONED: ["EFFECTIVE", "EFFECTIVE"],
    CANCELLED: ["CANCELLED", "CANCELLED"],
    INELIGIBLE: ["APPROVED", "APPROVED"],
    NOT_DUE: ["PUBLISHED", "PUBLISHED"],
    TRANSITIONED: ["PUBLISHED", "EFFECTIVE"],
    WITHDRAWN: ["WITHDRAWN", "WITHDRAWN"],
  } as const;
  const [previous, current] = states[outcome];
  return {
    transition_outcome: outcome,
    version_id: VERSION,
    document_id: DOCUMENT,
    document_variant_id: VARIANT,
    configuration_version_id: CONFIGURATION,
    previous_lifecycle_state: previous,
    lifecycle_state: current,
    effective_from: EFFECTIVE_FROM,
    effective_until: null,
    row_version: 4,
    predecessor_version_id: null,
    predecessor_previous_state: null,
    predecessor_effective_until: null,
    predecessor_row_version: null,
    document_activated: false,
    policy_gap: policyGap,
    policy_gap_at: policyGap ? EFFECTIVE_FROM : null,
  };
}

function input() {
  return {
    tenantId: TENANT,
    versionId: VERSION,
    instant: EFFECTIVE_FROM,
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "JOB" as const,
  };
}

describe("effective-instant transition domain boundary", () => {
  it.each(["ALREADY_TRANSITIONED", "CANCELLED", "INELIGIBLE", "NOT_DUE", "WITHDRAWN"] as const)(
    "INV-EFF-007 / INV-EFF-008: %s is an audited no-op when no gap is detected",
    async (outcome) => {
      const query = vi.fn().mockResolvedValue({ rows: [transitionRow(outcome)] });
      const result = await transitionDocumentVersionEffective(
        { query } as unknown as AuditTransaction,
        input(),
      );

      expect(result).toMatchObject({ outcome, emittedEvents: [] });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it("INV-EFF-005: narrates a withdrawal gap as the system actor", async () => {
    const recordedAt = new Date("2027-01-15T09:42:18.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [transitionRow("WITHDRAWN", true)] })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: "91000000-0000-0000-0007-000000000001",
            sequence: "12",
            recorded_at: recordedAt,
          },
        ],
      });
    const result = await transitionDocumentVersionEffective(
      { query } as unknown as AuditTransaction,
      input(),
    );

    expect(EFFECTIVITY_SYSTEM_ACTOR).toEqual({ type: "SYSTEM", id: null });
    expect(result).toMatchObject({ outcome: "WITHDRAWN", policyGap: true });
    const auditPayload = JSON.parse(String(query.mock.calls[1]?.[1]?.[2])) as Array<{
      actor_type: string;
      actor_id: string | null;
      event_type: string;
      safe_after: Record<string, unknown>;
    }>;
    expect(auditPayload).toEqual([
      expect.objectContaining({
        actor_type: "SYSTEM",
        actor_id: null,
        event_type: "governance.policy_gap",
        safe_after: expect.objectContaining({ severity: "HIGH", triggeringVersionId: VERSION }),
      }),
    ]);
  });
});
