/**
 * Developer commands. They run against Docker Compose with no arguments beyond what
 * `.env.example` already provides.
 *
 *   pnpm --filter @policyoffice/db migrate         apply everything pending
 *   pnpm --filter @policyoffice/db migrate:status  what is applied, pending, or changed
 *   pnpm --filter @policyoffice/db migrate:new x   create the next migration file
 *
 * There is no revert command, and there is no down migration to revert to. See runner.ts.
 */
import { Client } from "pg";
import { migrationDatabaseUrl } from "./migration-connection.js";
import { applyMigrations, createMigration, MigrationTamperedError, status } from "./runner.js";

async function withClient<T>(fn: (sql: Client) => Promise<T>): Promise<T> {
  const sql = new Client({ connectionString: migrationDatabaseUrl() });
  try {
    await sql.connect();
  } catch (cause) {
    throw new Error(
      [
        "Could not open the administrative migration connection.",
        "",
        "Start the local environment with:",
        "  docker compose up -d",
        "",
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      ].join("\n"),
      { cause },
    );
  }
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const command = process.argv[2];

try {
  if (command === "apply") {
    const result = await withClient((sql) =>
      applyMigrations(sql, undefined, (l) => console.log(l)),
    );
    console.log(
      result.applied.length
        ? `applied ${result.applied.length} migration(s)`
        : `nothing to apply; ${result.alreadyApplied.length} already applied`,
    );
  } else if (command === "status") {
    const lines = await withClient((sql) => status(sql));
    for (const line of lines) console.log(`${line.state.padEnd(8)} ${line.name}`);
    if (lines.some((l) => l.state === "changed")) {
      console.error("\nA migration has changed since it was applied. See ADR-0009.");
      process.exit(1);
    }
  } else if (command === "new") {
    const slug = process.argv[3];
    if (!slug) throw new Error("usage: migrate:new <slug>");
    console.log(`created ${createMigration(slug)}`);
  } else {
    console.error("usage: cli.ts <apply|status|new>");
    process.exit(2);
  }
} catch (error) {
  if (error instanceof MigrationTamperedError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
