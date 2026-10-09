-- ============================================================================
-- 93_schedulable_node_guard_test.sql — F-120 / R-002, migration 0072.
--
-- THE REQUIREMENT UNDER TEST, in one sentence: only a node on the schedulable
-- level (here, "Work Cell") may carry a run or an assignment; a node higher
-- up the tree (Site/Department/Line) is refused, whichever door was used to
-- reach node_id --- create_run, create_assignment, move_run, or a raw
-- PostgREST INSERT/UPDATE that goes through none of them.
--
-- Same conventions as 91_copy_plant_structure_test.sql: each case is its own
-- SAVEPOINT + DO block with an outer EXCEPTION WHEN OTHERS that turns any
-- unexpected error into RAISE NOTICE 'FAIL ...', so one broken case never
-- hides the rest.
--
-- FIXTURE --- the seed's org 1 (Northwind Manufacturing), Plant 1's real
-- shape (supabase/seed.sql, not paraphrased):
--   Plant 1 (Site)         30000000-...-01
--     Assembly (Department) 30000000-...-02
--       Line 1 (Line)        30000000-...-04   <- NOT schedulable
--         Cell 1 (Work Cell)   30000000-...-07  <- schedulable
--   a1 is the seed's company admin; Widget X (60000000-...-01) is offered at
--   the plant root, so it is offered at every node under it.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

\echo 'CS1: create_run onto a Line (not schedulable) is refused invalid_argument/not_schedulable'
SAVEPOINT sp_CS1;
DO $$
DECLARE v_code text; v_detail text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_run('30000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000001',
      tstzrange(now(), now() + interval '2 hours'), 1);
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CS1: create_run onto a Line succeeded';
  ELSIF v_code <> 'PT400' OR v_detail NOT ILIKE '%not_schedulable%' THEN
    RAISE NOTICE 'FAIL CS1: refused but not as expected: sqlstate=% detail=%', v_code, v_detail;
  ELSE RAISE NOTICE 'PASS CS1'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CS1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS1;

\echo 'CS2: the CONTROL for CS1 --- the same call onto Cell 1 (schedulable) succeeds'
SAVEPOINT sp_CS2;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := create_run('30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001',
    tstzrange(now(), now() + interval '2 hours'), 1);
  RESET ROLE;
  IF NOT (v_res->'run' ? 'id') THEN v_ok := false; v_why := ' no run id in result'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CS2'; ELSE RAISE NOTICE 'FAIL CS2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CS2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS2;

\echo 'CS3: create_assignment (product-direct) onto a Line is refused the same way'
SAVEPOINT sp_CS3;
DO $$
DECLARE v_code text; v_detail text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000004', NULL, NULL,
      '60000000-0000-0000-0000-000000000001', tstzrange(now(), now() + interval '2 hours'));
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CS3: create_assignment onto a Line succeeded';
  ELSIF v_code <> 'PT400' OR v_detail NOT ILIKE '%not_schedulable%' THEN
    RAISE NOTICE 'FAIL CS3: refused but not as expected: sqlstate=% detail=%', v_code, v_detail;
  ELSE RAISE NOTICE 'PASS CS3'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CS3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS3;

\echo 'CS4: the CONTROL for CS3 --- the same call onto Cell 1 succeeds'
SAVEPOINT sp_CS4;
DO $$
DECLARE v_res jsonb; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000001', NULL,
    '60000000-0000-0000-0000-000000000001', tstzrange(now(), now() + interval '2 hours'));
  RESET ROLE;
  IF NOT (v_res->'assignment' ? 'id') THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CS4'; ELSE RAISE NOTICE 'FAIL CS4: no assignment id in result'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CS4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS4;

\echo 'CS5: move_run onto a Line is refused the same way, and the run does not move'
SAVEPOINT sp_CS5;
DO $$
DECLARE v_run_id uuid; v_before uuid; v_code text; v_detail text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_run_id := (create_run('30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001',
    tstzrange(now(), now() + interval '2 hours'), 1)->'run'->>'id')::uuid;
  BEGIN
    PERFORM move_run(v_run_id, '30000000-0000-0000-0000-000000000004', tstzrange(now(), now() + interval '2 hours'));
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  SELECT node_id INTO v_before FROM runs WHERE id = v_run_id;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CS5: move_run onto a Line succeeded';
  ELSIF v_code <> 'PT400' OR v_detail NOT ILIKE '%not_schedulable%' THEN
    RAISE NOTICE 'FAIL CS5: refused but not as expected: sqlstate=% detail=%', v_code, v_detail;
  ELSIF v_before <> '30000000-0000-0000-0000-000000000007' THEN
    RAISE NOTICE 'FAIL CS5: refused, but the run moved anyway (node_id=%)', v_before;
  ELSE RAISE NOTICE 'PASS CS5'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CS5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS5;

\echo 'CS6: a raw INSERT into assignments with node_id on a Line is refused --- no RPC, no client in the way'
SAVEPOINT sp_CS6;
DO $$
DECLARE v_code text; v_detail text; v_ok boolean := true; v_id uuid;
BEGIN
  BEGIN
    INSERT INTO assignments (org_id, node_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004',
            '60000000-0000-0000-0000-000000000001', tstzrange(now(), now() + interval '2 hours'), 1.0)
    RETURNING id INTO v_id;
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CS6: a raw INSERT onto a Line succeeded (id=%)', v_id;
  ELSIF v_code <> 'PT400' OR v_detail NOT ILIKE '%not_schedulable%' THEN
    RAISE NOTICE 'FAIL CS6: refused but not as expected: sqlstate=% detail=%', v_code, v_detail;
  ELSE RAISE NOTICE 'PASS CS6'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL CS6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS6;

\echo 'CS7: a raw UPDATE moving an existing assignment onto a Line is refused the same way'
SAVEPOINT sp_CS7;
DO $$
DECLARE v_id uuid; v_code text; v_detail text; v_ok boolean := true; v_after uuid;
BEGIN
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
          '50000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
          tstzrange(now(), now() + interval '2 hours'), 1.0)
  RETURNING id INTO v_id;
  BEGIN
    UPDATE assignments SET node_id = '30000000-0000-0000-0000-000000000004' WHERE id = v_id;
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  SELECT node_id INTO v_after FROM assignments WHERE id = v_id;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CS7: a raw UPDATE onto a Line succeeded';
  ELSIF v_code <> 'PT400' OR v_detail NOT ILIKE '%not_schedulable%' THEN
    RAISE NOTICE 'FAIL CS7: refused but not as expected: sqlstate=% detail=%', v_code, v_detail;
  ELSIF v_after <> '30000000-0000-0000-0000-000000000007' THEN
    RAISE NOTICE 'FAIL CS7: refused, but the row moved anyway (node_id=%)', v_after;
  ELSE RAISE NOTICE 'PASS CS7'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL CS7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CS7;

ROLLBACK;

\echo '93_schedulable_node_guard_test.sql complete (CS1-CS7)'
