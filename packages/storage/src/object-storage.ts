import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  contentStorageReference,
  inspectContentBytes,
  type InspectedContentBytes,
  type Sha256Digest,
} from "../../domain/src/index.js";
import { StorageConfigurationError, type StorageConfiguration } from "./config.js";

export const CONTENT_UPLOAD_SLOT_TTL_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_256 = /^sha-256:[0-9a-f]{64}$/;
const SINGLE_USE_HEADER = "if-none-match";

export interface ContentUploadClaims {
  readonly tenantId: string;
  readonly documentVersionId: string;
  readonly revisionId: string;
  readonly slotId: string;
  readonly claimedDigest: Sha256Digest;
  readonly claimedByteSize: number;
  readonly expiresAt: Date;
}

export interface ContentUploadSlot extends ContentUploadClaims {
  readonly uploadUrl: string;
  readonly requiredHeaders: Readonly<Record<typeof SINGLE_USE_HEADER, "*">>;
}

export interface FinalizedContentUpload extends InspectedContentBytes {
  readonly contentBytes: Uint8Array;
  readonly quarantineKey: string;
}

export interface CreateContentUploadSlotInput extends Omit<ContentUploadClaims, "expiresAt"> {
  readonly issuedAt: Date;
  readonly ttlSeconds?: number;
}

export interface ControlledFileStorage {
  createUploadSlot(input: CreateContentUploadSlotInput): Promise<ContentUploadSlot>;
  verifyAndStoreUpload(claims: ContentUploadClaims, now?: Date): Promise<FinalizedContentUpload>;
  consumeUpload(claims: ContentUploadClaims): Promise<void>;
}

export class ControlledFileUploadError extends Error {
  readonly code: "CLAIM_MISMATCH" | "EXPIRED" | "INTEGRITY_CONFLICT" | "NOT_FOUND";

  constructor(
    code: "CLAIM_MISMATCH" | "EXPIRED" | "INTEGRITY_CONFLICT" | "NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlledFileUploadError";
    this.code = code;
  }
}

function requireUuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value.toLowerCase();
}

function requireDigest(value: Sha256Digest): Sha256Digest {
  if (!SHA_256.test(value)) throw new TypeError("claimedDigest must be a lowercase SHA-256 digest");
  return value;
}

function requireByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("claimedByteSize must be a positive safe integer");
  }
  return value;
}

function requireDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return new Date(value.valueOf());
}

function requireTtl(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > CONTENT_UPLOAD_SLOT_TTL_SECONDS) {
    throw new TypeError(`ttlSeconds must be between 1 and ${CONTENT_UPLOAD_SLOT_TTL_SECONDS}`);
  }
  return value;
}

function validatedClaims(claims: ContentUploadClaims): ContentUploadClaims {
  return Object.freeze({
    tenantId: requireUuid(claims.tenantId, "tenantId"),
    documentVersionId: requireUuid(claims.documentVersionId, "documentVersionId"),
    revisionId: requireUuid(claims.revisionId, "revisionId"),
    slotId: requireUuid(claims.slotId, "slotId"),
    claimedDigest: requireDigest(claims.claimedDigest),
    claimedByteSize: requireByteSize(claims.claimedByteSize),
    expiresAt: requireDate(claims.expiresAt, "expiresAt"),
  });
}

/** The quarantine key binds every claim that finalization relies on to the signed PUT. */
export function contentUploadQuarantineKey(input: ContentUploadClaims): string {
  const claims = validatedClaims(input);
  const digestHex = claims.claimedDigest.slice("sha-256:".length);
  const expiresAtSeconds = Math.floor(claims.expiresAt.valueOf() / 1_000);
  return [
    "quarantine",
    "t",
    claims.tenantId,
    "version",
    claims.documentVersionId,
    "revision",
    claims.revisionId,
    "slot",
    claims.slotId,
    "expires",
    String(expiresAtSeconds),
    "size",
    String(claims.claimedByteSize),
    "sha256",
    digestHex,
  ].join("/");
}

function createStorageClient(configuration: StorageConfiguration): S3Client {
  return new S3Client({
    endpoint: configuration.endpoint,
    region: configuration.region,
    forcePathStyle: configuration.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  });
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    statusCode(error) === 404 || errorName(error) === "NoSuchKey" || errorName(error) === "NotFound"
  );
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    statusCode(error) === 409 ||
    statusCode(error) === 412 ||
    errorName(error) === "PreconditionFailed"
  );
}

async function objectBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!object.Body) {
      throw new ControlledFileUploadError("NOT_FOUND", "uploaded object has no body");
    }
    return new Uint8Array(await object.Body.transformToByteArray());
  } catch (cause) {
    if (cause instanceof ControlledFileUploadError) throw cause;
    if (isNotFound(cause)) {
      throw new ControlledFileUploadError("NOT_FOUND", "uploaded object was not found", {
        cause,
      });
    }
    throw cause;
  }
}

async function writeContentOnce(
  client: S3Client,
  configuration: StorageConfiguration,
  tenantId: string,
  bytes: Uint8Array,
  inspected: InspectedContentBytes,
): Promise<void> {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: configuration.bucket,
        Key: inspected.storageRef,
        Body: bytes,
        ContentLength: inspected.byteSize,
        ContentType: inspected.mediaType,
        IfNoneMatch: "*",
      }),
    );
    return;
  } catch (cause) {
    if (!isPreconditionFailure(cause)) throw cause;
  }

  const existing = await objectBytes(client, configuration.bucket, inspected.storageRef);
  const existingInspection = inspectContentBytes(tenantId, existing);
  if (
    existingInspection.digest !== inspected.digest ||
    contentStorageReference(tenantId, existingInspection.digest) !== inspected.storageRef
  ) {
    throw new ControlledFileUploadError(
      "INTEGRITY_CONFLICT",
      "the content-addressed key already contains different bytes",
    );
  }
}

/** The sole production S3 client seam. */
export function createControlledFileStorage(
  configuration: StorageConfiguration,
): ControlledFileStorage {
  const client = createStorageClient(configuration);

  return Object.freeze({
    async createUploadSlot(input: CreateContentUploadSlotInput) {
      const issuedAt = requireDate(input.issuedAt, "issuedAt");
      const ttlSeconds = requireTtl(input.ttlSeconds ?? CONTENT_UPLOAD_SLOT_TTL_SECONDS);
      const expiresAt = new Date(
        Math.floor(issuedAt.valueOf() / 1_000) * 1_000 + ttlSeconds * 1_000,
      );
      const claims = validatedClaims({ ...input, expiresAt });
      const key = contentUploadQuarantineKey(claims);
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: configuration.bucket,
          Key: key,
          IfNoneMatch: "*",
        }),
        {
          expiresIn: ttlSeconds,
          signingDate: issuedAt,
          signableHeaders: new Set([SINGLE_USE_HEADER]),
        },
      );
      return Object.freeze({
        ...claims,
        uploadUrl,
        requiredHeaders: Object.freeze({ [SINGLE_USE_HEADER]: "*" as const }),
      });
    },

    async verifyAndStoreUpload(input: ContentUploadClaims, now: Date = new Date()) {
      const claims = validatedClaims(input);
      const checkedAt = requireDate(now, "now");
      if (checkedAt.valueOf() >= claims.expiresAt.valueOf()) {
        throw new ControlledFileUploadError("EXPIRED", "upload slot has expired");
      }
      const quarantineKey = contentUploadQuarantineKey(claims);
      const bytes = await objectBytes(client, configuration.bucket, quarantineKey);
      const inspected = inspectContentBytes(claims.tenantId, bytes);
      if (
        inspected.digest !== claims.claimedDigest ||
        inspected.byteSize !== claims.claimedByteSize
      ) {
        throw new ControlledFileUploadError(
          "CLAIM_MISMATCH",
          "stored bytes do not match the claims bound to the upload slot",
        );
      }
      await writeContentOnce(client, configuration, claims.tenantId, bytes, inspected);
      return Object.freeze({
        ...inspected,
        contentBytes: new Uint8Array(bytes),
        quarantineKey,
      });
    },

    async consumeUpload(input: ContentUploadClaims) {
      const claims = validatedClaims(input);
      await client.send(
        new PutObjectCommand({
          Bucket: configuration.bucket,
          Key: contentUploadQuarantineKey(claims),
          Body: new Uint8Array(),
          ContentLength: 0,
          ContentType: "application/octet-stream",
          Metadata: { state: "consumed" },
        }),
      );
    },
  });
}

/** Bootstrap the local/CI MinIO bucket; production bucket creation stays out of the app. */
export async function prepareLocalStorageBucket(
  configuration: StorageConfiguration,
): Promise<void> {
  const endpoint = new URL(configuration.endpoint);
  if (endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new StorageConfigurationError("local bucket preparation requires a loopback endpoint");
  }
  const client = createStorageClient(configuration);
  try {
    await client.send(new CreateBucketCommand({ Bucket: configuration.bucket }));
  } catch (cause) {
    if (
      errorName(cause) !== "BucketAlreadyOwnedByYou" &&
      errorName(cause) !== "BucketAlreadyExists"
    ) {
      throw cause;
    }
  }
}
