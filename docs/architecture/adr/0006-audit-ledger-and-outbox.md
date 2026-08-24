# ADR-0006: The audit ledger and outbound delivery

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

The audit ledger is the product's evidence spine. `audit-event-catalogue.md` specifies the
envelope and roughly ninety event types; this ADR decides how they are written, ordered
and delivered.

> **INV-AUD-004 — An event is emitted in the same transaction as the state change it
> records, or via an outbox guaranteeing eventual emission.**  *"A committed change with
> no event is an unprovable change."*

> **INV-AUD-009 — Events carry a deterministic total order within a tenant, so a
> reconstructed chronology is stable across regenerations.**

The second is harder than it looks, and it is where most of this ADR goes.

## Decision

### The ledger is written in the same transaction. There is no outbox for it.

`ADR-0000` put the event store in the same PostgreSQL database as the domain. That
collapses INV-AUD-004's two options into the simpler one: the event is an `INSERT` in the
transaction that made the change. Either both commit or neither does.

An outbox pattern exists to bridge a transaction boundary. There is no boundary to bridge,
so introducing one would add a delivery guarantee problem in order to solve a problem we
do not have.

**Outbound delivery is a different question.** Webhooks (V1) and SIEM export (V1) do cross
a boundary, and they are handled by consumers reading forward over the ledger with a
cursor — covered below. The ledger itself is the outbox; there is no second table.

### Ordering: a gapless per-tenant sequence

The obvious implementation — a `bigserial` — is wrong here, and quietly so.

A sequence assigns its value when a statement runs, not when its transaction commits.
Transaction A can take sequence 5 while B takes 6, and B can commit first. A consumer
following the log by sequence reads 6, records its cursor, and then 5 appears behind it
and is never delivered. The same reordering makes "regenerate this evidence pack" return a
different chronology depending on when it ran, which INV-EVD-006 forbids.

Sequences also leave gaps on rollback. In an evidence ledger a gap is indistinguishable
from a deleted event, which undermines exactly the property the ledger is for.

So the sequence is allocated under a per-tenant row lock, inside the transaction:

```sql
-- one row per tenant; the update takes a row lock held to commit
update tenant_event_sequence
   set next_sequence = next_sequence + 1
 where tenant_id = $1
returning next_sequence - 1 as sequence;
```

Two properties follow, and both are worth the cost:

**Gapless.** Sequence *n+1* cannot be assigned until *n*'s transaction has committed or
rolled back — a rollback releases the lock without incrementing. "Sequences 1 to N with no
holes" therefore becomes a checkable integrity property of an exported ledger, verifiable
by a recipient with no access to the system.

**Commit-ordered.** Assignment order and commit order are the same, so a cursor-following
consumer cannot skip an event, and a regenerated pack orders identically.

The cost is that **governed writes within one tenant serialise at commit**. For this
product that is acceptable arithmetic: a busy tenant performs a few hundred governance
actions a day, and the lock is held for the tail of a short transaction. Tenants do not
contend with each other at all.

The exception is bulk import, which can produce thousands of events. It runs as one
transaction per batch, taking the lock once per batch rather than once per document.

### Append-only, structurally

```sql
revoke update, delete, truncate on audit_event from app_role;
```

Level 2 on the enforcement ladder, and the reason `ADR-0001` has the application connect
as a non-owner role. Corrections are compensating events carrying `corrects_event_id`
(INV-AUD-002); there is no code path that edits history because the database role cannot.

**Retention disposal is the one exception**, and it is deliberate. Records become eligible
for disposal under the customer's configured schedule (INV-RET-003), which requires
`DELETE`. That runs as a separate retention role, from a job that checks legal holds first
(INV-RET-001), and it emits `retention.disposed` — which is itself a ledger event. The
application role never holds that privilege.

### Exactly one event per transition

> **INV-AUD-001 — Every governance-relevant transition emits exactly one canonical audit
> event.**

Enforced with a dedupe key rather than by care:

```sql
-- e.g. 'version.effective:9f2c…', 'campaign.launched:41ab…'
unique (tenant_id, dedupe_key)
```

A retried job or a double-clicked button produces a unique-violation the emitting
transaction treats as "already recorded", not as an error. This is INV-EFF-007 — *a
scheduler firing twice produces exactly one `version.effective`* — enforced at level 2
rather than trusted to a handler.

Events that legitimately recur (`attestation.reminded`, `approval.reminded`) include the
occurrence in their key.

### The envelope

The fields INV-AUD-005 requires are **columns**, not JSON: tenant, sequence, type, schema
version, `occurred_at`, `recorded_at`, actor, originating actor, elevation session,
subject, the governance coordinates, action, outcome, correlation, source channel,
configuration version.

Family-specific attributes go in a `jsonb` column with two guards: a size limit as a
`CHECK` constraint, and validation at write time against a schema registry keyed by
`(event_type, event_schema_version)`. Free-form payloads are how ledgers accumulate
document bodies and personal data, which INV-AUD-003 forbids.

> **INV-AUD-008 — Event types are a versioned contract.**

The registry keeps every historical `(type, version)` schema. Adding a required field
means a new version; the old one stays valid for events already written. An event type is
never renamed and never repurposed — that would silently reinterpret history.

### One emission path

`emit(ctx, event)` is callable only with an open transaction context, and an architecture
test fails the build on any other `INSERT` into `audit_event`. The same rule as ADR-0003's
evaluator, for the same reason: a second path is the defect.

### Outbound delivery

Webhooks and SIEM export are V1. Because the sequence is gapless and commit-ordered, each
consumer is a durable cursor:

```text
consumer:  last_sequence = 918273
poll:      select … where tenant_id = $1 and sequence > $2 order by sequence limit 500
```

No event can be skipped, delivery is at-least-once, and consumers deduplicate on
`event_id`. A delivery failure never alters governance state — a webhook that cannot be
delivered is an operational problem, not a governance one.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A separate outbox table** | Solves a transaction-boundary problem that does not exist when the ledger shares the domain's database. Adds a second store to keep consistent |
| **`bigserial` sequence** | Assignment order is not commit order, so a cursor-following consumer skips events and regenerated packs reorder. Gaps on rollback are indistinguishable from deletions |
| **Ordering by `occurred_at` alone** | Timestamps collide, and a backdated governance fact can precede an event recorded earlier. INV-AUD-009 needs a tiebreak that is stable |
| **A global sequence across tenants** | Every tenant's writes would serialise against every other tenant's, and the sequence would leak cross-tenant activity volume — a side channel under INV-TEN-005 |
| **Logical decoding / CDC to build the ledger** | Elegant, and it makes the ledger a derivative of physical replication rather than a first-class governed record. Schema changes and vacuum behaviour become evidence concerns |
| **Free-form `jsonb` payload** | How ledgers end up containing document bodies and unnecessary personal data (INV-AUD-003) |
| **Application-level append-only discipline** | Level 4 where level 2 is available. `REVOKE` is one line and cannot be forgotten |
| **Hash-chaining events now** | Genuinely stronger tamper evidence, and the glossary deliberately reserves that as a later claim. It also complicates retention disposal, since deleting a link breaks the chain. Revisit when a customer requires it |

## Consequences

### What becomes easier

- "Every committed change has an event" is true by construction rather than by review.
- A gapless sequence is an integrity property a recipient can verify without the vendor,
  which strengthens every evidence pack.
- External consumers are a cursor and a query, with no delivery-guarantee machinery.
- Regenerating an evidence pack yields the same chronology (INV-EVD-006), because ordering
  does not depend on when the query ran.

### What becomes harder

- **Governed writes serialise per tenant.** The deliberate cost of gaplessness. It needs
  measuring under bulk import specifically, which is the one workload that could feel it.
- **The sequence row is a hot row** for a busy tenant, with the attendant vacuum
  considerations.
- **Adding an event type is a real change**: a schema, a version, a place in the registry,
  and a test. That friction is the point — the catalogue is a contract.
- **Retention disposal needs a second role**, which the migration and privilege surface
  must set up and CI must validate.

### What we have committed to maintaining

- One emission path, and an architecture test that keeps it the only one.
- The schema registry, including every historical version, forever.
- `REVOKE` on the application role, and the separate retention role as the only thing that
  can dispose.

### Cost of reversing this

Moderate. Switching to a `bigserial` would be trivial mechanically and would silently
break the ordering guarantee that evidence determinism rests on, so it is precisely the
change to be suspicious of later. Adding hash-chaining on top is additive and can be done
whenever it is worth claiming.

## To verify at repository bootstrap

- Lock contention on `tenant_event_sequence` under a realistic bulk import, measured
  rather than assumed. If it is a problem, the fallback is a per-tenant batch allocation —
  which reintroduces gaps and would need recording as a weakening of INV-AUD-009.
- Whether Neon permits `REVOKE … TRUNCATE` and a second role for retention.
- `jsonb` size limits and whether a `CHECK` on `pg_column_size` behaves as expected with
  TOAST.
- Vacuum behaviour on the sequence table under sustained single-row updates.
