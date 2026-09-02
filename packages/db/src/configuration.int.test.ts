import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordConfigurationChange, type AuditTransaction } from "../../domain/src/index.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const TENANT = "83000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "84000000-0000-0000-0000-000000000002";
const USER = "83000000-0000-0000-0001-000000000001";
const OTHER_USER = "84000000-0000-0000-0001-000000000002";
const BASE_CONFIGURATION = "83000000-0000-0000-0002-000000000001";
const OTHER_CONFIGURATION = "84000000-0000-0000-0002-000000000002";
const DOCUMENT_TYPE = "83000000-0000-0000-0003-000000000001";
const OTHER_DOCUMENT_TYPE = "84000000-0000-0000-0003-000000000002";
const CLASSIFICATION = "83000000-0000-0000-0004-000000000001";
const OTHER_CLASSIFICATION = "84000000-0000-0000-0004-000000000002";
const SECOND_CONFIGURATION = "83000000-0000-0000-0005-000000000001";
const REQUEST_ID = "83000000-0000-0000-0006-000000000001";
const CORRELATION_ID = "83000000-0000-0000-0007-000000000001";
const FIXED_INSTANT = "2027-01-01T00:00:00.000Z";
const CONFIGURATION_TABLES = [
  "configuration_version",
  "document_type",
  "information_classification",
] as const;

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

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
    await sql.query("delete from audit_event where tenant_id = $1", [tenantId]);
    await sql.query("delete from tenant_event_sequence where tenant_id = $1", [tenantId]);
    await sql.query("delete from document_type where tenant_id = $1", [tenantId]);
    await sql.query("delete from information_classification where tenant_id = $1", [tenantId]);
    await sql.query("delete from configuration_version where tenant_id = $1", [tenantId]);
    await sql.query("delete from app_user where tenant_id = $1", [tenantId]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

interface Fixture {
  tenantId: string;
  userId: string;
  configurationId: string;
  documentTypeId: string;
  classificationId: string;
  label: string;
}

async function seedTenant(sql: Sql, fixture: Fixture): Promise<void> {
  await sql.query("begin");
  try {
    await sql.query("select set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await sql.query(
      `insert into app_user (tenant_id, id, display_name, contact_email, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [
        fixture.tenantId,
        fixture.userId,
        `${fixture.label} configuration user`,
        `${fixture.label.toLowerCase()}-configuration@example.test`,
      ],
    );
    await sql.query(
      `insert into configuration_version (
         tenant_id, id, sequence, effective_from, changed_by, change_reason,
         weakening, payload_digest
       ) values ($1, $2, 1, $3, $4, 'Initial fixture', false, $5)`,
      [
        fixture.tenantId,
        fixture.configurationId,
        FIXED_INSTANT,
        fixture.userId,
        `sha256:${fixture.label.toLowerCase()}-initial`,
      ],
    );
    await sql.query(
      `insert into document_type (
         tenant_id, id, code, name, rank, mandated_authority, default_review_rule,
         requires_attestation_by_default, status
       ) values ($1, $2, $3, $4, 10, $5, $6, false, 'ACTIVE')`,
      [
        fixture.tenantId,
        fixture.documentTypeId,
        `POLICY_${fixture.label}`,
        `${fixture.label} Policy`,
        { MATERIAL: { kind: "NAMED_USER" } },
        { months: 12 },
      ],
    );
    await sql.query(
      `insert into information_classification (
         tenant_id, id, code, name, rank, handling_instructions,
         externally_disclosable, status
       ) values ($1, $2, $3, $4, 10, 'Handle under tenant policy', false, 'ACTIVE')`,
      [fixture.tenantId, fixture.classificationId, `INTERNAL_${fixture.label}`, "Internal"],
    );
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
         ($1, 'Configuration tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU'),
         ($2, 'Other configuration tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT, OTHER_TENANT],
    );
    await seedTenant(sql, {
      tenantId: TENANT,
      userId: USER,
      configurationId: BASE_CONFIGURATION,
      documentTypeId: DOCUMENT_TYPE,
      classificationId: CLASSIFICATION,
      label: "A",
    });
    await seedTenant(sql, {
      tenantId: OTHER_TENANT,
      userId: OTHER_USER,
      configurationId: OTHER_CONFIGURATION,
      documentTypeId: OTHER_DOCUMENT_TYPE,
      classificationId: OTHER_CLASSIFICATION,
      label: "B",
    });
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

describe("the configuration schema", () => {
  it("INV-CFG-003 / INV-DOC-005: creates tenant-isolated configuration and taxonomy records", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{
        table_name: string;
        columns: string[];
        row_security: boolean;
        force_row_security: boolean;
        policy_count: number;
      }>(
        `select c.relname as table_name,
                array_agg(a.attname::text order by a.attname) filter (where a.attnum > 0) as columns,
                c.relrowsecurity as row_security,
                c.relforcerowsecurity as force_row_security,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
          where n.nspname = 'public' and c.relname = any($1::text[])
          group by c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
          order by c.relname`,
        [[...CONFIGURATION_TABLES]],
      ),
    );

    expect(rows.map((row) => row.table_name)).toEqual([...CONFIGURATION_TABLES].sort());
    for (const row of rows) {
      expect(row.columns, row.table_name).toEqual(
        expect.arrayContaining(["tenant_id", "id", "created_at", "updated_at", "row_version"]),
      );
      expect(row.row_security, row.table_name).toBe(true);
      expect(row.force_row_security, row.table_name).toBe(true);
      expect(row.policy_count, row.table_name).toBe(1);
    }
  });

  it("INV-CFG-003: constrains nullable audit references to a real tenant configuration", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ is_nullable: string; constraint_name: string; validated: boolean }>(
        `select cols.is_nullable, con.conname as constraint_name, con.convalidated as validated
           from information_schema.columns cols
           join pg_class rel on rel.relname = cols.table_name
           join pg_namespace n on n.oid = rel.relnamespace and n.nspname = cols.table_schema
           join pg_constraint con on con.conrelid = rel.oid and con.contype = 'f'
          where cols.table_schema = 'public'
            and cols.table_name = 'audit_event'
            and cols.column_name = 'configuration_version_id'
            and con.conname = 'audit_event_configuration_version_fk'`,
      ),
    );
    expect(rows).toEqual([
      {
        is_nullable: "YES",
        constraint_name: "audit_event_configuration_version_fk",
        validated: true,
      },
    ]);
  });

  it("INV-CFG-003: permits an operational event without a configuration reference", async () => {
    await withTenant(TENANT, async (sql) => {
      const { rows } = await sql.query<{ configuration_version_id: string | null }>(
        `insert into audit_event (
           tenant_id, sequence, event_type, event_schema_version, occurred_at,
           actor_type, actor_id, subject_type, subject_id, action, outcome,
           request_id, correlation_id, source_channel
         ) values ($1, 999, 'session.revoked', 1, $2, 'USER', $3, 'USER', $3,
                   'REVOKE_SESSION', 'SUCCESS', $4, $5, 'WEB')
         returning configuration_version_id`,
        [TENANT, FIXED_INSTANT, USER, REQUEST_ID, CORRELATION_ID],
      );
      expect(rows).toEqual([{ configuration_version_id: null }]);
    });
  });

  it("INV-CFG-003 / INV-TEN-003: refuses another tenant's configuration reference", async () => {
    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          `insert into audit_event (
             tenant_id, sequence, event_type, event_schema_version, occurred_at,
             actor_type, actor_id, subject_type, subject_id, action, outcome,
             request_id, correlation_id, source_channel, configuration_version_id
           ) values ($1, 999, 'configuration.changed', 1, $2, 'USER', $3,
                     'CONFIGURATION_VERSION', $4, 'CREATE_CONFIGURATION_VERSION',
                     'SUCCESS', $5, $6, 'WEB', $4)`,
          [TENANT, FIXED_INSTANT, USER, OTHER_CONFIGURATION, REQUEST_ID, CORRELATION_ID],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "audit_event_configuration_version_fk",
    });
  });

  it("INV-CFG-003 / INV-CFG-006: names every configuration constraint with its invariant", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; constraint_name: string; comment: string | null }>(
        `select rel.relname as table_name,
                con.conname as constraint_name,
                obj_description(con.oid, 'pg_constraint') as comment
           from pg_constraint con
           join pg_class rel on rel.oid = con.conrelid
           join pg_namespace n on n.oid = rel.relnamespace
          where n.nspname = 'public'
            and (
              rel.relname = any($1::text[])
              or con.conname = 'audit_event_configuration_version_fk'
            )
            and con.contype in ('p', 'f', 'u', 'c')
          order by rel.relname, con.conname`,
        [[...CONFIGURATION_TABLES]],
      ),
    );
    expect(rows.length).toBeGreaterThan(14);
    expect(rows.filter((row) => !row.comment?.includes("INV-"))).toEqual([]);
  });

  it("INV-CFG-006: grants app_role only the specified configuration privileges", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string; privileges: string[] }>(
        `select table_name,
                array_agg(privilege_type::text order by privilege_type)::text[] as privileges
           from information_schema.role_table_grants
          where grantee = current_user and table_name = any($1::text[])
          group by table_name
          order by table_name`,
        [[...CONFIGURATION_TABLES]],
      ),
    );
    expect(rows).toEqual([
      { table_name: "configuration_version", privileges: ["INSERT", "SELECT"] },
      { table_name: "document_type", privileges: ["INSERT", "SELECT", "UPDATE"] },
      {
        table_name: "information_classification",
        privileges: ["INSERT", "SELECT", "UPDATE"],
      },
    ]);
  });

  it("INV-DOC-005: keeps the document-version forward reference nullable and unconstrained", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ is_nullable: string; comment: string; foreign_keys: number }>(
        `select cols.is_nullable,
                col_description(rel.oid, attr.attnum) as comment,
                (select count(*)::int
                   from pg_constraint con
                  where con.conrelid = rel.oid
                    and con.contype = 'f'
                    and attr.attnum = any(con.conkey)) as foreign_keys
           from information_schema.columns cols
           join pg_class rel on rel.relname = cols.table_name
           join pg_namespace n on n.oid = rel.relnamespace and n.nspname = cols.table_schema
           join pg_attribute attr on attr.attrelid = rel.oid and attr.attname = cols.column_name
          where cols.table_schema = 'public'
            and cols.table_name = 'document_type'
            and cols.column_name = 'mandated_by_document_version_id'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_nullable: "YES", foreign_keys: 0 });
    expect(rows[0]?.comment).toContain("POL-013 (#51)");
  });

  it("INV-AUTH-019: no database authorization structure references classification", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ table_name: string }>(`
        select rel.relname as table_name
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_class target on target.oid = con.confrelid
         where con.contype = 'f'
           and target.relname = 'information_classification'
           and rel.relname ~ '(access|grant|role|permission|capability|authorization)'
      `),
    );
    expect(rows).toEqual([]);
  });
});

describe("configuration history", () => {
  it("INV-CFG-006: appends sequence n+1 without changing the prior row", async () => {
    await withTenant(TENANT, async (sql) => {
      const before = await sql.query<{ bytes: string }>(
        "select encode(convert_to(to_jsonb(configuration_version)::text, 'UTF8'), 'hex') as bytes from configuration_version where id = $1",
        [BASE_CONFIGURATION],
      );
      const recorded = await recordConfigurationChange(transaction(sql), {
        tenantId: TENANT,
        configurationVersionId: SECOND_CONFIGURATION,
        effectiveFrom: new Date("2027-02-01T00:00:00.000Z"),
        changedBy: USER,
        changeReason: "Adopt the February governance configuration",
        weakening: false,
        payloadDigest: "sha256:a-february",
        occurredAt: new Date("2027-01-20T10:00:00.000Z"),
        requestId: REQUEST_ID,
        correlationId: CORRELATION_ID,
        sourceChannel: "WEB",
      });
      const after = await sql.query<{ bytes: string }>(
        "select encode(convert_to(to_jsonb(configuration_version)::text, 'UTF8'), 'hex') as bytes from configuration_version where id = $1",
        [BASE_CONFIGURATION],
      );
      expect(recorded.sequence).toBe(2);
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("INV-CFG-004 / INV-AUD-004: emits exactly one event with actor, before and after in the same transaction", async () => {
    await withTenant(TENANT, async (sql) => {
      const recorded = await recordConfigurationChange(transaction(sql), {
        tenantId: TENANT,
        configurationVersionId: SECOND_CONFIGURATION,
        effectiveFrom: new Date("2027-02-01T00:00:00.000Z"),
        changedBy: USER,
        changeReason: "Adopt the February governance configuration",
        weakening: false,
        payloadDigest: "sha256:a-february",
        occurredAt: new Date("2027-01-20T10:00:00.000Z"),
        requestId: REQUEST_ID,
        correlationId: CORRELATION_ID,
        sourceChannel: "WEB",
      });
      const { rows } = await sql.query<{
        actor_id: string;
        configuration_version_id: string;
        safe_before: Record<string, unknown>;
        safe_after: Record<string, unknown>;
      }>(
        `select actor_id, configuration_version_id, safe_before, safe_after
           from audit_event
          where event_type = 'configuration.changed' and subject_id = $1`,
        [recorded.id],
      );
      expect(rows).toEqual([
        {
          actor_id: USER,
          configuration_version_id: SECOND_CONFIGURATION,
          safe_before: {
            configurationVersionId: BASE_CONFIGURATION,
            sequence: 1,
            effectiveFrom: FIXED_INSTANT,
            payloadDigest: "sha256:a-initial",
            weakening: false,
          },
          safe_after: {
            configurationVersionId: SECOND_CONFIGURATION,
            sequence: 2,
            effectiveFrom: "2027-02-01T00:00:00.000Z",
            payloadDigest: "sha256:a-february",
            weakening: false,
          },
        },
      ]);
    });
  });

  it("INV-CFG-004 / INV-AUD-004: rolls the configuration row and event back together", async () => {
    await withAppRole(async (sql) => {
      await sql.query("begin");
      try {
        await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        await recordConfigurationChange(transaction(sql), {
          tenantId: TENANT,
          configurationVersionId: SECOND_CONFIGURATION,
          effectiveFrom: new Date("2027-02-01T00:00:00.000Z"),
          changedBy: USER,
          changeReason: "This transaction will roll back",
          weakening: false,
          payloadDigest: "sha256:rolled-back",
          occurredAt: new Date("2027-01-20T10:00:00.000Z"),
          requestId: REQUEST_ID,
          correlationId: CORRELATION_ID,
          sourceChannel: "API",
        });
      } finally {
        await sql.query("rollback");
      }
    });

    await withTenant(TENANT, async (sql) => {
      const configuration = await sql.query<{ count: number }>(
        "select count(*)::int as count from configuration_version where id = $1",
        [SECOND_CONFIGURATION],
      );
      const event = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where subject_id = $1",
        [SECOND_CONFIGURATION],
      );
      expect(configuration.rows).toEqual([{ count: 0 }]);
      expect(event.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-CFG-006: app_role cannot update a configuration version", async () => {
    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          "update configuration_version set payload_digest = 'tampered', row_version = 2 where id = $1",
          [BASE_CONFIGURATION],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-CFG-006: concurrent changes allocate distinct consecutive sequences", async () => {
    const inputs = [
      {
        configurationVersionId: "83000000-0000-0000-0009-000000000001",
        requestId: "83000000-0000-0000-0010-000000000001",
        correlationId: "83000000-0000-0000-0011-000000000001",
        payloadDigest: "sha256:concurrent-one",
      },
      {
        configurationVersionId: "83000000-0000-0000-0009-000000000002",
        requestId: "83000000-0000-0000-0010-000000000002",
        correlationId: "83000000-0000-0000-0011-000000000002",
        payloadDigest: "sha256:concurrent-two",
      },
    ] as const;

    const recorded = await Promise.all(
      inputs.map((input) =>
        inCommittedTenant(TENANT, (sql) =>
          recordConfigurationChange(transaction(sql), {
            tenantId: TENANT,
            ...input,
            effectiveFrom: new Date("2027-03-01T00:00:00.000Z"),
            changedBy: USER,
            changeReason: "Concurrent configuration test",
            weakening: false,
            occurredAt: new Date("2027-02-20T10:00:00.000Z"),
            sourceChannel: "API",
          }),
        ),
      ),
    );
    expect(recorded.map((item) => item.sequence).sort()).toEqual([2, 3]);

    await withTenant(TENANT, async (sql) => {
      const { rows } = await sql.query<{ sequence: number }>(
        "select sequence from configuration_version where id = any($1::uuid[]) order by sequence",
        [inputs.map((input) => input.configurationVersionId)],
      );
      expect(rows).toEqual([{ sequence: 2 }, { sequence: 3 }]);
    });
  });
});

describe("taxonomy privileges and uniqueness", () => {
  it("INV-DOC-005: refuses a duplicate document-type rank in one tenant while allowing it across tenants", async () => {
    await expect(
      withTenant(TENANT, (sql) =>
        sql.query(
          `insert into document_type (
             tenant_id, id, code, name, rank, mandated_authority, default_review_rule, status
           ) values ($1, $2, 'MANUAL_A', 'Manual', 10, $3, $4, 'ACTIVE')`,
          [
            TENANT,
            "83000000-0000-0000-0008-000000000001",
            { MATERIAL: { kind: "NAMED_USER" } },
            { months: 12 },
          ],
        ),
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "document_type_tenant_rank_unique",
    });

    for (const [tenantId, typeId] of [
      [TENANT, DOCUMENT_TYPE],
      [OTHER_TENANT, OTHER_DOCUMENT_TYPE],
    ] as const) {
      await withTenant(tenantId, async (sql) => {
        const { rows } = await sql.query<{ rank: number }>(
          "select rank from document_type where id = $1",
          [typeId],
        );
        expect(rows).toEqual([{ rank: 10 }]);
      });
    }
  });

  it("INV-DOC-005 / INV-AUTH-019: allows administrative taxonomy updates", async () => {
    await withTenant(TENANT, async (sql) => {
      const type = await sql.query<{ row_version: number }>(
        "update document_type set status = 'RETIRED', row_version = 2 where id = $1 returning row_version",
        [DOCUMENT_TYPE],
      );
      const classification = await sql.query<{ row_version: number }>(
        "update information_classification set status = 'RETIRED', row_version = 2 where id = $1 returning row_version",
        [CLASSIFICATION],
      );
      expect(type.rows).toEqual([{ row_version: 2 }]);
      expect(classification.rows).toEqual([{ row_version: 2 }]);
    });
  });

  it.each(CONFIGURATION_TABLES)("INV-CFG-006: app_role cannot delete from %s", async (table) => {
    await expect(
      withTenant(TENANT, (sql) => sql.query(`delete from ${table}`)),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("configuration tenant isolation", () => {
  it("INV-TEN-001: another tenant configuration id is indistinguishable from an absent id", async () => {
    await withTenant(OTHER_TENANT, async (sql) => {
      const crossTenant = await sql.query<{ count: number }>(
        "select count(*)::int as count from configuration_version where id = $1",
        [BASE_CONFIGURATION],
      );
      const absent = await sql.query<{ count: number }>(
        "select count(*)::int as count from configuration_version where id = $1",
        ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
      );
      expect(crossTenant.rows).toEqual([{ count: 0 }]);
      expect(crossTenant.rows).toEqual(absent.rows);
    });
  });
});
