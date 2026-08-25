/**
 * The Drizzle schema.
 *
 * `ADR-0000`: Drizzle for schema and typed queries, hand-written SQL for migrations. The
 * DDL carries the guarantees -- exclusion constraints, triggers, revoked privileges,
 * composite foreign keys including `tenant_id` -- and a migration tool that abstracts DDL
 * away is disqualifying. So this file describes the schema for typed queries; it does not
 * generate it.
 *
 * Which raises the obvious question: what stops the two disagreeing? The drift check in
 * `verify.ts` builds one database from the migration chain and another from this
 * definition, then compares them. A mismatch fails CI. Without that, "the model and the
 * database disagree" is a runtime discovery.
 *
 * Empty right now, deliberately. POL-003 is the harness; the tables arrive with POL-006
 * onward, and `data-model.md` § Verification is their exit criterion.
 */

// No tables yet. The drift check is exercised against this emptiness, which is a real
// assertion: it fails if a migration creates a table this file does not describe.
export {};
