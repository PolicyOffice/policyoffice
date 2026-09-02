import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "81000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "82000000-0000-0000-0000-000000000002";
const USER = "81000000-0000-0000-0001-000000000001";
const ROOT_ENTITY = "81000000-0000-0000-0002-000000000001";
const OTHER_ENTITY = "82000000-0000-0000-0002-000000000002";
const ROOT_UNIT = "81000000-0000-0000-0003-000000000001";
const LITHUANIA = "81000000-0000-0000-0004-000000000001";
const FINLAND = "81000000-0000-0000-0004-000000000002";
const OTHER_JURISDICTION = "82000000-0000-0000-0004-000000000002";

const ORGANIZATION_TABLES = [
  "body_membership",
  "governance_body",
  "jurisdiction",
  "legal_entity",
  "org_membership",
  "org_unit",
  "space",
] as const;

async function inCommittedTenant<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withAppRole(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(sql);
      await sql.query("commit");
      return result;
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

async function clearTenant(sql: Sql, tenantId: string): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await sql.query("delete from body_membership where tenant_id = $1", [tenantId]);
    await sql.query("delete from governance_body where tenant_id = $1", [tenantId]);
    await sql.query("delete from space where tenant_id = $1", [tenantId]);
    await sql.query("delete from org_membership where tenant_id = $1", [tenantId]);
    await sql.query("delete from org_unit where tenant_id = $1", [tenantId]);
    await sql.query("delete from jurisdiction where tenant_id = $1", [tenantId]);
    await sql.query("delete from legal_entity where tenant_id = $1", [tenantId]);
    await sql.query("delete from app_user where tenant_id = $1", [tenantId]);
    await sql.query("delete from audit_event where tenant_id = $1", [tenantId]);
    await sql.query("delete from tenant_event_sequence where tenant_id = $1", [tenantId]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values
         ($1, 'Organisation tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other organisation tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );

    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await sql.query(
        `insert into app_user (tenant_id, id, display_name, contact_email, status)
         values ($1, $2, 'Organisation user', 'organisation@example.test', 'ACTIVE')`,
        [TENANT, USER],
      );
      await sql.query(
        `insert into legal_entity
           (tenant_id, id, legal_name, country_of_registration, status)
         values ($1, $2, 'Root OÜ', 'LT', 'ACTIVE')`,
        [TENANT, ROOT_ENTITY],
      );
      await sql.query(
        `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
         values ($1, $2, 'Root unit', 'ROOT', $3, 'ACTIVE')`,
        [TENANT, ROOT_UNIT, ROOT_ENTITY],
      );
      await sql.query(
        `insert into jurisdiction (tenant_id, id, code, name, level, status)
         values
           ($1, $2, 'LT', 'Lithuania', 'NATIONAL', 'ACTIVE'),
           ($1, $3, 'FI', 'Finland', 'NATIONAL', 'ACTIVE')`,
        [TENANT, LITHUANIA, FINLAND],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }

    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [OTHER_TENANT]);
      await sql.query(
        `insert into legal_entity (tenant_id, id, legal_name, status)
         values ($1, $2, 'Other entity', 'ACTIVE')`,
        [OTHER_TENANT, OTHER_ENTITY],
      );
      await sql.query(
        `insert into jurisdiction (tenant_id, id, code, name, level, status)
         values ($1, $2, 'SE', 'Sweden', 'NATIONAL', 'ACTIVE')`,
        [OTHER_TENANT, OTHER_JURISDICTION],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of [TENANT, OTHER_TENANT]) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
  });
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("the organization schema", () => {
  it("contains every organization table with standard columns and forced tenant isolation", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(
        `
        select c.relname as table_name,
               array_agg(a.attname::text order by a.attname) filter (where a.attnum > 0) as columns,
               c.relrowsecurity as row_security,
               c.relforcerowsecurity as force_row_security,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
         where n.nspname = 'public'
           and c.relname = any($1::text[])
         group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
         order by c.relname
      `,
        [[...ORGANIZATION_TABLES]],
      ),
    );

    expect(rows.map((row) => row.table_name)).toEqual([...ORGANIZATION_TABLES]);
    for (const row of rows) {
      expect(row.columns, row.table_name).toEqual(
        expect.arrayContaining(["tenant_id", "id", "created_at", "updated_at", "row_version"]),
      );
      expect(row.row_security, row.table_name).toBe(true);
      expect(row.force_row_security, row.table_name).toBe(true);
      expect(row.policy_count, row.table_name).toBe(1);
    }
  });

  it("names every organization constraint with its enforcing invariant", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string; comment: string | null }>(
        `
        select rel.relname as table_name,
               con.conname as constraint_name,
               obj_description(con.oid, 'pg_constraint') as comment
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public'
           and rel.relname = any($1::text[])
           and con.contype in ('p', 'f', 'u', 'c', 'x')
         order by rel.relname, con.conname
      `,
        [[...ORGANIZATION_TABLES]],
      ),
    );
    expect(rows.length).toBeGreaterThan(35);
    expect(rows.filter((row) => !row.comment?.includes("INV-"))).toEqual([]);
  });

  it("uses tenant-qualified RESTRICT for every organization foreign key", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string }>(
        `
        select rel.relname as table_name, con.conname as constraint_name
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public'
           and rel.relname = any($1::text[])
           and con.contype = 'f'
           and (
             con.confdeltype <> 'r'
             or not exists (
               select 1
                 from unnest(con.conkey) as key(attnum)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = key.attnum
                where a.attname = 'tenant_id'
             )
           )
      `,
        [[...ORGANIZATION_TABLES]],
      ),
    );
    expect(rows).toEqual([]);
  });

  it("names every organization level-2 trigger with its enforcing invariant", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; trigger_name: string; comment: string | null }>(`
        select c.relname as table_name,
               t.tgname as trigger_name,
               obj_description(t.oid, 'pg_trigger') as comment
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and t.tgname in (
             'legal_entity_acyclic',
             'org_unit_acyclic',
             'enforce_org_membership_jurisdictions',
             'protect_org_membership_history'
           )
         order by c.relname, t.tgname
      `),
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => !row.comment?.includes("INV-"))).toEqual([]);
  });
});

describe("acyclic organization hierarchies", () => {
  it.each([
    [
      "legal entity",
      `insert into legal_entity
         (tenant_id, id, legal_name, registration_number, parent_legal_entity_id, status)
       values ($1, $2, 'Self parent', $3, $2, 'ACTIVE')`,
      "81000000-0000-0000-0010-000000000001",
    ],
    [
      "org unit",
      `insert into org_unit
         (tenant_id, id, name, legal_entity_id, parent_org_unit_id, status)
       values ($1, $2, 'Self parent', $3, $2, 'ACTIVE')`,
      "81000000-0000-0000-0010-000000000002",
    ],
  ])("INV-ORG-001: refuses a self-parenting %s on insert", async (_label, statement, id) => {
    await expect(
      withTenant(TENANT, (sql) => sql.query(statement, [TENANT, id, ROOT_ENTITY])),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("INV-ORG-001: refuses a two-node legal-entity cycle introduced by update", async () => {
    await expect(
      withTenant(TENANT, async (sql) => {
        const first = "81000000-0000-0000-0011-000000000001";
        const second = "81000000-0000-0000-0011-000000000002";
        await sql.query(
          `insert into legal_entity (tenant_id, id, legal_name, status)
           values ($1, $2, 'First', 'ACTIVE')`,
          [TENANT, first],
        );
        await sql.query(
          `insert into legal_entity
             (tenant_id, id, legal_name, parent_legal_entity_id, status)
           values ($1, $2, 'Second', $3, 'ACTIVE')`,
          [TENANT, second, first],
        );
        await sql.query(
          `update legal_entity
              set parent_legal_entity_id = $2, row_version = 2
            where id = $1`,
          [first, second],
        );
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "legal_entity_acyclic" });
  });

  it("INV-ORG-001: refuses a three-node org-unit cycle introduced by update", async () => {
    await expect(
      withTenant(TENANT, async (sql) => {
        const first = "81000000-0000-0000-0012-000000000001";
        const second = "81000000-0000-0000-0012-000000000002";
        const third = "81000000-0000-0000-0012-000000000003";
        await sql.query(
          `insert into org_unit (tenant_id, id, name, legal_entity_id, status)
           values ($1, $2, 'First', $3, 'ACTIVE')`,
          [TENANT, first, ROOT_ENTITY],
        );
        await sql.query(
          `insert into org_unit
             (tenant_id, id, name, legal_entity_id, parent_org_unit_id, status)
           values
             ($1, $2, 'Second', $4, $5, 'ACTIVE'),
             ($1, $3, 'Third', $4, $2, 'ACTIVE')`,
          [TENANT, second, third, ROOT_ENTITY, first],
        );
        await sql.query(
          `update org_unit set parent_org_unit_id = $2, row_version = 2 where id = $1`,
          [first, third],
        );
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "org_unit_acyclic" });
  });

  it("INV-ORG-001: concurrent legal-entity parent changes cannot commit a cycle", async () => {
    const first = "81000000-0000-0000-0019-000000000001";
    const second = "81000000-0000-0000-0019-000000000002";
    await inCommittedTenant(TENANT, (sql) =>
      sql.query(
        `insert into legal_entity (tenant_id, id, legal_name, status)
         values ($1, $2, 'Concurrent first', 'ACTIVE'),
                ($1, $3, 'Concurrent second', 'ACTIVE')`,
        [TENANT, first, second],
      ),
    );

    try {
      await withAppRole((firstSql) =>
        withAppRole(async (secondSql) => {
          await firstSql.query("begin");
          await secondSql.query("begin");
          let firstCommitted = false;
          try {
            await firstSql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
            await secondSql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
            await firstSql.query(
              `update legal_entity
                  set parent_legal_entity_id = $2, row_version = 2
                where id = $1`,
              [first, second],
            );
            const secondUpdate = secondSql
              .query(
                `update legal_entity
                    set parent_legal_entity_id = $2, row_version = 2
                  where id = $1`,
                [second, first],
              )
              .then(
                () => undefined,
                (error: unknown) => error,
              );
            await new Promise<void>((resolve) => setImmediate(resolve));
            await firstSql.query("commit");
            firstCommitted = true;
            expect(await secondUpdate).toMatchObject({
              code: "23514",
              constraint: "legal_entity_acyclic",
            });
          } finally {
            if (!firstCommitted) await firstSql.query("rollback");
            await secondSql.query("rollback");
          }
        }),
      );
    } finally {
      await inCommittedTenant(TENANT, async (sql) => {
        await sql.query(
          `update legal_entity
              set parent_legal_entity_id = null, row_version = row_version + 1
            where id = $1 and parent_legal_entity_id is not null`,
          [first],
        );
        await sql.query("delete from legal_entity where id = any($1::uuid[])", [[first, second]]);
      });
    }
  });
});

describe("tenant-contained organization references", () => {
  it("INV-TEN-003 / INV-ORG-001: refuses a legal-entity parent from another tenant", async () => {
    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          `insert into legal_entity
             (tenant_id, id, legal_name, parent_legal_entity_id, status)
           values ($1, $2, 'Cross tenant child', $3, 'ACTIVE')`,
          [TENANT, "81000000-0000-0000-0013-000000000001", OTHER_ENTITY],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "legal_entity_parent_fk" });
  });

  it("INV-TEN-003 / INV-ORG-004: refuses an explicit jurisdiction from another tenant", async () => {
    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          `insert into org_membership
             (tenant_id, user_id, legal_entity_id, org_unit_id, validity, jurisdiction_ids)
           values ($1, $2, $3, $4, tstzrange('2026-01-01', null, '[)'), array[$5]::uuid[])`,
          [TENANT, USER, ROOT_ENTITY, ROOT_UNIT, OTHER_JURISDICTION],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "org_membership_jurisdiction_tenant_fk",
    });
  });

  it("INV-TEN-002 / INV-TEN-005: a cross-tenant organization id behaves as absent", async () => {
    const [crossTenant, absent] = await withTenant(TENANT, async (sql) => {
      const cross = await sql.query<{ count: number }>(
        "select count(*)::int as count from legal_entity where id = $1",
        [OTHER_ENTITY],
      );
      const missing = await sql.query<{ count: number }>(
        "select count(*)::int as count from legal_entity where id = $1",
        ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
      );
      return [cross, missing];
    });
    expect(crossTenant.rows).toEqual([{ count: 0 }]);
    expect(crossTenant.rows).toEqual(absent.rows);
  });
});

describe("organization history", () => {
  it("INV-ORG-003: refuses deletion while referenced and closes the legal entity in place", async () => {
    await withTenant(TENANT, async (sql) => {
      await sql.query("savepoint before_delete");
      try {
        await sql.query("delete from legal_entity where id = $1", [ROOT_ENTITY]);
        expect.unreachable("a referenced legal entity unexpectedly deleted");
      } catch (error) {
        expect(error).toMatchObject({ code: "23001" });
        await sql.query("rollback to savepoint before_delete");
      }

      const { rows } = await sql.query<{ status: string; closed_at: Date; row_version: number }>(
        `update legal_entity
            set status = 'CLOSED', closed_at = '2027-01-01T00:00:00Z', row_version = 2
          where id = $1
        returning status, closed_at, row_version`,
        [ROOT_ENTITY],
      );
      expect(rows[0]?.status).toBe("CLOSED");
      expect(rows[0]?.closed_at).toBeInstanceOf(Date);
      expect(rows[0]?.row_version).toBe(2);
    });
  });

  it("INV-ORG-002: ends and appends a correction while preserving both readable facts", async () => {
    await withTenant(TENANT, async (sql) => {
      const first = "81000000-0000-0000-0014-000000000001";
      const correction = "81000000-0000-0000-0014-000000000002";
      await sql.query(
        `insert into org_membership
           (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity, is_primary)
         values ($1, $2, $3, $4, $5, tstzrange('2026-01-01', null, '[)'), true)`,
        [TENANT, first, USER, ROOT_ENTITY, ROOT_UNIT],
      );
      await sql.query(
        `update org_membership
            set validity = tstzrange('2026-01-01', '2027-01-01', '[)'), row_version = 2
          where id = $1`,
        [first],
      );
      await sql.query(
        `insert into org_membership
           (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity, is_primary)
         values ($1, $2, $3, $4, $5, tstzrange('2027-01-01', null, '[)'), false)`,
        [TENANT, correction, USER, ROOT_ENTITY, ROOT_UNIT],
      );

      const history = await sql.query<{ id: string; validity: string }>(
        "select id, validity::text from org_membership where id = any($1::uuid[]) order by id",
        [[first, correction]],
      );
      expect(history.rows).toHaveLength(2);

      await sql.query("savepoint before_rewrite");
      try {
        await sql.query(
          "update org_membership set is_primary = false, row_version = 3 where id = $1",
          [first],
        );
        expect.unreachable("an ended membership unexpectedly changed");
      } catch (error) {
        expect(error).toMatchObject({ code: "55000" });
        await sql.query("rollback to savepoint before_rewrite");
      }
    });
  });

  it("INV-ORG-002: app_role cannot delete an ended membership", async () => {
    await expect(
      withTenant(TENANT, async (sql) => {
        const ended = "81000000-0000-0000-0014-000000000003";
        await sql.query(
          `insert into org_membership
             (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity)
           values ($1, $2, $3, $4, $5, tstzrange('2025-01-01', '2026-01-01', '[)'))`,
          [TENANT, ended, USER, ROOT_ENTITY, ROOT_UNIT],
        );
        await sql.query("delete from org_membership where id = $1", [ended]);
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-ORG-002 / INV-TIME-005: rejects overlap and counts an abutting boundary once", async () => {
    await withTenant(TENANT, async (sql) => {
      const first = "81000000-0000-0000-0015-000000000001";
      const overlapping = "81000000-0000-0000-0015-000000000002";
      const abutting = "81000000-0000-0000-0015-000000000003";
      await sql.query(
        `insert into org_membership
           (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity)
         values ($1, $2, $3, $4, $5, tstzrange('2026-01-01', '2027-01-01', '[)'))`,
        [TENANT, first, USER, ROOT_ENTITY, ROOT_UNIT],
      );

      await sql.query("savepoint before_overlap");
      try {
        await sql.query(
          `insert into org_membership
             (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity)
           values ($1, $2, $3, $4, $5, tstzrange('2026-06-01', '2027-06-01', '[)'))`,
          [TENANT, overlapping, USER, ROOT_ENTITY, ROOT_UNIT],
        );
        expect.unreachable("overlapping membership intervals unexpectedly succeeded");
      } catch (error) {
        expect(error).toMatchObject({ code: "23P01", constraint: "org_membership_no_overlap" });
        await sql.query("rollback to savepoint before_overlap");
      }

      await sql.query(
        `insert into org_membership
           (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity)
         values ($1, $2, $3, $4, $5, tstzrange('2027-01-01', '2028-01-01', '[)'))`,
        [TENANT, abutting, USER, ROOT_ENTITY, ROOT_UNIT],
      );
      const { rows } = await sql.query<{ count: number }>(
        `select count(*)::int as count
           from org_membership
          where user_id = $1
            and legal_entity_id = $2
            and org_unit_id = $3
            and validity @> '2027-01-01T00:00:00Z'::timestamptz`,
        [USER, ROOT_ENTITY, ROOT_UNIT],
      );
      expect(rows).toEqual([{ count: 1 }]);
    });
  });

  it("INV-ORG-004: keeps registration country and explicit jurisdiction independent", async () => {
    await withTenant(TENANT, async (sql) => {
      const membership = "81000000-0000-0000-0016-000000000001";
      await sql.query(
        `insert into org_membership
           (tenant_id, id, user_id, legal_entity_id, org_unit_id, validity, jurisdiction_ids)
         values ($1, $2, $3, $4, $5, tstzrange('2026-01-01', null, '[)'), array[$6]::uuid[])`,
        [TENANT, membership, USER, ROOT_ENTITY, ROOT_UNIT, FINLAND],
      );
      const { rows } = await sql.query<{
        country_of_registration: string;
        jurisdiction_code: string;
      }>(
        `select le.country_of_registration, j.code as jurisdiction_code
           from org_membership om
           join legal_entity le on le.tenant_id = om.tenant_id and le.id = om.legal_entity_id
           join jurisdiction j
             on j.tenant_id = om.tenant_id and j.id = any(om.jurisdiction_ids)
          where om.id = $1`,
        [membership],
      );
      expect(rows).toEqual([{ country_of_registration: "LT", jurisdiction_code: "FI" }]);
    });
  });

  it("INV-ORG-005: a body requires one legal entity and dissolution preserves it", async () => {
    await withTenant(TENANT, async (sql) => {
      const body = "81000000-0000-0000-0017-000000000001";
      await sql.query(
        `insert into governance_body
           (tenant_id, id, code, name, legal_entity_id, status)
         values ($1, $2, 'BOARD', 'Management Board', $3, 'ACTIVE')`,
        [TENANT, body, ROOT_ENTITY],
      );
      const { rows } = await sql.query<{ id: string; status: string; closed_at: Date }>(
        `update governance_body
            set status = 'DISSOLVED', closed_at = '2027-01-01T00:00:00Z', row_version = 2
          where id = $1
        returning id, status, closed_at`,
        [body],
      );
      expect(rows[0]).toMatchObject({ id: body, status: "DISSOLVED" });
      expect(rows[0]?.closed_at).toBeInstanceOf(Date);
    });

    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          `insert into governance_body
             (tenant_id, code, name, legal_entity_id, status)
           values ($1, 'INVALID', 'Invalid body', $2, 'ACTIVE')`,
          [TENANT, "ffffffff-ffff-ffff-ffff-ffffffffffff"],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "governance_body_legal_entity_fk" });
  });
});
