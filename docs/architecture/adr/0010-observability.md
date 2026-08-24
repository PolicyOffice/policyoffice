# ADR-0010: Observability

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

This product needs to know whether its scheduled governance work is happening. It also
sells to buyers whose DPO is in the room, and whose objection to compliance tooling is
that it becomes surveillance.

Those two pull in opposite directions, and the specification already picked a side:

> **INV-AUD-007 — Business governance events and low-level security or observability logs
> remain separately modelled.**  *"The evidence ledger is not a request log."*

> **INV-AUD-003 — Audit events never contain document bodies, arbitrary form payloads or
> unnecessary personal data.**

And from `product-blueprint.md`, stated as a product position rather than a technical one:
reading telemetry is off, network metadata is not collected by default, and *"a compliance
product that quietly becomes an employee monitoring system has betrayed the compliance
function it serves."*

Decision 7 adds the third constraint: observability containing customer data stays in the
EU region, completely.

## Decision

### Two systems, permanently separate

| | Audit ledger | Operational telemetry |
|---|---|---|
| Question | *What did the organisation do?* | *Is the system working?* |
| Store | Postgres, in-tenant, append-only (`ADR-0006`) | Logs and metrics, outside the domain |
| Retention | Per record class, customer-configured | 30 days for logs; 2 years for security events |
| Audience | Auditors, regulators, evidence packs | Us |
| Contains | Governance transitions | Requests, latencies, failures |
| Contains **never** | Request payloads, page views, searches | Anything that is evidence |

Nothing is written to both. A governance transition is a ledger event and does not become
a log line; an HTTP 500 is a log line and never becomes evidence.

### Logs carry identifiers, not content

An **allowlist**, not a denylist. A log line may carry: `tenant_id`, `correlation_id`,
`request_id`, `actor_id`, the route, the outcome, timings, an error class, and the
identifiers of governance objects involved. Anything not on that list is not logged.

Denylist redaction — scrubbing fields that look sensitive — fails the first time someone
adds a field. An allowlist fails closed, and the failure is a missing field in a log
rather than a document body in a third-party service.

Specifically never logged: document titles or content, attestation statement text, comment
or rationale text, search queries, email addresses, request or response bodies.

`correlation_id` is shared with the audit envelope (`audit-event-catalogue.md`), so an
operational incident can be tied to the governance events it touched — by identifier,
without either store holding the other's data.

### No session replay. No product analytics.

Stated as a refusal because the tooling is ubiquitous and would be installed by reflex.

Session replay records the screen. In this product the screen contains the customer's
policies, their draft text, their approver comments and their employees' names. Installing
it would export exactly the material the tenancy model, the authorization evaluator and
the privacy profiles exist to protect — to a third party, outside the evidence ledger,
with no governance record that it happened.

The same applies to behavioural product analytics. `success-metrics.md` already refuses to
measure reading time, scroll depth, engagement and search queries; instrumenting them for
"product insight" would reintroduce through the back door what the metrics chapter turned
down at the front.

What replaces them: server-side counters of governance outcomes — packs generated, reviews
completed on time, campaigns closed — which are derived from the ledger and are the
customer's own data, not observation of their employees.

### What is actually monitored

The signals that matter here are not the usual ones. They come from what the preceding
ADRs made non-authoritative on purpose.

| Signal | Why it matters | Alert |
|---|---|---|
| **Scheduled transition delay** | `ADR-0005` made effectivity resolve from the range, so a late job means the register misdescribes reality rather than breaking it. Safe only if someone is told | Yes, and quickly |
| **Dead-lettered governance jobs** | `ADR-0007`: a silently dead effectivity or review job means the register lies indefinitely | Yes |
| **Audit sequence gaps** | `ADR-0006` makes the per-tenant sequence gapless. A gap means something is badly wrong with the ledger's integrity claim | Yes, highest severity |
| **Evidence generation failure rate** | The differentiating feature failing quietly is the worst way for it to fail | Yes |
| **Notification delivery failure** | A reminder nobody received is a deadline nobody knew about | Yes |
| **Authorization decision latency** | The evaluator is on every path (`ADR-0003`); degradation there is degradation everywhere | Threshold |
| **Sequence-row lock wait time** | The measured cost of `ADR-0006`'s gapless ordering, and the number that decides whether the fallback is ever needed | Threshold |
| **Job queue depth and age** | Standard, and here it is a governance signal rather than a capacity one | Threshold |
| **Search index lag** | Cannot leak (`INV-AUTH-011` enforces at retrieval) but can confuse | Informational |

An audit sequence gap is the one to be loudest about. It should never happen, and if it
does, the integrity property that evidence packs advertise has stopped being true.

### Error tracking

Sentry, EU region, with server-side scrubbing on and the allowlist above applied before
anything is sent.

The rule that needs stating: **stack traces must not carry domain payloads.** A captured
exception whose frames include a document's content has exported that content, and error
trackers are exactly where this happens accidentally. Domain errors are typed and carry
identifiers; they do not carry the objects they failed on.

### Residency

Decision 7 says one EU region, complete, and observability *containing customer data* is
explicitly in scope. So:

- error tracking in an EU region, or it is not used;
- logs and metrics retained in-region;
- any provider that cannot be constrained to the EU is a **Decision Request**, not a
  substitution.

`ADR-0000`'s verification list already carries this for Sentry and Resend. It is repeated
here because this is where the requirement actually bites — telemetry is the component
most likely to be adopted casually from a US-hosted free tier.

### Health and readiness

Liveness, readiness including database reachability, and a build identifier. The readiness
check does **not** run a domain query — a health endpoint that reads tenant data is an
unauthenticated read path, which is precisely what `ADR-0003` exists to prevent.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One store for audit and telemetry** | Forbidden by INV-AUD-007, and it would put request logs inside evidence packs and evidence inside a log retention policy |
| **Denylist redaction** | Fails the first time a field is added, and fails open |
| **Session replay** | Would export policy content, draft text and employee names to a third party, outside the ledger, with no record. Contradicts the product's stated position |
| **Behavioural product analytics** | Reintroduces the metrics `success-metrics.md` refuses, wearing an engineering hat |
| **Logging request bodies for debugging** | The single most common way personal data reaches a log aggregator |
| **A US-hosted free tier for error tracking** | Convenient, and it breaks decision 7 quietly rather than loudly |
| **Distributed tracing from day one** | Real value in a distributed system. `ADR-0000` chose a monolith; correlation identifiers already answer most of what tracing would |

## Consequences

### What becomes easier

- The DPO question — *what does your product record about our employees?* — has a short,
  checkable answer.
- Governance failures are visible as governance failures, not buried in application logs.
- Residency is easy to state completely, because there are few places customer data can
  go.

### What becomes harder

- **Debugging with less context.** No request bodies, no payloads in traces. Reproduction
  depends on correlation identifiers and on the domain being deterministic, which it is by
  design.
- **The allowlist is maintenance.** Every new field is a decision, and that friction is
  the control working.
- **No behavioural data to reach for** when a product question arises. The answer is to
  ask the design partner.

### What we have committed to maintaining

- The allowlist, and the review that keeps new fields off it by default.
- The separation between the ledger and telemetry, in both directions.
- No session replay and no behavioural analytics, as a standing position rather than a
  current absence.

### Cost of reversing this

Low technically, high in credibility. Adding session replay or behavioural analytics later
contradicts a published product position, and the buyers most likely to notice are the
ones whose objection it was written to answer.

## To verify at repository bootstrap

- Sentry's EU region on the free tier, and whether server-side scrubbing is configurable
  enough to enforce an allowlist rather than a denylist.
- Log retention and residency for whatever the deployment target provides by default —
  platform logs are the easiest place for this commitment to leak.
- That a sequence-gap detector can run cheaply enough to be continuous rather than
  nightly.
