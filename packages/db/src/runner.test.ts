/**
 * Unit tests for the parts of the runner that need no database.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as runner from "./runner.js";
import { checksum, nextMigrationName, readMigrations } from "./runner.js";

const dirWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "po-unit-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, "utf8");
  return dir;
};

describe("there is no reverse path", () => {
  it("exports nothing that could revert, roll back or drop a migration", () => {
    // ADR-0009: "There are no down migrations. Not 'we rarely write them': they do not
    // exist." Adding one later must mean changing this design, not discovering a helper
    // that already exists. This test is what makes that true rather than intended.
    const exported = Object.keys(runner);
    // Without this the assertion below passes vacuously if the module stops exporting
    // anything at all -- the same trap the architecture test guards against.
    expect(exported.length).toBeGreaterThan(5);
    const reverseish = exported.filter((name) => /revert|rollback|undo|down|drop/i.test(name));
    expect(reverseish).toEqual([]);
  });
});

describe("checksums", () => {
  it("changes when a single character of the migration changes", () => {
    // This is the whole mechanism behind immutability-once-merged.
    expect(checksum("create table a (id int);")).not.toBe(checksum("create table a (id bigint);"));
  });

  it("is stable for identical content", () => {
    expect(checksum("select 1;")).toBe(checksum("select 1;"));
  });
});

describe("reading migrations", () => {
  it("orders by the zero-padded numeric prefix, not by discovery order", () => {
    const dir = dirWith({
      "0010_j.sql": "select 10;",
      "0002_b.sql": "select 2;",
      "0001_a.sql": "select 1;",
    });
    expect(readMigrations(dir).map((m) => m.name)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
      "0010_j.sql",
    ]);
  });

  it("treats a migration as transactional unless it opts out", () => {
    const dir = dirWith({
      "0001_plain.sql": "select 1;",
      "0002_concurrent.sql":
        "-- policyoffice:non-transactional\ncreate index concurrently i on t (c);",
    });
    const [plain, concurrent] = readMigrations(dir);
    expect(plain?.transactional).toBe(true);
    expect(concurrent?.transactional).toBe(false);
  });

  it("does not mistake the marker inside a comment body for an opt-out", () => {
    // The marker must be its own line, or a migration that merely mentions the convention
    // in prose would silently lose its transaction.
    const dir = dirWith({
      "0001_a.sql": "-- see policyoffice:non-transactional for the marker\nselect 1;",
    });
    expect(readMigrations(dir)[0]?.transactional).toBe(true);
  });
});

describe("naming the next migration", () => {
  it("increments the sequence and slugifies the description", () => {
    const dir = dirWith({ "0001_a.sql": "select 1;", "0002_b.sql": "select 2;" });
    expect(nextMigrationName("Document spine!", dir)).toBe("0003_document_spine.sql");
  });

  it("starts at 0001 in an empty directory", () => {
    expect(nextMigrationName("first", dirWith({}))).toBe("0001_first.sql");
  });
});
