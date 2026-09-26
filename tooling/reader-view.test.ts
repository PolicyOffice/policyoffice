import { describe, expect, it } from "vitest";
import { resolveReaderDocument, type AuditTransaction } from "../packages/domain/src/index.js";

const TENANT = "c7000000-0000-0000-0000-000000000001";
const DOCUMENT = "c7000000-0000-0000-0018-000000000001";
const VARIANT = "c7000000-0000-0000-0019-000000000001";
const VERSION = "c7000000-0000-0000-0020-000000000002";
const REVISION = "c7000000-0000-0000-0021-000000000002";
const FUTURE = "c7000000-0000-0000-0020-000000000003";
const REQUEST_INSTANT = new Date("2026-09-20T09:00:00.000Z");

function documentRow() {
  return {
    document_id: DOCUMENT,
    document_code: "POL-035",
    document_title: "Reader policy",
    baseline_variant_id: VARIANT,
    owner_user_id: "c7000000-0000-0000-0001-000000000001",
    owner_name: "Policy Owner",
    org_unit_id: "c7000000-0000-0000-0007-000000000001",
    org_unit_code: "COMPLIANCE",
    org_unit_name: "Compliance",
    document_type_id: "c7000000-0000-0000-0014-000000000001",
    document_type_name: "Policy",
  };
}

function versionRow() {
  return {
    version_id: VERSION,
    display_label: "2.0",
    version_title: "Reader policy version two",
    lifecycle_state: "EFFECTIVE",
    change_summary: "Clarifies reader handling",
    published_at: new Date("2026-01-01T00:00:00.000Z"),
    effective_from: new Date("2026-02-01T00:00:00.000Z"),
    effective_until: new Date("2027-01-01T00:00:00.000Z"),
    approved_revision_id: REVISION,
    content_digest: `sha-256:${"a".repeat(64)}`,
    governs_at_request_instant: true,
    version_document_type_id: "c7000000-0000-0000-0014-000000000001",
    version_document_type_name: "Policy",
    classification_id: "c7000000-0000-0000-0015-000000000001",
    classification_code: "INTERNAL",
    classification_name: "Internal",
    handling_instructions: "Keep inside the company.",
    successor_id: null,
    successor_display_label: null,
    successor_title: null,
  };
}

function transaction(options: Readonly<{ governed: boolean; future: boolean }>): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string) {
      let rows: readonly Readonly<Record<string, unknown>>[];
      if (text.includes("from document\n  join document_variant baseline")) {
        rows = [documentRow()];
      } else if (text.includes("from content_attachment")) {
        rows = [
          {
            id: "c7000000-0000-0000-0022-000000000001",
            filename: "reader-policy.pdf",
            media_type: "application/pdf",
            byte_size: "4096",
            digest: `sha-256:${"b".repeat(64)}`,
          },
        ];
      } else if (
        text.includes("from document_variant variant") &&
        text.includes("classification")
      ) {
        rows = [versionRow()];
      } else if (text.includes("lifecycle_state = 'PUBLISHED'")) {
        rows = options.future
          ? [
              {
                id: FUTURE,
                display_label: "3.0",
                title: "Reader policy version three",
                effective_from: new Date("2027-01-01T00:00:00.000Z"),
              },
            ]
          : [];
      } else if (text.includes("version.effective_range @>")) {
        rows = options.governed
          ? [
              {
                id: VERSION,
                document_id: DOCUMENT,
                document_variant_id: VARIANT,
                lifecycle_state: "EFFECTIVE",
                effective_from: new Date("2026-02-01T00:00:00.000Z"),
                effective_until: new Date("2027-01-01T00:00:00.000Z"),
              },
            ]
          : [];
      } else {
        throw new Error(`unexpected reader query: ${text}`);
      }
      return { rows: rows as Row[] };
    },
  };
}

describe("reader-view shaping", () => {
  it("INV-EFF-001 / INV-EFF-006: keeps the governing version separate from a later scheduled version", async () => {
    const view = await resolveReaderDocument(transaction({ governed: true, future: true }), {
      tenantId: TENANT,
      documentId: DOCUMENT,
      at: REQUEST_INSTANT,
      requestInstant: REQUEST_INSTANT,
    });

    expect(view).toMatchObject({
      document: {
        id: DOCUMENT,
        owner: { name: "Policy Owner" },
        owningScope: { code: "COMPLIANCE" },
      },
      version: {
        id: VERSION,
        displayLabel: "2.0",
        governsAtRequestInstant: true,
        classification: {
          name: "Internal",
          handlingInstructions: "Keep inside the company.",
        },
        attachments: [{ filename: "reader-policy.pdf", byteSize: "4096" }],
      },
      laterPublishedVersion: {
        id: FUTURE,
        displayLabel: "3.0",
        bindsFrom: new Date("2027-01-01T00:00:00.000Z"),
      },
    });
  });

  it("INV-EFF-006: states that nothing governed before the first effective interval", async () => {
    const view = await resolveReaderDocument(transaction({ governed: false, future: false }), {
      tenantId: TENANT,
      documentId: DOCUMENT,
      at: new Date("2024-01-01T00:00:00.000Z"),
      requestInstant: REQUEST_INSTANT,
    });

    expect(view).toMatchObject({
      document: { id: DOCUMENT, code: "POL-035" },
      version: null,
      laterPublishedVersion: null,
    });
  });
});
