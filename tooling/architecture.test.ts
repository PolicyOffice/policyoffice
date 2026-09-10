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
const ADMIN_CONNECTION_SITE = "packages/db/src/migration-connection.ts";
const TEST_CONNECTION_SITE = "packages/testing/src/db.ts";
// Production has one administrative constructor. The test harness is the deliberate
// exception: it must construct clients itself to prove each restricted PostgreSQL role.
const CONNECTION_SITES = new Set([ADMIN_CONNECTION_SITE, TEST_CONNECTION_SITE]);
const DATA_LAYER_PREFIX = "packages/db/src/";
const EXCLUDED_SOURCE_DIRECTORIES = new Set([".git", ".next", "dist", "node_modules"]);

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
const ALLOWED_BARE_IMPORTS: ReadonlySet<string> = new Set<string>([
  // POL-015: the canonical content digest is pure computation over bytes. Node's built-in
  // primitive adds no framework, request context, I/O service or runtime dependency.
  "node:crypto",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (EXCLUDED_SOURCE_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface SourceUnit {
  readonly file: string;
  readonly source: string;
}

function sourceUnit(file: string): SourceUnit {
  return { file, source: readFileSync(file, "utf8") };
}

function repositoryPath(file: string): string {
  const path = file.startsWith(REPO_ROOT) ? relative(REPO_ROOT, file) : file;
  return path.replaceAll("\\", "/");
}

function parsedSource(unit: SourceUnit): ts.SourceFile {
  return ts.createSourceFile(unit.file, unit.source, ts.ScriptTarget.ESNext, true);
}

/**
 * Every module specifier a file imports, including `import type`, `export … from` and
 * dynamic `import()`.
 *
 * Type-only imports count. A type-only import of the web framework creates no runtime
 * dependency, but it does mean a domain rule is expressed in terms of a request -- which
 * is the coupling the boundary exists to prevent, arriving by a quieter route.
 */
function importsIn(unit: SourceUnit): string[] {
  const source = parsedSource(unit);
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

function importsOf(file: string): string[] {
  return importsIn(sourceUnit(file));
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

function isDatabaseClientImport(specifier: string): boolean {
  return (
    specifier === "pg" ||
    specifier.startsWith("pg/") ||
    specifier === "drizzle-orm" ||
    specifier.startsWith("drizzle-orm/") ||
    specifier === "postgres" ||
    specifier.startsWith("postgres/")
  );
}

function databaseClientImportProblems(units: readonly SourceUnit[]): string[] {
  const problems: string[] = [];
  for (const unit of units) {
    const file = repositoryPath(unit.file);
    const mayImportDatabaseClient =
      file.startsWith(DATA_LAYER_PREFIX) || file === TEST_CONNECTION_SITE;
    if (mayImportDatabaseClient) continue;
    for (const specifier of importsIn(unit)) {
      if (isDatabaseClientImport(specifier)) {
        problems.push(`${file} imports database client "${specifier}" outside the data layer`);
      }
    }
  }
  return problems.sort();
}

function importedConnectionConstructors(source: ts.SourceFile): {
  readonly classes: ReadonlyMap<string, "Client" | "Pool">;
  readonly namespaces: ReadonlySet<string>;
  readonly postgresFunctions: ReadonlySet<string>;
} {
  const classes = new Map<string, "Client" | "Pool">();
  const namespaces = new Set<string>();
  const postgresFunctions = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;

    if (specifier === "pg" || specifier.startsWith("pg/")) {
      if (clause.name) namespaces.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.add(clause.namedBindings.name.text);
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "Client" || imported === "Pool") {
            classes.set(element.name.text, imported);
          }
        }
      }
    }

    if (specifier === "postgres" || specifier.startsWith("postgres/")) {
      if (clause.name) postgresFunctions.add(clause.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "postgres") {
            postgresFunctions.add(element.name.text);
          }
        }
      }
    }
  }
  return { classes, namespaces, postgresFunctions };
}

function connectionConstructions(unit: SourceUnit): string[] {
  const source = parsedSource(unit);
  const imported = importedConnectionConstructors(source);
  const constructions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const constructor = imported.classes.get(node.expression.text);
        if (constructor) constructions.push(`new ${constructor}`);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        imported.namespaces.has(node.expression.expression.text) &&
        (node.expression.name.text === "Client" || node.expression.name.text === "Pool")
      ) {
        constructions.push(`new ${node.expression.name.text}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      imported.postgresFunctions.has(node.expression.text)
    ) {
      constructions.push("postgres(...)");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constructions;
}

function connectionConstructionProblems(units: readonly SourceUnit[]): string[] {
  const problems: string[] = [];
  for (const unit of units) {
    const file = repositoryPath(unit.file);
    if (CONNECTION_SITES.has(file)) continue;
    for (const construction of connectionConstructions(unit)) {
      problems.push(`${file} constructs a database client with ${construction}`);
    }
  }
  return problems.sort();
}

function isExported(node: { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function typeReferenceName(type: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(type)) return undefined;
  const name = type.typeName;
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function isTransactionHandleName(name: string): boolean {
  return name === "Client" || name === "Pool" || name === "Sql" || name.endsWith("Transaction");
}

function isTransactionHandle(
  type: ts.TypeNode | undefined,
  knownNames: ReadonlySet<string> = new Set(),
): boolean {
  if (!type) return false;
  const name = typeReferenceName(type);
  if (name && (isTransactionHandleName(name) || knownNames.has(name))) return true;
  if (ts.isParenthesizedTypeNode(type)) return isTransactionHandle(type.type, knownNames);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) => isTransactionHandle(member, knownNames));
  }
  return false;
}

function transactionHandleNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (isTransactionHandleName(imported)) names.add(element.name.text);
    }
  }
  return names;
}

interface ExportedFunction {
  readonly file: string;
  readonly name: string;
  readonly parameters: ts.NodeArray<ts.ParameterDeclaration>;
  readonly transactionHandleNames: ReadonlySet<string>;
}

function exportedFunctions(unit: SourceUnit): ExportedFunction[] {
  const source = parsedSource(unit);
  const file = repositoryPath(unit.file);
  const knownTransactionHandles = transactionHandleNames(source);
  const declarations = new Map<string, ts.NodeArray<ts.ParameterDeclaration>>();
  const exportedNames = new Set<string>();

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement.parameters);
      if (isExported(statement)) exportedNames.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          declarations.set(declaration.name.text, declaration.initializer.parameters);
          if (isExported(statement)) exportedNames.add(declaration.name.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedNames.add(element.propertyName?.text ?? element.name.text);
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      exportedNames.add(statement.expression.text);
    }
  }

  return [...exportedNames].flatMap((name) => {
    const parameters = declarations.get(name);
    return parameters
      ? [{ file, name, parameters, transactionHandleNames: knownTransactionHandles }]
      : [];
  });
}

function dataFunctionParameterProblems(units: readonly SourceUnit[]): string[] {
  const problems: string[] = [];
  for (const unit of units) {
    if (!repositoryPath(unit.file).startsWith(DATA_LAYER_PREFIX)) continue;
    for (const fn of exportedFunctions(unit)) {
      const transactionIndex = fn.parameters.findIndex((parameter) =>
        isTransactionHandle(parameter.type, fn.transactionHandleNames),
      );
      if (transactionIndex > 0) {
        problems.push(
          `${fn.file} exports ${fn.name} with its transaction at parameter ${transactionIndex + 1}, not parameter 1`,
        );
      }
    }
  }
  return problems.sort();
}

function contextBoundaryProblems(units: readonly SourceUnit[]): string[] {
  if (units.length === 0) return ["the context boundary discovered no source files"];
  return [
    ...databaseClientImportProblems(units),
    ...connectionConstructionProblems(units),
    ...dataFunctionParameterProblems(units),
  ].sort();
}

describe("INV-TEN-004 / INV-AUTH-001: data access requires an explicit context", () => {
  const units = sourceFiles(REPO_ROOT).map(sourceUnit);

  it("has repository source and transaction-taking functions to check", () => {
    const dataFunctions = units
      .filter((unit) => repositoryPath(unit.file).startsWith(DATA_LAYER_PREFIX))
      .flatMap(exportedFunctions)
      .filter((fn) =>
        fn.parameters.some((parameter) =>
          isTransactionHandle(parameter.type, fn.transactionHandleNames),
        ),
      );
    expect(units.length).toBeGreaterThan(0);
    expect(dataFunctions.length).toBeGreaterThan(0);
  });

  it("rejects pg and Drizzle imports outside the data layer, naming each file", () => {
    expect(
      contextBoundaryProblems([
        { file: "apps/web/src/leak.ts", source: 'import { Client } from "pg";' },
        { file: "apps/worker/src/leak.ts", source: 'import { sql } from "drizzle-orm";' },
      ]),
    ).toEqual([
      'apps/web/src/leak.ts imports database client "pg" outside the data layer',
      'apps/worker/src/leak.ts imports database client "drizzle-orm" outside the data layer',
    ]);
  });

  it("rejects client construction outside the administrative site and test harness", () => {
    expect(
      contextBoundaryProblems([
        {
          file: "packages/db/src/leaked-client.ts",
          source: 'import { Client as PgClient } from "pg"; new PgClient();',
        },
        {
          file: "packages/db/src/leaked-pool.ts",
          source: 'import { Pool } from "pg"; new Pool();',
        },
        {
          file: "packages/db/src/leaked-postgres.ts",
          source: 'import postgres from "postgres"; postgres();',
        },
      ]),
    ).toEqual([
      "packages/db/src/leaked-client.ts constructs a database client with new Client",
      "packages/db/src/leaked-pool.ts constructs a database client with new Pool",
      "packages/db/src/leaked-postgres.ts constructs a database client with postgres(...)",
    ]);
  });

  it("rejects an exported data function whose transaction is not its first parameter", () => {
    const misplaced = {
      file: "packages/db/src/documents.ts",
      source:
        'import type { AuthorizationTransaction as Tx } from "./authorization.js"; async function loadDocument(id: string, transaction: Tx) {} export { loadDocument };',
    };
    expect(contextBoundaryProblems([misplaced])).toEqual([
      "packages/db/src/documents.ts exports loadDocument with its transaction at parameter 2, not parameter 1",
    ]);
  });

  it("classifies a newly added transaction-first repository function without an allowlist", () => {
    const added = {
      file: "packages/db/src/new-repository.ts",
      source:
        "export async function loadNewThing(transaction: AuthorizationTransaction, id: string) {}",
    };
    expect(contextBoundaryProblems([added])).toEqual([]);
  });

  it("fails rather than passing vacuously when source discovery finds nothing", () => {
    expect(contextBoundaryProblems([])).toEqual([
      "the context boundary discovered no source files",
    ]);
  });

  it("keeps the current repository behind the context boundary", () => {
    expect(contextBoundaryProblems(units)).toEqual([]);
  });
});
