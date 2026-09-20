import { describe, expect, it } from "vitest";
import {
  BODY_RESOLUTION_REQUIRED_CAPABILITIES,
  ApprovalBodyResolutionEvidenceError,
  ApprovalBodyResolutionRequiredError,
  ApprovalBodyResolutionUnauthorizedError,
  UnsupportedApprovalCompletionRuleError,
  assertAttendingMembersHeldSeats,
  isApprovalParticipantEligible,
  isApprovalStageSatisfied,
  recordBodyResolution,
} from "../packages/domain/src/approval-decision.js";
import { AuthzContext } from "../packages/domain/src/authorization.js";

const TENANT = "10000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "20000000-0000-0000-0000-000000000001";
const USER = "10000000-0000-0000-0001-000000000001";
const OTHER_USER = "10000000-0000-0000-0001-000000000002";

function context(tenantId = TENANT, userId = USER): AuthzContext {
  return new AuthzContext({
    tenantId,
    principal: { type: "USER", id: userId },
    instant: new Date("2026-09-19T10:00:00.000Z"),
    load: async () => {
      throw new Error("authorization facts must not load for an invalid command boundary");
    },
  });
}

function bodyResolutionInput() {
  return {
    tenantId: TENANT,
    approvalTaskId: "10000000-0000-0000-0002-000000000001",
    recordedByUserId: USER,
    decision: "APPROVE" as const,
    configurationVersionId: "10000000-0000-0000-0003-000000000001",
    occurredAt: new Date("2026-09-19T10:00:00.000Z"),
    requestId: "10000000-0000-0000-0004-000000000001",
    correlationId: "10000000-0000-0000-0005-000000000001",
    sourceChannel: "API" as const,
  };
}

describe("approval stage completion", () => {
  it("INV-APR-005 / POL-042: only active frozen participants remain eligible", () => {
    expect(isApprovalParticipantEligible({ participantType: "USER", status: "ACTIVE" })).toBe(true);
    expect(isApprovalParticipantEligible({ participantType: "USER", status: "DEACTIVATED" })).toBe(
      false,
    );
    expect(
      isApprovalParticipantEligible({ participantType: "GOVERNANCE_BODY", status: "ACTIVE" }),
    ).toBe(true);
    expect(
      isApprovalParticipantEligible({
        participantType: "GOVERNANCE_BODY",
        status: "DISSOLVED",
      }),
    ).toBe(false);
  });

  it("INV-APR-008: ALL completes only after every task has approved", () => {
    expect(
      isApprovalStageSatisfied({ completionRule: "ALL", taskCount: 2, approvalCount: 1 }),
    ).toBe(false);
    expect(
      isApprovalStageSatisfied({ completionRule: "ALL", taskCount: 2, approvalCount: 2 }),
    ).toBe(true);
  });

  it("POL-041: BODY_RESOLUTION refuses the direct user-decision command", () => {
    expect(() =>
      isApprovalStageSatisfied({
        completionRule: "BODY_RESOLUTION",
        taskCount: 1,
        approvalCount: 1,
      }),
    ).toThrow(ApprovalBodyResolutionRequiredError);
  });

  it.each(["ANY_ONE", "AT_LEAST_N"] as const)(
    "Pilot scope: %s remains unavailable rather than acquiring implied arithmetic",
    (completionRule) => {
      expect(() =>
        isApprovalStageSatisfied({ completionRule, taskCount: 2, approvalCount: 1 }),
      ).toThrow(UnsupportedApprovalCompletionRuleError);
    },
  );

  it("INV-APR-009: invalid completion counts fail closed", () => {
    expect(() =>
      isApprovalStageSatisfied({ completionRule: "ALL", taskCount: 1, approvalCount: 2 }),
    ).toThrow(TypeError);
    expect(() =>
      isApprovalStageSatisfied({ completionRule: "ALL", taskCount: 0, approvalCount: 0 }),
    ).toThrow(TypeError);
  });
});

describe("body resolution evidence", () => {
  it("INV-APR-023: exposes only body.act_for as the command capability", () => {
    expect(BODY_RESOLUTION_REQUIRED_CAPABILITIES).toEqual({ record: "body.act_for" });
  });

  it("INV-APR-023: rejects a recorder that differs from the authorization principal before querying", async () => {
    const transaction = { query: async () => Promise.reject(new Error("unexpected query")) };
    await expect(
      recordBodyResolution(transaction, context(TENANT, OTHER_USER), bodyResolutionInput()),
    ).rejects.toBeInstanceOf(ApprovalBodyResolutionUnauthorizedError);
  });

  it("INV-TEN-001: rejects a cross-tenant authorization context before querying", async () => {
    const transaction = { query: async () => Promise.reject(new Error("unexpected query")) };
    await expect(
      recordBodyResolution(transaction, context(OTHER_TENANT), bodyResolutionInput()),
    ).rejects.toMatchObject({
      name: "ApprovalBodyResolutionUnauthorizedError",
      because: "WRONG_TENANT",
    });
  });

  it("INV-ORG-002: accepts only attendees whose dated seat overlaps the resolution date", () => {
    const memberships = [
      {
        userId: USER,
        validFrom: new Date("2026-09-18T12:00:00.000Z"),
        validUntil: new Date("2026-09-20T00:00:00.000Z"),
      },
      {
        userId: OTHER_USER,
        validFrom: new Date("2026-09-17T00:00:00.000Z"),
        validUntil: new Date("2026-09-19T00:00:00.000Z"),
      },
    ];
    expect(() => assertAttendingMembersHeldSeats([USER], memberships, "2026-09-19")).not.toThrow();
    expect(() => assertAttendingMembersHeldSeats([OTHER_USER], memberships, "2026-09-19")).toThrow(
      ApprovalBodyResolutionEvidenceError,
    );
  });

  it("refuses attendee evidence without the date needed to interpret it", async () => {
    const transaction = { query: async () => Promise.reject(new Error("unexpected query")) };
    await expect(
      recordBodyResolution(transaction, context(), {
        ...bodyResolutionInput(),
        attendingMembers: [USER],
      }),
    ).rejects.toBeInstanceOf(ApprovalBodyResolutionEvidenceError);
  });
});
