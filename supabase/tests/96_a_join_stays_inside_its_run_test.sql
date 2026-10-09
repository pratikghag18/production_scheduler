-- ============================================================================
-- 96_a_join_stays_inside_its_run_test.sql --- migration 0079 (F-131 / R-383).
--
-- A block that joins a run lies inside that run's hours, or the server
-- refuses with a named reason (`outside_run`). The check lives in
-- create_assignment's run branch, after app_can_edit_node and before
-- check_eligibility; a direct (product-attached) block is untouched.
--
-- Every answer and refusal is measured as `authenticated` with a real jwt
-- sub: psql connects as the superuser, who bypasses RLS and whose
-- app_current_org() is NULL, which is NOT the context these cases are about.
--
-- FIXTURE --- the SEED's org 1 (Northwind), whose shape is fixed (as
-- 88_absences_test.sql uses it):
--   Plant 1 (root 30..01)
--     Assembly (30..02)          <- Ana supervises (a2)
--       Line 1 (30..04)
--         Cell 1 (30..07)        <- schedulable; where runs are placed
--   People: Elena (50..04) home Assembly, owned by Plant 1
--   Product: Widget X (60..01), made at Plant 1
--   a1 company admin; a viewer (b1) added below with a viewer grant on Plant 1.
--
-- Runs are placed in a clean future week, 2028-05-01 onward (past every date
-- 88_absences_test.sql uses, so a shared scratch database never carries a
-- stray run or absence from that file into this one's dates by accident).
--
-- CASES
--   J0  premises: create_assignment's current definition contains
--       `outside_run` (pg_get_functiondef), and api_raise raises PT409
--   J1  a join fully inside the run succeeds; the row reads back with
--       run_id set and the timerange asked for
--   J2  a join starting before the run is refused `outside_run`; the DETAIL
--       carries run_id, node_id, run_timerange, timerange; no row written
--   J3  a join ending after the run is refused the same way
--   J4  a join equal to the run's whole window succeeds (@> is inclusive of
--       equality --- the boundary assignmentFitsRun also accepts)
--   J5  a DIRECT block (p_product_id, no run) is untouched by this rule
--   J6  order: a signed-in VIEWER joining with an outside span gets
--       not_permitted, not outside_run (the permission check comes first)
--   J7  an unknown p_run_id is refused invalid_argument naming p_run_id
--   J8  move_run of a staffed run still succeeds with the new definition
--       installed (its crew UPDATE is not a join; proves the check does not
--       leak beyond create_assignment)
-- ============================================================================

BEGIN;

-- A viewer with a read-everything grant on Plant 1, for J6 (same fixture
-- 88_absences_test.sql seeds for its own AB6).
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'vic@northwind.example') ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000b1', 'viewer', 'run') ON CONFLICT DO NOTHING;
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', 'viewer') ON CONFLICT DO NOTHING;

\echo 'J0: premises --- create_assignment contains outside_run; api_raise raises PT409'
SAVEPOINT sp_J0;
DO $$
DECLARE v_def text; v_sqlstate text; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT pg_get_functiondef(
    'create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)'::regprocedure
  ) INTO v_def;
  IF v_def NOT ILIKE '%outside_run%' THEN v_ok := false; v_why := v_why || ' create_assignment has no outside_run'; END IF;
  BEGIN
    PERFORM api_raise('outside_run', 'probe', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'PT409' THEN v_ok := false; v_why := v_why || format(' api_raise sqlstate=%s (not PT409)', SQLSTATE); END IF;
  END;
  IF v_ok THEN RAISE NOTICE 'PASS J0'; ELSE RAISE NOTICE 'FAIL J0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL J0: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J0;

\echo 'J1: a join fully INSIDE the run succeeds; the row reads back with run_id and the timerange asked for'
SAVEPOINT sp_J1;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run_win tstzrange := tstzrange('2028-05-01 08:00+00','2028-05-01 16:00+00');
        v_asg_win tstzrange := tstzrange('2028-05-01 10:00+00','2028-05-01 14:00+00');
        v_run jsonb; v_run_id uuid; v_res jsonb; v_asg_id uuid;
        v_row_run_id uuid; v_row_range tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_run_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_res := create_assignment(v_cell, v_el, v_run_id, NULL, v_asg_win);
  v_asg_id := (v_res->'assignment'->>'id')::uuid;
  RESET ROLE;
  IF v_asg_id IS NULL THEN v_ok := false; v_why := v_why || ' no assignment id returned'; END IF;
  SELECT run_id, timerange INTO v_row_run_id, v_row_range FROM assignments WHERE id = v_asg_id;
  IF v_row_run_id IS DISTINCT FROM v_run_id THEN v_ok := false; v_why := v_why || ' run_id not set on the row'; END IF;
  IF v_row_range IS DISTINCT FROM v_asg_win THEN v_ok := false; v_why := v_why || ' timerange on the row does not match what was asked'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS J1'; ELSE RAISE NOTICE 'FAIL J1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J1;

\echo 'J2: a join STARTING BEFORE the run is refused outside_run; DETAIL carries run_id/node_id/run_timerange/timerange; no row written'
SAVEPOINT sp_J2;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run_win tstzrange := tstzrange('2028-05-02 08:00+00','2028-05-02 16:00+00');
        v_asg_win tstzrange := tstzrange('2028-05-02 07:00+00','2028-05-02 12:00+00');
        v_run jsonb; v_run_id uuid; v_state text := 'none'; v_detail text; v_d jsonb;
        v_ok boolean := true; v_why text := ''; v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_run_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  BEGIN
    PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, v_asg_win);
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_d := v_detail::jsonb;
  END;
  SELECT count(*) INTO v_count FROM assignments WHERE run_id = v_run_id;
  RESET ROLE;
  IF v_state = 'allowed' THEN v_ok := false; v_why := v_why || ' the before-start join was accepted';
  ELSIF v_state <> 'PT409' THEN v_ok := false; v_why := v_why || format(' sqlstate=%s (not PT409)', v_state);
  ELSIF v_d->>'error' <> 'outside_run' THEN v_ok := false; v_why := v_why || format(' error=%s (not outside_run)', v_d->>'error');
  ELSE
    IF (v_d->>'run_id') IS DISTINCT FROM v_run_id::text THEN v_ok := false; v_why := v_why || ' DETAIL missing/wrong run_id'; END IF;
    IF (v_d->>'node_id') IS DISTINCT FROM v_cell::text THEN v_ok := false; v_why := v_why || ' DETAIL missing/wrong node_id'; END IF;
    IF (v_d->>'run_timerange') IS NULL THEN v_ok := false; v_why := v_why || ' DETAIL missing run_timerange'; END IF;
    IF (v_d->>'timerange') IS NULL THEN v_ok := false; v_why := v_why || ' DETAIL missing timerange'; END IF;
  END IF;
  IF v_count <> 0 THEN v_ok := false; v_why := v_why || ' a row was written despite the refusal'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS J2'; ELSE RAISE NOTICE 'FAIL J2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J2;

\echo 'J3: a join ENDING AFTER the run is refused the same way'
SAVEPOINT sp_J3;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run_win tstzrange := tstzrange('2028-05-03 08:00+00','2028-05-03 16:00+00');
        v_asg_win tstzrange := tstzrange('2028-05-03 12:00+00','2028-05-03 17:00+00');
        v_run jsonb; v_run_id uuid; v_state text := 'none'; v_detail text; v_d jsonb; v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_run_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  BEGIN
    PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, v_asg_win);
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_d := v_detail::jsonb;
  END;
  SELECT count(*) INTO v_count FROM assignments WHERE run_id = v_run_id;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'FAIL J3: the after-end join was accepted';
  ELSIF v_state <> 'PT409' THEN RAISE NOTICE 'FAIL J3: sqlstate=% (not PT409)', v_state;
  ELSIF v_d->>'error' <> 'outside_run' THEN RAISE NOTICE 'FAIL J3: refused but not as outside_run: %', v_d->>'error';
  ELSIF v_count <> 0 THEN RAISE NOTICE 'FAIL J3: a row was written despite the refusal';
  ELSE RAISE NOTICE 'PASS J3'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J3;

\echo 'J4: a join EQUAL to the run''s whole window succeeds (@> is inclusive of equality)'
SAVEPOINT sp_J4;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-05-04 08:00+00','2028-05-04 16:00+00');
        v_run jsonb; v_run_id uuid; v_res jsonb; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_res := create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  RESET ROLE;
  IF (v_res->'assignment'->>'id') IS NULL THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS J4'; ELSE RAISE NOTICE 'FAIL J4: an exact-window join was refused'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J4;

\echo 'J5: a DIRECT block (p_product_id, no run) is untouched by this rule'
SAVEPOINT sp_J5;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-05-05 06:00+00','2028-05-05 22:00+00');
        v_res jsonb; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- No run at all exists at this window; a direct block names a product, not
  -- a run, so there is nothing for outside_run to compare against.
  v_res := create_assignment(v_cell, v_el, NULL, v_wx, v_win);
  RESET ROLE;
  IF (v_res->'assignment'->>'id') IS NULL THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS J5'; ELSE RAISE NOTICE 'FAIL J5: a direct block was refused outside_run'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J5;

\echo 'J6: order --- a signed-in VIEWER joining with an outside span gets not_permitted, not outside_run'
SAVEPOINT sp_J6;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run_win tstzrange := tstzrange('2028-05-06 08:00+00','2028-05-06 16:00+00');
        v_outside_win tstzrange := tstzrange('2028-05-06 06:00+00','2028-05-06 10:00+00');
        v_run jsonb; v_run_id uuid; v_state text := 'none'; v_detail text; v_d jsonb;
BEGIN
  -- The run is created as Ana (an editor); the refused join is attempted as
  -- the viewer, whose span is ALSO outside the run -- so a bug that checked
  -- containment before permission would report outside_run here instead.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_run_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, v_outside_win);
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_d := v_detail::jsonb;
  END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'FAIL J6: the viewer''s join was accepted';
  ELSIF v_state <> 'PT403' THEN RAISE NOTICE 'FAIL J6: sqlstate=% (not PT403)', v_state;
  ELSIF v_d->>'error' <> 'not_permitted' THEN RAISE NOTICE 'FAIL J6: refused but not as not_permitted: %', v_d->>'error';
  ELSE RAISE NOTICE 'PASS J6'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J6;

\echo 'J7: an unknown p_run_id is refused invalid_argument naming p_run_id'
SAVEPOINT sp_J7;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_win tstzrange := tstzrange('2028-05-07 08:00+00','2028-05-07 16:00+00');
        v_state text := 'none'; v_detail text; v_d jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_cell, v_el, '99999999-9999-9999-9999-999999999999'::uuid, NULL, v_win);
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_d := v_detail::jsonb;
  END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'FAIL J7: an unknown run id was accepted';
  ELSIF v_state <> 'PT400' THEN RAISE NOTICE 'FAIL J7: sqlstate=% (not PT400)', v_state;
  ELSIF v_d->>'error' <> 'invalid_argument' OR v_d->>'field' <> 'p_run_id' THEN
    RAISE NOTICE 'FAIL J7: refused but not invalid_argument naming p_run_id: error=% field=%', v_d->>'error', v_d->>'field';
  ELSE RAISE NOTICE 'PASS J7'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J7;

\echo 'J8: move_run of a staffed run still succeeds with the new definition installed (its crew UPDATE is not a join)'
SAVEPOINT sp_J8;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-05-08 08:00+00','2028-05-08 16:00+00');
        v_new_win tstzrange := tstzrange('2028-05-09 08:00+00','2028-05-09 16:00+00');
        v_run jsonb; v_run_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  v_res := move_run(v_run_id, v_cell, v_new_win);
  RESET ROLE;
  IF (v_res->'run'->>'id') IS DISTINCT FROM v_run_id::text THEN v_ok := false; v_why := v_why || ' move_run did not return the run'; END IF;
  IF (SELECT timerange FROM runs WHERE id = v_run_id) IS DISTINCT FROM v_new_win THEN
    v_ok := false; v_why := v_why || ' the run did not actually move';
  END IF;
  IF (SELECT timerange FROM assignments WHERE run_id = v_run_id) IS DISTINCT FROM v_new_win THEN
    v_ok := false; v_why := v_why || ' the crew row did not move with it';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS J8'; ELSE RAISE NOTICE 'FAIL J8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL J8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_J8;

ROLLBACK;

\echo '96_a_join_stays_inside_its_run_test.sql complete (J0-J8)'
