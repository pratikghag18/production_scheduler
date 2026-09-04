#!/usr/bin/env bash
# Run ONE numbered supabase/tests file against a fresh (harness + all migrations
# + seed) database inside the running local Supabase Postgres container. This is
# the by-hand reproduction of verify-db.sh step 7 for this Windows machine, where
# verify-db.sh itself cannot run (it wants /usr/lib/postgresql/16/bin).
#
# Usage:  scripts/run-sql-test.sh 52_scope_and_colour_test.sql
#         scripts/run-sql-test.sh --rebuild            # just (re)build the DB
#
# It scans output for "NOTICE:  FAIL" and prints a PASS/FAIL tally. Exit 1 on any
# FAIL. The scratch DB (sql_test_db) is rebuilt only when --rebuild is passed or
# it does not exist, so repeated single-file runs are fast.
set -uo pipefail
C=supabase_db_production_scheduler
DB=sql_test_db
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$1" -q -v ON_ERROR_STOP=1; }

rebuild() {
  docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
    -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" -c "CREATE DATABASE $DB;" >/dev/null
  run "$DB" < "$ROOT/supabase/tests/00_harness.sql" >/dev/null 2>&1
  for f in "$ROOT"/supabase/migrations/*.sql; do
    if ! out=$(run "$DB" < "$f" 2>&1); then echo "MIGRATION FAILED: $(basename "$f")"; echo "$out"|tail -5; exit 1; fi
  done
  if ! out=$(run "$DB" < "$ROOT/supabase/seed.sql" 2>&1); then echo "SEED FAILED"; echo "$out"|tail -8; exit 1; fi
  echo "rebuilt $DB (harness + all migrations + seed)"
}

exists() { docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -tAc \
  "select 1 from pg_database where datname='$DB'" 2>/dev/null | grep -q 1; }

if [ "${1:-}" = "--rebuild" ]; then rebuild; exit 0; fi
exists || rebuild

TF="$ROOT/supabase/tests/${1:?usage: run-sql-test.sh <NN_name_test.sql>}"
[ -f "$TF" ] || { echo "no such test file: $TF"; exit 1; }
OUT=$(docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$DB" -f - < "$TF" 2>&1)
echo "$OUT" | grep -E "NOTICE:  (FAIL|PASS)|ERROR|EXCEPTION" | head -60
NF=$(echo "$OUT" | grep -c "NOTICE:  FAIL")
NP=$(echo "$OUT" | grep -c "NOTICE:  PASS")
ERR=$(echo "$OUT" | grep -cE "^psql:.*ERROR|^ERROR")
echo "---- $1 : $NP passed, $NF failed, $ERR hard-errors ----"
{ [ "$NF" -eq 0 ] && [ "$ERR" -eq 0 ]; }
