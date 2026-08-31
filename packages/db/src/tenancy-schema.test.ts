import { describe, expect, it } from "vitest";
import {
  TENANT_TABLE_SECURITY_QUERY,
  tenantTableSecurityProblems,
  type TenantTableSecurityRow,
} from "./tenancy-schema.js";

const row = (
  table_name: string,
  overrides: Partial<TenantTableSecurityRow> = {},
): TenantTableSecurityRow => ({
  schema_name: "public",
  table_name,
  rls_enabled: true,
  rls_forced: true,
  has_tenant_policy: true,
  ...overrides,
});

describe("tenant table schema introspection", () => {
  it("discovers tables by the presence of tenant_id rather than a hard-coded list", () => {
    expect(TENANT_TABLE_SECURITY_QUERY).toContain("a.attname = 'tenant_id'");
    expect(TENANT_TABLE_SECURITY_QUERY).not.toMatch(/app_user|user_session|user_group/);
  });

  it("reports each missing RLS mechanism on any newly discovered table", () => {
    expect(
      tenantTableSecurityProblems([
        row("secure"),
        row("new_without_security", {
          rls_enabled: false,
          rls_forced: false,
          has_tenant_policy: false,
        }),
      ]),
    ).toEqual([
      {
        table: "public.new_without_security",
        missing: ["RLS enabled", "RLS forced", "tenant policy"],
      },
    ]);
  });

  it("accepts a discovered table only when RLS is enabled, forced and has the policy", () => {
    expect(tenantTableSecurityProblems([row("future_tenant_table")])).toEqual([]);
  });
});
