#!/usr/bin/env bash
# Shared setup: the three database roles from ADR-0009, none of them superusers.
# Run this before the numbered checks. It is idempotent and destructive — it
# drops every verification schema so the checks start from nothing.
set -euo pipefail
su_psql() { docker compose exec -T -e PGPASSWORD=postgres postgres psql -U postgres -d policyoffice -v ON_ERROR_STOP=1 -tAq "$@"; }

su_psql <<'SQL'
DROP SCHEMA IF EXISTS v02 CASCADE;
DROP SCHEMA IF EXISTS v03 CASCADE;
DROP SCHEMA IF EXISTS v04 CASCADE;
DROP SCHEMA IF EXISTS v05 CASCADE;

REASSIGN OWNED BY migration_role TO postgres;
DROP OWNED BY migration_role;
DROP OWNED BY app_role;
DROP OWNED BY retention_role;
DROP ROLE IF EXISTS app_role;
DROP ROLE IF EXISTS retention_role;
DROP ROLE IF EXISTS migration_role;

-- The owner is deliberately NOT a superuser. FORCE ROW LEVEL SECURITY subjects
-- the table owner to its own policies, but a superuser bypasses RLS entirely,
-- so a superuser owner makes FORCE worthless. See 02-tenancy.sh.
CREATE ROLE migration_role LOGIN PASSWORD 'migration_role' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_role       LOGIN PASSWORD 'app_role'       NOSUPERUSER NOBYPASSRLS;
CREATE ROLE retention_role LOGIN PASSWORD 'retention_role' NOSUPERUSER NOBYPASSRLS;

GRANT CREATE, CONNECT ON DATABASE policyoffice TO migration_role;
GRANT CONNECT ON DATABASE policyoffice TO app_role, retention_role;
SQL
echo "roles ready: migration_role (owner, DDL) · app_role (restricted) · retention_role (disposal)"
