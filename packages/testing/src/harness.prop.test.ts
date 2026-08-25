/**
 * A representative property-based test, proving fast-check is wired up and that a failure
 * reports a replayable seed.
 *
 * It deliberately cites no invariant. The property below is about half-open interval
 * arithmetic, which is INV-TIME-005's subject -- but the enforcement that actually carries
 * that invariant is a `tstzrange` with `[)` bounds in the schema, verified by
 * `verification/01-extensions-and-types.sql`. Claiming coverage here for a rule the
 * database enforces, against code that does not exist yet, would put a green tick against
 * an invariant nothing in the product implements.
 *
 * fast-check is here now rather than later because INV-APL-001 -- deterministic
 * applicability resolution -- sits at level 5 of the enforcement ladder: "cannot be
 * structurally enforced -- property-based tests instead". It is the only enforcement that
 * invariant will ever have, so the harness for it should not arrive the same week the
 * resolver does.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/** Half-open: `from` is inside, `until` is not. */
const contains = (from: number, until: number, at: number): boolean => at >= from && at < until;

describe("property-based harness", () => {
  it("abutting half-open intervals never both contain the same instant", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        (start, firstLength, secondLength, at) => {
          const boundary = start + firstLength;
          const end = boundary + secondLength;
          const inFirst = contains(start, boundary, at);
          const inSecond = contains(boundary, end, at);
          // The boundary instant belongs to exactly one of them, never both, never neither.
          return !(inFirst && inSecond);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("reports a replayable seed when a property fails", () => {
    // A property failure that cannot be reproduced is a flake, not a finding.
    let message = "";
    try {
      fc.assert(
        fc.property(fc.integer(), (n) => n !== n),
        { seed: 42, numRuns: 10 },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // fast-check prints the seed and the shrink path; both are needed to replay a
    // failure exactly. Assert on the seed rather than the phrasing around it.
    expect(message).toContain("seed: 42");
    expect(message).toContain("path:");
    expect(message).toContain("Counterexample");
  });
});
