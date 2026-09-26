import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluateIndependentReview } from "./independent-review.js";

const HEAD = "1".repeat(40);
const OLD = "2".repeat(40);
const OUTSIDER = "mallory";
const REVIEWERS = JSON.parse(
  readFileSync(new URL("../.github/independent-reviewers.json", import.meta.url), "utf8"),
) as string[];
const WORKFLOW_SOURCE = readFileSync(
  new URL("../.github/workflows/independent-review.yml", import.meta.url),
  "utf8",
);

function comment(login: string, sha: string): Readonly<{ body: string; user: { login: string } }> {
  return { body: `Reviewed-commit: ${sha}`, user: { login } };
}

describe("the independent review decision", () => {
  it("keeps the status pending when an outsider names the head", () => {
    expect(
      evaluateIndependentReview({
        comments: [comment(OUTSIDER, HEAD)],
        headSha: HEAD,
        reviewerLogins: REVIEWERS,
      }),
    ).toEqual({
      state: "pending",
      description: "awaiting a conformance review of this commit",
    });
  });

  it("sets success when a listed reviewer names the head", () => {
    expect(
      evaluateIndependentReview({
        // `gh api --paginate --slurp` returns one nested array per response page.
        comments: [[comment("aca333", HEAD)]],
        headSha: HEAD,
        reviewerLogins: REVIEWERS,
      }),
    ).toEqual({
      state: "success",
      description: "reviewed against the specification at this commit",
    });
  });

  it("lets only listed reviewers compete for the latest review", () => {
    expect(
      evaluateIndependentReview({
        comments: [comment("aca333", HEAD), comment(OUTSIDER, OLD)],
        headSha: HEAD,
        reviewerLogins: REVIEWERS,
      }),
    ).toEqual({
      state: "success",
      description: "reviewed against the specification at this commit",
    });
  });

  it("reports the listed review's short sha when it names an older commit", () => {
    expect(
      evaluateIndependentReview({
        comments: [comment("aca333", OLD)],
        headSha: HEAD,
        reviewerLogins: REVIEWERS,
      }),
    ).toEqual({
      state: "pending",
      description: "last review covered 2222222, not this commit",
    });
  });

  it.each([
    "Reviewed-commit: 1234567",
    `Reviewed-commit: ${"a".repeat(39)}`,
    `Reviewed-commit: ${"a".repeat(41)}`,
    `Reviewed-commit: ${"A".repeat(40)}`,
  ])("ignores a shortened or malformed marker: %s", (body) => {
    expect(
      evaluateIndependentReview({
        comments: [{ body, user: { login: "aca333" } }],
        headSha: HEAD,
        reviewerLogins: REVIEWERS,
      }),
    ).toEqual({
      state: "pending",
      description: "awaiting a conformance review of this commit",
    });
  });

  it("loads the exact reviewer allowlist required by the repository", () => {
    expect(REVIEWERS).toEqual(["aca333"]);
  });
});

describe("the independent review workflow boundary", () => {
  interface Workflow {
    readonly on?: Readonly<Record<string, { readonly types?: readonly string[] }>>;
    readonly permissions?: Readonly<Record<string, string>>;
    readonly jobs?: Readonly<
      Record<
        string,
        {
          readonly if?: string;
          readonly permissions?: Readonly<Record<string, string>>;
          readonly steps?: readonly {
            readonly env?: Readonly<Record<string, string>>;
            run?: string;
          }[];
        }
      >
    >;
  }

  const workflow = parse(WORKFLOW_SOURCE) as Workflow;
  const record = workflow.jobs?.record;
  const evaluateStep = record?.steps?.[0];

  it("runs pull request changes from the default-branch workflow", () => {
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(workflow.on?.pull_request_target?.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(record?.if).toBe(
      "github.event_name == 'pull_request_target' || github.event.issue.pull_request",
    );
    expect(evaluateStep?.env?.PR).toContain("github.event_name == 'pull_request_target'");
  });

  it("keeps the documented token permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(record?.permissions).toEqual({
      contents: "read",
      statuses: "write",
      "pull-requests": "read",
    });
  });

  it("executes only the evaluator and allowlist fetched from the default branch", () => {
    const run = evaluateStep?.run ?? "";
    expect(run).toContain("tooling/independent-review.ts?ref=$DEFAULT_BRANCH");
    expect(run).toContain(".github/independent-reviewers.json?ref=$DEFAULT_BRANCH");
    expect(run).not.toContain("?ref=$HEAD_SHA");
    expect(run).not.toMatch(/\b(?:git|npm|pnpm|yarn|bun)\b/);
  });
});
