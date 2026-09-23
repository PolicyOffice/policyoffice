import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STARTUP_CHECK = fileURLToPath(new URL("./startup-check.ts", import.meta.url));
const TENANT_ID = "73000000-0000-0000-0000-000000000001";

const validEnvironment = Object.freeze({
  POLICYOFFICE_TENANT_ID: TENANT_ID,
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "test-access",
  S3_SECRET_KEY: "test-secret",
  S3_BUCKET: "policyoffice-startup-test",
});

function startup(environment: Readonly<Record<string, string | undefined>>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", STARTUP_CHECK], {
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
}

describe("web startup configuration", () => {
  it.each(["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"])(
    "refuses to start without %s",
    (missing) => {
      const result = startup({ ...validEnvironment, [missing]: undefined });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${missing} is required`);
    },
  );

  it("accepts complete tenant and storage configuration without contacting the store", () => {
    const result = startup(validEnvironment);
    expect(result.status, result.stderr).toBe(0);
  });
});
