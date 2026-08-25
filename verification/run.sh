#!/usr/bin/env bash
# Runs every platform check in order against the local Docker environment.
#
#   docker compose up -d && ./verification/run.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres pg_isready -U postgres -d policyoffice >/dev/null 2>&1 \
  || { echo "postgres is not up. run: docker compose up -d" >&2; exit 1; }

./verification/00-roles.sh > /dev/null
echo "roles ready"
echo
for f in $(ls verification/0[1-9]-* 2>/dev/null | sort); do
  name=$(basename "$f")
  echo "════ $name ════"
  case "$f" in
    *.sh)  bash "$f" ;;
    *.sql) docker compose exec -T -e PGPASSWORD=postgres postgres \
             psql -U postgres -d policyoffice -v ON_ERROR_STOP=1 -f - < "$f" ;;
  esac
  echo
done
echo "════ all platform checks passed ════"
