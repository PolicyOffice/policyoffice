# Invariants not yet implemented

Every invariant in `docs/domain/invariants.md` must either be named by a test or appear
here. `tooling/invariant-coverage.ts` enforces that, and it is a required CI gate.

**This file only shrinks.** An entry is removed in the same pull request that adds the
test naming its invariant — the coverage check fails if an invariant is both tested and
still listed here, so a stale entry cannot survive.

Adding an entry is deliberately more visible in a diff than writing the test would have
been. That is the incentive, and it is the point of the file.

**A reason states what exists and what is missing.** "No schema or domain code yet" is a
claim about the tree, and it stops being true the moment the schema lands — after which the
entry hides a real gap behind a false explanation instead of exposing it. Name the thing
that landed and the specific clause still unenforced, so a reader can tell an untouched
subject from a half-built one. Re-read the code before writing the reason; do not copy the
line above it.

Format, parsed strictly:

```text
- INV-XXX-000 — reason, and the ticket that will implement it
```

## INV-TEN — Tenant isolation


## INV-DOC — Document identity and lifecycle

- INV-DOC-003 — MVP; retirement landed (`retireDocument` emits `document.retired`, with integration coverage). Restoration did not: `document.restored` is a name in the audit catalogue with no emission path, and this invariant is entirely about restoring
- INV-DOC-030 — V1; `alignment_obligation` and its integrity triggers landed in `0015`. Nothing raises an obligation when a Governing Framework version is published, and `alignment.raised`/`alignment.resolved` have no emission path yet

## INV-VER — Versioning and immutability

- INV-VER-014 — MVP; the *never derived* half holds by construction — `changeVersionMateriality` takes an explicit class from its caller and no classifier exists — and is covered by tests naming INV-VER-007 and INV-AUD-008. The *confirmed at approval* half has no approval workflow to be confirmed in
- INV-VER-015 — MVP; `changeVersionMateriality` already refuses any change outside `DRAFT`. Raising by resubmission, and the elevated capability plus recorded reason for lowering, all wait on the approval workflow

## INV-EFF — Effectivity and supersession

- INV-EFF-009 — V1; publication currently **refuses** retroactive dates outright (`document_version_retroactive_publication_unsupported`), which is stronger than this invariant asks for. The elevated-capability-with-reason path arrives with approval — whoever builds it must relax that constraint deliberately, not discover it

## INV-APR — Approval

- INV-APR-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-010 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-011 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-012 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-013 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-014 — V1; no schema or domain code yet (Phase 2/3)
- INV-APR-020 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-021 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-022 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-023 — MVP; no schema or domain code yet (Phase 2/3)
- INV-APR-024 — MVP; no schema or domain code yet (Phase 2/3)

## INV-CFG — Configuration

- INV-CFG-001 — MVP; configuration landed in `0007`. This is a meta-invariant over every other entry in the registry, and no single test establishes it — it needs either a structural argument that configuration cannot express an invariant-weakening value, or a per-invariant check. Open as a design question, not merely unimplemented
- INV-CFG-005 — V1; no schema or domain code yet (Phase 2/3)

## INV-AUTH — Authorization

- INV-AUTH-005 — MVP; both subjects now exist — applicability rules (`0015`) and the evaluator (`packages/domain/src/authorization.ts`, #101; `0017` is grant and role storage, and its own header disclaims deciding anything) — and `decide()` takes no applicability input at all. Nothing calls the evaluator yet, so there is no path on which to assert the separation end to end
- INV-AUTH-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-009 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-AUTH-013 — V1; no schema or domain code yet (Phase 2/3)
- INV-AUTH-018 — V1; no schema or domain code yet (Phase 2/3)

## INV-APL — Applicability and variants

Every entry here waits on the same missing piece: the **resolver**. `applicability_rule` and
its constraints (`0015`) and the `variant_type` branches (`0008`) are all stored; no code
turns them into a result set for a given scope and instant, and most of these invariants are
properties of that resolution. `docs/engineering/ci-gates.md` records the same gap against
the property-based gate.

- INV-APL-001 — MVP; rules are stored but nothing resolves them; determinism is a property of the resolver, which does not exist
- INV-APL-002 — V1; the `variant_type` branches (`0008`) and dated `applicability_rule` rows (`0015`) are stored. Nothing resolves a scope and instant to exactly one of them
- INV-APL-003 — V1; publication landed in `0012` and does not consult applicability at all, so the publication-time collision check `data-model.md` assigns this invariant (level 4) has no home yet
- INV-APL-004 — V1; there is no reader path to fail closed in. This invariant governs what resolution does when it cannot choose, and nothing resolves yet
- INV-APL-005 — V1; `SUPPLEMENT` exists as a `variant_type` value (`0008`); coexistence is a property of the resolver, which does not exist
- INV-APL-006 — V1; `TRANSLATION` exists as a `variant_type` value (`0008`). Neither normative scope resolution nor language selection is implemented, so their ordering has nothing to order
- INV-APL-007 — V1; the *never auto-merges* half holds vacuously — no merge or translation code exists. The *marks them alignment-required* half is unbuilt: `alignment_obligation` landed in `0015` but publication (`0012`) raises nothing. Same gap as INV-DOC-030
- INV-APL-009 — V1; the dated facts this reads are in place — membership history (INV-ORG-002) and `applicability_rule` intervals. No resolver reads them, at the requested instant or at all
- INV-APL-012 — V1; both halves are expressible — `inheritance_mode.MANDATORY` (`0015`) and `variant_type.REPLACEMENT`/`SUPPLEMENT` (`0008`) — and nothing enforces the combination, because publication does not consult applicability

## INV-REV — Review

- INV-REV-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-REV-007 — MVP; no schema or domain code yet (Phase 2/3)

## INV-ATT — Attestation

- INV-ATT-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-006 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-007 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-008 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-009 — V1; no schema or domain code yet (Phase 2/3)
- INV-ATT-010 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-011 — MVP; no schema or domain code yet (Phase 2/3)
- INV-ATT-012 — MVP; no schema or domain code yet (Phase 2/3)

## INV-AUD — Audit

- INV-AUD-006 — V1; no schema or domain code yet (Phase 2/3)

## INV-EVD — Evidence

- INV-EVD-001 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-002 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-003 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-004 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-005 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-006 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-007 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-008 — V1; no schema or domain code yet (Phase 2/3)
- INV-EVD-009 — MVP; no schema or domain code yet (Phase 2/3)
- INV-EVD-010 — MVP; no schema or domain code yet (Phase 2/3)

## INV-RET — Retention and legal hold

- INV-RET-001 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-002 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-003 — V1; no schema or domain code yet (Phase 2/3)
- INV-RET-004 — V1; no schema or domain code yet (Phase 2/3)

## INV-TIME — Time and concurrency

- INV-TIME-002 — MVP; scheduled transitions landed (`transition_document_version_effective`, `0013`) and take an absolute `timestamptz`. `tenant.default_timezone` is stored (`0003`) but nothing converts a wall-clock time into an instant, which is where DST actually bites. Live once scheduling accepts a local time
- INV-TIME-004 — MVP; no request layer exists to retry. The pieces it will build on are in place — `transition_document_version_effective` is idempotent by construction (`0013`) and audit emission carries a `dedupeKey`
