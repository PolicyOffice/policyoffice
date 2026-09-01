/**
 * Forward-only SQL migrations.
 *
 * `ADR-0009`, and the part that shapes everything else:
 *
 *   "There are no down migrations. Not 'we rarely write them': they do not exist. A down
 *    migration is a data-loss tool pointed at an evidence ledger."
 *
 * So there is no revert function in this file, no `down` half of a migration file, and no
 * rollback helper. Recovery from a bad migration is a forward migration or a restore from
 * backup, both of which are honest about what is happening. Adding a reverse path later
 * must require changing this design, not calling something that already exists.
 *
 * Migrations are immutable once merged. The ledger stores a checksum per migration and
 * the runner refuses to proceed when a file no longer matches what was applied -- an
 * edited migration means the schema in front of you and the schema everyone else has are
 * different, and nothing else would notice.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** The runner's own bookkeeping. Excluded from the drift check: it is not modelled state. */
export const LEDGER_TABLE = "schema_migration";

/**
 * The administrative connection bootstraps this role; every ordinary migration and the
 * ledger itself run as it. Keeping the switch here means migration authors cannot forget
 * the ownership boundary that makes forced RLS bind the schema owner (INV-TEN-001).
 */
export const MIGRATION_ROLE = "migration_role";

/** The one migration that must run before migration_role is able to run anything. */
const ROLE_BOOTSTRAP_MIGRATION = "0001_roles.sql";

/**
 * Marker opting a migration out of a transaction.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so such migrations
 * run alone and unwrapped. The cost is real and worth stating: a non-transactional
 * migration that fails partway leaves the database in an intermediate state, and the only
 * way forward is another migration.
 */
const NON_TRANSACTIONAL = /^--\s*policyoffice:non-transactional\s*$/m;

/**
 * Migration session settings (`ADR-0009`, "Migrations must not lock the table").
 *
 * `lock_timeout` is short on purpose. A migration that cannot take its lock quickly is
 * blocked behind a long-running query, and waiting means every subsequent request queues
 * behind the migration's lock request. Failing fast is recoverable; a lock queue in
 * production is an outage.
 *
 * `statement_timeout` is generous but finite, so a runaway migration is bounded.
 */
export const LOCK_TIMEOUT_MS = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 3_000);
export const STATEMENT_TIMEOUT_MS = Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS ?? 300_000);

export interface Migration {
  name: string;
  path: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export const checksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // zero-padded numeric prefixes, so lexical order is application order
  return files.map((name) => {
    const path = join(dir, name);
    const sql = readFileSync(path, "utf8");
    return {
      name,
      path,
      sql,
      checksum: checksum(sql),
      transactional: !NON_TRANSACTIONAL.test(sql),
    };
  });
}

async function ledgerExists(sql: Client): Promise<boolean> {
  const { rows } = await sql.query<{ present: boolean }>(
    `select to_regclass('public.${LEDGER_TABLE}') is not null as present`,
  );
  return rows[0]?.present ?? false;
}

async function migrationRoleExists(sql: Client): Promise<boolean> {
  const { rows } = await sql.query<{ present: boolean }>(
    `select exists (select 1 from pg_roles where rolname = '${MIGRATION_ROLE}') as present`,
  );
  return rows[0]?.present ?? false;
}

/**
 * Create the ledger and its comment as one exception-protected operation.
 *
 * `CREATE TABLE IF NOT EXISTS` followed by an unconditional `COMMENT` is not idempotent
 * across owners: COMMENT still requires ownership when another administrator runs the
 * chain later. Catching duplicate_table keeps the comment on the creation path only, and
 * also closes the race between two first invocations.
 *
 * The caller determines ownership. applyMigrations always calls this after switching to
 * migration_role.
 */
export async function ensureLedger(sql: Client): Promise<void> {
  await sql.query(`
    do $policyoffice_ledger$
    begin
      begin
        create table public.${LEDGER_TABLE} (
          name        text        primary key,
          checksum    text        not null,
          applied_at  timestamptz not null default now(),
          duration_ms integer     not null
        );
        comment on table public.${LEDGER_TABLE} is
          'Applied migrations and their checksums. Runner bookkeeping, not modelled state -- excluded from the drift check.';
      exception
        when duplicate_table then null;
      end;
    end
    $policyoffice_ledger$;
  `);
}

export async function appliedMigrations(sql: Client): Promise<Map<string, AppliedMigration>> {
  if (!(await ledgerExists(sql))) return new Map();
  return readAppliedMigrations(sql);
}

async function readAppliedMigrations(sql: Client): Promise<Map<string, AppliedMigration>> {
  const { rows } = await sql.query<{ name: string; checksum: string; applied_at: Date }>(
    `select name, checksum, applied_at from public.${LEDGER_TABLE} order by name`,
  );
  return new Map(
    rows.map((r) => [r.name, { name: r.name, checksum: r.checksum, appliedAt: r.applied_at }]),
  );
}

/**
 * Give the administrative session an explicit SET-only path into migration_role and give
 * that role the database/schema privileges needed by all migrations.
 *
 * PostgreSQL 16 separated ADMIN from SET on role memberships. The role creator therefore
 * has enough authority to administer migration_role but cannot necessarily SET ROLE until
 * this explicit grant is made. INHERIT stays false so the administrative session never
 * owns objects accidentally merely by holding the membership.
 */
async function assertAdministrativeConnection(sql: Client): Promise<void> {
  const { rows } = await sql.query<{ session_user: string }>("select session_user");
  if (rows[0]?.session_user === MIGRATION_ROLE) {
    throw new Error(
      [
        "Migrations require an administrative connection, not migration_role.",
        "The administrator bootstraps roles and explicitly SET ROLEs for DDL;",
        "migration_role remains NOSUPERUSER NOBYPASSRLS and owns the created objects.",
      ].join(" "),
    );
  }
}

async function prepareMigrationRole(sql: Client): Promise<void> {
  await assertAdministrativeConnection(sql);
  await sql.query(`
    do $policyoffice_database_grant$
    begin
      execute format(
        'grant connect, create on database %I to ${MIGRATION_ROLE}',
        current_database()
      );
    end
    $policyoffice_database_grant$;
  `);
  await sql.query(`grant usage, create on schema public to ${MIGRATION_ROLE} with grant option`);
  await sql.query(`
    do $policyoffice_set_grant$
    begin
      execute format(
        'grant ${MIGRATION_ROLE} to %I with set true, inherit false',
        session_user
      );
    end
    $policyoffice_set_grant$;
  `);
}

/** Move ledgers created by the old runner off their administrative/superuser owner. */
async function normalizeLedgerOwner(sql: Client): Promise<void> {
  const { rows } = await sql.query<{ owner: string }>(`
    select pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = '${LEDGER_TABLE}'
       and c.relkind = 'r'
  `);
  const owner = rows[0]?.owner;
  if (owner && owner !== MIGRATION_ROLE) {
    await sql.query(`alter table public.${LEDGER_TABLE} owner to ${MIGRATION_ROLE}`);
  }
}

async function asMigrationRole<T>(sql: Client, fn: () => Promise<T>): Promise<T> {
  await sql.query(`set role ${MIGRATION_ROLE}`);
  try {
    return await fn();
  } finally {
    await sql.query("reset role");
  }
}

export class MigrationTamperedError extends Error {
  constructor(
    readonly migration: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      [
        `Migration ${migration} has changed since it was applied.`,
        `  applied checksum: ${expected}`,
        `  file checksum:    ${actual}`,
        "",
        "ADR-0009 makes a merged migration immutable. Editing one means this database and",
        "every other database built from this chain now have different schemas, and nothing",
        "else would detect it.",
        "",
        "A correction is a NEW migration. There is no down path, by design.",
      ].join("\n"),
    );
    this.name = "MigrationTamperedError";
  }
}

export interface ApplyResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply every pending migration, in order.
 *
 * Idempotent by ledger rather than by luck: an already-applied migration is verified
 * against its recorded checksum and skipped.
 */
export async function applyMigrations(
  sql: Client,
  dir: string = MIGRATIONS_DIR,
  log: (line: string) => void = () => {},
): Promise<ApplyResult> {
  await sql.query(`set lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await sql.query(`set statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  // Fail before inspecting the ledger or running 0001. On a clean database there is no
  // ledger yet, but migration_role still cannot bootstrap or alter itself.
  await assertAdministrativeConnection(sql);

  const migrations = readMigrations(dir);
  let hasLedger = await ledgerExists(sql);
  let rolePrepared = false;
  let already = new Map<string, AppliedMigration>();

  if (hasLedger) {
    if (!(await migrationRoleExists(sql))) {
      throw new Error(`${LEDGER_TABLE} exists but ${MIGRATION_ROLE} does not`);
    }
    await prepareMigrationRole(sql);
    rolePrepared = true;
    await normalizeLedgerOwner(sql);
    already = await asMigrationRole(sql, () => readAppliedMigrations(sql));
  }

  const result: ApplyResult = { applied: [], alreadyApplied: [] };

  for (const migration of migrations) {
    const record = already.get(migration.name);
    if (record) {
      if (record.checksum !== migration.checksum) {
        throw new MigrationTamperedError(migration.name, record.checksum, migration.checksum);
      }
      result.alreadyApplied.push(migration.name);
      continue;
    }

    const started = Date.now();
    const bootstrapsRoles = migration.name === ROLE_BOOTSTRAP_MIGRATION;
    if (migration.transactional) {
      await sql.query("begin");
      try {
        if (bootstrapsRoles) {
          // A role cannot create or constrain itself. This is the administrative
          // connection's sole DDL exception; 0001 creates roles but no owned objects.
          await sql.query(migration.sql);
          await prepareMigrationRole(sql);
          rolePrepared = true;
        } else {
          if (!rolePrepared) {
            if (!(await migrationRoleExists(sql))) {
              throw new Error(
                `${MIGRATION_ROLE} does not exist; apply ${ROLE_BOOTSTRAP_MIGRATION} first`,
              );
            }
            await prepareMigrationRole(sql);
            rolePrepared = true;
          }
          await sql.query(`set local role ${MIGRATION_ROLE}`);
        }

        // The ledger is created by migration_role, including on a completely clean
        // database where 0001 had to run before the role existed.
        await sql.query(`set local role ${MIGRATION_ROLE}`);
        if (!hasLedger) {
          await ensureLedger(sql);
          hasLedger = true;
        }

        if (!bootstrapsRoles) await sql.query(migration.sql);

        // Merged migrations 0003 and 0004 explicitly RESET ROLE at the end. They are
        // immutable, so re-establish the runner convention before touching its ledger.
        await sql.query(`set local role ${MIGRATION_ROLE}`);
        await recordApplied(sql, migration, Date.now() - started);
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    } else {
      if (bootstrapsRoles) {
        throw new Error(`${ROLE_BOOTSTRAP_MIGRATION} must remain transactional`);
      }
      if (!rolePrepared) {
        if (!(await migrationRoleExists(sql))) {
          throw new Error(
            `${MIGRATION_ROLE} does not exist; apply ${ROLE_BOOTSTRAP_MIGRATION} first`,
          );
        }
        await prepareMigrationRole(sql);
        rolePrepared = true;
      }
      if (!hasLedger) {
        await sql.query("begin");
        try {
          await sql.query(`set local role ${MIGRATION_ROLE}`);
          await ensureLedger(sql);
          await sql.query("commit");
          hasLedger = true;
        } catch (error) {
          await sql.query("rollback");
          throw error;
        }
      }

      // Unwrapped, and alone. If this fails partway there is no rollback -- the recovery
      // is a forward migration, which is what ADR-0009 asks for rather than pretending
      // otherwise.
      await asMigrationRole(sql, async () => {
        await sql.query(migration.sql);
        // A legacy migration may have RESET ROLE. Restore the central convention before
        // recording the checksum.
        await sql.query(`set role ${MIGRATION_ROLE}`);
        await recordApplied(sql, migration, Date.now() - started);
      });
    }
    log(`applied ${migration.name} (${Date.now() - started}ms)`);
    result.applied.push(migration.name);
  }
  return result;
}

async function recordApplied(sql: Client, migration: Migration, durationMs: number): Promise<void> {
  await sql.query(
    `insert into public.${LEDGER_TABLE} (name, checksum, duration_ms) values ($1, $2, $3)`,
    [migration.name, migration.checksum, durationMs],
  );
}

export interface StatusLine {
  name: string;
  state: "applied" | "pending" | "changed";
}

export async function status(sql: Client, dir: string = MIGRATIONS_DIR): Promise<StatusLine[]> {
  const migrations = readMigrations(dir);
  if (!(await ledgerExists(sql))) {
    return migrations.map((m) => ({ name: m.name, state: "pending" as const }));
  }
  if (!(await migrationRoleExists(sql))) {
    throw new Error(`${LEDGER_TABLE} exists but ${MIGRATION_ROLE} does not`);
  }
  await prepareMigrationRole(sql);
  await normalizeLedgerOwner(sql);
  const already = await asMigrationRole(sql, () => readAppliedMigrations(sql));
  return migrations.map((m) => {
    const record = already.get(m.name);
    if (!record) return { name: m.name, state: "pending" as const };
    return { name: m.name, state: record.checksum === m.checksum ? "applied" : "changed" };
  });
}

/** Next zero-padded sequence number, so ordering stays lexical. */
export function nextMigrationName(slug: string, dir: string = MIGRATIONS_DIR): string {
  const existing = readMigrations(dir);
  const last = existing.at(-1);
  const n = last ? Number(last.name.slice(0, 4)) + 1 : 1;
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${String(n).padStart(4, "0")}_${safe || "migration"}.sql`;
}

export function createMigration(slug: string, dir: string = MIGRATIONS_DIR): string {
  const name = nextMigrationName(slug, dir);
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      `-- ${name}`,
      "--",
      "-- Forward-only. Once merged this file is immutable: the runner records its checksum",
      "-- and refuses to proceed if it changes. A correction is a new migration.",
      "--",
      `-- The runner executes this file as ${MIGRATION_ROLE}; do not SET or RESET ROLE here.`,
      "--",
      "-- Every constraint carrying an invariant states which one, where the enforcement is:",
      "--",
      "--   comment on constraint one_effective_version_per_variant on document_version is",
      "--     'INV-EFF-002: at most one version of a variant claims any instant';",
      "--",
      "-- Uncomment for CREATE INDEX CONCURRENTLY, which cannot run inside a transaction:",
      "-- policyoffice:non-transactional",
      "",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}
