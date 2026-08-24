# Phase 1 — Architecture

Turn the specification into an architecture: a selected stack, a physical data model, a
threat model, and the ADRs that record why each is the way it is.

**Phase 1 is complete when a Codex-ready ticket can be written against a real schema.**

## What Phase 0 handed over

| Input | Consequence for this phase |
|---|---|
| 145 invariants with an enforcement ladder | Every level-1 and level-2 target must map to a concrete database mechanism, or drop a level with a stated reason |
| `domain-model.md` — ~45 entities | The physical model is derived from it, not reinvented |
| File-centric content (decision 2) | Content storage holds the uploaded controlled file; extracted text is derived and never hashed |
| `LegalEntity` schema-complete, behaviour-minimal (decision 1) | The entity dimension exists in the first migration; resolution does not traverse it yet |
| One EU region, complete (decision 7) | Every provider in the budget posture needs an EU-jurisdiction option, or a Decision Request |
| TypeScript, public repository | `ADR-0000` |

## Conventions for this phase

- **An ADR records a decision, not a design document.** Context, decision, alternatives,
  consequences, cost of reversal. If it reads like a tutorial, it is too long.
- **Every ADR that carries an invariant names it.** The link from `INV-*` to the mechanism
  that enforces it must be visible where the enforcement lives — including in SQL
  comments.
- **Nothing costing money is decided here.** It is a Decision Request.
- **Where an ADR cannot be written without a fact about a vendor**, the fact is verified
  before the ADR is accepted, not assumed. `ADR-0000` carries a list of exactly this.

## Done

- [x] `ADR-0000` — stack selection. TypeScript modular monolith, PostgreSQL, Drizzle with
      hand-written SQL migrations, Postgres-backed job queue, Postgres full-text search

## Remaining — ADRs

Roughly in dependency order. Each is small; several are a page.

- [ ] `ADR-0001` — **Tenancy enforcement.** Composite keys alone, or also row-level
      security? Which role the application connects as, and what that role may not do.
      Carries INV-TEN-001…005
- [ ] `ADR-0002` — **Identity and sessions.** Local accounts for the Pilot, and the shape
      that keeps OIDC, SAML and SCIM additive in V1. Carries INV-AUTH-014
- [ ] `ADR-0003` — **The authorization evaluator.** Its interface, how every surface is
      made to call it, and what may be cached given that expiry is evaluated at check time.
      Carries INV-AUTH-001…004, INV-AUTH-010
- [ ] `ADR-0004` — **Content storage and canonicalisation.** Bucket layout, the canonical
      manifest's serialisation, the digest algorithm, and text extraction for comparison.
      Carries INV-VER-009, INV-VER-013
- [ ] `ADR-0005` — **Effectivity and supersession.** The exclusion constraint's exact
  scope
      key, and the supersession transaction. Carries INV-EFF-002, INV-EFF-003, INV-EFF-007
- [ ] `ADR-0006` — **Audit outbox.** Table design, delivery, and the total ordering
      INV-AUD-009 requires. Carries INV-AUD-002, INV-AUD-004, INV-AUD-009
- [ ] `ADR-0007` — **Job execution.** Queue choice, idempotency keys, retry and failure
      semantics, and scheduling across DST. Carries INV-EFF-007, INV-TIME-002, INV-TIME-004
- [ ] `ADR-0008` — **Evidence pack generation.** Assembly, determinism, streaming, storage
      and expiry. Carries INV-EVD-003, INV-EVD-006, INV-EVD-010
- [ ] `ADR-0009` — **Migrations and environments.** Neon branching, seeding, and the
      fresh-versus-upgrade validation the CI gate list requires
- [ ] `ADR-0010` — **Observability.** What is recorded, what stays in-region, and how it
      stays out of the evidence ledger. Carries INV-AUD-007, INV-AUD-003

## Remaining — models

- [ ] `docs/architecture/data-model.md` — the physical schema derived from
      `domain-model.md`: tables, keys, constraints, indexes, and the invariant each
      constraint enforces
- [ ] `docs/architecture/threat-model.md` — assets, actors, trust boundaries, and the
      abuse cases the invariants already answer. Tenant isolation, evidence integrity and
      privilege elevation are the three that matter
- [ ] `docs/architecture/README.md` — how the pieces fit, in one page, for a security
      reviewer

## Exit criteria

- [ ] Every level-1 and level-2 enforcement target in `invariants.md` maps to a named
      mechanism in the physical model, or has dropped a level with a recorded reason
- [ ] The physical model covers every entity in `domain-model.md`, or states why one is
      deferred
- [ ] The threat model's abuse cases each resolve to an invariant or to a recorded
      acceptance
- [ ] Every item on `ADR-0000`'s verification list is checked against the actual vendors
- [ ] No ADR contradicts `docs/domain/` — and where one wanted to, a Decision Request was
      opened instead

## What comes after

| Phase | Output |
|---|---|
| **2 — Repository bootstrap** | CI workflows, Docker local environment, migrations, test harness, Playwright, rulesets, CODEOWNERS, licence. **Blocked on decision 8 — the product name** |
| **3 — Golden slice** | The vertical slice decomposed into Codex-ready tickets: create → draft → submit → request changes → approve → publish → effective → attest → review → evidence pack |
