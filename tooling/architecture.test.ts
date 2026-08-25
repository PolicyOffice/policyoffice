/**
 * The domain boundary, enforced.
 *
 * `ADR-0000` § What we have committed to maintaining:
 *
 *   "A domain package that never imports the web framework. This will be under constant
 *    pressure and is the single most important architectural boundary in the repository."
 *
 * Under constant pressure is the operative phrase. A boundary maintained by intention
 * lasts until the first afternoon when importing the request context is the quick fix.
 * This test is what makes forgetting insufficient.
 *
 * Two invariants rest on it:
 *
 *   INV-TEN-004  tenant scoping is enforced below the presentation layer, so background
 *                jobs and APIs inherit it
 *   INV-AUTH-001 default deny, through one evaluator with no second path around it
 *
 * It is an ALLOWLIST, deliberately. A denylist of forbidden frameworks silently permits
 * the next one anybody adds, which is precisely the failure it would exist to prevent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN_SRC = join(REPO_ROOT, "packages/domain/src");

/**
 * Bare module specifiers the domain package may import.
 *
 * Empty, and that is the correct starting point rather than an oversight. Every addition
 * is a deliberate, reviewed widening of the most important boundary in the repository, so
 * it should require a diff and a reason -- not merely happen.
 *
 * When the content model lands it will want a hashing primitive (INV-VER-009). Add
 * `node:crypto` then, in the pull request that needs it, with the reason in the ticket.
 */
const ALLOWED_BARE_IMPORTS: ReadonlySet<string> = new Set<string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Every module specifier a file imports, including `import type`, `export … from` and
 * dynamic `import()`.
 *
 * Type-only imports count. A type-only import of the web framework creates no runtime
 * dependency, but it does mean a domain rule is expressed in terms of a request -- which
 * is the coupling the boundary exists to prevent, arriving by a quieter route.
 */
function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const isRelative = (specifier: string): boolean => specifier.startsWith(".");

describe("INV-TEN-004 / INV-AUTH-001: the domain package is framework-free", () => {
  const files = sourceFiles(DOMAIN_SRC);

  it("has source files to check, so a passing run means something", () => {
    // Without this, deleting the package would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports nothing outside the allowlist", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (isRelative(specifier)) continue;
        if (ALLOWED_BARE_IMPORTS.has(specifier)) continue;
        violations.push(`${relative(REPO_ROOT, file)} imports "${specifier}"`);
      }
    }
    expect(
      violations,
      violations.length === 0
        ? ""
        : [
            "The domain package imported something outside its allowlist:",
            ...violations.map((v) => `  - ${v}`),
            "",
            "This is the boundary ADR-0000 calls the most important in the repository.",
            "INV-TEN-004 and INV-AUTH-001 both depend on the domain being reachable from",
            "the web app and the worker without either one's runtime coming with it.",
            "",
            "If the dependency is genuinely framework-free and genuinely belongs here, add",
            "it to ALLOWED_BARE_IMPORTS in this file, with the reason in the ticket. If it",
            "is a framework, a request context, or an ORM client, the code belongs on the",
            "other side of the boundary instead.",
          ].join("\n"),
    ).toEqual([]);
  });

  it("declares no runtime dependencies in its manifest", () => {
    // The import check reads source. This reads intent: a dependency that is declared but
    // not yet imported is a boundary already conceded.
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/domain/package.json"), "utf8"),
    );
    const deps = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps)).toEqual([]);
  });
});
