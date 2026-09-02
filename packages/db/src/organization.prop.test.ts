import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMigrationRole__PRIVILEGED, withTenant } from "@policyoffice/testing";

const TENANT = "83000000-0000-0000-0000-000000000003";

function entityId(index: number): string {
  return `83000000-0000-0000-0018-${String(index + 1).padStart(12, "0")}`;
}

function wouldCreateCycle(
  parents: ReadonlyArray<number | null>,
  node: number,
  proposedParent: number | null,
): boolean {
  let ancestor = proposedParent;
  const visited = new Set<number>([node]);
  while (ancestor !== null) {
    if (visited.has(ancestor)) return true;
    visited.add(ancestor);
    ancestor = parents[ancestor] ?? null;
  }
  return false;
}

function isAcyclic(parents: ReadonlyArray<number | null>): boolean {
  return parents.every((_, node) => !wouldCreateCycle(parents, node, parents[node] ?? null));
}

beforeAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await sql.query("delete from legal_entity where tenant_id = $1", [TENANT]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    await sql.query("delete from tenant where id = $1", [TENANT]);
    await sql.query(
      `insert into tenant
         (id, name, status, default_timezone, default_locale, residency_profile)
       values ($1, 'Hierarchy property tenant', 'ACTIVE', 'Europe/Tallinn', 'en', 'EU')`,
      [TENANT],
    );
  });
});

afterAll(async () => {
  await withMigrationRole__PRIVILEGED(async (sql) => {
    await sql.query("begin");
    try {
      await sql.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await sql.query("delete from legal_entity where tenant_id = $1", [TENANT]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    await sql.query("delete from tenant where id = $1", [TENANT]);
  });
});

describe("organization hierarchy properties", () => {
  it("INV-ORG-001: arbitrary legal-entity graph updates can never persist a cycle", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(fc.nat(), { nil: null }), { minLength: 1, maxLength: 10 }),
        async (rawParents) => {
          await withTenant(TENANT, async (sql) => {
            const ids = rawParents.map((_, index) => entityId(index));
            const parents: Array<number | null> = rawParents.map(() => null);
            const versions = rawParents.map(() => 1);

            for (const [index, id] of ids.entries()) {
              await sql.query(
                `insert into legal_entity (tenant_id, id, legal_name, status)
                 values ($1, $2, $3, 'ACTIVE')`,
                [TENANT, id, `Entity ${index}`],
              );
            }

            for (const [node, rawParent] of rawParents.entries()) {
              const proposedParent = rawParent === null ? null : rawParent % ids.length;
              const shouldReject = wouldCreateCycle(parents, node, proposedParent);
              const nextVersion = (versions[node] ?? 0) + 1;
              await sql.query("savepoint before_edge");
              try {
                await sql.query(
                  `update legal_entity
                      set parent_legal_entity_id = $2, row_version = $3
                    where id = $1`,
                  [ids[node], proposedParent === null ? null : ids[proposedParent], nextVersion],
                );
                expect(shouldReject, `edge ${node} -> ${String(proposedParent)}`).toBe(false);
                parents[node] = proposedParent;
                versions[node] = nextVersion;
                await sql.query("release savepoint before_edge");
              } catch (error) {
                await sql.query("rollback to savepoint before_edge");
                await sql.query("release savepoint before_edge");
                expect(shouldReject, `edge ${node} -> ${String(proposedParent)}`).toBe(true);
                expect(error).toMatchObject({ code: "23514" });
              }
            }

            const { rows } = await sql.query<{ id: string; parent_legal_entity_id: string | null }>(
              "select id, parent_legal_entity_id from legal_entity order by id",
            );
            const indexById = new Map(ids.map((id, index) => [id, index]));
            const storedParents = rows.map((row) =>
              row.parent_legal_entity_id === null
                ? null
                : (indexById.get(row.parent_legal_entity_id) ?? null),
            );
            expect(storedParents).toEqual(parents);
            expect(isAcyclic(storedParents)).toBe(true);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
