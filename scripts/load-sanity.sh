#!/usr/bin/env bash
# Load sanity: does the board stay usable with hundreds of cells and thousands of
# assignments? Builds a throwaway database, seeds volume, and MEASURES -- it
# prints numbers and asserts nothing, because the honest answer to "is this fast
# enough" is the maintainer's, not a test's.
#
#   scripts/load-sanity.sh              build, seed and measure (default)
#   scripts/load-sanity.sh --keep       leave load_test_db behind to poke at
#   scripts/load-sanity.sh --drop       just drop load_test_db and exit
#
# ⛔ IT NEVER TOUCHES THE DEV DATABASE. Everything happens in `load_test_db`,
# built from harness + migrations + seed exactly the way run-sql-test.sh builds
# its own scratch database, and dropped at the end unless --keep.
#
# ⚠️ WHY THE MEASUREMENT SIGNS IN. `board_window` is STABLE, not SECURITY
# DEFINER, so it runs as the CALLER and every row goes through RLS. Measured
# without a jwt sub, `app_current_org()` is NULL, the whole subtree is filtered
# away, and the function returns an empty payload in ~1.4ms no matter how much
# data is behind it. The first version of this measurement did exactly that and
# reported four scopes as indistinguishable. The session-106 numbers come from a
# real `authenticated` session with a real grant.
set -uo pipefail

C=supabase_db_production_scheduler
DB=load_test_db
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=0

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --drop)
      docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
        -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" >/dev/null && echo "dropped $DB"
      exit 0 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

run() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$1" -q -v ON_ERROR_STOP=1; }

if ! docker ps --format '{{.Names}}' | grep -q "^$C$"; then
  echo "The Supabase database container is not running. Start the stack first."
  exit 1
fi

echo "load-sanity: building $DB (harness + migrations + seed)"
docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
  -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" -c "CREATE DATABASE $DB;" >/dev/null
run "$DB" < "$ROOT/supabase/tests/00_harness.sql" >/dev/null 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do
  if ! out=$(run "$DB" < "$f" 2>&1); then
    echo "MIGRATION FAILED: $(basename "$f")"; echo "$out" | tail -5; exit 1
  fi
done
if ! out=$(run "$DB" < "$ROOT/supabase/seed.sql" 2>&1); then
  echo "SEED FAILED"; echo "$out" | tail -8; exit 1
fi

echo "load-sanity: seeding volume"
if ! out=$(run "$DB" < "$ROOT/scripts/load/fixture.sql" 2>&1); then
  echo "FIXTURE FAILED"; echo "$out" | tail -20; exit 1
fi
echo "$out" | grep -E "cells|nodes total|operators|runs|assignments" || true

echo
echo "load-sanity: board_window by scope"
run "$DB" < "$ROOT/scripts/load/measure.sql" 2>&1 | sed -n 's/^NOTICE:  //p'

echo
echo "load-sanity: where a plant-sized read spends its time"
run "$DB" < "$ROOT/scripts/load/breakdown.sql" 2>&1 | sed -n 's/^NOTICE:  //p'

echo
echo "load-sanity: the same rows with RLS bypassed, for contrast"
docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$DB" \
  < "$ROOT/scripts/load/rls-isolate.sql" 2>&1 | grep -iE "^===|Time:" | grep -vE "Time: 0\.[0-9]+ ms"

if [ "$KEEP" = "0" ]; then
  docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
    -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" >/dev/null
  echo
  echo "load-sanity: dropped $DB (pass --keep to leave it)"
fi
