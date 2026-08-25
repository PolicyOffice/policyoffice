# ADR-0000: Stack selection

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

Phase 0 produced a complete specification with 145 registered invariants and an
**enforcement ladder** that prefers structural and database-level guarantees over
application code, and application code over tests. That ladder is not decoration — it is
the reason this product can claim to be a system of record — and it constrains the stack
more than any performance or preference argument does.

Four things were already fixed before this ADR:

| Constraint | Source |
|---|---|
| One EU region, complete — application data, object storage, backups, search, audit, evidence packs, queues, DR replicas, observability | Open decision 7, 2026-08-24 |
| File-centric content: the uploaded controlled file is the governed artefact | Open decision 2, 2026-08-24 |
| Free tier only; anything costing money is a Decision Request | `docs/engineering/agent-workflow.md`, budget posture |
| No AI in any domain operation or in the required-check path | `AGENTS.md` rules 6 and the CI gate list |

Two more were settled while writing this ADR: **TypeScript end to end**, because the
founder reviews every pull request an agent writes and their own fluency dominates any
technical argument; and **a public repository**, which the CI gate list already assumed
for unlimited Actions minutes.

What remains is choosing a stack that lets the enforcement ladder actually be climbed. The
decisive question throughout is not *what is pleasant to write* but **what can express a
composite foreign key including `tenant_id`, an exclusion constraint over an effective
interval, a revoked `UPDATE` privilege, and a transactional outbox — without fighting the
tooling.**

## Decision

A **modular monolith in TypeScript on Node.js**, backed by a single PostgreSQL database,
deployed as one application process plus one worker process.

| Layer | Choice | The invariant or constraint that decided it |
|---|---|---|
| Language | TypeScript, `strict` | Founder review fluency. Capabilities and states are modelled as discriminated unions, not strings — enforcement level 3 (INV-AUTH-016) |
| Runtime | Node.js LTS | Boring, and the dependency-provenance story a security reviewer expects. Not Bun or Deno — this product's differentiator is trustworthiness, and the runtime is the wrong place to spend novelty budget |
| Shape | Modular monolith, one repository, one deployable plus a worker | INV-AUTH-001 requires *one* authorization evaluator with no second path around it. Service boundaries invite a second path |
| Web | Next.js (App Router) for the reader and governance surfaces | One framework for both experiences in `information-architecture.md`, server-rendered by default, and no separate API deployment to secure |
| Domain | A framework-free package the web and worker both depend on | The domain must not import Next.js. If it does, the single enforcement point becomes a request-scoped one, and background jobs get their own copy of the rules (INV-TEN-004) |
| Database | PostgreSQL, single instance, Neon free tier in an EU region | The only mainstream database that gives every mechanism the ladder names. Detail below |
| Schema and access | Drizzle for schema and typed queries; hand-written SQL migrations | Migrations must express triggers, privileges, exclusion constraints and composite keys. A migration tool that abstracts DDL away is disqualifying |
| Jobs and scheduling | Postgres-backed queue in the same database | INV-AUD-004 requires the event and the state change to commit together or via an outbox. A queue in the same transaction gives that for free |
| Search | PostgreSQL full-text | INV-AUTH-011 enforces authorization at retrieval regardless, so a separate index buys latency and a second disclosure surface. Also: no second system to keep inside the EU commitment |
| Object storage | S3-compatible, EU jurisdiction | Controlled files and evidence packs. Content is file-centric, so this holds the governed bytes |
| Tests | Vitest, Playwright, `fast-check` for property-based | The CI gate list already names integration tests against real Postgres, a Playwright critical suite, and property-based applicability tests (INV-APL-001) |

### Why PostgreSQL specifically

Every row of the enforcement ladder's illustrative targets in `invariants.md` maps to a
Postgres mechanism:

| Invariant | Target level | Mechanism |
|---|---:|---|
| INV-TEN-003 no cross-tenant reference | 1 | Composite foreign keys including `tenant_id`, enforced by unique constraints on `(tenant_id, id)` |
| INV-EFF-002 one effective version per scope | 2 | `EXCLUDE USING gist` over the scope key and the effective `tstzrange`, via `btree_gist` |
| INV-VER-003 released content immutable | 2 | A trigger refusing `UPDATE` on released rows |
| INV-AUD-002 audit append-only | 2 | `REVOKE UPDATE, DELETE` from the application role |
| INV-TIME-003 optimistic concurrency | 2 | A version column with a conflict-raising update |
| INV-TIME-005 half-open intervals | 3 + 2 | `tstzrange` with `[)` bounds, so overlap is a type-level property |

INV-EFF-002 is the one that ends the discussion. *"At most one version is effective for a
given document, variant scope and instant"* is a range-overlap constraint. Expressed as an
exclusion constraint it is a rule the application **cannot** break; expressed anywhere
else it is a rule the application is checked against afterwards, and a race defeats it. No
document database and no ORM-level validation offers an equivalent.

### Why the schema layer is Drizzle plus raw SQL

The migration tool has to be able to say things most of them abstract away: `EXCLUDE USING
gist`, `CREATE TRIGGER`, `REVOKE UPDATE ON audit_event FROM app_role`, partial unique
indexes, and composite foreign keys carrying `tenant_id`.

Drizzle generates SQL migration files that are then edited and committed as SQL, which
means the DDL is reviewable in the diff and CI's fresh-install and upgrade tests run the
real statements. A declarative-schema tool that owns migration generation, and treats
anything it cannot model as an escape hatch, inverts that relationship: the constraints
that carry the guarantees become the exceptional case.

This is a deliberate trade of developer convenience for enforcement strength, and it is
the same trade the enforcement ladder makes.

### Why jobs live in Postgres

Effectivity transitions, reminders, escalations, campaign enrolment, retention disposal
and evidence generation all need scheduling. The obvious answer from the research was a
dedicated workflow engine.

A Postgres-backed queue wins here for a reason that is not cost:

> **INV-AUD-004 — An event is emitted in the same transaction as the state change it
> records, or via an outbox guaranteeing eventual emission.**

When the queue is a table in the same database, enqueueing a job and committing the state
change it describes are one transaction. With an external engine they are two systems and
a distributed-commit problem, which is how *"a committed change with no event"* — an
unprovable change — gets into production.

INV-EFF-007 makes the same argument: a scheduler firing twice must produce exactly one
`version.effective`. Transactional dequeue plus an idempotency key in the same database is
a solved problem. Across a queue boundary it is a design exercise.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Go or Kotlin backend** | Both are better languages for this domain in isolation. Neither survives the constraint that the founder reviews every agent-written pull request, and a second language doubles the review surface for one person |
| **Separate API service and SPA** | A second deployable is a second place authorization can be answered. INV-AUTH-010 requires API and UI authorization to be identical; the cheapest way to guarantee that is for them to be the same code in the same process |
| **Microservices** | No scaling problem exists, and every service boundary is a new opportunity to lose tenant scoping below the presentation layer (INV-TEN-004) |
| **Prisma** | The migration model does not comfortably express exclusion constraints, triggers, privilege revocation or composite foreign keys carrying `tenant_id`. Those are not edge cases here; they are where the guarantees live |
| **MySQL, or a document database** | No exclusion constraints, therefore no structural enforcement of INV-EFF-002. Everything the ladder wants at level 2 drops to level 5 |
| **Temporal or a dedicated workflow engine** | Splits the transaction that INV-AUD-004 requires, adds a second system inside the EU residency commitment, and costs money on any realistic plan |
| **OpenSearch or Elasticsearch** | A second store to keep in-region, a second disclosure surface for INV-AUTH-011 and INV-AUTH-012, and unnecessary until a customer's estate is large enough to need it. The research's own warning about picking search infrastructure for résumé reasons applies |
| **Bun or Deno** | Faster and pleasant. The wrong place to spend novelty for a product whose entire proposition is that it can be trusted |
| **Event sourcing the domain** | Tempting given the audit ledger, and it would make history free. It also makes every authorization query a projection, puts point-in-time reconstruction on the read path, and is a large bet to place before a single customer exists. The audit ledger already carries the history the product sells |

## Consequences

### What becomes easier

- Most invariants become structurally or database-enforced rather than remembered, which
  is exactly what makes an agent-implemented codebase safe to review.
- One deployable, one database, one language: a solo founder can hold it in their head,
  and a security reviewer can be told the whole architecture in a paragraph.
- Everything stays inside the free tier and inside one EU region, so the residency
  commitment is a short and checkable statement.
- Playwright, Vitest and property-based tests all run against the real application in CI
  with a Postgres service container, with no infrastructure.

### What becomes harder

- **Scaling is deferred, not solved.** A modular monolith scales vertically for a long
  time and this product has no scale problem, but the day it does, the boundaries have to
  be found rather than declared.
- **Postgres full-text is weaker than a dedicated engine** for stemming, ranking and
  multilingual content. Multilingual is a Commercial V1 concern (translations), and this
  should be revisited then rather than pre-solved now.
- **Hand-written SQL migrations are more work** and easier to get wrong than generated
  ones. Mitigated by the CI gate that validates every migration on a fresh database *and*
  as an upgrade.
- **TypeScript's type system cannot express what the domain deserves.** No exhaustive
  totality checking, no refinement types, and `any` is always one careless line away.
  Mitigated by `strict`, by pushing guarantees into the database, and by a lint rule that
  bans `any` in the domain package.

### What we have committed to maintaining

- A domain package that never imports the web framework. This will be under constant
  pressure and is the single most important architectural boundary in the repository.
- Hand-written DDL for every constraint that carries an invariant, with the invariant ID
  in a SQL comment so the link is visible where the enforcement lives.
- One authorization evaluator, called by every surface, with no exceptions.

### Cost of reversing this

| Reversal | Cost |
|---|---|
| Language | Total rewrite. Effectively irreversible |
| Modular monolith → services | Moderate and deliberate: extract along existing module boundaries. This is the normal path and the shape is chosen to permit it |
| Drizzle → another schema layer | Low. The migrations are SQL, and SQL survives the tool |
| Postgres → anything else | Effectively irreversible. Every level-1 and level-2 enforcement is Postgres-specific, by design |
| Postgres FTS → a search engine | Low. Search is behind an interface and authorization is enforced at retrieval regardless |
| Postgres queue → a workflow engine | Moderate, and it would mean accepting the INV-AUD-004 problem this decision avoids |

## Deferred to later ADRs

This ADR selects the stack. It does not design the system.

| ADR | Question |
|---|---|
| Tenancy enforcement | Composite keys alone, or also row-level security? Which role the application connects as |
| Content storage and canonicalisation | Bucket layout, the canonical manifest's serialisation, digest algorithm, text extraction for comparison |
| Audit outbox | Table design, delivery, ordering guarantees for INV-AUD-009 |
| Identity and sessions | Local accounts for the Pilot; OIDC, SAML and SCIM for V1 |
| Authorization evaluator | Its interface, caching bounded by INV-AUTH-003, and how every surface is made to call it |
| Effectivity and supersession | The exclusion constraint's exact scope key, and the supersession transaction |
| Evidence pack generation | Assembly, determinism for INV-EVD-006, streaming, storage and expiry |
| Migrations and environments | Neon branching, seeding, fresh-versus-upgrade validation |
| Observability | What is recorded, kept in-region, and kept out of the evidence ledger per INV-AUD-007 |

## To verify at repository bootstrap

Recorded rather than assumed, because this ADR was written from a specification rather
than from a running system, and some of it depends on current vendor behaviour:

- ~~Neon free tier: EU region availability, `btree_gist`, whether `REVOKE` on the
  application role is permitted, and connection-pooling behaviour under a transactional
  job queue.~~ **Verified 2026-08-25** by `verification/06-neon.sh`: `eu-central-1`,
  `btree_gist` 1.8, `REVOKE UPDATE/DELETE/TRUNCATE` all effective against the application
  role, and `SET LOCAL` scoped correctly through the pooler. Two findings changed other
  ADRs — see `ADR-0001` and `ADR-0009`. Pooling behaviour under a transactional job queue
  is not yet exercised, because there is no queue.
- The residency commitment against every provider in the budget posture — object storage,
  error tracking and transactional email each need an EU-jurisdiction option, or a
  Decision Request.
- Drizzle's current migration workflow, specifically that hand-edited SQL survives
  regeneration.
- Whether the chosen Postgres job queue supports transactional enqueue and idempotent
  dequeue as required by INV-EFF-007 and INV-AUD-004.

Any of these failing is a Decision Request, not a quiet substitution.
