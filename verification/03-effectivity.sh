#!/usr/bin/env bash
# ADR-0005: at most one version of a variant claims any instant, enforced by a
# Postgres exclusion constraint rather than by a check-then-write in application
# code. This is the invariant that selected PostgreSQL (ADR-0000).
#
# Carries INV-EFF-002, INV-TIME-005, and the scope-key decision in ADR-0005.
set -euo pipefail

DC="docker compose exec -T"
mig() { $DC -e PGPASSWORD=migration_role postgres psql -U migration_role -h 127.0.0.1 -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
su()  { $DC -e PGPASSWORD=postgres       postgres psql -U postgres       -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

T=11111111-1111-1111-1111-111111111111
V1=aaaa1111-0000-0000-0000-000000000001   # baseline variant
V2=aaaa2222-0000-0000-0000-000000000002   # a replacement variant of the same document

echo "--- setup ---"
su <<SQL
DROP SCHEMA IF EXISTS v03 CASCADE;
CREATE SCHEMA v03 AUTHORIZATION migration_role;
SQL
mig <<SQL
CREATE TABLE v03.document_version (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  document_variant_id uuid NOT NULL,
  label               text NOT NULL,
  effective_from      timestamptz,
  effective_until     timestamptz,
  withdrawn_at        timestamptz,
  -- tstzrange(NULL, NULL) is (,) — UNBOUNDED, not null, and it overlaps
  -- everything. A pre-release version must therefore be excluded explicitly,
  -- or it would claim all of time. See the correction recorded in ADR-0005.
  effective_range     tstzrange GENERATED ALWAYS AS (
                        CASE WHEN effective_from IS NULL THEN NULL
                             ELSE tstzrange(effective_from, effective_until, '[)')
                        END) STORED,
  PRIMARY KEY (tenant_id, id),

  -- INV-EFF-002: at most one version of a variant claims any instant.
  -- Keyed on the variant, not the document: a group baseline and a regional
  -- replacement are two variants of one document and both are legitimately
  -- effective at once, for different populations.
  CONSTRAINT one_effective_version_per_variant
    EXCLUDE USING gist (
      tenant_id           WITH =,
      document_variant_id WITH =,
      effective_range     WITH &&
    ) WHERE (effective_range IS NOT NULL)
);
SQL
pass "exclusion constraint created (btree_gist over uuid = and tstzrange &&)"

ins() { mig -c "INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until) VALUES ('$T','$1','$2',$3,$4);" ; }

echo
echo "--- v1 claims [2027-01-01, 2027-03-01) ---"
ins "$V1" v1 "'2027-01-01Z'" "'2027-03-01Z'" >/dev/null && pass "accepted"

echo
echo "--- v2 claims [2027-02-01, 2027-04-01) on the same variant: must be refused ---"
set +e
err=$(mig -c "INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
              VALUES ('$T','$V1','v2-overlapping','2027-02-01Z','2027-04-01Z');" 2>&1)
rc=$?
set -e
[ $rc -eq 0 ] && fail "an overlapping interval was accepted"
echo "$err" | grep -q 'one_effective_version_per_variant' \
  && pass "refused by name, so publication can report which constraint collided" \
  || fail "refused, but not by the expected constraint: $err"

sqlstate=$(mig -tAc "DO \$\$
BEGIN
  INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
  VALUES ('$T','$V1','x','2027-02-01Z','2027-04-01Z');
EXCEPTION WHEN others THEN
  RAISE NOTICE 'SQLSTATE=%', SQLSTATE;
END \$\$;" 2>&1 | grep -oE 'SQLSTATE=[0-9A-Z]+' | cut -d= -f2)
[ "$sqlstate" = "23P01" ] || fail "expected SQLSTATE 23P01 (exclusion_violation), got '$sqlstate'"
pass "SQLSTATE is 23P01 — the publication path can translate this into a governance error, not a 500"

echo
echo "--- v2 claims [2027-03-01, ∞) — abutting, not overlapping (INV-TIME-005) ---"
ins "$V1" v2 "'2027-03-01Z'" NULL >/dev/null \
  && pass "accepted: half-open intervals abut cleanly, so a successor can start the instant its predecessor ends" \
  || fail "an abutting interval was refused — the range is not half-open"

echo
echo "--- a different variant may claim the same instants (ADR-0005 scope key) ---"
ins "$V2" replacement-v1 "'2027-01-01Z'" "'2027-06-01Z'" >/dev/null \
  && pass "accepted: keying on the variant preserves baseline-plus-replacement, the cross-border capability" \
  || fail "a second variant was blocked — the constraint is keyed too broadly"

echo
echo "--- pre-release versions claim no time and stay out of the constraint ---"
mig -c "INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
        VALUES ('$T','$V1','draft-a',NULL,NULL), ('$T','$V1','draft-b',NULL,NULL);" >/dev/null \
  && pass "two rows with no effective_from coexist — the CASE yields NULL, and the partial index skips them" \
  || fail "pre-release rows were caught by the constraint"

echo
echo "--- withdrawal CLOSES the interval; it must not null it ---"
mig -c "INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until, withdrawn_at)
        VALUES ('$T','$V2','w1','2029-01-01Z','2029-04-01Z','2029-04-01Z');" >/dev/null
hist=$(mig -tAc "SELECT count(*) FROM v03.document_version
                 WHERE document_variant_id = '$V2' AND effective_range @> '2029-02-01Z'::timestamptz;" | grep -E '^[0-9]+$')
[ "$hist" = "1" ] || fail "historical resolution could not find the withdrawn version for a date it governed"
pass "a withdrawn version still resolves for the period before withdrawal — history is preserved"

after=$(mig -tAc "SELECT count(*) FROM v03.document_version
                  WHERE document_variant_id = '$V2' AND effective_range @> '2029-06-01Z'::timestamptz;" | grep -E '^[0-9]+$')
[ "$after" = "0" ] || fail "the withdrawn version still claims time after withdrawal"
pass "and claims nothing after the withdrawal instant — so a policy gap is detectable"

mig -c "INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
        VALUES ('$T','$V2','w2-successor','2029-04-01Z',NULL);" >/dev/null \
  && pass "a successor may claim the instant the withdrawal closed at" \
  || fail "a successor was blocked after a withdrawal"

echo
echo "--- a race: two concurrent transactions claiming overlapping intervals ---"
mig -c "DELETE FROM v03.document_version WHERE document_variant_id = '$V2';" >/dev/null
(
  mig <<SQL &
BEGIN;
INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
VALUES ('$T','$V2','racer-1','2028-01-01Z','2028-06-01Z');
SELECT pg_sleep(1);
COMMIT;
SQL
  P1=$!
  sleep 0.2
  set +e
  mig <<SQL >/tmp/racer2.out 2>&1
BEGIN;
INSERT INTO v03.document_version (tenant_id, document_variant_id, label, effective_from, effective_until)
VALUES ('$T','$V2','racer-2','2028-03-01Z','2028-09-01Z');
COMMIT;
SQL
  echo $? > /tmp/racer2.rc
  set -e
  wait $P1
)
survivors=$(mig -tAc "SELECT count(*) FROM v03.document_version WHERE document_variant_id = '$V2';" | grep -E '^[0-9]+$')
[ "$survivors" = "1" ] || fail "$survivors rows survived the race; exactly 1 should have"
grep -q 'one_effective_version_per_variant' /tmp/racer2.out \
  && pass "the second transaction blocked on the first, then was refused on commit — a race cannot defeat it" \
  || pass "exactly one survived the race (loser output: $(head -c 120 /tmp/racer2.out | tr '\n' ' '))"

echo
echo "--- final state ---"
mig -c "SELECT label, effective_range FROM v03.document_version ORDER BY document_variant_id, label;"
