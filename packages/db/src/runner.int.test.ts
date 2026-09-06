/**
 * The migration harness, against a real PostgreSQL.
 *
 * Harness-only tests cite no invariant in their titles: machinery is not the rule it will
 * eventually carry. The clean-chain ownership test is the deliberate exception. It builds
 * the real tenancy schema and names INV-TEN-001 because a superuser/BYPASSRLS table owner
 * would weaken that schema's enforcement, not merely the harness. See
 * tooling/invariants-pending.md.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  appliedMigrations,
  ensureLedger,
  LEDGER_TABLE,
  LOCK_TIMEOUT_MS,
  MIGRATION_ROLE,
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
  it("applies every migration from clean through the documented administrative connection", async () => {
    await withTempDatabase("apply", async (_url, sql) => {
      const result = await applyMigrations(sql);
      expect(result.applied).toEqual(readMigrations().map((m) => m.name));

      const ledger = await appliedMigrations(sql);
      for (const migration of readMigrations()) {
        expect(ledger.get(migration.name)?.checksum).toBe(migration.checksum);
      }
    });
  });

  it("re-running through a different administrative role succeeds", async () => {
    await withTempDatabase("different_admin", async (_url, sql) => {
      await applyMigrations(sql);
      const secondAdmin = `po_second_admin_${process.pid}_${Date.now()}`;
      await sql.query(`create role ${secondAdmin} nosuperuser nobypassrls`);
      await sql.query(`
        do $second_admin_database$
        begin
          execute format(
            'grant connect, create on database %I to ${secondAdmin} with grant option',
            current_database()
          );
        end
        $second_admin_database$;
      `);
      await sql.query(`grant usage, create on schema public to ${secondAdmin} with grant option`);
      await sql.query(
        `grant ${MIGRATION_ROLE} to ${secondAdmin} with admin true, set true, inherit false`,
      );
      try {
        await sql.query(`set session authorization ${secondAdmin}`);
        const result = await applyMigrations(sql);
        expect(result.applied).toEqual([]);
        expect(result.alreadyApplied).toEqual(readMigrations().map((m) => m.name));
      } finally {
        await sql.query("reset session authorization");
        await sql.query(`drop owned by ${secondAdmin}`);
        await sql.query(`drop role ${secondAdmin}`);
      }
    });
  });

  it("rejects migration_role clearly before bootstrapping a clean database", async () => {
    await withTempDatabase("wrong_clean_role", async (_url, sql) => {
      const before = await sql.query<{ ledger: string | null }>(
        `select to_regclass('public.${LEDGER_TABLE}')::text as ledger`,
      );
      expect(before.rows[0]?.ledger).toBeNull();

      try {
        await sql.query(`set session authorization ${MIGRATION_ROLE}`);
        await expect(applyMigrations(sql)).rejects.toThrow(
          /require an administrative connection, not migration_role/i,
        );
      } finally {
        await sql.query("reset session authorization");
      }

      const after = await sql.query<{ ledger: string | null }>(
        `select to_regclass('public.${LEDGER_TABLE}')::text as ledger`,
      );
      expect(after.rows[0]?.ledger).toBeNull();
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

  it("owns an ordinary migration object without role SQL in the migration file", async () => {
    const dir = fixtureDir({ "0001_owned.sql": "create table centrally_owned (id int);" });
    await withTempDatabase("central_owner", async (_url, sql) => {
      await applyMigrations(sql, dir);
      const { rows } = await sql.query<{ owner: string }>(`
        select pg_get_userbyid(c.relowner) as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'centrally_owned'
      `);
      expect(rows[0]?.owner).toBe(MIGRATION_ROLE);
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

describe("the migration ledger", () => {
  it("is idempotent across owners because only its creator applies the comment", async () => {
    await withTempDatabase("ledger_owners", async (_url, sql) => {
      const suffix = `${process.pid}_${Date.now()}`;
      const first = `po_ledger_first_${suffix}`;
      const second = `po_ledger_second_${suffix}`;
      await sql.query(`create role ${first}`);
      await sql.query(`create role ${second}`);
      await sql.query(`grant usage, create on schema public to ${first}, ${second}`);

      try {
        await sql.query(`set role ${first}`);
        await ensureLedger(sql);
        await sql.query("reset role");

        await sql.query(`set role ${second}`);
        await ensureLedger(sql);
        await sql.query("reset role");

        const { rows } = await sql.query<{ owner: string; comment: string }>(`
          select pg_get_userbyid(c.relowner) as owner,
                 obj_description(c.oid, 'pg_class') as comment
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = '${LEDGER_TABLE}'
        `);
        expect(rows[0]?.owner).toBe(first);
        expect(rows[0]?.comment).toContain("Applied migrations and their checksums");
      } finally {
        await sql.query("reset role");
        await sql.query(`alter table if exists public.${LEDGER_TABLE} owner to current_user`);
        await sql.query(`drop owned by ${first}`);
        await sql.query(`drop owned by ${second}`);
        await sql.query(`drop role ${first}`);
        await sql.query(`drop role ${second}`);
      }
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
      const { rows } = await sql.query<{ name: string; owner: string }>(`
        select c.relname as name, pg_get_userbyid(c.relowner) as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname in ('t', 't_id_idx')
         order by c.relname
      `);
      expect(rows).toEqual([
        { name: "t", owner: MIGRATION_ROLE },
        { name: "t_id_idx", owner: MIGRATION_ROLE },
      ]);
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
  it("INV-TEN-001: clean-chain ownership cannot bypass row-level security", async () => {
    await withTempDatabase("ownership", async (_url, sql) => {
      await applyMigrations(sql);

      // State the enforcement property directly: FORCE RLS does not bind a superuser or
      // BYPASSRLS owner, regardless of what that role happens to be named.
      const bypassingOwners = await sql.query<{
        table_name: string;
        owner: string;
      }>(`
        select n.nspname || '.' || c.relname as table_name, r.rolname as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_roles r on r.oid = c.relowner
         where c.relkind in ('r', 'p')
           and c.relrowsecurity
           and (r.rolsuper or r.rolbypassrls)
         order by 1
      `);
      expect(bypassingOwners.rows).toEqual([]);

      // Decision #43: a trusted extension's script runs as PostgreSQL's bootstrap
      // superuser, so its member functions and types are deliberately not owned by the
      // non-superuser caller. Extension members are safe to exclude from our ownership
      // convention because PostgreSQL contributes no tables, asserted here rather than
      // left as an inherited assumption. The RLS assertion above excludes nothing.
      const extensionTables = await sql.query<{ name: string }>(`
        select n.nspname || '.' || c.relname as name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_depend d
            on d.classid = 'pg_class'::regclass
           and d.objid = c.oid
           and d.deptype = 'e'
         where c.relkind in ('r', 'p')
         order by 1
      `);
      expect(extensionTables.rows).toEqual([]);

      const definedObjects = await sql.query<{
        kind: string;
        name: string;
        owner: string;
      }>(`
        with owned_object(kind, name, owner_oid, class_id, object_id) as (
          select case c.relkind when 'S' then 'sequence' else 'table' end,
                 n.nspname || '.' || c.relname,
                 c.relowner,
                 'pg_class'::regclass::oid,
                 c.oid
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'S')
          union all
          select 'type', n.nspname || '.' || t.typname, t.typowner,
                 'pg_type'::regclass::oid, t.oid
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typisdefined
          union all
          select 'function', n.nspname || '.' || p.oid::regprocedure::text, p.proowner,
                 'pg_proc'::regclass::oid, p.oid
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
        )
        select o.kind, o.name, r.rolname as owner
          from owned_object o
          join pg_roles r on r.oid = o.owner_oid
         where not exists (
           select 1
             from pg_depend d
            where d.classid = o.class_id
              and d.objid = o.object_id
              and d.deptype = 'e'
         )
         order by o.kind, o.name
      `);

      expect(definedObjects.rows.length).toBeGreaterThan(6);
      expect(definedObjects.rows.filter((row) => row.owner !== MIGRATION_ROLE)).toEqual([]);

      const extension = await sql.query<{ owner: string; superuser: boolean }>(`
        select r.rolname as owner, r.rolsuper as superuser
          from pg_extension e
          join pg_roles r on r.oid = e.extowner
         where e.extname = 'btree_gist'
      `);
      expect(extension.rows).toHaveLength(1);
      expect(extension.rows[0]?.superuser).toBe(false);
    });
  });

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
        constraint runner_test_one_effective_version_per_variant
          exclude using gist (tenant_id with =, variant_id with =, effective_range with &&)
          where (effective_range is not null)
      )`);
      await sql.query(
        `comment on constraint runner_test_one_effective_version_per_variant on effectivity is
           'INV-EFF-002: at most one version of a variant claims any instant'`,
      );

      // The invariant id must be readable from the BUILT schema -- that is what makes the
      // "spec -> INV -> enforcement" link checkable rather than a convention.
      const { rows } = await sql.query<{ comment: string }>(
        `select obj_description(con.oid, 'pg_constraint') as comment
           from pg_constraint con
          where con.conname = 'runner_test_one_effective_version_per_variant'`,
      );
      expect(rows[0]?.comment).toContain("INV-EFF-002");
    });
  });
});
