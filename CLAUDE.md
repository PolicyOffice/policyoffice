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

### Never assert from memory what a file already states

Before writing or amending any ticket, **open the authority and read the specific lines
the ticket depends on**. Not your summary of them, not the earlier ticket that cited
them, not what you wrote in a review last week.

Two forms, both of which have shipped defects here:

- **A claim about landed code.** If a ticket says how a merged migration behaves — which
  branch does what, which column a trigger guards, what a function already emits — read
  the migration. POL-017's ticket said `document.activated` was emitted by POL-016; it is
  emitted only inside POL-016's `if v_immediate` branch, so a scheduled first version
  would have gone effective with its document stuck at `PLANNED` and no event ever
  recorded.
- **A constraint written without re-reading what it must hold against.** POL-014 was
  amended to require a check refusing "a digest without `submitted_at`", which is
  unsatisfiable for every draft row because `data-model.md` makes three of those four
  columns `not null`.

Of the five Decision Requests raised while building the document spine, four were defects
in tickets rather than in the specification, and every one had this shape. Codex caught
all of them before implementation, which is the two-agent split working — but a blocked
ticket still costs a full round trip, and these are the cheapest defects in the project
to prevent.

The tell is any sentence in a ticket asserting what another artefact contains. When you
write one, go and look.

## Never brief Codex through the operator

The repository is the only channel between the agents — `running-the-agents.md` § *The agents do
not talk to each other*. The operator has three fixed lines to type and **needs no issue number,
pull request number or sha**.

So do not end a turn with a block for them to paste. If Codex needs to know something, it goes
in the ticket or on the pull request, where it is versioned, reviewable, and still there for an
agent that starts cold next week. Anything said only in chat is invisible to that agent.

This includes the `Reviewed-commit` for pull requests you authored. Rule 8 stops you posting it;
it does not make the operator a courier. Codex finds your open pull requests itself with
`gh pr list --state open` and computes the sha. **A sha in the chat is a smell.**

Done wrong for an entire session on 2026-09-10, until the founder asked whether the
orchestration had broken. It had not — the design was being worked around.

## Reconcile a suite count before citing it

Codex works in the same checkout, so `vitest`'s globs can collect its half-written test files.
That produces a run which reports everything it executed as passing while two workers crash in a
footnote — and it looks exactly like flake.

Check `git status --short`, and reconcile the file count against `origin/main` plus whatever your
branch adds. **If it does not add up, the tree is not yours and the run proves nothing.** On
2026-09-10 this was misdiagnosed as a Node version problem and asserted in two documents before
being checked; a clean `origin/main` behaves identically on Node 20 and 24.

## Committing: never `git add -A`

**Codex works in the same working directory you do.** It is not a separate checkout. So at any
moment the tree may hold files from a branch it is mid-implementation on, and `git add -A`,
`git add .` and `git commit -a` will all sweep them into your commit.

**And check which branch you are on before you create one.** Staging is not the only way another
agent's work ends up in your pull request. On 2026-09-10 a two-file documentation change went out
carrying the whole of POL-029 — 11 files, 1,318 lines — because `git checkout -b` was run while the
shared checkout was on Codex's branch, so the new branch was cut from its commit instead of `main`.
The commit itself was clean, explicit paths and all. **Codex changes the current branch between
your turns.** So:

```bash
git checkout main && git pull --ff-only origin main && git checkout -b docs/whatever
```

Then confirm before opening the pull request:

```bash
git log --oneline origin/main..HEAD    # only your commits
git diff origin/main HEAD --name-only  # only your files
```

Stage explicit paths. Every time:

```bash
git add docs/plans/phase-3-golden-slice.md docs/plans/open-decisions.md
```

Then read `git status --short` before committing, and treat anything you did not name as a
signal that Codex is working — not as something to include.

This is not hypothetical. On 2026-09-09, PR #96 was opened as *"documentation only, Tier 0"*,
intended to change two files in `docs/plans/`. It landed nine: a migration, a new module, its
test, an export and two test-file edits — the whole of POL-022, swept out of Codex's working
tree by one `git add -A`. The founder approved it on the Tier 0 description. Nothing unreviewed
reached `main` only because the same code was independently reviewed on its own pull request an
hour later, which was luck rather than process.

A Tier 0 label that is false is worse than no label. It is the one thing a reviewer is entitled
to take at face value.

## Subagent policy

Default: none. This project runs on two €20/month subscriptions.

- Use `Explore` for wide codebase searches that would otherwise flood context.
- Use a second review agent **only** for Tier 2 changes.
- Never fan out multiple reviewers over the same diff. The independence that matters is
  already there: Codex implements, you review.
