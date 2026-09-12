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
  if (!tenant || !userId) throw new Error("the browser fixture requires a tenant administrator");
  await withTenantTransaction(
    { tenantId: tenant.tenant.id, principal: { type: "USER", id: userId } },
    async (transaction) => {
      await transaction.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, capability,
           scope_type, scope_id, validity, granted_by, reason
         ) values (
           $1, 'a0000000-0000-0000-0025-000000000002', 'ALLOW', 'USER', $2,
           'document.read', 'TENANT', null, tstzrange($3::timestamptz, null, '[)'),
           $2, 'POL-032 browser fixture'
         )`,
        [tenant.tenant.id, userId, buildFixtureSet("test").createdAt],
      );
    },
  );
  return async () => removeFixtureSetForTests("test");
}
