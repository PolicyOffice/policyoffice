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
| `neon.sh` | The hosting platform: EU region, roles, forced RLS, pooler semantics, revoked privileges | 0000, 0001, 0009 |

The numbered checks are the local run. **`neon.sh` has no number on purpose** — it needs
credentials and a network, so `run.sh` does not pick it up:

```bash
set -a; . ./.env; set +a && ./verification/neon.sh
```

**Roles.** `00-roles.sh` creates the three roles from `ADR-0009` — `migration_role`,
`app_role`, `retention_role` — none of them superusers. Run it first; `run.sh` does.

---

## What the first run found (PostgreSQL 17.11)

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

## What the move to PostgreSQL 18 found

The database was moved from 17 to 18 on 2026-08-25, a founder decision taken for the
longer support runway while the cost of moving was still zero. All assertions were
re-executed. Everything above still holds, `btree_gist` is 1.8 rather than 1.7, and two
new things came out of it.

### 3. On 18, omitting `STORED` silently weakens INV-EFF-002

PostgreSQL 18 added **virtual** generated columns and made `VIRTUAL` the **default** when
neither keyword is given. Virtual columns cannot be indexed, and `EXCLUDE USING gist`
needs an index.

```text
CREATE TABLE … effective_range tstzrange GENERATED ALWAYS AS (…)   -- no STORED
  → succeeds.  pg_attribute.attgenerated = 'v'  (VIRTUAL)
ALTER TABLE … ADD CONSTRAINT … EXCLUDE USING gist (…)
  → ERROR: unique constraints on virtual generated columns are not supported
```

On 17 that DDL was a **syntax error**, so the mistake could not be made. On 18 the table
is created successfully and only the constraint fails — later, in a different migration,
in front of whoever is debugging it at the time. The failure mode being designed against
is that person concluding the exclusion constraint is unworkable and reaching for a
trigger or an application-level check, which moves INV-EFF-002 from level 2 to level 5
without anyone deciding to.

No existing code was affected: all four declarations already said `STORED` explicitly.
`01-extensions-and-types.sql` now asserts it, so the requirement is executable rather than
remembered.

### 4. The roles teardown never worked on a clean clone

`00-roles.sh` called `REASSIGN OWNED BY migration_role` before creating the roles.
`REASSIGN OWNED` and `DROP OWNED` both error on a role that does not exist, so the script
only ever succeeded because a previous run had left the roles behind in the volume.

`phase-2-bootstrap.md`'s exit criterion is that `docker compose up -d &&
./verification/run.sh` passes **from a clean clone**. It did not, and nothing detected
that, because the volume outlived every run. Found by wiping the volume for the major
version change. The teardown is now guarded and genuinely idempotent.

This is not a PostgreSQL 18 issue. It is a latent defect that a fresh volume exposed, and
it is the second time in this directory that executing something has found what reviewing
it did not.

### The Docker image also moved its data directory

Unrelated to the database, but it stops the container from starting: the `postgres:18+`
images store data in a major-version-specific subdirectory so `pg_upgrade --link` works
without crossing a mount boundary. The volume is mounted at `/var/lib/postgresql`, **not**
`/var/lib/postgresql/data`. `docker-compose.yml` carries a comment saying so, because the
old path looks more correct than it is.

---

## Confirmed as specified

| Claim | Result |
|---|---|
| `btree_gist` available | 1.8, on PostgreSQL 18.6 |
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

## Verified on the platform — Neon, 2026-08-25

`neon.sh`, 24 assertions against the provisioned project: PostgreSQL **18.6**,
`aws-eu-central-1` (Frankfurt), free plan. It is deliberately **not** part of `run.sh` —
it needs credentials and a network. Run it with `set -a; . ./.env; set +a`.

Neon runs the same PostgreSQL minor version as the local environment, so this is a
like-for-like comparison rather than an approximation.

| Claim | Result |
|---|---|
| An EU region | `eu-central-1`, from the endpoint host — decision 7 holds |
| `btree_gist` | 1.8, same as local. Creatable by the provisioned role **and** by a plain non-superuser role |
| A non-owner application role | Creatable, `NOSUPERUSER NOBYPASSRLS`, inheriting neither through any role grant |
| `FORCE ROW LEVEL SECURITY` with a non-superuser owner | **Binds the owner.** ADR-0001's load-bearing claim holds |
| No tenant context | Errors rather than returning rows, on both endpoints — fails closed |
| Cross-tenant identifier | Zero rows, not an error — INV-TEN-002 holds |
| `SET LOCAL` through the pooler | Does not survive its transaction |
| `REVOKE UPDATE, DELETE, TRUNCATE` | All three refused for the application role; a separate retention role may `DELETE` and not `INSERT` |
| `CREATE INDEX CONCURRENTLY` | Works through **both** endpoints — see finding 7 |
| Restore timing | **Not measured** — see below |

### 5. The role Neon gives you cannot be the application role

`neondb_owner` has `rolbypassrls = t`, directly and again through membership of
`neon_superuser`. Row-level security does not apply to it at all.

This is exactly the trap `ADR-0001` describes, sitting in the default configuration of the
platform: connect the application with the credentials Neon hands you and INV-TEN-001 is
silently unenforced, while every test that runs as that role passes. It is the superuser
finding from the first run wearing different clothes.

The three roles must therefore be created explicitly, by SQL, `NOSUPERUSER NOBYPASSRLS` —
which works, and is checked here including inheritance through role grants.

### 6. The pooler caches a role by OID, so recreating one by name poisons it

Dropping a role and recreating it with the **same name** leaves Neon's pooled endpoint
serving cached server connections bound to the *old* OID. Queries then fail with
`invalid role OID: <n>` or a spurious `permission denied`, while the identical query on the
direct endpoint succeeds. A never-before-used role name is unaffected — verified both ways.

`ADR-0009` establishes the three roles **by migration**. A migration that ever drops and
recreates a role therefore breaks production through the pooled endpoint, presenting as an
authorization bug that heals itself once the connections cycle. That is close to the worst
possible shape for a defect in this product.

**Roles are created once and `ALTER`ed thereafter.** Never dropped and recreated.

### 7. `CREATE INDEX CONCURRENTLY` works through the pooler

`ADR-0009` predicted it would need a direct connection, *"which typically requires a direct
connection."* On Neon it succeeds through the pooled endpoint as well; both indexes were
built and confirmed present. The ADR is amended.

It is still refused inside an explicit transaction block, which is Postgres behaving as
documented and is why the migration harness must be able to mark a migration
non-transactional.

### 8. Failing closed, but by two different errors

With no tenant context both endpoints refuse, which is what INV-TEN-001 requires. They
refuse *differently*:

```text
direct : ERROR: unrecognized configuration parameter "app.tenant_id"
pooled : ERROR: invalid input syntax for type uuid: ""
```

Through the pooler the custom GUC survives as an empty string once any transaction on that
backend has set it, so which error appears depends on connection reuse. An application must
never decide *"no tenant context"* by matching on the error — the policy has to fail closed
by construction, which it does.

### Two more platform behaviours worth knowing

- **Neon's control plane intercepts `CREATE ROLE`** and rejects weak passwords with an HTTP
  400. Role passwords in migrations must be generated, and this is a way CI (a plain
  container) and production (Neon) diverge silently.
- **PostgreSQL 16+ separates `ADMIN` from `SET`.** `CREATEROLE` confers `ADMIN` on roles it
  creates but not the right to `SET ROLE` to them, so `REASSIGN OWNED` and dropping a schema
  owned by another role need an explicit `GRANT … WITH SET TRUE` first.

### Still not measured: restore timing

`ADR-0009` asked for a number so the disaster-recovery claim in the security documentation
is measured rather than assumed. Neon restores by branching to a past instant, which is a
control-plane operation reachable through the console or the Neon API — not through a
connection string. Measuring it needs a Neon API key, and it is the one item on the ADR
lists still outstanding.
