import {
  buildFixtureSet,
  loadFixtureSet,
  removeFixtureSetForTests,
} from "../packages/db/src/fixtures.ts";
import { withTenantTransaction } from "../packages/db/src/application-transaction.ts";

export default async function globalSetup(): Promise<() => Promise<void>> {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
  const tenant = buildFixtureSet("test").tenants[0];
  const userId = tenant?.users[0]?.id;
  const authorRoleId = tenant?.securityRoles.find((role) => role.code === "AUTHOR")?.id;
  if (!tenant || !userId || !authorRoleId) {
    throw new Error("the browser fixture requires a tenant administrator and author role");
  }
  await withTenantTransaction(
    { tenantId: tenant.tenant.id, principal: { type: "USER", id: userId } },
    async (transaction) => {
      await transaction.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, security_role_id,
           scope_type, scope_id, validity, granted_by, reason
         ) values (
           $1, 'a0000000-0000-0000-0025-000000000002', 'ALLOW', 'USER', $2,
           $3, 'TENANT', null, tstzrange($4::timestamptz, null, '[)'),
           $2, 'POL-033 browser author fixture'
         )`,
        [tenant.tenant.id, userId, authorRoleId, buildFixtureSet("test").createdAt],
      );
    },
  );
  return async () => removeFixtureSetForTests("test");
}
