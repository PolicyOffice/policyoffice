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
