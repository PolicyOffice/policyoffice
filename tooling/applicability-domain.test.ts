import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_OBLIGATION_STATUSES,
  ALIGNMENT_SUBJECT_TYPES,
  APPLICABILITY_EFFECTS,
  APPLICABILITY_REQUIRED_CAPABILITIES,
  INHERITANCE_MODES,
  evaluateAlignmentObligationDeadline,
} from "../packages/domain/src/applicability.js";

describe("applicability and alignment contracts", () => {
  it("INV-AUTH-017: requires the dedicated applicability capability without defining an evaluator", () => {
    expect(APPLICABILITY_REQUIRED_CAPABILITIES).toEqual({
      changeRules: "document.manage_applicability",
    });
  });

  it("exposes the closed applicability and alignment vocabulary", () => {
    expect(APPLICABILITY_EFFECTS).toEqual(["INCLUDE", "EXCLUDE"]);
    expect(INHERITANCE_MODES).toEqual(["MANDATORY", "DEFAULT", "LOCAL_ONLY"]);
    expect(ALIGNMENT_SUBJECT_TYPES).toEqual(["DOCUMENT_VARIANT", "DOCUMENT_TYPE"]);
    expect(ALIGNMENT_OBLIGATION_STATUSES).toEqual(["OPEN", "RESOLVED"]);
  });

  it("INV-APL-013: passing a deadline only raises visible exception state", () => {
    const obligation = {
      status: "OPEN" as const,
      dueAt: new Date("2027-02-01T00:00:00.000Z"),
      sourceVersionState: "EFFECTIVE",
      downstreamVersionState: "EFFECTIVE",
    };
    const original = structuredClone(obligation);

    expect(
      evaluateAlignmentObligationDeadline(obligation, new Date("2027-01-31T23:59:59.999Z")),
    ).toEqual({ overdue: false, governanceExceptionVisible: false });
    expect(
      evaluateAlignmentObligationDeadline(obligation, new Date("2027-02-01T00:00:00.000Z")),
    ).toEqual({ overdue: true, governanceExceptionVisible: true });
    expect(obligation).toEqual(original);
  });

  it("INV-APL-008 / INV-APL-013: a resolved obligation never becomes overdue again", () => {
    expect(
      evaluateAlignmentObligationDeadline(
        { status: "RESOLVED", dueAt: new Date("2027-02-01T00:00:00.000Z") },
        new Date("2028-02-01T00:00:00.000Z"),
      ),
    ).toEqual({ overdue: false, governanceExceptionVisible: false });
  });
});
