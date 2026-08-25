/**
 * The migration harness, against a real PostgreSQL.
 *
 * These tests cite no invariant in their titles, deliberately. They exercise the machinery
 * that will carry INV-EFF-002 (btree_gist and EXCLUDE), INV-AUD-002 (revoked privileges)
 * and INV-TEN-001 (the non-bypassing application role) -- but the invariants themselves
 * constrain tables that do not exist yet. Claiming them here would mark them covered while
 * the product has no schema, and nobody would notice when the real tables landed untested.
 * See tooling/invariants-pending.md.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  appliedMigrations,
  LOCK_TIMEOUT_MS,
  MigrationTamperedError,
  readMigrations,
  status,
  STATEMENT_TIMEOUT_MS,
  withTempDatabase,
} from "./index.js";

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "po-fixture-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, "utf8");
  return dir;
}

describe("applying the chain", () => {
  it("applies every migration in order and records a checksum for each", async () => {
    await withTempDatabase("apply", async (_url, sql) => {
      const result = await applyMigrations(sql);
      expect(result.applied).toEqual(readMigrations().map((m) => m.name));

      const ledger = await appliedMigrations(sql);
      for (const migration of readMigrations()) {
        expect(ledger.get(migration.name)?.checksum).toBe(migration.checksum);
      }
    });
  });

  it("re-running applies nothing -- idempotent by ledger, not by luck", async () => {
    await withTempDatabase("idempotent", async (_url, sql) => {
      await applyMigrations(sql);
      const second = await applyMigrations(sql);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(readMigrations().map((m) => m.name));
    });
  });

  it("REFUSES to proceed when an already-applied migration has been edited", async () => {
    // ADR-0009 makes a merged migration immutable. Editing one means this database and
    // every other database built from the chain now differ, and nothing else detects it.
    const dir = fixtureDir({ "0001_a.sql": "create table a (id int);" });
    await withTempDatabase("tampered", async (_url, sql) => {
      await applyMigrations(sql, dir);
      writeFileSync(join(dir, "0001_a.sql"), "create table a (id bigint);", "utf8");

      await expect(applyMigrations(sql, dir)).rejects.toThrow(MigrationTamperedError);
      await expect(applyMigrations(sql, dir)).rejects.toThrow(/0001_a\.sql/);
      await expect(applyMigrations(sql, dir)).rejects.toThrow(/no down path/i);
    });
  });

  it("reports a changed migration in status rather than silently ignoring it", async () => {
    const dir = fixtureDir({ "0001_a.sql": "create table a (id int);" });
    await withTempDatabase("status", async (_url, sql) => {
      await applyMigrations(sql, dir);
      writeFileSync(join(dir, "0001_a.sql"), "create table a (id bigint);", "utf8");
      expect(await status(sql, dir)).toEqual([{ name: "0001_a.sql", state: "changed" }]);
    });
  });

  it("rolls back a failed transactional migration, leaving no ledger row", async () => {
    const dir = fixtureDir({
      "0001_ok.sql": "create table ok (id int);",
      "0002_bad.sql": "create table bad (id int); select 1/0;",
    });
    await withTempDatabase("failure", async (_url, sql) => {
      await expect(applyMigrations(sql, dir)).rejects.toThrow();
      const ledger = await appliedMigrations(sql);
      expect(ledger.has("0001_ok.sql")).toBe(true);
      expect(ledger.has("0002_bad.sql")).toBe(false);
      // and the partial work is gone
      const { rows } = await sql.query("select to_regclass('public.bad') is null as absent");
      expect(rows[0]).toMatchObject({ absent: true });
    });
  });
});

describe("non-transactional migrations", () => {
  it("runs CREATE INDEX CONCURRENTLY when the migration opts out of a transaction", async () => {
    const dir = fixtureDir({
      "0001_table.sql": "create table t (id int); insert into t values (1);",
      "0002_index.sql":
        "-- policyoffice:non-transactional\ncreate index concurrently t_id_idx on t (id);",
    });
    await withTempDatabase("concurrent", async (_url, sql) => {
      const result = await applyMigrations(sql, dir);
      expect(result.applied).toEqual(["0001_table.sql", "0002_index.sql"]);
      const { rows } = await sql.query(
        "select count(*)::int as n from pg_indexes where indexname = 't_id_idx'",
      );
      expect(rows[0]).toMatchObject({ n: 1 });
    });
  });

  it("fails loudly when CREATE INDEX CONCURRENTLY is left in a transactional migration", async () => {
    // Rather than mysteriously: PostgreSQL raises "cannot run inside a transaction block",
    // which is a clear instruction to add the marker.
    const dir = fixtureDir({
      "0001_table.sql": "create table t (id int);",
      "0002_index.sql": "create index concurrently t_id_idx on t (id);",
    });
    await withTempDatabase("concurrent-bad", async (_url, sql) => {
      await expect(applyMigrations(sql, dir)).rejects.toThrow(/cannot run inside a transaction/i);
    });
  });
});

describe("the migration session", () => {
  it("sets lock_timeout and statement_timeout so a blocked migration fails fast", async () => {
    // ADR-0009: waiting for a lock means every subsequent request queues behind the
    // migration's lock request. Failing fast is recoverable; a lock queue is an outage.
    await withTempDatabase("timeouts", async (_url, sql) => {
      await applyMigrations(sql);
      // pg_settings reports the raw value in the setting's base unit (ms for both).
      // current_setting() normalises 3000ms to "3s" and 300000ms to "5min", so asserting
      // on its string form would be asserting on PostgreSQL's display preferences.
      const { rows } = await sql.query<{ name: string; setting: string; unit: string }>(
        `select name, setting, unit from pg_settings
          where name in ('lock_timeout','statement_timeout') order by name`,
      );
      const byName = new Map(rows.map((r) => [r.name, r]));
      expect(byName.get("lock_timeout")?.unit).toBe("ms");
      expect(Number(byName.get("lock_timeout")?.setting)).toBe(LOCK_TIMEOUT_MS);
      expect(byName.get("statement_timeout")?.unit).toBe("ms");
      expect(Number(byName.get("statement_timeout")?.setting)).toBe(STATEMENT_TIMEOUT_MS);
    });
  });
});

describe("what the chain actually builds", () => {
  it("creates three roles, none of them a superuser and none bypassing RLS", async () => {
    // The attributes are re-applied on every run, not only at creation, so an existing
    // role cannot drift away from them.
    await withTempDatabase("roles", async (_url, sql) => {
      await applyMigrations(sql);
      const { rows } = await sql.query<{ rolname: string; su: boolean; bypass: boolean }>(
        `select rolname, rolsuper as su, rolbypassrls as bypass from pg_roles
          where rolname in ('migration_role','app_role','retention_role') order by rolname`,
      );
      expect(rows).toHaveLength(3);
      for (const role of rows) {
        expect(role.su, `${role.rolname} must not be a superuser`).toBe(false);
        expect(role.bypass, `${role.rolname} must not bypass RLS`).toBe(false);
      }
    });
  });

  it("never drops and recreates a role, so pooled connections are not poisoned", async () => {
    // verification/README.md finding 6: Neon's pooler caches server connections by role
    // OID. A migration that recreates a role breaks production through the pooled
    // endpoint while the direct endpoint works, and heals itself when connections cycle.
    const sql = readMigrations()
      .map((m) => m.sql)
      .join("\n");
    expect(sql).not.toMatch(/drop\s+role/i);
    expect(sql).not.toMatch(/drop\s+owned/i);
  });

  it("sets no role password, so no secret enters a public repository", async () => {
    // Neon's control plane also rejects weak passwords on CREATE ROLE, so a fixture
    // password that works against the CI container fails against production.
    const sql = readMigrations()
      .map((m) => m.sql)
      .join("\n");
    expect(sql).not.toMatch(/password\s+'/i);
  });

  it("makes btree_gist available, so an exclusion constraint can be declared", async () => {
    // This is what keeps INV-EFF-002 at enforcement level 2 rather than level 5.
    await withTempDatabase("gist", async (_url, sql) => {
      await applyMigrations(sql);
      const ext = await sql.query("select extversion from pg_extension where extname='btree_gist'");
      expect(ext.rows).toHaveLength(1);

      await sql.query(`create table effectivity (
        tenant_id uuid not null,
        variant_id uuid not null,
        effective_range tstzrange,
        constraint one_effective_version_per_variant
          exclude using gist (tenant_id with =, variant_id with =, effective_range with &&)
          where (effective_range is not null)
      )`);
      await sql.query(
        `comment on constraint one_effective_version_per_variant on effectivity is
           'INV-EFF-002: at most one version of a variant claims any instant'`,
      );

      // The invariant id must be readable from the BUILT schema -- that is what makes the
      // "spec -> INV -> enforcement" link checkable rather than a convention.
      const { rows } = await sql.query<{ comment: string }>(
        `select obj_description(con.oid, 'pg_constraint') as comment
           from pg_constraint con where con.conname = 'one_effective_version_per_variant'`,
      );
      expect(rows[0]?.comment).toContain("INV-EFF-002");
    });
  });
});
