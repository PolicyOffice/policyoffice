/**
 * The harness's own regression tests.
 *
 * These exist because the harness is what makes every later tenancy assertion mean
 * something. If `withAppRole` ever quietly connects as the owner, or a missing tenant
 * context stops raising, the entire integration suite goes on reporting green over an
 * unenforced model -- which is precisely how the first run of `02-tenancy.sh` passed
 * while proving nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAppRole, withMigrationRole__PRIVILEGED, withTenant, withoutTenant } from "./index.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
  // Schema setup is legitimately privileged. It happens here, never inside a test that
  // asserts an isolation property -- the guard in guard.ts enforces that distinction.
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("drop schema if exists t04 cascade");
    await sql.query("create schema t04");
    await sql.query("grant usage on schema t04 to app_role");
    await sql.query(`create table t04.doc (
      tenant_id uuid not null,
      id        uuid not null default gen_random_uuid(),
      title     text not null,
      primary key (tenant_id, id)
    )`);
    // Seed BEFORE enabling row-level security, deliberately. FORCE binds the owner too,
    // so once the policy is on, even migration_role cannot insert a row for a tenant it
    // has no context for. That is the property under test; here it is just the reason
    // fixtures come first.
    await sql.query("insert into t04.doc (tenant_id, title) values ($1,$2), ($3,$4)", [
      TENANT_A,
      "tenant A doc",
      TENANT_B,
      "tenant B doc",
    ]);
    await sql.query("alter table t04.doc enable row level security");
    await sql.query("alter table t04.doc force row level security");
    await sql.query(
      `create policy tenant_isolation on t04.doc
         using (tenant_id = current_setting('app.tenant_id')::uuid)`,
    );
    await sql.query("grant select, insert on t04.doc to app_role");
  });
});

afterAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("drop schema if exists t04 cascade");
  });
});

describe("the connecting role", () => {
  it("is app_role by default, and is neither a superuser nor a bypasser", async () => {
    // The harness's single most important property. Everything else assumes it.
    const { rows } = await withAppRole((sql) =>
      sql.query(
        `select current_user as who,
                current_setting('is_superuser') as su,
                (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
      ),
    );
    expect(rows[0]).toMatchObject({ who: "app_role", su: "off", bypass: false });
  });
});

// Proves the HARNESS enforces isolation, on a fixture table it created. Deliberately
// does not name INV-TEN-001 in the title: the coverage gate reads titles, and claiming
// that invariant here would mark it covered while the product has no tables at all.
// The invariant's own tests arrive with the schema (POL-006), and the register shrinks
// then.
describe("the harness: row-level security applies to app_role", () => {
  it("returns only the current tenant's rows", async () => {
    const a = await withTenant(TENANT_A, (sql) => sql.query("select title from t04.doc"));
    const b = await withTenant(TENANT_B, (sql) => sql.query("select title from t04.doc"));
    expect(a.rows).toEqual([{ title: "tenant A doc" }]);
    expect(b.rows).toEqual([{ title: "tenant B doc" }]);
  });

  it("returns only the current tenant even with no WHERE clause", async () => {
    // The forgotten predicate has to be survivable, or isolation depends on every query
    // being written correctly forever.
    const { rows } = await withTenant(TENANT_A, (sql) =>
      sql.query("select count(*)::int as n from t04.doc"),
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("the harness: absent tenant context fails closed", () => {
  it("raises rather than returning rows", async () => {
    // Assert only that it raises. verification/README.md finding 8: the error differs
    // between a direct and a pooled connection, so matching on it would pass locally and
    // behave differently in production.
    await expect(
      withoutTenant((sql) => sql.query("select count(*) from t04.doc")),
    ).rejects.toThrow();
  });
});

describe("the harness: another tenant's identifier is not-found, never forbidden", () => {
  it("returns zero rows and no error for a real id from another tenant", async () => {
    const { rows } = await withTenant(TENANT_B, (sql) => sql.query("select id from t04.doc"));
    const bId: unknown = rows[0]?.id;
    const seen = await withTenant(TENANT_A, (sql) =>
      sql.query("select count(*)::int as n from t04.doc where id = $1", [bId]),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });
});

describe("test isolation", () => {
  it("does not leak writes to other tests, whatever the order", async () => {
    await withTenant(TENANT_A, (sql) =>
      sql.query("insert into t04.doc (tenant_id, title) values ($1,$2)", [TENANT_A, "scratch"]),
    );
    const { rows } = await withTenant(TENANT_A, (sql) =>
      sql.query("select count(*)::int as n from t04.doc where title = 'scratch'"),
    );
    // The insert above committed nothing: withTenant always rolls back.
    expect(rows[0]?.n).toBe(0);
  });
});

describe("the harness: the suite does not run in UTC", () => {
  it("uses a timezone that would expose a UTC assumption", () => {
    expect(process.env.TZ).toBe("Europe/Tallinn");
    expect(new Date("2027-07-01T12:00:00Z").getHours()).not.toBe(12);
  });
});
