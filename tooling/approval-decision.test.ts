import { describe, expect, it } from "vitest";
import {
  ApprovalBodyResolutionRequiredError,
  UnsupportedApprovalCompletionRuleError,
  isApprovalStageSatisfied,
} from "../packages/domain/src/approval-decision.js";

describe("approval stage completion", () => {
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
