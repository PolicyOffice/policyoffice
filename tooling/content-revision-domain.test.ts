import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_REVISION_REQUIRED_CAPABILITIES,
  ContentRevisionLifecycleError,
  addContentAttachment,
  createContentRevision,
  inspectContentMediaType,
  type AuditTransaction,
  type CreateContentRevisionInput,
} from "../packages/domain/src/index.js";

const TENANT = "95000000-0000-0000-0000-000000000001";
const REVISION = "95000000-0000-0000-0001-000000000001";
const VERSION = "95000000-0000-0000-0002-000000000001";
const USER = "95000000-0000-0000-0003-000000000001";
const CONFIGURATION = "95000000-0000-0000-0004-000000000001";
const REQUEST = "95000000-0000-0000-0005-000000000001";
const CORRELATION = "95000000-0000-0000-0006-000000000001";

function creationInput(): CreateContentRevisionInput {
  return {
    tenantId: TENANT,
    revisionId: REVISION,
    documentVersionId: VERSION,
    createdByUserId: USER,
    contentBytes: new TextEncoder().encode("Controlled policy body"),
    actor: { type: "USER", id: USER },
    configurationVersionId: CONFIGURATION,
    occurredAt: new Date("2027-03-01T10:00:00.000Z"),
    requestId: REQUEST,
    correlationId: CORRELATION,
    sourceChannel: "API",
  };
}

describe("content revision domain contracts", () => {
  it("INV-VER-009: refuses a caller-supplied digest before issuing a query", async () => {
    const query = vi.fn();
    const input = {
      ...creationInput(),
      contentDigest: `sha-256:${"0".repeat(64)}`,
    } as CreateContentRevisionInput;

    await expect(createContentRevision({ query } as AuditTransaction, input)).rejects.toThrow(
      /exactly these keys/i,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("INV-VER-004: refuses attachment edits while the version is IN_REVIEW", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: REVISION,
          document_id: "95000000-0000-0000-0007-000000000001",
          document_variant_id: "95000000-0000-0000-0008-000000000001",
          document_version_id: VERSION,
          lifecycle_state: "IN_REVIEW",
          canonical_manifest: "{}",
          submitted_at: null,
          row_version: 1,
        },
      ],
    });

    await expect(
      addContentAttachment({ query } as AuditTransaction, {
        tenantId: TENANT,
        revisionId: REVISION,
        attachmentId: "95000000-0000-0000-0009-000000000001",
        expectedRevisionRowVersion: 1,
        filename: "evidence.pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      }),
    ).rejects.toBeInstanceOf(ContentRevisionLifecycleError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("records capabilities at every entry point without introducing an evaluator", () => {
    expect(CONTENT_REVISION_REQUIRED_CAPABILITIES).toEqual({
      create: "document.edit_draft",
      addAttachment: "document.edit_draft",
      replaceAttachment: "document.edit_draft",
      removeAttachment: "document.edit_draft",
      submit: "document.submit",
    });
  });

  it("INV-VER-013: inspects magic bytes rather than trusting a filename or content type", () => {
    expect(inspectContentMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      "application/pdf",
    );
    expect(inspectContentMediaType(new TextEncoder().encode("plain policy text"))).toBe(
      "text/plain",
    );
    expect(inspectContentMediaType(new Uint8Array([0, 0xff, 0]))).toBe("application/octet-stream");
  });
});
