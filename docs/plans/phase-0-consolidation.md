# Phase 0 — Specification Consolidation

Turn the archived research in `docs/research/` into one canonical, non-contradictory
specification under `docs/domain/` and `docs/product/`, and surface every decision that
needs the founder rather than inventing an answer.

**Phase 0 is complete when architecture can begin without reopening product questions.**

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

## Remaining — product

- [ ] `product-blueprint.md` — mission, boundaries, what the product is explicitly not
- [ ] `personas-and-jobs.md` — personas and jobs to be done
- [ ] `information-architecture.md` — reader experience and governance experience, kept distinct
- [ ] `scope-and-roadmap.md` — Pilot / Commercial V1 / Later, with testable acceptance criteria
- [ ] `success-metrics.md`

## Remaining — decisions

- [x] `docs/plans/open-decisions.md` — every question needing the founder, each with options,
      a recommendation, consequence and reversibility
- [ ] **The founder answers 1, 2 and 7.** Those three block Phase 1

Eight decisions are written up. Decisions 1, 2 and 7 block the physical data model and
therefore Phase 1; the rest shape scope without stopping architecture.

1. How much `LegalEntity` capability belongs in the Pilot — **blocks Phase 1**
2. Native editor vs file/Office-centric authoring — canonical content and hashing — **blocks Phase 1**
3. Final `Space` semantics
4. Whether the Pilot ships a fixed workflow or configurable templates
5. Pilot applicability complexity — explicit audience lists, or rules
6. Licence: BSL 1.1 vs PolyForm Shield (repository is currently unlicensed)
7. Data residency and hosting region — **blocks Phase 1**, added while writing the domain chapters
8. Product and repository name — flagged open in `README.md`, gates publishing the repository

## Exit criteria

- [ ] Every remaining file above exists and cites invariant IDs
- [ ] No contradiction remains between `docs/domain/` files
- [ ] Every open decision is written down with a recommendation, and the founder has answered
      those that block the physical data model
- [x] `docs/research/` is referenced by nothing normative

## What comes after

| Phase | Output |
|---|---|
| **1 — Architecture** | ADR-000 stack selection, then the ADR backlog. Threat model. Physical data model. |
| **2 — Repository bootstrap** | CI workflows, Docker local environment, migrations, test harness, Playwright, rulesets, CODEOWNERS, licence |
| **3 — Golden slice** | The vertical slice decomposed into Codex-ready tickets: create → draft → submit → request changes → approve → publish → effective → attest → review → evidence pack |
