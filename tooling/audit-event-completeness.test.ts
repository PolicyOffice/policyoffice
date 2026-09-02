/**
 * The catalogue, typed contract and production write paths must stay in step.
 *
 * This is a dedicated merge gate because a missing governance event is usually invisible
 * until someone tries to reconstruct evidence. The first version of the gate proves that
 * every catalogued name has a versioned contract and that audit.ts is the only production
 * source allowed to insert into the ledger. Later transition tickets add their names to
 * IMPLEMENTED_AUDIT_EVENT_TYPES in the same change that adds their calls.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_SCHEMAS,
  AUDIT_EVENT_TYPES,
  IMPLEMENTED_AUDIT_EVENT_TYPES,
} from "../packages/domain/src/audit.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function documentedEventTypes(): string[] {
  const document = readFileSync(join(ROOT, "docs/domain/audit-event-catalogue.md"), "utf8");
  const catalogue = document.split("## The catalogue")[1]?.split("## Retention")[0];
  if (!catalogue) throw new Error("could not find the audit event catalogue tables");

  const names = catalogue
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) => {
      const eventCell = line.split("|")[1] ?? "";
      return [...eventCell.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((match) => match[1]!);
    });
  return [...new Set(names)].sort();
}

function productionSourceFiles(): string[] {
  return ["apps/web", "apps/worker", "packages/domain", "packages/db"]
    .map((directory) => join(ROOT, directory, "src"))
    .filter((directory) => statSync(directory).isDirectory())
    .flatMap(sourceFiles);
}

describe("audit-event completeness", () => {
  it("INV-AUD-008: every catalogued event has exactly one typed, versioned registry entry", () => {
    const documented = documentedEventTypes();
    expect(documented.length).toBeGreaterThan(100);
    expect([...AUDIT_EVENT_TYPES].sort()).toEqual(documented);
    expect(Object.keys(AUDIT_EVENT_SCHEMAS).sort()).toEqual(documented);

    for (const eventType of AUDIT_EVENT_TYPES) {
      const versions = Object.keys(AUDIT_EVENT_SCHEMAS[eventType]).map(Number);
      expect(versions, eventType).toEqual([1]);
    }
  });

  it("INV-AUD-001: records implemented emissions separately from catalogued contracts", () => {
    expect(new Set(IMPLEMENTED_AUDIT_EVENT_TYPES).size).toBe(IMPLEMENTED_AUDIT_EVENT_TYPES.length);
    expect(
      IMPLEMENTED_AUDIT_EVENT_TYPES.filter((eventType) => !AUDIT_EVENT_TYPES.includes(eventType)),
    ).toEqual([]);
    const productionReferences = productionSourceFiles()
      .filter((file) => !file.endsWith("packages/domain/src/audit.ts"))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/["']([a-z_]+\.[a-z_]+)["']/g)].map(
          (match) => match[1]!,
        ),
      )
      .filter((name) => (AUDIT_EVENT_TYPES as readonly string[]).includes(name));

    expect([...IMPLEMENTED_AUDIT_EVENT_TYPES].sort()).toEqual(
      [...new Set(productionReferences)].sort(),
    );
  });

  it("INV-AUD-001 / INV-AUD-004 / INV-AUD-007: audit.ts is the only production ledger insertion path", () => {
    const insertionFiles = productionSourceFiles()
      .filter((file) =>
        /insert\s+into\s+(?:public\.)?audit_event\b/i.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(ROOT, file));

    expect(insertionFiles).toEqual(["packages/domain/src/audit.ts"]);
  });
});
