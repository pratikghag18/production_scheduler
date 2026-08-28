-- ============================================================================
-- 70_hierarchy_test.sql — brief P1-5a §9, the 36 acceptance cases (L1-L12,
-- N1-N17), plus 7 cases added after design-session verification (Aug 25):
-- D1/D2/D3 regression-test three real defects the design session's own
-- unprescribed mutations + NULL-argument probes found (none caught by this
-- suite or the design session's own independent one at the time); U1/U4/U5/
-- U7 close four coverage gaps the design session found where the clean
-- build already behaved correctly but nothing here proved it. 43 cases total.
--
-- UNLIKE 60_api_test.sql / 40_rls_test.sql: the brief requires every case to
-- run independently and report its own PASS/FAIL without aborting the run
-- (§9), because this same file is re-run once per §10 mutation and a file
-- that stops at the first failure cannot say which case caught which
-- mutation. So each case is its own SAVEPOINT + DO block, and the DO block
-- carries an outer `EXCEPTION WHEN OTHERS` that turns *any* unexpected
-- error (not just the deliberately-triggered ones a case is testing for)
-- into a `RAISE NOTICE 'FAIL ...'` instead of letting it propagate and
-- abort the transaction. Every case ends with ROLLBACK TO SAVEPOINT, so a
-- rollback discards table writes but never the NOTICE output (brief §9).
--
-- Trap (brief §9, confirmed while writing this file): capture
-- RETURNED_SQLSTATE via GET STACKED DIAGNOSTICS in the SAME handler that
-- catches the exception under test, not in some later nested handler that
-- casts DETAIL to jsonb and falls back to SQLSTATE on cast failure — that
-- fallback reports the CAST's sqlstate (22P02), not the error under test.
--
-- Assert on the machine `error` code parsed from DETAIL, never on SQLSTATE
-- or message text — except N10, the brief's one explicit exception, which
-- asserts the raw SQLSTATE because it is exercising the unique index
-- backstop directly, with no RPC and no api_raise involved.
--
-- org: 10000000-0000-0000-0000-000000000001
-- Admin sub: 00000000-0000-0000-0000-0000000000a1
-- Ana sub (supervisor): 00000000-0000-0000-0000-0000000000a2
--
-- Levels: Site 20000000-...-0000 (pos 0) / Department ...-0001 (pos 1) /
--   Line ...-0002 (pos 2) / Work Cell ...-0003 (pos 3, schedulable)
-- Nodes: Plant 1 30000000-...-0001 (plant_1) / Assembly ...-0002
--   (plant_1.assembly) / Machining ...-0003 (plant_1.machining) /
--   Line 1 ...-0004 (...assembly.line_1) / Line 2 ...-0005
--   (...assembly.line_2) / CNC Line ...-0006 (...machining.cnc_line) /
--   Cell 1 ...-0007 / Cell 2 ...-0008 / Cell 3 ...-0009 (all under Line 1) /
--   Cell 4 3000000a-...-000a / Cell 5 ...-000b (under Line 2) /
--   Cell 6 ...-000c / Cell 7 ...-000d (under CNC Line)
-- Runs: r1/r2/r7 on Cell 1, r3 on Cell 2, r4 on Cell 3, r5/r8 on Cell 6,
--   r6 on Cell 7 (see 60_api_test.sql header for full run/assignment map).
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ============================================================================
-- Levels: L1-L12
-- ============================================================================

\echo 'L1: reorder that strands nodes (swap Department and Line) -> level_in_use'
SAVEPOINT sp_L1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
-- D92 (migration 0016). THIS CASE USED TO ASSERT THE DEFECT.
-- It swapped Department and Line on the SEEDED, POPULATED org and asserted the
-- save succeeded -- which it did, taking the org from 0 adjacency violations to
-- 12 with no error, after which create_node silently produced children on the
-- wrong level. The suite was not merely blind to the bug: it pinned it as the
-- contract. A green case is not evidence a behaviour is correct, only that it
-- is intended, and intent is what this line changes.
-- The "a reorder can succeed" coverage L1 used to provide moves to L1b, which
-- runs it on a structure where it is legal.
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_order text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_in_use' THEN
    RAISE NOTICE 'PASS L1';
  ELSE
    RAISE NOTICE 'FAIL L1: caught=%, detail=%', v_caught, v_detail;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_L1;

\echo 'L2: rename all four levels; the 7 cells keep their level_id'
SAVEPOINT sp_L2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_cell_count int;
BEGIN
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Facility','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Zone','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Cell Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Station','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_cell_count FROM nodes
    WHERE level_id = '20000000-0000-0000-0000-000000000003'
      AND org_id = '10000000-0000-0000-0000-000000000001';
  IF v_cell_count = 7 THEN
    RAISE NOTICE 'PASS L2';
  ELSE
    RAISE NOTICE 'FAIL L2: expected 7 nodes still on the Work Cell level_id, got %', v_cell_count;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L2;

\echo 'L3: append a new deepest level (id: null) -> 5 levels, new one at position 4 with a generated id'
SAVEPOINT sp_L3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_new jsonb;
BEGIN
  v_res := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true),
    jsonb_build_object('id',null,'name','Sub Cell','is_schedulable',false)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT e INTO v_new FROM jsonb_array_elements(v_res) e WHERE e->>'name' = 'Sub Cell';
  IF jsonb_array_length(v_res) = 5
     AND (v_new->>'position')::int = 4
     AND v_new->>'id' IS NOT NULL
  THEN
    RAISE NOTICE 'PASS L3';
  ELSE
    RAISE NOTICE 'FAIL L3: expected 5 levels with Sub Cell at position 4 with a generated id, got %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L3;

\echo 'L4: remove a level that has nodes -> level_in_use'
SAVEPOINT sp_L4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    -- Work Cell (still has 7 nodes) omitted; Line marked schedulable so the
    -- payload is otherwise valid and the case exercises step 7 specifically.
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_in_use' THEN
    RAISE NOTICE 'PASS L4';
  ELSE
    RAISE NOTICE 'FAIL L4: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L4;

\echo 'L5: add an empty level, then remove it -> succeeds, back to 4'
SAVEPOINT sp_L5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_count int;
BEGIN
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true),
    jsonb_build_object('id',null,'name','Extra','is_schedulable',false)
  ), '21000000-0000-0000-0000-000000000001');
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001';
  IF v_count = 4 THEN
    RAISE NOTICE 'PASS L5';
  ELSE
    RAISE NOTICE 'FAIL L5: expected 4 levels, got %', v_count;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L5;

\echo 'L6a: zero schedulable -> invalid_argument'
SAVEPOINT sp_L6a;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',false)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS L6a';
  ELSE
    RAISE NOTICE 'FAIL L6a: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L6a: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L6a;

\echo 'L6b: two schedulable -> invalid_argument'
SAVEPOINT sp_L6b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',true),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS L6b';
  ELSE
    RAISE NOTICE 'FAIL L6b: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L6b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L6b;

\echo 'L7: move schedulable to Line while runs are present -> schedulable_level_locked'
SAVEPOINT sp_L7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',true),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',false)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'schedulable_level_locked' THEN
    RAISE NOTICE 'PASS L7';
  ELSE
    RAISE NOTICE 'FAIL L7: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L7;

\echo 'L8: delete all assignments + runs, then move schedulable to Line -> succeeds'
SAVEPOINT sp_L8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_sched_count int; v_line_sched boolean;
BEGIN
  DELETE FROM assignments WHERE org_id = '10000000-0000-0000-0000-000000000001';
  DELETE FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';
  v_res := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',true),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',false)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_sched_count FROM jsonb_array_elements(v_res) e WHERE (e->>'is_schedulable')::boolean;
  SELECT (e->>'is_schedulable')::boolean INTO v_line_sched FROM jsonb_array_elements(v_res) e WHERE e->>'id' = '20000000-0000-0000-0000-000000000002';
  IF v_sched_count = 1 AND v_line_sched THEN
    RAISE NOTICE 'PASS L8';
  ELSE
    RAISE NOTICE 'FAIL L8: expected exactly one schedulable (Line), got %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L8;

\echo 'L9: Ana (supervisor) calls save_hierarchy_levels -> not_permitted'
SAVEPOINT sp_L9;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN
    RAISE NOTICE 'PASS L9';
  ELSE
    RAISE NOTICE 'FAIL L9: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L9;

\echo 'L10: PROPERTY — after 3 successful saves, positions are 0..n-1 with no gaps and exactly one schedulable'
SAVEPOINT sp_L10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_positions int[]; v_expected int[]; v_sched_count int; v_n int; v_violations int := 0;
BEGIN
  -- Save 1: rename in place. This WAS a reorder (Department and Line swapped),
  -- which migration 0016 now refuses on a populated structure -- see L1. The
  -- property this case exists to check is that positions stay 0..n-1 with no
  -- gaps and exactly one schedulable after EVERY save, which does not depend on
  -- the save being a reorder; L1b covers a legal reorder.
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT array_agg(position ORDER BY position) INTO v_positions FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001';
  v_n := array_length(v_positions,1);
  SELECT array_agg(g) INTO v_expected FROM generate_series(0, v_n-1) g;
  IF v_positions IS DISTINCT FROM v_expected THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save1 position gap: %', v_positions; END IF;
  SELECT count(*) INTO v_sched_count FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001' AND is_schedulable;
  IF v_sched_count <> 1 THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save1 schedulable count %', v_sched_count; END IF;

  -- Save 2: rename all four, same order.
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Facility','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Zone','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Cell Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Station','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT array_agg(position ORDER BY position) INTO v_positions FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001';
  v_n := array_length(v_positions,1);
  SELECT array_agg(g) INTO v_expected FROM generate_series(0, v_n-1) g;
  IF v_positions IS DISTINCT FROM v_expected THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save2 position gap: %', v_positions; END IF;
  SELECT count(*) INTO v_sched_count FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001' AND is_schedulable;
  IF v_sched_count <> 1 THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save2 schedulable count %', v_sched_count; END IF;

  -- Save 3: append a new level.
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Facility','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Zone','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Cell Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Station','is_schedulable',true),
    jsonb_build_object('id',null,'name','Sub Station','is_schedulable',false)
  ), '21000000-0000-0000-0000-000000000001');
  SELECT array_agg(position ORDER BY position) INTO v_positions FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001';
  v_n := array_length(v_positions,1);
  SELECT array_agg(g) INTO v_expected FROM generate_series(0, v_n-1) g;
  IF v_positions IS DISTINCT FROM v_expected THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save3 position gap: %', v_positions; END IF;
  SELECT count(*) INTO v_sched_count FROM hierarchy_levels WHERE org_id = '10000000-0000-0000-0000-000000000001' AND is_schedulable;
  IF v_sched_count <> 1 THEN v_violations := v_violations + 1; RAISE NOTICE '  L10 save3 schedulable count %', v_sched_count; END IF;

  IF v_violations = 0 THEN
    RAISE NOTICE 'PASS L10';
  ELSE
    RAISE NOTICE 'FAIL L10: % violations', v_violations;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L10;

\echo 'L11a: p_levels = [] -> invalid_argument'
SAVEPOINT sp_L11a;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels('[]'::jsonb, '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS L11a';
  ELSE
    RAISE NOTICE 'FAIL L11a: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L11a: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L11a;

\echo 'L11b: one level, name ''   '' -> invalid_argument'
SAVEPOINT sp_L11b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id',null,'name','   ','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS L11b';
  ELSE
    RAISE NOTICE 'FAIL L11b: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L11b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L11b;

\echo 'L11c: p_levels = {"a":1} (not an array) -> invalid_argument'
SAVEPOINT sp_L11c;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels('{"a":1}'::jsonb, '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS L11c';
  ELSE
    RAISE NOTICE 'FAIL L11c: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L11c: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L11c;

\echo 'L12: detach every assignment, delete all runs, then move schedulable -> schedulable_level_locked (assignments-only)'
SAVEPOINT sp_L12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text; v_run_count int; v_assignment_count int;
BEGIN
  BEGIN
    UPDATE assignments a SET run_id = NULL, product_id = r.product_id
      FROM runs r WHERE a.run_id = r.id;
    DELETE FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';

    SELECT count(*) INTO v_run_count FROM runs WHERE org_id = '10000000-0000-0000-0000-000000000001';
    SELECT count(*) INTO v_assignment_count FROM assignments WHERE org_id = '10000000-0000-0000-0000-000000000001';
    IF v_run_count <> 0 OR v_assignment_count = 0 THEN
      RAISE EXCEPTION 'setup invariant broken: runs=%, assignments=%', v_run_count, v_assignment_count;
    END IF;

    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',true),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',false)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'schedulable_level_locked' THEN
    RAISE NOTICE 'PASS L12';
  ELSE
    RAISE NOTICE 'FAIL L12: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L12;

-- ============================================================================
-- D92 / migration 0016 — the reorder guard: L1b, L13-L17
--
-- `save_hierarchy_levels` always refused to REMOVE a level with nodes (L4) and
-- to move the schedulable flag off a level with work (L7/L12). It never guarded
-- REORDERING, and `nodes_before_level` cannot: that trigger is
-- `before insert or update of parent_id, level_id ON NODES`, and the three
-- write passes touch only `hierarchy_levels`.
--
-- The guard is phrased as an OUTCOME -- "does every node still line up
-- afterwards" -- not as "an in-use level may not move". L15 is why: the obvious
-- phrasing makes an already-scrambled database unrepairable, because the repair
-- is itself a move of an in-use level.
-- ============================================================================

\echo 'L1b: reorder a structure that has NO nodes -> succeeds'
SAVEPOINT sp_L1b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_tpl uuid; v_names text[];
BEGIN
  v_tpl := (create_hierarchy_template('Reorderable')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id',null,'name','Alpha','is_schedulable',false),
    jsonb_build_object('id',null,'name','Beta','is_schedulable',true)
  ), v_tpl);
  -- Now swap them. No node sits on either, so nothing can be stranded.
  PERFORM save_hierarchy_levels(
    (SELECT jsonb_agg(jsonb_build_object('id',hl.id,'name',hl.name,'is_schedulable',hl.is_schedulable)
              ORDER BY hl.position DESC)
       FROM hierarchy_levels hl WHERE hl.template_id = v_tpl), v_tpl);
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_names
    FROM hierarchy_levels hl WHERE hl.template_id = v_tpl;
  IF v_names = ARRAY['Beta','Alpha'] THEN
    RAISE NOTICE 'PASS L1b';
  ELSE
    RAISE NOTICE 'FAIL L1b: expected [Beta,Alpha], got %', v_names;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L1b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L1b;

\echo 'L13: reorder strands a ROOT only (one root, no children) -> level_in_use'
SAVEPOINT sp_L13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_tpl uuid; v_own uuid; v_caught boolean := false; v_detail jsonb; v_detail_raw text;
BEGIN
  -- THE CASE A PARENT-JOIN GUARD MISSES ENTIRELY. With one root and no
  -- children there is no parent/child pair at all, so a check written only as
  -- "child position = parent position + 1" scores ZERO violations while the
  -- root sits off position 0. Measured before the second half of the guard was
  -- written: the swap below was ALLOWED. Both halves of `nodes_before_level`'s
  -- rule have to be mirrored, not just the one an obvious fixture reaches.
  v_tpl := (create_hierarchy_template('Solo')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id',null,'name','Alpha','is_schedulable',false),
    jsonb_build_object('id',null,'name','Beta','is_schedulable',true)
  ), v_tpl);
  -- 0020 §10: a root create COPIES the shape it is given, so the node lands in
  -- a NEW structure and `v_tpl` is left empty. Reordering `v_tpl` would strand
  -- nothing and this case would pass for the wrong reason -- a fixture that can
  -- no longer deliver what its name claims (rule 3b). The reorder must target
  -- the structure the site actually owns, which create_node now returns.
  v_own := (create_node(NULL, 'Only Node', 0, v_tpl)->>'template_id')::uuid;
  IF v_own IS NULL OR v_own = v_tpl THEN
    RAISE NOTICE 'FAIL L13: fixture -- root did not receive its own copy (own=%, source=%)', v_own, v_tpl;
    RETURN;
  END IF;
  BEGIN
    PERFORM save_hierarchy_levels(
      (SELECT jsonb_agg(jsonb_build_object('id',hl.id,'name',hl.name,'is_schedulable',hl.is_schedulable)
                ORDER BY hl.position DESC)
         FROM hierarchy_levels hl WHERE hl.template_id = v_own), v_own);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_in_use'
     AND v_detail->>'reason' = 'reorder strands a root node' THEN
    RAISE NOTICE 'PASS L13';
  ELSE
    RAISE NOTICE 'FAIL L13: caught=%, detail=%', v_caught, v_detail;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_L13;

\echo 'L14: a REFUSED reorder leaves the stored order untouched'
SAVEPOINT sp_L14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_order text;
BEGIN
  -- The guard runs AFTER the three write passes, so this asserts the raise
  -- actually rolls them back rather than leaving a half-applied order behind.
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  SELECT string_agg(hl.name, ' > ' ORDER BY hl.position) INTO v_order
    FROM hierarchy_levels hl WHERE hl.template_id = '21000000-0000-0000-0000-000000000001';
  IF v_order = 'Site > Department > Line > Work Cell' THEN
    RAISE NOTICE 'PASS L14';
  ELSE
    RAISE NOTICE 'FAIL L14: order is now %', v_order;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_L14;

\echo 'L15: a structure ALREADY scrambled can still be repaired -> succeeds'
SAVEPOINT sp_L15;
DO $$
DECLARE v_before int; v_after int;
BEGIN
  -- Simulates a database saved before 0016 existed. THE WHOLE REASON the guard
  -- asks about the OUTCOME rather than forbidding a used level from moving: the
  -- repair is itself a move of two in-use levels, so the obvious phrasing would
  -- lock the admin out of fixing their own data. Scrambled here with a direct
  -- UPDATE as the table owner, because the RPC would (correctly) refuse.
  UPDATE hierarchy_levels SET position = position + 100
    WHERE template_id = '21000000-0000-0000-0000-000000000001';
  UPDATE hierarchy_levels SET position =
      CASE position - 100 WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE position - 100 END
    WHERE template_id = '21000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_before FROM nodes n
    JOIN nodes pn ON pn.id = n.parent_id
    JOIN hierarchy_levels cl ON cl.id = n.level_id
    JOIN hierarchy_levels pl ON pl.id = pn.level_id
   WHERE cl.template_id = '21000000-0000-0000-0000-000000000001'
     AND cl.position IS DISTINCT FROM pl.position + 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  RESET ROLE;

  SELECT count(*) INTO v_after FROM nodes n
    JOIN nodes pn ON pn.id = n.parent_id
    JOIN hierarchy_levels cl ON cl.id = n.level_id
    JOIN hierarchy_levels pl ON pl.id = pn.level_id
   WHERE cl.template_id = '21000000-0000-0000-0000-000000000001'
     AND cl.position IS DISTINCT FROM pl.position + 1;

  IF v_before > 0 AND v_after = 0 THEN
    RAISE NOTICE 'PASS L15 (repaired % violations)', v_before;
  ELSE
    RAISE NOTICE 'FAIL L15: before=%, after=%', v_before, v_after;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L15;

\echo 'L16: a SECOND template in the SAME org being broken does not block this one'
SAVEPOINT sp_L16;
DO $$
DECLARE v_other uuid; v_owned uuid; v_root uuid; v_ok boolean := false;
BEGIN
  -- The guard is scoped to the template being saved. Scoped by ORG instead, one
  -- scrambled site would make every save to EVERY OTHER site in the same org
  -- fail, with a message about nodes the admin cannot see from that screen.
  --
  -- THE FIXTURE IS THE TEST, and the first version of it was blind: it broke a
  -- template belonging to the OTHER ORG, where org-scoping and template-scoping
  -- give the same answer, so the mutation that swaps one for the other was NOT
  -- CAUGHT. Telling them apart needs two templates in the SAME org -- one
  -- broken, the other being saved.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  v_other := (create_hierarchy_template('Second Site')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id',null,'name','Alpha','is_schedulable',false),
    jsonb_build_object('id',null,'name','Beta','is_schedulable',true)
  ), v_other);
  -- 0020 §10: the root lands in a COPY of `v_other`, and THE COPY is what
  -- holds the nodes. Everything below must therefore point at `v_owned`, not
  -- at `v_other` -- scrambling an empty structure strands nothing, and the two
  -- mutations this case exists to catch (guard scoped by ORG instead of by
  -- TEMPLATE) would go quietly uncaught for the third time.
  v_root := (create_node(NULL, 'Second Root', 0, v_other)->>'id')::uuid;
  SELECT hl.template_id INTO v_owned
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_root;
  -- A CHILD, not just a root. Without it the second template's only breakage is
  -- a stranded ROOT, which the parent-join clause never looks at -- so the
  -- mutation that re-scopes THAT clause from template to org stayed NOT CAUGHT.
  -- The fixture has to be able to break the specific clause under test.
  PERFORM create_node(v_root, 'Second Child', 0);
  RESET ROLE;

  IF v_owned IS NULL OR v_owned = v_other THEN
    RAISE NOTICE 'FAIL L16: fixture -- second root did not receive its own copy';
    RETURN;
  END IF;

  -- Scramble ONLY the second site's structure, as the table owner (the RPC
  -- would refuse). It is in the SAME ORG as the template saved below, which is
  -- the property that tells org-scoping and template-scoping apart.
  UPDATE hierarchy_levels SET position = position + 100 WHERE template_id = v_owned;
  UPDATE hierarchy_levels SET position =
      CASE position - 100 WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE position - 100 END
    WHERE template_id = v_owned;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name','Department','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
    jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Cell','is_schedulable',true)
  ), '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_ok := true;
  IF v_ok THEN RAISE NOTICE 'PASS L16'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL L16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_L16;

\echo 'L17: every RPC migration 0014 created is revoked from anon'
SAVEPOINT sp_L17;
DO $$
DECLARE v_leaky int;
BEGIN
  -- Migration 0016 replaces save_hierarchy_levels in place rather than dropping
  -- it. A DROP would take the grants with it and the function would come back
  -- with the PUBLIC default -- the trap 90_'s T30 exists for. Asserted, not
  -- assumed, because the difference is invisible in the migration's diff.
  -- D93. Written for save_hierarchy_levels alone, it FAILED -- anon had
  -- EXECUTE. Widening it to all four of 0014's functions showed the same for
  -- every one, and only those: of thirteen public RPCs, the nine from other
  -- migrations are all correctly revoked. A guard that checks one member of a
  -- set a migration created will not tell you the migration forgot the set.
  SELECT count(*) INTO v_leaky FROM (VALUES
    ('save_hierarchy_levels(jsonb,uuid)'),
    ('create_hierarchy_template(text)'),
    ('rename_hierarchy_template(uuid,text)'),
    ('delete_hierarchy_template(uuid)')
  ) AS f(sig)
  WHERE has_function_privilege('anon', f.sig, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f.sig, 'EXECUTE');
  IF v_leaky = 0 THEN
    RAISE NOTICE 'PASS L17';
  ELSE
    RAISE NOTICE 'FAIL L17: % of 4 functions have wrong grants', v_leaky;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_L17;

-- ============================================================================
-- Nodes: N1-N17
-- ============================================================================

\echo 'N1: create_node(Line 1, ''Cell 9'', 3)'
SAVEPOINT sp_N1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := create_node('30000000-0000-0000-0000-000000000004', 'Cell 9', 3);
  IF v_res->>'path' = 'plant_1.assembly.line_1.cell_9'
     AND v_res->>'level_id' = '20000000-0000-0000-0000-000000000003'
     AND (v_res->>'sort_order')::int = 3
  THEN
    RAISE NOTICE 'PASS N1';
  ELSE
    RAISE NOTICE 'FAIL N1: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N1;

\echo 'N2: create_node(Line 1, ''Cell-1'') -> path_collision'
SAVEPOINT sp_N2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM create_node('30000000-0000-0000-0000-000000000004', 'Cell-1');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision' THEN
    RAISE NOTICE 'PASS N2';
  ELSE
    RAISE NOTICE 'FAIL N2: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N2;

\echo 'N3: create_node(NULL, ''Plant 1'') -> path_collision'
SAVEPOINT sp_N3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM create_node(NULL, 'Plant 1');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision' THEN
    RAISE NOTICE 'PASS N3';
  ELSE
    RAISE NOTICE 'FAIL N3: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N3;

\echo 'N4: create_node(Cell 1, ''Machine A'') -> level_mismatch'
SAVEPOINT sp_N4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM create_node('30000000-0000-0000-0000-000000000007', 'Machine A');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN
    RAISE NOTICE 'PASS N4';
  ELSE
    RAISE NOTICE 'FAIL N4: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N4;

\echo 'N5: rename_node(Cell 2, ''Cell-1'') -> path_collision'
SAVEPOINT sp_N5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM rename_node('30000000-0000-0000-0000-000000000008', 'Cell-1');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision' THEN
    RAISE NOTICE 'PASS N5';
  ELSE
    RAISE NOTICE 'FAIL N5: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N5;

\echo 'N6: move_node(Cell 1, Line 2) -> path plant_1.assembly.line_2.cell_1'
SAVEPOINT sp_N6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := move_node('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000005');
  IF v_res->>'path' = 'plant_1.assembly.line_2.cell_1' THEN
    RAISE NOTICE 'PASS N6';
  ELSE
    RAISE NOTICE 'FAIL N6: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N6;

\echo 'N7: move_node(Line 1, Cell 1) -> node_cycle'
SAVEPOINT sp_N7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM move_node('30000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN
    RAISE NOTICE 'PASS N7';
  ELSE
    RAISE NOTICE 'FAIL N7: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N7;

\echo 'N7b: move_node(Line 1, Line 1) -> node_cycle'
SAVEPOINT sp_N7b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM move_node('30000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN
    RAISE NOTICE 'PASS N7b';
  ELSE
    RAISE NOTICE 'FAIL N7b: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N7b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N7b;

\echo 'N8: move_node(Cell 1, Assembly) -> level_mismatch'
SAVEPOINT sp_N8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM move_node('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN
    RAISE NOTICE 'PASS N8';
  ELSE
    RAISE NOTICE 'FAIL N8: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N8;

\echo 'N9a: direct UPDATE nodes parent_id=Cell1 WHERE id=Line1 -> node_cycle (trigger, no RPC)'
SAVEPOINT sp_N9a;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000007'
      WHERE id = '30000000-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN
    RAISE NOTICE 'PASS N9a';
  ELSE
    RAISE NOTICE 'FAIL N9a: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N9a: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N9a;

\echo 'N9b: direct UPDATE nodes parent_id=Assembly WHERE id=Cell1 -> level_mismatch (trigger, no RPC)'
SAVEPOINT sp_N9b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000002'
      WHERE id = '30000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN
    RAISE NOTICE 'PASS N9b';
  ELSE
    RAISE NOTICE 'FAIL N9b: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N9b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N9b;

\echo 'N10: direct INSERT of a node whose path duplicates an existing one -> SQLSTATE 23505'
SAVEPOINT sp_N10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_sqlstate text;
BEGIN
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003',
              '30000000-0000-0000-0000-000000000004', 'Cell-1');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    v_caught := true;
  END;
  IF v_caught AND v_sqlstate = '23505' THEN
    RAISE NOTICE 'PASS N10';
  ELSE
    RAISE NOTICE 'FAIL N10: caught=%, sqlstate=%', v_caught, v_sqlstate;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N10;

\echo 'N11a: delete_node(Line 1, ''delete'') -> node_in_use'
SAVEPOINT sp_N11a;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM delete_node('30000000-0000-0000-0000-000000000004', 'delete');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_in_use' THEN
    RAISE NOTICE 'PASS N11a';
  ELSE
    RAISE NOTICE 'FAIL N11a: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N11a: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N11a;

\echo 'N11b: delete_node(Cell 1, ''delete'') -> node_in_use'
SAVEPOINT sp_N11b;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM delete_node('30000000-0000-0000-0000-000000000007', 'delete');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_in_use' THEN
    RAISE NOTICE 'PASS N11b';
  ELSE
    RAISE NOTICE 'FAIL N11b: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N11b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N11b;

\echo 'N11c: create a fresh leaf, delete_node(it, ''delete'') -> deleted:1, row gone'
SAVEPOINT sp_N11c;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_new jsonb; v_new_id uuid; v_res jsonb; v_exists boolean;
BEGIN
  v_new := create_node('30000000-0000-0000-0000-000000000004', 'Temp Cell', 0);
  v_new_id := (v_new->>'id')::uuid;
  v_res := delete_node(v_new_id, 'delete');
  SELECT EXISTS(SELECT 1 FROM nodes WHERE id = v_new_id) INTO v_exists;
  IF (v_res->>'deleted')::int = 1 AND NOT v_exists THEN
    RAISE NOTICE 'PASS N11c';
  ELSE
    RAISE NOTICE 'FAIL N11c: res=%, still exists=%', v_res, v_exists;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N11c: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N11c;

\echo 'N12: delete_node(Line 1, ''deactivate'') -> deactivated:4; nothing under plant_1.assembly.line_1 still active'
SAVEPOINT sp_N12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_active_count int;
BEGIN
  v_res := delete_node('30000000-0000-0000-0000-000000000004', 'deactivate');
  SELECT count(*) INTO v_active_count FROM nodes
    WHERE path <@ 'plant_1.assembly.line_1'::ltree AND active;
  IF (v_res->>'deactivated')::int = 4 AND v_active_count = 0 THEN
    RAISE NOTICE 'PASS N12';
  ELSE
    RAISE NOTICE 'FAIL N12: res=%, still-active-count=%', v_res, v_active_count;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N12;

\echo 'N13: PROPERTY — after a move, a rename and a create, every node satisfies path/nlevel invariants'
SAVEPOINT sp_N13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_violations int := 0;
  rec RECORD;
  v_parent_path ltree;
  v_expected_path ltree;
BEGIN
  PERFORM move_node('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000005');
  PERFORM rename_node('30000000-0000-0000-0000-000000000004', 'Line One');
  PERFORM create_node('30000000-0000-0000-0000-000000000004', 'Cell 9', 3);

  FOR rec IN
    SELECT n.id, n.parent_id, n.name, n.path, hl.position AS lvl_pos
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
    WHERE n.org_id = '10000000-0000-0000-0000-000000000001'
  LOOP
    IF rec.parent_id IS NULL THEN
      v_expected_path := slugify(rec.name)::ltree;
    ELSE
      SELECT path INTO v_parent_path FROM nodes WHERE id = rec.parent_id;
      v_expected_path := v_parent_path || slugify(rec.name)::ltree;
    END IF;
    IF rec.path IS DISTINCT FROM v_expected_path THEN
      v_violations := v_violations + 1;
      RAISE NOTICE '  N13 path violation: node % path % expected %', rec.id, rec.path, v_expected_path;
    END IF;
    IF nlevel(rec.path) <> rec.lvl_pos + 1 THEN
      v_violations := v_violations + 1;
      RAISE NOTICE '  N13 nlevel violation: node % nlevel % expected %', rec.id, nlevel(rec.path), rec.lvl_pos + 1;
    END IF;
  END LOOP;

  IF v_violations = 0 THEN
    RAISE NOTICE 'PASS N13';
  ELSE
    RAISE NOTICE 'FAIL N13: % violations', v_violations;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N13;

-- ============================================================================
-- N14 / N14b — the escape hatch, REWRITTEN for D97 (migration 0017).
--
-- N14 used to assert that a plain `authenticated` caller could set
-- app.hierarchy_migration and skip the level check. That was true, it was
-- never reachable through PostgREST, and the maintainer asked for it closed -- so the
-- case now asserts the REFUSAL. N14b rescues the coverage N14 was legitimately
-- providing (the hatch works, and the path cascade still runs underneath it),
-- moved to the caller the hatch is now reserved for: the table's OWNER. Same
-- shape as L1/L1b when D92 landed.
-- ============================================================================
\echo 'N14: app.hierarchy_migration=on as `authenticated` is REFUSED -> not_permitted'
SAVEPOINT sp_N14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_caught boolean := false; v_detail_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000002'
      WHERE id = '30000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_detail_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN
    RAISE NOTICE 'PASS N14';
  ELSE
    RAISE NOTICE 'FAIL N14: caught=%, detail=%', v_caught, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N14;

\echo 'N14b: the OWNER may still use the hatch, and the path cascade still runs'
SAVEPOINT sp_N14b;
RESET ROLE;
DO $$
DECLARE v_path ltree;
BEGIN
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000002'
    WHERE id = '30000000-0000-0000-0000-000000000007';
  SELECT path INTO v_path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000007';
  IF v_path = 'plant_1.assembly.cell_1'::ltree THEN
    RAISE NOTICE 'PASS N14b';
  ELSE
    RAISE NOTICE 'FAIL N14b: path is %, expected plant_1.assembly.cell_1', v_path;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N14b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N14b;

\echo 'N15: set a node''s sort_order to 7, then move_node(..., NULL) [p_sort_order omitted] -> sort_order still 7'
-- CORRECTED (design-session review, Aug 25): this case's point is that the
-- 2-arg call form -- p_sort_order omitted, defaulting to NULL -- preserves
-- the node's existing sort_order via move_node's own
-- `coalesce(p_sort_order, sort_order)`. The first version of this case used
-- Plant 1 (the only node legally allowed a NULL *parent*), which conflated
-- "p_sort_order omitted" with "p_new_parent_id = NULL" and only ever
-- exercised move_node's root-node branch -- so it never exercised the
-- ordinary, far more common non-root move path this case is actually named
-- for, and did not fail under mutation M7 the way the brief's own reference
-- implementation's N15 does. Now moves Cell 1 to Line 2 (same underlying
-- move as N6) via the 2-arg call, isolating the sort_order-preservation
-- behaviour from the root/non-root parent question entirely.
SAVEPOINT sp_N15;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  UPDATE nodes SET sort_order = 7 WHERE id = '30000000-0000-0000-0000-000000000007'; -- Cell 1
  v_res := move_node('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000005'); -- Cell 1 -> Line 2, p_sort_order omitted
  IF (v_res->>'sort_order')::int = 7 THEN
    RAISE NOTICE 'PASS N15';
  ELSE
    RAISE NOTICE 'FAIL N15: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N15;

\echo 'N16: rename_node(Line 1, ''Line One'') -> 4 nodes under plant_1.assembly.line_one, none under ...line_1'
SAVEPOINT sp_N16;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_new_count int; v_old_count int;
BEGIN
  PERFORM rename_node('30000000-0000-0000-0000-000000000004', 'Line One');
  SELECT count(*) INTO v_new_count FROM nodes WHERE path <@ 'plant_1.assembly.line_one'::ltree;
  SELECT count(*) INTO v_old_count FROM nodes WHERE path <@ 'plant_1.assembly.line_1'::ltree;
  IF v_new_count = 4 AND v_old_count = 0 THEN
    RAISE NOTICE 'PASS N16';
  ELSE
    RAISE NOTICE 'FAIL N16: new_count=%, old_count=%', v_new_count, v_old_count;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N16;

\echo 'N17: move_node(Cell 1, Assembly): error=level_mismatch AND the node_id key is absent from DETAIL'
SAVEPOINT sp_N17;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM move_node('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    -- DETAIL is only valid JSON when the raise went through api_raise; a raw
    -- constraint violation's DETAIL is plain text, so the ::jsonb cast is
    -- isolated in its own handler rather than done inline in the capture
    -- above (brief section 9's trap, in disguise: an implicit text->jsonb
    -- assignment cast on GET STACKED DIAGNOSTICS raises 22P02 exactly like
    -- an explicit ::jsonb would, and that failure would otherwise escape to
    -- the case's own outer handler and get mislabelled as "unexpected").
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' AND NOT (v_detail ? 'node_id') THEN
    RAISE NOTICE 'PASS N17';
  ELSE
    RAISE NOTICE 'FAIL N17: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N17;

-- ============================================================================
-- D1/D2/D3 + U1/U4/U5/U7 -- added after design-session verification (Aug 25)
-- found three real defects (D1/D2/D3, none caught by this suite or the
-- design session's own independent one) and four gaps where an unprescribed
-- mutation went uncaught by both suites even though the clean build already
-- behaves correctly (U1/U4/U5/U7 -- coverage gaps, not bugs).
-- ============================================================================

\echo 'D1: delete_node(fresh leaf, NULL) -> invalid_argument, node NOT deleted (not brief-prescribed; a bug in the brief''s own spec)'
SAVEPOINT sp_D1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_new jsonb; v_id uuid; v_caught boolean := false;
  v_detail jsonb; v_detail_raw text; v_sqlstate text; v_exists boolean;
BEGIN
  v_new := create_node('30000000-0000-0000-0000-000000000004', 'D1 Probe Leaf', 0);
  v_id := (v_new->>'id')::uuid;
  BEGIN
    PERFORM delete_node(v_id, NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  SELECT EXISTS(SELECT 1 FROM nodes WHERE id = v_id) INTO v_exists;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' AND v_exists THEN
    RAISE NOTICE 'PASS D1';
  ELSE
    RAISE NOTICE 'FAIL D1: caught=%, sqlstate=%, detail=%, node_still_exists=%', v_caught, v_sqlstate, v_detail, v_exists;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL D1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D1;

\echo 'D2: create_node(Line 1, name, NULL) -> succeeds, sort_order coalesced to 0 (not brief-prescribed)'
SAVEPOINT sp_D2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := create_node('30000000-0000-0000-0000-000000000004', 'D2 Probe', NULL);
  IF (v_res->>'sort_order')::int = 0 THEN
    RAISE NOTICE 'PASS D2';
  ELSE
    RAISE NOTICE 'FAIL D2: %', v_res;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL D2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D2;

\echo 'D3: save_hierarchy_levels with a malformed level id -> invalid_argument (not brief-prescribed)'
SAVEPOINT sp_D3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels('[{"id":"nope","name":"S","is_schedulable":true}]'::jsonb, '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS D3';
  ELSE
    RAISE NOTICE 'FAIL D3: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL D3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_D3;

\echo 'U1: create_node stores the TRIMMED name, not the raw p_name'
SAVEPOINT sp_U1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_stored_name text;
BEGIN
  v_res := create_node('30000000-0000-0000-0000-000000000004', '  Cell 9  ', 0);
  SELECT name INTO v_stored_name FROM nodes WHERE id = (v_res->>'id')::uuid;
  IF v_res->>'name' = 'Cell 9' AND v_stored_name = 'Cell 9' THEN
    RAISE NOTICE 'PASS U1';
  ELSE
    RAISE NOTICE 'FAIL U1: returned name=%, stored name=%', v_res->>'name', v_stored_name;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_U1;

\echo 'U4: delete_node(...,''delete'') on a childless, work-free node that HAS a profile_grants row -> succeeds, grant removed'
SAVEPOINT sp_U4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_new jsonb; v_id uuid; v_res jsonb; v_grant_count int; v_node_exists boolean;
BEGIN
  v_new := create_node('30000000-0000-0000-0000-000000000004', 'U4 Probe Leaf', 0);
  v_id := (v_new->>'id')::uuid;
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    VALUES ('a0000000-0000-0000-0000-000000000001', v_id, '10000000-0000-0000-0000-000000000001', 'supervisor');
  v_res := delete_node(v_id, 'delete');
  SELECT count(*) INTO v_grant_count FROM profile_grants WHERE node_id = v_id;
  SELECT EXISTS(SELECT 1 FROM nodes WHERE id = v_id) INTO v_node_exists;
  IF (v_res->>'deleted')::int = 1 AND v_grant_count = 0 AND NOT v_node_exists THEN
    RAISE NOTICE 'PASS U4';
  ELSE
    RAISE NOTICE 'FAIL U4: res=%, grant_count=%, node_exists=%', v_res, v_grant_count, v_node_exists;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_U4;

\echo 'U5: direct INSERT with parent_id = its own (explicit) id -> node_cycle (trigger, INSERT path, not via move_node)'
SAVEPOINT sp_U5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_new_id uuid := gen_random_uuid();
  v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    INSERT INTO nodes (id, org_id, level_id, parent_id, name)
      VALUES (v_new_id, '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003',
              v_new_id, 'Self Parent');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN
    RAISE NOTICE 'PASS U5';
  ELSE
    RAISE NOTICE 'FAIL U5: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_U5;

\echo 'U7: direct INSERT of a non-root-level node with parent_id IS NULL -> level_mismatch (trigger, INSERT path)'
SAVEPOINT sp_U7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', NULL, 'Orphan Line');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN
    RAISE NOTICE 'PASS U7';
  ELSE
    RAISE NOTICE 'FAIL U7: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_U7;

-- ============================================================================
-- W1-W7 (design session, Aug 25, migration 0011 / design plan §19.13):
-- whitespace parity between the SQL name rules and the client's
-- `String.trim()`. Before 0011, bare `trim()` stripped SPACES ONLY, so
-- W1-W3 ACCEPTED input the client rejects and W4-W5 STORED the name with its
-- whitespace still attached.
--
-- W3 is the load-bearing case: it uses NBSP (U+00A0), which the obvious
-- `btrim(x, E' \t\n\r\f\v')` fix does NOT strip. That fix passes W1, W2,
-- W4 and W5 and fails W3 -- which is exactly why the character class is
-- `[\s\uFEFF]` and not an ASCII set. W5 covers the U+FEFF arm that plain
-- `\s` misses, and it is the character a CSV file opens with.
--
-- W6 pins the opposite edge: U+200B is NOT whitespace to JS, so it must not
-- be stripped here either. Parity is the requirement, not aggressiveness.
-- ============================================================================

\echo 'W1: save_hierarchy_levels with a TAB-only level name -> invalid_argument (blank)'
SAVEPOINT sp_W1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id','20000000-0000-0000-0000-000000000000','name','Site','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000001','name',chr(9),'is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000002','name','Line','is_schedulable',false),
      jsonb_build_object('id','20000000-0000-0000-0000-000000000003','name','Work Cell','is_schedulable',true)
    ), '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS W1';
  ELSE
    RAISE NOTICE 'FAIL W1: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W1;

\echo 'W2: create_node(Line 1, TAB) -> invalid_argument (blank)'
SAVEPOINT sp_W2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM create_node('30000000-0000-0000-0000-000000000004', chr(9));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS W2';
  ELSE
    RAISE NOTICE 'FAIL W2: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W2;

\echo 'W3: rename_node(Cell 1, NBSP U+00A0) -> invalid_argument (btrim over an ASCII set would MISS this)'
SAVEPOINT sp_W3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_detail_raw text; v_sqlstate text;
BEGIN
  BEGIN
    PERFORM rename_node('30000000-0000-0000-0000-000000000007', chr(160));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_detail_raw = PG_EXCEPTION_DETAIL;
    v_caught := true;
    BEGIN
      v_detail := v_detail_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_detail := NULL;
    END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN
    RAISE NOTICE 'PASS W3';
  ELSE
    RAISE NOTICE 'FAIL W3: caught=%, sqlstate=%, detail=%', v_caught, v_sqlstate, v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W3;

\echo 'W4: create_node(Line 1, TAB + ''Cell 9'' + LF) stores the name TRIMMED and slugs it'
SAVEPOINT sp_W4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := create_node('30000000-0000-0000-0000-000000000004', chr(9) || ' Cell 9 ' || chr(10));
  IF v_res->>'name' = 'Cell 9' AND v_res->>'path' = 'plant_1.assembly.line_1.cell_9' THEN
    RAISE NOTICE 'PASS W4';
  ELSE
    RAISE NOTICE 'FAIL W4: name=%, path=%', v_res->>'name', v_res->>'path';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W4;

\echo 'W5: rename_node(Cell 1, BOM U+FEFF + ''Cell One'') strips the BOM -- the character a CSV file starts with'
SAVEPOINT sp_W5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := rename_node('30000000-0000-0000-0000-000000000007', chr(65279) || 'Cell One');
  IF v_res->>'name' = 'Cell One' AND v_res->>'path' = 'plant_1.assembly.line_1.cell_one' THEN
    RAISE NOTICE 'PASS W5';
  ELSE
    RAISE NOTICE 'FAIL W5: name=%, path=%', v_res->>'name', v_res->>'path';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W5;

\echo 'W6: app_trim_ws does NOT strip U+200B ZWSP -- JS String.trim() does not either, and parity is the point'
SAVEPOINT sp_W6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_got text;
BEGIN
  v_got := app_trim_ws(chr(8203) || 'a' || chr(8203));
  IF v_got = chr(8203) || 'a' || chr(8203) THEN
    RAISE NOTICE 'PASS W6';
  ELSE
    RAISE NOTICE 'FAIL W6: app_trim_ws stripped U+200B; got %', v_got;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W6;

\echo 'W7: app_trim_ws(NULL) is '''' -- matches the client''s String(d?.name ?? '''').trim()'
SAVEPOINT sp_W7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_got text;
BEGIN
  v_got := app_trim_ws(NULL);
  IF v_got = '' THEN
    RAISE NOTICE 'PASS W7';
  ELSE
    RAISE NOTICE 'FAIL W7: app_trim_ws(NULL) = %', coalesce(v_got,'<NULL>');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W7;

RESET ROLE;
\echo '70_hierarchy_test.sql: all 50 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;
