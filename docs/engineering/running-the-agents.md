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

**You never need to know an issue or PR number.** The agents query the backlog themselves
using the selection rule in `AGENTS.md`.

**Starting implementation work.** Open Codex — a separate terminal, not the one Claude is
in — and say:

```text
Pick up the next ready issue and implement it. Follow AGENTS.md.
```

Codex lists open issues labelled `ready`, skips any with unmet dependencies or work
already in progress, claims the lowest-numbered one that remains, reads the spec sections
it cites, implements, tests and opens a pull request.

**Getting a review.** In a Claude session:

```text
Review any open PRs.
```

**Fixing review comments.** Back in Codex:

```text
Address the review comments on any PRs that have them.
```

If a ticket ever needs more than one line of instruction from you, the ticket was not
finished. That is a specification failure, not an operator failure.

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

This is a tool for later. Until there is a backlog with genuinely independent tickets in
it, there is nothing to run in parallel and no reason to create a worktree.

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

## Automation: what is actually possible

Neither agent polls. Both are turn-based — they act when addressed and sit inert
otherwise. "Leave them both running and they will find work" is not how either behaves
natively.

What does exist:

| Mechanism | What it does | Verdict |
|---|---|---|
| **Codex cloud tasks** | Assign tickets; they run in their own containers and open PRs. Laptop can be closed. Several at once. | **Use this.** The right answer for "I am at work." |
| **`/loop` in a Claude session** | Polls on an interval — check open PRs every 30 minutes and review them | Useful once there is steady PR flow. Costs quota on empty ticks. Not yet. |
| **Scheduled cloud agents** | A cron-triggered session that clones the repo and performs a defined job | Viable. Premature. |
| **Remote Control from a phone** | Drive a laptop session from your phone | Real, and the right tool if you want to intervene mid-day |
| **GitHub Actions triggering agents** | Label an issue `ready`, a workflow runs the agent and opens the PR | The genuine end state. **Verify plan coverage before designing around it.** |

### Cloud agents are not context-starved here

The usual objection to cloud sessions is that they lack the project context sitting on your
machine. **For this project that is false.** All context is the repository — `AGENTS.md`,
the specification, the invariant registry, the tickets. A cloud agent clones it and knows
exactly what a local one knows.

That is a direct payoff of putting context in files rather than in conversations. It was
not an accident, and it is what makes unattended work viable at all.

### The bottleneck is not agent runtime

Worth stating bluntly, because it changes what is worth automating: **unused quota is not
the constraint. Specification quality is.**

An agent grinding unsupervised through vague tickets produces pull requests that get
discarded, costing more quota than idling ever saved. Automation multiplies whatever the
backlog contains — including its mistakes, at scale, while nobody is reachable.

So the order matters. A deep, proven ticket backlog first. Automation second.

### Recommended rhythm

Cloud tasks are assigned through an account, not through a machine. Nothing has to be
queued up before leaving the laptop — a browser or phone works from anywhere.

```text
Morning, 30–45 min    Claude session on the laptop — produce a batch of tickets,
                      push them as issues. Close the laptop.

During the day        From a phone or any browser: assign a Codex cloud task.
                      When its PR appears, assign the next. Answer any
                      Decision Request. Nothing else.

Evening               Claude session — review the accumulated PRs.
                      Codex fixes. Merge what is green.
```

**Stagger the tasks; do not fire a batch.** Four tasks assigned at once consume quota
simultaneously and can exhaust a rolling window in one go. Assigning them one at a time
across the day spreads the burn and, more importantly, means a systematically bad ticket
produces one discarded pull request rather than four.

Early on, assign exactly one and look at what comes back before scaling up. Ticket quality
is unproven until a ticket has actually produced a good PR without follow-up questions.

The only two things worth doing from a phone are **assigning the next task** and
**answering Decision Requests**. Both are the operator's job. Neither requires reading
code.

Revisit Actions-triggered automation once tickets are reliably good enough that unattended
implementation has become boring.

## Managing context

Context is re-sent on every turn, so a long conversation costs more per message than a
short one, and eventually gets compacted — which loses detail. The instinct to manage this
is correct. The fix, though, is **session hygiene, not compaction settings**.

**One session, one coherent job.** Consolidating the specification is a session.
Reviewing today's pull requests is a session. Debugging a failing migration is a session.

A session is closer to a branch than to a workspace. You would not do six months of work
on one branch and periodically reset it.

| Action | When |
|---|---|
| **Start a new session** | A new unit of work. **The default.** |
| **Resume a session** | Continuing the same unit of work later — mid-debug, back after lunch |
| **`/clear`** | You are inside a session that has drifted or finished and you want to keep this window. Uncommon. |
| **`/compact`** | Mid-task, running long, and continuity genuinely matters. Lossy — usually better to finish and start fresh. |

Starting a new session costs no more than clearing one; both begin from zero context. What
separate sessions buy is **history**. Each has its own title and transcript, so "the
session where we settled the document taxonomy" is findable months later, and two sessions
can run at once — one reviewing PRs while another writes specification. A single
long-lived session that has been cleared twelve times has one title and a transcript
nobody can navigate.

Either way, a fresh session that reads `AGENTS.md` and two specification files knows more,
and more accurately, than a stale one carrying 200k tokens of conversation about something
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
