import { createHash } from "node:crypto";

/**
 * Canonicalisation schema v1 is a permanent evidence contract. Later schemas may add
 * rules, but they must never reinterpret a manifest that records version 1.
 */
export const CANONICALISATION_SCHEMA_VERSION = 1 as const;

export type Sha256Digest = `sha-256:${string}`;

export interface CanonicalContentPart {
  readonly partId: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
}

export interface CanonicalAttachment {
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly digest: Sha256Digest;
}

export interface CanonicalManifest {
  readonly canonicalisationSchemaVersion: typeof CANONICALISATION_SCHEMA_VERSION;
  readonly contentRevisionId: string;
  readonly contentParts: readonly CanonicalContentPart[];
  readonly attachments: readonly CanonicalAttachment[];
}

export interface CanonicalManifestInput {
  readonly contentRevisionId: string;
  readonly contentParts: readonly CanonicalContentPart[];
  readonly attachments: readonly CanonicalAttachment[];
}

export interface ObservedContentPartDigest {
  readonly partId: string;
  readonly digest: Sha256Digest;
}

export interface ObservedAttachmentDigest {
  readonly filename: string;
  readonly digest: Sha256Digest;
}

export interface ObservedManifestDigests {
  readonly contentParts: readonly ObservedContentPartDigest[];
  readonly attachments: readonly ObservedAttachmentDigest[];
}

export type CanonicalHashFunction = (bytes: Uint8Array) => string;

export interface StoredManifestVerificationInput {
  /** The exact canonical JSON stored with the revision, not a reconstructed object. */
  readonly storedManifest: string;
  readonly expectedContentDigest: Sha256Digest;
  readonly observedDigests: ObservedManifestDigests;
}

export interface ManifestDigestMismatch {
  readonly member: string;
  readonly expectedDigest: Sha256Digest | null;
  readonly observedDigest: Sha256Digest | null;
}

export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly mismatches: readonly ManifestDigestMismatch[];
}

/** Typed refusal for a value that canonical JSON cannot represent without ambiguity. */
export class InvalidCanonicalManifestError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "InvalidCanonicalManifestError";
    this.path = path;
  }
}

const SHA_256 = /^sha-256:[0-9a-f]{64}$/;
const ENCODER = new TextEncoder();

type RecordValue = Record<string, unknown>;

function compareCodePoint(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  while (true) {
    const leftNext = leftIterator.next();
    const rightNext = rightIterator.next();
    if (leftNext.done || rightNext.done) {
      if (leftNext.done && rightNext.done) return 0;
      return leftNext.done ? -1 : 1;
    }
    const leftCodePoint = leftNext.value.codePointAt(0) ?? -1;
    const rightCodePoint = rightNext.value.codePointAt(0) ?? -1;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
}

function normaliseText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCanonicalManifestError(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidCanonicalManifestError(path, "must be a plain object");
  }
  return value as RecordValue;
}

function requireExactKeys(value: RecordValue, path: string, expected: readonly string[]): void {
  const actual = Object.getOwnPropertyNames(value).sort(compareCodePoint);
  const wanted = [...expected].sort(compareCodePoint);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new InvalidCanonicalManifestError(
      path,
      `must contain exactly these keys: ${wanted.join(", ")}`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new InvalidCanonicalManifestError(path, "symbol keys cannot be represented in JSON");
  }
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidCanonicalManifestError(path, "must be an array");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new InvalidCanonicalManifestError(path, "must not contain sparse entries");
    }
  }
  const extraKeys = Object.keys(value).filter((key) => !/^(0|[1-9][0-9]*)$/.test(key));
  if (extraKeys.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
    throw new InvalidCanonicalManifestError(path, "must not carry non-element properties");
  }
  return value;
}

function requireText(value: unknown, path: string, normalise: boolean): string {
  if (typeof value !== "string") {
    throw new InvalidCanonicalManifestError(path, "must be a string");
  }
  const result = normalise ? normaliseText(value) : value;
  if (result.length === 0) throw new InvalidCanonicalManifestError(path, "must not be empty");
  return result;
}

function requireDigest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== "string" || !SHA_256.test(value)) {
    throw new InvalidCanonicalManifestError(
      path,
      "must use sha-256:<64 lowercase hexadecimal characters>",
    );
  }
  return value as Sha256Digest;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw new InvalidCanonicalManifestError(path, "must be a non-negative safe integer");
  }
  return value;
}

function readContentPart(
  candidate: unknown,
  path: string,
  normalise: boolean,
): CanonicalContentPart {
  const value = requireRecord(candidate, path);
  requireExactKeys(value, path, ["partId", "mediaType", "digest"]);
  return Object.freeze({
    partId: requireText(value.partId, `${path}.partId`, normalise),
    mediaType: requireText(value.mediaType, `${path}.mediaType`, normalise),
    digest: requireDigest(value.digest, `${path}.digest`),
  });
}

function readAttachment(candidate: unknown, path: string, normalise: boolean): CanonicalAttachment {
  const value = requireRecord(candidate, path);
  requireExactKeys(value, path, ["filename", "mediaType", "byteSize", "digest"]);
  return Object.freeze({
    filename: requireText(value.filename, `${path}.filename`, normalise),
    mediaType: requireText(value.mediaType, `${path}.mediaType`, normalise),
    byteSize: requireNonNegativeInteger(value.byteSize, `${path}.byteSize`),
    digest: requireDigest(value.digest, `${path}.digest`),
  });
}

function assertUniquePartIds(contentParts: readonly CanonicalContentPart[], path: string): void {
  const partIds = new Set<string>();
  for (const part of contentParts) {
    if (partIds.has(part.partId)) {
      throw new InvalidCanonicalManifestError(
        `${path}.contentParts`,
        `partId ${JSON.stringify(part.partId)} occurs more than once`,
      );
    }
    partIds.add(part.partId);
  }
}

function readManifest(candidate: unknown, path: string, canonicalise: boolean): CanonicalManifest {
  const value = requireRecord(candidate, path);
  requireExactKeys(value, path, [
    "canonicalisationSchemaVersion",
    "contentRevisionId",
    "contentParts",
    "attachments",
  ]);
  const schemaVersion = requireNonNegativeInteger(
    value.canonicalisationSchemaVersion,
    `${path}.canonicalisationSchemaVersion`,
  );
  if (schemaVersion !== CANONICALISATION_SCHEMA_VERSION) {
    throw new InvalidCanonicalManifestError(
      `${path}.canonicalisationSchemaVersion`,
      `must be ${CANONICALISATION_SCHEMA_VERSION}`,
    );
  }
  const contentParts = requireArray(value.contentParts, `${path}.contentParts`).map((part, index) =>
    readContentPart(part, `${path}.contentParts[${index}]`, canonicalise),
  );
  const attachments = requireArray(value.attachments, `${path}.attachments`).map(
    (attachment, index) =>
      readAttachment(attachment, `${path}.attachments[${index}]`, canonicalise),
  );
  assertUniquePartIds(contentParts, path);

  if (canonicalise) {
    contentParts.sort(
      (left, right) =>
        compareCodePoint(left.partId, right.partId) ||
        compareCodePoint(left.digest, right.digest) ||
        compareCodePoint(left.mediaType, right.mediaType),
    );
    attachments.sort(
      (left, right) =>
        compareCodePoint(left.filename, right.filename) ||
        compareCodePoint(left.digest, right.digest) ||
        compareCodePoint(left.mediaType, right.mediaType) ||
        left.byteSize - right.byteSize,
    );
  }

  return Object.freeze({
    canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
    contentRevisionId: requireText(
      value.contentRevisionId,
      `${path}.contentRevisionId`,
      canonicalise,
    ),
    contentParts: Object.freeze(contentParts),
    attachments: Object.freeze(attachments),
  });
}

function stringifyCanonicalJson(value: unknown, path = "manifest"): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(normaliseText(value));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidCanonicalManifestError(path, "floating-point numbers are forbidden");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((member, index) => stringifyCanonicalJson(member, `${path}[${index}]`)).join(",")}]`;
  }
  const object = requireRecord(value, path);
  const keys = Object.keys(object).sort(compareCodePoint);
  const normalisedKeys = new Set<string>();
  const members = keys.map((key) => {
    const normalisedKey = normaliseText(key);
    if (normalisedKeys.has(normalisedKey)) {
      throw new InvalidCanonicalManifestError(path, "object keys collide after NFC normalisation");
    }
    normalisedKeys.add(normalisedKey);
    return `${JSON.stringify(normalisedKey)}:${stringifyCanonicalJson(object[key], `${path}.${normalisedKey}`)}`;
  });
  return `{${members.join(",")}}`;
}

/**
 * Construct the one complete manifest for a revision. Attachments are not an optional
 * side-channel: every supplied attachment is normalised, ordered and included in the
 * returned value (INV-VER-009, INV-VER-013).
 *
 * The output deliberately contains no clock, host or request data. Byte-exact
 * reproducibility from stored records is required by INV-EVD-006 and INV-APL-009.
 */
export function buildCanonicalManifest(input: CanonicalManifestInput): CanonicalManifest {
  const value = requireRecord(input, "manifest input");
  requireExactKeys(value, "manifest input", ["contentRevisionId", "contentParts", "attachments"]);
  return readManifest(
    {
      canonicalisationSchemaVersion: CANONICALISATION_SCHEMA_VERSION,
      contentRevisionId: value.contentRevisionId,
      contentParts: value.contentParts,
      attachments: value.attachments,
    },
    "manifest",
    true,
  );
}

/** Canonical JSON: code-point key order, UTF-8-ready NFC strings and no whitespace. */
export function serializeCanonicalManifest(manifest: CanonicalManifest): string {
  return stringifyCanonicalJson(readManifest(manifest, "manifest", true));
}

/** Hash arbitrary observed bytes with the repository-wide, prefixed digest format. */
export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  if (!(bytes instanceof Uint8Array)) {
    throw new InvalidCanonicalManifestError("bytes", "must be a Uint8Array");
  }
  return `sha-256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Digest the canonical serialisation of the complete manifest. */
export function digestCanonicalManifest(manifest: CanonicalManifest): Sha256Digest {
  return sha256Digest(ENCODER.encode(serializeCanonicalManifest(manifest)));
}

function readObservedDigests(candidate: unknown): ObservedManifestDigests {
  const value = requireRecord(candidate, "observedDigests");
  requireExactKeys(value, "observedDigests", ["contentParts", "attachments"]);
  const partIds = new Set<string>();
  const contentParts = requireArray(value.contentParts, "observedDigests.contentParts").map(
    (candidatePart, index) => {
      const path = `observedDigests.contentParts[${index}]`;
      const part = requireRecord(candidatePart, path);
      requireExactKeys(part, path, ["partId", "digest"]);
      const result = Object.freeze({
        partId: requireText(part.partId, `${path}.partId`, false),
        digest: requireDigest(part.digest, `${path}.digest`),
      });
      if (partIds.has(result.partId)) {
        throw new InvalidCanonicalManifestError(path, "partId occurs more than once");
      }
      partIds.add(result.partId);
      return result;
    },
  );
  const attachments = requireArray(value.attachments, "observedDigests.attachments").map(
    (candidateAttachment, index) => {
      const path = `observedDigests.attachments[${index}]`;
      const attachment = requireRecord(candidateAttachment, path);
      requireExactKeys(attachment, path, ["filename", "digest"]);
      const result = Object.freeze({
        filename: requireText(attachment.filename, `${path}.filename`, false),
        digest: requireDigest(attachment.digest, `${path}.digest`),
      });
      return result;
    },
  );
  return Object.freeze({
    contentParts: Object.freeze(contentParts),
    attachments: Object.freeze(attachments),
  });
}

function addContentPartMismatches(
  mismatches: ManifestDigestMismatch[],
  manifest: CanonicalManifest,
  observed: ObservedManifestDigests,
): void {
  const expectedById = new Map(manifest.contentParts.map((part) => [part.partId, part.digest]));
  const observedById = new Map(observed.contentParts.map((part) => [part.partId, part.digest]));
  const ids = new Set([...expectedById.keys(), ...observedById.keys()]);
  for (const partId of [...ids].sort(compareCodePoint)) {
    const expectedDigest = expectedById.get(partId) ?? null;
    const observedDigest = observedById.get(partId) ?? null;
    if (expectedDigest !== observedDigest) {
      mismatches.push({ member: `contentPart:${partId}`, expectedDigest, observedDigest });
    }
  }
}

function digestGroups(
  values: readonly { readonly filename: string; readonly digest: Sha256Digest }[],
): Map<string, Sha256Digest[]> {
  const groups = new Map<string, Sha256Digest[]>();
  for (const value of values) {
    const group = groups.get(value.filename) ?? [];
    group.push(value.digest);
    groups.set(value.filename, group);
  }
  for (const group of groups.values()) group.sort(compareCodePoint);
  return groups;
}

function addAttachmentMismatches(
  mismatches: ManifestDigestMismatch[],
  manifest: CanonicalManifest,
  observed: ObservedManifestDigests,
): void {
  const expectedByName = digestGroups(manifest.attachments);
  const observedByName = digestGroups(observed.attachments);
  const filenames = new Set([...expectedByName.keys(), ...observedByName.keys()]);
  for (const filename of [...filenames].sort(compareCodePoint)) {
    const expected = expectedByName.get(filename) ?? [];
    const actual = observedByName.get(filename) ?? [];
    const count = Math.max(expected.length, actual.length);
    for (let index = 0; index < count; index += 1) {
      const expectedDigest = expected[index] ?? null;
      const observedDigest = actual[index] ?? null;
      if (expectedDigest !== observedDigest) {
        const suffix = count === 1 ? "" : `#${index + 1}`;
        mismatches.push({
          member: `attachment:${filename}${suffix}`,
          expectedDigest,
          observedDigest,
        });
      }
    }
  }
}

/**
 * Verify exact stored manifest bytes and every observed member digest. The stored bytes
 * are hashed directly; this path deliberately never reserialises them with the
 * canonicalisation implementation that happens to be current.
 */
export function verifyStoredCanonicalManifest(
  input: StoredManifestVerificationInput,
  hash: CanonicalHashFunction = sha256Digest,
): ManifestVerificationResult {
  const value = requireRecord(input, "verification input");
  requireExactKeys(value, "verification input", [
    "storedManifest",
    "expectedContentDigest",
    "observedDigests",
  ]);
  const storedManifest = requireText(
    value.storedManifest,
    "verification input.storedManifest",
    false,
  );
  const expectedContentDigest = requireDigest(
    value.expectedContentDigest,
    "verification input.expectedContentDigest",
  );
  const observed = readObservedDigests(value.observedDigests);
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedManifest) as unknown;
  } catch (cause) {
    throw new InvalidCanonicalManifestError(
      "verification input.storedManifest",
      `must be valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  const manifest = readManifest(parsed, "stored manifest", false);
  const observedManifestDigest = requireDigest(hash(ENCODER.encode(storedManifest)), "hash result");
  const mismatches: ManifestDigestMismatch[] = [];
  if (observedManifestDigest !== expectedContentDigest) {
    mismatches.push({
      member: "manifest",
      expectedDigest: expectedContentDigest,
      observedDigest: observedManifestDigest,
    });
  }
  addContentPartMismatches(mismatches, manifest, observed);
  addAttachmentMismatches(mismatches, manifest, observed);
  return Object.freeze({ valid: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}
