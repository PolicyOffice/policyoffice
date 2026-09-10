# Phase 3 — Golden Slice

Turn a schema that can hold governed policy into a product that performs governance. The
Pilot is not a few CRUD screens; it is the smallest thing that proves the whole chain.

```text
create document → draft revision → submit immutable candidate → request changes →
resubmit → approve → publish → become effective → assign audience → acknowledge →
inspect audit history → complete a scheduled review → generate an evidence pack
```

**Phase 3 is complete when that flow runs end to end, through an interface, with three
distinct principals — author, approver, reader — and produces an evidence pack a stranger can
verify without the application.**

## What Phase 2 handed over

| Input | Consequence |
|---|---|
| Fourteen migrations, the document spine complete | Half the flow above is already storable; none of it is yet *performable* |
| Every entry point records its required capability and enforces nothing | The evaluator is not one ticket among many — it is the precondition for calling any of this authorised |
| Three `security definer` functions, each verified not to leak tenancy | The pattern for privileged operations is established; reuse it rather than inventing a second one |
| `apps/web` contains one route, `/health` | There is no interface, no session handling and no read path. This is the largest single gap |
| Seven Decision Requests, five of them ticket defects | Read the authority before asserting what it says (`CLAUDE.md`) |

## Conventions for this phase

- **Everything Phase 2's conventions already say.** Forward-only migrations, invariant IDs in
  constraint comments, audit events defined at version 1 by the ticket that first emits them,
  tenant scoping below the UI, no AI in any domain operation.
- **A ticket that cannot cite the capability it enforces is not ready.** Phase 2 could defer
  authorization because nothing was reachable. Phase 3 makes things reachable.
- **The interface is not a separate workstream.** A slice that works only in integration tests
  has not proved the claim in the exit criterion.
- **Nothing here is demonstrated with one principal.** The flow's whole point is that different
  people do different parts and the record shows who.

## Decide first — four questions that shape the tickets

Most of Phase 3 cannot be decomposed until these are answered. They are listed in the order
they block work. **Decision 2 was answered on 2026-09-08**; the other three stand.

### 1. The `ADR-0003` authorization evaluator — **started 2026-09-09**

Every Phase 2 ticket recorded a capability requirement and enforced none, deliberately and
consistently. That debt is now due: approval, publication and the reader path are all
authorization decisions, and the exit criterion *"CI blocks a pull request that breaks a
tenant-isolation or authorization test"* carried over from Phase 2 cannot be met without it.

`ADR-0003` is unusually complete — one function, a `Decision` carrying a reason rather than a
boolean, deny-beats-allow in one pass with no specificity, containment along the administrative
chain only, memoisation within a request and never across. It needs decomposing, not designing.

**Decomposed into four tickets. Only the first is written.**

| | What | Status |
|---|---|---|
| POL-023 (#95) | The capability, scope and grant schema, the nine system roles, and a gate keeping them equal to `authorization-model.md`'s role table | **merged** #98 |
| POL-024 (#100) | `decide()` itself: the `Decision` type, deny-beats-allow, containment, validity at check time, per-request memoisation | **merged** #101 |
| **POL-025 (#103)** | The authorization matrix, generated from the role table — `ADR-0003` § *Proving it*, and Phase 2's carried-over exit criterion | **ready** |
| POL-026 | The context boundary: an architecture test that no repository function is reachable without a principal-carrying context | write after POL-025 lands |

`decide()` exists and is proven — deny-beats-allow has unit and property coverage, expiry is
evaluated at the fixed instant, and the evaluator does **one** query against a thousand grants
under forced RLS, asserted rather than measured once. **Still nothing is enforced**: there are
no entry points, so the `*_REQUIRED_CAPABILITIES` constants remain contracts.

**Each ticket is written only after the one before it lands**, and that discipline has held for
three of the four. POL-016 and POL-017 both needed amending in Phase 2 because they were written
too early, and two of that phase's five Decision Requests came from exactly that.

**Nothing is enforced when POL-023 lands.** A schema called `access_grant` looks like access
control and is not; the `*_REQUIRED_CAPABILITIES` constants stay contracts until POL-024. Two
further pieces — enforcement at entry points, and search filtering at retrieval
(INV-AUTH-011/012) — wait on decision 4, because there are no entry points to enforce at.

`ADR-0003`'s verify-at-bootstrap list is down to one open item. **Query cost is closed** —
POL-024 measured one query and 30.8 ms against 1,000 grants under forced RLS, and guarded it
with an assertion rather than a note. **Generating the matrix from the role table** is
half-proven: POL-023's `parseAuthorizationModel()` already parses roles and inheritance out of
`authorization-model.md`, and POL-025 finishes it. **The import boundary** is POL-026's, and it
is the last one.

### 2. Open decision 5 — Pilot applicability complexity — **decided**

`open-decisions.md` proposes **explicit audience lists**, and that is now **decided — option
A**, by founder delegation on 2026-09-08.

**Corrected 2026-09-08.** This section previously claimed that settling decision 5 would also
settle Decision Request #86. It does not, and the claim was made without reading
`multi-entity-model.md` — the same failure `CLAUDE.md` now rules against, committed in the very
document that records the rule.

The two are orthogonal. Decision 5 is about how applicability is **expressed** — explicit lists
versus predicates — and `multi-entity-model.md` says plainly that it *"changes no invariant
above"*. Decision Request #86 asked what a rule is **attached to**, which that same document had
already answered: *"An applicability rule attaches to a variant… over a dated interval."*

#86's real finding survives the correction, and is now recorded in `multi-entity-model.md` and
`data-model.md`: variant-attached dated rules cannot satisfy `versioning.md`'s *immutable after
approval, corrected by a new version* unless they record **which version authorised each
interval**. That is one column, not a change of attachment.

### 3. Approval configurability — open decision 4

`open-decisions.md` proposes **template-backed, not customer-editable**. Approval is the
largest unbuilt subsystem — `approval_run`, `approval_stage`, `approval_task`,
`approval_decision`, mandated authority, serial ordering, completion rules — and how much of it
is configurable changes the ticket count materially.

### 4. What the interface is

There is no UI, no session handling and no read path. `ADR-0002` chose server-side sessions in
Postgres; nothing implements them. The slice needs enough interface for three principals to
perform their parts, and that scope is a product decision rather than an architectural one.

## The work, in dependency order

Not tickets yet — tickets follow the decisions above. This is the shape.

| Group | What it covers | Blocked by |
|---|---|---|
| **Authorization** | The evaluator, grants, the capability matrix and its CI gate | Decision 1 |
| **Sessions and identity** | Server-side sessions per `ADR-0002`, sign-in, principal resolution | Decision 4 |
| **Approval** | Runs, stages, tasks, decisions, mandated authority, request-changes and resubmission | Decisions 1, 3 |
| **Audience and attestation** | Applicability resolution, assignment, acknowledgement | Decision 1 |
| **Read paths** | The register, a version's history, the audit trail as a person can read it | Decisions 1, 4 |
| **Review cases** | Scheduled review, completion, the obligations that survive it | Decision 1 |
| **Evidence packs** | Assembly, the manifest, byte-exact verification outside the application | Everything above |
| **Playwright** | The flow driven through the interface, carried from Phase 2 | Decision 4 |

Two items carry forward from Phase 2 with their triggers recorded there rather than repeated
here: **Neon restore timing**, due before any real data exists, and the **authorization
matrix**, which is Decision 1's output.

## Start here, before any decision

One ticket is ready now and depends on none of the above.

**The constraint-comment gate.** Phase 2's exit criterion is partially met: the convention is
settled and the comments are written, but only `document.int.test.ts` and `version.int.test.ts`
assert it, each against a hand-maintained allowlist. A constraint added to `content_revision`,
`configuration` or `organization` without a comment is caught by nothing. The fix is a
schema-discovered check in the style of the seeds' tenant-coverage test — walk every level-1
and level-2 constraint in `public`, assert each carries an invariant ID or is explicitly listed
as carrying none. It is POL-019's shape, and it closes the criterion honestly rather than by
extending two allowlists.

## Open at the end of the 2026-09-10 session

Nothing here blocks POL-025 or POL-026. Recorded so it is not rediscovered.

- **The applied branch ruleset is missing a required check.** `audit-event completeness` has
  been in `.github/rulesets/main.json` since #58 (2026-09-02) and is **not** in the applied
  ruleset. POL-019's placeholder-schema gate therefore runs on every pull request and **cannot
  block one**. POL-025 adds a fifteenth context, `authorization matrix`, to the same committed
  file. Both need the founder to apply the ruleset — live configuration is never an agent's to
  change. Compare with:

  ```bash
  gh api repos/PolicyOffice/policyoffice/rulesets/<id> --jq '[.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
  ```

- **One untested guard in the evaluator.** `scopeContains()` in
  `packages/domain/src/authorization.ts` returns false for a `GOVERNANCE_BODY`-scoped grant
  against a non-body resource. It is correct and currently redundant — the loader walks
  `org_unit → legal_entity` and never into bodies — so removing it fails no test. If a
  body-scoped document ever exists, nothing catches its loss. One test, next time someone is in
  that file. Raised on #101.

- **Decision Request #92 is parked deliberately.** *Does submission freeze applicability, or only
  approval?* Applicability is mutable while a version is `IN_REVIEW`, which matches
  `versioning.md` exactly — but INV-VER-007 calls applicability a field an approver relied upon,
  while INV-VER-002 freezes the content revision at submission because *"approvers must not
  review a moving target."* Nothing can approve anything yet. Answer it when the approval
  workflow is built, deliberately, rather than inheriting whatever the implementation does.

- **Neon restore timing** remains the only unaddressed ADR verification item outside
  `ADR-0003`. Its trigger is recorded in `phase-2-bootstrap.md`: before any production data
  exists, not before a phase closes.

## Exit criteria

- [ ] The reference flow runs end to end through the interface, with author, approver and
      reader as distinct principals
- [ ] The same flow runs in tests, and the test fails when any step is removed
- [ ] An evidence pack verifies **outside the application** — a stranger with the pack and a
      hash function reaches the same answer
- [ ] Every entry point's recorded capability is enforced by the evaluator, and CI fails when
      an authorization test does
- [ ] Playwright drives the flow in the runner
- [ ] Every invariant the slice touches is tested or still registered in
      `tooling/invariants-pending.md` with a reason — the register only shrinks
- [ ] No domain operation calls an LLM

## What comes after

| Phase | Output |
|---|---|
| **4 — Private alpha** | Tenant-isolation suite hardened, review workflow, audit completeness, authorised search, evidence generation at estate scale |
