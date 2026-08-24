# ADR-0009: Migrations and environments

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Founder, Claude Code

## Context

`ADR-0000` chose hand-written SQL migrations because the DDL carries the guarantees:
exclusion constraints, triggers, revoked privileges, composite foreign keys including
`tenant_id`. The preceding ADRs have since added specific requirements — three database
roles, `btree_gist`, a generated range column, a per-tenant sequence table.

The CI gate list already commits to the hard part:

```text
→ integration tests (real Postgres service container)
→ migration validation: fresh install AND upgrade
```

This ADR decides how migrations are written and what each environment actually is.

## Decision

### Forward-only, immutable once merged

Migrations are numbered SQL files, applied in order, recorded in a ledger table. A
migration that has been merged is never edited — a correction is a new migration.

**There are no down migrations.** Not "we rarely write them": they do not exist.

A down migration is a data-loss tool pointed at an evidence ledger. On a system whose
whole proposition is that released content is immutable and history cannot be rewritten,
keeping a scripted path that drops columns and tables is a contradiction sitting in the
repository. Recovery from a bad migration is a forward migration, or a restore from backup
— both of which are honest about what is happening.

Destructive change uses **expand and contract**:

```text
1. expand    add the new structure, nullable, alongside the old
2. backfill  in batches, idempotently, as a job
3. dual-write / switch reads
4. contract  a later release drops the old structure
```

Contract is a separate migration in a later release, so a rollback of the release that
switched reads never lands on a schema that has already lost its old column.

### Three roles, established by migration

`ADR-0001`, `ADR-0006` and the retention model each need a different privilege set, so the
roles and their grants are part of the schema and are validated by CI like anything else.

| Role | May | May not |
|---|---|---|
| `migration_role` | DDL, grants, extensions. Owns the objects | Run in the application |
| `app_role` | `SELECT`/`INSERT` broadly, `UPDATE`/`DELETE` where the domain permits | `UPDATE`, `DELETE`, `TRUNCATE` on append-only tables (INV-AUD-002, INV-APR-007, INV-ATT-007). Bypass row-level security |
| `retention_role` | `DELETE` on records eligible for disposal | Read or write anything else. Run outside the disposal job |

`ALTER TABLE … FORCE ROW LEVEL SECURITY` is required, because the owner would otherwise be
exempt from its own policies (`ADR-0001`).

Extensions — `btree_gist` for `ADR-0005` — are created by `migration_role`, since the
application role will not have the privilege.

### Every constraint that carries an invariant says so

```sql
comment on constraint one_effective_version_per_variant on document_version is
  'INV-EFF-002: at most one version of a variant claims any instant';
```

The registry's chain is `spec section → INV-ID → test name → issue → PR → ADR`. This puts
the ID where the enforcement actually lives, so a future refactor that finds the
constraint inconvenient discovers what it is for before removing it.

### CI validates three things, not one

| Check | What it catches |
|---|---|
| **Fresh install** | The migration chain builds a correct schema from nothing — the new-customer path |
| **Upgrade** | Applying new migrations to the previous release's schema, with representative data — the existing-customer path |
| **Drift** | The schema built from migrations matches the Drizzle schema definition. Catches the model and the database disagreeing, which is otherwise found at runtime |

All three run against a **Postgres service container**, not against Neon. CI needs a
disposable database per run, and a container is faster, free and unmetered. Neon is where
the application is deployed; it is not the test substrate. Its platform-specific behaviour
— pooler semantics, permitted privileges, extension availability — is verified once at
bootstrap and then re-verified by a scheduled job, not on every pull request.

### Migrations must not lock the table

The rules, because "it worked on an empty database" is how this fails:

- add columns nullable, backfill in batches, then constrain
- `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction, so such migrations
  are marked non-transactional and run alone
- set a `lock_timeout` and a `statement_timeout` on the migration session, so a migration
  blocked behind a long query fails fast instead of queueing every request behind it
- validate constraints in two steps: `NOT VALID`, then `VALIDATE CONSTRAINT`

None of this matters at Pilot scale, and all of it is much harder to retrofit into a
migration habit than to start with.

### Environments

| Environment | What it is |
|---|---|
| **Local** | Docker Compose: Postgres, an S3-compatible store, and Mailpit for outbound email. Object storage is local too, so nothing developed against it is accidentally coupled to a provider |
| **CI** | Postgres service container per run. Playwright runs against the application booted inside the runner — no deployed environment, no infrastructure, no cost |
| **Preview** | Deliberately none. Recorded in `consolidation-notes.md`; revisit when there is a design partner to show |
| **Staging** | Later, and a known future cost |
| **Production** | Neon, one EU region, per decision 7 |

### Seeds are fixtures, not data

Three seed sets, all deterministic — fixed identifiers, fixed instants, no `random()`, no
`now()`:

| Seed | Purpose |
|---|---|
| **Reference** | Governance profiles, system roles, capability definitions. Applied by migration, since they are configuration the product ships |
| **Development** | A small, realistic tenant: a taxonomy, a governance body, a few documents at different lifecycle states |
| **Test** | Fixtures for Playwright and integration tests, including a second tenant that exists solely so cross-tenant negative tests have something real to fail against |

The second tenant is not an afterthought. Definition of done row 4 requires a cross-tenant
negative test on any data access, and a test asserting isolation against an empty database
asserts nothing.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Down migrations** | A scripted data-loss path aimed at an evidence ledger, in a product whose proposition is that history cannot be rewritten |
| **Declarative schema with generated migrations** | Rejected in `ADR-0000`. It makes the constraints that carry the guarantees the exceptional case |
| **Neon branches for CI** | Elegant, and it puts a network dependency and a free-tier quota in the path of every pull request. Containers are faster and unmetered |
| **One database role** | Then `REVOKE` cannot express append-only, and `FORCE ROW LEVEL SECURITY` has no non-owner to apply to. Two of the level-2 enforcements evaporate |
| **Seeds with random or current-time data** | Non-deterministic fixtures make failures irreproducible, which is worse than no fixtures |
| **Skipping the drift check** | The model and the database disagreeing is a silent failure that surfaces as a runtime error in whichever query happens to run first |

## Consequences

### What becomes easier

- Both customer paths — new install and upgrade — are proven on every pull request rather
  than discovered at release.
- The privilege model is code, reviewed in diffs and validated by CI, instead of a console
  setting nobody can audit.
- Local development needs one command and no accounts.

### What becomes harder

- **No rollback script.** Recovering from a bad migration means a forward fix or a
  restore, and the restore path has to be rehearsed rather than assumed. The nightly
  backup-restore drill in the CI schedule is that rehearsal.
- **Expand and contract is three releases** for a change that a rename would do in one.
- **Hand-written DDL is more work**, which is `ADR-0000`'s accepted trade.
- **CI's database differs from production's**: a container in tests, Neon in production.
  The scheduled verification job against a real Neon branch exists to keep that honest.

### What we have committed to maintaining

- Immutability of merged migrations.
- The invariant ID in a comment on every constraint that carries one.
- The second tenant in test seeds, forever.

### Cost of reversing this

Low for tooling. High for the no-down-migrations rule, because reintroducing it would mean
writing the reverse of every migration retroactively — and the reason not to is a product
argument rather than a technical one.

## To verify at repository bootstrap

- Which roles Neon permits creating, and whether `app_role` can be a non-owner with `FORCE
  ROW LEVEL SECURITY` in effect. `ADR-0001` depends on this and there is no fallback that
  preserves the same level.
- Whether `btree_gist` can be created on Neon and by which role.
- `CREATE INDEX CONCURRENTLY` through Neon's pooler, which typically requires a direct
  connection.
- Restore timing from a Neon backup, measured once, so the disaster-recovery claim in
  security documentation is a number rather than an assumption.
