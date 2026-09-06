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
  ENVELOPE_ONLY_BY_DESIGN,
  ENVELOPE_ONLY_SCHEMA,
  IMPLEMENTED_AUDIT_EVENT_TYPES,
  type AuditEventSchema,
} from "../packages/domain/src/audit.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUDIT_EMITTER = "packages/domain/src/audit.ts";
const AUDIT_TABLE_DEFINITION = "packages/db/src/schema.ts";
const RAW_AUDIT_INSERT = /insert\s+into\s+(?:public\.)?audit_event\b/i;
const AUDIT_TABLE_EXPORT_REFERENCE = /\bauditEvent\b/;

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

function productionSources(): ProductionSource[] {
  return productionSourceFiles().map((file) => ({
    path: relative(ROOT, file),
    source: readFileSync(file, "utf8"),
  }));
}

/**
 * Keep the raw SQL emitter unique and make the Drizzle table unavailable to a second
 * production path. Matching the table-export identifier deliberately covers imports,
 * re-exports, aliases' import clauses and namespace-property access without trying to
 * enumerate every API that could eventually accept a Drizzle table.
 */
function auditWritePathProblems(sources: readonly ProductionSource[]): string[] {
  const problems: string[] = [];
  const rawInsertPaths = sources
    .filter(({ source }) => RAW_AUDIT_INSERT.test(source))
    .map(({ path }) => path);

  if (!rawInsertPaths.includes(AUDIT_EMITTER)) {
    problems.push(`${AUDIT_EMITTER}: canonical raw insert is missing`);
  }
  for (const path of rawInsertPaths) {
    if (path !== AUDIT_EMITTER) problems.push(`${path}: contains a raw audit_event insert`);
  }

  for (const { path, source } of sources) {
    if (
      path !== AUDIT_EMITTER &&
      path !== AUDIT_TABLE_DEFINITION &&
      AUDIT_TABLE_EXPORT_REFERENCE.test(source)
    ) {
      problems.push(`${path}: references the auditEvent table export`);
    }
  }

  return problems.sort();
}

interface ImplementedSchemaGateInput<EventType extends string> {
  implementedEventTypes: readonly EventType[];
  schemas: Readonly<Partial<Record<EventType, Readonly<Record<number, AuditEventSchema>>>>>;
  envelopeOnlyByDesign: readonly EventType[];
  envelopeOnlySchema: AuditEventSchema;
}

/**
 * Identity is the contract here. A separately declared schema with empty key arrays is a
 * deliberate decision; inheriting the shared placeholder is the unconsidered default.
 */
function implementedSchemaProblems<EventType extends string>({
  implementedEventTypes,
  schemas,
  envelopeOnlyByDesign,
  envelopeOnlySchema,
}: ImplementedSchemaGateInput<EventType>): string[] {
  const permitted = new Set(envelopeOnlyByDesign);
  const problems: string[] = [];
  for (const eventType of implementedEventTypes) {
    const registeredSchemas = Object.values(schemas[eventType] ?? {});
    const usesPlaceholder = registeredSchemas.some((schema) => schema === envelopeOnlySchema);
    if (usesPlaceholder && !permitted.has(eventType)) {
      problems.push(`${eventType}: implemented event still uses ENVELOPE_ONLY_SCHEMA`);
    }
  }
  return problems.sort();
}

describe("audit-event completeness", () => {
  it("INV-AUD-008: every catalogued event has a typed, gapless version registry", () => {
    const documented = documentedEventTypes();
    expect(documented.length).toBeGreaterThan(100);
    expect([...AUDIT_EVENT_TYPES].sort()).toEqual(documented);
    expect(Object.keys(AUDIT_EVENT_SCHEMAS).sort()).toEqual(documented);

    for (const eventType of AUDIT_EVENT_TYPES) {
      const versions = Object.keys(AUDIT_EVENT_SCHEMAS[eventType])
        .map(Number)
        .sort((left, right) => left - right);
      expect(versions.length, eventType).toBeGreaterThan(0);
      expect(versions, eventType).toEqual(
        Array.from({ length: versions.at(-1) ?? 0 }, (_, index) => index + 1),
      );
    }
  });

  it("INV-AUD-001: records implemented emissions separately from catalogued contracts", () => {
    expect(new Set(IMPLEMENTED_AUDIT_EVENT_TYPES).size).toBe(IMPLEMENTED_AUDIT_EVENT_TYPES.length);
    expect(
      IMPLEMENTED_AUDIT_EVENT_TYPES.filter((eventType) => !AUDIT_EVENT_TYPES.includes(eventType)),
    ).toEqual([]);
    const productionReferences = productionSources()
      .filter(({ path }) => path !== AUDIT_EMITTER)
      .flatMap(({ source }) =>
        [...source.matchAll(/["']([a-z_]+\.[a-z_]+)["']/g)].map((match) => match[1]!),
      )
      .filter((name) => (AUDIT_EVENT_TYPES as readonly string[]).includes(name));

    expect([...IMPLEMENTED_AUDIT_EVENT_TYPES].sort()).toEqual(
      [...new Set(productionReferences)].sort(),
    );
  });

  it("INV-AUD-008: implemented events replace the placeholder or declare an exception", () => {
    expect(
      implementedSchemaProblems({
        implementedEventTypes: IMPLEMENTED_AUDIT_EVENT_TYPES,
        schemas: AUDIT_EVENT_SCHEMAS,
        envelopeOnlyByDesign: ENVELOPE_ONLY_BY_DESIGN,
        envelopeOnlySchema: ENVELOPE_ONLY_SCHEMA,
      }),
    ).toEqual([]);
  });

  it("INV-AUD-008: the placeholder gate distinguishes defaults, exceptions, and deliberate empty schemas", () => {
    const eventType = "access.denied" as const;
    const placeholderSchemas = Object.freeze({
      [eventType]: Object.freeze({ 1: ENVELOPE_ONLY_SCHEMA }),
    });
    const fixture = {
      implementedEventTypes: [eventType],
      schemas: placeholderSchemas,
      envelopeOnlyByDesign: [],
      envelopeOnlySchema: ENVELOPE_ONLY_SCHEMA,
    } as const;

    expect(implementedSchemaProblems(fixture)).toEqual([
      "access.denied: implemented event still uses ENVELOPE_ONLY_SCHEMA",
    ]);
    expect(implementedSchemaProblems({ ...fixture, envelopeOnlyByDesign: [eventType] })).toEqual(
      [],
    );

    const deliberateEmptySchema: AuditEventSchema = Object.freeze({
      safeBeforeKeys: Object.freeze([]),
      safeAfterKeys: Object.freeze([]),
      requiredSafeBeforeKeys: Object.freeze([]),
      requiredSafeAfterKeys: Object.freeze([]),
      safeBeforeRequired: false,
      safeAfterRequired: false,
    });
    expect(deliberateEmptySchema).not.toBe(ENVELOPE_ONLY_SCHEMA);
    expect(
      implementedSchemaProblems({
        ...fixture,
        schemas: Object.freeze({
          [eventType]: Object.freeze({ 1: deliberateEmptySchema }),
        }),
      }),
    ).toEqual([]);
    expect(
      implementedSchemaProblems({
        ...fixture,
        schemas: Object.freeze({
          [eventType]: Object.freeze({
            1: deliberateEmptySchema,
            2: ENVELOPE_ONLY_SCHEMA,
          }),
        }),
      }),
    ).toEqual(["access.denied: implemented event still uses ENVELOPE_ONLY_SCHEMA"]);
  });

  it("INV-AUD-001 / INV-AUD-004 / INV-AUD-007: audit.ts is the only production ledger insertion path", () => {
    expect(auditWritePathProblems(productionSources())).toEqual([]);
  });

  it("INV-AUD-001: the sole-path gate rejects raw SQL and Drizzle-table bypasses", () => {
    const fixture: ProductionSource[] = [
      {
        path: AUDIT_EMITTER,
        source: "await transaction.query('insert into audit_event (tenant_id) values ($1)')",
      },
      {
        path: AUDIT_TABLE_DEFINITION,
        source: "export const auditEvent = pgTable('audit_event', {});",
      },
      {
        path: "apps/worker/src/raw-bypass.ts",
        source: "await sql.query('INSERT INTO public.audit_event (tenant_id) values ($1)')",
      },
      {
        path: "packages/db/src/drizzle-bypass.ts",
        source: 'import { auditEvent } from "./schema.js"; db.insert(auditEvent).values(values);',
      },
    ];

    expect(auditWritePathProblems(fixture)).toEqual([
      "apps/worker/src/raw-bypass.ts: contains a raw audit_event insert",
      "packages/db/src/drizzle-bypass.ts: references the auditEvent table export",
    ]);
  });
});
