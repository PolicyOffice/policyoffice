import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSession } from "@policyoffice/domain";
import { withAppRole } from "@policyoffice/testing";
import { withTenantTransaction, type TenantContext } from "./application-transaction.js";
import { authorizationDataLoader } from "./authorization.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";
import { appUser } from "./schema.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (!tenantA || !tenantB) throw new Error("the test fixture requires two tenants");

const TENANT_A = tenantA.tenant.id;
const TENANT_B = tenantB.tenant.id;
const USER_A = tenantA.users[0]?.id ?? "";
const USER_B = tenantB.users[0]?.id ?? "";
const ABSENT_USER = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const INSTANT = new Date("2026-09-11T09:00:00.000Z");

const context = (tenantId: string, principalId: string): TenantContext =>
  Object.freeze({
    tenantId,
    principal: Object.freeze({ type: "USER", id: principalId }),
  });

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("the application transaction boundary under forced RLS", () => {
  it("INV-TEN-004: yields one app_role handle to domain, authorization, and Drizzle", async () => {
    const observed = await withTenantTransaction(context(TENANT_A, USER_A), async (transaction) => {
      const role = await transaction.query<{ role: string; tenant_id: string }>(
        `select current_user as role, current_setting('app.tenant_id') as tenant_id`,
      );
      const users = await transaction.drizzle
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.id, USER_A));
      const session = await issueSession(transaction, {
        tenantId: TENANT_A,
        userId: USER_A,
        userAgentClass: "POL-030 integration test",
        instant: INSTANT,
      });
      const facts = await authorizationDataLoader(transaction)({
        tenantId: TENANT_A,
        principal: transaction.context.principal,
        instant: INSTANT,
        resource: { tenantId: TENANT_A, type: "TENANT", id: null },
      });
      return { role: role.rows, users, session, facts };
    });

    expect(observed.role).toEqual([{ role: "app_role", tenant_id: TENANT_A }]);
    expect(observed.users).toEqual([{ id: USER_A }]);
    expect(observed.session.principal).toEqual({ type: "USER", id: USER_A });
    expect(observed.facts).toMatchObject({ resourceFound: true, principalActive: true });
  });

  it("INV-TEN-004: clears SET LOCAL before the same connection is reused", async () => {
    await withAppRole(async (sql) => {
      type ConnectionSource = NonNullable<Parameters<typeof withTenantTransaction>[2]>;
      const source: ConnectionSource = { connect: async () => sql };

      await withTenantTransaction(
        context(TENANT_A, USER_A),
        async (transaction) => {
          const setting = await transaction.query<{ tenant_id: string }>(
            `select current_setting('app.tenant_id') as tenant_id`,
          );
          expect(setting.rows).toEqual([{ tenant_id: TENANT_A }]);
        },
        source,
      );

      const afterFirst = await sql.query<{ tenant_id: string | null }>(
        `select nullif(current_setting('app.tenant_id', true), '') as tenant_id`,
      );
      expect(afterFirst.rows).toEqual([{ tenant_id: null }]);

      await withTenantTransaction(
        context(TENANT_B, USER_B),
        async (transaction) => {
          const setting = await transaction.query<{ tenant_id: string }>(
            `select current_setting('app.tenant_id') as tenant_id`,
          );
          expect(setting.rows).toEqual([{ tenant_id: TENANT_B }]);
        },
        source,
      );

      const afterSecond = await sql.query<{ tenant_id: string | null }>(
        `select nullif(current_setting('app.tenant_id', true), '') as tenant_id`,
      );
      expect(afterSecond.rows).toEqual([{ tenant_id: null }]);
    });
  });

  it("INV-TEN-001 / INV-TEN-002: makes a foreign user indistinguishable from an absent one", async () => {
    await withTenantTransaction(context(TENANT_A, USER_A), async (transaction) => {
      const foreign = await transaction.query<{ id: string }>(
        "select id from app_user where id = $1",
        [USER_B],
      );
      const absent = await transaction.query<{ id: string }>(
        "select id from app_user where id = $1",
        [ABSENT_USER],
      );

      expect(foreign.rows).toEqual([]);
      expect(foreign).toEqual(absent);
    });
  });
});
