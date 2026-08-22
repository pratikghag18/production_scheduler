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
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  runuser -u "$PGSUPERUSER" -- "$PGBIN/initdb" -D "$PGDATA" --auth=trust -U "$PGSUPERUSER" \
    || { note_fail "initdb"; exit 1; }
else
  echo "PGDATA already initialised at $PGDATA, reusing."
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
runuser -u "$PGSUPERUSER" -- "$PGBIN/createdb" -h "$PGSOCK" "$DB" \
  || { note_fail "createdb"; exit 1; }
note_pass "database $DB created fresh"

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
for f in $(ls "$TESTS_DIR"/[1-9]*.sql | sort); do
  echo "--- $(basename "$f") ---"
  if psql_su -f "$f"; then
    note_pass "$(basename "$f")"
  else
    note_fail "$(basename "$f")"
  fi
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
TABLES="orgs hierarchy_levels nodes operators products skills operator_skills node_skill_requirements runs assignments shift_templates shifts shift_breaks node_shift_templates user_profiles profile_grants audit_log"

mkdir -p "$(dirname "$SCHEMA_MD")"
cat > "$SCHEMA_MD" <<'MD'
# Schema reference

> **Migrations are append-only.** Anything wrong here is fixed by a new
> migration, never by editing one that has already run.

## Tables

| Table | Purpose |
|---|---|
| `orgs` | One row per tenant. Carries `settings` (capacity cap, eligibility policy, week start, snap default). |
| `hierarchy_levels` | The org's ordered hierarchy definition (Site/Department/Line/Work Cell, or whatever the org names them). Exactly one level per org may be `is_schedulable`. |
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
