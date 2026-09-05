import { describe, expect, it } from "vitest";
import {
  DIRECT_DOCUMENT_LIFECYCLE_TRANSITIONS,
  DOCUMENT_LIFECYCLE_STATES,
  DOCUMENT_REQUIRED_CAPABILITIES,
  VARIANT_TYPES,
} from "../packages/domain/src/document.js";

describe("document identity contracts", () => {
  it("INV-DOC-002: exposes exactly the Planned, Active and Retired lifecycle", () => {
    expect(DOCUMENT_LIFECYCLE_STATES).toEqual(["PLANNED", "ACTIVE", "RETIRED"]);
  });

  it("INV-DOC-007: offers no direct PLANNED to ACTIVE lifecycle transition", () => {
    expect(DIRECT_DOCUMENT_LIFECYCLE_TRANSITIONS).toEqual([
      { from: "PLANNED", to: "RETIRED", capability: "document.retire" },
    ]);
    expect(DIRECT_DOCUMENT_LIFECYCLE_TRANSITIONS).not.toContainEqual({
      from: "PLANNED",
      to: "ACTIVE",
      capability: expect.anything(),
    });
  });

  it("INV-APL-011: records BASELINE as a closed variant type rather than free text", () => {
    expect(VARIANT_TYPES).toEqual(["BASELINE", "REPLACEMENT", "SUPPLEMENT", "TRANSLATION"]);
  });

  it("INV-AUTH-017: records document command capabilities without inventing an evaluator", () => {
    expect(DOCUMENT_REQUIRED_CAPABILITIES).toEqual({
      listRegister: "document.read",
      create: "document.create",
      changeMetadata: "document.manage",
      changeOwner: "document.manage",
      changeType: "document.manage",
      retire: "document.retire",
      restore: "document.restore",
    });
  });
});
