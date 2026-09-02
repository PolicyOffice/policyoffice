import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTHORIZATION_PATH =
  /(?:^|\/)(?:authorization|authorizer|authz|access[-_.]?(?:grant|evaluator)|permissions?|capabilities?)(?:\/|\.|[-_.])/i;
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
      ({ path, source }) => AUTHORIZATION_PATH.test(path) && CLASSIFICATION_REFERENCE.test(source),
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
      ]),
    ).toEqual([
      "packages/domain/src/authorization.ts: authorization surface references information classification",
    ]);
  });
});
