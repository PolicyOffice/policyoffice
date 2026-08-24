# Phase 1 — Architecture

Turn the specification into an architecture: a selected stack, a physical data model, a
threat model, and the ADRs that record why each is the way it is.

**Phase 1 is complete when a Codex-ready ticket can be written against a real schema.**

**Status: complete.** Eleven ADRs, the physical data model, the threat model and a one-page
architecture summary. The vendor-verification criterion moved to Phase 2, where the accounts
are created — see below.

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
- [x] `ADR-0001` — tenancy enforcement. Composite keys at level 1, forced row-level security
      at level 2, one transaction helper that requires a tenant context
- [x] `ADR-0002` — identity and sessions. Server-side sessions in Postgres, local passwords
      for the Pilot, and the three rules that keep enterprise identity additive
- [x] `ADR-0003` — the authorization evaluator. One function returning a reason rather than
      a boolean, typed capabilities, and an architecture test that makes the boundary real
- [x] `ADR-0004` — content storage and canonicalisation. Content-addressed objects
      partitioned per tenant, server-computed digests, canonical JSON manifests, and a hard
      line between governed and derived artefacts
- [x] `ADR-0005` — effectivity and supersession. The interval is claimed at publication, an
      exclusion constraint keyed on the variant enforces INV-EFF-002, and resolution reads
      the range rather than a state column
- [x] `ADR-0006` — the audit ledger and outbound delivery. Written in the same transaction,
      ordered by a gapless per-tenant sequence, append-only by revoked privilege, and read
      forward by cursor for webhooks and SIEM
- [x] `ADR-0007` — job execution and scheduling. At-least-once with idempotency in the
      domain transaction, reference payloads, calendar-rule scheduling, and failure that
      raises a governance exception rather than a log line
- [x] `ADR-0008` — evidence pack generation. Resolve, assemble, publish; availability is a
      database fact rather than the presence of an object; per-record authorization at
      assembly. Raised open decision 9
- [x] `ADR-0009` — migrations and environments. Forward-only SQL, no down migrations, three
      database roles established by migration, and CI validating fresh install, upgrade and
      drift against a container
- [x] `ADR-0010` — observability. Two permanently separate systems, an allowlist rather than
      redaction, no session replay or behavioural analytics, and the governance signals that
      actually need alerting

## ADRs — complete

All eleven planned ADRs are written. Further ADRs are raised as the architecture meets
reality rather than planned in advance.

`ADR-0008` raised **open decision 9**, because deciding it in an ADR would have quietly
narrowed a deliverable specified in `evidence-model.md`. That is the fourth exit criterion
working as intended rather than a problem.

## Models — done

- [x] `docs/architecture/data-model.md` — the physical schema. All 46 entities from
      `domain-model.md`, an enforcement map from every level-1 and level-2 invariant to its
      mechanism, and the eight that deliberately sit lower with the reason recorded
- [x] `docs/architecture/threat-model.md` — assets, actors, trust boundaries, the three
      abuse categories that matter, and the residual risks written down as accepted rather
      than left unstated
- [x] `docs/architecture/README.md` — one page for a security reviewer, with the decision
      record, what we do not claim, and the unverified list stated openly


## Exit criteria

- [x] Every level-1 and level-2 enforcement target in `invariants.md` maps to a named
      mechanism in the physical model, or has dropped a level with a recorded reason —
      the enforcement map in `data-model.md`, with eight deliberate drops
- [x] The physical model covers every entity in `domain-model.md`, or states why one is
      deferred — all 46
- [x] The threat model's abuse cases each resolve to an invariant or to a recorded
      acceptance — eight accepted residual risks, each with the trigger that would change it
- [ ] ~~Every item on `ADR-0000`'s verification list is checked against the actual
      vendors~~ — **moved to Phase 2.** See below
- [x] No ADR contradicts `docs/domain/` — and where one wanted to, a Decision Request was
      opened instead: `ADR-0008` raised open decision 9 rather than narrowing the evidence
      pack layout

### The verification criterion moves to Phase 2

It was written as a Phase 1 criterion and belongs in Phase 2, for a practical reason that
was not obvious when the plan was drafted: every item on it requires an account with a
vendor, and creating those accounts is the first thing repository bootstrap does.

Verifying earlier would mean creating the accounts in Phase 1 and doing it twice. The list
is carried forward intact — it is the first task of Phase 2, before any migration is
written, because `ADR-0001` and `ADR-0005` have no fallback that preserves the same
enforcement level if the platform refuses.

## Phase 1 is closed

Eleven ADRs, a physical data model covering 46 entities, a threat model, and a one-page
architecture summary. Four of five exit criteria met; the fifth carried forward with its
reason recorded.

Architecture no longer blocks implementation. What blocks Phase 2 is **open decision 8, the
product and repository name** — the licence file needs a licensor and a product, and the CI
gate list assumes a public repository.

## What comes after

| Phase | Output |
|---|---|
| **2 — Repository bootstrap** | CI workflows, Docker local environment, migrations, test harness, Playwright, rulesets, CODEOWNERS, licence. **Blocked on decision 8 — the product name** |
| **3 — Golden slice** | The vertical slice decomposed into Codex-ready tickets: create → draft → submit → request changes → approve → publish → effective → attest → review → evidence pack |
