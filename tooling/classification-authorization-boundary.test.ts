import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DEFINITION = "packages/db/src/schema.ts";
const AUTHORIZATION_PATH =
  /(?:^|\/)(?:authorization|authorizer|authz|access[-_.]?(?:grant|evaluator)|permissions?|capabilities?)(?:\/|\.|[-_.])/i;
const AUTHORIZATION_SOURCE =
  /\b(?:access_grant|accessGrant|applicability_rule|applicabilityRule|security_role|securityRole)\b/;
const CLASSIFICATION_REFERENCE =
  /\b(?:information_classification|informationClassification(?:Id)?|classification_id|classificationId)\b/;

interface ProductionSource {
  path: string;
  source: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry) && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function authorizationClassificationProblems(sources: readonly ProductionSource[]): string[] {
  return sources
    .filter(
      ({ path, source }) =>
        path !== SCHEMA_DEFINITION &&
        (AUTHORIZATION_PATH.test(path) || AUTHORIZATION_SOURCE.test(source)) &&
        CLASSIFICATION_REFERENCE.test(source),
    )
    .map(({ path }) => `${path}: authorization surface references information classification`)
    .sort();
}

function productionSources(): ProductionSource[] {
  return ["apps/web/src", "apps/worker/src", "packages/domain/src", "packages/db/src"]
    .flatMap((directory) => sourceFiles(join(ROOT, directory)))
    .map((file) => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8") }));
}

describe("the information-classification authorization boundary", () => {
  it("INV-AUTH-019: no authorization evaluator reads information classification", () => {
    expect(authorizationClassificationProblems(productionSources())).toEqual([]);
  });

  it("INV-AUTH-019: the boundary gate rejects classification as an evaluator input", () => {
    expect(
      authorizationClassificationProblems([
        {
          path: "packages/domain/src/authorization.ts",
          source:
            "export function authorize(classificationId: string): boolean { return !!classificationId; }",
        },
        {
          path: "packages/db/src/evaluator.ts",
          source: "select classification_id from access_grant",
        },
        {
          path: SCHEMA_DEFINITION,
          source: "export const accessGrant = {}; export const informationClassification = {};",
        },
        {
          path: "packages/domain/src/document.ts",
          source: "export interface DocumentInput { classificationId: string }",
        },
      ]),
    ).toEqual([
      "packages/db/src/evaluator.ts: authorization surface references information classification",
      "packages/domain/src/authorization.ts: authorization surface references information classification",
    ]);
  });
});
