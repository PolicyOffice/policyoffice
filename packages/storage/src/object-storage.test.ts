import { describe, expect, it } from "vitest";
import {
  StorageConfigurationError,
  contentUploadQuarantineKey,
  createControlledFileStorage,
  storageConfiguration,
  type ContentUploadClaims,
} from "./index.js";

const TENANT = "71000000-0000-0000-0000-000000000001";
const VERSION = "71000000-0000-0000-0001-000000000001";
const REVISION = "71000000-0000-0000-0002-000000000001";
const SLOT = "71000000-0000-0000-0003-000000000001";
const DIGEST = `sha-256:${"a".repeat(64)}` as const;

const environment = Object.freeze({
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "test-access",
  S3_SECRET_KEY: "test-secret",
  S3_BUCKET: "policyoffice-test",
});

function claims(): ContentUploadClaims {
  return {
    tenantId: TENANT,
    documentVersionId: VERSION,
    revisionId: REVISION,
    slotId: SLOT,
    claimedDigest: DIGEST,
    claimedByteSize: 17,
    expiresAt: new Date("2026-09-21T12:05:00.000Z"),
  };
}

describe("controlled-file storage contracts", () => {
  it("binds tenant, revision, claims and expiry into the quarantine key", () => {
    expect(contentUploadQuarantineKey(claims())).toBe(
      [
        "quarantine",
        "t",
        TENANT,
        "version",
        VERSION,
        "revision",
        REVISION,
        "slot",
        SLOT,
        "expires",
        "1789992300",
        "size",
        "17",
        "sha256",
        "a".repeat(64),
      ].join("/"),
    );
    expect(contentUploadQuarantineKey({ ...claims(), tenantId: TENANT.toUpperCase() })).toBe(
      contentUploadQuarantineKey(claims()),
    );
  });

  it("parses the one storage configuration and infers path-style access for local MinIO", () => {
    expect(storageConfiguration(environment)).toEqual({
      endpoint: "http://localhost:9000",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      bucket: "policyoffice-test",
      region: "us-east-1",
      forcePathStyle: true,
    });
  });

  it.each(["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"])(
    "refuses startup without %s",
    (missing) => {
      expect(() => storageConfiguration({ ...environment, [missing]: undefined })).toThrow(
        new StorageConfigurationError(`${missing} is required`),
      );
    },
  );

  it("refuses malformed endpoint, bucket and path-style settings", () => {
    expect(() => storageConfiguration({ ...environment, S3_ENDPOINT: "not-a-url" })).toThrow(
      StorageConfigurationError,
    );
    expect(() => storageConfiguration({ ...environment, S3_BUCKET: "Invalid_Bucket" })).toThrow(
      StorageConfigurationError,
    );
    expect(() => storageConfiguration({ ...environment, S3_FORCE_PATH_STYLE: "yes" })).toThrow(
      StorageConfigurationError,
    );
  });

  it("refuses an expired finalization before contacting object storage", async () => {
    const storage = createControlledFileStorage(storageConfiguration(environment));
    await expect(storage.verifyAndStoreUpload(claims(), claims().expiresAt)).rejects.toMatchObject({
      code: "EXPIRED",
    });
  });
});
