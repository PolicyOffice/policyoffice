import { describe, expect, it, vi } from "vitest";
import {
  InvalidAuditEventError,
  emitAuditEvent,
  emitAuditEvents,
  validateAuditEvent,
  type AuditEventInput,
  type AuditTransaction,
} from "../packages/domain/src/audit.js";

const TENANT = "10000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "20000000-0000-0000-0000-000000000002";

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    tenantId: TENANT,
    eventType: "version.effective",
    eventSchemaVersion: 1,
    occurredAt: new Date("2027-01-15T09:42:17.231Z"),
    actor: { type: "SYSTEM", id: null },
    subject: { type: "DOCUMENT_VERSION", id: "10000000-0000-0000-0001-000000000001" },
    action: "MAKE_EFFECTIVE",
    outcome: "SUCCESS",
    requestId: "10000000-0000-0000-0002-000000000001",
    correlationId: "10000000-0000-0000-0003-000000000001",
    sourceChannel: "JOB",
    configurationVersionId: "10000000-0000-0000-0004-000000000001",
    dedupeKey: "version.effective:10000000-0000-0000-0001-000000000001",
    ...overrides,
  };
}

describe("the audit event envelope", () => {
  it.each([
    "tenantId",
    "eventType",
    "eventSchemaVersion",
    "occurredAt",
    "actor",
    "subject",
    "action",
    "outcome",
    "requestId",
    "correlationId",
    "sourceChannel",
    "configurationVersionId",
  ] as const)("INV-AUD-005: rejects a missing %s before reaching PostgreSQL", (field) => {
    const candidate = { ...event() } as Record<string, unknown>;
    delete candidate[field];
    expect(() => validateAuditEvent(candidate)).toThrow(InvalidAuditEventError);
  });

  it("INV-AUD-008: rejects an unregistered type or schema version", () => {
    expect(() => validateAuditEvent({ ...event(), eventType: "version.renamed" })).toThrow(
      /catalogue/i,
    );
    expect(() => validateAuditEvent({ ...event(), eventSchemaVersion: 2 })).toThrow(
      /not registered/i,
    );
  });

  it("INV-AUD-003: refuses arbitrary snapshot fields until that event schema declares them", () => {
    expect(() => validateAuditEvent({ ...event(), safeAfter: { document_body: "text" } })).toThrow(
      /not declared/i,
    );
  });
});

describe("the typed audit emitter", () => {
  it("INV-AUD-005: validates before issuing SQL", async () => {
    const query = vi.fn();
    await expect(
      emitAuditEvent({ query } as unknown as AuditTransaction, {
        ...event(),
        correlationId: "",
      }),
    ).rejects.toThrow(InvalidAuditEventError);
    expect(query).not.toHaveBeenCalled();
  });

  it("INV-AUD-009: returns the database-assigned sequence and identity", async () => {
    const recordedAt = new Date("2027-01-15T09:42:17.245Z");
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          event_id: "10000000-0000-0000-0005-000000000001",
          sequence: "7",
          recorded_at: recordedAt,
        },
      ],
    });
    const emitted = await emitAuditEvent({ query } as unknown as AuditTransaction, event());
    expect(emitted).toEqual({
      eventId: "10000000-0000-0000-0005-000000000001",
      sequence: 7n,
      recordedAt,
    });
    expect(String(query.mock.calls[0]?.[0])).toMatch(/insert into audit_event/);
  });

  it("INV-TEN-001: refuses a batch spanning tenants before issuing SQL", async () => {
    const query = vi.fn();
    await expect(
      emitAuditEvents({ query } as unknown as AuditTransaction, [
        event(),
        event({ tenantId: OTHER_TENANT }),
      ]),
    ).rejects.toThrow(/cannot cross tenants/i);
    expect(query).not.toHaveBeenCalled();
  });
});
