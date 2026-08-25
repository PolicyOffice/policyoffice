# Platform verification

Every ADR in `docs/architecture/adr/` carries a *verify at repository bootstrap* list,
because the architecture was written from a specification rather than from a running
system. This directory is that verification: executable checks that the mechanisms the
enforcement ladder depends on actually behave as the ADRs claim.

```bash
docker compose up -d
./verification/run.sh
```

It is not a test suite for the application — there is no application yet. It is evidence
that the platform can support the guarantees, re-runnable when Postgres or the hosting
platform changes.

| Check | Verifies | ADR |
|---|---|---|
| `01-extensions-and-types.sql` | `btree_gist`, `gen_random_uuid`, half-open `tstzrange`, generated columns are not writable | 0000, 0005 |
| `02-tenancy.sh` | Composite keys refuse a cross-tenant reference; forced RLS survives a forgotten predicate; `SET LOCAL` does not leak | 0001 |
| `03-effectivity.sh` | The exclusion constraint refuses an overlapping effective interval, including under a race | 0005 |
| `04-append-only.sh` | Revoked privileges make the ledger append-only; the dedupe key stops a double emission | 0006 |
| `05-gapless-sequence.sh` | The per-tenant sequence stays gapless under concurrent writers, and a rollback consumes no number | 0006 |

**Roles.** `00-roles.sh` creates the three roles from `ADR-0009` — `migration_role`,
`app_role`, `retention_role` — none of them superusers. Run it first; `run.sh` does.

---

## What the first run found

Two things the ADRs asserted were wrong, and both were found by executing them rather than
by review.

### 1. A withdrawn version would have claimed all of time

`ADR-0005` said withdrawal "nulls the range rather than closing it", with the constraint
skipping rows via `WHERE (effective_range IS NOT NULL)`.

But `tstzrange(NULL, NULL, '[)')` does not produce a null range. It produces `(,)` — an
**unbounded** range that overlaps everything:

```text
tstzrange(NULL,NULL,'[)')          →  (,)      is_null = false
(,) && ['2027-01-01','2027-03-01') →  true
```

So a withdrawn version would have blocked every other version of its variant, forever —
the exact opposite of the intent, and it would have shipped as a partial unique index that
looked correct in review.

Worse, the underlying idea was also wrong. Nulling the range on withdrawal erases the fact
that the version governed anyone, which breaks the point-in-time reconstruction
INV-EVD-007 and INV-APL-009 depend on. A withdrawn version *was* effective, up to the
moment it was withdrawn.

**The correction, now verified:**

- the generated column yields `NULL` only when there is no `effective_from`, so
  pre-release versions claim no time:

```sql effective_range tstzrange GENERATED ALWAYS AS (
    CASE WHEN effective_from IS NULL THEN NULL
         ELSE tstzrange(effective_from, effective_until, '[)')
    END) STORED
```

- withdrawal **closes** the interval at the withdrawal instant rather than nulling it, so
  historical resolution still finds the version for the period it governed, and it claims
  nothing afterwards.

### 2. `FORCE ROW LEVEL SECURITY` does not bind a superuser

`ADR-0001` said forced RLS subjects the table owner to its own policies. True — but a
**superuser bypasses row-level security entirely**, and `FORCE` does not change that.

The first run of `02-tenancy.sh` failed for exactly this reason: the owner was `postgres`,
and it saw both tenants' rows.

Two consequences, both now enforced by the checks:

- **the migration role must not be a superuser**, or `FORCE` buys nothing against the role
  that owns every table;
- **integration tests must never connect as a superuser.** A cross-tenant negative test
  run as `postgres` passes while proving nothing, which would quietly hollow out row 4 of
  the definition of done.

---

## Confirmed as specified

| Claim | Result |
|---|---|
| `btree_gist` available | 1.7, on PostgreSQL 17.11 |
| Exclusion constraint over `uuid =` and `tstzrange &&` | Works, and holds under a concurrent race |
| Exclusion violation `SQLSTATE` | `23P01` — publication can return a governance error rather than a 500 |
| Constraint keyed on the variant | A second variant may claim the same instants, preserving baseline-plus-replacement |
| Half-open `[)` intervals | Abut without overlapping; the boundary instant belongs to exactly one |
| Generated range column | Cannot be written directly, so it cannot drift from its timestamps |
| Composite foreign keys | A cross-tenant reference is refused as a foreign-key violation |
| Forced RLS with a non-superuser owner | Applies to owner and application role alike |
| No tenant context set | The query errors rather than returning rows — fails closed |
| `SET LOCAL` | Scoped to its transaction; a pooled connection cannot inherit it |
| `REVOKE UPDATE, DELETE, TRUNCATE` | All three refused for the application role |
| Unique dedupe key | A repeated `version.effective` is refused |
| Gapless sequence | 200 events across 8 concurrent writers, range 1..200, no holes |
| Rollback and the sequence | Consumes no number, so a rolled-back transaction leaves no hole |

## Still unverified — needs the hosting platform

These depend on the platform rather than on Postgres, and are checked once a Neon project
exists:

- an EU region, and `btree_gist` creatable there;
- whether a non-owner application role can be created, and `FORCE ROW LEVEL SECURITY`
  applied — `ADR-0001` has no fallback at the same enforcement level if not;
- `SET LOCAL` semantics through the connection pooler;
- `CREATE INDEX CONCURRENTLY` through the pooler, which usually needs a direct connection;
- `REVOKE … TRUNCATE` and a separate retention role;
- restore timing from a backup, so the disaster-recovery claim is a number.
