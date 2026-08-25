/**
 * Database connections for integration tests.
 *
 * One finding governs the design of this file more than anything else. From
 * `verification/README.md`, finding 2:
 *
 *   FORCE ROW LEVEL SECURITY binds the table owner but NOT a superuser. A cross-tenant
 *   negative test run as `postgres` passes while proving nothing.
 *
 * And its Neon counterpart, finding 5: the role the platform provisions for you
 * (`neondb_owner`) holds BYPASSRLS, so the same trap exists in production's default
 * configuration.
 *
 * A test suite that gets this wrong is worse than no test suite, because it reports green
 * over an unenforced tenancy model. So the connecting role is a property of the harness,
 * not something each test is trusted to remember:
 *
 *   - `withAppRole` is the default and what every behavioural test should use.
 *   - The privileged helpers are named so they cannot be used quietly. `__PRIVILEGED` and
 *     `__BYPASSES_RLS` appear in the diff, in the review, and in a grep.
 *   - Using a privileged connection anywhere in a test whose name cites a tenancy or
 *     authorization invariant FAILS that test. See `assertNoPrivilegedEscape`.
 */
import { Client } from "pg";

export type Sql = Client;

/**
 * Connection strings, defaulting to the Docker Compose environment so that tests run from
 * a clean clone with no configuration. CI overrides them to point at its service
 * container; nothing else differs (`ADR-0009`).
 */
const url = (name: string, fallback: string): string => process.env[name] ?? fallback;

const APP_URL = () =>
  url("TEST_DATABASE_URL_APP", "postgres://app_role:app_role@localhost:5432/policyoffice");
const MIGRATION_URL = () =>
  url(
    "TEST_DATABASE_URL_MIGRATION",
    "postgres://migration_role:migration_role@localhost:5432/policyoffice",
  );
const SUPERUSER_URL = () =>
  url("TEST_DATABASE_URL_SUPERUSER", "postgres://postgres:postgres@localhost:5432/policyoffice");

/** Set whenever a privileged connection is opened, and read by `assertNoPrivilegedEscape`. */
let privilegedConnectionUsed: string | undefined;

/** Cleared between tests by the setup file. */
export function resetPrivilegeTracking(): void {
  privilegedConnectionUsed = undefined;
}

export function privilegedConnectionInThisTest(): string | undefined {
  return privilegedConnectionUsed;
}

async function connect(connectionString: string, role: string): Promise<Client> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (cause) {
    // Fail, never skip. A silently skipped integration suite is a green build that tested
    // nothing, which is the specific outcome this project cannot afford.
    throw new Error(
      [
        `Could not connect to Postgres as ${role}.`,
        "",
        "Integration tests run against a real database and are never skipped when one is",
        "absent -- a skipped suite reports green while proving nothing.",
        "",
        "Start it with:  docker compose up -d && ./verification/00-roles.sh",
        "",
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      ].join("\n"),
      { cause },
    );
  }
  return client;
}

async function using<T>(client: Client, fn: (sql: Sql) => Promise<T>): Promise<T> {
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The default. Connects as `app_role`: not the owner, not a superuser, subject to every
 * row-level security policy exactly as the running application is.
 */
export async function withAppRole<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return using(await connect(APP_URL(), "app_role"), fn);
}

/**
 * `app_role`, inside a transaction, with the tenant context set for its duration.
 *
 * `SET LOCAL` rather than `SET`, deliberately: it is scoped to the transaction, so it
 * cannot leak into the next one on a pooled connection (INV-TEN-005). Verified against
 * both Neon endpoints in `verification/neon.sh`.
 *
 * The transaction is always rolled back. That is the isolation mechanism -- tests cannot
 * see each other's rows regardless of execution order, and nothing needs truncating.
 */
export async function withTenant<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withAppRole(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      return await fn(sql);
    } finally {
      await sql.query("rollback");
    }
  });
}

/**
 * `app_role` with NO tenant context, inside a rolled-back transaction.
 *
 * For asserting that the absence of context fails closed (INV-TEN-001, INV-TEN-005).
 * Note that the error differs between a direct and a pooled connection -- see
 * `verification/README.md` finding 8 -- so assert that it *raises*, never which error.
 */
export async function withoutTenant<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withAppRole(async (sql) => {
    await sql.query("begin");
    try {
      return await fn(sql);
    } finally {
      await sql.query("rollback");
    }
  });
}

/**
 * DDL only. Named to be impossible to use by accident or to miss in review.
 *
 * `migration_role` owns the schema. It is not a superuser, so FORCE ROW LEVEL SECURITY
 * still binds it -- but it can create and drop objects, which no behavioural test should
 * be doing.
 */
export async function withMigrationRole__PRIVILEGED<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  privilegedConnectionUsed = "migration_role";
  return using(await connect(MIGRATION_URL(), "migration_role"), fn);
}

/**
 * The superuser. Almost nothing should need this.
 *
 * A superuser BYPASSES row-level security entirely, FORCE or not. Any tenancy or
 * authorization assertion made through this connection is worthless: it passes whether or
 * not the policy exists. `assertNoPrivilegedEscape` turns that from a convention into a
 * failing test.
 */
export async function withSuperuser__BYPASSES_RLS<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  privilegedConnectionUsed = "superuser (BYPASSES RLS)";
  return using(await connect(SUPERUSER_URL(), "postgres"), fn);
}
