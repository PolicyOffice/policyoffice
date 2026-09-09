import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_COMMENT_QUERY,
  constraintCommentProblems,
  type ConstraintCommentException,
  type ConstraintCommentRow,
} from "./constraint-comments.js";

const row = (
  table_name: string,
  constraint_name: string,
  comment: string | null,
): ConstraintCommentRow => ({
  schema_name: "public",
  table_name,
  constraint_name,
  comment,
});

describe("constraint comment coverage", () => {
  it("discovers governed constraints from the catalogue and excludes runner bookkeeping", () => {
    expect(CONSTRAINT_COMMENT_QUERY).toContain("from pg_constraint");
    expect(CONSTRAINT_COMMENT_QUERY).toContain("con.contype in ('p', 'u', 'f', 'c', 'x')");
    expect(CONSTRAINT_COMMENT_QUERY).toContain("rel.relname <> 'schema_migration'");
  });

  it("distinguishes invariant comments, missing comments, and documented exceptions", () => {
    const exception: ConstraintCommentException = {
      table: "excepted_table",
      constraint: "excepted_constraint",
      reason: "This fixture deliberately has no registered invariant.",
    };

    expect(
      constraintCommentProblems(
        [
          row("commented_table", "commented_constraint", "INV-TEN-003: tenant-contained"),
          row("missing_table", "missing_constraint", null),
          row("excepted_table", "excepted_constraint", null),
        ],
        [exception],
      ),
    ).toEqual([
      "public.missing_table.missing_constraint: missing invariant ID comment or documented exception",
    ]);
  });

  it("does not treat an exception without a reason as documented", () => {
    expect(
      constraintCommentProblems(
        [row("table", "constraint", null)],
        [{ table: "table", constraint: "constraint", reason: "" }],
      ),
    ).toEqual(["public.table.constraint: missing invariant ID comment or documented exception"]);
  });
});
