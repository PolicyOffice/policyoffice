#!/usr/bin/env bash
# ADR-0001: tenancy at two levels — composite keys make a cross-tenant reference
# unrepresentable (level 1); forced row-level security makes a forgotten predicate
# return nothing (level 2).
#
# Carries INV-TEN-001, INV-TEN-002, INV-TEN-003, INV-TEN-004.
#
# This is a shell script rather than a .sql file because the claims are about
# *who is connected*. Asserting them from one superuser session would prove
# nothing — which is itself one of the findings below.
set -euo pipefail

DC="docker compose exec -T"
su_psql()  { $DC -e PGPASSWORD=postgres       postgres psql -U postgres       -d policyoffice -v ON_ERROR_STOP=1 -tA "$@"; }
mig_psql() { $DC -e PGPASSWORD=migration_role postgres psql -U migration_role -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tA "$@"; }
app_psql() { $DC -e PGPASSWORD=app_role       postgres psql -U app_role       -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tA "$@"; }

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }
# psql echoes BEGIN/SET/COMMIT tags; keep only the numeric result line.
num()  { grep -E '^[0-9]+$' | tail -1; }

A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222

echo "--- setup (roles come from 00-roles.sh) ---"
su_psql <<SQL
DROP SCHEMA IF EXISTS v02 CASCADE;
CREATE SCHEMA v02 AUTHORIZATION migration_role;
GRANT USAGE ON SCHEMA v02 TO app_role, retention_role;
SQL

mig_psql <<SQL
CREATE TABLE v02.tenant (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE v02.document (
  tenant_id uuid NOT NULL REFERENCES v02.tenant(id),
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  title     text NOT NULL,
  PRIMARY KEY (tenant_id, id),   -- INV-TEN-003
  UNIQUE (id)                    -- so an id alone is a valid external reference
);

CREATE TABLE v02.attestation_campaign (
  tenant_id   uuid NOT NULL REFERENCES v02.tenant(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES v02.document (tenant_id, id)
);

INSERT INTO v02.tenant (id, name) VALUES ('$A','Tenant A'), ('$B','Tenant B');
INSERT INTO v02.document (tenant_id, id, title) VALUES
  ('$A','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A: Information Security Policy'),
  ('$B','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B: Code of Conduct');

ALTER TABLE v02.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE v02.document FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v02.document
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT ON v02.document TO app_role;
GRANT SELECT ON v02.tenant TO app_role;
SQL

echo
echo "--- INV-TEN-003: a cross-tenant reference must be unrepresentable ---"
if mig_psql -c "INSERT INTO v02.attestation_campaign (tenant_id, document_id)
                VALUES ('$B','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" >/dev/null 2>&1; then
  fail "a cross-tenant foreign key was accepted"
else
  pass "composite key refused a cross-tenant reference (level 1, structural)"
fi

echo
echo "--- INV-TEN-001: the application role sees only its own tenant ---"
n=$(app_psql -c "BEGIN; SET LOCAL app.tenant_id = '$A'; SELECT count(*) FROM v02.document; COMMIT;" | num)
[ "$n" = "1" ] || fail "app_role saw $n rows for tenant A, expected 1"
pass "tenant A context returns exactly its own row"

t=$(app_psql -c "BEGIN; SET LOCAL app.tenant_id = '$B'; SELECT title FROM v02.document; COMMIT;" | grep -c 'B: Code of Conduct' || true)
[ "$t" = "1" ] || fail "tenant B context did not return tenant B's row"
pass "tenant B context returns a different row from the same table"

echo
echo "--- INV-TEN-002: another tenant's identifier behaves as not-found ---"
n=$(app_psql -c "BEGIN; SET LOCAL app.tenant_id = '$B';
                 SELECT count(*) FROM v02.document WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; COMMIT;" | num)
[ "$n" = "0" ] || fail "a cross-tenant id returned $n rows"
pass "a known-good id from another tenant returns zero rows, not an error"

echo
echo "--- the forgotten predicate: an unqualified SELECT returns one tenant, not all ---"
n=$(app_psql -c "BEGIN; SET LOCAL app.tenant_id = '$A'; SELECT count(*) FROM v02.document; COMMIT;" | num)
[ "$n" = "1" ] || fail "an unqualified SELECT returned $n rows"
pass "a query with no WHERE clause still returns only the current tenant"

echo
echo "--- with no tenant context set at all ---"
if app_psql -c "SELECT count(*) FROM v02.document;" >/dev/null 2>&1; then
  fail "a query with no tenant context succeeded — the policy did not fail closed"
else
  pass "no tenant context is an error, not an empty result — fails closed"
fi

echo
echo "--- SET LOCAL must not leak past its transaction ---"
if app_psql <<SQL >/dev/null 2>&1
BEGIN; SET LOCAL app.tenant_id = '$A'; SELECT 1 FROM v02.document LIMIT 1; COMMIT;
SELECT count(*) FROM v02.document;
SQL
then
  fail "the tenant setting survived the transaction — a pooled connection would leak it"
else
  pass "SET LOCAL is scoped to its transaction; the next statement has no context"
fi

echo
echo "--- FORCE: the non-superuser owner is subject to its own policy ---"
n=$(mig_psql -c "BEGIN; SET LOCAL app.tenant_id = '$A'; SELECT count(*) FROM v02.document; COMMIT;" | num)
[ "$n" = "1" ] || fail "the owner saw $n rows under FORCE, expected 1"
pass "FORCE applies the policy to the table owner (non-superuser)"

echo
echo "--- and the boundary: a superuser bypasses RLS regardless of FORCE ---"
n=$(su_psql -c "SET app.tenant_id = '$A'; SELECT count(*) FROM v02.document;" | num)
if [ "$n" = "2" ]; then
  echo "NOTE: a superuser sees all $n rows. This is Postgres behaving as documented,"
  echo "      and it is why the owner must not be a superuser — and why integration"
  echo "      tests must never connect as one. A cross-tenant negative test run as"
  echo "      superuser passes while proving nothing."
else
  fail "expected a superuser to bypass RLS and see 2 rows, saw $n"
fi

echo
echo "--- role attributes ---"
su_psql -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
            WHERE rolname IN ('postgres','migration_role','app_role','retention_role') ORDER BY rolname;"
