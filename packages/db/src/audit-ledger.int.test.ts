import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emitAuditEvent,
  emitAuditEvents,
  type AuditEventInput,
  type AuditTransaction,
} from "../../domain/src/audit.js";
import {
  withAppRole,
  withMigrationRole__PRIVILEGED,
  withRetentionTenant,
  withTenant,
  type Sql,
} from "@policyoffice/testing";

const GENERAL_TENANT = "71000000-0000-0000-0000-000000000001";
const CONCURRENT_TENANT = "72000000-0000-0000-0000-000000000002";
const DEDUPE_TENANT = "73000000-0000-0000-0000-000000000003";
const ROLLBACK_TENANT = "74000000-0000-0000-0000-000000000004";
const OTHER_TENANT = "75000000-0000-0000-0000-000000000005";
const GROUP_ID = "71000000-0000-0000-0001-000000000001";
const SUBJECT_ID = "71000000-0000-0000-0002-000000000001";
const CONFIGURATION_ID = "71000000-0000-0000-0003-000000000001";
const REQUEST_ID = "71000000-0000-0000-0004-000000000001";
const CORRELATION_ID = "71000000-0000-0000-0005-000000000001";
const TENANTS = [
  GENERAL_TENANT,
  CONCURRENT_TENANT,
  DEDUPE_TENANT,
  ROLLBACK_TENANT,
  OTHER_TENANT,
] as const;

function transaction(sql: Sql): AuditTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function event(
  tenantId: string,
  suffix: string,
  overrides: Partial<AuditEventInput> = {},
): AuditEventInput {
  return {
    tenantId,
    eventType: "version.effective",
    eventSchemaVersion: 1,
    occurredAt: new Date("2027-01-15T09:42:17.231Z"),
    actor: { type: "SYSTEM", id: null },
    subject: { type: "DOCUMENT_VERSION", id: SUBJECT_ID },
    action: "MAKE_EFFECTIVE",
    outcome: "SUCCESS",
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    sourceChannel: "JOB",
    configurationVersionId: CONFIGURATION_ID,
    dedupeKey: `version.effective:${suffix}`,
    ...overrides,
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
    await sql.query("delete from user_group where tenant_id = $1", [tenantId]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
}

async function installFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of TENANTS) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[...TENANTS]]);
    for (const [index, tenantId] of TENANTS.entries()) {
      await sql.query(
        `insert into tenant
           (id, name, status, default_timezone, default_locale, residency_profile)
         values ($1, $2, 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
        [tenantId, `Audit tenant ${index + 1}`],
      );
    }
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [GENERAL_TENANT]);
      await sql.query(
        `insert into user_group (tenant_id, id, name, source, status)
         values ($1, $2, 'Audit state fixture', 'LOCAL', 'ACTIVE')`,
        [GENERAL_TENANT, GROUP_ID],
      );
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
  });

  await inCommittedTenant(GENERAL_TENANT, (sql) =>
    emitAuditEvent(transaction(sql), event(GENERAL_TENANT, "privilege-fixture")),
  );
}

async function removeFixtures(): Promise<void> {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    for (const tenantId of TENANTS) await clearTenant(sql, tenantId);
    await sql.query("delete from tenant where id = any($1::uuid[])", [[...TENANTS]]);
  });
}

beforeAll(installFixtures);
afterAll(removeFixtures);

describe("the audit ledger schema", () => {
  it("INV-AUD-005: PostgreSQL refuses an event missing its required envelope", async () => {
    await expect(
      withTenant(GENERAL_TENANT, (sql) =>
        sql.query("insert into audit_event (tenant_id, sequence) values ($1, 999)", [
          GENERAL_TENANT,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  it.each(["safe_before", "safe_after"] as const)(
    "INV-AUD-003: PostgreSQL refuses an oversized %s snapshot",
    async (column) => {
      const incompressible = randomBytes(6_000).toString("hex");
      await expect(
        withTenant(GENERAL_TENANT, (sql) =>
          sql.query(
            `insert into audit_event (
               tenant_id, sequence, event_type, event_schema_version, occurred_at,
               actor_type, subject_type, subject_id, action, outcome, correlation_id,
               source_channel, ${column}
             ) values ($1, 999, 'version.effective', 1, now(), 'SYSTEM',
                       'DOCUMENT_VERSION', $2, 'MAKE_EFFECTIVE', 'SUCCESS', $3, 'JOB', $4)`,
            [GENERAL_TENANT, SUBJECT_ID, CORRELATION_ID, { value: incompressible }],
          ),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "audit_event_safe_snapshot_size",
      });
    },
  );

  it("names every level-1 and level-2 ledger constraint with its invariant", async () => {
    const { rows } = await withAppRole((sql) =>
      sql.query<{ constraint_name: string; comment: string | null }>(`
        select con.conname as constraint_name,
               obj_description(con.oid, 'pg_constraint') as comment
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public'
           and rel.relname in ('audit_event', 'tenant_event_sequence')
         order by con.conname
      `),
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => !row.comment?.includes("INV-"))).toEqual([]);
  });
});

describe("append-only privileges", () => {
  it("INV-AUD-002: app_role may insert and select events", async () => {
    await withTenant(GENERAL_TENANT, async (sql) => {
      const emitted = await emitAuditEvent(transaction(sql), event(GENERAL_TENANT, "app-insert"));
      const selected = await sql.query<{ event_id: string }>(
        "select event_id from audit_event where event_id = $1",
        [emitted.eventId],
      );
      expect(selected.rows).toEqual([{ event_id: emitted.eventId }]);
    });
  });

  it("INV-AUD-002: app_role is refused update", async () => {
    await expect(
      withTenant(GENERAL_TENANT, (sql) => sql.query("update audit_event set action = 'TAMPERED'")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-AUD-002: app_role is refused delete", async () => {
    await expect(
      withTenant(GENERAL_TENANT, (sql) => sql.query("delete from audit_event")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-AUD-002: app_role is refused truncate", async () => {
    await expect(
      withTenant(GENERAL_TENANT, (sql) => sql.query("truncate audit_event")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("INV-AUD-002: retention_role may delete but cannot insert", async () => {
    await withRetentionTenant(GENERAL_TENANT, async (sql) => {
      const deleted = await sql.query("delete from audit_event returning event_id");
      expect(deleted.rowCount).toBe(1);
    });

    await expect(
      withRetentionTenant(GENERAL_TENANT, (sql) =>
        sql.query(
          `insert into audit_event (
             tenant_id, sequence, event_type, event_schema_version, occurred_at,
             actor_type, subject_type, subject_id, action, outcome, correlation_id,
             source_channel
           ) values ($1, 999, 'version.effective', 1, now(), 'SYSTEM',
                     'DOCUMENT_VERSION', $2, 'MAKE_EFFECTIVE', 'SUCCESS', $3, 'JOB')`,
          [GENERAL_TENANT, SUBJECT_ID, CORRELATION_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("gapless allocation and transactionality", () => {
  it("INV-AUD-009: eight concurrent writers produce exactly sequences 1 through 200", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, writer) =>
        withAppRole(async (sql) => {
          for (let index = 0; index < 25; index += 1) {
            await sql.query("begin");
            try {
              await sql.query("select set_config('app.tenant_id', $1, true)", [CONCURRENT_TENANT]);
              await emitAuditEvent(
                transaction(sql),
                event(CONCURRENT_TENANT, `${writer}-${index}`),
              );
              await sql.query("commit");
            } catch (error) {
              await sql.query("rollback");
              throw error;
            }
          }
        }),
      ),
    );

    await withTenant(CONCURRENT_TENANT, async (sql) => {
      const { rows } = await sql.query<{ sequence: string }>(
        "select sequence from audit_event order by sequence",
      );
      expect(rows.map((row) => Number(row.sequence))).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 1),
      );
    });
  });

  it("INV-AUD-009: a rolled-back allocation consumes no number", async () => {
    await withAppRole(async (sql) => {
      await sql.query("begin");
      await sql.query("select set_config('app.tenant_id', $1, true)", [ROLLBACK_TENANT]);
      const rolledBack = await emitAuditEvent(
        transaction(sql),
        event(ROLLBACK_TENANT, "rolled-back"),
      );
      expect(rolledBack.sequence).toBe(1n);
      await sql.query("rollback");
    });

    const committed = await inCommittedTenant(ROLLBACK_TENANT, (sql) =>
      emitAuditEvent(transaction(sql), event(ROLLBACK_TENANT, "committed")),
    );
    expect(committed.sequence).toBe(1n);
  });

  it("INV-AUD-001 / INV-EFF-007: the same dedupe key is refused without consuming a number", async () => {
    await inCommittedTenant(DEDUPE_TENANT, (sql) =>
      emitAuditEvent(transaction(sql), event(DEDUPE_TENANT, "same")),
    );
    await expect(
      inCommittedTenant(DEDUPE_TENANT, (sql) =>
        emitAuditEvent(transaction(sql), event(DEDUPE_TENANT, "same")),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "audit_event_dedupe_unique" });

    await withTenant(DEDUPE_TENANT, async (sql) => {
      const events = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event",
      );
      const cursor = await sql.query<{ next_sequence: string }>(
        "select next_sequence from tenant_event_sequence",
      );
      expect(events.rows[0]?.count).toBe(1);
      expect(cursor.rows[0]?.next_sequence).toBe("2");
    });
  });

  it("INV-AUD-004: a state change and its event roll back together", async () => {
    await withAppRole(async (sql) => {
      await sql.query("begin");
      await sql.query("select set_config('app.tenant_id', $1, true)", [GENERAL_TENANT]);
      await sql.query("update user_group set name = 'Changed', row_version = 2 where id = $1", [
        GROUP_ID,
      ]);
      await emitAuditEvent(transaction(sql), event(GENERAL_TENANT, "state-rollback"));
      await sql.query("rollback");
    });

    await withTenant(GENERAL_TENANT, async (sql) => {
      const group = await sql.query<{ name: string }>("select name from user_group where id = $1", [
        GROUP_ID,
      ]);
      const audit = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where dedupe_key = $1",
        ["version.effective:state-rollback"],
      );
      expect(group.rows).toEqual([{ name: "Audit state fixture" }]);
      expect(audit.rows).toEqual([{ count: 0 }]);
    });
  });

  it("INV-AUD-009: a bulk batch allocates one contiguous sequence range", async () => {
    await withTenant(OTHER_TENANT, async (sql) => {
      const emitted = await emitAuditEvents(
        transaction(sql),
        Array.from({ length: 50 }, (_, index) => event(OTHER_TENANT, `bulk-${index}`)),
      );
      expect(emitted.map((item) => item.sequence)).toEqual(
        Array.from({ length: 50 }, (_, index) => BigInt(index + 1)),
      );
    });
  });
});

describe("tenant isolation", () => {
  it("INV-TEN-001: another tenant event id is indistinguishable from an absent id", async () => {
    const eventId = await inCommittedTenant(GENERAL_TENANT, async (sql) => {
      const emitted = await emitAuditEvent(transaction(sql), event(GENERAL_TENANT, "cross-tenant"));
      return emitted.eventId;
    });

    await withTenant(OTHER_TENANT, async (sql) => {
      const crossTenant = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where event_id = $1",
        [eventId],
      );
      const absent = await sql.query<{ count: number }>(
        "select count(*)::int as count from audit_event where event_id = $1",
        ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
      );
      expect(crossTenant.rows).toEqual([{ count: 0 }]);
      expect(crossTenant.rows).toEqual(absent.rows);
    });
  });
});
