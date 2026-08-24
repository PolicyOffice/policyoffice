# ADR-0007: Job execution and scheduling

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

Six things in this product happen without a person present: a version becomes effective, a
review falls due, a reminder is sent, a campaign enrols or closes, an evidence pack is
assembled, and records become eligible for disposal.

Every one of them is a governance action, which makes the job runner a governance
component rather than infrastructure. The invariants it has to satisfy are unusually
specific:

> **INV-APR-002 — No elapsed time, timeout or escalation ever results in automatic
> approval.**  **INV-EFF-007 — A scheduler firing twice produces exactly one
> `version.effective` event.**  **INV-TIME-002 — Scheduled transitions behave correctly
> across DST boundaries and timezone configuration changes.**  **INV-TIME-004 — A retried
> request returns the original logical result rather than performing the action twice.**
> **INV-ATT-010 — Duplicate notification delivery never produces duplicate assignments or
> duplicate governance transitions.**

`ADR-0000` chose a Postgres-backed queue over a workflow engine, because INV-AUD-004 wants
the enqueue and the state change in one transaction. This ADR decides how the runner
behaves.

## Decision

### At-least-once, and every handler is idempotent

There is no exactly-once delivery, here or anywhere. Rather than pretending otherwise, the
guarantee is placed where it can actually be enforced: **inside the domain transaction**,
not in the queue.

`ADR-0005` already showed the shape — lock the aggregate, re-read authoritative state,
no-op if the transition has happened or can no longer happen. `ADR-0006` backs it with a
unique dedupe key on the event. A handler that runs twice therefore produces one
transition and one event, structurally, whatever the queue does.

This is why the queue's delivery semantics are not load-bearing, and why choosing a
different queue later would be cheap.

### Payloads are references, never snapshots

A job carries identifiers and the instant it was scheduled for. It carries **no copy of
the state it will act on**.

The payload describes what was true when the job was enqueued. Withdrawal, cancellation,
reassignment and configuration changes all happen after that. A handler that trusts its
payload is a handler that acts on stale facts — which is precisely how a withdrawn version
becomes effective (INV-EFF-008) or a deactivated approver's task auto-completes
(INV-APR-005).

Every handler re-reads authoritative state inside its transaction, and treats the payload
as a pointer.

### Time comes from the database

Handlers do not read the worker's wall clock for governance decisions. The authoritative
instant is `now()` inside the transaction — one clock, transaction-consistent, and the
same clock the effective ranges of `ADR-0005` are compared against.

A worker with a skewed clock is then a monitoring problem rather than a correctness one.

### Scheduling is a calendar rule, not an interval

> **INV-TIME-002 — Scheduled transitions behave correctly across DST boundaries and
> timezone configuration changes.**

Recurring work — review cadences, reminder ladders — is stored as a **rule**: cadence,
anchor, the tenant's timezone, and a time of day. The next occurrence's UTC instant is
*derived* from the rule, never by adding a fixed number of seconds to the previous one.

Adding 365 days lands an hour out across a DST boundary and drifts permanently. Adding a
calendar month to 31 January has to clamp to the end of February, and the following
occurrence returns to the 31st rather than staying clamped — `review-model.md` specifies
this arithmetic, and it lives in the domain package, not in the job runner.

When a tenant changes its timezone, **future** instants are recomputed from the rules.
Past ones are historical facts and never move.

### Failure is visible, not silent

Bounded retries with exponential backoff and jitter. After exhaustion, a job goes to a
dead-letter state — and, for governance job classes, **raises a governance exception that
appears in the register**.

This matters more here than in most systems. `ADR-0005` deliberately made the effectivity
transition non-authoritative: if it never runs, the right text still resolves and only the
register is wrong. That is the safe failure mode, but it is only safe if someone is told.
A silently dead effectivity job means the register lies indefinitely.

| Job class | On exhaustion | Why |
|---|---|---|
| Effectivity transition | Governance exception, alert. Resolution is unaffected | The register would otherwise misdescribe reality |
| Review scheduling | Governance exception | A missed review that nobody knows is missed is the failure the product exists to prevent |
| Reminder or notification | Logged, retried, surfaced on the campaign or run | Delivery is operational; the obligation stands regardless (INV-ATT-010) |
| Evidence pack generation | Pack marked `FAILED`, never partially available | INV-EVD-004 |
| Retention disposal | Alert, nothing disposed | Failing closed on destruction is always right |
| Campaign enrolment (V1) | Governance exception | A joiner who silently received no obligation is invisible |

Nothing on that list retries into an approval, an acknowledgement or a withdrawal.
Automation reminds and escalates; it never decides (INV-APR-002).

### Workers are principals

A worker process runs the same codebase and the same domain package as the web
application, and each job executes as an **explicit principal with explicit
capabilities**, inside a tenant context.

There is no system user with everything. `ADR-0001`'s transaction helper requires a tenant
context, and `ADR-0003`'s evaluator requires a principal, so a job that fails to establish
both cannot reach data at all — which is INV-TEN-004 holding for background work by
construction rather than by review.

### Concurrency

`SELECT … FOR UPDATE SKIP LOCKED` for dequeue, giving parallel workers without
coordination. Correctness comes from the per-aggregate lock in the domain transaction
(`ADR-0005`), not from queue-level exclusivity — so throughput can grow without weakening
any guarantee.

Jobs that must not run concurrently for the same subject take the same aggregate lock, and
the second one blocks and then no-ops.

### Queue choice

The required properties, in priority order:

1. **Transactional enqueue** — a job can be added inside the caller's transaction, so
   enqueue and state change commit together (INV-AUD-004)
2. `SKIP LOCKED` dequeue with a visibility timeout
3. Scheduled and delayed jobs
4. Recurring jobs, or a scheduler that can create them
5. Retry policy with backoff, and a dead-letter state
6. No component outside PostgreSQL

**Graphile Worker** is the candidate that appears to satisfy all six, with pg-boss as the
alternative. That is a starting point, not a decision: the property list is what matters,
and which library provides it is confirmed at bootstrap. Property 1 is the one to test
first, because a library that only enqueues over its own connection defeats the entire
argument for this design.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Temporal or a dedicated workflow engine** | Splits the transaction INV-AUD-004 requires, adds a second system inside the EU residency commitment, and costs money on any realistic plan |
| **Redis-backed queue** | A second store to keep in-region and consistent, with no transactional relationship to the data it acts on |
| **Cron plus a polling table** | Effectively what this is, minus visibility timeouts, backoff and dead-lettering. Rebuilding those is not a saving |
| **Exactly-once delivery** | Does not exist. Claiming it moves the idempotency requirement somewhere it will not be honoured |
| **Snapshot payloads** | Faster handlers, acting on facts that may have changed. The withdrawal race is the counterexample |
| **Worker wall clock** | Two clocks, and the wrong one is authoritative during skew |
| **Adding N days for recurrence** | Drifts across DST and mishandles month ends. The rule is the source of truth, not the previous instant |
| **A system superuser principal for jobs** | Convenient, and it removes the authorization boundary from every background path — the classic way multi-tenant products leak through their workers |

## Consequences

### What becomes easier

- The queue can be replaced without touching correctness, because correctness is in the
  domain transaction.
- Background work inherits tenancy and authorization by construction, satisfying
  INV-TEN-004 without a separate review of every job.
- Scheduling correctness across DST and month boundaries is unit-testable in the domain
  package, with no clock or queue involved.

### What becomes harder

- **Every handler re-reads state**, which is more code and more queries than trusting a
  payload. It is also the only correct option.
- **Job failure needs a governance surface**, not just an error log. The register has to
  grow a way to show "this scheduled transition has not happened", and someone has to look
  at it.
- **Two processes to run and observe** in local development and in CI.
- **Timezone recomputation on configuration change** is a real migration-shaped operation
  the first time a tenant changes it.

### What we have committed to maintaining

- Idempotency in every governance handler, asserted by a test that runs the handler twice
  and expects one transition and one event.
- Reference payloads. A snapshot in a payload is a defect, however convenient.
- No job that can produce an approval, an acknowledgement or a withdrawal without a
  person.

### Cost of reversing this

Low for the queue library. High for the idempotency discipline, because relaxing it means
auditing every handler to find which ones were quietly relying on the queue instead.

## To verify at repository bootstrap

- That the chosen library can enqueue inside a caller-supplied transaction — property 1,
  and the one the whole design rests on.
- Neon's connection limits against a worker pool plus a web pool, since both hold
  connections and the free tier is not generous.
- Whether a long-running job (evidence generation) needs its own queue or worker pool so
  it cannot starve short governance transitions.
- `SKIP LOCKED` behaviour through Neon's pooler.
