import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORAGE_SEAM = "packages/storage/src/object-storage.ts";
const EXCLUDED_DIRECTORIES = new Set([".git", ".next", "dist", "node_modules"]);

function productionSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (EXCLUDED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...productionSourceFiles(path));
    else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".int.test.ts") &&
      !entry.endsWith(".prop.test.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function parsed(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
}

describe("the controlled-file storage seam", () => {
  const files = productionSourceFiles(REPO_ROOT);

  it("keeps every production S3 client import at the one named seam", () => {
    const importers: string[] = [];
    for (const file of files) {
      for (const statement of parsed(file).statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === "@aws-sdk/client-s3"
        ) {
          importers.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(importers).toEqual([STORAGE_SEAM]);
  });

  it("constructs S3Client exactly once inside that seam", () => {
    const source = parsed(join(REPO_ROOT, STORAGE_SEAM));
    let constructors = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "S3Client"
      ) {
        constructors += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(constructors).toBe(1);
  });
});
