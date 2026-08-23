# Agent Workflow

How this project is built. This document is normative: agents follow it, and changes to
it are decisions, not edits.

## Premise

The project is developed by AI agents under a single founder, on two €20/month
subscriptions. The design goal is **not** "no humans." It is:

> No human is needed for anything mechanical. The founder's attention is spent only on
> decisions that are genuinely theirs to make.

A repository where a bot opened, reviewed, approved and merged everything is not
evidence of engineering maturity. Traceability from specification to invariant to test
to merge is.

## Actors

| Actor | Owns | Share of volume |
|---|---|---|
| **Claude Code** | Specification, ADRs, ticket authoring, architecture, hard debugging, PR review | ~20% |
| **Codex** | Implementation, tests, CI fixes, review-comment fixes | ~80% |
| **CI** | The merge gate. Deterministic. No AI in the required-check path. | every PR |
| **Founder** | Product decisions, milestone acceptance | decisions only |

Two subscriptions are two independent quota pools. The governing economic rule:
**never spend Claude quota on work Codex can do from a good ticket.** Claude's job is
to make tickets good enough that Codex does not need Claude.

**The reviewer is never the implementer.** This is the whole reason the two-agent split
exists, and it is why this project does not need a fan-out of review subagents.

## The loop

```text
Claude writes issue (complete contract)   →  label: ready
        ↓
Codex branches, implements, tests, opens PR (Closes #N)
        ↓
CI runs deterministic gates
        ↓
Claude reviews the diff against the specification  →  comments  →  review check
        ↓
Codex fixes  →  CI green
        ↓
GitHub auto-merges (squash). Nobody clicks anything.
```

The founder appears in this loop **only** when an agent raises a Decision Request.

## Merge policy

A PR merges automatically when all three are true:

1. all required CI checks are green;
2. the independent-review check is green;
3. no `decision-required` label is present.

The independent-review check is an honest signal, not a fake human approval: it records
that an agent other than the implementer reviewed the diff against the specification.
`CONTRIBUTING.md` states exactly what it means. This project does not create sockpuppet
accounts to simulate a team.

### Risk tiers

| Tier | Paths | Gate |
|---|---|---|
| **0** | `docs/`, config, dependency bumps | CI only, auto-merge |
| **1** | ordinary feature code | CI + one review pass |
| **2** | authorization, tenancy, versioning, effectivity, approval, audit, evidence, content hashing | CI + review pass + invariant tests must exist and be cited |

Tier 2 paths are enforced through `CODEOWNERS`, not memory.

### Phasing

- **Until the golden slice is complete and its invariant suite is proven:** tiers 1 and
  2 require the review check to have actually run.
- **After that:** full auto-merge on green, review check included in CI.

## Decision Requests

An agent must **stop and open a Decision Request issue** — which blocks the PR — on any
of the following. Improvising instead is a process failure, regardless of whether the
guess was right.

| Trigger | What the request must contain |
|---|---|
| **Money** — a new paid service, or a free tier that will be exceeded | what breaks without it, the free alternative and why it is insufficient, actual €/month, a recommendation |
| **Scope** — cannot be built as specified, or is materially larger than the ticket implies | what the ticket assumed, what is actually true, options |
| **Product rule** — implementing would contradict `docs/domain/` | the rule, why it appears to be in the way, the alternative that respects it |
| **Privacy / legal** — new personal-data category, retention change, new subprocessor, change to what "EU residency" covers | the data, the purpose, the minimal alternative |
| **Irreversible or public** — licence, domain, anything customer-visible | what becomes hard to undo |
| **Deadlock** — agents disagree and tests cannot arbitrate | both positions, and what evidence would settle it |

Every request states: the question, the options, a **recommendation**, the consequence
of each, and how reversible the decision is. The founder should be able to answer in one
line.

Answers are recorded in the repository — as an ADR when architectural, otherwise as the
closed issue with the founder's reasoning. **Think in chat, decide in GitHub.**

## The ticket contract

A ticket is Codex-ready only when every section is filled. If the invariants or
acceptance-criteria sections cannot be filled, the specification is not ready and the
ticket should not exist yet.

```markdown
## Context          spec section(s) + dependency issues
## Goal             one sentence
## In scope / Out of scope
## Invariants       INV-VER-003, INV-AUTH-011   (must not break)
## Authorization    capability + scope required
## Audit events     which events this must emit
## Acceptance criteria   testable statements
## Required tests   unit / integration / playwright?
## Likely files
```

## Traceability

The chain that makes this repository legible to a reviewer:

```text
spec section  →  INV-ID  →  test name  →  issue  →  PR  →  ADR
```

Every domain invariant has a stable ID recorded in `docs/domain/invariants.md`. Tickets
cite IDs. Test names contain IDs. CI fails if any invariant has zero tests referencing
it. For a product whose entire value proposition is provable governance, this is not
decoration — it is the same discipline the product sells.

## CI gates

Blocking on every PR:

```text
locked dependency install
  → format → lint → typecheck
  → unit tests
  → domain invariant tests
  → integration tests (real Postgres service container)
  → migration validation: fresh install AND upgrade
  → tenant-isolation suite
  → authorization matrix
  → audit-event completeness
  → production build
  → dependency review + secret scan + CodeQL
  → Playwright critical suite (Chromium only)
```

Nightly / scheduled only: full Chromium + Firefox + WebKit, property-based applicability
resolution tests, backup-restore drill.

**No AI in the required-check path, ever.** An agent's approval is a comment on a PR, not
a correctness guarantee. Compilers, tests, migrations, static analysis and Playwright
decide mergeability.

### Deliberate omission: no preview environments yet

Both source blueprints assume per-PR preview deployments. We are not building them yet.
Playwright runs against the application booted inside the CI runner with a Postgres
service container: full end-to-end coverage, €0, no infrastructure to operate. Preview
deployments arrive when there is a design partner to show, not before. Recorded as an
ADR.

## Founder checkpoints

The founder does not review diffs. They cannot usefully judge whether an endpoint has a
bug, and a gate that produces rubber-stamping is worse than no gate.

The founder's attention goes to:

1. **Decision Requests** — arrive as notifications; a one-line reply is enough.
2. **Milestone demos** — "here is the running app; does this behave the way your policy
   register should?" This is domain review, and it is the founder's highest-value
   contribution: no agent knows that at their organisation a manual needs only a
   department head while a policy needs management board approval.
3. **Specification sign-off** — during consolidation and whenever domain semantics change.
4. **A weekly digest** — scheduled job posting what merged, what is blocked, which
   decisions are waiting, and free-tier headroom.

## Parallelism

Agents work in separate git worktrees so that two tickets can be in flight without
colliding. Tickets are decomposed with explicit dependency order; independent tickets may
run concurrently, dependent ones may not.

Practical cadence: one Claude session produces five to eight tickets cheaply, then Codex
works through them. Batch specification, batch implementation, batch review.

## Budget posture

Free tier only. Anything that would cost money is a Decision Request, not a commit.

| Need | Choice |
|---|---|
| Repo, CI, CodeQL, secret scanning, Dependabot, Issues, Projects | GitHub Free — unlimited Actions minutes on public repositories |
| Postgres | Neon free tier (EU region, database branching) |
| Object storage | Cloudflare R2 free tier |
| Transactional email | Resend free tier; Mailpit locally |
| Error tracking | Sentry free tier |
| Local environment | Docker Compose |

Known future costs, none required for the pilot: a staging host, a domain, and a
commercial-use hosting plan if the eventual deployment target's free tier forbids
commercial use.
