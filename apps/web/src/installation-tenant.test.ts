import { describe, expect, it } from "vitest";
import { INSTALLATION_TENANT_CONFIGURATION, installationTenantId } from "./installation-tenant.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";

describe("the installation tenant seam", () => {
  it("returns the one configured Pilot tenant", () => {
    expect(installationTenantId({ POLICYOFFICE_TENANT_ID: TENANT_ID })).toBe(TENANT_ID);
  });

  it.each([{}, { POLICYOFFICE_TENANT_ID: "" }])(
    "fails startup when the tenant configuration is missing",
    (environment) => {
      expect(() => installationTenantId(environment)).toThrow(
        `${INSTALLATION_TENANT_CONFIGURATION} is required`,
      );
    },
  );

  it("names malformed tenant configuration instead of silently selecting a tenant", () => {
    expect(() => installationTenantId({ POLICYOFFICE_TENANT_ID: "not-a-uuid" })).toThrow(
      `${INSTALLATION_TENANT_CONFIGURATION} must be a UUID`,
    );
  });
});
