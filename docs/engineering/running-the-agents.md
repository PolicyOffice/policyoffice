# Running the Agents

The practical mechanics. `agent-workflow.md` says what the process is; this says how to
actually operate it on one laptop.

## The agents do not talk to each other

Claude Code and Codex are separate programs. Neither can see the other's conversation, and
neither is a daemon that needs to stay running. There is no orchestrator process.

**The repository is the only channel between them.**

```text
Claude session  ──writes──▶  spec, ADRs, GitHub issues
                                      │
                                      ▼
                            Codex session  ──writes──▶  branch, PR
                                      │
                                      ▼
                            Claude session  ──writes──▶  PR review
```

Everything an agent needs to act is in the repository or in a GitHub issue. That is not a
stylistic preference — it is the reason a cold agent with no memory of any previous
conversation can pick up work and be immediately useful.

## What you actually type

**Starting implementation work.** Open Codex — a separate terminal, not the one Claude is
in — and give it one line:

```text
Work on issue #14. Follow AGENTS.md.
```

That is the whole instruction. Codex reads `AGENTS.md` on its own, reads the issue with
`gh issue view 14`, finds the spec sections the issue cites, implements, tests, and opens
a pull request. If the ticket needs more than one line of instruction from you, the ticket
was not finished.

**Getting a review.** In a Claude session:

```text
Review PR #23.
```

**Fixing review comments.** Back in Codex:

```text
Address the review comments on PR #23.
```

## Local Codex or cloud Codex

Codex can run as a local CLI or as a cloud task that works in its own container and opens
a PR without your machine being involved. Both are useful, for different work.

| | Use for | Because |
|---|---|---|
| **Cloud tasks** | Well-specified tickets with no local dependency | Closest thing to fire-and-forget. Assign it, close the laptop, a PR appears. Several can run at once. |
| **Local CLI** | Anything needing the local environment — database, migrations, Playwright against a running app, debugging | It can actually run the thing |

Check what your plan includes before designing a day around cloud tasks. Practically:
batch the well-specified tickets to the cloud, keep the fiddly ones local.

## Running two things at once

Two agents editing the same working directory will collide. Use a **git worktree** — a
second checkout of the same repository on a different branch, sharing one history:

```bash
git worktree add ../pm-pol-014 -b feat/pol-014-content-revision
```

Now `../pm-pol-014` is a complete working copy on its own branch. Point one Codex session
at it and another at the main directory. When the branch merges:

```bash
git worktree remove ../pm-pol-014
```

Only parallelise tickets with no dependency on each other. The ticket backlog states
dependencies for exactly this reason.

## A realistic day

You will not run all of this every day. Most days are one box.

```text
Morning     Claude session — decompose an epic into 5-8 tickets, push them as issues
            ~30-45 min of your attention, most of it answering questions

Then        Assign 2-3 tickets to Codex. Cloud tasks, or local in worktrees.
            Walk away.

Later       PRs exist. Claude session — review them. Codex fixes what comes back.

End         Merge what is green. Answer any Decision Request.
            ~10 minutes.
```

The expensive part is the morning. Everything after it is cheap, and most of it happens
without you.

## Managing context

Context is re-sent on every turn, so a long conversation costs more per message than a
short one, and eventually gets compacted — which loses detail. The instinct to manage this
is correct. The fix, though, is **session hygiene, not compaction settings**.

**One session, one coherent job.** Consolidating the spec is a session. Reviewing three
PRs is a session. Debugging a failing migration is a session. When the job changes, clear
and start fresh.

```text
/clear      starting something new — wipes context, keeps the repo
/compact    mid-task and running long — summarises, keeps continuity, loses detail
```

Prefer `/clear`. A fresh session that reads `AGENTS.md` and two spec files knows more,
more accurately, than a stale session carrying 200k tokens of conversation about something
else. The summary you would have paid to keep is usually worse than the documents it was
summarising.

**This is why the repository is written the way it is.** `AGENTS.md`, `CLAUDE.md`, the
domain specification and the ticket contracts exist so that context lives in files rather
than in a conversation. Files are cheap to re-read, precise, reviewable, and shared between
agents. Conversation is none of those things.

Practical habits:

- Do not paste large documents into chat. Put them in the repository and say where.
- Keep `CLAUDE.md` short — it loads into every session automatically.
- Work in focused bursts rather than scattered single messages; repeated context is cached
  for a period, so consecutive turns are cheaper than the same turns spread across a day.
- When a session has produced something durable — a decision, a spec, a ticket — write it
  to the repository **before** clearing. Anything not written down is lost, by design.

If a conversation is worth keeping, it was worth committing.
