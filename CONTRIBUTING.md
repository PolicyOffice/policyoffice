# Contributing

This repository is developed primarily by AI agents under a single founder. The
conventions below exist so that the history stays legible to a human reading it later.

## Branches and commits

- Branch from `main`: `feat/pol-142-short-slug`, `fix/…`, `docs/…`, `chore/…`
- [Conventional Commits](https://www.conventionalcommits.org/), imperative mood:
  `feat(policy): freeze content revision on submission`
- One PR closes exactly one issue. Small and coherent beats large and complete.
- Squash merge only. Branch deleted on merge. `main` keeps a linear history.
- Never commit secrets, `.env` files, or Playwright authentication state.

## Authorship

Agent contributions are attributed honestly in commit trailers. Showing how the work was
actually produced is part of the point of this repository; obscuring it would not make
the engineering better, only less truthful.

## The review gate

`main` requires: all deterministic CI checks green, an independent-review check green,
and no `decision-required` label. GitHub merges automatically once those hold.

**On the independent-review check.** This is a single-maintainer repository. Requiring a
second human approval would be theatre, and creating a second account to supply it would
be dishonest. What this check actually records is narrower and true: **an agent other
than the one that wrote the change reviewed the diff against the product specification,
and the review is visible in the PR conversation.** Codex implements and Claude reviews;
where Claude authors the change — specification, tickets, process — Codex reviews it. One
rule in both directions: the agent that wrote the diff never records its review.

Correctness is decided by the deterministic pipeline — compilers, tests, migrations,
static analysis, Playwright — not by any agent's approval. No AI is in the required-check
path.

## Risk tiers

| Tier | Paths | Gate |
|---|---|---|
| 0 | `docs/`, config, dependency bumps | CI only |
| 1 | ordinary feature code | CI + one review pass |
| 2 | authorization, tenancy, versioning, effectivity, approval, audit, evidence, hashing | CI + review pass + invariant tests cited by ID |

Tier 2 paths are enforced through `CODEOWNERS`.

## When to stop instead of deciding

Open a **Decision Request** and stop when a change would introduce a cost, exceed a free
tier, contradict a rule in `docs/domain/`, add a category of personal data, or do
anything irreversible or externally visible. See `docs/engineering/agent-workflow.md`.

Implementation convenience never overrides governance semantics. If a domain rule seems
to be in the way, that is a question, not an obstacle to route around.

## Definition of Done

See `docs/engineering/definition-of-done.md`. A feature is not done because its happy
path renders.

## What the "independent review" check means

It is a required status check, and `agent-workflow.md` makes it one of the three merge
conditions. It is worth being precise about what it does and does not assert, because a
governance product that overstated its own controls would be a poor advertisement.

**What it asserts.** A conformance review — does this do what the specification says, with
the right invariants, audit events and authorization — was recorded against **this exact
commit**. A review is recorded by a pull-request comment containing:

```text
Reviewed-commit: <the full 40-character sha>
```

Only comments from a login in `.github/independent-reviewers.json` count; the list currently
contains the one account shared by the founder and both agents. The default branch's copy of
the `pull_request_target` workflow fetches the evaluator and reviewer list from that same
branch. A pull request therefore cannot change the decision code or allowlist that grades its
own head.

The check compares the recorded sha to the pull request's head. Push a new commit and the
recorded sha no longer matches, the check returns to pending, and code nobody has read cannot
merge behind a stale approval. That property is the entire point.

**The author never posts it.** Recording a review of your own pull request is prohibited
(`AGENTS.md` rule 8). It is the one merge condition a machine cannot verify, which is
exactly why it depends on discipline rather than on a check — and why breaking it is a
process failure rather than a shortcut. If your pull request is blocked on this status it is
waiting for the other agent — Claude for what Codex implemented, Codex for what Claude
authored — and that is the system working. It is not waiting for the founder.

**The reviewer arms auto-merge.** When approving, the reviewer enables auto-merge before
posting `Reviewed-commit`; the author never enables it on their own pull request. The order
matters because GitHub refuses to enable auto-merge after the review comment clears the last
blocking condition. A review that requests changes does not arm it.

**What it does not assert.** It is not a human approval, and it is not cryptographic proof
that a different party reviewed the diff. Both agents in this project authenticate as the
same GitHub account, so GitHub cannot distinguish the implementer from the reviewer, and
this repository will not create a second account to manufacture an appearance of one.

The independence that matters is real but procedural: the agent that wrote a change never
records its review — Claude reviews what Codex implements, Codex reviews what Claude authors
— they run in separate sessions with separate context, and a model reviewing its own output
catches its own misreading of a specification far less reliably than an independent pass
does. That is why the two passes exist. The check records that the second pass happened; it
does not prove it.

Nor is the status context bound to a dedicated GitHub App. A pull request could add a new
workflow that posts a forged `independent review` status, because repository workflows can
name that context too. The procedural protection is that an author's pull request remains
unarmed: only the independent reviewer enables auto-merge after examining the diff. Closing
this residual gap would require a separately credentialed App, which is disproportionate for
three trusted parties sharing one account.

**Why not require a GitHub review approval instead.** Because the only account that could
give one belongs to the founder, and the merge policy is explicitly that nobody clicks
anything. Requiring it would deadlock every pull request on the person the workflow exists
to keep out of the loop. `.github/CODEOWNERS` records the same reasoning.

Everything that decides *correctness* is deterministic: compilers, tests, migrations,
static analysis. No AI runs in that path. This check sits alongside it and is honest about
being a different kind of signal.
