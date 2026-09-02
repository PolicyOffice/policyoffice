/**
 * Spaces are filing metadata, never an input to authority or applicability.
 *
 * The database shape alone cannot enforce that negative dependency. This gate inspects
 * production query sources and includes regression fixtures so an empty implementation
 * cannot make the assertion vacuously green.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DEFINITION = "packages/db/src/schema.ts";
const AUTHORITY_PATH = /(?:authorization|applicability|access[-_]?grant|capability|resolver)/i;
const AUTHORITY_SOURCE = /\b(?:access_grant|accessGrant|applicability_rule|applicabilityRule)\b/;
const SPACE_QUERY =
  /(?:\b(?:from|join)\s+(?:public\.)?"?space"?\b|\.(?:from|(?:left|right|inner)?join)\(\s*space\s*\)|\bspaceId\b|\bspace_id\b)/i;

interface ProductionSource {
  path: string;
  source: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function productionSources(): ProductionSource[] {
  return ["apps/web", "apps/worker", "packages/domain", "packages/db"]
    .map((directory) => join(ROOT, directory, "src"))
    .filter((directory) => statSync(directory).isDirectory())
    .flatMap(sourceFiles)
    .map((path) => ({ path: relative(ROOT, path), source: readFileSync(path, "utf8") }));
}

function organizationBoundaryProblems(sources: readonly ProductionSource[]): string[] {
  return sources
    .filter(
      ({ path, source }) =>
        path !== SCHEMA_DEFINITION &&
        (AUTHORITY_PATH.test(path) || AUTHORITY_SOURCE.test(source)) &&
        SPACE_QUERY.test(source),
    )
    .map(({ path }) => `${path}: an authority/applicability path reads Space`)
    .sort();
}

describe("organization boundaries", () => {
  it("INV-AUTH-015 / INV-APL-010: production authority and applicability queries never read Space", () => {
    expect(organizationBoundaryProblems(productionSources())).toEqual([]);
  });

  it("INV-AUTH-015 / INV-APL-010: the structural gate rejects SQL and typed Space dependencies", () => {
    expect(
      organizationBoundaryProblems([
        {
          path: "packages/domain/src/authorization.ts",
          source: "return db.select().from(space).where(eq(space.id, input.spaceId));",
        },
        {
          path: "packages/db/src/applicability-query.ts",
          source: "select * from applicability_rule join space on space.id = space_id",
        },
        {
          path: "packages/db/src/space-admin.ts",
          source: "return db.select().from(space);",
        },
      ]),
    ).toEqual([
      "packages/db/src/applicability-query.ts: an authority/applicability path reads Space",
      "packages/domain/src/authorization.ts: an authority/applicability path reads Space",
    ]);
  });
});
