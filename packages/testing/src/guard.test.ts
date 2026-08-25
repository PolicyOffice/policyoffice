/**
 * The guard turns "integration tests must never connect as a superuser" from a sentence
 * in a README into a failing test. Its own behaviour is therefore worth asserting --
 * including, especially, that it actually fails.
 */
import { describe, expect, it } from "vitest";
import { assertNoPrivilegedEscape } from "./guard.js";

describe("assertNoPrivilegedEscape", () => {
  it("passes when the test opened no privileged connection", () => {
    expect(() => assertNoPrivilegedEscape("INV-TEN-001: isolation holds", undefined)).not.toThrow();
  });

  it("FAILS a tenancy assertion made through a superuser connection", () => {
    // The whole point. A superuser bypasses row-level security entirely, so this
    // assertion would have passed whether or not the policy existed.
    expect(() =>
      assertNoPrivilegedEscape("INV-TEN-001: isolation holds", "superuser (BYPASSES RLS)"),
    ).toThrow(/superuser/i);
  });

  it("FAILS an authorization assertion made through the schema owner", () => {
    expect(() =>
      assertNoPrivilegedEscape("INV-AUTH-002: explicit deny wins", "migration_role"),
    ).toThrow(/migration_role/);
  });

  it("allows privileged access in a test that asserts no RLS-dependent property", () => {
    // Deliberately narrow. Schema setup needs migration_role; migration tests need it
    // throughout. Only tenancy and authorization claims are void through such a
    // connection.
    expect(() =>
      assertNoPrivilegedEscape("migration ledger records a checksum", "migration_role"),
    ).not.toThrow();
  });

  it("explains what to do instead", () => {
    // An enforcement that does not say how to comply gets worked around.
    try {
      assertNoPrivilegedEscape("INV-TEN-002: not-found", "superuser (BYPASSES RLS)");
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("withAppRole");
      expect(message).toContain("beforeAll");
    }
  });
});
