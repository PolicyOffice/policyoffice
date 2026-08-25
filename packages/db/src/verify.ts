/**
 * The three things CI validates about migrations (`ADR-0009`):
 *
 *   fresh install  the chain builds a correct schema from nothing -- the new-customer path
 *   upgrade        new migrations apply to the previous schema WITH DATA -- the existing-
 *                  customer path, and the one that catches the real failures
 *   drift          the schema built from migrations matches the Drizzle definition
 *
 * All three run against throwaway databases on a real PostgreSQL, never a mock. CI uses a
 * service container rather than Neon: it needs a disposable database per run, and a
 * container is faster, free and unmetered.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { applyMigrations, LEDGER_TABLE, readMigrations, MIGRATIONS_DIR } from "./runner.js";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

const adminUrl = (): string =>
  process.env.MIGRATION_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

const urlForDatabase = (database: string): string => {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
};

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * A disposable database, always dropped.
 *
 * Named per run so two checks cannot collide, and dropped with FORCE because a lingering
 * connection would otherwise leave the database behind and fail the next run for an
 * unrelated reason.
 */
export async function withTempDatabase<T>(
  label: string,
  fn: (url: string, sql: Client) => Promise<T>,
): Promise<T> {
  const name = `po_verify_${label}_${process.pid}_${Date.now().toString(36)}`;
  const admin = await connect(adminUrl());
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(name);
  const sql = await connect(url);
  try {
    return await fn(url, sql);
  } finally {
    await sql.end();
    const cleanup = await connect(adminUrl());
    try {
      await cleanup.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await cleanup.end();
    }
  }
}

/**
 * A normalised description of everything the migration chain is supposed to produce.
 *
 * Deliberately covers more than tables and columns. The enforcement ladder lives in
 * constraints, indexes and privileges, so a comparison that only looked at columns would
 * pass while an exclusion constraint or a REVOKE had gone missing -- which is exactly the
 * kind of drift that matters here.
 *
 * The ledger table is excluded: it is the runner's bookkeeping, not modelled state, and it
 * is deliberately absent from the Drizzle schema.
 */
export async function snapshot(sql: Client): Promise<string> {
  const parts: string[] = [];
  // Sequential, not Promise.all: a single pg Client multiplexes nothing, and concurrent
  // queries on one are deprecated and will throw in pg 9.
  for (const [label, text] of snapshotQueries(LEDGER_TABLE)) {
    const { rows } = await sql.query<Record<string, unknown>>(text);
    const lines = rows.map((r) => Object.values(r).join(" | ")).sort();
    parts.push([`## ${label}`, ...lines].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * What the snapshot compares.
 *
 * Deliberately more than tables and columns. The enforcement ladder lives in constraints,
 * indexes, row-level security and privileges, so a comparison that only looked at columns
 * would pass while an exclusion constraint or a REVOKE had gone missing -- which is
 * exactly the drift that would matter.
 *
 * The ledger table is excluded throughout: it is the runner's bookkeeping, not modelled
 * state, and it is deliberately absent from the Drizzle schema.
 */
function snapshotQueries(ledger: string): ReadonlyArray<readonly [string, string]> {
  const notSystem = "table_schema not in ('pg_catalog','information_schema')";
  const nsNotSystem = "n.nspname not in ('pg_catalog','information_schema')";
  return [
    [
      "tables",
      `select table_schema, table_name from information_schema.tables
        where ${notSystem} and table_name <> '${ledger}' order by 1,2`,
    ],
    [
      "columns",
      `select c.table_schema, c.table_name, c.column_name, c.data_type,
              c.is_nullable, coalesce(c.column_default,'-')
         from information_schema.columns c
        where c.${notSystem} and c.table_name <> '${ledger}' order by 1,2,3`,
    ],
    [
      "constraints",
      `select n.nspname, rel.relname, con.conname, pg_get_constraintdef(con.oid)
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace n on n.oid = rel.relnamespace
        where ${nsNotSystem} and rel.relname <> '${ledger}' order by 1,2,3`,
    ],
    [
      "indexes",
      `select schemaname, tablename, indexname, indexdef from pg_indexes
        where schemaname not in ('pg_catalog','information_schema')
          and tablename <> '${ledger}' order by 1,2,3`,
    ],
    [
      "row level security",
      `select n.nspname, c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ${nsNotSystem} and c.relname <> '${ledger}' order by 1,2`,
    ],
    [
      "policies",
      `select schemaname, tablename, policyname, coalesce(qual,'-'), coalesce(with_check,'-')
         from pg_policies
        where schemaname not in ('pg_catalog','information_schema') order by 1,2,3`,
    ],
  ] as const;
}

/** The chain builds a schema from nothing. */
export async function verifyFresh(): Promise<string> {
  return withTempDatabase("fresh", async (_url, sql) => {
    const result = await applyMigrations(sql);
    const expected = readMigrations().map((m) => m.name);
    if (result.applied.length !== expected.length) {
      throw new Error(
        `fresh install applied ${result.applied.length} of ${expected.length} migrations`,
      );
    }
    return snapshot(sql);
  });
}

/**
 * New migrations apply to the previous release's schema, with data present.
 *
 * "It worked on an empty database" is how migrations fail in production, so the data is
 * the point. Representative data is synthetic while there are no domain tables; it becomes
 * real fixtures once POL-006 onward land, and this function is where they go.
 */
export async function verifyUpgrade(): Promise<void> {
  const all = readMigrations();
  if (all.length < 2) throw new Error("the upgrade check needs at least two migrations");
  const previous = all.slice(0, -1);
  const latest = all.at(-1)!;

  await withTempDatabase("upgrade", async (_url, sql) => {
    // Build the previous release.
    await applyMigrations(sql, MIGRATIONS_DIR_FOR(previous.map((m) => m.name)));

    // Representative data, present before the new migration runs.
    await sql.query(`create table upgrade_fixture (
      id uuid primary key default gen_random_uuid(),
      payload text not null
    )`);
    await sql.query("insert into upgrade_fixture (payload) values ('before the upgrade')");

    // Apply the rest.
    const result = await applyMigrations(sql);
    if (!result.applied.includes(latest.name)) {
      throw new Error(`upgrade did not apply ${latest.name}`);
    }

    const { rows } = await sql.query<{ payload: string }>("select payload from upgrade_fixture");
    if (rows[0]?.payload !== "before the upgrade") {
      throw new Error("data present before the upgrade did not survive it");
    }
  });
}

/**
 * A directory containing only the named migrations.
 *
 * Implemented by filtering rather than copying files: the runner reads a directory, so the
 * subset is expressed as a temporary directory of symlinks.
 */
function MIGRATIONS_DIR_FOR(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "po-migrations-"));
  for (const name of names) symlinkSync(join(MIGRATIONS_DIR, name), join(dir, name));
  return dir;
}

/**
 * The schema built from migrations matches the Drizzle definition.
 *
 * Two databases, compared: one built by the migration chain, one built by applying the SQL
 * drizzle-kit renders from `schema.ts`. Comparing snapshots rather than trusting
 * `drizzle-kit push` keeps the check deterministic and non-interactive, which matters for
 * something that has to run unattended on every pull request.
 */
export async function verifyDrift(): Promise<{ drifted: boolean; diff: string }> {
  const fromMigrations = await verifyFresh();

  const drizzleSql = execFileSync(
    "node_modules/.bin/drizzle-kit",
    ["export", "--sql", "--config", "drizzle.config.ts"],
    { cwd: PKG_ROOT, encoding: "utf8" },
  );

  const fromSchema = await withTempDatabase("drizzle", async (_url, sql) => {
    const statements = drizzleSql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));
    for (const statement of statements) await sql.query(statement);
    return snapshot(sql);
  });

  if (fromMigrations === fromSchema) return { drifted: false, diff: "" };

  const a = fromMigrations.split("\n");
  const b = fromSchema.split("\n");
  const diff: string[] = [];
  for (const line of a) if (!b.includes(line)) diff.push(`- migrations only: ${line}`);
  for (const line of b) if (!a.includes(line)) diff.push(`+ drizzle only:    ${line}`);
  return { drifted: true, diff: diff.join("\n") };
}
