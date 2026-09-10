import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type Sql } from "@policyoffice/testing";
import {
  AuthzContext,
  decide,
  type AuthorizationPrincipalType,
  type AuthorizationScopeType,
  type Capability,
  type GrantEffect,
  type ResourceRef,
} from "../../domain/src/authorization.js";
import { authorizationDataLoader, type AuthorizationTransaction } from "./authorization.js";
import { buildFixtureSet, loadFixtureSet, removeFixtureSetForTests } from "./fixtures.js";

const fixture = buildFixtureSet("test");
const tenantA = fixture.tenants[0];
const tenantB = fixture.tenants[1];
if (tenantA === undefined || tenantB === undefined)
  throw new Error("test fixture needs two tenants");

const TENANT_A = tenantA.tenant.id;
const TENANT_B = tenantB.tenant.id;
const USER_A = tenantA.users[0]?.id ?? "";
const DOCUMENT_A = tenantA.documents[0]?.id ?? "";
const VERSION_A = tenantA.documents[0]?.draftVersionId ?? "";
const DOCUMENT_B = tenantB.documents[0]?.id ?? "";
const ENTITY_A = tenantA.legalEntity.id;
const UNIT_A = tenantA.orgUnit.id;
const DOCUMENT_TYPE_A = tenantA.documentTypes[0]?.id ?? "";
const NOW = new Date("2030-01-02T12:00:00.000Z");

const ABSENT_DOCUMENT = "30000000-0000-0000-0000-000000000001";
const INVITED_USER = "30000000-0000-0000-0001-000000000001";
const DEACTIVATED_USER = "30000000-0000-0000-0001-000000000002";
const EXPIRED_GROUP = "30000000-0000-0000-0002-000000000001";
const EXPIRED_MEMBERSHIP = "30000000-0000-0000-0003-000000000001";
const SIBLING_UNIT = "30000000-0000-0000-0004-000000000001";
const SIBLING_DOCUMENT = "30000000-0000-0000-0005-000000000001";

interface GrantInput {
  readonly id: string;
  readonly principalType?: AuthorizationPrincipalType;
  readonly principalId?: string;
  readonly effect?: GrantEffect;
  readonly capability?: Capability | null;
  readonly securityRoleId?: string | null;
  readonly scopeType?: AuthorizationScopeType;
  readonly scopeId?: string | null;
  readonly validFrom?: Date;
  readonly validUntil?: Date | null;
}

function transaction(sql: Sql): AuthorizationTransaction {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await sql.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

function countedTransaction(sql: Sql): {
  readonly transaction: AuthorizationTransaction;
  readonly queryCount: () => number;
  readonly statements: readonly string[];
} {
  let count = 0;
  const statements: string[] = [];
  return {
    transaction: {
      async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]) {
        count += 1;
        statements.push(text);
        const result = await sql.query(text, values);
        return { rows: result.rows as Row[] };
      },
    },
    queryCount: () => count,
    statements,
  };
}

function context(
  sql: AuthorizationTransaction,
  principalId = USER_A,
  principalType: AuthorizationPrincipalType = "USER",
  instant = NOW,
): AuthzContext {
  return new AuthzContext({
    tenantId: TENANT_A,
    principal: { type: principalType, id: principalId },
    instant,
    load: authorizationDataLoader(sql),
  });
}

async function insertGrant(sql: Sql, input: GrantInput): Promise<void> {
  await sql.query(
    `insert into access_grant (
       tenant_id, id, effect, principal_type, principal_id,
       security_role_id, capability, scope_type, scope_id,
       validity, granted_by, reason
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       tstzrange($10::timestamptz, $11::timestamptz, '[)'), $12,
       'Authorization evaluator integration fixture'
     )`,
    [
      TENANT_A,
      input.id,
      input.effect ?? "ALLOW",
      input.principalType ?? "USER",
      input.principalId ?? USER_A,
      input.securityRoleId ?? null,
      input.capability === undefined ? "document.read" : input.capability,
      input.scopeType ?? "TENANT",
      input.scopeId ?? null,
      input.validFrom ?? new Date("2029-01-01T00:00:00.000Z"),
      input.validUntil ?? null,
      USER_A,
    ],
  );
}

beforeAll(async () => {
  await removeFixtureSetForTests("test");
  await loadFixtureSet("test");
});

afterAll(async () => {
  await removeFixtureSetForTests("test");
});

describe("authorization evaluator under forced RLS", () => {
  it("INV-TEN-002 / INV-TEN-005: foreign and absent resources do the same fact-query work", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const foreignLoad = countedTransaction(sql);
      const absentLoad = countedTransaction(sql);

      await expect(
        decide(context(foreignLoad.transaction), "document.read", {
          tenantId: TENANT_B,
          type: "DOCUMENT",
          id: DOCUMENT_B,
        }),
      ).resolves.toEqual({ allowed: false, because: "WRONG_TENANT" });
      await expect(
        decide(context(absentLoad.transaction), "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: ABSENT_DOCUMENT,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });

      expect(foreignLoad.queryCount()).toBe(1);
      expect(absentLoad.queryCount()).toBe(1);
      expect(foreignLoad.statements).toEqual(absentLoad.statements);
    });
  });

  it("INV-AUTH-014: INVITED and DEACTIVATED principals cannot use retained valid grants", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `insert into app_user (
           tenant_id, id, display_name, contact_email, status, deactivated_at
         ) values
           ($1, $2, 'Invited evaluator user', 'evaluator-invited@example.test', 'INVITED', null),
           ($1, $3, 'Deactivated evaluator user', 'evaluator-deactivated@example.test',
            'DEACTIVATED', '2030-01-01T00:00:00Z')`,
        [TENANT_A, INVITED_USER, DEACTIVATED_USER],
      );

      for (const [index, principalId] of [INVITED_USER, DEACTIVATED_USER].entries()) {
        const grantId = `30000000-0000-0000-0006-${String(index + 1).padStart(12, "0")}`;
        await insertGrant(sql, { id: grantId, principalId });

        await expect(
          decide(context(transaction(sql), principalId), "document.read", {
            tenantId: TENANT_A,
            type: "DOCUMENT",
            id: DOCUMENT_A,
          }),
        ).resolves.toEqual({ allowed: false, because: "PRINCIPAL_INACTIVE" });

        const retained = await sql.query<{ count: number }>(
          "select count(*)::int as count from access_grant where tenant_id = $1 and id = $2",
          [TENANT_A, grantId],
        );
        expect(retained.rows[0]?.count).toBe(1);
      }
    });
  });

  it("INV-AUTH-003: an expired group membership cannot carry a current group grant", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `insert into user_group (tenant_id, id, name, source, status)
         values ($1, $2, 'Expired evaluator membership', 'LOCAL', 'ACTIVE')`,
        [TENANT_A, EXPIRED_GROUP],
      );
      await sql.query(
        `insert into group_membership (tenant_id, id, group_id, user_id, validity)
         values ($1, $2, $3, $4,
                 tstzrange('2029-01-01T00:00:00Z', '2030-01-02T11:59:59Z', '[)'))`,
        [TENANT_A, EXPIRED_MEMBERSHIP, EXPIRED_GROUP, USER_A],
      );
      await insertGrant(sql, {
        id: "30000000-0000-0000-0007-000000000001",
        principalType: "GROUP",
        principalId: EXPIRED_GROUP,
      });

      await expect(
        decide(context(transaction(sql)), "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: DOCUMENT_A,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
    });
  });

  it("INV-AUTH-008 / INV-AUTH-017: follows ownership downward without reversing a narrow grant", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
         values ($1, $2, 'Sibling evaluator unit', 'EVALUATOR_SIBLING', $3, 'ACTIVE')`,
        [TENANT_A, SIBLING_UNIT, ENTITY_A],
      );
      await sql.query(
        `insert into document (
           tenant_id, id, document_code, canonical_title, document_type_id,
           owning_org_unit_id, lifecycle_status, is_governing_framework
         ) values ($1, $2, 'EVALUATOR-SIBLING', 'Sibling evaluator document', $3,
                   $4, 'PLANNED', false)`,
        [TENANT_A, SIBLING_DOCUMENT, DOCUMENT_TYPE_A, SIBLING_UNIT],
      );

      const unitGrantId = "30000000-0000-0000-0008-000000000001";
      await insertGrant(sql, {
        id: unitGrantId,
        scopeType: "ORG_UNIT",
        scopeId: UNIT_A,
      });
      const unitContext = context(transaction(sql));

      for (const resource of [
        { tenantId: TENANT_A, type: "DOCUMENT", id: DOCUMENT_A },
        { tenantId: TENANT_A, type: "DOCUMENT_VERSION", id: VERSION_A },
      ] satisfies ResourceRef[]) {
        await expect(decide(unitContext, "document.read", resource)).resolves.toEqual({
          allowed: true,
          via: { tenantId: TENANT_A, id: unitGrantId },
        });
      }
      await expect(
        decide(unitContext, "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: SIBLING_DOCUMENT,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });

      const documentGrantId = "30000000-0000-0000-0008-000000000002";
      await insertGrant(sql, {
        id: documentGrantId,
        capability: "document.manage",
        scopeType: "DOCUMENT",
        scopeId: DOCUMENT_A,
      });
      const documentContext = context(transaction(sql));
      await expect(
        decide(documentContext, "document.manage", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: DOCUMENT_A,
        }),
      ).resolves.toEqual({
        allowed: true,
        via: { tenantId: TENANT_A, id: documentGrantId },
      });
      await expect(
        decide(documentContext, "document.manage", {
          tenantId: TENANT_A,
          type: "ORG_UNIT",
          id: UNIT_A,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
      await expect(
        decide(documentContext, "document.manage", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: SIBLING_DOCUMENT,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
    });
  });

  it("INV-AUTH-017: an applicability target cannot substitute for the owning unit", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `insert into org_unit (tenant_id, id, name, code, legal_entity_id, status)
         values ($1, $2, 'New owning evaluator unit', 'EVALUATOR_OWNER', $3, 'ACTIVE')`,
        [TENANT_A, SIBLING_UNIT, ENTITY_A],
      );
      const unitGrantId = "30000000-0000-0000-0009-000000000001";
      await insertGrant(sql, {
        id: unitGrantId,
        scopeType: "ORG_UNIT",
        scopeId: UNIT_A,
      });

      await expect(
        decide(context(transaction(sql)), "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: DOCUMENT_A,
        }),
      ).resolves.toEqual({
        allowed: true,
        via: { tenantId: TENANT_A, id: unitGrantId },
      });

      await sql.query(
        `update document
            set owning_org_unit_id = $1, row_version = row_version + 1
          where tenant_id = $2 and id = $3`,
        [SIBLING_UNIT, TENANT_A, DOCUMENT_A],
      );

      await expect(
        decide(context(transaction(sql)), "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: DOCUMENT_A,
        }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
    });
  });

  it("expands a database role and memoises one resource fact query", async () => {
    await withTenant(TENANT_A, async (sql) => {
      const counted = countedTransaction(sql);
      const ctx = context(counted.transaction);

      for (const capability of [
        "tenant.manage_identity",
        "tenant.manage_configuration",
        "tenant.manage_security",
        "document.manage_access",
      ] as const) {
        await expect(
          decide(ctx, capability, { tenantId: TENANT_A, type: "TENANT", id: null }),
        ).resolves.toEqual({
          allowed: true,
          via: { tenantId: TENANT_A, id: tenantA.accessGrant.id },
        });
      }
      await expect(
        decide(ctx, "document.publish", { tenantId: TENANT_A, type: "TENANT", id: null }),
      ).resolves.toEqual({ allowed: false, because: "NO_GRANT" });
      expect(counted.queryCount()).toBe(1);
    });
  });

  it("keeps one RLS evaluator query below the bootstrap cost guard for 1,000 grants", async () => {
    await withTenant(TENANT_A, async (sql) => {
      await sql.query(
        `insert into access_grant (
           tenant_id, id, effect, principal_type, principal_id, capability,
           scope_type, validity, granted_by, reason
         )
         select $1, gen_random_uuid(), 'ALLOW', 'USER', $2, 'document.read',
                'TENANT', tstzrange('2029-01-01T00:00:00Z', null, '[)'), $2,
                'Authorization evaluator query-cost fixture'
           from generate_series(1, 1000)`,
        [TENANT_A, USER_A],
      );
      const counted = countedTransaction(sql);
      const startedAt = performance.now();

      await expect(
        decide(context(counted.transaction), "document.read", {
          tenantId: TENANT_A,
          type: "DOCUMENT",
          id: DOCUMENT_A,
        }),
      ).resolves.toMatchObject({ allowed: true });

      const elapsedMilliseconds = performance.now() - startedAt;
      process.stdout.write(
        `authorization bootstrap: 1000 grants, ${counted.queryCount()} query, ${elapsedMilliseconds.toFixed(1)} ms\n`,
      );
      expect(counted.queryCount()).toBe(1);
      expect(elapsedMilliseconds).toBeLessThan(1_000);
    });
  });
});
