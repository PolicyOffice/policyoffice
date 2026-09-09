import type { QueryResultRow } from "pg";

export interface ConstraintCommentRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  comment: string | null;
}

export interface ConstraintCommentException {
  table: string;
  constraint: string;
  reason: string;
}

/**
 * Constraints that deliberately enforce no registered invariant.
 *
 * Every entry needs a constraint-specific reason. This is an explicit record of why an
 * invariant ID is absent, not a backlog or an allowlist of the constraints the gate checks.
 */
export const CONSTRAINT_COMMENT_EXCEPTIONS: readonly ConstraintCommentException[] = Object.freeze([
  Object.freeze({
    table: "app_user",
    constraint: "app_user_external_identity_unique",
    reason:
      "Prevents one tenant from binding an identity-provider subject twice; no registered invariant requires that mapping to be unique.",
  }),
  Object.freeze({
    table: "document",
    constraint: "document_retirement_instant_consistent",
    reason:
      "Keeps the retirement timestamp consistent with lifecycle state; no registered invariant specifies that timestamp pairing.",
  }),
  Object.freeze({
    table: "document",
    constraint: "document_retirement_reason_required",
    reason:
      "Requires a reason on the retirement transition; no registered invariant requires this check.",
  }),
  Object.freeze({
    table: "document_version",
    constraint: "document_version_effective_interval_start_required",
    reason:
      "Prevents a closed effective interval without a start; no registered invariant specifies this prerequisite independently.",
  }),
  Object.freeze({
    table: "group_membership",
    constraint: "group_membership_identity_validity_unique",
    reason:
      "Prevents duplicate membership facts for the exact same validity interval; no registered invariant requires exact-row uniqueness.",
  }),
]);

/**
 * Discovers every governed constraint from PostgreSQL's catalogue. The migration ledger is
 * runner bookkeeping rather than modelled state, so its table is excluded wholesale here.
 */
export const CONSTRAINT_COMMENT_QUERY = `
  select n.nspname as schema_name,
         rel.relname as table_name,
         con.conname as constraint_name,
         obj_description(con.oid, 'pg_constraint')::text as comment
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname = 'public'
     and rel.relname <> 'schema_migration'
     and con.contype in ('p', 'u', 'f', 'c', 'x')
   order by n.nspname, rel.relname, con.conname
`;

const INVARIANT_ID = /\bINV-[A-Z]+-\d{3}\b/;

export function constraintCommentProblems(
  rows: readonly ConstraintCommentRow[],
  exceptions: readonly ConstraintCommentException[] = CONSTRAINT_COMMENT_EXCEPTIONS,
): string[] {
  const exceptionReasons = new Map(
    exceptions.map(({ table, constraint, reason }) => [`${table}.${constraint}`, reason]),
  );

  return rows
    .filter((row) => {
      const reason = exceptionReasons.get(`${row.table_name}.${row.constraint_name}`);
      return !INVARIANT_ID.test(row.comment ?? "") && !reason?.trim();
    })
    .map(
      (row) =>
        `${row.schema_name}.${row.table_name}.${row.constraint_name}: missing invariant ID comment or documented exception`,
    )
    .sort();
}
