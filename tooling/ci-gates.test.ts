/**
 * The gate list, the workflows and the branch ruleset must agree.
 *
 * Three artefacts describe the merge gate and nothing keeps them in step: the prose list
 * in `agent-workflow.md`, the jobs in `.github/workflows/`, and the required status checks
 * in `.github/rulesets/main.json`. A required check whose job was renamed blocks every
 * pull request forever; a job whose check was dropped from the ruleset stops gating
 * anything and nobody notices, which is the worse of the two.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string): string => readFileSync(new URL(p, new URL(root, "file:")), "utf8");

interface Workflow {
  name?: string;
  jobs?: Record<string, { name?: string; if?: string }>;
}

const workflows = [".github/workflows/pr.yml", ".github/workflows/codeql.yml"].map(
  (p) => [p, parse(read(p)) as Workflow] as const,
);

const jobNames = new Set(
  workflows.flatMap(([, wf]) => Object.values(wf.jobs ?? {}).map((j) => j.name ?? "")),
);
// Set by .github/workflows/independent-review.yml as a commit status, not a job.
jobNames.add("independent review");

interface Ruleset {
  rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
}
const ruleset = JSON.parse(read(".github/rulesets/main.json")) as Ruleset;
const required = (
  ruleset.rules.find((r) => r.type === "required_status_checks")?.parameters
    ?.required_status_checks ?? []
).map((c) => c.context);

describe("the branch ruleset and the workflows agree", () => {
  it("has required checks to compare, so this does not pass vacuously", () => {
    expect(required.length).toBeGreaterThan(5);
    expect(jobNames.size).toBeGreaterThan(5);
  });

  it("every required status check is produced by a job that exists", () => {
    // A required check with no job blocks every pull request indefinitely, waiting for a
    // status that nothing will ever report.
    const orphaned = required.filter((c) => !jobNames.has(c));
    expect(orphaned, `required checks with no matching job: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("every gate job is a required status check", () => {
    // The quieter failure: a job that runs, goes red, and gates nothing.
    const notRequired = [...jobNames].filter((n) => n && !required.includes(n));
    expect(notRequired, `jobs that gate nothing: ${notRequired.join(", ")}`).toEqual([]);
  });
});

describe("the ruleset does not deadlock the merge policy", () => {
  it("does not require code-owner review", () => {
    // The only code owner is the founder, and agent-workflow.md's merge policy is that
    // nobody clicks anything. Requiring it deadlocks every Tier 2 pull request on the one
    // person the workflow exists to keep out of the loop. CODEOWNERS says so too.
    const pr = ruleset.rules.find((r) => r.type === "pull_request") as
      { parameters?: Record<string, unknown> } | undefined;
    expect(pr?.parameters?.require_code_owner_review).toBe(false);
    expect(pr?.parameters?.required_approving_review_count).toBe(0);
  });

  it("allows squash merges only", () => {
    const pr = ruleset.rules.find((r) => r.type === "pull_request") as
      { parameters?: { allowed_merge_methods?: string[] } } | undefined;
    expect(pr?.parameters?.allowed_merge_methods).toEqual(["squash"]);
  });
});

describe("no AI in the required-check path", () => {
  it("no gate workflow calls a model or a non-deterministic service", () => {
    // agent-workflow.md: "No AI in the required-check path, ever." The independent-review
    // check is the documented exception and lives in its own workflow -- it records that a
    // review happened and decides nothing about correctness.
    const gateSources = [read(".github/workflows/pr.yml"), read(".github/workflows/codeql.yml")];
    for (const source of gateSources) {
      expect(source).not.toMatch(/anthropic|openai|api\.claude|generativelanguage/i);
    }
  });

  it("pins every third-party action to a commit sha rather than a tag", () => {
    // A tag is mutable. This is a supply-chain surface on a repository whose proposition
    // is trustworthiness.
    const sources = [
      ...workflows.map(([p]) => read(p)),
      read(".github/workflows/independent-review.yml"),
      read(".github/workflows/neon-verification.yml"),
      read(".github/actions/setup/action.yml"),
    ];
    // Anchored to the start of a line. An unanchored /uses:/ also matches the tail of
    // "statuses: write" in a permissions block, which is how this test first went red.
    const uses = sources.flatMap((s) =>
      [...s.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((m) => m[1]!),
    );
    const external = uses.filter((u) => !u.startsWith("./"));
    expect(external.length).toBeGreaterThan(3);
    for (const ref of external) {
      expect(ref, `${ref} is not pinned to a 40-character commit sha`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
