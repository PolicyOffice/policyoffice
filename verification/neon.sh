#!/usr/bin/env bash
# ADR-0000, ADR-0001, ADR-0005, ADR-0006, ADR-0007, ADR-0009 — the platform half.
#
# The other checks verify PostgreSQL. This one verifies the *hosting platform*, because
# six claims the ADRs depend on are properties of Neon rather than of Postgres, and
# ADR-0001 states there is no fallback at the same enforcement level if the RLS claim
# fails.
#
# Deliberately NOT part of ./verification/run.sh: it needs credentials and a network.
# Run it on demand, and on a schedule once CI exists (ADR-0009).
#
#   set -a; . ./.env; set +a
#   ./verification/neon.sh
#
# Requires NEON_DATABASE_URL_POOLED and NEON_DATABASE_URL_DIRECT. Both, because two
# claims are specifically about the difference between them. Never commit either: the
# repository is public and .env is gitignored.
#
# psql comes from the local postgres container so that nothing has to be installed on
# the host. That is the only thing docker is used for here.
set -euo pipefail
cd "$(dirname "$0")/.."

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "NOTE: $*"; }

[ -n "${NEON_DATABASE_URL_POOLED:-}" ] || fail "NEON_DATABASE_URL_POOLED is not set. Run: set -a; . ./.env; set +a"
[ -n "${NEON_DATABASE_URL_DIRECT:-}" ] || fail "NEON_DATABASE_URL_DIRECT is not set. Run: set -a; . ./.env; set +a"
case "$NEON_DATABASE_URL_POOLED" in *-pooler.*) :;; *) fail "NEON_DATABASE_URL_POOLED does not name a -pooler host. Copy the string with 'Connection pooling' ON.";; esac
case "$NEON_DATABASE_URL_DIRECT"  in *-pooler.*) fail "NEON_DATABASE_URL_DIRECT names a -pooler host. Copy the string with 'Connection pooling' OFF.";; esac
docker compose exec -T postgres true >/dev/null 2>&1 \
  || fail "the local postgres container is not running; it supplies psql. run: docker compose up -d"

# Never let a URL reach stdout or the process table of another user.
q() { # q <url> ; SQL on stdin
  docker compose exec -T -e __U="$1" postgres sh -c 'psql "$__U" -v ON_ERROR_STOP=0 -tAq -f -' 2>&1
}
qs() { # strict: abort on error
  docker compose exec -T -e __U="$1" postgres sh -c 'psql "$__U" -v ON_ERROR_STOP=1 -tAq -f -' 2>&1
}
url_as() { echo "$1" | sed -E "s|://[^@]+@|://$2:$3@|"; }

# Teardown, in the only order that works. Learned by getting it wrong:
#   * the schema is owned by ${RM}, and PostgreSQL 16+ separates ADMIN from SET --
#     CREATEROLE grants ADMIN on roles it creates but NOT the right to SET ROLE to them,
#     so the owner cannot be impersonated until membership is granted WITH SET TRUE;
#   * the schema must go BEFORE the roles. Dropping a role first reassigns ownership and
#     leaves grants behind that then block the drop of the remaining roles.
teardown() {
  # One session, not one per statement: the GRANT ... WITH SET TRUE has to be in scope
  # for the REASSIGN/DROP that follow, and a round trip to Frankfurt per statement is
  # slow enough to notice. Cleans up EVERY v06_* role, not just this run's, so an
  # aborted run self-heals on the next one.
  cat <<'SQL' | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
DO $$
DECLARE r record; owner text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'v06\_%' LOOP
    EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE', r.rolname);
  END LOOP;
  SELECT pg_get_userbyid(nspowner) INTO owner FROM pg_namespace WHERE nspname='v06';
  IF owner IS NOT NULL THEN
    EXECUTE format('SET LOCAL ROLE %I', owner);
    EXECUTE 'DROP SCHEMA IF EXISTS v06 CASCADE';
    RESET ROLE;
  END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'v06\_%' LOOP
    EXECUTE format('DROP OWNED BY %I', r.rolname);
    EXECUTE format('DROP ROLE %I', r.rolname);
  END LOOP;
END $$;
SQL
}

A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222

# Role names are unique per run, deliberately. Neon's pooler keeps cached server
# connections bound to a role's OID, so a name that is dropped and recreated serves
# "invalid role OID" and spurious permission-denied errors through the pooled endpoint
# until those connections cycle. Asserted below; the consequence for the product is in
# ADR-0009. Fixed names here would make this check intermittently and confusingly red.
RUN=$(date +%s)
RM="v06_${RUN}_migration"
RA="v06_${RUN}_app"
RR="v06_${RUN}_retention"

echo "════ region, version and the default role ════"
INFO=$(echo "SELECT current_setting('server_version') || '|' || current_user || '|' || current_setting('is_superuser');" | qs "$NEON_DATABASE_URL_DIRECT")
SRV=${INFO%%|*}; REST=${INFO#*|}; OWNER=${REST%%|*}; SU=${REST##*|}
HOST=$(echo "$NEON_DATABASE_URL_DIRECT" | sed -E 's|.*@([^/?]+).*|\1|')
REGION=$(echo "$HOST" | sed -E 's|.*\.([a-z]+-[a-z]+-[0-9]+)\..*|\1|')
echo "server_version : $SRV"
echo "region         : $REGION   (from the endpoint host)"
echo "default role   : $OWNER (is_superuser=$SU)"
case "$REGION" in eu-*) pass "the endpoint is in an EU region — decision 7 holds";;
                  *) fail "endpoint region '$REGION' is not in the EU. Decision 7 requires one EU region, completely.";; esac
[ "$SU" = "off" ] || fail "the default role is a superuser; FORCE ROW LEVEL SECURITY would be worthless against it"

echo
echo "════ the default role bypasses RLS — which is why the app must not use it ════"
BY=$(echo "SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;" | qs "$NEON_DATABASE_URL_DIRECT")
if [ "$BY" = "t" ]; then
  note "$OWNER has BYPASSRLS. Row-level security does not apply to it at all."
  note "This is the ADR-0001 trap, live on this platform: connecting the application as the"
  note "role Neon hands you would silently disable INV-TEN-001. The roles below are created"
  note "explicitly NOSUPERUSER NOBYPASSRLS for exactly this reason."
  pass "recorded: the provisioned role is unusable as an application role"
else
  pass "$OWNER does not hold BYPASSRLS"
fi

echo
echo "════ can a non-owner, non-bypassing role be created at all? ════"
# Neon's control plane intercepts CREATE ROLE and rejects weak passwords, so these are
# generated rather than fixed. They are never printed and the roles are dropped at the end.
PW_M="$(openssl rand -base64 27 | tr -d '/+=')Aa1"
PW_A="$(openssl rand -base64 27 | tr -d '/+=')Bb2"
PW_R="$(openssl rand -base64 27 | tr -d '/+=')Cc3"

teardown
DBNAME=$(echo "$NEON_DATABASE_URL_DIRECT" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')
cat <<SQL | qs "$NEON_DATABASE_URL_DIRECT" >/dev/null
CREATE ROLE ${RM} LOGIN PASSWORD '${PW_M}' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ${RA}       LOGIN PASSWORD '${PW_A}' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ${RR} LOGIN PASSWORD '${PW_R}' NOSUPERUSER NOBYPASSRLS;
GRANT CREATE ON DATABASE ${DBNAME} TO ${RM};
SQL
ATTRS=$(echo "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'v06\\_' || '${RUN}' || '\\_%' AND NOT rolsuper AND NOT rolbypassrls;" | qs "$NEON_DATABASE_URL_DIRECT")
[ "$ATTRS" = "3" ] || fail "expected 3 non-superuser, non-bypassing roles, got $ATTRS"
pass "three roles created by SQL, all NOSUPERUSER NOBYPASSRLS"
INH=$(cat <<'SQL' | qs "$NEON_DATABASE_URL_DIRECT"
SELECT count(*) FROM pg_auth_members m
  JOIN pg_roles g ON g.oid=m.roleid
  JOIN pg_roles c ON c.oid=m.member
 WHERE c.rolname LIKE 'v06\_%' AND (g.rolbypassrls OR g.rolsuper);
SQL
)
[ "$INH" = "0" ] || fail "a v06 role inherits BYPASSRLS or SUPERUSER through membership ($INH grants)"
pass "and none of them inherits BYPASSRLS or SUPERUSER through a role grant"

U_MIG=$(url_as "$NEON_DATABASE_URL_DIRECT" ${RM} "$PW_M")
U_MIG_P=$(url_as "$NEON_DATABASE_URL_POOLED" ${RM} "$PW_M")
U_APP=$(url_as  "$NEON_DATABASE_URL_DIRECT" ${RA} "$PW_A")
U_APP_P=$(url_as "$NEON_DATABASE_URL_POOLED" ${RA} "$PW_A")
U_RET_P=$(url_as "$NEON_DATABASE_URL_POOLED" ${RR} "$PW_R")

echo
echo "════ btree_gist — INV-EFF-002 has no level-2 enforcement without it ════"
echo "CREATE EXTENSION IF NOT EXISTS btree_gist;" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null
EXT=$(echo "SELECT extversion FROM pg_extension WHERE extname='btree_gist';" | qs "$NEON_DATABASE_URL_DIRECT" | tail -1)
pass "btree_gist $EXT is creatable (by $OWNER)"
MIGEXT=$(echo "CREATE EXTENSION IF NOT EXISTS btree_gist;" | q "$U_MIG" || true)
case "$MIGEXT" in *"permission denied"*|*ERROR*) note "${RM} alone cannot create it; the extension must be provisioned by $OWNER";;
                  *) pass "${RM} can create it too";; esac

echo
echo "════ schema and table owned by a NON-superuser, RLS enabled and FORCED ════"
cat <<SQL | qs "$U_MIG" >/dev/null
DROP SCHEMA IF EXISTS v06 CASCADE;
CREATE SCHEMA v06;
GRANT USAGE ON SCHEMA v06 TO ${RA}, ${RR};
CREATE TABLE v06.doc (
  tenant_id uuid NOT NULL,
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  title     text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
INSERT INTO v06.doc (tenant_id,title) VALUES ('${A}','tenant A doc'), ('${B}','tenant B doc');
ALTER TABLE v06.doc ENABLE ROW LEVEL SECURITY;
ALTER TABLE v06.doc FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v06.doc
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT ON v06.doc TO ${RA};

CREATE TABLE v06.audit_event (
  tenant_id uuid NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  payload text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
GRANT SELECT, INSERT ON v06.audit_event TO ${RA};
REVOKE UPDATE, DELETE, TRUNCATE ON v06.audit_event FROM ${RA};
GRANT SELECT, DELETE ON v06.audit_event TO ${RR};
SQL
OWN=$(echo "SELECT tableowner||'|'||rowsecurity::text FROM pg_tables WHERE schemaname='v06' AND tablename='doc';" | qs "$U_MIG")
FRC=$(echo "SELECT relforcerowsecurity FROM pg_class WHERE oid='v06.doc'::regclass;" | qs "$U_MIG")
[ "$OWN" = "${RM}|true" ] && [ "$FRC" = "t" ] || fail "table is not owned by ${RM} with RLS forced (got $OWN forced=$FRC)"
pass "v06.doc owned by ${RM}, RLS enabled and forced"

echo
echo "════ INV-TEN-001 — FORCE binds the owner; no context fails closed ════"
R=$(echo "SELECT count(*) FROM v06.doc;" | q "$U_MIG")
case "$R" in *ERROR*) pass "the non-superuser OWNER is refused with no tenant context — FORCE binds it";;
             *) fail "the owner read $R rows with no tenant context. FORCE is not binding. ADR-0001 has no fallback here — open a Decision Request.";; esac
R=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT count(*) FROM v06.doc; COMMIT;\n" "$A" | q "$U_MIG")
[ "$R" = "1" ] || fail "owner with tenant context saw '$R' rows, expected 1"
pass "and with a tenant context it sees exactly that tenant's row"

for ep in DIRECT POOLED; do
  [ "$ep" = DIRECT ] && U="$U_APP" || U="$U_APP_P"
  RA=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT title FROM v06.doc; COMMIT;\n" "$A" | q "$U")
  RB=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT title FROM v06.doc; COMMIT;\n" "$B" | q "$U")
  [ "$RA" = "tenant A doc" ] && [ "$RB" = "tenant B doc" ] \
    || fail "$ep: app_role saw '$RA' / '$RB'"
  pass "$ep: app_role sees only its own tenant, for two different tenants"
done

echo
echo "════ INV-TEN-002 — another tenant's identifier is NOT-FOUND, not forbidden ════"
BID=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT id FROM v06.doc; COMMIT;\n" "$B" | q "$U_APP_P" | head -1)
R=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT count(*) FROM v06.doc WHERE id='%s'; COMMIT;\n" "$A" "$BID" | q "$U_APP_P")
[ "$R" = "0" ] || fail "a real cross-tenant id returned '$R' — expected 0 rows and no error"
pass "a real id from another tenant returns zero rows, not an error"

echo
echo "════ SET LOCAL through the POOLER — the tenant-context leak test ════"
LEAK=$( { printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT title FROM v06.doc; COMMIT;\n" "$A"
          echo "SELECT count(*) FROM v06.doc;"; } | q "$U_APP_P" )
echo "$LEAK" | head -1 | grep -q "tenant A doc" || fail "the in-transaction read failed: $LEAK"
SECOND=$(echo "$LEAK" | tail -1)
case "$SECOND" in
  *ERROR*) pass "SET LOCAL does not survive its transaction through the pooler — the next statement fails closed" ;;
  *)       fail "tenant context LEAKED past its transaction through the pooler (got '$SECOND'). This is the most severe possible finding: open a Decision Request." ;;
esac
DIRECT_ERR=$(echo "SELECT count(*) FROM v06.doc;" | q "$U_APP" | head -1)
note "the two endpoints fail closed by DIFFERENT errors:"
note "  direct : ${DIRECT_ERR#*ERROR:  }"
note "  pooled : ${SECOND#*ERROR:  }"
note "Both refuse. But an application must never decide 'no tenant context' by matching the"
note "error: through the pooler the GUC survives as an empty string once any transaction on"
note "that backend has set it, so which error you get depends on connection reuse."

echo
echo "════ the pooler caches a role by OID — dropping and recreating a name poisons it ════"
PW_T="$(openssl rand -base64 27 | tr -d '/+=')Tt4"
RT="v06_${RUN}_churn"
printf "CREATE ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOBYPASSRLS;\n" "$RT" "$PW_T" | qs "$NEON_DATABASE_URL_DIRECT" >/dev/null
printf "GRANT USAGE ON SCHEMA v06 TO %s; GRANT SELECT ON v06.doc TO %s;\n" "$RT" "$RT" | qs "$U_MIG" >/dev/null
U_T=$(url_as "$NEON_DATABASE_URL_POOLED" "$RT" "$PW_T")
FIRST=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT title FROM v06.doc; COMMIT;\n" "$A" | q "$U_T")
[ "$FIRST" = "tenant A doc" ] || fail "the fresh role could not read through the pooler: $FIRST"
pass "a never-before-used role name works through the pooler immediately"

# now drop and recreate the SAME name, then use it again through the pooler
printf "GRANT %s TO CURRENT_USER WITH SET TRUE;\n" "$RT" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
printf "REVOKE ALL ON SCHEMA v06 FROM %s; REVOKE ALL ON v06.doc FROM %s;\n" "$RT" "$RT" | q "$U_MIG" >/dev/null 2>&1 || true
printf "DROP OWNED BY %s;\n" "$RT" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
printf "DROP ROLE %s;\n" "$RT" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
GONE=$(printf "SELECT count(*) FROM pg_roles WHERE rolname='%s';\n" "$RT" | qs "$NEON_DATABASE_URL_DIRECT")
[ "$GONE" = "0" ] || fail "could not drop $RT to test role churn (still present)"
printf "CREATE ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOBYPASSRLS;\n" "$RT" "$PW_T" | qs "$NEON_DATABASE_URL_DIRECT" >/dev/null
printf "GRANT USAGE ON SCHEMA v06 TO %s; GRANT SELECT ON v06.doc TO %s;\n" "$RT" "$RT" | qs "$U_MIG" >/dev/null
AGAIN=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; SELECT title FROM v06.doc; COMMIT;\n" "$A" | q "$U_T")
case "$AGAIN" in
  *"invalid role OID"*|*"permission denied"*)
    pass "after drop-and-recreate the SAME name fails through the pooler: ${AGAIN#*ERROR:  }"
    note "The pooled session is still bound to the dropped role's OID. The direct endpoint is"
    note "unaffected, and a query that should obviously succeed returns a privilege error."
    note "ADR-0009 establishes the three roles BY MIGRATION. A migration that ever drops and"
    note "recreates a role therefore breaks production through the pooled endpoint, in a way"
    note "that looks like an authorization bug and heals itself later. Create roles once and"
    note "ALTER them thereafter." ;;
  "tenant A doc")
    note "drop-and-recreate did NOT poison the pooler on this run. The behaviour may be timing"
    note "dependent, or Neon may have fixed it. Re-check before relying on either outcome." ;;
  *) fail "unexpected result after role churn: $AGAIN" ;;
esac
printf "GRANT %s TO CURRENT_USER WITH SET TRUE;\n" "$RT" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
printf "REVOKE ALL ON SCHEMA v06 FROM %s; REVOKE ALL ON v06.doc FROM %s;\n" "$RT" "$RT" | q "$U_MIG" >/dev/null 2>&1 || true
printf "DROP OWNED BY %s;\n" "$RT"       | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true
printf "DROP ROLE IF EXISTS %s;\n" "$RT" | q "$NEON_DATABASE_URL_DIRECT" >/dev/null 2>&1 || true

echo
echo "════ CREATE INDEX CONCURRENTLY — ADR-0009 predicted the pooler refuses it ════"
echo "DROP INDEX IF EXISTS v06.v06_ix_d; DROP INDEX IF EXISTS v06.v06_ix_p;" | q "$U_MIG" >/dev/null
D=$(echo "CREATE INDEX CONCURRENTLY v06_ix_d ON v06.doc (title);" | q "$U_MIG")
P=$(echo "CREATE INDEX CONCURRENTLY v06_ix_p ON v06.doc (tenant_id);" | q "$U_MIG_P")
HAVE=$(echo "SELECT count(*) FROM pg_indexes WHERE schemaname='v06' AND indexname IN ('v06_ix_d','v06_ix_p');" | qs "$U_MIG")
case "$HAVE" in
  2) pass "CREATE INDEX CONCURRENTLY succeeds through BOTH endpoints — ADR-0009's prediction is wrong on Neon" ;;
  *) note "direct: ${D:-ok}"; note "pooled: ${P:-ok}"
     note "only $HAVE of 2 indexes were built; ADR-0009's prediction holds and migrations that"
     note "use CREATE INDEX CONCURRENTLY need the direct endpoint" ;;
esac
INTX=$(echo "BEGIN; CREATE INDEX CONCURRENTLY v06_ix_tx ON v06.doc (id); COMMIT;" | q "$U_MIG_P" | head -1)
case "$INTX" in *"cannot run inside a transaction block"*) pass "and it is still refused inside an explicit transaction, so the harness must mark such migrations non-transactional";; *) note "unexpected: $INTX";; esac

echo
echo "════ INV-AUD-002 — append-only is a revoked privilege ════"
printf "BEGIN; SET LOCAL app.tenant_id='%s'; INSERT INTO v06.audit_event(tenant_id,payload) VALUES ('%s','appended'); COMMIT;\n" "$A" "$A" | q "$U_APP_P" >/dev/null
pass "app_role may append"
for stmt in "UPDATE v06.audit_event SET payload='x'" "DELETE FROM v06.audit_event" "TRUNCATE v06.audit_event"; do
  R=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; %s; COMMIT;\n" "$A" "$stmt" | q "$U_APP_P" | head -1)
  case "$R" in *"permission denied"*) pass "${stmt%% *} refused for app_role";;
               *) fail "${stmt%% *} was NOT refused for app_role: $R";; esac
done
R=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; DELETE FROM v06.audit_event; COMMIT;\n" "$A" | q "$U_RET_P" | head -1)
case "$R" in *ERROR*) fail "retention_role could not delete: $R";; *) pass "retention_role may dispose";; esac
R=$(printf "BEGIN; SET LOCAL app.tenant_id='%s'; INSERT INTO v06.audit_event(tenant_id,payload) VALUES ('%s','nope'); COMMIT;\n" "$A" "$A" | q "$U_RET_P" | head -1)
case "$R" in *"permission denied"*) pass "and retention_role may not append";; *) fail "retention_role could INSERT: $R";; esac

echo
echo "════ restore timing ════"
note "NOT MEASURED. Neon restores by creating a branch at a past instant, which is a"
note "control-plane operation available through the console or the Neon API — neither is"
note "reachable with a connection string alone."
note "To measure it: create a Neon API key, restore a branch to a timestamp, and time it"
note "end to end. Until then the disaster-recovery claim in the security documentation has"
note "no number behind it, and ADR-0009 asked for one."

echo
echo "════ cleanup ════"
teardown
pass "roles and schema removed"
echo
echo "════ neon platform checks complete ════"
