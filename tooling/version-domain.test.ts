import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIRECT_VERSION_LIFECYCLE_TRANSITIONS,
  DOCUMENT_VERSION_COLUMN_CLASSIFICATION,
  MATERIALITY_CLASSES,
  VERSION_LIFECYCLE_STATES,
  VERSION_REQUIRED_CAPABILITIES,
} from "../packages/domain/src/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("document version contracts", () => {
  it("INV-EFF-001 / INV-EFF-006: persists exactly ten lifecycle states and no derived conditions", () => {
    expect(VERSION_LIFECYCLE_STATES).toEqual([
      "DRAFT",
      "IN_REVIEW",
      "CHANGES_REQUESTED",
      "APPROVED",
      "PUBLISHED",
      "EFFECTIVE",
      "SUPERSEDED",
      "WITHDRAWN",
      "REJECTED",
      "CANCELLED",
    ]);
    expect(VERSION_LIFECYCLE_STATES).not.toContain("SCHEDULED");
    expect(VERSION_LIFECYCLE_STATES).not.toContain("ARCHIVED");
  });

  it("INV-VER-003 / INV-EFF-001 / INV-EFF-004: exposes exactly the specified lifecycle transitions", () => {
    expect(DIRECT_VERSION_LIFECYCLE_TRANSITIONS).toEqual([
      { from: "DRAFT", to: "IN_REVIEW" },
      { from: "IN_REVIEW", to: "CHANGES_REQUESTED" },
      { from: "CHANGES_REQUESTED", to: "DRAFT" },
      { from: "IN_REVIEW", to: "APPROVED" },
      { from: "IN_REVIEW", to: "REJECTED" },
      { from: "DRAFT", to: "CANCELLED" },
      { from: "IN_REVIEW", to: "CANCELLED" },
      { from: "CHANGES_REQUESTED", to: "CANCELLED" },
      { from: "APPROVED", to: "CANCELLED" },
      { from: "APPROVED", to: "PUBLISHED" },
      { from: "PUBLISHED", to: "EFFECTIVE" },
      { from: "PUBLISHED", to: "WITHDRAWN" },
      { from: "EFFECTIVE", to: "SUPERSEDED" },
      { from: "EFFECTIVE", to: "WITHDRAWN" },
    ]);
  });

  it("records the four human-decided materiality classes", () => {
    expect(MATERIALITY_CLASSES).toEqual(["EDITORIAL", "NON_MATERIAL", "MATERIAL", "EMERGENCY"]);
  });

  it("INV-VER-003 / INV-VER-007 / INV-VER-008 / INV-DOC-009 / INV-DOC-010: classifies every stored column explicitly", () => {
    expect(DOCUMENT_VERSION_COLUMN_CLASSIFICATION).toEqual({
      identity: ["tenant_id", "id", "created_at"],
      governed: [
        "document_variant_id",
        "version_sequence",
        "document_type_id",
        "title",
        "classification_id",
        "materiality",
        "change_summary",
        "effective_from",
        "effective_until",
        "content_digest",
        "approved_revision_id",
        "configuration_version_id",
      ],
      administrative: [
        "display_label",
        "lifecycle_state",
        "approved_at",
        "published_at",
        "superseded_by_version_id",
        "withdrawn_at",
        "withdrawal_reason",
        "updated_at",
        "row_version",
      ],
      generated: ["effective_range"],
    });

    const classified = Object.values(DOCUMENT_VERSION_COLUMN_CLASSIFICATION).flat();
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(
      [
        "approved_at",
        "approved_revision_id",
        "change_summary",
        "classification_id",
        "configuration_version_id",
        "content_digest",
        "created_at",
        "display_label",
        "document_type_id",
        "document_variant_id",
        "effective_from",
        "effective_range",
        "effective_until",
        "id",
        "lifecycle_state",
        "materiality",
        "published_at",
        "row_version",
        "superseded_by_version_id",
        "tenant_id",
        "title",
        "updated_at",
        "version_sequence",
        "withdrawal_reason",
        "withdrawn_at",
      ].sort(),
    );
  });

  it("INV-VER-006: treats display labels as metadata and never as an ordering expression", () => {
    expect(DOCUMENT_VERSION_COLUMN_CLASSIFICATION.administrative).toContain("display_label");
    expect(DOCUMENT_VERSION_COLUMN_CLASSIFICATION.governed).toContain("version_sequence");
    for (const path of [
      "packages/domain/src/version.ts",
      "packages/db/src/schema.ts",
      "packages/db/src/fixtures.ts",
    ]) {
      expect(readFileSync(`${ROOT}/${path}`, "utf8")).not.toMatch(
        /order\s+by\s+(?:\w+\.)?display_label/i,
      );
    }
  });

  it("records version entry-point capabilities without inventing an evaluator", () => {
    expect(VERSION_REQUIRED_CAPABILITIES).toEqual({
      create: "document.edit_draft",
      changeMateriality: "document.edit_draft",
      changeMetadata: "document.manage",
      cancel: "document.cancel_version",
    });
  });
});
