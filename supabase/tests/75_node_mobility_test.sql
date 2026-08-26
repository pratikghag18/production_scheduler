-- ============================================================================
-- 75_node_mobility_test.sql — migration 0017 (D94 place_node, P1-5k
-- promote_node/demote_node, D97 the escape-hatch lock). 33 cases, M1-M33.
--
-- Same shape as 70_hierarchy_test.sql and for the same reason: every case is
-- its own SAVEPOINT + DO block with an outer `EXCEPTION WHEN OTHERS` that
-- turns any unexpected error into a FAIL notice instead of aborting the run,
-- because this file is re-run once per mutation and a file that stops at the
-- first failure cannot say which case caught which mutation.
--
-- Assert on the machine `error` code parsed from DETAIL, never on SQLSTATE or
-- message text.
--
-- WHY THIS FILE EXISTS AT ALL: these 33 checks were first written as a scratch
-- script and run there. That is the exact failure rule 11 records — a suite
-- that ran once in a container and vanished, leaving the most thoroughly
-- validated code as the only code with no committed guard.
--
-- Northwind org 10000000-...-0001, admin sub ...a1, supervisor sub ...a2.
--   Plant 1 30000000-...-0001 / Assembly ...-0002 / Line 1 ...-0004
--   Cell 1 ...-0007 / Cell 2 ...-0008 / Cell 3 ...-0009   (all children of Line 1)
-- Contoso org 10000000-...-0002, admin sub ...b1.
--   Line 1 3000000b-...-0004 / Cell 1 3000000b-...-0007 (holds 1 run + 1 assignment)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- place_node — M1-M10
-- ---------------------------------------------------------------------------

\echo 'M1: place Cell 3 between Cell 1 and Cell 2 -> Cell 1, Cell 3, Cell 2'
SAVEPOINT sp_M1;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_order text;
BEGIN
  PERFORM place_node('30000000-0000-0000-0000-000000000009',
                     '30000000-0000-0000-0000-000000000004', 1);
  SELECT string_agg(name, ',' ORDER BY sort_order) INTO v_order
    FROM nodes WHERE parent_id = '30000000-0000-0000-0000-000000000004';
  IF v_order = 'Cell 1,Cell 3,Cell 2' THEN RAISE NOTICE 'PASS M1';
  ELSE RAISE NOTICE 'FAIL M1: order is %, expected Cell 1,Cell 3,Cell 2', v_order; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M1;

\echo 'M2: a reorder leaves every path untouched -- it moves nothing in the tree'
SAVEPOINT sp_M2;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_path ltree;
BEGIN
  PERFORM place_node('30000000-0000-0000-0000-000000000009',
                     '30000000-0000-0000-0000-000000000004', 1);
  SELECT path INTO v_path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000009';
  IF v_path = 'plant_1.assembly.line_1.cell_3'::ltree THEN RAISE NOTICE 'PASS M2';
  ELSE RAISE NOTICE 'FAIL M2: path is %', v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M2;

\echo 'M3: an index past the end clamps to last'
SAVEPOINT sp_M3;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_order text;
BEGIN
  PERFORM place_node('30000000-0000-0000-0000-000000000007',
                     '30000000-0000-0000-0000-000000000004', 99);
  SELECT string_agg(name, ',' ORDER BY sort_order) INTO v_order
    FROM nodes WHERE parent_id = '30000000-0000-0000-0000-000000000004';
  IF v_order = 'Cell 2,Cell 3,Cell 1' THEN RAISE NOTICE 'PASS M3';
  ELSE RAISE NOTICE 'FAIL M3: order is %', v_order; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M3;

\echo 'M4: a negative index clamps to first'
SAVEPOINT sp_M4;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_order text;
BEGIN
  PERFORM place_node('30000000-0000-0000-0000-000000000008',
                     '30000000-0000-0000-0000-000000000004', -5);
  SELECT string_agg(name, ',' ORDER BY sort_order) INTO v_order
    FROM nodes WHERE parent_id = '30000000-0000-0000-0000-000000000004';
  IF v_order = 'Cell 2,Cell 1,Cell 3' THEN RAISE NOTICE 'PASS M4';
  ELSE RAISE NOTICE 'FAIL M4: order is %', v_order; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M4;

\echo 'M5: a NULL index means first, it does not throw'
SAVEPOINT sp_M5;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_order text;
BEGIN
  PERFORM place_node('30000000-0000-0000-0000-000000000009',
                     '30000000-0000-0000-0000-000000000004', NULL);
  SELECT string_agg(name, ',' ORDER BY sort_order) INTO v_order
    FROM nodes WHERE parent_id = '30000000-0000-0000-0000-000000000004';
  IF v_order = 'Cell 3,Cell 1,Cell 2' THEN RAISE NOTICE 'PASS M5';
  ELSE RAISE NOTICE 'FAIL M5: order is %', v_order; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M5;

-- M6-M9 prove the DELEGATION: place_node restates none of move_node's guards,
-- so each of these must surface move_node's own error code unchanged.
\echo 'M6: place onto a wrong-level parent -> level_mismatch (delegated to move_node)'
SAVEPOINT sp_M6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM place_node('30000000-0000-0000-0000-000000000009',
                       '30000000-0000-0000-0000-000000000008', 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN RAISE NOTICE 'PASS M6';
  ELSE RAISE NOTICE 'FAIL M6: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M6;

\echo 'M7: place a node under its own child -> node_cycle (delegated)'
SAVEPOINT sp_M7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM place_node('30000000-0000-0000-0000-000000000004',
                       '30000000-0000-0000-0000-000000000007', 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN RAISE NOTICE 'PASS M7';
  ELSE RAISE NOTICE 'FAIL M7: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M7;

\echo 'M8: place an unknown node id -> invalid_argument (delegated)'
SAVEPOINT sp_M8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM place_node('99999999-9999-9999-9999-999999999999',
                       '30000000-0000-0000-0000-000000000004', 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN RAISE NOTICE 'PASS M8';
  ELSE RAISE NOTICE 'FAIL M8: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M8;

-- M9 is the tenant case. It must never become a read-path test in disguise:
-- an org-1 admin naming an org-2 node must be refused, and the refusal must be
-- the org scope, not a coincidence of the node not existing.
\echo 'M9: an org-1 admin placing an org-2 node -> invalid_argument (org scope)'
SAVEPOINT sp_M9;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb; v_exists boolean;
BEGIN
  -- assert the fixture first: the node really does exist, in the other org
  SELECT EXISTS (SELECT 1 FROM nodes WHERE id = '3000000b-0000-0000-0000-000000000007')
    INTO v_exists;
  BEGIN
    PERFORM place_node('3000000b-0000-0000-0000-000000000007',
                       '30000000-0000-0000-0000-000000000004', 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN RAISE NOTICE 'PASS M9';
  ELSE RAISE NOTICE 'FAIL M9: caught=%, detail=%, fixture_visible_to_org1=%',
        v_caught, v_detail, v_exists; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M9;

\echo 'M10: a supervisor cannot place -> not_permitted'
SAVEPOINT sp_M10;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM place_node('30000000-0000-0000-0000-000000000009',
                       '30000000-0000-0000-0000-000000000004', 1);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS M10';
  ELSE RAISE NOTICE 'FAIL M10: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M10;

-- ---------------------------------------------------------------------------
-- promote_node / demote_node — M11-M21
--
-- M11 and M12 are a PAIR and the pair is the point. M11 proves the guard
-- refuses the damage; M12 proves it is a guard and not a lock-out, by making
-- the identical call succeed once the work is moved. A suite with only M11
-- cannot tell a correct refusal from a function that refuses everything.
-- ---------------------------------------------------------------------------

\echo 'M11: promote refused while the subtree still holds scheduled work -> schedulable_level_locked'
SAVEPOINT sp_M11;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb; v_runs int;
BEGIN
  SELECT count(*) INTO v_runs FROM runs WHERE node_id = '3000000b-0000-0000-0000-000000000007';
  BEGIN
    PERFORM promote_node('3000000b-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'schedulable_level_locked' AND v_runs > 0 THEN
    RAISE NOTICE 'PASS M11';
  ELSE RAISE NOTICE 'FAIL M11: caught=%, detail=%, fixture_runs=%', v_caught, v_detail, v_runs; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M11;

\echo 'M12: the IDENTICAL promote succeeds once the work is moved off -- a guard, not a lock-out'
SAVEPOINT sp_M12;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b1';
DO $$
DECLARE v_path ltree;
BEGIN
  DELETE FROM assignments WHERE node_id = '3000000b-0000-0000-0000-000000000007';
  DELETE FROM runs WHERE node_id = '3000000b-0000-0000-0000-000000000007';
  PERFORM promote_node('3000000b-0000-0000-0000-000000000004');
  SELECT path INTO v_path FROM nodes WHERE id = '3000000b-0000-0000-0000-000000000007';
  IF v_path = 'plant_1.line_1.cell_1'::ltree THEN RAISE NOTICE 'PASS M12';
  ELSE RAISE NOTICE 'FAIL M12: path is %, expected plant_1.line_1.cell_1', v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M12;

\echo 'M13: a promote leaves ZERO adjacency violations in the org'
SAVEPOINT sp_M13;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000b1';
DO $$
DECLARE v_bad int;
BEGIN
  DELETE FROM assignments WHERE node_id = '3000000b-0000-0000-0000-000000000007';
  DELETE FROM runs WHERE node_id = '3000000b-0000-0000-0000-000000000007';
  PERFORM promote_node('3000000b-0000-0000-0000-000000000004');
  SELECT count(*) INTO v_bad
    FROM nodes n
    JOIN hierarchy_levels nl ON nl.id = n.level_id
    LEFT JOIN nodes p ON p.id = n.parent_id
    LEFT JOIN hierarchy_levels pl ON pl.id = p.level_id
   WHERE n.org_id = '10000000-0000-0000-0000-000000000002'
     AND ((n.parent_id IS NULL AND nl.position <> 0)
       OR (n.parent_id IS NOT NULL AND nl.position <> pl.position + 1));
  IF v_bad = 0 THEN RAISE NOTICE 'PASS M13';
  ELSE RAISE NOTICE 'FAIL M13: % adjacency violations after promote', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M13;

-- ⭐ M14 is the case the whole top-down design exists for, and its FIRST
-- fixture could not deliver it. It promoted Line 1, whose descendants are all
-- Work Cells -- ONE depth band, so the loop's ordering was irrelevant and a
-- mutation reversing it (deepest-first) was caught by nothing. Assembly has
-- TWO bands of descendants (Lines, then Cells), which is the minimum that can
-- tell top-down from bottom-up. The case asserts its own fixture depth so it
-- can never silently regress to the shallow version again.
\echo 'M14: promoting a subtree with TWO generations below it holds -- 0 violations'
SAVEPOINT sp_M14;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_bad int; v_asm_pos int; v_line_pos int; v_cell_pos int; v_bands int;
BEGIN
  SELECT count(DISTINCT nlevel(path)) INTO v_bands
    FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001'
     AND path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002')
     AND id <> '30000000-0000-0000-0000-000000000002';

  DELETE FROM assignments WHERE node_id IN
    (SELECT id FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001'
       AND path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002'));
  DELETE FROM runs WHERE node_id IN
    (SELECT id FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001'
       AND path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002'));

  PERFORM promote_node('30000000-0000-0000-0000-000000000002');

  SELECT hl.position INTO v_asm_pos FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
    WHERE n.id = '30000000-0000-0000-0000-000000000002';
  SELECT hl.position INTO v_line_pos FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
    WHERE n.id = '30000000-0000-0000-0000-000000000004';
  SELECT hl.position INTO v_cell_pos FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
    WHERE n.id = '30000000-0000-0000-0000-000000000007';
  SELECT count(*) INTO v_bad
    FROM nodes n JOIN hierarchy_levels nl ON nl.id = n.level_id
    LEFT JOIN nodes p ON p.id = n.parent_id
    LEFT JOIN hierarchy_levels pl ON pl.id = p.level_id
   WHERE n.org_id = '10000000-0000-0000-0000-000000000001'
     AND ((n.parent_id IS NULL AND nl.position <> 0)
       OR (n.parent_id IS NOT NULL AND nl.position <> pl.position + 1));

  IF v_bands >= 2 AND v_bad = 0 AND v_asm_pos = 0 AND v_line_pos = 1 AND v_cell_pos = 2 THEN
    RAISE NOTICE 'PASS M14';
  ELSE
    RAISE NOTICE 'FAIL M14: fixture_bands=% (need >=2), violations=%, assembly=% (want 0), line=% (want 1), cell=% (want 2)',
      v_bands, v_bad, v_asm_pos, v_line_pos, v_cell_pos;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M14;

\echo 'M15: a relevel NEVER sets the escape hatch -- the trigger stays armed throughout'
SAVEPOINT sp_M15;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_hatch text;
BEGIN
  DELETE FROM assignments WHERE node_id IN
    (SELECT id FROM nodes WHERE path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'));
  DELETE FROM runs WHERE node_id IN
    (SELECT id FROM nodes WHERE path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'));
  PERFORM promote_node('30000000-0000-0000-0000-000000000004');
  v_hatch := coalesce(current_setting('app.hierarchy_migration', true), '');
  IF v_hatch = '' THEN RAISE NOTICE 'PASS M15';
  ELSE RAISE NOTICE 'FAIL M15: hatch is %, expected unset', v_hatch; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M15;

\echo 'M16: promoting a top-level node is refused -- there is no rung above'
SAVEPOINT sp_M16;
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
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN RAISE NOTICE 'PASS M16';
  ELSE RAISE NOTICE 'FAIL M16: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M16;

-- ⭐ M17 is the case that matters most in this file. Measured BEFORE the
-- up-front rung check existed, a demote off the bottom of the template did not
-- fail: the level update matched zero rows, the parent change STOOD, and the
-- tree was left with an adjacency violation. It half-succeeded. The assertion
-- is therefore both "refused" AND "nothing moved".
\echo 'M17: demote off the bottom of the template is refused, and NOTHING moves'
SAVEPOINT sp_M17;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb; v_parent uuid;
BEGIN
  BEGIN
    PERFORM demote_node('30000000-0000-0000-0000-000000000007',
                        '30000000-0000-0000-0000-000000000008');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT parent_id INTO v_parent FROM nodes WHERE id = '30000000-0000-0000-0000-000000000007';
  IF v_caught AND v_detail->>'reason' = 'no destination level'
     AND v_parent = '30000000-0000-0000-0000-000000000004' THEN
    RAISE NOTICE 'PASS M17';
  ELSE RAISE NOTICE 'FAIL M17: caught=%, detail=%, parent_now=%', v_caught, v_detail, v_parent; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M17;

\echo 'M18: demote onto a target at the wrong level is refused'
SAVEPOINT sp_M18;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM demote_node('30000000-0000-0000-0000-000000000004',
                            '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch'
     AND v_detail->>'reason' LIKE '%own level%' THEN RAISE NOTICE 'PASS M18';
  ELSE RAISE NOTICE 'FAIL M18: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M18;

\echo 'M19: demote onto ones own descendant -> node_cycle'
SAVEPOINT sp_M19;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM demote_node('30000000-0000-0000-0000-000000000002',
                            '30000000-0000-0000-0000-000000000007');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'node_cycle' THEN RAISE NOTICE 'PASS M19';
  ELSE RAISE NOTICE 'FAIL M19: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M19;

-- M20 is demote's success case, and it needs a subtree with HEADROOM. A
-- Department whose subtree already reaches Work Cell cannot be demoted at all,
-- so the fixture creates a childless one -- a case whose name promises a
-- successful demote must have a fixture that can deliver one.
\echo 'M20: a childless Department demoted under a sibling becomes a Line'
SAVEPOINT sp_M20;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_new uuid; v_path ltree; v_pos int;
BEGIN
  v_new := (create_node('30000000-0000-0000-0000-000000000001', 'Finishing', 0, NULL)->>'id')::uuid;
  PERFORM demote_node(v_new, '30000000-0000-0000-0000-000000000002');
  SELECT n.path, hl.position INTO v_path, v_pos
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_new;
  IF v_path = 'plant_1.assembly.finishing'::ltree AND v_pos = 2 THEN RAISE NOTICE 'PASS M20';
  ELSE RAISE NOTICE 'FAIL M20: path=%, position=% (want 2)', v_path, v_pos; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M20: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M20;

\echo 'M21: a supervisor cannot promote -> not_permitted'
SAVEPOINT sp_M21;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS M21';
  ELSE RAISE NOTICE 'FAIL M21: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M21: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M21;

-- ---------------------------------------------------------------------------
-- The escape hatch, D97 — M22-M25.
-- M22/M23 are the lock; M24 rescues what the lock must NOT break; M25 proves
-- the underlying rule still works with the hatch out of the picture entirely,
-- so a mutation that neuters the whole trigger cannot hide behind the lock.
-- ---------------------------------------------------------------------------

\echo 'M22: `authenticated` setting the hatch is refused -> not_permitted'
SAVEPOINT sp_M22;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000001'
      WHERE id = '30000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS M22';
  ELSE RAISE NOTICE 'FAIL M22: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M22: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M22;

\echo 'M23: the refusal names the reason, so it is not confused with an adjacency error'
SAVEPOINT sp_M23;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000001'
      WHERE id = '30000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_detail->>'reason' = 'hierarchy_migration bypass not permitted for this role' THEN
    RAISE NOTICE 'PASS M23';
  ELSE RAISE NOTICE 'FAIL M23: detail=%', v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M23: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M23;

\echo 'M24: the OWNER may still use the hatch, and the path cascade still runs under it'
SAVEPOINT sp_M24;
RESET ROLE;
DO $$
DECLARE v_path ltree;
BEGIN
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000002'
    WHERE id = '30000000-0000-0000-0000-000000000007';
  SELECT path INTO v_path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000007';
  IF v_path = 'plant_1.assembly.cell_1'::ltree THEN RAISE NOTICE 'PASS M24';
  ELSE RAISE NOTICE 'FAIL M24: path is %', v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M24: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M24;

\echo 'M25: with the hatch unset, the level rule still refuses a level-skipping move'
SAVEPOINT sp_M25;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000001'
      WHERE id = '30000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'level_mismatch' THEN RAISE NOTICE 'PASS M25';
  ELSE RAISE NOTICE 'FAIL M25: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL M25: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_M25;

-- ---------------------------------------------------------------------------
-- Grants — M26-M33. D93 was exactly this: a migration that created four
-- functions and granted only a table, leaving all four anon-executable. A
-- guard that checks ONE member of a set a migration created will not tell you
-- the migration forgot the set, so all four are checked in both directions.
-- ---------------------------------------------------------------------------
\echo 'M26-M33: the four new functions are revoked from anon and granted to authenticated'
SAVEPOINT sp_M26;
RESET ROLE;
DO $$
DECLARE
  fns text[] := ARRAY['place_node(uuid,uuid,int)', 'app_relevel_subtree(uuid,uuid,int)',
                      'promote_node(uuid)', 'demote_node(uuid,uuid)'];
  f text; i int := 26;
BEGIN
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE NOTICE 'FAIL M%: anon can execute %', i, f;
    ELSE RAISE NOTICE 'PASS M% (anon cannot execute %)', i, f; END IF;
    i := i + 1;
  END LOOP;
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE NOTICE 'PASS M% (authenticated can execute %)', i, f;
    ELSE RAISE NOTICE 'FAIL M%: authenticated cannot execute %', i, f; END IF;
    i := i + 1;
  END LOOP;
END $$;
ROLLBACK TO SAVEPOINT sp_M26;

RESET ROLE;
\echo '75_node_mobility_test.sql: all 33 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;
