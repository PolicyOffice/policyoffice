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
they block work. **Decision 2 was answered on 2026-09-08**, **decision 1 is complete as of
2026-09-10**, and **decision 4 was decided the same day** (#114, `open-decisions.md` § 11).
**Decision 3 was decided the same day** (`open-decisions.md` § 4, option A). **All four
shaping questions are answered**, and nothing in Phase 3 is waiting on a decision.

### 1. The `ADR-0003` authorization evaluator — **complete 2026-09-10**

Every Phase 2 ticket recorded a capability requirement and enforced none, deliberately and
consistently. That debt is now due: approval, publication and the reader path are all
authorization decisions, and the exit criterion *"CI blocks a pull request that breaks a
tenant-isolation or authorization test"* carried over from Phase 2 cannot be met without it.

`ADR-0003` is unusually complete — one function, a `Decision` carrying a reason rather than a
boolean, deny-beats-allow in one pass with no specificity, containment along the administrative
chain only, memoisation within a request and never across. It needs decomposing, not designing.

**Decomposed into four tickets. All four are now written; three have landed.**

| | What | Status |
|---|---|---|
| POL-023 (#95) | The capability, scope and grant schema, the nine system roles, and a gate keeping them equal to `authorization-model.md`'s role table | **merged** #98 |
| POL-024 (#100) | `decide()` itself: the `Decision` type, deny-beats-allow, containment, validity at check time, per-request memoisation | **merged** #101 |
| POL-025 (#103) | The authorization matrix, generated from the role table — `ADR-0003` § *Proving it*, and Phase 2's carried-over exit criterion | **merged** #107 |
| **POL-026 (#108)** | The context boundary: an architecture test that no repository function is reachable without a principal-carrying context | **ready** |

`decide()` exists and is proven — deny-beats-allow has unit and property coverage, expiry is
evaluated at the fixed instant, and the evaluator does **one** query against a thousand grants
under forced RLS, asserted rather than measured once. **Still nothing is enforced**: there are
no entry points, so the `*_REQUIRED_CAPABILITIES` constants remain contracts.

**Each ticket was written only after the one before it landed**, and that discipline held for
all four. POL-016 and POL-017 both needed amending in Phase 2 because they were written too
early, and two of that phase's five Decision Requests came from exactly that. None of
POL-023 through POL-026 needed amending.

The matrix is proven rather than assumed: mutating `scopeContains()` to drop containment fails
438 cells, bypassing expiry fails the matrix, and an undocumented capability fails both files by
name. The twelve-cell database sample compares `decide()` on synthetic facts against `decide()`
on database facts, so an algorithm bug cancels on both sides and only a **loader** disagreement
shows — mutating the loader to drop a validity upper bound fails it, naming the cell, while the
matrix correctly stays green. That division is deliberate: the matrix proves the algorithm, the
sample proves the loader.

**Nothing is enforced when POL-023 lands.** A schema called `access_grant` looks like access
control and is not; the `*_REQUIRED_CAPABILITIES` constants stay contracts until POL-024. Two
further pieces — enforcement at entry points, and search filtering at retrieval
(INV-AUTH-011/012) — wait on decision 4, because there are no entry points to enforce at.

`ADR-0003`'s verify-at-bootstrap list is down to one open item. **Query cost is closed** —
POL-024 measured one query and 30.8 ms against 1,000 grants under forced RLS, and guarded it
with an assertion rather than a note. **Generating the matrix from the role table is closed** —
POL-025 builds all 4,050 cells from `parseAuthorizationModel()`, and a capability added to the
runtime enum without a documented decision fails the build by name. **The import boundary** is
POL-026's, and it is the last one; that ticket strikes it from the ADR.

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

### 3. Approval configurability — **decided 2026-09-10, option A**

`open-decisions.md` proposes **template-backed, not customer-editable**. Approval is the
largest unbuilt subsystem — `approval_run`, `approval_stage`, `approval_task`,
`approval_decision`, mandated authority, serial ordering, completion rules — and how much of it
is configurable changes the ticket count materially.

### 4. What the interface is — **decided 2026-09-10, option B**

Asked as #114, answered by the founder the same day, and recorded as **`open-decisions.md`
§ 11** so it stops being a plan heading and becomes a decision with reasoning attached.

**Minimal surfaces everywhere, except the approval inbox and the reader view**, which are built
as `information-architecture.md` § *Key surfaces* specifies them. The argument is in § 11 and
turns on one thing: the approval inbox's page ordering — content and digest above the decision
controls — is the governance requirement, not styling. A minimal form with two buttons and
nothing above them would satisfy every exit criterion here while embodying the failure the
product exists to prevent.

**The plan was wrong about the starting point, and it matters for the first ticket.** This
section said *"nothing implements them"*. The **schema is already complete**: `user_session`
and `user_credential` landed in `0003`, and they match `ADR-0002` closely enough that no
migration is needed to begin — `token_hash` rather than a token, `idle_expires_at` and
`absolute_expires_at` both present, `revoked_at` for deletion-based revocation,
`params jsonb` so Argon2id parameters can be raised without a schema change, and
`credential_kind` as an enum so adding OIDC later is a new kind rather than a changed
principal. What is missing is **domain code**: nothing in `packages/domain/src` or `apps/`
references either table.

### The interface work, decomposed

Written one at a time, as the authorization epic was.

| | What | Status |
|---|---|---|
| **POL-029** | Session lifecycle over the existing `0003` schema: issue, resolve, refresh idle, revoke. No routes, no UI | **written** |
| POL-030 | The request context: a principal-carrying context assembled from a session, and `decide()` called at a real entry point for the first time | after POL-029 |
| POL-031 | Sign-in and sign-out, and the author's minimal path — create, draft, submit | after POL-030 |
| POL-032 | **The approval inbox**, built to `information-architecture.md` | needs the approval subsystem first |
| POL-033 | **The reader view**, built to `information-architecture.md` | after POL-031 |
| POL-034 | Playwright drives the reference flow with three principals | last |

**POL-032 is unblocked.** Approval configurability was answered the same day as decision 4 —
`open-decisions.md` § 4, **option A**: one or two seeded template versions per governance
profile, runs bind by identifier, no template editor ships. The approval subsystem beneath the
inbox — `approval_run`, `approval_stage`, `approval_task`, `approval_decision`,
`workflow_template`, `workflow_template_version` — is specified in `data-model.md` § *Approval*
and entirely unbuilt.

**The one thing that would spoil A → B, recorded so the ticket carries it.** Option A is
reversible into a full editor only if seeded templates are written as **ordinary tenant-owned
rows** with `published_at` and `published_by` set, exactly as an editor would write them. A
hard-coded template identifier, or a seeded row with its authoring columns left null, turns B
into a backfill. Those columns already exist in `data-model.md`, so this costs nothing to get
right and is an acceptance criterion in whichever ticket seeds them.

That ticket sits between POL-031 and POL-032 and is not written yet — the approval subsystem is
several tickets, not one, and decomposing it is the next specification job after POL-030 lands.

## The work, in dependency order

Not tickets yet — tickets follow the decisions above. This is the shape.

| Group | What it covers | Blocked by |
|---|---|---|
| ~~**Authorization**~~ | The evaluator, grants, the capability matrix and its CI gate | **done** — POL-023…027 |
| **Sessions and identity** | Server-side sessions per `ADR-0002`, sign-in, principal resolution | **unblocked** — POL-029 |
| **Approval** | Runs, stages, tasks, decisions, mandated authority, request-changes and resubmission | **unblocked** — decompose after POL-030 |
| **Audience and attestation** | Applicability resolution, assignment, acknowledgement | Decision 1 |
| **Read paths** | The register, a version's history, the audit trail as a person can read it | **unblocked** — POL-033 |
| **Review cases** | Scheduled review, completion, the obligations that survive it | Decision 1 |
| **Evidence packs** | Assembly, the manifest, byte-exact verification outside the application | Everything above |
| **Playwright** | The flow driven through the interface, carried from Phase 2 | **unblocked** — POL-034 |

Two items carry forward from Phase 2 with their triggers recorded there rather than repeated
here: **Neon restore timing**, due before any real data exists, and the **authorization
matrix**, which is Decision 1's output.

## Start here, before any decision — **done, by an unusual route**

**The constraint-comment gate has shipped.** `packages/db/src/constraint-comments.ts` walks
every level-1 and level-2 constraint in `public` from `pg_constraint` and asserts each carries
an invariant ID or is explicitly excepted — schema-discovered, as the criterion required, not a
third hand-maintained allowlist. It is asserted from `fixtures.int.test.ts` and
`authorization.int.test.ts`, so it runs under `integration tests` rather than as its own gate.

**How it landed is worth keeping.** POL-022's own pull request, #94, was closed unmerged. Its
migration `0016_constraint_invariant_comments.sql` had already reached `main` inside #96 — the
pull request opened as *"documentation only, Tier 0"* that `CLAUDE.md` § *Committing* records as
the `git add -A` incident — and the module followed in #98 alongside POL-023's schema. So the
work is in, complete and tested, but no pull request in the history is about it, and its
migration is attributed to a docs change.

Nothing needs redoing. It is recorded here because someone looking for when this gate arrived
will not find it by reading pull request titles.

## Open at the end of the 2026-09-10 session

Nothing here blocks POL-026. Recorded so it is not rediscovered.

- **The applied branch ruleset was missing a required check — applied 2026-09-10.**
  `audit-event completeness` had been in `.github/rulesets/main.json` since #58 (2026-09-02)
  and was **not** in the applied ruleset, so POL-019's placeholder-schema gate ran on every
  pull request and could not block one. The founder directed the change in session and it was
  applied: the live ruleset now carries all fourteen committed contexts, and nothing else in
  it moved. Live configuration is still never an agent's to change on its own initiative —
  what closed this was an explicit instruction, not an agent deciding the drift was safe to
  fix.

  Before requiring it, the job was checked for the failure that matters: a required context
  that never reports blocks every merge permanently. `audit-event completeness` has no `paths`
  filter and no `if`, and reported green on #101, #102 and #104.

  **Now closed as well.** POL-025's fifteenth context, `authorization matrix`, was applied on
  2026-09-10 after #107 merged — the same three pre-flight checks first: the job carries no
  `paths` filter and no `if`, it had reported green on #107, and no pull request was open to be
  disrupted. **The applied ruleset and `.github/rulesets/main.json` now match exactly, fifteen
  contexts, with no drift for the first time.** Both applications were founder-directed in
  session; live configuration remains not an agent's to change on its own initiative, and
  `AGENTS.md` was deliberately left unamended rather than turning that into standing policy.
  Verify with:

  ```bash
  gh api repos/PolicyOffice/policyoffice/rulesets/<id> --jq '[.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
  ```

- **One untested guard in the evaluator — now ticketed as POL-027 (#109).** `scopeContains()`
  in `packages/domain/src/authorization.ts` returns false for a `GOVERNANCE_BODY`-scoped grant
  against a non-body resource. Re-checked on 2026-09-10 after the matrix landed, by deleting
  the line: **42 files, 538 tests, all still passing.** POL-025 does not reach it either — the
  matrix uses a `DOCUMENT` resource for every cell, and `body.act_for` is held by no role, so
  its 135 cells only ever assert denial. The whole governance-body arm is unproven, not just
  the guard.

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
