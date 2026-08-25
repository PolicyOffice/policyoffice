# ADR-0001: Tenancy enforcement

- **Status:** Accepted — **amended 2026-08-25** after verification
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

> **Amendment.** Verification found this ADR's claim about `FORCE ROW LEVEL SECURITY` to
> be true but incomplete, in a way that would have hollowed out the protection. Corrected
> below and marked **[corrected 2026-08-25]**. Evidence: `verification/02-tenancy.sh`.

## Context

> **INV-TEN-001 — No query, job, export, webhook or search path returns data from a tenant
> other than the authenticated principal's.**  *"The single most severe possible defect in
> a multi-tenant compliance product."*

Five invariants govern tenancy, and they are not all the same shape. Two of them are worth
separating carefully, because they fail differently and a single mechanism does not catch
both:

| Failure | Invariant | What it looks like |
|---|---|---|
| A record **points at** another tenant's record | INV-TEN-003 | A campaign in tenant A referencing a document version in tenant B. Corrupt data, permanently |
| A **query returns** another tenant's rows | INV-TEN-001 | A developer or an agent forgets a `WHERE tenant_id = …`. Correct data, disclosed |

The first is a data-integrity problem and can be made structurally impossible. The second
is a code-discipline problem, and in a repository where most code is written by agents,
"remember the predicate" is not a control.

`ADR-0000` chose PostgreSQL partly because it can address both.

## Decision

**Both mechanisms, at different levels of the enforcement ladder.**

### 1. Composite keys — structural, level 1

Every tenant-owned table carries `tenant_id`, and every foreign key between tenant-owned
tables is composite:

```sql
create table document (
  tenant_id  uuid not null references tenant(id),
  id         uuid not null default gen_random_uuid(),
  -- INV-TEN-003: the composite primary key is what makes a
  -- cross-tenant foreign key unrepresentable, not just invalid
  primary key (tenant_id, id),
  document_type_id uuid not null,
  owning_org_unit_id uuid not null,
  foreign key (tenant_id, document_type_id)   references document_type(tenant_id, id),
  foreign key (tenant_id, owning_org_unit_id) references org_unit(tenant_id, id)
);
```

A child row cannot reference a parent in another tenant, because the reference carries the
tenant and the parent's key includes it. There is no code path, migration or manual
`INSERT` that produces a cross-tenant reference — the state is not representable.

`id` remains globally unique in practice (a UUID) so that identifiers can appear in URLs
and events without a tenant prefix. The uniqueness that the database *enforces* is on
`(tenant_id, id)`.

### 2. Row-level security — level 2

Every tenant-owned table has RLS enabled and **forced**, with a policy comparing
`tenant_id` against a transaction-scoped setting:

```sql
alter table document enable row level security;
alter table document force  row level security;   -- the owner is not exempt

create policy tenant_isolation on document
  using (tenant_id = current_setting('app.tenant_id')::uuid);
```

**[corrected 2026-08-25] `FORCE` binds the owner. It does not bind a superuser.**

The original wording — "owners are not exempt" — is true and insufficient. `FORCE`
subjects the *table owner* to its own policies, but a **superuser bypasses row-level
security entirely**, and no setting on the table changes that. The first run of the
verification failed on exactly this: the owner was `postgres`, and it saw every tenant's
rows.

Two consequences, and both are load-bearing:

**The migration role must not be a superuser.** It owns every table, so if it holds
superuser rights then `FORCE` protects nothing against the one role that touches
everything. `ADR-0009`'s three roles are all created `nosuperuser nobypassrls` for this
reason.

**Integration tests must never connect as a superuser.** This is the more dangerous one. A
cross-tenant negative test run as `postgres` passes — it sees the other tenant's row and
asserts nothing about isolation, because RLS was never consulted. Row 4 of the definition
of done would be satisfied on paper by a test that proves nothing at all. The test harness
connects as `app_role`, and that is not a preference.

The application sets that value **inside each transaction**:

```sql
set local app.tenant_id = $1;
```

`SET LOCAL` rather than `SET`, because connection poolers hand the same physical
connection to unrelated work. A transaction-scoped setting cannot leak into the next
request; a session-scoped one can, and that failure mode is silent, intermittent and
catastrophic.

The application connects as a **non-owner role** with `FORCE ROW LEVEL SECURITY` in effect
and `UPDATE`/`DELETE` revoked on append-only tables (INV-AUD-002). Migrations run as a
separate, more privileged role, only in CI and deployment.

### 3. One place that opens transactions

RLS only helps if `app.tenant_id` is always set. So there is exactly one function that
starts a database transaction, it requires a tenant context argument, and it issues the
`SET LOCAL` before yielding. Nothing else in the repository opens a transaction or holds a
raw connection — enforced by an architecture test, not by convention.

A background job or an export therefore cannot run without a tenant context, which is what
INV-TEN-004 asks for: *tenant scoping enforced below the presentation layer, so background
jobs and APIs inherit it.*

### 4. Not-found, not forbidden

The data layer returns "no rows" for a cross-tenant identifier, because RLS filtered it.
The application maps that to a not-found response with the same shape and comparable
timing as a genuinely absent record (INV-TEN-002, INV-TEN-005). There is deliberately no
code path that can distinguish *exists in another tenant* from *does not exist*, because a
code path that can distinguish them is a code path that can leak.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Composite keys only** | Prevents corrupt references but not a forgotten predicate. In a codebase written largely by agents, the forgotten predicate is the likelier failure |
| **RLS only** | Prevents disclosure but permits a cross-tenant foreign key to be written. Data integrity is not a subset of read isolation |
| **A repository layer that always adds `WHERE tenant_id`** | This exists anyway, but as the *only* mechanism it is level 4 — one missed method and it is gone, with nothing underneath |
| **Schema per tenant** | Strong isolation, and every migration multiplies by the tenant count. On a free-tier Postgres this stops working at a few dozen tenants, and it makes cross-tenant administrative queries — which support genuinely needs — awkward rather than merely restricted |
| **Database per tenant** | The strongest isolation and the wrong economics for a product priced per managed user. Revisit only if a customer contractually requires physical separation, which would be a Decision Request |
| **Session-scoped `SET` instead of `SET LOCAL`** | Leaks across pooled connections. The bug appears under load, in production, intermittently |
| **Tenant in the JWT, trusted by the database** | Moves the boundary into a token the application mints. `SET LOCAL` from a server-side session is one fewer thing to forge |

## Consequences

### What becomes easier

- A forgotten `WHERE tenant_id` returns nothing instead of returning someone else's data.
  The failure mode becomes a visible bug rather than a silent breach.
- The cross-tenant negative test the definition of done requires (row 4) has something
  real to assert against at two levels.
- Support and administrative tooling can be given a deliberately different role, rather
  than relying on everyone remembering which queries are the dangerous ones.

### What becomes harder

- **Every query pays a policy check.** Small, but real. Indexes must lead with `tenant_id`
  so the planner can use them under the policy predicate.
- **Connection handling gets stricter.** No ambient connections, no raw pool access, no
  `SELECT` outside the one transaction helper. This will feel obstructive during
  development and is exactly the point.
- **Migrations need two roles**, and the privilege grants become part of the migration
  surface that CI must validate on a fresh database.
- **Debugging is less direct**: a `psql` session as the app role sees nothing until it
  sets `app.tenant_id`, which surprises people once.

### What we have committed to maintaining

- Composite foreign keys on every tenant-owned relationship, forever. The first plain
  `references other_table(id)` is a hole.
- One transaction helper, with no second path to a connection.
- The invariant ID in a SQL comment above each policy and each composite key, so the
  reason survives contact with a future refactor.

### Cost of reversing this

Low for RLS — the policies can be dropped and the repository layer still filters. Very
high for composite keys, because every key and every reference in the schema would change.

## Verified

Against PostgreSQL 18.6, by `verification/02-tenancy.sh`:

| Claim | Result |
|---|---|
| Composite keys refuse a cross-tenant reference | Foreign-key violation, structurally (level 1) |
| The application role sees only its own tenant | One row, from a table holding two tenants' |
| A cross-tenant identifier | Returns zero rows, not an error — not-found, per INV-TEN-002 |
| A query with no `WHERE` clause | Still returns only the current tenant. The forgotten predicate is survivable |
| No tenant context set at all | The query errors rather than returning rows — fails closed |
| `SET LOCAL` | Scoped to its transaction; the next statement has no context, so a pooled connection cannot inherit one |
| `FORCE` with a non-superuser owner | The policy applies to the owner |
| `FORCE` with a superuser | **Bypassed.** See the correction above |

### Still to verify on the hosting platform

- Neon: whether a non-owner role can be created and used by the application, and whether
  `FORCE ROW LEVEL SECURITY` applies there. There is no fallback at the same enforcement
  level, so a "no" is a Decision Request.
- Neon's pooler: `SET LOCAL` semantics under transaction pooling, and that the driver does
  not reuse a connection mid-transaction.
- Drizzle: that the query builder can be driven entirely through a caller-supplied
  transaction handle, so the one-transaction-helper rule is enforceable.
- Planner behaviour with RLS on a table with a composite primary key, measured rather than
  assumed.

Any of these failing is a Decision Request. The fallback — composite keys plus a
repository layer, with RLS dropped — is a level weaker and must be recorded as such
against INV-TEN-001.
