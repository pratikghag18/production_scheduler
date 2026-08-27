-- ============================================================================
-- 76_relevel_contract_test.sql — migration 0024. 17 cases, N1-N17.
--
-- 0024 changes only what an already-failing call SAYS, so every case here
-- asserts a MACHINE CODE or a DETAIL PAYLOAD SHAPE, never a message string.
-- That is the whole point: `parseSchedulerError` reads the code out of DETAIL
-- and the payload keys by name, and both were wrong.
--
-- Same shape as 75_node_mobility_test.sql: one SAVEPOINT per case, an outer
-- `EXCEPTION WHEN OTHERS` that turns any unexpected error into a FAIL notice
-- rather than aborting the file, because this file is re-run once per mutation.
--
-- Northwind org 10000000-...-0001, admin sub ...a1.
--   Plant 1 30000000-...-0001 (Site) / Assembly ...-0002 (Department)
--   Line 1 ...-0004 / Cell 1 ...-0007 (3 runs, 3 assignments)
--   Plant 1's template 21000000-...-0001, levels Site/Department/Line/Work Cell.
-- EVERY Work Cell in the seed carries work, so the clean-path cases below build
-- their own childless subtree rather than borrowing one -- rule 3b, a case name
-- that says "no collision" must not be silently testing "stranded work".
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The collision, which used to be a raw 23505 with an empty DETAIL — N1-N5.
-- ---------------------------------------------------------------------------

\echo 'N1: promote into a parent that already has that name -> path_collision'
SAVEPOINT sp_N1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_cell uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  v_line := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Test Cell', 0, NULL)->>'id')::uuid;
  -- a LINE under Assembly already called 'Test Cell', which is where the
  -- promoted work cell is about to land
  PERFORM create_node('30000000-0000-0000-0000-000000000002', 'Test Cell', 0, NULL);
  BEGIN PERFORM promote_node(v_cell);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision' THEN RAISE NOTICE 'PASS N1';
  ELSE RAISE NOTICE 'FAIL N1: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N1;

\echo 'N2: its DETAIL carries the prospective path and the REAL colliding node id'
SAVEPOINT sp_N2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_cell uuid; v_other uuid; v_raw text; v_detail jsonb;
BEGIN
  v_line  := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  v_cell  := (create_node(v_line, 'Test Cell', 0, NULL)->>'id')::uuid;
  v_other := (create_node('30000000-0000-0000-0000-000000000002', 'Test Cell', 0, NULL)->>'id')::uuid;
  BEGIN PERFORM promote_node(v_cell);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  -- The path is asserted as a LITERAL, not read back from the row that caused
  -- it: deriving the expectation from the thing under test is rule 3.
  IF v_detail->>'path' = 'plant_1.assembly.test_cell'
     AND (v_detail->>'existing_node_id')::uuid = v_other THEN RAISE NOTICE 'PASS N2';
  ELSE RAISE NOTICE 'FAIL N2: detail=%, expected existing_node_id=%', v_detail, v_other; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N2;

\echo 'N3: demote into a target that already has that name -> path_collision'
SAVEPOINT sp_N3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_x uuid; v_y uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  v_x := (create_node('30000000-0000-0000-0000-000000000001', 'Dept X', 0, NULL)->>'id')::uuid;
  v_y := (create_node('30000000-0000-0000-0000-000000000001', 'Dept Y', 0, NULL)->>'id')::uuid;
  PERFORM create_node(v_y, 'Dept X', 0, NULL);
  BEGIN PERFORM demote_node(v_x, v_y);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision' THEN RAISE NOTICE 'PASS N3';
  ELSE RAISE NOTICE 'FAIL N3: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N3;

\echo 'N4: the SAME demote without the colliding name succeeds -- the guard is not a wall'
SAVEPOINT sp_N4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_x uuid; v_y uuid; v_path ltree; v_pos int;
BEGIN
  v_x := (create_node('30000000-0000-0000-0000-000000000001', 'Dept X', 0, NULL)->>'id')::uuid;
  v_y := (create_node('30000000-0000-0000-0000-000000000001', 'Dept Y', 0, NULL)->>'id')::uuid;
  PERFORM demote_node(v_x, v_y);
  SELECT n.path, hl.position INTO v_path, v_pos
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_x;
  IF v_path = 'plant_1.dept_y.dept_x'::ltree AND v_pos = 2 THEN RAISE NOTICE 'PASS N4';
  ELSE RAISE NOTICE 'FAIL N4: path=%, position=% (want 2)', v_path, v_pos; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N4;

\echo 'N5: a promote with no collision and no work succeeds and lands one rung up'
SAVEPOINT sp_N5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_cell uuid; v_path ltree; v_pos int;
BEGIN
  v_line := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Test Cell', 0, NULL)->>'id')::uuid;
  PERFORM promote_node(v_cell);
  SELECT n.path, hl.position INTO v_path, v_pos
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_cell;
  IF v_path = 'plant_1.assembly.test_cell'::ltree AND v_pos = 2 THEN RAISE NOTICE 'PASS N5';
  ELSE RAISE NOTICE 'FAIL N5: path=%, position=% (want 2)', v_path, v_pos; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N5;

-- ---------------------------------------------------------------------------
-- The payload the client could not decode — N6-N8.
-- ---------------------------------------------------------------------------

\echo 'N6: the stranded-work refusal carries blocking_rows AND level_id -- the shape the client parses'
SAVEPOINT sp_N6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000007');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'schedulable_level_locked'
     AND jsonb_typeof(v_detail->'blocking_rows') = 'number'
     AND jsonb_typeof(v_detail->'level_id') = 'string' THEN RAISE NOTICE 'PASS N6';
  ELSE RAISE NOTICE 'FAIL N6: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N6;

\echo 'N7: blocking_rows is the real number of runs in the moved subtree'
SAVEPOINT sp_N7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_raw text; v_detail jsonb; v_runs int;
BEGIN
  SELECT count(*) INTO v_runs FROM runs
   WHERE node_id = '30000000-0000-0000-0000-000000000007';
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000007');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_runs = 3 AND (v_detail->>'blocking_rows')::int = v_runs THEN RAISE NOTICE 'PASS N7';
  ELSE RAISE NOTICE 'FAIL N7: runs=% (want 3), detail=%', v_runs, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N7;

\echo 'N8: level_id names a real, NON-schedulable level in the node''s own template'
SAVEPOINT sp_N8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_raw text; v_detail jsonb; v_sched boolean; v_tpl uuid; v_pos int;
BEGIN
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000007');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT is_schedulable, template_id, position INTO v_sched, v_tpl, v_pos
    FROM hierarchy_levels WHERE id = (v_detail->>'level_id')::uuid;
  IF v_sched IS FALSE AND v_tpl = '21000000-0000-0000-0000-000000000001'
     AND v_pos = 2 THEN RAISE NOTICE 'PASS N8';
  ELSE RAISE NOTICE 'FAIL N8: sched=%, template=%, position=% (want f/plant-1 template/2), detail=%',
       v_sched, v_tpl, v_pos, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N8;

-- ---------------------------------------------------------------------------
-- The subtree exclusion, and the guards 0024 must not have disturbed — N9-N14.
-- ---------------------------------------------------------------------------

\echo 'N9: a node WITH descendants and no collision is not refused -- the subtree is excluded from its own candidates'
SAVEPOINT sp_N9;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_cell uuid; v_lp ltree; v_cp ltree;
BEGIN
  v_line := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Test Cell', 0, NULL)->>'id')::uuid;
  PERFORM promote_node(v_line);
  SELECT path INTO v_lp FROM nodes WHERE id = v_line;
  SELECT path INTO v_cp FROM nodes WHERE id = v_cell;
  IF v_lp = 'plant_1.test_line'::ltree AND v_cp = 'plant_1.test_line.test_cell'::ltree
    THEN RAISE NOTICE 'PASS N9';
  ELSE RAISE NOTICE 'FAIL N9: line=%, cell=%', v_lp, v_cp; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N9;

\echo 'N10: a promote to ROOT collides too -- the NULL-prefix branch is not decoration'
SAVEPOINT sp_N10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_dept uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  v_dept := (create_node('30000000-0000-0000-0000-000000000001', 'Widgets', 0, NULL)->>'id')::uuid;
  PERFORM create_node(NULL, 'Widgets', 0, '21000000-0000-0000-0000-000000000001');
  BEGIN PERFORM promote_node(v_dept);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision'
     AND v_detail->>'path' = 'widgets' THEN RAISE NOTICE 'PASS N10';
  ELSE RAISE NOTICE 'FAIL N10: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N10;

\echo 'N11: a top-level node still cannot be promoted -> level_mismatch'
SAVEPOINT sp_N11;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN RAISE NOTICE 'PASS N11';
  ELSE RAISE NOTICE 'FAIL N11: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N11;

\echo 'N12: demoting a node beneath its own descendant is still node_cycle'
SAVEPOINT sp_N12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM demote_node('30000000-0000-0000-0000-000000000002',
                            '30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN RAISE NOTICE 'PASS N12';
  ELSE RAISE NOTICE 'FAIL N12: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N12;

\echo 'N13: a demote with no rung below is still level_mismatch, and still fires BEFORE the collision check'
SAVEPOINT sp_N13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM demote_node('30000000-0000-0000-0000-000000000009',
                            '30000000-0000-0000-0000-000000000008');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch'
     AND v_detail->>'reason' = 'no destination level' THEN RAISE NOTICE 'PASS N13';
  ELSE RAISE NOTICE 'FAIL N13: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N13;

\echo 'N14: a collision is still caught when the moved node HAS descendants'
SAVEPOINT sp_N14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  v_line := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  PERFORM create_node(v_line, 'Test Cell', 0, NULL);
  -- a DEPARTMENT under Plant 1 already called 'Test Line', which is where the
  -- promoted line is about to land
  PERFORM create_node('30000000-0000-0000-0000-000000000001', 'Test Line', 0, NULL);
  BEGIN PERFORM promote_node(v_line);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'path_collision'
     AND v_detail->>'path' = 'plant_1.test_line' THEN RAISE NOTICE 'PASS N14';
  ELSE RAISE NOTICE 'FAIL N14: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N14;

-- ---------------------------------------------------------------------------
-- The two org scopes inside the new check — N15-N16. Both were written because
-- a mutation escaped: dropping either `org_id` filter was caught by NOTHING.
-- N15 turned out to be a MISSING CASE; N16 pins the fact that makes the other
-- one inert, so that removing the guard it depends on turns the mutation live
-- and this case red in the same run (verification-standard rule 7f).
-- ---------------------------------------------------------------------------

\echo 'N15: an identical path in ANOTHER org is not a collision'
SAVEPOINT sp_N15;
SET LOCAL ROLE authenticated;
-- Contoso's admin builds the decoy. Contoso's tree is path-for-path identical
-- to Northwind's (both seed a `plant_1.assembly.line_1`), which is exactly why
-- a missing org filter here would be invisible in every other case in this file.
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b1';
DO $$
DECLARE v_decoy int;
BEGIN
  PERFORM create_node('3000000b-0000-0000-0000-000000000002', 'Test Cell', 0, NULL);
  -- Counted HERE, while this session can still see it. RLS filters `nodes` by
  -- org, so the Northwind half below reads 0 for a decoy that exists -- the
  -- first draft of this case did exactly that and its own assertion caught it
  -- (verification-standard instrument 34: read every fixture value before the
  -- identity changes).
  SELECT count(*) INTO v_decoy FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000002'
     AND path = 'plant_1.assembly.test_cell'::ltree;
  IF v_decoy <> 1 THEN
    RAISE NOTICE 'FAIL N15: decoy not built, count=%', v_decoy;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N15: fixture build failed: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_line uuid; v_cell uuid; v_path ltree;
BEGIN
  v_line := (create_node('30000000-0000-0000-0000-000000000002', 'Test Line', 0, NULL)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Test Cell', 0, NULL)->>'id')::uuid;
  PERFORM promote_node(v_cell);
  SELECT path INTO v_path FROM nodes WHERE id = v_cell;
  IF v_path = 'plant_1.assembly.test_cell'::ltree THEN RAISE NOTICE 'PASS N15';
  ELSE RAISE NOTICE 'FAIL N15: path=%', v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N15;

\echo 'N16: app_relevel_subtree is callable directly, and a FOREIGN destination is refused'
SAVEPOINT sp_N16;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_x uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- app_relevel_subtree is granted to `authenticated`, so PostgREST exposes it:
  -- promote_node and demote_node are NOT the only way in, and a destination in
  -- another org cannot be reached through either of them. 0020's destination
  -- admin check is what refuses this, and it runs BEFORE 0024's collision
  -- pre-check -- which is why the org filter on that pre-check's parent lookup
  -- is unreachable and its mutation (S6) is inert. If this case ever goes red,
  -- that mutation is live again.
  v_x := (create_node('30000000-0000-0000-0000-000000000001', 'Dept X', 0, NULL)->>'id')::uuid;
  BEGIN PERFORM app_relevel_subtree(v_x, '3000000b-0000-0000-0000-000000000002', 1);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS N16';
  ELSE RAISE NOTICE 'FAIL N16: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N16;

\echo 'N17: every path in the org has every prefix of itself as a real node'
SAVEPOINT sp_N17;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_bad int; v_total int;
BEGIN
  -- THE INVARIANT 0024's COLLISION CHECK QUIETLY RESTS ON, asserted directly
  -- rather than assumed. `nodes_before_path` / `nodes_cascade_path` build every
  -- path as parent-path + own label, so a path can only EXIST if every prefix
  -- of it exists as a node. That is why narrowing the collision check to the
  -- moved node alone changes no verdict (mutation S10, executed and inert): if
  -- a DESCENDANT's prospective path already existed, the node's own prospective
  -- path -- a prefix of it -- would exist too, and would be found first.
  -- If this case ever goes red, S10 is live again.
  SELECT count(*) INTO v_total FROM nodes;
  SELECT count(*) INTO v_bad FROM nodes n
   WHERE (n.parent_id IS NULL AND nlevel(n.path) <> 1)
      OR (n.parent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM nodes p
             WHERE p.id = n.parent_id
               AND n.path <@ p.path
               AND nlevel(n.path) = nlevel(p.path) + 1));
  IF v_bad = 0 AND v_total > 0 THEN RAISE NOTICE 'PASS N17';
  ELSE RAISE NOTICE 'FAIL N17: % of % nodes have a path with no parent behind it', v_bad, v_total; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL N17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N17;

ROLLBACK;
