import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DEFINITION = "packages/db/src/schema.ts";
const FIXTURE_LOADER = "packages/db/src/fixtures.ts";
const AUTHORIZATION_PATH =
  /(?:^|\/)(?:authorization|authorizer|authz|access[-_.]?(?:grant|evaluator)|permissions?|capabilities?)(?:\/|\.|[-_.])/i;
const AUTHORIZATION_SOURCE =
  /\b(?:access_grant|accessGrant|security_role|securityRole|effectivePermissions)\b/;
const APPLICABILITY_REFERENCE =
  /\b(?:applicability_rule|applicabilityRule|alignment_obligation|alignmentObligation)\b/;

interface ProductionSource {
  path: string;
  source: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (
      (/\.[cm]?[jt]sx?$/.test(entry) || entry.endsWith(".sql")) &&
      !entry.endsWith(".test.ts")
    )
      files.push(path);
  }
  return files;
}

function authorizationApplicabilityProblems(sources: readonly ProductionSource[]): string[] {
  return sources
    .filter(
      ({ path, source }) =>
        path !== SCHEMA_DEFINITION &&
        path !== FIXTURE_LOADER &&
        (AUTHORIZATION_PATH.test(path) || AUTHORIZATION_SOURCE.test(source)) &&
        APPLICABILITY_REFERENCE.test(source),
    )
    .map(({ path }) => `${path}: authorization surface references applicability`)
    .sort();
}

function productionSources(): ProductionSource[] {
  return [
    "apps/web/src",
    "apps/worker/src",
    "packages/domain/src",
    "packages/db/src",
    "packages/db/migrations",
  ]
    .flatMap((directory) => sourceFiles(join(ROOT, directory)))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
}

describe("the applicability authorization boundary", () => {
  it("INV-AUTH-017: no authorization evaluator reads applicability scope", () => {
    expect(authorizationApplicabilityProblems(productionSources())).toEqual([]);
  });

  it("INV-AUTH-017: the boundary gate rejects applicability as an evaluator input", () => {
    expect(
      authorizationApplicabilityProblems([
        {
          path: "packages/domain/src/authorization.ts",
          source: "return applicabilityRule.effect === 'INCLUDE';",
        },
        {
          path: "packages/db/src/access-grant-evaluator.ts",
          source: "select * from access_grant join applicability_rule using (tenant_id)",
        },
        {
          path: SCHEMA_DEFINITION,
          source: "export const accessGrant = {}; export const applicabilityRule = {};",
        },
        {
          path: "packages/domain/src/applicability.ts",
          source: "export const applicabilityRule = {};",
        },
      ]),
    ).toEqual([
      "packages/db/src/access-grant-evaluator.ts: authorization surface references applicability",
      "packages/domain/src/authorization.ts: authorization surface references applicability",
    ]);
  });
});
