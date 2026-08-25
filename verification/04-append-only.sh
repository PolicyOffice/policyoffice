#!/usr/bin/env bash
# ADR-0006: the audit ledger is append-only because the application role lacks
# the privilege to do anything else — level 2, not a discipline.
#
# Carries INV-AUD-002, and the same mechanism serves INV-APR-007 and INV-ATT-007.
set -euo pipefail
DC="docker compose exec -T"
su()  { $DC -e PGPASSWORD=postgres       postgres psql -U postgres       -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
mig() { $DC -e PGPASSWORD=migration_role postgres psql -U migration_role -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
app() { $DC -e PGPASSWORD=app_role       postgres psql -U app_role       -h 127.0.0.1 -d policyoffice -tAq "$@"; }
ret() { $DC -e PGPASSWORD=retention_role postgres psql -U retention_role -h 127.0.0.1 -d policyoffice -tAq "$@"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }
refused() { grep -qiE 'permission denied|must be owner' <<<"$1"; }

su <<'SQL'
DROP SCHEMA IF EXISTS v04 CASCADE;
CREATE SCHEMA v04 AUTHORIZATION migration_role;
GRANT USAGE ON SCHEMA v04 TO app_role, retention_role;
SQL

mig <<'SQL'
CREATE TABLE v04.audit_event (
  tenant_id  uuid   NOT NULL,
  sequence   bigint NOT NULL,
  event_type text   NOT NULL,
  dedupe_key text,
  PRIMARY KEY (tenant_id, sequence),
  UNIQUE (tenant_id, dedupe_key)     -- INV-AUD-001, INV-EFF-007
);
GRANT SELECT, INSERT ON v04.audit_event TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON v04.audit_event FROM app_role;
GRANT SELECT, DELETE ON v04.audit_event TO retention_role;  -- disposal only
INSERT INTO v04.audit_event VALUES
  ('11111111-1111-1111-1111-111111111111', 1, 'version.effective', 'version.effective:abc');
SQL

T=11111111-1111-1111-1111-111111111111

echo "--- the application role may append ---"
app -c "INSERT INTO v04.audit_event VALUES ('$T', 2, 'version.published', 'version.published:abc');" >/dev/null \
  && pass "INSERT permitted" || fail "the application role could not append"

echo
echo "--- and may not rewrite history ---"
for op in "UPDATE v04.audit_event SET event_type = 'tampered'" \
          "DELETE FROM v04.audit_event" \
          "TRUNCATE v04.audit_event"; do
  out=$(app -c "$op;" 2>&1 || true)
  verb=${op%% *}
  refused "$out" && pass "$verb refused: $(head -1 <<<"$out")" || fail "$verb was permitted — the ledger is not append-only"
done

echo
echo "--- INV-AUD-001: a duplicate dedupe key is refused, so a retry emits one event ---"
out=$(app -c "INSERT INTO v04.audit_event VALUES ('$T', 99, 'version.effective', 'version.effective:abc');" 2>&1 || true)
grep -qi 'duplicate key' <<<"$out" \
  && pass "a scheduler firing twice cannot record a second version.effective" \
  || fail "the duplicate was accepted: $out"

echo
echo "--- retention disposal is a different role, and it can delete ---"
ret -c "DELETE FROM v04.audit_event WHERE sequence = 2;" >/dev/null \
  && pass "retention_role may dispose under a configured schedule" \
  || fail "retention_role could not delete"

echo
echo "--- but retention_role cannot append or rewrite ---"
out=$(ret -c "INSERT INTO v04.audit_event VALUES ('$T', 50, 'forged', 'forged:1');" 2>&1 || true)
refused "$out" && pass "INSERT refused for retention_role" || fail "retention_role could append events"

echo
echo "--- privileges as granted ---"
su -c "SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type)
       FROM information_schema.role_table_grants
       WHERE table_schema='v04' AND grantee IN ('app_role','retention_role')
       GROUP BY grantee ORDER BY grantee;"
