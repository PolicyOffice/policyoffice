import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ReviewComment {
  readonly body?: unknown;
  readonly user?: Readonly<{ login?: unknown }> | null;
}

export interface IndependentReviewResult {
  readonly state: "pending" | "success";
  readonly description: string;
}

interface IndependentReviewInput {
  readonly comments: readonly unknown[];
  readonly headSha: string;
  readonly reviewerLogins: readonly string[];
}

const REVIEW_MARKER = /Reviewed-commit: ([0-9a-f]{40})(?![0-9a-fA-F])/g;

function flattenedComments(comments: readonly unknown[]): readonly unknown[] {
  return comments.flatMap((comment) => (Array.isArray(comment) ? comment : [comment]));
}

function reviewMarkers(body: unknown): readonly string[] {
  if (typeof body !== "string") return [];
  return [...body.matchAll(REVIEW_MARKER)].map((match) => match[1]!);
}

function latestAuthorizedReview(
  comments: readonly unknown[],
  reviewerLogins: readonly string[],
): string | undefined {
  const reviewers = new Set(reviewerLogins);
  let latest: string | undefined;

  for (const value of flattenedComments(comments)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const comment = value as ReviewComment;
    const login = comment.user?.login;
    if (typeof login !== "string" || !reviewers.has(login)) continue;
    for (const marker of reviewMarkers(comment.body)) latest = marker;
  }

  return latest;
}

export function evaluateIndependentReview({
  comments,
  headSha,
  reviewerLogins,
}: IndependentReviewInput): IndependentReviewResult {
  const reviewedSha = latestAuthorizedReview(comments, reviewerLogins);

  if (reviewedSha === headSha) {
    return {
      state: "success",
      description: "reviewed against the specification at this commit",
    };
  }
  if (reviewedSha) {
    return {
      state: "pending",
      description: `last review covered ${reviewedSha.slice(0, 7)}, not this commit`,
    };
  }
  return {
    state: "pending",
    description: "awaiting a conformance review of this commit",
  };
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be a JSON array of strings`);
  }
  return value;
}

function main(): void {
  const [headSha, commentsPath, reviewersPath] = process.argv.slice(2);
  if (!headSha || !commentsPath || !reviewersPath) {
    throw new TypeError(
      "usage: node independent-review.ts <head-sha> <comments.json> <reviewers.json>",
    );
  }
  const comments = JSON.parse(readFileSync(commentsPath, "utf8")) as unknown;
  if (!Array.isArray(comments)) throw new TypeError("comments must be a JSON array");
  const reviewerLogins = stringArray(
    JSON.parse(readFileSync(reviewersPath, "utf8")) as unknown,
    "reviewers",
  );
  process.stdout.write(
    JSON.stringify(evaluateIndependentReview({ comments, headSha, reviewerLogins })),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) main();
