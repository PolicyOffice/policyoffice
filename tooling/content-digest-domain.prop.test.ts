import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildCanonicalManifest,
  digestCanonicalManifest,
  serializeCanonicalManifest,
  sha256Digest,
  type CanonicalAttachment,
  type CanonicalContentPart,
  type CanonicalManifestInput,
  type Sha256Digest,
} from "../packages/domain/src/content-digest.js";

const token = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
    minLength: 1,
    maxLength: 16,
  })
  .map((characters) => characters.join(""));
const digest = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((characters) => `sha-256:${characters.join("")}` as Sha256Digest);
const contentPart = fc.record<CanonicalContentPart>({
  partId: token,
  mediaType: token.map((value) => `application/${value}`),
  digest,
});
const attachment = fc.record<CanonicalAttachment>({
  filename: token.map((value) => `${value}.bin`),
  mediaType: token.map((value) => `application/${value}`),
  byteSize: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
  digest,
});
const contentParts = fc.uniqueArray(contentPart, {
  selector: ({ partId }) => partId,
  maxLength: 6,
});
const attachments = fc.uniqueArray(attachment, {
  selector: ({ filename, digest: value }) => `${filename}\u0000${value}`,
  maxLength: 6,
});
const manifest = fc.record<CanonicalManifestInput>({
  contentRevisionId: token,
  contentParts,
  attachments,
});
const manifestWithAttachment = fc.record<CanonicalManifestInput>({
  contentRevisionId: token,
  contentParts,
  attachments: fc.uniqueArray(attachment, {
    selector: ({ filename, digest: value }) => `${filename}\u0000${value}`,
    minLength: 1,
    maxLength: 6,
  }),
});
const governedBytes = fc.uint8Array({ minLength: 1, maxLength: 256 });

describe("canonical content manifest properties", () => {
  it("INV-VER-009: serialisation is deterministic under arbitrary member permutations", () => {
    fc.assert(
      fc.property(manifest, (candidate) => {
        const forward = buildCanonicalManifest(candidate);
        const permuted = buildCanonicalManifest({
          ...candidate,
          contentParts: [...candidate.contentParts].reverse(),
          attachments: [...candidate.attachments].reverse(),
        });
        expect(serializeCanonicalManifest(permuted)).toBe(serializeCanonicalManifest(forward));
      }),
    );
  });

  it("INV-VER-009 / INV-VER-013: changing any governed attachment byte changes the content digest", () => {
    fc.assert(
      fc.property(manifestWithAttachment, governedBytes, (candidate, originalBytes) => {
        const first = candidate.attachments[0];
        if (!first) throw new Error("generator promised at least one attachment");
        const changedBytes = originalBytes.slice();
        const firstByte = changedBytes[0];
        if (firstByte === undefined) throw new Error("generator promised at least one byte");
        changedBytes[0] = firstByte ^ 1;
        const before = {
          ...candidate,
          attachments: [
            { ...first, byteSize: originalBytes.byteLength, digest: sha256Digest(originalBytes) },
            ...candidate.attachments.slice(1),
          ],
        };
        const after = {
          ...candidate,
          attachments: [
            { ...first, byteSize: changedBytes.byteLength, digest: sha256Digest(changedBytes) },
            ...candidate.attachments.slice(1),
          ],
        };
        expect(digestCanonicalManifest(buildCanonicalManifest(after))).not.toBe(
          digestCanonicalManifest(buildCanonicalManifest(before)),
        );
      }),
    );
  });

  it("INV-VER-009: serialisation round-trips every covered value", () => {
    fc.assert(
      fc.property(manifest, (candidate) => {
        const canonical = buildCanonicalManifest(candidate);
        expect(JSON.parse(serializeCanonicalManifest(canonical))).toEqual(canonical);
      }),
    );
  });
});
