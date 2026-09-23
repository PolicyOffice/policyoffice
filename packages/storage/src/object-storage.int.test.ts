import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inspectContentBytes, sha256Digest, type Sha256Digest } from "@policyoffice/domain";
import {
  contentUploadQuarantineKey,
  createControlledFileStorage,
  prepareLocalStorageBucket,
  storageConfiguration,
  type ContentUploadClaims,
  type ControlledFileUploadError,
  type StorageConfiguration,
} from "./index.js";

const TENANT_A = "72000000-0000-0000-0000-000000000001";
const TENANT_B = "72000000-0000-0000-0000-000000000002";
const VERSION_A = "72000000-0000-0000-0001-000000000001";
const VERSION_B = "72000000-0000-0000-0001-000000000002";

const configuration = storageConfiguration({
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "minioadmin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "minioadmin",
  S3_BUCKET: "policyoffice-pol044-test",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
});

function testClient(input: StorageConfiguration): S3Client {
  return new S3Client({
    endpoint: input.endpoint,
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  });
}

const client = testClient(configuration);
const storage = createControlledFileStorage(configuration);

function id(namespace: number, sequence: number): string {
  return `72000000-0000-0000-${String(namespace).padStart(4, "0")}-${String(sequence).padStart(12, "0")}`;
}

async function clearBucket(): Promise<void> {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: configuration.bucket }));
  const objects = (listed.Contents ?? []).flatMap((object) =>
    object.Key ? [{ Key: object.Key }] : [],
  );
  if (objects.length > 0) {
    await client.send(
      new DeleteObjectsCommand({ Bucket: configuration.bucket, Delete: { Objects: objects } }),
    );
  }
}

async function readObject(key: string): Promise<Uint8Array> {
  const object = await client.send(
    new GetObjectCommand({ Bucket: configuration.bucket, Key: key }),
  );
  if (!object.Body) throw new Error(`object ${key} has no body`);
  return new Uint8Array(await object.Body.transformToByteArray());
}

async function objectKeys(prefix?: string): Promise<string[]> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: configuration.bucket, Prefix: prefix }),
  );
  return (listed.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])).sort();
}

async function upload(
  bytes: Uint8Array,
  input: {
    tenantId: string;
    versionId: string;
    revisionId: string;
    slotId: string;
    claimedDigest?: Sha256Digest;
    claimedByteSize?: number;
    ttlSeconds?: number;
  },
) {
  const issuedAt = new Date();
  const slot = await storage.createUploadSlot({
    tenantId: input.tenantId,
    documentVersionId: input.versionId,
    revisionId: input.revisionId,
    slotId: input.slotId,
    claimedDigest: input.claimedDigest ?? sha256Digest(bytes),
    claimedByteSize: input.claimedByteSize ?? bytes.byteLength,
    issuedAt,
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
  });
  const response = await fetch(slot.uploadUrl, {
    method: "PUT",
    headers: { ...slot.requiredHeaders, "content-type": "application/pdf" },
    body: bytes,
  });
  return { slot, response };
}

beforeAll(async () => {
  await prepareLocalStorageBucket(configuration);
});

beforeEach(clearBucket);
afterAll(async () => {
  await clearBucket();
  client.destroy();
});

describe("controlled files in real MinIO", () => {
  it("INV-VER-009 / INV-VER-010: accepts one PUT, sniffs stored bytes, writes the digest key once and consumes the slot", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const { slot, response } = await upload(bytes, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 1),
      slotId: id(3, 1),
    });
    expect(response.status).toBe(200);

    const replay = await fetch(slot.uploadUrl, {
      method: "PUT",
      headers: slot.requiredHeaders,
      body: new TextEncoder().encode("replacement"),
    });
    expect(replay.status).toBe(412);

    await expect(
      storage.verifyAndStoreUpload({ ...slot, revisionId: id(2, 99) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const finalized = await storage.verifyAndStoreUpload(slot);
    expect(finalized).toMatchObject({
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      digest: sha256Digest(bytes),
      storageRef: `t/${TENANT_A}/blob/${sha256Digest(bytes).slice("sha-256:".length)}`,
    });
    expect(await readObject(finalized.storageRef)).toEqual(bytes);

    await storage.consumeUpload(slot);
    expect(await readObject(contentUploadQuarantineKey(slot))).toHaveLength(0);
    const replayAfterMove = await fetch(slot.uploadUrl, {
      method: "PUT",
      headers: slot.requiredHeaders,
      body: bytes,
    });
    expect(replayAfterMove.status).toBe(412);
  });

  it("INV-VER-009: refuses a client digest mismatch before writing a content object", async () => {
    const bytes = new TextEncoder().encode("server measured bytes");
    const { slot, response } = await upload(bytes, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 2),
      slotId: id(3, 2),
      claimedDigest: `sha-256:${"0".repeat(64)}` as Sha256Digest,
    });
    expect(response.status).toBe(200);
    await expect(storage.verifyAndStoreUpload(slot)).rejects.toMatchObject({
      code: "CLAIM_MISMATCH",
    });
    expect(await objectKeys(`t/${TENANT_A}/blob/`)).toEqual([]);
  });

  it("INV-TEN-001 / INV-TEN-003: deduplicates only within a tenant", async () => {
    const bytes = new TextEncoder().encode("identical governed bytes");
    const first = await upload(bytes, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 3),
      slotId: id(3, 3),
    });
    const second = await upload(bytes, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 4),
      slotId: id(3, 4),
    });
    const foreign = await upload(bytes, {
      tenantId: TENANT_B,
      versionId: VERSION_B,
      revisionId: id(2, 5),
      slotId: id(3, 5),
    });
    expect([first.response.status, second.response.status, foreign.response.status]).toEqual([
      200, 200, 200,
    ]);

    const [firstFinal, secondFinal, foreignFinal] = await Promise.all([
      storage.verifyAndStoreUpload(first.slot),
      storage.verifyAndStoreUpload(second.slot),
      storage.verifyAndStoreUpload(foreign.slot),
    ]);
    expect(firstFinal.storageRef).toBe(secondFinal.storageRef);
    expect(foreignFinal.storageRef).not.toBe(firstFinal.storageRef);
    expect(await objectKeys(`t/${TENANT_A}/blob/`)).toEqual([firstFinal.storageRef]);
    expect(await objectKeys(`t/${TENANT_B}/blob/`)).toEqual([foreignFinal.storageRef]);

    const crossTenantClaims: ContentUploadClaims = {
      ...foreign.slot,
      tenantId: TENANT_A,
    };
    await expect(storage.verifyAndStoreUpload(crossTenantClaims)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("INV-VER-010: never replaces bytes already stored at a content-addressed key", async () => {
    const expected = new TextEncoder().encode("expected governed bytes");
    const inspected = inspectContentBytes(TENANT_A, expected);
    const existing = new TextEncoder().encode("unexpected existing bytes");
    await client.send(
      new PutObjectCommand({
        Bucket: configuration.bucket,
        Key: inspected.storageRef,
        Body: existing,
      }),
    );
    const { slot } = await upload(expected, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 6),
      slotId: id(3, 6),
    });
    await expect(storage.verifyAndStoreUpload(slot)).rejects.toEqual(
      expect.objectContaining<Partial<ControlledFileUploadError>>({ code: "INTEGRITY_CONFLICT" }),
    );
    expect(await readObject(inspected.storageRef)).toEqual(existing);
  });

  it("expires both the provider credential and server finalization window", async () => {
    const bytes = new TextEncoder().encode("short lived upload");
    const first = await upload(bytes, {
      tenantId: TENANT_A,
      versionId: VERSION_A,
      revisionId: id(2, 7),
      slotId: id(3, 7),
      ttlSeconds: 1,
    });
    expect(first.response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(storage.verifyAndStoreUpload(first.slot, new Date())).rejects.toMatchObject({
      code: "EXPIRED",
    });

    const second = await storage.createUploadSlot({
      tenantId: TENANT_A,
      documentVersionId: VERSION_A,
      revisionId: id(2, 8),
      slotId: id(3, 8),
      claimedDigest: sha256Digest(bytes),
      claimedByteSize: bytes.byteLength,
      issuedAt: new Date(),
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expiredPut = await fetch(second.uploadUrl, {
      method: "PUT",
      headers: second.requiredHeaders,
      body: bytes,
    });
    expect(expiredPut.status).toBe(403);
  });
});
