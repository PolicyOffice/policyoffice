import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  withoutTenant,
  type Sql,
} from "@policyoffice/testing";
import {
  TENANT_TABLE_SECURITY_QUERY,
  tenantTableSecurityProblems,
  type TenantTableSecurityRow,
} from "./tenancy-schema.js";

const TENANT_A = "10000000-0000-0000-0000-000000000001";
const TENANT_B = "20000000-0000-0000-0000-000000000002";
const USER_A = "10000000-0000-0000-0001-000000000001";
const USER_B = "20000000-0000-0000-0001-000000000002";
const CREDENTIAL_A = "10000000-0000-0000-0002-000000000001";
const CREDENTIAL_B = "20000000-0000-0000-0002-000000000002";
const SESSION_A = "10000000-0000-0000-0003-000000000001";
const SESSION_B = "20000000-0000-0000-0003-000000000002";
const GROUP_A = "10000000-0000-0000-0004-000000000001";
const GROUP_B = "20000000-0000-0000-0004-000000000002";
const MEMBERSHIP_A = "10000000-0000-0000-0005-000000000001";
const MEMBERSHIP_B = "20000000-0000-0000-0005-000000000002";
const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";

const STANDARD_TENANT_TABLES = [
  "app_user",
  "group_membership",
  "user_credential",
  "user_group",
  "user_session",
] as const;
const TENANT_TABLES = [
  "app_user",
  "audit_event",
  "group_membership",
  "tenant_event_sequence",
  "user_credential",
  "user_group",
  "user_session",
] as const;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function clearTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await sql.query("delete from audit_event where tenant_id = $1", [tenantId]);
    await sql.query("delete from tenant_event_sequence where tenant_id = $1", [tenantId]);
    await sql.query("delete from group_membership where tenant_id = $1", [tenantId]);
    await sql.query("delete from user_session where tenant_id = $1", [tenantId]);
    await sql.query("delete from user_credential where tenant_id = $1", [tenantId]);
    await sql.query("delete from user_group where tenant_id = $1", [tenantId]);
    await sql.query("delete from app_user where tenant_id = $1", [tenantId]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

interface FixtureIds {
  tenantId: string;
  userId: string;
  credentialId: string;
  sessionId: string;
  groupId: string;
  membershipId: string;
  label: string;
}

async function seedTenant(sql: Sql, fixture: FixtureIds): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await sql.query(
      `insert into app_user
         (tenant_id, id, created_at, updated_at, external_identity_id, display_name,
          contact_email, status, locale, timezone)
       values ($1, $2, $3, $3, null, $4, $5, 'ACTIVE', 'en', 'Europe/Tallinn')`,
      [
        fixture.tenantId,
        fixture.userId,
        FIXED_INSTANT,
        `${fixture.label} User`,
        `${fixture.label.toLowerCase()}@example.test`,
      ],
    );
    await sql.query(
      `insert into user_credential
         (tenant_id, id, created_at, updated_at, user_id, kind, secret_hash, params)
       values ($1, $2, $3, $3, $4, 'PASSWORD', $5, '{}'::jsonb)`,
      [fixture.tenantId, fixture.credentialId, FIXED_INSTANT, fixture.userId, "fixture-hash"],
    );
    await sql.query(
      `insert into user_session
         (tenant_id, id, created_at, updated_at, user_id, token_hash, issued_at,
          idle_expires_at, absolute_expires_at, user_agent_class)
       values ($1, $2, $3, $3, $4, $5, $3, $6, $7, 'browser')`,
      [
        fixture.tenantId,
        fixture.sessionId,
        FIXED_INSTANT,
        fixture.userId,
        `${fixture.label.toLowerCase()}-token-hash`,
        "2026-01-01T01:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ],
    );
    await sql.query(
      `insert into user_group
         (tenant_id, id, created_at, updated_at, name, source, status)
       values ($1, $2, $3, $3, $4, 'LOCAL', 'ACTIVE')`,
      [fixture.tenantId, fixture.groupId, FIXED_INSTANT, `${fixture.label} Group`],
    );
    await sql.query(
      `insert into group_membership
         (tenant_id, id, created_at, updated_at, group_id, user_id, validity)
       values ($1, $2, $3, $3, $4, $5,
               tstzrange('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '[)'))`,
      [fixture.tenantId, fixture.membershipId, FIXED_INSTANT, fixture.groupId, fixture.userId],
    );
    await sql.query("insert into tenant_event_sequence (tenant_id, next_sequence) values ($1, 2)", [
      fixture.tenantId,
    ]);
    await sql.query(
      `insert into audit_event (
         tenant_id, sequence, event_type, event_schema_version, occurred_at, actor_type,
         actor_id, subject_type, subject_id, action, outcome, request_id, correlation_id,
         source_channel, configuration_version_id, dedupe_key
       ) values ($1, 1, 'user.provisioned', 1, $3, 'SYSTEM', null, 'USER', $2,
                 'PROVISION', 'SUCCESS', $2, $2, 'IMPORT', $2, $4)`,
      [fixture.tenantId, fixture.userId, FIXED_INSTANT, `user.provisioned:${fixture.userId}`],
    );
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT_A);
    await clearTenant(sql, TENANT_B);
    await sql.query("delete from tenant where id in ($1, $2)", [TENANT_A, TENANT_B]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile,
          governance_profile_code, created_at)
       values
         ($1, 'Tenant A', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU', null, $3),
         ($2, 'Tenant B', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU', null, $3)`,
      [TENANT_A, TENANT_B, FIXED_INSTANT],
    );
    await seedTenant(sql, {
      tenantId: TENANT_A,
      userId: USER_A,
      credentialId: CREDENTIAL_A,
      sessionId: SESSION_A,
      groupId: GROUP_A,
      membershipId: MEMBERSHIP_A,
      label: "A",
    });
    await seedTenant(sql, {
      tenantId: TENANT_B,
      userId: USER_B,
      credentialId: CREDENTIAL_B,
      sessionId: SESSION_B,
      groupId: GROUP_B,
      membershipId: MEMBERSHIP_B,
      label: "B",
    });
  });
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await clearTenant(sql, TENANT_A);
    await clearTenant(sql, TENANT_B);
    await sql.query("delete from tenant where id in ($1, $2)", [TENANT_A, TENANT_B]);
  });
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("the tenancy and identity schema", () => {
  it("contains exactly the modelled tables and the standard tenant-owned columns", async () => {
    const { rows: tableRows } = await withAppRole((sql) =>
      sql.query<{ table_name: string }>(`
        select relname as table_name
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and relname <> 'schema_migration'
         order by relname
      `),
    );
    expect(tableRows.map((row) => row.table_name)).toEqual([
      "app_user",
      "audit_event",
      "group_membership",
      "tenant",
      "tenant_event_sequence",
      "user_credential",
      "user_group",
      "user_session",
    ]);

    const standard = ["tenant_id", "id", "created_at", "updated_at", "row_version"];
    const { rows: columnRows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; column_name: string }>(`
        select c.relname as table_name, a.attname as column_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid
         where n.nspname = 'public'
           and c.relkind = 'r'
           and a.attnum > 0
           and not a.attisdropped
           and exists (
             select 1 from pg_attribute own
              where own.attrelid = c.oid and own.attname = 'tenant_id'
           )
         order by c.relname, a.attname
      `),
    );
    for (const table of STANDARD_TENANT_TABLES) {
      const columns = columnRows
        .filter((row) => row.table_name === table)
        .map((r) => r.column_name);
      expect(columns, table).toEqual(expect.arrayContaining(standard));
    }
  });

  it("INV-TEN-001: every application table and the migration ledger have the non-superuser owner", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; owner: string }>(`
        select c.relname as table_name, pg_get_userbyid(c.relowner) as owner
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind = 'r'
         order by c.relname
      `),
    );
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.owner !== "migration_role")).toEqual([]);
  });

  it("INV-TIME-001: authoritative instant columns are timestamptz, never timestamp", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; column_name: string }>(`
        select table_name, column_name
          from information_schema.columns
         where table_schema not in ('pg_catalog', 'information_schema')
           and data_type = 'timestamp without time zone'
      `),
    );
    expect(rows).toEqual([]);
  });

  it("INV-TEN-003: every level-1 tenant key constraint names its invariant", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string; comment: string | null }>(`
        select rel.relname as table_name,
               con.conname as constraint_name,
               obj_description(con.oid, 'pg_constraint') as comment
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public'
           and con.contype in ('p', 'f')
           and exists (
             select 1 from pg_attribute a
              where a.attrelid = rel.oid and a.attname = 'tenant_id'
           )
         order by rel.relname, con.conname
      `),
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => !row.comment?.includes("INV-TEN-003"))).toEqual([]);
  });

  it("refuses a duplicate membership for the same group, user and validity", async () => {
    try {
      await withTenant(TENANT_A, (sql) =>
        sql.query(
          `insert into group_membership
             (tenant_id, id, group_id, user_id, validity)
           values ($1, $2, $3, $4,
                   tstzrange('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '[)'))`,
          [TENANT_A, "10000000-0000-0000-0010-000000000001", GROUP_A, USER_A],
        ),
      );
      expect.unreachable("an exact duplicate membership unexpectedly succeeded");
    } catch (error) {
      expect(databaseCode(error)).toBe("23505");
    }
  });
});

describe("the tenant-isolation gate", () => {
  it("INV-TEN-001: dynamically requires enabled, forced RLS and a policy on every tenant table", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<TenantTableSecurityRow>(TENANT_TABLE_SECURITY_QUERY),
    );
    expect(rows.map((row) => row.table_name)).toEqual([...TENANT_TABLES]);
    expect(tenantTableSecurityProblems(rows)).toEqual([]);
  });

  it("INV-TEN-001: an unqualified SELECT returns only the current tenant from every table", async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await withTenant(tenantId, async (sql) => {
        for (const table of TENANT_TABLES) {
          const { rows } = await sql.query<{ count: number }>(
            `select count(*)::int as count from ${quotedIdentifier(table)}`,
          );
          expect(rows[0]?.count, `${table} for ${tenantId}`).toBe(1);
        }
      });
    }
  });

  it("INV-TEN-001: querying with no tenant context raises instead of returning rows", async () => {
    await expect(withoutTenant((sql) => sql.query("select * from app_user"))).rejects.toThrow();
  });

  it("INV-TEN-001: app_role cannot enumerate the unscoped tenant root", async () => {
    try {
      await withAppRole((sql) => sql.query("select id from tenant"));
      expect.unreachable("app_role unexpectedly read the tenant root");
    } catch (error) {
      expect(databaseCode(error)).toBe("42501");
    }
  });

  it("INV-TEN-002 / INV-TEN-005: another tenant's real id is indistinguishable from an absent id", async () => {
    const [crossTenant, absent] = await withTenant(TENANT_A, async (sql) => {
      const cross = await sql.query<{ count: number }>(
        "select count(*)::int as count from app_user where id = $1",
        [USER_B],
      );
      const missing = await sql.query<{ count: number }>(
        "select count(*)::int as count from app_user where id = $1",
        ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
      );
      return [cross, missing];
    });
    expect(crossTenant.rows).toEqual([{ count: 0 }]);
    expect(crossTenant.rows).toEqual(absent.rows);
  });

  it("INV-TEN-003: a composite foreign key refuses a parent from another tenant", async () => {
    try {
      await withTenant(TENANT_B, (sql) =>
        sql.query(
          `insert into group_membership
             (tenant_id, id, group_id, user_id, validity)
           values ($1, $2, $3, $4,
                   tstzrange('2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z', '[)'))`,
          [TENANT_B, "20000000-0000-0000-0006-000000000002", GROUP_A, USER_B],
        ),
      );
      expect.unreachable("the cross-tenant reference unexpectedly succeeded");
    } catch (error) {
      expect(databaseCode(error)).toBe("23503");
    }
  });

  it("INV-TEN-001: the RLS check refuses a write carrying another tenant_id", async () => {
    try {
      await withTenant(TENANT_A, (sql) =>
        sql.query(
          `insert into user_group (tenant_id, id, name, source, status)
           values ($1, $2, 'wrong tenant', 'LOCAL', 'ACTIVE')`,
          [TENANT_B, "10000000-0000-0000-0006-000000000001"],
        ),
      );
      expect.unreachable("the cross-tenant write unexpectedly succeeded");
    } catch (error) {
      expect(databaseCode(error)).toBe("42501");
    }
  });
});

describe("identity lifecycle and concurrency", () => {
  it("INV-AUTH-014: deactivation preserves the user and immediately deletes every session", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const { rows } = await sql.query<{
        status: string;
        deactivated_at: Date;
        row_version: number;
      }>(
        `update app_user
            set status = 'DEACTIVATED', row_version = 2
          where id = $1
        returning status, deactivated_at, row_version`,
        [USER_A],
      );
      expect(rows[0]?.status).toBe("DEACTIVATED");
      expect(rows[0]?.deactivated_at).toBeInstanceOf(Date);
      expect(rows[0]?.row_version).toBe(2);

      const sessions = await sql.query<{ count: number }>(
        "select count(*)::int as count from user_session where user_id = $1",
        [USER_A],
      );
      const users = await sql.query<{ count: number }>(
        "select count(*)::int as count from app_user where id = $1",
        [USER_A],
      );
      expect(sessions.rows[0]?.count).toBe(0);
      expect(users.rows[0]?.count).toBe(1);
    });
  });

  it("INV-AUTH-014: app_role may delete a session but cannot delete its user", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const deleted = await sql.query("delete from user_session where id = $1 returning id", [
        SESSION_A,
      ]);
      expect(deleted.rowCount).toBe(1);
    });

    try {
      await withTenant(TENANT_A, (sql) =>
        sql.query("delete from app_user where id = $1", [USER_A]),
      );
      expect.unreachable("app_role unexpectedly deleted a historical principal");
    } catch (error) {
      expect(databaseCode(error)).toBe("42501");
    }
  });

  it("INV-TIME-003: every tenant table carries the stale-write trigger", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string }>(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_trigger t on t.tgrelid = c.oid
         where n.nspname = 'public'
           and t.tgname = 'enforce_row_version'
           and not t.tgisinternal
         order by c.relname
      `),
    );
    expect(rows.map((row) => row.table_name)).toEqual([...STANDARD_TENANT_TABLES]);
  });

  it("INV-TIME-003: a stale row_version conflicts rather than overwriting", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query("update user_group set name = 'first write', row_version = 2 where id = $1", [
        GROUP_A,
      ]);
      try {
        await sql.query(
          "update user_group set name = 'stale write', row_version = 2 where id = $1",
          [GROUP_A],
        );
        expect.unreachable("a stale update unexpectedly overwrote the first write");
      } catch (error) {
        expect(databaseCode(error)).toBe("40001");
      }
    });
  });

  it("INV-TIME-005: membership intervals reject closed bounds and accept abutting half-open bounds", async () => {
    try {
      await withTenant(TENANT_A, (sql) =>
        sql.query(
          `insert into group_membership
             (tenant_id, id, group_id, user_id, validity)
           values ($1, $2, $3, $4,
                   tstzrange('2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z', '[]'))`,
          [TENANT_A, "10000000-0000-0000-0007-000000000001", GROUP_A, USER_A],
        ),
      );
      expect.unreachable("a closed membership interval unexpectedly succeeded");
    } catch (error) {
      expect(databaseCode(error)).toBe("23514");
    }

    await withTenant(TENANT_A, async (sql) => {
      const first = await sql.query(
        `insert into group_membership
           (tenant_id, id, group_id, user_id, validity)
         values ($1, $2, $3, $4,
                 tstzrange('2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z', '[)'))`,
        [TENANT_A, "10000000-0000-0000-0008-000000000001", GROUP_A, USER_A],
      );
      const second = await sql.query(
        `insert into group_membership
           (tenant_id, id, group_id, user_id, validity)
         values ($1, $2, $3, $4,
                 tstzrange('2028-01-01T00:00:00Z', '2029-01-01T00:00:00Z', '[)'))`,
        [TENANT_A, "10000000-0000-0000-0009-000000000001", GROUP_A, USER_A],
      );
      expect(first.rowCount).toBe(1);
      expect(second.rowCount).toBe(1);
    });
  });
});
