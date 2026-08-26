#!/usr/bin/env bash
# ==============================================================================
# scripts/verify-db.sh — brief P1-2 §5/§7
#
# Validates supabase/migrations, supabase/seed.sql and supabase/tests against
# a scratch PostgreSQL 16 instance (no Docker / no `supabase start` in this
# container — see the brief's §5 environment note). Idempotent and
# re-runnable: it tears down and recreates the scratch database every run, so
# nothing here needs its own idempotency games beyond that.
#
# Exit code is non-zero if any step fails.
# ==============================================================================
set -uo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/tmp/pgdata
PGSOCK=/tmp/pgsock
PGLOG=/tmp/pg_verify_log.txt
DB=scheduler_test
PGSUPERUSER=ubuntu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
TESTS_DIR="$REPO_ROOT/supabase/tests"
SEED_FILE="$REPO_ROOT/supabase/seed.sql"
HARNESS_FILE="$TESTS_DIR/00_harness.sql"
SCHEMA_MD="$REPO_ROOT/docs/schema.md"

FAILED=0
STEP_LOG=""

step() { echo; echo "=== $* ==="; }
note_fail() { FAILED=1; echo "!!! FAILED: $*"; STEP_LOG="${STEP_LOG}FAIL: $*"$'\n'; }
note_pass() { STEP_LOG="${STEP_LOG}PASS: $*"$'\n'; }

psql_su() {
  "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"
}

# ------------------------------------------------------------------------------
step "1. Locate PostgreSQL 16 (no install attempted, per brief §5)"
# ------------------------------------------------------------------------------
if [ ! -x "$PGBIN/initdb" ] || [ ! -x "$PGBIN/pg_ctl" ] || [ ! -x "$PGBIN/psql" ]; then
  echo "FATAL: PostgreSQL 16 binaries not found at $PGBIN."
  echo "Per brief §5 this script must not attempt to install anything — stopping."
  exit 1
fi
"$PGBIN/psql" --version
note_pass "PostgreSQL 16 binaries located at $PGBIN"

# ------------------------------------------------------------------------------
step "2. initdb (as ubuntu, not root) + start (unix socket only)"
# ------------------------------------------------------------------------------
# ------------------------------------------------------------------------------
# ENCODING IS LOAD-BEARING (design session, Aug 25 2026 — design plan §19.13).
#
# This script used to run a bare `initdb`. The container sets no locale, so
# PostgreSQL defaulted to **SQL_ASCII / C** — and every SQL test this project
# has ever run has therefore run on a database whose encoding and collation
# do NOT match Supabase, which is UTF-8.
#
# What that cost: any test touching non-ASCII text was not merely untested but
# UNWRITABLE — `chr(5760)` raises "requested character too large for encoding",
# so the whitespace-parity cases in 70_hierarchy_test.sql (W1–W7) could not
# even be expressed. `lower()` also stops doing Unicode case mapping, which is
# exactly what `slugify()` depends on.
#
# `C.utf8` is the only UTF-8 locale present in this container. It was MEASURED
# against an ICU `en-US` database on the full slugify corpus and every row
# agrees, so the collation *provider* does not change any answer here; the
# ENCODING is what mattered.
#
# The cluster is re-initialised if it exists with the wrong encoding, because a
# database's encoding cannot be changed after the fact.
# ------------------------------------------------------------------------------
PG_WANT_ENCODING=UTF8
PG_WANT_LOCALE=C.utf8

pgdata_encoding() {
  # Read the encoding initdb baked in, without needing the server running.
  [ -f "$PGDATA/PG_VERSION" ] || return 1
  grep -oP '(?<=^ENCODING = ).*' "$PGDATA/pg_control_stub" 2>/dev/null && return 0
  # No stub file in a normal cluster; ask the server if it is up, else assume unknown.
  if runuser -u "$PGSUPERUSER" -- "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    runuser -u "$PGSUPERUSER" -- "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d postgres \
      -tAc "select pg_encoding_to_char(encoding) from pg_database where datname='template1'" 2>/dev/null
  else
    echo UNKNOWN
  fi
}

if [ -f "$PGDATA/PG_VERSION" ]; then
  existing="$(pgdata_encoding || echo UNKNOWN)"
  if [ "$existing" != "$PG_WANT_ENCODING" ]; then
    echo "PGDATA at $PGDATA has encoding '${existing:-UNKNOWN}', not $PG_WANT_ENCODING — re-initialising."
    runuser -u "$PGSUPERUSER" -- "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA"
  else
    echo "PGDATA already initialised at $PGDATA with $PG_WANT_ENCODING, reusing."
  fi
fi

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  runuser -u "$PGSUPERUSER" -- "$PGBIN/initdb" -D "$PGDATA" --auth=trust -U "$PGSUPERUSER" \
    --encoding="$PG_WANT_ENCODING" --locale="$PG_WANT_LOCALE" \
    || { note_fail "initdb"; exit 1; }
fi

runuser -u "$PGSUPERUSER" -- mkdir -p "$PGSOCK"
chmod 0777 "$PGSOCK"

if runuser -u "$PGSUPERUSER" -- "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "PostgreSQL already running."
else
  runuser -u "$PGSUPERUSER" -- "$PGBIN/pg_ctl" -D "$PGDATA" \
    -o "-k $PGSOCK -h '' -c unix_socket_permissions=0777" \
    -l "$PGLOG" start \
    || { note_fail "pg_ctl start (see $PGLOG)"; cat "$PGLOG" 2>/dev/null; exit 1; }
  sleep 1
fi
chmod 0777 "$PGSOCK"
note_pass "PostgreSQL 16 running on unix socket $PGSOCK (no TCP)"

# ------------------------------------------------------------------------------
step "3. createdb scheduler_test (dropped and recreated fresh every run)"
# ------------------------------------------------------------------------------
runuser -u "$PGSUPERUSER" -- "$PGBIN/dropdb" -h "$PGSOCK" --if-exists "$DB" \
  || { note_fail "dropdb"; exit 1; }
runuser -u "$PGSUPERUSER" -- "$PGBIN/createdb" -h "$PGSOCK" \
  --encoding="$PG_WANT_ENCODING" --locale="$PG_WANT_LOCALE" --template=template0 "$DB" \
  || { note_fail "createdb"; exit 1; }

# Assert it, rather than trusting it — this is the check whose absence let the
# suite run on SQL_ASCII for four days.
db_enc="$(runuser -u "$PGSUPERUSER" -- "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d "$DB" \
  -tAc "select pg_encoding_to_char(encoding) from pg_database where datname = current_database()")"
if [ "$db_enc" != "$PG_WANT_ENCODING" ]; then
  note_fail "database $DB has encoding $db_enc, expected $PG_WANT_ENCODING"
  exit 1
fi
note_pass "database $DB created fresh ($db_enc, locale $PG_WANT_LOCALE — matches Supabase's UTF-8)"

# ------------------------------------------------------------------------------
step "4. Apply supabase/tests/00_harness.sql (test-only auth shim)"
# ------------------------------------------------------------------------------
psql_su -f "$HARNESS_FILE" || { note_fail "00_harness.sql"; exit 1; }
note_pass "00_harness.sql applied"

# ------------------------------------------------------------------------------
step "5. Apply every migration in filename order"
# ------------------------------------------------------------------------------
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "--- $(basename "$f") ---"
  psql_su -f "$f" || { note_fail "migration $(basename "$f")"; exit 1; }
done
note_pass "all $(ls "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ') migrations applied cleanly"

# ------------------------------------------------------------------------------
step "5b/5c. Upgrade paths: migrations that TRANSFORM EXISTING DATA"
# ------------------------------------------------------------------------------
# WHY THESE STEPS EXIST AT ALL. Every numbered test in supabase/tests runs
# against a database where all migrations have ALREADY been applied to an empty
# schema, so any migration whose job is to transform existing data runs against
# ZERO ROWS and is, in effect, untested. Two have now been caught by this:
#
#   0019  a backfill that read can_edit=true as 'admin' would have handed every
#         existing subtree grantee the hierarchy, on the morning of the upgrade,
#         with a fully green suite.
#   0020  its backfill IS a no-op here, by construction -- and the first run of
#         it left every template unowned, silently, while the suite was green.
#
# Each check below builds its own database, applies migrations STOPPING AT the
# one under test, plants a fixture in the old shape, applies that one migration,
# and asserts. Stopping (rather than skipping) matters: a skip would apply every
# LATER migration against a schema missing the column the upgrade is about.
#
# THIS IS THE PATTERN FOR ANY FUTURE DATA-TRANSFORMING MIGRATION: add a row to
# UPGRADE_CHECKS and a file that takes the migration path as :mig.
#
# Format: <stop-at migration basename>|<test file basename>|<expected PASS count>
UPGRADE_CHECKS="
20260826000019_scoped_roles.sql|upgrade_0019_backfill.sql|5
20260826000020_site_ownership.sql|upgrade_0020_site_ownership.sql|5
"

run_upgrade_check() {
  local stop_at="$1" test_file="$2" want_pass="$3"
  local db="scheduler_upgrade_${stop_at%%_*}"
  local mig="$MIGRATIONS_DIR/$stop_at"
  local tf="$TESTS_DIR/$test_file"

  if [ ! -f "$mig" ] || [ ! -f "$tf" ]; then
    note_fail "upgrade check: $mig or $tf missing"; return
  fi

  runuser -u "$PGSUPERUSER" -- "$PGBIN/dropdb" -h "$PGSOCK" --if-exists "$db" >/dev/null 2>&1
  runuser -u "$PGSUPERUSER" -- "$PGBIN/createdb" -h "$PGSOCK" \
    --encoding="$PG_WANT_ENCODING" --locale="$PG_WANT_LOCALE" --template=template0 "$db"

  local ok=1
  "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d "$db" -v ON_ERROR_STOP=1 -q \
    -f "$HARNESS_FILE" >/dev/null 2>&1 || ok=0
  for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    [ "$(basename "$f")" = "$stop_at" ] && break
    "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d "$db" -v ON_ERROR_STOP=1 -q \
      -f "$f" >/dev/null 2>&1 || { ok=0; echo "upgrade check: failed applying $(basename "$f")"; break; }
  done

  if [ "$ok" -ne 1 ]; then
    note_fail "upgrade check $test_file: could not build a database stopping at $stop_at"
  else
    local out; out=$(mktemp)
    # ON_ERROR_STOP off: these files report per-case with RAISE NOTICE, the same
    # idiom as 70/80, and are SCANNED for NOTICE: FAIL rather than trusted to
    # exit non-zero. An expected PASS count is asserted too, so a file that dies
    # halfway cannot look like a pass.
    ( cd "$REPO_ROOT" && "$PGBIN/psql" -h "$PGSOCK" -U "$PGSUPERUSER" -d "$db" \
        -v "mig=$mig" -f "$tf" ) > "$out" 2>&1
    cat "$out"
    local n_fail n_pass
    n_fail=$(grep -c "NOTICE:  FAIL" "$out" || true)
    n_pass=$(grep -c "NOTICE:  PASS" "$out" || true)
    if [ "$n_fail" -ne 0 ] || [ "$n_pass" -ne "$want_pass" ]; then
      note_fail "$test_file ($n_pass passed, $n_fail failed; expected $want_pass passed, 0 failed)"
    else
      note_pass "$test_file ($n_pass cases, real upgrade stopping at $stop_at)"
    fi
    rm -f "$out"
  fi
  runuser -u "$PGSUPERUSER" -- "$PGBIN/dropdb" -h "$PGSOCK" --if-exists "$db" >/dev/null 2>&1
}

# HERE-STRING, NOT A PIPE. `echo ... | while` runs the loop in a SUBSHELL, so
# every note_fail inside it would set FAILED=1 in a process that then exits --
# the script would print the failure and still exit 0. That is the third
# distinct way this harness has managed to report a pass over a failure (see
# [[verify-db-harness-drift]]); a here-string keeps the loop in this shell.
while IFS='|' read -r stop_at test_file want_pass; do
  [ -z "$stop_at" ] && continue
  echo "--- $test_file ---"
  run_upgrade_check "$stop_at" "$test_file" "$want_pass"
done <<< "$UPGRADE_CHECKS"

# ------------------------------------------------------------------------------
step "6. Apply supabase/seed.sql"
# ------------------------------------------------------------------------------
psql_su -f "$SEED_FILE" || { note_fail "seed.sql"; exit 1; }
note_pass "seed.sql applied"

# ------------------------------------------------------------------------------
step "7. Run supabase/tests/[1-9]*.sql in order"
# ------------------------------------------------------------------------------
# EXTENDED BY BRIEF P1-3a §8/§6: 60_api_test.sql (P1-3a's own test file) must
# run after 50_audit_test.sql. Filename-sorted glob order already places it
# there on its own ("50_..." < "60_..." lexically), so the loop below is
# unchanged; this guard just makes the requirement explicit and fails loudly
# if the file is ever missing, instead of silently running one fewer test.
if [ ! -f "$TESTS_DIR/60_api_test.sql" ]; then
  note_fail "60_api_test.sql not found in $TESTS_DIR (brief P1-3a §8 requires it to run after 50_audit_test.sql)"
  exit 1
fi
# EXTENDED BY BRIEF P1-5a §3: 70_hierarchy_test.sql (P1-5a's own test file)
# must run after 60_api_test.sql. Filename-sorted glob order already places
# it there on its own ("60_..." < "70_..." lexically), so the loop below is
# unchanged; this guard just makes the requirement explicit, same idiom as
# the 60_api_test.sql guard immediately above.
if [ ! -f "$TESTS_DIR/70_hierarchy_test.sql" ]; then
  note_fail "70_hierarchy_test.sql not found in $TESTS_DIR (brief P1-5a §3 requires it to run after 60_api_test.sql)"
  exit 1
fi
# ------------------------------------------------------------------------------
# A NON-ZERO EXIT CODE IS NOT THE ONLY WAY A TEST FILE FAILS (design session,
# Aug 25 2026 -- design plan §19.17 / D85).
#
# 70_hierarchy_test.sql and 80_cross_org_test.sql report per-case results with
# `RAISE NOTICE 'PASS x'` / `RAISE NOTICE 'FAIL x'`, and wrap each case in
# `EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL ...'`. A NOTICE is not an
# error: psql exits 0 no matter how many cases failed. This loop used to test
# only the exit code, so for as long as that idiom has existed the harness has
# been able to print
#
#     PASS: 70_hierarchy_test.sql
#
# for a run in which EIGHT cases printed FAIL -- which is exactly what it did,
# hiding the `create_node` regression that migration 0013 fixes.
#
# The output is now scanned for `NOTICE:  FAIL` as well. A file that emits ZERO
# `NOTICE:  PASS` lines is not treated as suspicious: 10-60 use a different
# idiom (raise an exception on failure) and legitimately emit neither.
# ------------------------------------------------------------------------------
# EXTENDED BY D86: 90_hierarchy_template_test.sql must run after
# 80_cross_org_test.sql. Filename-sorted glob order already places it there;
# this guard makes the requirement explicit and fails loudly if the file goes
# missing, instead of silently running one fewer test -- the same idiom as the
# 60_ and 70_ guards above.
if [ ! -f "$TESTS_DIR/90_hierarchy_template_test.sql" ]; then
  note_fail "90_hierarchy_template_test.sql not found in $TESTS_DIR (D86 requires it to run after 80_cross_org_test.sql)"
  exit 1
fi
for f in $(ls "$TESTS_DIR"/[1-9]*.sql | sort); do
  echo "--- $(basename "$f") ---"
  out_file=$(mktemp)
  if psql_su -f "$f" > "$out_file" 2>&1; then
    exit_ok=1
  else
    exit_ok=0
  fi
  cat "$out_file"
  n_fail=$(grep -c "NOTICE:  FAIL" "$out_file" || true)
  n_pass=$(grep -c "NOTICE:  PASS" "$out_file" || true)
  if [ "$exit_ok" -ne 1 ]; then
    note_fail "$(basename "$f") (psql exited non-zero)"
  elif [ "$n_fail" -ne 0 ]; then
    note_fail "$(basename "$f") ($n_fail case(s) reported FAIL via RAISE NOTICE; $n_pass reported PASS)"
  elif [ "$n_pass" -ne 0 ]; then
    note_pass "$(basename "$f") ($n_pass cases)"
  else
    note_pass "$(basename "$f")"
  fi
  rm -f "$out_file"
done

# ------------------------------------------------------------------------------
step "8a. Acceptance item 30: EXPLAIN the board-window query (subtree x time, as Admin)"
# ------------------------------------------------------------------------------
# NOTE: the seed dataset is intentionally tiny (12 assignment rows, 7 cells),
# so PostgreSQL's cost-based planner will correctly prefer a plain sequential
# scan over these indexes at this scale -- that is the right call by the
# planner, not a defect in the indexes. To demonstrate that the gist indexes
# ARE usable and correct (which is what item 30 is actually checking), this
# run disables sequential scans for the EXPLAIN so the planner is forced onto
# the index path; at production data volumes (thousands+ of assignments) the
# planner would choose these indexes on its own, with enable_seqscan left on.
EXPLAIN_OUT=$(mktemp)
psql_su <<'SQL' > "$EXPLAIN_OUT" 2>&1
BEGIN;
SET LOCAL enable_seqscan = off;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
EXPLAIN (ANALYZE, BUFFERS)
SELECT a.* FROM assignments a
JOIN nodes n ON n.id = a.node_id
WHERE n.org_id = '10000000-0000-0000-0000-000000000001'
  AND n.path <@ 'plant_1'
  AND a.timerange && tstzrange('2026-01-01', '2027-01-01');
ROLLBACK;
SQL
cat "$EXPLAIN_OUT"
if grep -qi "Seq Scan on assignments" "$EXPLAIN_OUT"; then
  note_fail "item 30: EXPLAIN shows a sequential scan on assignments even with enable_seqscan=off"
else
  note_pass "item 30: EXPLAIN plan captured (see output above / docs/schema.md appendix), no seq scan on assignments"
fi

# ------------------------------------------------------------------------------
step "8b. Acceptance item 31: \\d+ every table, appended to docs/schema.md"
# ------------------------------------------------------------------------------
TABLES="orgs hierarchy_templates hierarchy_levels nodes operators products skills operator_skills node_skill_requirements runs assignments shift_templates shifts shift_breaks node_shift_templates user_profiles profile_grants audit_log"

mkdir -p "$(dirname "$SCHEMA_MD")"
cat > "$SCHEMA_MD" <<'MD'
# Schema reference

> **Migrations are append-only.** Anything wrong here is fixed by a new
> migration, never by editing one that has already run.

## Tables

| Table | Purpose |
|---|---|
| `orgs` | One row per tenant. Carries `settings` (capacity cap, eligibility policy, week start, snap default). |
| `hierarchy_templates` | A named hierarchy SHAPE within an org (D86). One org may hold several, so different sites can be organised differently. |
| `hierarchy_levels` | One template's ordered level list (Site/Department/Line/Work Cell, or whatever the site names them). Exactly one level per TEMPLATE may be `is_schedulable` — not one per org. |
| `nodes` | Every unit at every level, self-referencing tree. `path` (ltree) is trigger-maintained from `parent_id`/`name` — never supplied by callers. |
| `operators` | The roster. `home_node_id` is a default site/department for roster filtering. |
| `products` | The catalog. No color column — color is a UI-only sku-to-token mapping. |
| `skills` | Named certifications. |
| `operator_skills` | Who holds which skill, with optional expiry. |
| `node_skill_requirements` | A skill required at a node; inherits down the subtree (ancestor union query). |
| `runs` | "This cell produces this product during this window." No two active runs may overlap on the same node (`runs_no_overlap_on_node`). |
| `assignments` | "This operator staffs this cell during this window." Either run-attached (`run_id` set, product inherited) or direct (`product_id` set on the row) — never both, never neither. |
| `shift_templates` / `shifts` / `shift_breaks` | Named daily patterns, their shifts, and breaks within those shifts. Times are minutes-from-midnight; `end_min` may exceed 1440 for overnight shifts. |
| `node_shift_templates` | Which template applies at a node; nearest-ancestor-wins resolution via `resolve_shift_template()`. |
| `user_profiles` | One row per app user (`user_id` -> `auth.users`), role, and default creation-mode preference. |
| `profile_grants` | Subtree grants: which node subtree a profile may see/edit, and whether that grant includes write access. |
| `audit_log` | Append-only log of `runs`/`assignments` insert/update/delete, written only by a `SECURITY DEFINER` trigger. Admin-read-only. |

## The four invariants

1. **An operator's instantaneous load never exceeds their org's capacity cap.** Enforced by the `check_operator_capacity()` trigger on `assignments` (migration 0004) — an instant-wise peak calculation (not a naive sum), advisory-locked per operator so two concurrent writers can't both squeeze past the cap.
2. **A run's cell has no overlapping run.** Enforced by the `runs_no_overlap_on_node` exclusion constraint (migration 0003) — a database invariant, not a UI check, so a cross-cell run move that lands on an occupied cell is refused outright.
3. **A run-attached assignment's node always matches its run's node.** Enforced by the `assignments_run_consistency` trigger (migration 0003) — the API moves a run and its crew together; the database refuses a half-completed move.
4. **Cross-tenant rows cannot exist.** Every child table carries `org_id` and references its parent through a composite `(org_id, parent_id)` foreign key, so a row in one org can never reference a row in another — structurally, not just via RLS.

## Known deferrals

- **Timezone (D10).** Seed data anchors day 0 to the Monday of the current week in UTC. Per-site timezone is not yet a design decision; UTC is the honest placeholder until it is.
- **Not built in Phase 1** (per design-plan §17): `assignments_archive` + retention job, partitioning, `integration_connections`, Copy Week / templates.
- **`src/lib/database.types.ts`** is left as the P1-1 placeholder — `npm run db:types` needs a running local Supabase (Docker), unavailable in this container. Run `npm run db:start && npm run db:reset && npm run db:types` on a machine with Docker to generate real types.

## Validation posture

Validated against a scratch PostgreSQL 16 instance in the build container (no Docker, no `supabase start`) using `supabase/tests/00_harness.sql` — a test-only shim providing `auth.users`/`auth.uid()`/the `authenticated`/`anon` roles, applied only by `scripts/verify-db.sh`, never as a migration. The one thing the shim cannot prove is the real `auth.users` foreign key against actual Supabase Auth — confirm that by running `supabase db reset` on a machine with Docker.

---

## Appendix: `\d+` for every table

Generated by `scripts/verify-db.sh` against the scratch database on each run — always current as of the last verification run.

MD

for t in $TABLES; do
  echo '```' >> "$SCHEMA_MD"
  echo "\\d+ $t" >> "$SCHEMA_MD"
  psql_su -c "\d+ $t" >> "$SCHEMA_MD" 2>&1
  echo '```' >> "$SCHEMA_MD"
  echo >> "$SCHEMA_MD"
done
TABLE_COUNT=$(echo "$TABLES" | wc -w)
note_pass "item 31: docs/schema.md written with \\d+ appendix for all $TABLE_COUNT tables"

# ------------------------------------------------------------------------------
step "Summary"
# ------------------------------------------------------------------------------
echo "$STEP_LOG"
if [ "$FAILED" -ne 0 ]; then
  echo "verify-db.sh: ONE OR MORE STEPS FAILED"
  exit 1
else
  echo "verify-db.sh: all steps passed"
  exit 0
fi
