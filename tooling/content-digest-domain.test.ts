import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as contentDigestModule from "../packages/domain/src/content-digest.js";
import {
  CANONICALISATION_SCHEMA_VERSION,
  InvalidCanonicalManifestError,
  buildCanonicalManifest,
  digestCanonicalManifest,
  serializeCanonicalManifest,
  sha256Digest,
  verifyStoredCanonicalManifest,
  type CanonicalManifestInput,
  type ObservedManifestDigests,
  type Sha256Digest,
} from "../packages/domain/src/content-digest.js";

const A = `sha-256:${"a".repeat(64)}` as Sha256Digest;
const B = `sha-256:${"b".repeat(64)}` as Sha256Digest;
const C = `sha-256:${"c".repeat(64)}` as Sha256Digest;

function input(overrides: Partial<CanonicalManifestInput> = {}): CanonicalManifestInput {
  return {
    contentRevisionId: "revision-1",
    contentParts: [{ partId: "body", mediaType: "application/pdf", digest: A }],
    attachments: [{ filename: "annex.pdf", mediaType: "application/pdf", byteSize: 7, digest: B }],
    ...overrides,
  };
}

function observations(candidate = buildCanonicalManifest(input())): ObservedManifestDigests {
  return {
    contentParts: candidate.contentParts.map(({ partId, digest }) => ({ partId, digest })),
    attachments: candidate.attachments.map(({ filename, digest }) => ({ filename, digest })),
  };
}

interface GoldenVector {
  readonly name: string;
  readonly input: CanonicalManifestInput;
  readonly canonicalJson: string;
  readonly contentDigest: Sha256Digest;
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/content-digest-v1.json", import.meta.url)),
    "utf8",
  ),
) as GoldenVector;

describe("canonical content manifests", () => {
  it("INV-VER-009: keeps the schema-v1 golden bytes and digest stable", () => {
    const manifest = buildCanonicalManifest(golden.input);
    expect(serializeCanonicalManifest(manifest), golden.name).toBe(golden.canonicalJson);
    expect(digestCanonicalManifest(manifest), golden.name).toBe(golden.contentDigest);
  });

  it("INV-VER-009: serialises logical members identically under input permutation", () => {
    const forward = buildCanonicalManifest(
      input({
        contentParts: [
          { partId: "body", mediaType: "application/pdf", digest: A },
          { partId: "annex", mediaType: "text/plain", digest: C },
        ],
        attachments: [
          { filename: "z.txt", mediaType: "text/plain", byteSize: 2, digest: C },
          { filename: "a.txt", mediaType: "text/plain", byteSize: 1, digest: B },
        ],
      }),
    );
    const reversed = buildCanonicalManifest(
      input({
        contentParts: [...forward.contentParts].reverse(),
        attachments: [...forward.attachments].reverse(),
      }),
    );
    expect(serializeCanonicalManifest(reversed)).toBe(serializeCanonicalManifest(forward));
  });

  it("INV-VER-013: sorts duplicate filenames by digest as the deterministic tiebreak", () => {
    const manifest = buildCanonicalManifest(
      input({
        attachments: [
          { filename: "annex.pdf", mediaType: "application/pdf", byteSize: 2, digest: C },
          { filename: "annex.pdf", mediaType: "application/pdf", byteSize: 1, digest: B },
        ],
      }),
    );
    expect(manifest.attachments.map(({ digest }) => digest)).toEqual([B, C]);
  });

  it("INV-VER-013: remains insertion-independent when filename and digest are identical", () => {
    const attachments = [
      { filename: "annex", mediaType: "text/plain", byteSize: 1, digest: B },
      { filename: "annex", mediaType: "application/pdf", byteSize: 1, digest: B },
    ] as const;
    const forward = buildCanonicalManifest(input({ attachments }));
    const reversed = buildCanonicalManifest(input({ attachments: [...attachments].reverse() }));
    expect(serializeCanonicalManifest(reversed)).toBe(serializeCanonicalManifest(forward));
  });

  it("INV-VER-009: orders strings by Unicode code point rather than UTF-16 code unit", () => {
    const manifest = buildCanonicalManifest(
      input({
        contentParts: [
          { partId: "\u{10000}", mediaType: "text/plain", digest: A },
          { partId: "\uE000", mediaType: "text/plain", digest: B },
        ],
      }),
    );
    expect(manifest.contentParts.map(({ partId }) => partId)).toEqual(["\uE000", "\u{10000}"]);
  });

  it("INV-VER-009: normalises CRLF, CR and canonically equivalent Unicode", () => {
    const decomposed = buildCanonicalManifest(
      input({
        contentRevisionId: "revision-Cafe\u0301\r\nsecond\rthird",
        attachments: [
          { filename: "Cafe\u0301\r\n.txt", mediaType: "text/plain", byteSize: 1, digest: B },
        ],
      }),
    );
    const composed = buildCanonicalManifest(
      input({
        contentRevisionId: "revision-Café\nsecond\nthird",
        attachments: [{ filename: "Café\n.txt", mediaType: "text/plain", byteSize: 1, digest: B }],
      }),
    );
    expect(serializeCanonicalManifest(decomposed)).toBe(serializeCanonicalManifest(composed));
    expect(digestCanonicalManifest(decomposed)).toBe(digestCanonicalManifest(composed));
  });

  it("INV-VER-009: refuses floating-point values with a typed error", () => {
    const candidate = input({
      attachments: [
        { filename: "annex.pdf", mediaType: "application/pdf", byteSize: 1.5, digest: B },
      ],
    });
    expect(() => buildCanonicalManifest(candidate)).toThrow(InvalidCanonicalManifestError);
    expect(() => buildCanonicalManifest(candidate)).toThrow(/non-negative safe integer/);
  });

  it("INV-VER-009: requires and returns prefixed lowercase SHA-256 digests", () => {
    expect(sha256Digest(new TextEncoder().encode("governed bytes"))).toMatch(
      /^sha-256:[0-9a-f]{64}$/,
    );
    expect(() =>
      buildCanonicalManifest(
        input({
          contentParts: [
            {
              partId: "body",
              mediaType: "application/pdf",
              digest: A.toUpperCase() as Sha256Digest,
            },
          ],
        }),
      ),
    ).toThrow(InvalidCanonicalManifestError);
  });

  it("INV-VER-009 / INV-VER-013: changes the content digest when any governed attachment byte changes", () => {
    const encoder = new TextEncoder();
    const beforeAttachmentDigest = sha256Digest(encoder.encode("annex bytes"));
    const afterAttachmentDigest = sha256Digest(encoder.encode("Annex bytes"));
    const before = buildCanonicalManifest(
      input({
        attachments: [
          {
            filename: "annex.pdf",
            mediaType: "application/pdf",
            byteSize: 11,
            digest: beforeAttachmentDigest,
          },
        ],
      }),
    );
    const after = buildCanonicalManifest(
      input({
        attachments: [
          {
            filename: "annex.pdf",
            mediaType: "application/pdf",
            byteSize: 11,
            digest: afterAttachmentDigest,
          },
        ],
      }),
    );
    expect(digestCanonicalManifest(after)).not.toBe(digestCanonicalManifest(before));
  });

  it("INV-VER-013: exposes one construction path and includes every attachment it receives", () => {
    expect(Object.keys(contentDigestModule).sort()).toEqual([
      "CANONICALISATION_SCHEMA_VERSION",
      "InvalidCanonicalManifestError",
      "buildCanonicalManifest",
      "digestCanonicalManifest",
      "serializeCanonicalManifest",
      "sha256Digest",
      "verifyStoredCanonicalManifest",
    ]);
    const attachments = [
      { filename: "one.txt", mediaType: "text/plain", byteSize: 1, digest: A },
      { filename: "two.txt", mediaType: "text/plain", byteSize: 2, digest: B },
    ] as const;
    expect(buildCanonicalManifest(input({ attachments })).attachments).toHaveLength(
      attachments.length,
    );
  });

  it("INV-VER-009: records schema version 1 and rejects run-specific metadata", () => {
    const manifest = buildCanonicalManifest(input());
    expect(manifest.canonicalisationSchemaVersion).toBe(CANONICALISATION_SCHEMA_VERSION);
    const serialized = serializeCanonicalManifest(manifest);
    expect(serialized).not.toMatch(/timestamp|generatedAt|hostname|hostIdentifier/);
    expect(() =>
      buildCanonicalManifest({
        ...input(),
        generatedAt: "2027-01-01T00:00:00Z",
      } as CanonicalManifestInput),
    ).toThrow(InvalidCanonicalManifestError);
  });

  it("INV-VER-009: verifies stored bytes and matching observed digests without reserialising", () => {
    const manifest = buildCanonicalManifest(input());
    const storedManifest = serializeCanonicalManifest(manifest);
    const hash = vi.fn(sha256Digest);
    const result = verifyStoredCanonicalManifest(
      {
        storedManifest,
        expectedContentDigest: digestCanonicalManifest(manifest),
        observedDigests: observations(manifest),
      },
      hash,
    );
    expect(result).toEqual({ valid: true, mismatches: [] });
    expect(hash).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(hash.mock.calls[0]?.[0])).toBe(storedManifest);
  });

  it("INV-VER-013: fails verification and names a mismatched governed attachment", () => {
    const manifest = buildCanonicalManifest(input());
    const storedManifest = serializeCanonicalManifest(manifest);
    const result = verifyStoredCanonicalManifest({
      storedManifest,
      expectedContentDigest: digestCanonicalManifest(manifest),
      observedDigests: {
        ...observations(manifest),
        attachments: [{ filename: "annex.pdf", digest: C }],
      },
    });
    expect(result).toEqual({
      valid: false,
      mismatches: [{ member: "attachment:annex.pdf", expectedDigest: B, observedDigest: C }],
    });
  });
});
