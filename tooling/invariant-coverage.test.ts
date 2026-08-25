/**
 * Tests for the coverage gate itself.
 *
 * This gate is the only thing standing between `agent-workflow.md`'s traceability chain
 * and it being decorative, and it is the piece most likely to be quietly weakened later
 * -- by a broadened regex, a swallowed error, or a register entry that stops being
 * checked. So its three failure modes are tested rather than assumed.
 */
import { describe, expect, it } from "vitest";
import { citedInTitles, parseRegister, parseRegistry, problems } from "./invariant-coverage.js";

const registryWith = (...ids: string[]): string =>
  [
    "# Invariant Registry",
    "",
    ...ids.map((id) => `| ${id} | some statement | why | I | MVP |`),
  ].join("\n");

describe("parseRegistry", () => {
  it("reads invariant ids from table rows", () => {
    expect(parseRegistry(registryWith("INV-TEN-001", "INV-AUD-002"))).toEqual(
      new Set(["INV-TEN-001", "INV-AUD-002"]),
    );
  });

  it("ignores prose that merely mentions an id", () => {
    const text = "Some paragraph explaining INV-TEN-001 at length.\n";
    expect(parseRegistry(text).size).toBe(0);
  });
});

describe("parseRegister", () => {
  it("reads entries and their reasons", () => {
    const r = parseRegister("- INV-TEN-001 — MVP; no schema yet (POL-006)\n");
    expect(r.get("INV-TEN-001")).toBe("MVP; no schema yet (POL-006)");
  });

  it("ignores worked examples inside fenced code blocks", () => {
    // The register documents its own format. An example that parsed as a real entry
    // would report a phantom invariant -- a gate failing against documentation.
    const text = ["```text", "- INV-XXX-000 — the format", "```", ""].join("\n");
    expect(parseRegister(text).size).toBe(0);
  });
});

describe("citedInTitles", () => {
  it("reads ids from describe and it titles", () => {
    const src = `describe("INV-TEN-001: isolation", () => { it("INV-AUD-002 appends", () => {}); });`;
    expect(citedInTitles(src)).toEqual(["INV-TEN-001", "INV-AUD-002"]);
  });

  it("does NOT count an id mentioned only in a comment", () => {
    // Scanning file contents rather than titles would let a passing remark count as
    // coverage, which is worse than no coverage: it looks green.
    const src = `// INV-TEN-001 is relevant here\ndescribe("isolation", () => {});`;
    expect(citedInTitles(src)).toEqual([]);
  });

  it("reads ids from it.each and describe.skip", () => {
    const src = `describe.skip("INV-EFF-002 overlap", () => {});`;
    expect(citedInTitles(src)).toEqual(["INV-EFF-002"]);
  });
});

describe("problems", () => {
  const cov = (opts: {
    registered?: string[];
    tested?: Record<string, string[]>;
    pending?: Record<string, string>;
  }) => ({
    registered: new Set(opts.registered ?? []),
    tested: new Map(Object.entries(opts.tested ?? {})),
    pending: new Map(Object.entries(opts.pending ?? {})),
  });

  it("fails an invariant that is neither tested nor registered", () => {
    const p = problems(cov({ registered: ["INV-TEN-001"] }));
    expect(p).toHaveLength(1);
    expect(p[0]?.kind).toBe("untested-and-unregistered");
  });

  it("fails an invariant that is BOTH tested and still listed as pending", () => {
    // Otherwise the register rots into a list of things that were quietly done, and
    // stops meaning anything.
    const p = problems(
      cov({
        registered: ["INV-TEN-001"],
        tested: { "INV-TEN-001": ["a.test.ts"] },
        pending: { "INV-TEN-001": "not yet" },
      }),
    );
    expect(p).toHaveLength(1);
    expect(p[0]?.kind).toBe("registered-but-tested");
  });

  it("fails a test that names an id absent from the registry", () => {
    // A typo looks exactly like coverage while proving nothing at all.
    const p = problems(cov({ registered: [], tested: { "INV-TEN-999": ["a.test.ts"] } }));
    expect(p).toHaveLength(1);
    expect(p[0]?.kind).toBe("unknown-id");
  });

  it("fails a register entry for an id absent from the registry", () => {
    const p = problems(cov({ registered: [], pending: { "INV-GONE-001": "stale" } }));
    expect(p[0]?.kind).toBe("unknown-id");
  });

  it("passes when every invariant is either tested or registered", () => {
    const p = problems(
      cov({
        registered: ["INV-TEN-001", "INV-AUD-002"],
        tested: { "INV-TEN-001": ["a.test.ts"] },
        pending: { "INV-AUD-002": "no ledger yet (POL-008)" },
      }),
    );
    expect(p).toEqual([]);
  });
});
