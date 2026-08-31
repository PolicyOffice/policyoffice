# AGENTS.md

Read this first. It is a **map**, not the specification. It tells you where authority
lives and which rules you may not break. It is deliberately short.

## What this is

A Policy Operations platform: a system of record for controlled policy lifecycle —
authoring, approval, publication, applicability, distribution, attestation, review,
audit and evidence — for regulated European companies.

It is **not** a wiki, a document store, or a GRC suite.

The guiding test for any change:

> Does this make the system better able to prove which policy version governed whom,
> at what time, under what authority, and with what evidence?

## Where authority lives

| Question | Authoritative source |
|---|---|
| What the product does and for whom | `docs/product/` |
| Domain concepts, states, rules | `docs/domain/` |
| **Invariants you must never break** | `docs/domain/invariants.md` |
| Why the architecture is the way it is | `docs/architecture/adr/` |
| How we work, review and merge | `docs/engineering/agent-workflow.md` |
| When a change counts as finished | `docs/engineering/definition-of-done.md` |
| The current ticket you are implementing | its GitHub issue |

If a GitHub issue and the spec disagree, **the spec wins** — stop and open a
Decision Request.

## Non-negotiable rules

1. **Never silently change a product rule.** If implementing a ticket seems to require
   contradicting `docs/domain/`, stop and open a Decision Request. Implementation
   convenience never overrides governance semantics.
2. **Invariants are cited, not remembered.** Every invariant has a stable ID
   (`INV-VER-003`). Tickets cite them; test names contain them. If you add or change a
   domain rule, the registry entry and its tests change in the same PR.
3. **Released policy content is immutable.** No code path may mutate an approved,
   published or effective version's normative content.
4. **Tenant isolation is absolute.** Every query is tenant-scoped below the UI layer.
   A cross-tenant identifier behaves as not-found, never as forbidden-with-metadata.
5. **Automation never invents authority.** Nothing auto-approves on timeout. An overdue
   review never invalidates an effective policy. Ambiguity fails closed.
6. **The product runs without an LLM.** No runtime AI dependency in any domain
   operation: applicability, authorization, approval, effectivity, attestation,
   audit or evidence.
7. **Privacy is minimal by default.** Do not collect personal data because "an auditor
   might want it." New personal-data fields require justification in the PR.
8. **Never record a review of your own work.** The `independent review` status is set by a
   `Reviewed-commit: <sha>` comment, and it is the one merge condition that is not
   automated. Posting it on your own pull request would unblock your own merge and defeat
   the only gate a machine cannot check. Leave it pending; the reviewing agent posts it.
   This is the whole reason the two-agent split exists — see *Agent lanes* below.

## Working rules

- Branch: `feat/pol-142-short-slug`, `fix/…`, `docs/…`, `chore/…`
- Commits: [Conventional Commits](https://www.conventionalcommits.org/). Imperative mood.
- One PR closes exactly one issue (`Closes #142`). Small and coherent.
- Squash merge only. Branch deleted on merge. `main` is always releasable.
- Never commit secrets, `.env`, or Playwright auth state.
- `main` is protected: no direct pushes. Every change is a pull request, and twelve
  deterministic checks plus the review status must be green before it merges.
- Agent authorship is attributed honestly in commit trailers. That is a feature of this
  project, not something to hide.

## Working on the code

| Need | Command |
|---|---|
| The toolchain | `nvm use` (Node 24, from `.nvmrc`), then `pnpm install` |
| Postgres, object storage, mail | `docker compose up -d` |
| Everything CI runs | `pnpm check` — format, lint, typecheck, invariant coverage, tests, build |
| The migration checks | `pnpm db:verify` — fresh install, upgrade with data, schema drift |
| The platform claims | `./verification/run.sh` — 34 assertions, no application needed |

Integration tests connect as `app_role` and **fail rather than skip** when no database is
reachable. A skipped integration suite is a green build that tested nothing.

The layout is `apps/web`, `apps/worker`, `packages/domain`, `packages/db`,
`packages/testing` and `tooling/` — recorded in `ADR-0000`. `packages/domain` is
framework-free and an architecture test enforces it.

## Picking up work

Do not wait to be told which issue. Select it yourself.

```bash
gh issue list --label ready --state open
```

Selection rule, in order:

1. Skip anything whose `Depends on:` issues are still open.
2. Skip anything already labelled `in-progress` or with an open PR referencing it.
3. Among what remains, take the lowest `POL-` number.

Claim it before starting, and release it if you stop:

```bash
gh issue edit <n> --add-label in-progress
```

For review work, `gh pr list --state open` — review every PR with no review from you since
its most recent commit.

The operator should never need to know an issue number. If they do, the backlog is not
selectable and that is a defect in the tickets.

## Escalate, do not improvise

Open a **Decision Request** issue (template provided) and stop, when you hit:

- a new paid service or a free tier that will be exceeded;
- scope that cannot be built as specified;
- anything that would change a rule in `docs/domain/`;
- a new category of personal data, a retention change, or a new subprocessor;
- anything irreversible or externally visible;
- a disagreement between agents that tests cannot settle.

A blocked ticket with a clear question is a good outcome. A ticket that quietly
redefined the product is not.

## Agent lanes

| Agent | Owns |
|---|---|
| **Claude Code** | Specification, ADRs, ticket authoring, architecture, hard debugging, PR review |
| **Codex** | Implementation, tests, CI fixes, responding to review comments |
| **CI** | The merge gate. Deterministic. No AI in the required-check path. |
| **Founder** | Product decisions, milestone acceptance |

Reviewer must never be the implementer.
