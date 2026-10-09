-- ============================================================================
-- 66_no_assignment_status_test.sql — migration 0043, "a deleted assignment is
-- deleted." (R-323)
--
-- WHAT IS ACTUALLY AT RISK HERE. Dropping the column is trivial; what is not is
-- that four functions filtered on it, and every one of those filters existed to
-- stop a CANCELLED row counting. Remove the column carelessly and the filters
-- come out with it — and the two rules those filters live inside are the two
-- that stop a person or a cell being committed twice:
--
--   * an operator may not be booked past their capacity in a window
--   * two active runs may not overlap on the same cell
--
-- So X2–X5 do not test the removal at all. They test that the guards still
-- REFUSE, which is the thing a careless removal would quietly switch off. A
-- suite that only checked "the column is gone" would pass on a database that
-- had stopped protecting anybody.
--
-- ⚠️ AS `authenticated`, WHEREVER RLS OR A GUARD IS THE POINT. psql connects as
-- the superuser, who bypasses RLS; a case about a refusal that forgets to
-- switch role can pass while proving nothing.
--
-- Fixture is the seed's: a1 the company admin on plant_1, a2 a supervisor on
-- plant_1.assembly, and the seeded runs and assignments underneath.
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed.
-- ============================================================================

BEGIN;

\echo 'X1: the column is gone, and so is the trigger clause that named it'
SAVEPOINT sp_X1;
DO $$
DECLARE v_col int; v_trg text;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_name = 'assignments' AND column_name = 'status';
  -- The capacity trigger named `status` in its own column list; if that had
  -- been left behind the DROP would have failed, so this is really asserting
  -- that the trigger was re-created rather than dropped and forgotten.
  SELECT pg_get_triggerdef(oid) INTO v_trg FROM pg_trigger
   WHERE tgname = 'assignments_capacity' AND NOT tgisinternal;
  IF v_col = 0 AND v_trg IS NOT NULL AND v_trg NOT LIKE '%status%' AND v_trg LIKE '%efficiency%'
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: status_columns=% (want 0) trigger=%', v_col, coalesce(v_trg,'MISSING'); END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2 ⭐ THE GUARD STILL BITES: an operator cannot be booked past capacity'
SAVEPOINT sp_X2;
DO $$
DECLARE v_node uuid; v_run uuid; v_op uuid; v_err text := 'no error'; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT a.node_id, a.run_id, a.operator_id INTO v_node, v_run, v_op
    FROM assignments a JOIN runs r ON r.id = a.run_id LIMIT 1;
  -- The same person, the same window, a second full-efficiency booking. The
  -- capacity trigger is what must refuse this, and it used to skip any row
  -- whose status was 'cancelled' — the clause that has just been removed.
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, run_id, timerange, efficiency)
    SELECT a.org_id, a.node_id, a.operator_id, a.run_id, a.timerange, 1.000
      FROM assignments a WHERE a.operator_id = v_op AND a.run_id = v_run LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM assignments WHERE operator_id = v_op AND run_id = v_run;
  RESET ROLE;
  IF v_err <> 'no error' AND v_n = 1
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: sqlstate=% (want a refusal) rows=% (want 1)', v_err, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3 ⭐ AND SO DOES THE OVERLAP RULE: two runs cannot share a cell and a window'
SAVEPOINT sp_X3;
DO $$
DECLARE v_run runs; v_err text := 'no error'; v_n int;
BEGIN
  RESET ROLE;
  SELECT * INTO v_run FROM runs LIMIT 1;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
    VALUES (v_run.org_id, v_run.node_id, v_run.product_id, v_run.timerange, 'planned', 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM runs WHERE node_id = v_run.node_id AND timerange = v_run.timerange;
  IF v_err <> 'no error' AND v_n = 1
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: sqlstate=% (want a refusal) rows=% (want 1)', v_err, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4 ⭐ THE NEW DELETE WORKS, and the audit log is what remembers it'
SAVEPOINT sp_X4;
DO $$
DECLARE v_id uuid; v_left int; v_audit int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT a.id INTO v_id FROM assignments a
    JOIN nodes n ON n.id = a.node_id WHERE n.path <@ 'plant_1'::ltree LIMIT 1;
  DELETE FROM assignments WHERE id = v_id;
  SELECT count(*) INTO v_left FROM assignments WHERE id = v_id;
  RESET ROLE;
  -- The row is gone AND the deletion is recorded with its actor. This is the
  -- claim that made removing the column safe rather than a loss of history.
  SELECT count(*) INTO v_audit FROM audit_log
   WHERE table_name = 'assignments' AND row_id = v_id AND action = 'delete' AND actor_id IS NOT NULL;
  IF v_left = 0 AND v_audit = 1
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: rows_left=% (want 0) audit_rows=% (want 1)', v_left, v_audit; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5 ⚠ and the delete is still SCOPED: a supervisor cannot delete outside their grant'
SAVEPOINT sp_X5;
DO $$
DECLARE v_id uuid; v_left int; v_deleted int;
BEGIN
  -- a2 is granted plant_1.assembly; this row is under plant_1.machining.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  RESET ROLE;
  SELECT a.id INTO v_id FROM assignments a
    JOIN nodes n ON n.id = a.node_id WHERE n.path <@ 'plant_1.machining'::ltree LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- ⚠️ THE POINT OF THIS CASE: an RLS-filtered DELETE matching no visible row
  -- removes NOTHING and raises NOTHING. It is a success with no effect, which
  -- is why the client checks the row count rather than trusting the absence of
  -- an error. Here we assert the same thing from the server's side.
  DELETE FROM assignments WHERE id = v_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RESET ROLE;
  SELECT count(*) INTO v_left FROM assignments WHERE id = v_id;
  IF v_id IS NOT NULL AND v_deleted = 0 AND v_left = 1
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: target=% deleted=% (want 0) rows_left=% (want 1)',
    coalesce(v_id::text,'NONE'), v_deleted, v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;

\echo 'X6: deleting a run still takes its assignments with it — the behaviour this one now matches'
SAVEPOINT sp_X6;
DO $$
DECLARE v_run uuid; v_before int; v_after int; v_runs int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT a.run_id INTO v_run FROM assignments a WHERE a.run_id IS NOT NULL LIMIT 1;
  SELECT count(*) INTO v_before FROM assignments WHERE run_id = v_run;
  PERFORM delete_run(v_run, 'cascade');
  SELECT count(*) INTO v_after FROM assignments WHERE run_id = v_run;
  SELECT count(*) INTO v_runs FROM runs WHERE id = v_run;
  RESET ROLE;
  IF v_before > 0 AND v_after = 0 AND v_runs = 0
  THEN RAISE NOTICE 'PASS X6';
  ELSE RAISE NOTICE 'FAIL X6: before=% (want >0) after=% (want 0) runs_left=% (want 0)',
    v_before, v_after, v_runs; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X6;

ROLLBACK;
