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
and the review is visible in the PR conversation.** Codex implements; Claude reviews.

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

The check compares that sha to the pull request's head. Push a new commit and the recorded
sha no longer matches, the check returns to pending, and code nobody has read cannot merge
behind a stale approval. That property is the entire point.

**What it does not assert.** It is not a human approval, and it is not cryptographic proof
that a different party reviewed the diff. Both agents in this project authenticate as the
same GitHub account, so GitHub cannot distinguish the implementer from the reviewer, and
this repository will not create a second account to manufacture an appearance of one.

The independence that matters is real but procedural: the implementing agent is Codex and
the reviewing agent is Claude Code, they run in separate sessions with separate context,
and a model reviewing its own output catches its own misreading of a specification far less
reliably than an independent pass does. That is why the two passes exist. The check records
that the second pass happened; it does not prove it.

**Why not require a GitHub review approval instead.** Because the only account that could
give one belongs to the founder, and the merge policy is explicitly that nobody clicks
anything. Requiring it would deadlock every pull request on the person the workflow exists
to keep out of the loop. `.github/CODEOWNERS` records the same reasoning.

Everything that decides *correctness* is deterministic: compilers, tests, migrations,
static analysis. No AI runs in that path. This check sits alongside it and is honest about
being a different kind of signal.
