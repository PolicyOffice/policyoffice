import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAppRole, withTenant, type Sql } from "@policyoffice/testing";
import {
  AUTHORIZATION_SCOPE_TYPES,
  GRANT_EFFECTS,
  type AuthorizationCapability,
  type AuthorizationScopeType,
  type GrantEffect,
} from "./authorization-reference.js";
import {
  CONSTRAINT_COMMENT_QUERY,
  constraintCommentProblems,
  type ConstraintCommentRow,
} from "./constraint-comments.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";
import {
  parseAuthorizationModel,
  systemRoleProblems,
  type AuthorizationRoleDefinition,
} from "../../../tooling/authorization-role-catalogue.js";

const fixture = buildFixtureSet("test");
const TENANT_A = fixture.tenants[0]?.tenant.id ?? "";
const TENANT_B = fixture.tenants[1]?.tenant.id ?? "";
const USER_A = fixture.tenants[0]?.users[0]?.id ?? "";
const USER_B = fixture.tenants[1]?.users[0]?.id ?? "";
const GRANT_A = fixture.tenants[0]?.accessGrant.id ?? "";
const GRANT_B = fixture.tenants[1]?.accessGrant.id ?? "";
const ROLE_A =
  fixture.tenants[0]?.securityRoles.find((role) => role.code === "TENANT_ADMIN")?.id ?? "";
const ROLE_B =
  fixture.tenants[1]?.securityRoles.find((role) => role.code === "TENANT_ADMIN")?.id ?? "";
const DOCUMENTED_AUTHORIZATION = parseAuthorizationModel(
  readFileSync(
    fileURLToPath(new URL("../../../docs/domain/authorization-model.md", import.meta.url)),
    "utf8",
  ),
);

interface GrantInput {
  id: string;
  effect?: GrantEffect;
  securityRoleId?: string | null;
  capability?: AuthorizationCapability | null;
  scopeType?: AuthorizationScopeType;
  scopeId?: string | null;
  validUntil?: string | null;
  grantedBy?: string;
  reason?: string | null;
}

async function insertGrant(sql: Sql, input: GrantInput): Promise<void> {
  await sql.query(
    `insert into access_grant (
       tenant_id, id, created_at, updated_at, row_version, effect,
       principal_type, principal_id, security_role_id, capability,
       scope_type, scope_id, validity, granted_by, reason
     ) values (
       $1, $2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, $3,
       'USER', $4, $5, $6, $7, $8,
       tstzrange('2026-01-01T00:00:00Z', $9::timestamptz, '[)'), $10, $11
     )`,
    [
      TENANT_A,
      input.id,
      input.effect ?? "ALLOW",
      USER_A,
      input.securityRoleId === undefined ? ROLE_A : input.securityRoleId,
      input.capability ?? null,
      input.scopeType ?? "TENANT",
      input.scopeId ?? null,
      input.validUntil ?? null,
      input.grantedBy ?? USER_A,
      input.reason ?? null,
    ],
  );
}

async function expectConstraint(input: GrantInput, constraint: string): Promise<void> {
  await expect(withTenant(TENANT_A, (sql) => insertGrant(sql, input))).rejects.toMatchObject({
    code: "23514",
    constraint,
  });
}

async function enumValues(name: string): Promise<string[]> {
  const { rows } = await withAppRole((sql) =>
    sql.query<{ value: string }>(
      `select enum.enumlabel::text as value
         from pg_type typ
         join pg_enum enum on enum.enumtypid = typ.oid
         join pg_namespace n on n.oid = typ.typnamespace
        where n.nspname = 'public' and typ.typname = $1
        order by enum.enumsortorder`,
      [name],
    ),
  );
  return rows.map((row) => row.value);
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("authorization grant storage", () => {
  it("INV-AUTH-015 / INV-AUTH-016: installs the exact closed capability and scope enums", async () => {
    const capabilities = await enumValues("capability");
    const scopes = await enumValues("scope_type");

    expect(capabilities).toHaveLength(30);
    expect(capabilities).toEqual(DOCUMENTED_AUTHORIZATION.capabilities);
    expect(scopes).toEqual([...AUTHORIZATION_SCOPE_TYPES]);
    expect(scopes).not.toContain("SPACE");
    expect(await enumValues("grant_effect")).toEqual([...GRANT_EFFECTS]);
  });

  it("INV-AUTH-017 / INV-AUTH-019: keeps authorization storage separate from applicability, Space, and classification", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; columns: string[] }>(`
        select table_name, array_agg(column_name order by ordinal_position)::text[] as columns
          from information_schema.columns
         where table_schema = 'public'
           and table_name in ('security_role', 'access_grant')
         group by table_name
         order by table_name
      `),
    );

    expect(rows).toEqual([
      {
        table_name: "access_grant",
        columns: [
          "tenant_id",
          "id",
          "created_at",
          "updated_at",
          "row_version",
          "effect",
          "principal_type",
          "principal_id",
          "security_role_id",
          "capability",
          "scope_type",
          "scope_id",
          "validity",
          "granted_by",
          "reason",
        ],
      },
      {
        table_name: "security_role",
        columns: [
          "tenant_id",
          "id",
          "created_at",
          "updated_at",
          "row_version",
          "code",
          "name",
          "capabilities",
          "is_system",
        ],
      },
    ]);

    const metadata = await withAppRole((sql) =>
      sql.query<{
        scope_comment: string | null;
        scope_foreign_keys: number;
        trigger_names: string[];
      }>(`
        select col_description('access_grant'::regclass, att.attnum) as scope_comment,
               (
                 select count(*)::int
                   from pg_constraint con
                  where con.conrelid = 'access_grant'::regclass
                    and con.contype = 'f'
                    and att.attnum = any(con.conkey)
               ) as scope_foreign_keys,
               array(
                 select trigger.tgname
                   from pg_trigger trigger
                  where trigger.tgrelid = 'access_grant'::regclass
                    and not trigger.tgisinternal
                  order by trigger.tgname
               )::text[] as trigger_names
          from pg_attribute att
         where att.attrelid = 'access_grant'::regclass
           and att.attname = 'scope_id'
      `),
    );
    expect(metadata.rows).toEqual([
      {
        scope_comment: expect.stringMatching(/dangling scope fails closed.*scheduled consistency/s),
        scope_foreign_keys: 0,
        trigger_names: ["enforce_row_version"],
      },
    ]);
  });

  it("refuses a grant carrying both a role and capability, or neither", async () => {
    await expectConstraint(
      {
        id: "95000000-0000-0000-0001-000000000001",
        capability: "document.read",
      },
      "access_grant_role_or_capability",
    );
    await expectConstraint(
      {
        id: "95000000-0000-0000-0001-000000000002",
        securityRoleId: null,
      },
      "access_grant_role_or_capability",
    );
  });

  it("refuses a reasonless DENY and a reasonless time-bounded grant", async () => {
    await expectConstraint(
      { id: "95000000-0000-0000-0002-000000000001", effect: "DENY" },
      "access_grant_deny_reason_required",
    );
    await expectConstraint(
      {
        id: "95000000-0000-0000-0002-000000000002",
        validUntil: "2026-02-01T00:00:00Z",
      },
      "access_grant_bounded_reason_required",
    );
  });

  it("refuses a tenant scope with an id and a resource scope without one", async () => {
    await expectConstraint(
      {
        id: "95000000-0000-0000-0003-000000000001",
        scopeId: "95000000-0000-0000-0099-000000000001",
      },
      "access_grant_scope_id_consistent",
    );
    await expectConstraint(
      {
        id: "95000000-0000-0000-0003-000000000002",
        scopeType: "DOCUMENT",
      },
      "access_grant_scope_id_consistent",
    );
  });

  it("INV-AUTH-016: seeds all nine documented system role bundles for every tenant", async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const { rows } = await withTenant(tenantId, (sql) =>
        sql.query<{
          code: string;
          name: string;
          capabilities: string[];
          is_system: boolean;
        }>(`
          select code, name, capabilities::text[] as capabilities, is_system
            from security_role
           order by code
        `),
      );
      const roles: AuthorizationRoleDefinition[] = rows.map((row) => ({
        code: row.code,
        name: row.name,
        capabilities: row.capabilities,
        isSystem: row.is_system,
      }));
      expect(rows).toHaveLength(9);
      expect(systemRoleProblems(DOCUMENTED_AUTHORIZATION.roles, roles)).toEqual([]);
    }
  });

  it("grants app_role read and write without destructive access-grant privileges", async () => {
    const privileges = await withAppRole((sql) =>
      sql.query<{
        role_read: boolean;
        role_insert: boolean;
        role_update: boolean;
        grant_read: boolean;
        grant_insert: boolean;
        grant_update: boolean;
        grant_delete: boolean;
        grant_truncate: boolean;
      }>(`
        select has_table_privilege(current_user, 'security_role', 'select') as role_read,
               has_table_privilege(current_user, 'security_role', 'insert') as role_insert,
               has_table_privilege(current_user, 'security_role', 'update') as role_update,
               has_table_privilege(current_user, 'access_grant', 'select') as grant_read,
               has_table_privilege(current_user, 'access_grant', 'insert') as grant_insert,
               has_table_privilege(current_user, 'access_grant', 'update') as grant_update,
               has_table_privilege(current_user, 'access_grant', 'delete') as grant_delete,
               has_table_privilege(current_user, 'access_grant', 'truncate') as grant_truncate
      `),
    );
    expect(privileges.rows).toEqual([
      {
        role_read: true,
        role_insert: true,
        role_update: true,
        grant_read: true,
        grant_insert: true,
        grant_update: true,
        grant_delete: false,
        grant_truncate: false,
      },
    ]);

    await expect(
      withTenant(TENANT_A, (sql) => sql.query("delete from access_grant where id = $1", [GRANT_A])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(withAppRole((sql) => sql.query("truncate access_grant"))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("INV-TEN-001 / INV-TEN-003: forces tenant isolation under migration_role ownership", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        owner: string;
        policy_count: number;
      }>(`
        select rel.relname as table_name,
               rel.relrowsecurity as rls_enabled,
               rel.relforcerowsecurity as rls_forced,
               pg_get_userbyid(rel.relowner) as owner,
               count(policy.oid)::int as policy_count
          from pg_class rel
          join pg_namespace n on n.oid = rel.relnamespace
          left join pg_policy policy on policy.polrelid = rel.oid
         where n.nspname = 'public'
           and rel.relname in ('security_role', 'access_grant')
         group by rel.oid, rel.relname
         order by rel.relname
      `),
    );
    expect(rows).toEqual([
      {
        table_name: "access_grant",
        rls_enabled: true,
        rls_forced: true,
        owner: "migration_role",
        policy_count: 1,
      },
      {
        table_name: "security_role",
        rls_enabled: true,
        rls_forced: true,
        owner: "migration_role",
        policy_count: 1,
      },
    ]);

    const visible = await withTenant(TENANT_A, async (sql) => {
      const crossTenant = await sql.query("select id from access_grant where id = $1", [GRANT_B]);
      const absent = await sql.query("select id from access_grant where id = $1", [
        "95000000-0000-0000-0099-000000000099",
      ]);
      return [crossTenant.rows, absent.rows];
    });
    expect(visible).toEqual([[], []]);

    await expect(
      withTenant(TENANT_A, (sql) =>
        insertGrant(sql, {
          id: "95000000-0000-0000-0004-000000000001",
          securityRoleId: ROLE_B,
        }),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "access_grant_security_role_fk" });
    await expect(
      withTenant(TENANT_A, (sql) =>
        insertGrant(sql, {
          id: "95000000-0000-0000-0004-000000000002",
          grantedBy: USER_B,
        }),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "access_grant_granted_by_fk" });
  });

  it("INV-TEN-003: documents authorization constraints without inventing invariant coverage", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<ConstraintCommentRow>(CONSTRAINT_COMMENT_QUERY),
    );
    const authorizationRows = rows.filter((row) =>
      ["security_role", "access_grant"].includes(row.table_name),
    );

    expect(authorizationRows).toHaveLength(13);
    expect(constraintCommentProblems(authorizationRows)).toEqual([]);
  });
});
