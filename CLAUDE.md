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

### Before filing: prove every acceptance criterion can be met

The rule above is necessary and was not sufficient. In Phase 3 every Decision Request raised
against a ticket — #120, #132 and #139 — was a defect in the ticket, and one more was caught only
in review. All four were written after that rule existed, by the agent that wrote it. So the rule
is now a **pass over the finished draft**, run before `gh issue create` and again before any
amendment:

1. **Each criterion against the ticket's own facts.** For every acceptance criterion, name the
   tables, counts and mappings in the same ticket it depends on, and check it can be met given
   them. POL-033 listed four routes resting on three distinct capabilities, then required each
   denial case to hold *"the other three"* — impossible, and written in the same ticket as the
   table that made it so (#139).
2. **Each criterion against the machinery that has to satisfy it** — the type system, an existing
   gate, an accepted ADR. POL-031 required a handle to *"fail to compile"* when passed where
   `{ query }` is expected; branding the source never blocks structural assignability, which `tsc`
   confirms in a minute. The same draft required a second transaction opener that `ADR-0001` § 3
   forbids (#132).
3. **The Goal against the criteria.** The Goal is what the criteria must jointly prove. If it
   claims more, a criterion is missing or the Goal overstates. POL-027's Goal was *"deleting any
   part of it fails the build"*; its five cases left two conjuncts deletable, and POL-028 existed
   only to finish the sentence.
4. **Every claim about another artefact, opened** — the section above. POL-029 said revocation
   sets `revoked_at` and never deletes, contradicting `ADR-0002`, `data-model.md` and the trigger
   in `0003` at once (#120).
5. **Nothing that forecloses challenge.** Never write *"decided here so it is not re-litigated"*,
   or anything else telling the implementer not to object. The implementer's Decision Request is
   the safety net under items 1–4, and that sentence, in POL-031's first draft, tried to remove
   it. Propose the design, and say that a contradiction means a Decision Request rather than a
   workaround.

**Say in the ticket what the pass checked, specifically.** *"Verified: `createContentRevision`
takes `contentBytes`; nothing wires object storage"* is evidence a reviewer can falsify.
*"Verified against the spec"* is not.

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

`vitest` collects by glob, so a run in a tree that also holds another agent's half-written test
files reports everything it executed as passing while two workers crash in a footnote — and it looks
exactly like flake.

That happened on 2026-09-10, in the shared checkout that preceded the worktree split. **Under the
split it cannot happen from your own worktree.** The way it reaches you now is the one in the next
section: a session pointed at `PolicyManagement/`, where Codex's in-progress work is exactly what
you would be running against.

So reconcile the number before citing it. Count the files against `origin/main` plus whatever your
branch adds. **If it does not add up, the tree is not yours and the run proves nothing** — and that
is the check that caught it, after the crash had already been misdiagnosed as a Node version problem
and asserted in two documents. A clean `origin/main` behaves identically on Node 20 and 24.

## Committing: check which worktree you are in

**`running-the-agents.md` § *Where each agent works* is the authority**, not your recollection:
`PolicyManagement/` is Codex's and sits on its feature branch while working;
`policyoffice-claude/` is yours and stays **detached**, never on a named branch — because
`gh pr merge --delete-branch` fails if either worktree holds the branch being deleted.

Before the split existed the agents shared one working tree, and both failure modes below actually
happened. The split fixes the arrangement. **It does not fix a session pointed at the wrong
directory** — on 2026-09-12 this session was running in `PolicyManagement/`, on Codex's feature
branch, which is how the 2026-09-10 incident could have repeated after the split was in place.

So, first thing, every session:

```bash
git rev-parse --show-toplevel   # must end in /policyoffice-claude
git worktree list
```

If it does not, **do not create a branch here.** Either work through
`git -C /path/to/policyoffice-claude`, keeping that worktree detached, or ask for the session to be
pointed at the right directory. Committing on a detached HEAD and pushing with
`git push origin HEAD:refs/heads/<branch>` is the normal flow, not a workaround.

**Stage explicit paths anyway.** In your own worktree `git add -A` can no longer sweep up Codex's
files — separate index, separate HEAD — so the original reason is gone. The remaining one is your
own mess: reviewing a Tier 2 change means writing probe files and mutating source to check the tests
actually fail, and `git add -A` will commit a half-reverted mutation without comment.

```bash
git add docs/plans/phase-3-golden-slice.md docs/plans/open-decisions.md
```

**Confirm the branch point before opening a pull request.** Two commands, and they catch both
failure modes at once:

```bash
git log --oneline origin/main..HEAD      # only your commits
git diff origin/main...HEAD --name-only  # only your files
```

**Three dots on the diff, and it matters.** `git diff origin/main HEAD` compares the two commits,
so its output also lists every file **`main` gained since you branched**. On 2026-09-17 that
reported a third file on #152, a two-file pull request: the branch was cut at `6503163`, `main`
had since merged #151, and the plan file that merge touched appeared as though it were yours. The
only way to tell that false alarm from real contamination was to ask GitHub what the pull request
actually contained.

`origin/main...HEAD` diffs from the merge base instead, which is what the pull request itself
shows. It still catches the failure this section exists for: a branch cut from Codex's feature
branch moves the merge base back to where that branch left `main`, so its files appear. The
`git log` line needs no such fix — commits on `HEAD` that are not on `main` is already the right
question.

**A check that cries wolf is worse than no check**, because it teaches you to wave through the one
time it is right.

Contamination is not hypothetical either. On 2026-09-09, PR #96 was opened as *"documentation
only, Tier 0"*, intended to change two files in `docs/plans/`. It landed nine: a migration, a new
module, its test, an export and two test-file edits — the whole of POL-022, swept out of Codex's
working tree by one `git add -A`. The founder approved it on the Tier 0 description. Nothing
unreviewed reached `main` only because the same code was independently reviewed on its own pull
request an hour later, which was luck rather than process.

It happened again on 2026-09-10, and that time there was **no staging mistake at all**: a two-file
documentation change carried the whole of POL-029 — 11 files, 1,318 lines — because `git checkout -b`
ran while the shared checkout sat on Codex's branch, so the new branch was cut from its commit
instead of `main`. The commit was clean; the branch point was not. That is the one the two commands
above catch, and it is the reason to run them even when the diff looks right.

Both incidents predate the worktree split. Neither is possible from a correctly-pointed
`policyoffice-claude/`, which is exactly why the first check in this section is *which worktree am I
in*.

A Tier 0 label that is false is worse than no label. It is the one thing a reviewer is entitled
to take at face value.

## Subagent policy

Default: none. This project runs on two €20/month subscriptions.

- Use `Explore` for wide codebase searches that would otherwise flood context.
- Use a second review agent **only** for Tier 2 changes.
- Never fan out multiple reviewers over the same diff. The independence that matters is
  already there: Codex implements, you review.
