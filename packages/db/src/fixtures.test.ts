import { describe, expect, it } from "vitest";
import { buildFixtureSet, REFERENCE_ENUM_VALUES } from "./fixtures.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("deterministic fixtures", () => {
  it("INV-TIME-001: produces the same fixed identifiers and UTC instants on every build", () => {
    const first = buildFixtureSet("test");
    const second = buildFixtureSet("test");
    expect(second).toEqual(first);
    expect(first.createdAt).toMatch(INSTANT);

    for (const tenant of first.tenants) {
      expect(tenant.tenant.id).toMatch(UUID);
      expect(tenant.configuration.id).toMatch(UUID);
      expect(tenant.configuration.requestId).toMatch(UUID);
      expect(tenant.configuration.correlationId).toMatch(UUID);
      for (const membership of [...tenant.groupMemberships, ...tenant.orgMemberships]) {
        expect(membership.validFrom).toMatch(INSTANT);
        if (membership.validUntil !== null) expect(membership.validUntil).toMatch(INSTANT);
      }
    }
    expect(JSON.stringify(first)).not.toMatch(/random\(|now\(/i);
  });

  it("INV-CFG-002: copies profile values into each tenant without a live profile link", () => {
    const [alpha, beta] = buildFixtureSet("test").tenants;
    expect(alpha?.tenant.governanceProfileCode).toBe("ESSENTIAL");
    expect(beta?.tenant.governanceProfileCode).toBe("ESSENTIAL");
    expect(alpha?.documentTypes[0]).toEqual({
      ...beta?.documentTypes[0],
      id: alpha?.documentTypes[0]?.id,
    });
    expect(alpha?.documentTypes[0]?.id).not.toBe(beta?.documentTypes[0]?.id);
    expect(alpha?.classifications[0]?.id).not.toBe(beta?.classifications[0]?.id);
    expect(JSON.stringify([alpha, beta])).not.toMatch(/profile(Id|VersionId)/);
  });

  it("INV-ORG-002: carries both closed and open dated organisation memberships", () => {
    for (const tenant of buildFixtureSet("test").tenants) {
      expect(tenant.orgMemberships.some((membership) => membership.validUntil !== null)).toBe(true);
      expect(tenant.orgMemberships.some((membership) => membership.validUntil === null)).toBe(true);
    }
  });

  it("keeps development data distinct and creates exactly one legal entity", () => {
    const development = buildFixtureSet("development");
    expect(development.tenants).toHaveLength(1);
    expect(development.tenants[0]?.legalEntity).toBeDefined();
    expect(development.tenants[0]?.users.length).toBeGreaterThanOrEqual(3);
    expect(development.tenants[0]?.groups.length).toBeGreaterThanOrEqual(2);
  });

  it("records product-owned reference values as migration-owned enums", () => {
    expect(REFERENCE_ENUM_VALUES.tenant_status).toEqual(["ACTIVE", "SUSPENDED", "CLOSED"]);
    expect(REFERENCE_ENUM_VALUES.information_classification_status).toEqual(["ACTIVE", "RETIRED"]);
  });
});
