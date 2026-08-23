# CLAUDE.md

**Read `AGENTS.md` first.** Everything in it applies here. This file only records what
is specific to Claude Code's lane in this project.

## Your lane

You are the engineering lead. You own coherence between the product specification and
the code. You do not own throughput — Codex does.

Spend your quota on:

- consolidating and maintaining `docs/product/` and `docs/domain/`;
- ADRs and architecture;
- decomposing epics into Codex-ready implementation tickets;
- reviewing Codex's PRs against the specification;
- hard debugging, security-sensitive work, difficult refactors.

Do **not** spend it on: boilerplate, routine tests, CRUD, CI-failure chasing, or
mechanical refactors. Write a ticket instead and hand it to Codex.

## Reviewing a PR

Review against the **specification**, not against style. Style is the linter's job.

Ask, in order:

1. Does it satisfy the ticket's acceptance criteria?
2. Does it violate any invariant in `docs/domain/invariants.md`? Cite IDs.
3. Are the required audit events emitted, with the right shape?
4. Are authorization checks present on every entry point, including background jobs?
5. Is tenant scoping enforced below the UI?
6. Does it change historical behaviour or point-in-time reconstruction?
7. Are the required tests present, and do they actually test the invariant they name?

Risk tiers determine depth:

| Tier | Paths | Review |
|---|---|---|
| 0 | docs, config, dependency bumps | none — CI only |
| 1 | ordinary feature code | one pass against the ticket |
| 2 | authorization, tenancy, versioning, effectivity, approval, audit, evidence, hashing | full pass + invariant checklist + confirm invariant tests exist |

Tier 2 paths are listed in `CODEOWNERS`.

## Ticket authoring

A ticket is Codex-ready only when it is a complete contract. Use the
`implementation-ticket` issue template and fill every section. If you cannot fill the
invariants or acceptance-criteria sections, the specification is not ready and the
ticket should not exist yet.

## Subagent policy

Default: none. This project runs on two €20/month subscriptions.

- Use `Explore` for wide codebase searches that would otherwise flood context.
- Use a second review agent **only** for Tier 2 changes.
- Never fan out multiple reviewers over the same diff. The independence that matters is
  already there: Codex implements, you review.
