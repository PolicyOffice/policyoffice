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

export async function ensureLedger(sql: Client): Promise<void> {
  await sql.query(`
    create table if not exists ${LEDGER_TABLE} (
      name        text        primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer     not null
    )`);
  await sql.query(
    `comment on table ${LEDGER_TABLE} is
       'Applied migrations and their checksums. Runner bookkeeping, not modelled state -- excluded from the drift check.'`,
  );
}

export async function appliedMigrations(sql: Client): Promise<Map<string, AppliedMigration>> {
  await ensureLedger(sql);
  const { rows } = await sql.query<{ name: string; checksum: string; applied_at: Date }>(
    `select name, checksum, applied_at from ${LEDGER_TABLE} order by name`,
  );
  return new Map(
    rows.map((r) => [r.name, { name: r.name, checksum: r.checksum, appliedAt: r.applied_at }]),
  );
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

  const already = await appliedMigrations(sql);
  const result: ApplyResult = { applied: [], alreadyApplied: [] };

  for (const migration of readMigrations(dir)) {
    const record = already.get(migration.name);
    if (record) {
      if (record.checksum !== migration.checksum) {
        throw new MigrationTamperedError(migration.name, record.checksum, migration.checksum);
      }
      result.alreadyApplied.push(migration.name);
      continue;
    }

    const started = Date.now();
    if (migration.transactional) {
      await sql.query("begin");
      try {
        await sql.query(migration.sql);
        await recordApplied(sql, migration, Date.now() - started);
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    } else {
      // Unwrapped, and alone. If this fails partway there is no rollback -- the recovery
      // is a forward migration, which is what ADR-0009 asks for rather than pretending
      // otherwise.
      await sql.query(migration.sql);
      await recordApplied(sql, migration, Date.now() - started);
    }
    log(`applied ${migration.name} (${Date.now() - started}ms)`);
    result.applied.push(migration.name);
  }
  return result;
}

async function recordApplied(sql: Client, migration: Migration, durationMs: number): Promise<void> {
  await sql.query(`insert into ${LEDGER_TABLE} (name, checksum, duration_ms) values ($1, $2, $3)`, [
    migration.name,
    migration.checksum,
    durationMs,
  ]);
}

export interface StatusLine {
  name: string;
  state: "applied" | "pending" | "changed";
}

export async function status(sql: Client, dir: string = MIGRATIONS_DIR): Promise<StatusLine[]> {
  const already = await appliedMigrations(sql);
  return readMigrations(dir).map((m) => {
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
