import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_EVENT_SCHEMAS,
  IMPLEMENTED_AUDIT_EVENT_TYPES,
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

  it("INV-CFG-004: defines the first published configuration snapshot contract as v1", () => {
    const configurationEvent = event({
      eventType: "configuration.changed",
      eventSchemaVersion: 1,
      safeBefore: null,
      safeAfter: {
        configurationVersionId: "10000000-0000-0000-0004-000000000001",
        sequence: 1,
        effectiveFrom: "2027-01-15T09:42:17.231Z",
        payloadDigest: "sha256:configuration",
        weakening: false,
      },
    });
    expect(() => validateAuditEvent(configurationEvent)).not.toThrow();
    expect(() => validateAuditEvent({ ...configurationEvent, eventSchemaVersion: 2 })).toThrow(
      /not registered/i,
    );
    expect(() => validateAuditEvent({ ...configurationEvent, safeAfter: null })).toThrow(
      /safeAfter is required/i,
    );
    expect(() =>
      validateAuditEvent({
        ...configurationEvent,
        safeAfter: { ...configurationEvent.safeAfter, sequence: 2 },
      }),
    ).toThrow(/safeBefore is required/i);
  });

  it("INV-AUD-008: document.created publishes its required version-1 after-state", () => {
    const created = event({
      eventType: "document.created",
      eventSchemaVersion: 1,
      safeBefore: null,
      safeAfter: {
        documentCode: "POL-001",
        documentTypeId: "10000000-0000-0000-0010-000000000001",
        owningOrgUnitId: "10000000-0000-0000-0011-000000000001",
        spaceId: null,
        ownerUserId: null,
        lifecycleStatus: "PLANNED",
        baselineVariantId: "10000000-0000-0000-0012-000000000001",
      },
    });
    expect(() => validateAuditEvent(created)).not.toThrow();
    const incomplete = { ...created.safeAfter };
    Reflect.deleteProperty(incomplete, "baselineVariantId");
    expect(() => validateAuditEvent({ ...created, safeAfter: incomplete })).toThrow(
      /baselineVariantId is required/i,
    );
  });

  it("INV-AUD-008: document.metadata_changed requires the same changed keys on both sides", () => {
    const changed = event({
      eventType: "document.metadata_changed",
      eventSchemaVersion: 1,
      safeBefore: { canonicalTitle: "Old title" },
      safeAfter: { canonicalTitle: "New title" },
    });
    expect(() => validateAuditEvent(changed)).not.toThrow();
    expect(() => validateAuditEvent({ ...changed, safeBefore: null })).toThrow(
      /safeBefore is required/i,
    );
  });

  it("INV-AUD-008: document.owner_changed requires ownerUserId even when the value is null", () => {
    const changed = event({
      eventType: "document.owner_changed",
      eventSchemaVersion: 1,
      safeBefore: { ownerUserId: "10000000-0000-0000-0013-000000000001" },
      safeAfter: { ownerUserId: null },
    });
    expect(() => validateAuditEvent(changed)).not.toThrow();
    expect(() => validateAuditEvent({ ...changed, safeAfter: {} })).toThrow(
      /ownerUserId is required/i,
    );
  });

  it("INV-AUD-008: document.type_changed requires the authoritative type on both sides", () => {
    const changed = event({
      eventType: "document.type_changed",
      eventSchemaVersion: 1,
      safeBefore: { documentTypeId: "10000000-0000-0000-0014-000000000001" },
      safeAfter: { documentTypeId: "10000000-0000-0000-0014-000000000002" },
    });
    expect(() => validateAuditEvent(changed)).not.toThrow();
    expect(() => validateAuditEvent({ ...changed, safeBefore: {} })).toThrow(
      /documentTypeId is required/i,
    );
  });

  it("INV-AUD-008: document.retired requires the transition, instant and reason", () => {
    const retired = event({
      eventType: "document.retired",
      eventSchemaVersion: 1,
      safeBefore: { lifecycleStatus: "PLANNED" },
      safeAfter: {
        lifecycleStatus: "RETIRED",
        retiredAt: "2027-01-15T09:42:17.231Z",
        retirementReason: "Initiative cancelled",
      },
    });
    expect(() => validateAuditEvent(retired)).not.toThrow();
    expect(() =>
      validateAuditEvent({
        ...retired,
        safeAfter: {
          lifecycleStatus: "RETIRED",
          retiredAt: "2027-01-15T09:42:17.231Z",
        },
      }),
    ).toThrow(/retirementReason is required/i);
  });

  it("INV-AUD-008 / INV-DOC-009 / INV-DOC-010: version.created publishes its governed v1 snapshot", () => {
    const created = event({
      eventType: "version.created",
      eventSchemaVersion: 1,
      safeBefore: null,
      safeAfter: {
        documentVariantId: "10000000-0000-0000-0015-000000000001",
        versionSequence: 3,
        lifecycleState: "DRAFT",
        documentTypeId: "10000000-0000-0000-0016-000000000001",
        title: "Information Security Policy",
        classificationId: "10000000-0000-0000-0017-000000000001",
        materiality: "MATERIAL",
        configurationVersionId: "10000000-0000-0000-0004-000000000001",
      },
    });
    expect(() => validateAuditEvent(created)).not.toThrow();
    const incomplete = { ...created.safeAfter };
    Reflect.deleteProperty(incomplete, "documentTypeId");
    expect(() => validateAuditEvent({ ...created, safeAfter: incomplete })).toThrow(
      /documentTypeId is required/i,
    );
  });

  it("INV-AUD-008: version.materiality_changed requires both materiality values", () => {
    const changed = event({
      eventType: "version.materiality_changed",
      eventSchemaVersion: 1,
      safeBefore: { materiality: "NON_MATERIAL" },
      safeAfter: { materiality: "MATERIAL" },
    });
    expect(() => validateAuditEvent(changed)).not.toThrow();
    expect(() => validateAuditEvent({ ...changed, safeBefore: {} })).toThrow(
      /materiality is required/i,
    );
  });

  it("INV-AUD-008 / INV-VER-008: version.metadata_changed requires identical changed keys", () => {
    const changed = event({
      eventType: "version.metadata_changed",
      eventSchemaVersion: 1,
      safeBefore: { displayLabel: "2.0" },
      safeAfter: { displayLabel: "2027.02" },
    });
    expect(() => validateAuditEvent(changed)).not.toThrow();
    expect(() => validateAuditEvent({ ...changed, safeAfter: {} })).toThrow(
      /same keys before and after/i,
    );
  });

  it("INV-AUD-008: all implemented version events replace their placeholder v1 schema", () => {
    for (const eventType of [
      "version.created",
      "version.materiality_changed",
      "version.metadata_changed",
    ] as const) {
      expect(IMPLEMENTED_AUDIT_EVENT_TYPES).toContain(eventType);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]?.safeAfterRequired).toBe(true);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]?.safeAfterKeys.length).toBeGreaterThan(0);
    }
    for (const eventType of [
      "version.approved",
      "version.published",
      "version.withdrawn",
    ] as const) {
      expect(IMPLEMENTED_AUDIT_EVENT_TYPES).not.toContain(eventType);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]).toMatchObject({
        safeBeforeKeys: [],
        safeAfterKeys: [],
        safeAfterRequired: false,
      });
    }
  });

  it("INV-AUD-008: only emitted document events replace their placeholder schema", () => {
    const implemented = [
      "document.created",
      "document.metadata_changed",
      "document.owner_changed",
      "document.retired",
      "document.type_changed",
    ] as const;
    for (const eventType of implemented) {
      expect(IMPLEMENTED_AUDIT_EVENT_TYPES).toContain(eventType);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]?.safeAfterRequired).toBe(true);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]?.safeAfterKeys.length).toBeGreaterThan(0);
    }
    for (const eventType of [
      "document.activated",
      "document.restored",
      "document.sensitive_viewed",
    ] as const) {
      expect(IMPLEMENTED_AUDIT_EVENT_TYPES).not.toContain(eventType);
      expect(AUDIT_EVENT_SCHEMAS[eventType][1]).toMatchObject({
        safeBeforeKeys: [],
        safeAfterKeys: [],
        safeAfterRequired: false,
      });
    }
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
