# Phase 0 — Specification Consolidation

Turn the archived research in `docs/research/` into one canonical, non-contradictory
specification under `docs/domain/` and `docs/product/`, and surface every decision that
needs the founder rather than inventing an answer.

**Phase 0 is complete when architecture can begin without reopening product questions.**

**Status: the writing is done.** Sixteen chapters, 145 invariants, eight decisions written
up. What remains is the founder answering decisions 1, 2 and 7 — the three that block the
physical data model.

## Conventions for this phase

Established in earlier passes; do not re-litigate them without a reason.

- The aggregate is `Document`, not `Policy`. See `docs/domain/glossary.md`.
- Every domain rule gets a stable `INV-*` ID in `docs/domain/invariants.md`, and targets
  the strongest practical enforcement level.
- Where the sources disagree, record the resolution in `docs/domain/consolidation-notes.md`
  rather than silently picking one.
- Where a question needs the founder, add it to `docs/plans/open-decisions.md`. Do not
  invent an answer and do not stall the rest of the work waiting for one.
- `docs/research/` is archived and non-normative. `docs/domain/` wins any disagreement.

## Done

- [x] `docs/domain/glossary.md` — ubiquitous language, `Policy` → `Document` rename
- [x] `docs/domain/document-taxonomy.md` — ranked types, governance bodies, governing framework
- [x] `docs/domain/configuration-model.md` — invariant/configurable boundary, governance profiles
- [x] `docs/domain/invariants.md` — 145 invariants, stable IDs, enforcement ladder
- [x] `docs/domain/consolidation-notes.md` — 14 contradictions, 12 later refinements
- [x] `docs/engineering/agent-workflow.md` — process, review tiers, decision protocol
- [x] `docs/engineering/definition-of-done.md`
- [x] `docs/engineering/running-the-agents.md` — operating mechanics
- [x] `docs/research/` — source material archived

## Done — domain

Written in dependency order. Each cites the `INV-*` IDs it governs, and the registry grew
from 113 to 145 invariants in the same pass — a new `INV-ORG` family plus additions to
nine existing ones. Every registered invariant is now cited by at least one chapter.

- [x] `domain-model.md` — consolidated entity model and ER diagram, one table per entity
- [x] `document-lifecycle.md` — `Document` and `DocumentVersion` state machines, transition tables
- [x] `versioning.md` — content revisions, submission freeze, immutability, canonicalisation and hashing, materiality classes
- [x] `authorization-model.md` — capabilities, scopes, inheritance, explicit deny, time-bounded grants, break-glass
- [x] `approval-workflows.md` — templates and versioning, stages, completion rules including `BODY_RESOLUTION`, delegation, escalation, separation of duties
- [x] `review-model.md` — review rules, cases, outcomes, overdue semantics
- [x] `attestation-model.md` — campaigns, assignments, responses, audience modes, re-attestation
- [x] `multi-entity-model.md` — legal entities, org units, jurisdictions, variant types, the deterministic resolution algorithm, alignment obligations
- [x] `audit-event-catalogue.md` — canonical envelope and the full event list
- [x] `evidence-model.md` — pack contents, manifest schema, integrity, privacy profiles, point-in-time reconstruction
- [x] `business-rules.md` — edge cases and failure modes consolidated from both sources

## Done — product

- [x] `product-blueprint.md` — mission, boundaries, what the product is explicitly not
- [x] `personas-and-jobs.md` — personas and jobs to be done
- [x] `information-architecture.md` — reader experience and governance experience, kept distinct
- [x] `scope-and-roadmap.md` — Pilot / Commercial V1 / Later, with testable acceptance criteria
- [x] `success-metrics.md`

## Remaining — decisions

- [x] `docs/plans/open-decisions.md` — every question needing the founder, each with options,
      a recommendation, consequence and reversibility
- [x] **Decisions 1, 2 and 7 answered** on 2026-08-24. Architecture is unblocked

| # | Decision | Status |
|---:|---|---|
| 1 | How much `LegalEntity` capability belongs in the Pilot | **Decided** — schema-complete, behaviour-minimal |
| 2 | Native editor vs file-centric authoring | **Decided** — file-centric |
| 3 | Final `Space` semantics | Open. Affects register navigation only |
| 4 | Fixed workflow vs configurable templates in the Pilot | Open. Affects whether a template editor ships |
| 5 | Pilot applicability — explicit audience lists, or rules | Open. Affects Pilot resolution complexity |
| 6 | Licence | Open. Gates publishing the repository |
| 7 | Data residency and hosting region | **Decided** — one EU region, stated completely |
| 8 | Product and repository name | Open. Gates publishing the repository |

The four still open shape scope or gate publication. None blocks architecture, and none
changes an invariant.

## Exit criteria

- [x] Every remaining file above exists and cites invariant IDs
- [x] No contradiction remains between `docs/domain/` files
- [x] Every open decision is written down with a recommendation, and the founder has answered
      those that block the physical data model — answered 2026-08-24
- [x] `docs/research/` is referenced by nothing normative

The second criterion was verified rather than asserted. What was checked:

- every `INV-*` citation across `docs/` resolves to a registered invariant, and every
  registered invariant is cited by at least one chapter — both directions, mechanically;
- no duplicate invariant IDs;
- enumerated values agree across chapters — lifecycle states, completion rules, decision
  types, variant types, materiality classes, scope types, assignment states, pack states;
- capability names used in any chapter exist in the enumeration in `authorization-model.md`;
- event names used in any chapter exist in `audit-event-catalogue.md`;
- no chapter uses pre-consolidation vocabulary — `Policy` as the aggregate, `PolicyVersion`,
  `Department`, `PolicyException` — outside the historical tables in
  `consolidation-notes.md` that deliberately record it.

What that does **not** cover is semantic contradiction a reader would catch and a grep
would not. Phase 1 will surface any of those the first time the physical model is derived
from these chapters, which is the right time to find them.

## What comes after

| Phase | Output |
|---|---|
| **1 — Architecture** | ADR-000 stack selection, then the ADR backlog. Threat model. Physical data model. |
| **2 — Repository bootstrap** | CI workflows, Docker local environment, migrations, test harness, Playwright, rulesets, CODEOWNERS, licence |
| **3 — Golden slice** | The vertical slice decomposed into Codex-ready tickets: create → draft → submit → request changes → approve → publish → effective → attest → review → evidence pack |
