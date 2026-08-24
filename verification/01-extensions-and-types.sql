-- ADR-0000, ADR-0005: the database must provide the mechanisms the enforcement
-- ladder assumes. If any of this fails, ADR-0005 has no level-2 enforcement for
-- INV-EFF-002 and must be rewritten.
\set ON_ERROR_STOP on

\echo '--- server version ---'
SELECT version();

\echo '--- btree_gist: required for an exclusion constraint mixing = and && ---'
CREATE EXTENSION IF NOT EXISTS btree_gist;
SELECT extname, extversion FROM pg_extension WHERE extname = 'btree_gist';

\echo '--- gen_random_uuid() available without pgcrypto (PG13+) ---'
SELECT gen_random_uuid() IS NOT NULL AS uuid_ok;

DROP SCHEMA IF EXISTS v01 CASCADE;
CREATE SCHEMA v01;

\echo '--- generated tstzrange column, half-open [) — INV-TIME-005 ---'
CREATE TABLE v01.interval_check (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from timestamptz,
  effective_until timestamptz,
  effective_range tstzrange GENERATED ALWAYS AS
    (tstzrange(effective_from, effective_until, '[)')) STORED
);

INSERT INTO v01.interval_check (effective_from, effective_until)
VALUES ('2027-01-01Z', '2027-03-01Z'), ('2027-03-01Z', NULL);

DO $$
DECLARE a tstzrange; b tstzrange;
BEGIN
  SELECT effective_range INTO a FROM v01.interval_check WHERE effective_until IS NOT NULL;
  SELECT effective_range INTO b FROM v01.interval_check WHERE effective_until IS NULL;

  IF a && b THEN
    RAISE EXCEPTION 'FAIL: abutting half-open intervals overlap — INV-TIME-005 does not hold';
  END IF;
  IF NOT (b @> '2027-03-01Z'::timestamptz) THEN
    RAISE EXCEPTION 'FAIL: the instant at the boundary belongs to neither interval';
  END IF;
  IF a @> '2027-03-01Z'::timestamptz THEN
    RAISE EXCEPTION 'FAIL: the upper bound is inclusive — the range is not half-open';
  END IF;
  RAISE NOTICE 'PASS: [) intervals abut without overlapping; the boundary instant belongs to exactly one';
END $$;

\echo '--- a generated column cannot be written to directly ---'
DO $$
BEGIN
  BEGIN
    EXECUTE $q$ UPDATE v01.interval_check SET effective_range = tstzrange(null, null) $q$;
    RAISE EXCEPTION 'FAIL: the generated range column was writable';
  EXCEPTION WHEN generated_always THEN
    RAISE NOTICE 'PASS: the range cannot drift from the timestamps it is derived from';
  END;
END $$;

DROP SCHEMA v01 CASCADE;
