#!/usr/bin/env bash
# Run ONE numbered supabase/tests file against a fresh (harness + all migrations
# + seed) database inside the running local Supabase Postgres container. This is
# the by-hand reproduction of verify-db.sh step 7 for this Windows machine, where
# verify-db.sh itself cannot run (it wants /usr/lib/postgresql/16/bin).
#
# Usage:  scripts/run-sql-test.sh 52_scope_and_colour_test.sql
#         scripts/run-sql-test.sh --rebuild            # just (re)build the DB
#         scripts/run-sql-test.sh --demo               # the demo world (see below)
#
# It scans output for "NOTICE:  FAIL" and prints a PASS/FAIL tally. Exit 1 on any
# FAIL. The scratch DB (sql_test_db) is rebuilt only when --rebuild is passed or
# it does not exist, so repeated single-file runs are fast.
#
# ---------------------------------------------------------------------------
# ⭐ `--demo` AND WHY IT HAS A DATABASE OF ITS OWN (DEF-0006).
#
# `supabase/dev_demo.sql` is the fixture the running app actually shows, and it
# was on no runner's path: the SQL suite builds from the migrations and
# `seed.sql`, vitest never touches SQL. So migration 0044 could drop
# `runs.status` while the demo kept naming it, and nothing went red -- the file
# simply died part-way through on the next `db:reset`, leaving a HALF-BUILT
# world (plants and people in, no runs) that reads on screen as a product with
# no data. R-D112 had `verified_by: []` and now does not.
#
# ⛔ IT CANNOT SHARE `sql_test_db`. `dev_demo.sql` opens by DELETING org 1's
# seeded content, and about eighteen cases across eight files rest on org 1
# holding exactly one structure (config.toml records the measurement). The main
# loop does not rebuild between files, so a demo run against the shared database
# would leave every later file -- and every later single-file run -- silently
# reading the wrong world. Hence a second database, `sql_demo_db`, built and
# thrown away by this mode alone.
#
# ⚠️ THE APPLY IS HALF THE TEST. `-v ON_ERROR_STOP=1` means any error anywhere
# in `dev_demo.sql` fails this mode -- which is the half that would have caught
# DEF-0006, because the file's own assertions sit at the FOOT and a file that
# dies at line 414 never reaches them. `dev_demo_test.sql` is the other half:
# it asks the built world the questions R-D112 actually makes, from outside.
# ---------------------------------------------------------------------------
set -uo pipefail
C=supabase_db_production_scheduler
DB=sql_test_db
DEMO_DB=sql_demo_db
DEMO_TEST=dev_demo_test.sql
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$1" -q -v ON_ERROR_STOP=1; }

# Build $1 from harness + every migration + seed. With a second argument, also
# apply dev_demo.sql on top -- the same order `supabase db reset` uses, which is
# `config.toml`'s `sql_paths = ["./seed.sql", "./dev_demo.sql"]`.
build() {
  local db="$1" with_demo="${2:-}"
  docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
    -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" -c "CREATE DATABASE $db;" >/dev/null
  run "$db" < "$ROOT/supabase/tests/00_harness.sql" >/dev/null 2>&1
  for f in "$ROOT"/supabase/migrations/*.sql; do
    if ! out=$(run "$db" < "$f" 2>&1); then echo "MIGRATION FAILED: $(basename "$f")"; echo "$out"|tail -5; exit 1; fi
  done
  if ! out=$(run "$db" < "$ROOT/supabase/seed.sql" 2>&1); then echo "SEED FAILED"; echo "$out"|tail -8; exit 1; fi
  if [ -n "$with_demo" ]; then
    if ! out=$(run "$db" < "$ROOT/supabase/dev_demo.sql" 2>&1); then
      echo "DEV_DEMO FAILED -- the demo world did not finish building."
      echo "$out" | tail -20
      exit 1
    fi
    echo "built $db (harness + all migrations + seed + dev_demo)"
  else
    echo "rebuilt $db (harness + all migrations + seed)"
  fi
}

rebuild() { build "$DB"; }

exists() { docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -tAc \
  "select 1 from pg_database where datname='$1'" 2>/dev/null | grep -q 1; }

tally() { # $1 = psql output, $2 = label
  echo "$1" | grep -E "NOTICE:  (FAIL|PASS)|ERROR|EXCEPTION" | head -60
  local nf np err
  nf=$(echo "$1" | grep -c "NOTICE:  FAIL")
  np=$(echo "$1" | grep -c "NOTICE:  PASS")
  err=$(echo "$1" | grep -cE "^psql:.*ERROR|^ERROR")
  echo "---- $2 : $np passed, $nf failed, $err hard-errors ----"
  { [ "$nf" -eq 0 ] && [ "$err" -eq 0 ]; }
}

if [ "${1:-}" = "--rebuild" ]; then rebuild; exit 0; fi

if [ "${1:-}" = "--demo" ]; then
  # Always from scratch: dev_demo.sql is idempotent by construction, but the
  # point of this mode is that a CLEAN database plus this file produces the
  # whole world, which is what `db:reset` does to the machine you sign in on.
  build "$DEMO_DB" with-demo || exit 1
  TF="$ROOT/supabase/tests/$DEMO_TEST"
  [ -f "$TF" ] || { echo "no such test file: $TF"; exit 1; }
  OUT=$(docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$DEMO_DB" -f - < "$TF" 2>&1)
  tally "$OUT" "$DEMO_TEST"
  rc=$?
  docker exec -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q \
    -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE);" >/dev/null 2>&1
  exit $rc
fi

exists "$DB" || rebuild

TF="$ROOT/supabase/tests/${1:?usage: run-sql-test.sh <NN_name_test.sql> | --rebuild | --demo}"
[ -f "$TF" ] || { echo "no such test file: $TF"; exit 1; }
OUT=$(docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d "$DB" -f - < "$TF" 2>&1)
tally "$OUT" "$1"
