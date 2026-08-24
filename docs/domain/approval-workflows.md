# Approval Workflows

An approval is a claim that named authorities agreed to an exact text. Everything in this
chapter exists to make that claim provable and hard to fake — including by accident.

> **INV-APR-001 — Every Approval Decision references an exact Content Revision and its
> digest.**

An approval that cannot name what it approved is not evidence. It is a timestamp next to a
name.

## One run, one candidate

An `ApprovalRun` is bound to exactly one submitted `ContentRevision`. It starts at
submission and ends in one of five ways.

| Outcome | Cause | Effect on the version |
|---|---|---|
| `COMPLETED` | Every stage satisfied its completion rule | `InReview → Approved` |
| `CHANGES_REQUESTED` | An approver asked for changes | `InReview → ChangesRequested`; the snapshot is terminated |
| `REJECTED` | An approver rejected the candidate | `InReview → Rejected`, terminal |
| `CANCELLED` | Authorised cancellation, with a reason | `→ Cancelled`, terminal |
| `BLOCKED` | A stage can no longer be satisfied | The run stays open and visible as a governance exception. It never completes on its own |

> **INV-APR-003 — Requesting changes returns work to drafting and terminates the
> submission snapshot.**

> **INV-APR-004 — Resubmission creates a fresh Approval Run. Prior decisions remain
> visible as history and never carry over.**

Decisions do not transfer to different bytes. A reviewer who approved revision 4 has said
nothing whatsoever about revision 5, however small the difference, and the model must not
imply otherwise.

## Templates are versioned, and runs are frozen to them

> **INV-APR-010 — A Workflow Template Version is immutable. Editing creates a new version
> and never alters active or historical runs.**

> **INV-APR-012 — An Approval Run records its template version and its resolved
> participants at start. Later changes to templates, roles or group membership never alter
> a running or completed run.**

Without the second rule, an administrator adding a person to the Legal group in 2028
changes what "Legal approved this" meant in 2026. Participant resolution happens once, at
`approval_run.started`, and the resolved set is stored on the run.

This is the same principle as configuration versioning (INV-CFG-003) and released content
(INV-VER-003): **history is interpreted under the rules that existed then, never under
today's.**

## Structure

A template version is an ordered list of stages. Stages execute serially; tasks within a
stage execute in parallel.

```text
Stage 1 — Control review
  completion: AT_LEAST_N(2)
  tasks: CISO · DPO · Head of Risk

        ↓  stage 1 satisfied

Stage 2 — Legal
  completion: ALL
  tasks: General Counsel

        ↓  stage 2 satisfied

Stage 3 — Corporate approval
  completion: BODY_RESOLUTION
  tasks: Management Board
```

> **INV-APR-008 — A serial stage cannot begin before its predecessor satisfies its
> completion rule.**

Ordering is a governance guarantee, not a user-interface convenience. A board that
resolves before Legal has commented has approved something different from what the process
claims.

### Participants

A task is assigned to one of four participant kinds:

| Kind | Resolved at run start to | Notes |
|---|---|---|
| `USER` | That user | The simplest and the most brittle: people leave |
| `ROLE_AT_SCOPE` | Every principal holding that role at that scope | The usual choice — "the Compliance Admin for the Estonian entity" |
| `GROUP` | Every member of the group at that instant | Frozen by INV-APR-012 |
| `GOVERNANCE_BODY` | The body itself, not its members | Satisfied only by `BODY_RESOLUTION` |

### Completion rules

| Rule | Satisfied when | Typical use |
|---|---|---|
| `ALL` | Every task in the stage has an approval decision | A stage with a single indispensable approver, or a small set where each is required |
| `ANY_ONE` | Any one task has an approval decision | Interchangeable reviewers — any duty officer will do |
| `AT_LEAST_N` | N tasks have approval decisions | Quorum of named individuals: two of three control functions |
| `BODY_RESOLUTION` | Exactly one decision, recorded on behalf of the assigned Governance Body | Corporate approval as an institution |

`AT_LEAST_N` and `BODY_RESOLUTION` look similar and are entirely different governance
facts. Three of five executives individually approving is a quorum of individuals. The
Management Board resolving is the institution deciding, and the evidence names a
resolution, not five clicks. `document-taxonomy.md` specifies the second in full.

> **INV-APR-021 — A `BODY_RESOLUTION` decision always distinguishes the deciding body from
> the user who recorded it. The recorder is never presented as the approver.**

> **INV-APR-023 — Recording a body resolution requires capability to act for that specific
> body.**

> **INV-APR-024 — Which evidence fields a decision requires is tenant configuration, and
> the configuration version in force at decision time is recorded with the decision.**

> **INV-APR-022 — Where a resolution date is recorded, it may precede `recorded_at` but
> never precedes submission of the revision it approves.**

### The floor under every template

> **INV-APR-020 — A workflow may add approval requirements beyond its Document Type's
> mandated authority. It may never require fewer.**

Template configuration is validated against the type's `mandated_authority` when the
template is published *and* when a run starts, because the type's configuration can change
between those moments. A template that no longer satisfies the mandate cannot start a run;
the document's type configuration must be changed first, which is a separately audited act
that records which Governing Framework version justified it.

This is what makes the taxonomy load-bearing rather than decorative. Without it, an
administrator can defeat the organisation's own constitution by editing a template.

## Decisions

| Decision | Meaning | Effect |
|---|---|---|
| `APPROVE` | This participant's requirement is satisfied | Counts toward the stage's completion rule |
| `REQUEST_CHANGES` | The candidate needs work | Terminates the run immediately; work returns to drafting |
| `REJECT` | This candidate should not proceed | Terminates the run and the candidate |

Every decision records the participant, the exact content revision and digest, the
instant, the rationale where configuration requires one, and the configuration version in
force.

> **INV-APR-007 — Approval Decisions are immutable. Corrections create compensating
> events.**

If a decision was recorded against the wrong body, or with a mistyped minutes reference,
the correction is a new event that references and supersedes the original. Both remain in
evidence, and the sequence shows what was corrected and by whom. Editing the original
would produce a record that is *tidier* and *false*.

> **INV-APR-009 — Concurrent decisions are idempotent, and a completion threshold is
> satisfied exactly once.**

Two approvers clicking at the same moment on the last outstanding task of an
`AT_LEAST_N(2)` stage must not complete the stage twice, advance two stages, or emit two
`version.approved` events.

## When approvers are unavailable

> **INV-APR-005 — A deactivated, expired or unauthorised approver leaves the task
> unresolved. The system never substitutes anyone.**

The task becomes `UNRESOLVABLE` and appears as a governance exception. Someone authorised
reassigns it, and that reassignment is recorded. Silent substitution — promoting a deputy,
falling back to a manager, picking the next member of a group — destroys the
accountability the run exists to establish.

> **INV-APR-013 — A stage whose completion rule can no longer be satisfied blocks and
> raises a governance exception. It never completes, and participants are never
> re-resolved silently.**

An `AT_LEAST_N(3)` stage with two remaining eligible participants is unsatisfiable.
Failing closed and saying so is correct; quietly reducing the threshold to what is
achievable is not, and neither is re-resolving the participant set against today's group
membership.

### Delegation and reassignment

| | Delegation | Reassignment |
|---|---|---|
| Who initiates | The task holder | An authorised administrator |
| Duration | Time-bounded | Permanent for that task |
| Record | Both effective and originating actor on every resulting decision | The reassignment itself, with a reason |
| Typical cause | Planned absence | Departure, or an unresolvable task |

> **INV-APR-006 — Reassignment and delegation are explicit, authorised and audited,
> recording both effective and originating actor.**

> **INV-APR-014 — Delegation transfers a task, never a capability. A delegate who does not
> independently hold the required capability cannot decide.**

The second rule closes the obvious hole. If delegation carried capability, the shortest
path around every approval requirement in the product would be to delegate a task to
someone who was never authorised to hold it.

## Time, reminders and escalation

> **INV-APR-002 — No elapsed time, timeout or escalation ever results in automatic
> approval.**

This is not negotiable, not configurable, and not subject to a tenant's "we're a small
team" argument. A system in which silence becomes consent cannot be a system of record,
because the most consequential approvals are exactly the ones people avoid.

What automation may do when a due date passes:

| Action | Permitted |
|---|---|
| Remind the assignee | Yes |
| Notify their manager or the document owner | Yes |
| Raise the run as a governance exception | Yes |
| Add a further authorised approver, per configured rule | Yes, and audited |
| Reassign to an authorised person, per configured rule | Yes, and audited |
| Mark the run overdue | Yes |
| Record an approval | **Never** |
| Skip the stage | **Never** |
| Reduce a completion threshold | **Never** |

An overdue stage stays pending. Loudly.

## Separation of duties

Configurable per document type and per template, because the correct answer differs by
organisation size and by what is being approved.

| Rule | Effect |
|---|---|
| Author may not be sole final approver | The default in the Standard and Regulated profiles |
| Author may not appear in any approval stage | For high-risk types, where the organisation wants full independence |
| One person may not satisfy two distinct required roles in one run | Prevents a single individual completing a two-of-three control stage by holding three roles |

Where a rule cannot be satisfied — a five-person company where the only qualified approver
wrote the document — the run blocks and says so. It does not proceed with a warning, and
it does not silently disable the rule. Tenants that genuinely cannot separate duties
configure that deliberately, and their evidence records that this is how they govern.

## Pilot scope

Whether the Pilot ships a single fixed workflow or configurable templates is an open
decision recorded in `docs/plans/open-decisions.md`.

The distinction affects how much of this chapter is *exercised* in the Pilot. It affects
none of it structurally: even a fixed workflow is stored as a template version, runs
against a frozen participant set, and is bound to a run by identifier — because
retrofitting that later means rewriting every historical approval's interpretation, which
is precisely what INV-APR-010 and INV-APR-012 exist to prevent.
