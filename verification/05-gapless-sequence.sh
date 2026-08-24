#!/usr/bin/env bash
# ADR-0006: the audit sequence is allocated under a per-tenant row lock so that
# it is gapless and commit-ordered. A bigserial would be neither: it assigns on
# statement, not on commit, so a cursor-following consumer can skip an event and
# a regenerated evidence pack can reorder.
#
# Gaplessness is what lets a recipient verify "sequences 1..N with no holes"
# without the vendor. The cost is that governed writes within one tenant
# serialise at commit — ADR-0006 flagged that for measurement. This measures it.
#
# Carries INV-AUD-009, INV-EVD-006.
set -euo pipefail
DC="docker compose exec -T"
su()  { $DC -e PGPASSWORD=postgres       postgres psql -U postgres       -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
mig() { $DC -e PGPASSWORD=migration_role postgres psql -U migration_role -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
app() { $DC -e PGPASSWORD=app_role       postgres psql -U app_role       -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }
num()  { grep -E '^[0-9]+$' | tail -1; }

T=11111111-1111-1111-1111-111111111111
WRITERS=8
PER_WRITER=25
TOTAL=$((WRITERS * PER_WRITER))

su <<'SQL'
DROP SCHEMA IF EXISTS v05 CASCADE;
CREATE SCHEMA v05 AUTHORIZATION migration_role;
GRANT USAGE ON SCHEMA v05 TO app_role;
SQL

mig <<'SQL'
CREATE TABLE v05.tenant_event_sequence (
  tenant_id     uuid PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1
);
CREATE TABLE v05.audit_event (
  tenant_id uuid   NOT NULL,
  sequence  bigint NOT NULL,
  writer    text   NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);
INSERT INTO v05.tenant_event_sequence (tenant_id) VALUES ('11111111-1111-1111-1111-111111111111');
GRANT SELECT, INSERT ON v05.audit_event TO app_role;
GRANT SELECT, UPDATE ON v05.tenant_event_sequence TO app_role;
SQL
pass "sequence table and ledger created"

echo
echo "--- a rolled-back transaction must not consume a number ---"
app <<SQL >/dev/null
BEGIN;
UPDATE v05.tenant_event_sequence SET next_sequence = next_sequence + 1
 WHERE tenant_id = '$T';
ROLLBACK;
SQL
n=$(app -c "SELECT next_sequence FROM v05.tenant_event_sequence WHERE tenant_id='$T';" | num)
[ "$n" = "1" ] || fail "a rolled-back allocation consumed a number (next=$n); the sequence would have a hole"
pass "rollback releases the lock without incrementing — this is what a bigserial cannot do"

echo
echo "--- $WRITERS concurrent writers x $PER_WRITER events ---"
start=$(date +%s.%N)
for w in $(seq 1 $WRITERS); do
  (
    for i in $(seq 1 $PER_WRITER); do
      app <<SQL >/dev/null 2>&1
BEGIN;
WITH s AS (
  UPDATE v05.tenant_event_sequence SET next_sequence = next_sequence + 1
   WHERE tenant_id = '$T'
  RETURNING next_sequence - 1 AS seq
)
INSERT INTO v05.audit_event (tenant_id, sequence, writer)
SELECT '$T', s.seq, 'w$w' FROM s;
COMMIT;
SQL
    done
  ) &
done
wait
end=$(date +%s.%N)
elapsed=$(echo "$end - $start" | bc)

count=$(app  -c "SELECT count(*)         FROM v05.audit_event WHERE tenant_id='$T';" | num)
distinct=$(app -c "SELECT count(DISTINCT sequence) FROM v05.audit_event WHERE tenant_id='$T';" | num)
lo=$(app     -c "SELECT min(sequence)    FROM v05.audit_event WHERE tenant_id='$T';" | num)
hi=$(app     -c "SELECT max(sequence)    FROM v05.audit_event WHERE tenant_id='$T';" | num)

[ "$count" = "$TOTAL" ]    || fail "expected $TOTAL events, found $count"
[ "$distinct" = "$TOTAL" ] || fail "expected $TOTAL distinct sequences, found $distinct — duplicates were issued"
[ "$lo" = "1" ]            || fail "sequence starts at $lo, expected 1"
[ "$hi" = "$TOTAL" ]       || fail "sequence ends at $hi, expected $TOTAL — there are gaps"
pass "$TOTAL events, $distinct distinct sequences, range $lo..$hi — gapless under $WRITERS concurrent writers"

gaps=$(app -c "SELECT count(*) FROM generate_series(1,$TOTAL) g
               LEFT JOIN v05.audit_event e ON e.sequence = g AND e.tenant_id='$T'
               WHERE e.sequence IS NULL;" | num)
[ "$gaps" = "0" ] || fail "$gaps holes in the sequence"
pass "an explicit hole check confirms it: a recipient can verify 1..$TOTAL without the vendor"

echo
echo "--- the measured cost ADR-0006 asked for ---"
printf "    %s events, %s writers, %.2fs wall clock, %.1f events/sec\n" \
  "$TOTAL" "$WRITERS" "$elapsed" "$(echo "$TOTAL / $elapsed" | bc -l)"
echo
echo "    Read this honestly: it is NOT a measurement of lock contention. Each"
echo "    event spawns a container exec, a psql process and a fresh connection,"
echo "    so the figure is dominated by process startup. What it demonstrates is"
echo "    correctness under real concurrency, not throughput."
echo
echo "    The informative number is the bulk case below, which does the work over"
echo "    one connection. A true contention measurement needs persistent"
echo "    connections and belongs with the application, not here."

echo
echo "--- bulk import: many events, one transaction, one lock acquisition ---"
start=$(date +%s.%N)
app <<SQL >/dev/null
BEGIN;
WITH s AS (
  UPDATE v05.tenant_event_sequence SET next_sequence = next_sequence + 1000
   WHERE tenant_id = '$T'
  RETURNING next_sequence - 1000 AS base
)
INSERT INTO v05.audit_event (tenant_id, sequence, writer)
SELECT '$T', s.base + g - 1, 'bulk' FROM s, generate_series(1,1000) g;
COMMIT;
SQL
end=$(date +%s.%N)
printf "    1000 events in one transaction: %.2fs\n" "$(echo "$end - $start" | bc)"
bulkgaps=$(app -c "SELECT count(*) FROM generate_series(1,$((TOTAL+1000))) g
                   LEFT JOIN v05.audit_event e ON e.sequence = g AND e.tenant_id='$T'
                   WHERE e.sequence IS NULL;" | num)
[ "$bulkgaps" = "0" ] || fail "$bulkgaps holes after bulk import"
pass "batch allocation stays gapless — import takes the lock once per batch, not once per event"
