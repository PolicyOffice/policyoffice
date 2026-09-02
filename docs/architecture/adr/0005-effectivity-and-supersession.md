# ADR-0005: Effectivity and supersession

- **Status:** Accepted — **amended 2026-08-25** after verification
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

> **Amendment.** Executing this ADR against PostgreSQL 17 found two errors in it, both in
> how a version stops claiming time. They are corrected below and marked **[corrected
> 2026-08-25]**; the reasoning that was wrong is kept rather than deleted, so the same
> mistake is not made again. Evidence: `verification/03-effectivity.sh`.

> **Amendment, 2026-08-25 — `STORED` is load-bearing on PostgreSQL 18.** The database
> moved from 17 to 18. PostgreSQL 18 added *virtual* generated columns and made `VIRTUAL`
> the **default** when neither keyword is written. A virtual column cannot be indexed, and
> `EXCLUDE USING gist` requires an index — so a declaration that omits `STORED` produces a
> table that is created successfully and an exclusion constraint that cannot be added.
>
> On 17 the same DDL was a syntax error, so this could not happen. The `stored` in the
> declaration below is therefore no longer a stylistic choice; it is what keeps INV-EFF-002
> at enforcement level 2. Asserted by `verification/01-extensions-and-types.sql`.

## Context

This is the invariant that selected the database.

> **INV-EFF-002 — For a given Document, variant scope and instant, at most one Version is
> Effective.**  *"The system must always have exactly one answer to what applies."*

`ADR-0000` committed to enforcing it with a Postgres exclusion constraint. This ADR
decides the constraint's exact shape, which turns out to require answering a question the
specification leaves to architecture: **from what moment does a version claim its
interval?**

Three further invariants ride along:

> **INV-EFF-003 — Supersession is atomic.** A gap and an overlap are both governance
> failures.  **INV-EFF-006 — Effectivity is derived from applicability and dated
> intervals, never from a mutable `is_current` flag.**  **INV-EFF-007 — A scheduler firing
> twice produces exactly one `version.effective` event.**

## Decision

### The interval is claimed at publication, not at effectivity

A version's normative interval is recorded when it is **published**, not when it becomes
effective.

The alternative — populate the interval at the effective instant — is the obvious reading,
and it defers every conflict to the moment it does the most damage. Publish v4 effective 1
October and v5 effective 1 October, and nothing complains until the scheduler runs, at
which point one transition fails in a background job at midnight.

Claiming at publication means the second publication is refused by the database, with the
collision named, while a human is looking at the screen. INV-EFF-002 is stated in terms of
instants, and a future instant is still an instant.

Publishing a successor also closes its predecessor's interval prospectively: publishing v5
effective 1 November sets v4's `effective_until` to 1 November in the same transaction.
The schedule is therefore always coherent, not merely eventually coherent.

### The constraint

```sql
create table document_version (
  tenant_id           uuid not null,
  id                  uuid not null default gen_random_uuid(),
  document_variant_id uuid not null,
  lifecycle_state     text not null,
  effective_from      timestamptz,
  effective_until     timestamptz,

  -- half-open [from, until): no instant belongs to two consecutive intervals — INV-TIME-005
  withdrawn_at        timestamptz,

  -- [corrected 2026-08-25] tstzrange(null, null) is (,) — UNBOUNDED, not null,
  -- and it overlaps everything. Without this CASE a pre-release version would
  -- claim all of time and block every other version of its variant.
  effective_range     tstzrange generated always as (
                        case when effective_from is null then null
                             else tstzrange(effective_from, effective_until, '[)')
                        end) stored,   -- STORED is required: see the 2026-08-25 amendment

  primary key (tenant_id, id),
  foreign key (tenant_id, document_variant_id)
    references document_variant (tenant_id, id),

  -- INV-EFF-002: at most one version of a variant claims any instant.
  -- Pre-release versions have no effective_from, so their range is null and the
  -- partial index skips them. Withdrawal closes the interval; it does not null it.
  constraint one_effective_version_per_variant
    exclude using gist (
      tenant_id           with =,
      document_variant_id with =,
      effective_range     with &&
    ) where (effective_range is not null)
);
```

Requires `btree_gist` for the equality operators on `uuid` alongside the range overlap
operator.

Three details carry weight:

**The scope key is the variant, not the document.** Deliberate, and it is what
`multi-entity-model.md` requires. A group baseline and a Polish replacement are two
variants of one document, and both are legitimately effective at the same instant for
different populations. Keying the constraint on the document would forbid the product's
central cross-border capability.

**`where (effective_range is not null)`** keeps versions that claim no time out of the
constraint — those still in a pre-release state, and those cancelled before ever taking
effect. Both have no `effective_from`, so the `case` above yields null and the partial
index skips them.

**[corrected 2026-08-25] Withdrawal closes the interval. It does not null it.**

The first version of this ADR said withdrawal nulls the range, on the reasoning that a
withdrawn version "was never normative for the remainder of its claimed interval and
should not appear to have been". That reasoning is wrong in a way worth keeping visible,
because it is superficially attractive.

A withdrawn version *was* normative — from its effective instant until the moment it was
withdrawn. People were governed by it, attestations were recorded against it, and evidence
packs must be able to say so. Nulling its range would erase exactly that, and break the
point-in-time reconstruction INV-EVD-007 and INV-APL-009 depend on.

So withdrawal sets `effective_until = withdrawn_at`. The version keeps claiming the period
it actually governed, stops claiming anything afterwards, and the vacated time is visible
— which is what lets INV-EFF-005 detect that a withdrawal left no effective version and
emit `governance.policy_gap`.

**`effective_range` is generated, not maintained.** Application code sets `effective_from`
and `effective_until`; the range cannot drift from them.

### What this constraint does *not* enforce

Being explicit, because the gap is where a reader might assume more safety than exists.

INV-APL-003 — *two replacements of equal specificity claiming the same scope and interval
block publication* — is **not** expressible here. Applicability is a set of entity,
org-unit and jurisdiction predicates, and "these two applicability rules overlap" is a
set-intersection question, not a range-overlap one.

So it drops to level 4: a publication-time check in the one publication transaction, and
the fail-closed reader path of INV-APL-004 as the backstop. That is a weaker guarantee
than INV-EFF-002 gets, and `invariants.md` already anticipates it — INV-APL-001 is
targeted at level 5 with property-based tests for exactly this reason.

### Supersession happens at publication. The scheduler only narrates it.

This follows from claiming the interval at publication, and it is the part of this ADR
most worth understanding, because the obvious design has a hole in it.

> **INV-EFF-006 — Effectivity is derived from applicability and dated intervals, never
> from a mutable `is_current` flag.**

A `lifecycle_state = 'EFFECTIVE'` column that resolution filters on **is** a mutable flag,
whatever it is called. If resolution required it, a scheduler running ten minutes late on
1 November would produce ten minutes in which no version resolves — a policy gap
manufactured by a background job being slow. That is precisely the failure INV-EFF-006
exists to prevent.

So the two moments are separated.

**At publication — one transaction, and where atomicity lives:**

```text
1. Lock the variant row (select … for update) — one serialisation point per variant
2. Set the successor's effective_from, and its effective_until where a later
   version already claims an instant
3. Close the predecessor's interval: effective_until = successor's effective_from
4. The exclusion constraint accepts or rejects the whole thing
5. Insert version.published into the ledger, in this transaction — INV-AUD-004
6. Commit
```

After this commits the schedule is coherent for all time: no gap, no overlap, nothing left
for a job to get right. **INV-EFF-003's atomicity is satisfied here**, not at midnight.

> **[corrected 2026-09-02]** Both sequences above said *"enqueue … on the outbox"*. There
> is no outbox. `ADR-0006` decides that the ledger is written in the same transaction and
> that no second table exists, and `data-model.md` defines none. The wording was loose
> rather than a different decision — INV-AUD-004 offers same-transaction emission *or* an
> outbox, and this architecture has always taken the first branch, which is the stronger of
> the two. It is corrected here because the loose reading already cost a Decision Request
> (#47) against POL-007, and four document-spine tickets cite these sequences.

**At the effective instant — bookkeeping and audit:**

```text
1. Lock the variant row
2. Re-read authoritative state
      withdrawn or cancelled?  → no-op, commit                   — INV-EFF-008
      already transitioned?    → no-op, commit                   — INV-EFF-007
3. lifecycle_state: predecessor → SUPERSEDED, successor → EFFECTIVE
4. Insert version.superseded and version.effective into the ledger — INV-AUD-004
5. If the variant now has no version holding the instant, insert
   governance.policy_gap                                          — INV-EFF-005
6. Commit
```

Nothing in step 3 confers normativity. It records the governance narrative that
`document-lifecycle.md` describes, drives the register, and gives the audit ledger its
events. If this job never ran, the right text would still resolve — the register would
simply be describing it wrongly, which is a visible defect rather than a silent one.

**Locking the variant rather than the version**, in both cases: two rows change, a third
party may be publishing concurrently, and the common parent is the natural serialisation
point. Variants are independent, so contention stays local.

The state re-read in step 2 is what makes the job idempotent, which is what lets the
scheduler be at-least-once (INV-EFF-007) and closes the withdrawal race (INV-EFF-008). It
reads authoritative state — never the job payload, which is a snapshot of what was true
when the job was enqueued, and withdrawal happens after that.

### Resolving "what is effective now"

The range decides. Never the state column (INV-EFF-006):

```sql
select * from document_version
 where tenant_id = current_setting('app.tenant_id')::uuid
   and document_variant_id = $1
   and effective_range @> $2::timestamptz
   and lifecycle_state not in ('WITHDRAWN', 'CANCELLED');
```

Withdrawal closes the range at the withdrawal instant, so the state predicate is
belt-and-braces rather than the mechanism — but it is cheap, and it means a bug that
failed to close an interval still cannot resurrect a withdrawn version for time it no
longer governs (INV-EFF-004).

A GiST index on `(tenant_id, document_variant_id, effective_range)` — the one the
exclusion constraint creates — serves both the constraint and this query.

Historical resolution is the identical query with a different instant, which is the
property INV-EVD-007 and INV-APL-009 depend on. Point-in-time reconstruction is not a
separate code path; it is this one with `$2` set to something other than `now()`.


## Alternatives considered

| Alternative | Why not |
|---|---|
| **An `is_current` boolean** | Forbidden by INV-EFF-006. It drifts, it cannot answer historical questions, and keeping it consistent needs the same transaction as the range — with none of the guarantees |
| **Interval claimed at the effective instant** | Defers conflict detection to a background job at midnight, instead of to the person publishing |
| **Constraint keyed on the document** | Would forbid a baseline and a regional replacement being effective simultaneously, which is the product's cross-border capability |
| **Application-level "check then write"** | A race between the check and the write is exactly what an exclusion constraint exists to remove |
| **Closing the predecessor in a separate transaction** | Produces an observable gap or overlap. Both are governance failures under INV-EFF-003 |
| **Resolution filtered on `lifecycle_state = 'EFFECTIVE'`** | The first draft of this ADR did exactly that. A scheduler running late would then manufacture a policy gap out of nothing, which makes the state column a mutable current-flag by another name — forbidden by INV-EFF-006 |
| **Advisory locks instead of a row lock** | Works, and puts the serialisation key somewhere a reader of the schema will not find it |
| **Trusting the job payload for the state check** | The payload describes what was true when the job was enqueued. Withdrawal happens after that |

## Consequences

### What becomes easier

- A scheduling conflict is a database error at publication with the colliding version
  named, rather than a support ticket in November.
- Historical resolution is the present-tense query with a different parameter.
- The scheduler can be at-least-once, which is the only kind of scheduler that actually
  exists.

### What becomes harder

- **`btree_gist` becomes a hard dependency**, and it must be available on the deployment
  target. On the verification list.
- **Every publication takes a lock on the variant**, serialising concurrent publications
  for that variant. Correct, and a slower path than an unguarded insert.
- **Withdrawal has to null the range rather than close it**, which reads oddly until the
  reason is known — hence the comment carrying the invariant ID in the DDL.
- **The error surfaced by a constraint violation is a database error**, and translating it
  into *"v5 already claims 1 November for this variant"* is real work in the publication
  path.
- **The state column can lag the range** when the effectivity job is late or fails. That
  is by design — the right text still resolves — but the register and the resolver can
  briefly disagree, so monitoring must treat a stale transition as an alert rather than as
  an inconsistency to repair by hand.

### What we have committed to maintaining

- The DDL comment naming INV-EFF-002 above the constraint, so the reason survives a
  refactor.
- The idempotency check inside the transaction and against authoritative state, in every
  job that transitions effectivity.
- No `is_current` column, ever, in any table or materialised view.

### Cost of reversing this

High, and deliberately so. The constraint is the enforcement of the invariant that
distinguishes this product from a document library. Reversing it means accepting that
"what applies now" is a rule the application is checked against rather than one it cannot
break.

## Verified

Against PostgreSQL 18.6, by `verification/03-effectivity.sh`:

| Claim | Result |
|---|---|
| `btree_gist` available | Yes, 1.7 |
| Exclusion constraint over `uuid =` and `tstzrange &&` | Refuses an overlapping interval, by constraint name |
| Under a concurrent race | The second transaction blocks on the first, then is refused on commit. Exactly one survives |
| `SQLSTATE` | `23P01`, so publication returns a governance error rather than a 500 |
| Keyed on the variant | A second variant may claim the same instants — baseline-plus-replacement is preserved |
| Half-open `[)` | A successor may start at the instant its predecessor ends |
| Generated `tstzrange` column | Supported, and not writable, so the range cannot drift from its timestamps |
| Withdrawal closing the interval | Historical resolution still finds the version for the period it governed, and nothing after |

### Still to verify on the hosting platform

- `btree_gist` creatable on Neon, and by which role.
- Planner behaviour for `@>` on the GiST index under ADR-0001's row-level security policy,
  measured rather than assumed.
