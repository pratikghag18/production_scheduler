-- ============================================================================
-- 64_cycle_times_test.sql — migration 0040, R-315: "a standard cycle time per
-- schedulable node per product."
--
-- THE MAINTAINER'S WORDS (3 Sept):
--   "At each point in the lowest hierarchy where we actually do the assignment
--    I want to assign a standard cycle time for each product which can be made
--    in that hierarchy." ... "This should not be mandatory... When no cycle
--    time are defined, the target for the assignment is null." ... "store it in
--    the database in seconds so it is consistent."
--
-- What this file pins, in the idiom of 61_ (savepoint per case, personas by
-- request.jwt.claim.sub, RAISE NOTICE PASS/FAIL):
--
--   C0   the fixture is well-formed
--   C1   a cycle time saves at a SCHEDULABLE node for a product offered there
--   C2   ...and is refused one level up, at Line 1 (not_schedulable)
--   C3   ...and is refused for a product no plant offers here (not_offered_here)
--   C4   seconds_per_unit must be > 0 (CHECK, 23514) — zero is infinite output
--   C5   a plant admin writes their OWN plant's cells; another plant's is 42501
--   C6   ...and cannot even SEE the first plant's rows (select is downward)
--   C7   ⚠️ an RLS-filtered UPDATE changes ZERO rows and raises NOTHING
--        (CLAUDE.md §4: "a write that reports success can have changed nothing")
--   C8   board_window hands the numbers to the board, RLS-scoped
--   C9   a cross-TENANT row is the composite FK's refusal (23503), not a guard's
--   C10  ⚠️ delete_node('delete') still works on a cell that has a cycle time.
--        delete_node names node_shift_templates and node_skill_requirements
--        EXPLICITLY and knows nothing about this table; without ON DELETE
--        CASCADE the FK refuses and deleting any cell ever measured fails.
--        Deleting the PRODUCT takes its cycle times too.
--
-- FIXTURE, and the reasons (borrowed from 61_):
--   * one extra PLANT in the SAME org, built through create_node — a
--     cross-TENANT refusal proves nothing about a cross-PLANT one;
--   * both plant admins hold the org-wide role 'viewer', so app_is_admin()
--     cannot short-circuit any predicate under test.
--
-- People (both org-wide 'viewer'):
--   ca  admin grant on Plant 1        — site admin of Plant 1
--   cb  admin grant on Plant C        — a second plant, sees none of Plant 1
-- The seed supplies a1 (company admin, org 1) and b1 (company admin, org 2).
--
-- Seed: Plant 1 …0001 (Site), Line 1 …0004 (Line), Cell 1 …0007 / Cell 2 …0008
-- (Work Cell — the one schedulable level). WX …0001 is made at Plant 1.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE c_fix (k text primary key, v uuid);

-- The second plant, built through create_node so it is a real root.  Ids are
-- captured in scalars and written to the TEMP table AFTER RESET ROLE:
-- `authenticated` cannot write a temp table and the refusal reads exactly like
-- RLS (61_'s instrument-failure note 34).
DO $$
DECLARE v_pc uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pc := (create_node(NULL, 'Plant C (cycle)', 7, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  RESET ROLE;
  INSERT INTO c_fix (k, v) VALUES ('pc', v_pc);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- A schedulable cell under the second plant, so C5 has somewhere legal to write.
-- create_node needs the parent chain, so Plant C gets a Department, a Line and a
-- Cell — the same four levels the template defines.
--
-- ⚠️ The template id is READ BACK from the new root, never reused from the seed:
-- creating a root COPIES the structure (0020 §10, copy-on-root-create), so Plant
-- C has its own template and passing Northwind's is refused with "p_template_id
-- does not match the parent's hierarchy template". This is also why the
-- schedulable level is per-template, which is exactly what C2 depends on.
DO $$
DECLARE v_pc uuid; v_tmpl uuid; v_dept uuid; v_line uuid; v_cell uuid;
BEGIN
  SELECT v INTO v_pc FROM c_fix WHERE k = 'pc';
  SELECT hl.template_id INTO v_tmpl
    FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
   WHERE n.id = v_pc;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_dept := (create_node(v_pc,   'C Dept', 0, v_tmpl)->>'id')::uuid;
  v_line := (create_node(v_dept, 'C Line', 0, v_tmpl)->>'id')::uuid;
  v_cell := (create_node(v_line, 'C Cell', 0, v_tmpl)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO c_fix (k, v) VALUES ('c_line', v_line), ('c_cell', v_cell);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (plant C tree): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- Runs as the owner (no SET ROLE): RLS is bypassed for the fixture, triggers
-- still fire.
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_pc uuid;
BEGIN
  SELECT v INTO v_pc FROM c_fix WHERE k = 'pc';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000064a1'),
    ('00000000-0000-0000-0000-0000000064a2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e9000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000064a1', 'viewer'),
    ('e9000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000064a2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e9000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001', v_org, 'admin'),
    ('e9000000-0000-0000-0000-000000000002', v_pc,                                  v_org, 'admin');

  -- A part made ONLY in Plant C, so Plant 1's cells may not measure it (C3).
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('6c000000-0000-0000-0000-0000000000c1', v_org, 'CONLY', 'Made only in Plant C');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, '6c000000-0000-0000-0000-0000000000c1', v_pc);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- A fixture that half-builds measures a world missing the thing the cases are about.
\echo 'C0: the fixture is well-formed — Cell 1 schedulable, Line 1 not, WX offered at Plant 1, two plant admins, neither org-wide'
SAVEPOINT sp_C0;
DO $$
DECLARE v_cell_sched boolean; v_line_sched boolean; v_wx int; v_admins int; v_ccell uuid;
BEGIN
  SELECT hl.is_schedulable INTO v_cell_sched FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
   WHERE n.id = '30000000-0000-0000-0000-000000000007';
  SELECT hl.is_schedulable INTO v_line_sched FROM nodes n JOIN hierarchy_levels hl ON hl.id = n.level_id
   WHERE n.id = '30000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_wx FROM product_sites
   WHERE product_id = '60000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_admins FROM user_profiles WHERE id::text LIKE 'e9000000%' AND role = 'admin';
  SELECT v INTO v_ccell FROM c_fix WHERE k = 'c_cell';
  IF v_cell_sched AND NOT v_line_sched AND v_wx = 1 AND v_admins = 0 AND v_ccell IS NOT NULL
  THEN RAISE NOTICE 'PASS C0';
  ELSE RAISE NOTICE 'FAIL C0: cell_sched=% line_sched=% wx_places=% org_wide_admins=% c_cell=% (want t, f, 1, 0, set)',
    v_cell_sched, v_line_sched, v_wx, v_admins, v_ccell; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C0;

-- ---------------------------------------------------------------------------
-- C1 — the happy path. Seconds, at a cell, for a part made there.
-- ---------------------------------------------------------------------------
\echo 'C1: a cycle time of 90 s saves at Cell 1 for WX and reads back'
SAVEPOINT sp_C1;
DO $$
DECLARE v_err text := 'no error'; v_secs numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '60000000-0000-0000-0000-000000000001', 90);
    SELECT seconds_per_unit INTO v_secs FROM node_product_cycle_times
     WHERE node_id = '30000000-0000-0000-0000-000000000007'
       AND product_id = '60000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  RESET ROLE;
  IF v_err = 'no error' AND v_secs = 90 THEN RAISE NOTICE 'PASS C1';
  ELSE RAISE NOTICE 'FAIL C1: err=% secs=% (want no error, 90)', v_err, v_secs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C1;

-- ---------------------------------------------------------------------------
-- C2 — the level rule. Work is booked at one level; that is where it is measured.
-- ---------------------------------------------------------------------------
\echo 'C2 ⭐: the same cycle time is REFUSED at Line 1, one level up (not_schedulable)'
SAVEPOINT sp_C2;
DO $$
DECLARE v_state text := 'no error'; v_reason text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000004',
            '60000000-0000-0000-0000-000000000001', 90);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_reason := v_detail::jsonb->>'reason';
  END;
  RESET ROLE;
  IF v_state = 'PT400' AND v_reason = 'not_schedulable' THEN RAISE NOTICE 'PASS C2';
  ELSE RAISE NOTICE 'FAIL C2: state=% reason=% (want PT400, not_schedulable)', v_state, v_reason; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C2;

-- ---------------------------------------------------------------------------
-- C3 — the offering rule. The same predicate the run/assignment guards ask, so
-- a cycle time can never exist where the part may not be scheduled.
-- ---------------------------------------------------------------------------
\echo 'C3 ⭐: a part made only in Plant C is REFUSED a cycle time at Plant 1''s Cell 1 (not_offered_here)'
SAVEPOINT sp_C3;
DO $$
DECLARE v_state text := 'no error'; v_kind text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '6c000000-0000-0000-0000-0000000000c1', 90);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
  END;
  RESET ROLE;
  IF v_state = 'PT409' AND v_kind = 'product' THEN RAISE NOTICE 'PASS C3';
  ELSE RAISE NOTICE 'FAIL C3: state=% kind=% (want PT409, product)', v_state, v_kind; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C3;

-- ---------------------------------------------------------------------------
-- C4 — zero seconds is infinite output. Refused by CHECK, not by the UI alone.
-- ---------------------------------------------------------------------------
\echo 'C4: seconds_per_unit of 0 (and of -1) is refused by the CHECK constraint (23514)'
SAVEPOINT sp_C4;
DO $$
DECLARE v_zero text := 'no error'; v_neg text := 'no error';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '60000000-0000-0000-0000-000000000001', 0);
  EXCEPTION WHEN OTHERS THEN v_zero := SQLSTATE; END;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000008',
            '60000000-0000-0000-0000-000000000001', -1);
  EXCEPTION WHEN OTHERS THEN v_neg := SQLSTATE; END;
  RESET ROLE;
  IF v_zero = '23514' AND v_neg = '23514' THEN RAISE NOTICE 'PASS C4';
  ELSE RAISE NOTICE 'FAIL C4: zero=% negative=% (want 23514, 23514)', v_zero, v_neg; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C4;

-- ---------------------------------------------------------------------------
-- C5 — WRITING is per plant. A plant admin measures their own cells only.
-- ---------------------------------------------------------------------------
\echo 'C5 ⭐: the Plant 1 admin writes Cell 2; the Plant C admin writing Cell 2 is refused (42501)'
SAVEPOINT sp_C5;
DO $$
DECLARE v_mine text := 'no error'; v_theirs text := 'no error';
BEGIN
  -- ca — a site admin of Plant 1, which contains Cell 2.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000008',
            '60000000-0000-0000-0000-000000000001', 120);
  EXCEPTION WHEN OTHERS THEN v_mine := SQLSTATE || ' ' || SQLERRM; END;
  RESET ROLE;
  -- cb — a site admin of Plant C, which does not contain Cell 2.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
            '60000000-0000-0000-0000-000000000001', 120);
  EXCEPTION WHEN OTHERS THEN v_theirs := SQLSTATE; END;
  RESET ROLE;
  IF v_mine = 'no error' AND v_theirs = '42501' THEN RAISE NOTICE 'PASS C5';
  ELSE RAISE NOTICE 'FAIL C5: own_plant=% other_plant=% (want no error, 42501)', v_mine, v_theirs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C5;

-- ---------------------------------------------------------------------------
-- C6 — READING follows the node downward, so one plant never lists another's.
-- ---------------------------------------------------------------------------
\echo 'C6: the Plant C admin sees NONE of Plant 1''s cycle times; the Plant 1 admin and the company admin see it'
SAVEPOINT sp_C6;
DO $$
DECLARE v_other int; v_own int; v_company int;
BEGIN
  INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '60000000-0000-0000-0000-000000000001', 90);

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_other FROM node_product_cycle_times;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_own FROM node_product_cycle_times;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_company FROM node_product_cycle_times;
  RESET ROLE;
  IF v_other = 0 AND v_own = 1 AND v_company = 1 THEN RAISE NOTICE 'PASS C6';
  ELSE RAISE NOTICE 'FAIL C6: plantC=% plant1=% company=% (want 0,1,1)', v_other, v_own, v_company; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C6;

-- ---------------------------------------------------------------------------
-- C7 — ⚠️ the silent no-op. CLAUDE.md §4: an RLS-filtered UPDATE removes zero
-- rows and raises NOTHING, so a client that trusts "no error" reports a save
-- that never happened. The client answer is .select() + requireWritten.
-- ---------------------------------------------------------------------------
\echo 'C7 ⭐⭐: the Plant C admin''s UPDATE of a Plant 1 cycle time raises nothing and changes ZERO rows'
SAVEPOINT sp_C7;
DO $$
DECLARE v_err text := 'no error'; v_rows int; v_after numeric;
BEGIN
  INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '60000000-0000-0000-0000-000000000001', 90);

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE node_product_cycle_times SET seconds_per_unit = 5
     WHERE node_id = '30000000-0000-0000-0000-000000000007'
       AND product_id = '60000000-0000-0000-0000-000000000001';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  RESET ROLE;
  SELECT seconds_per_unit INTO v_after FROM node_product_cycle_times
   WHERE node_id = '30000000-0000-0000-0000-000000000007'
     AND product_id = '60000000-0000-0000-0000-000000000001';
  IF v_err = 'no error' AND v_rows = 0 AND v_after = 90 THEN RAISE NOTICE 'PASS C7';
  ELSE RAISE NOTICE 'FAIL C7: err=% rows=% value_after=% (want no error, 0, 90)', v_err, v_rows, v_after; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C7;

-- ---------------------------------------------------------------------------
-- C8 — the board gets the numbers, RLS-scoped like every other key.
-- ---------------------------------------------------------------------------
\echo 'C8 ⭐: board_window emits cycle_times for the scoped cells; the Plant C admin''s window carries none of them'
SAVEPOINT sp_C8;
DO $$
DECLARE v_payload jsonb; v_n int; v_secs numeric; v_node uuid; v_other int;
BEGIN
  INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '60000000-0000-0000-0000-000000000001', 90);

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_payload := board_window('plant_1'::ltree, '2099-08-01 00:00+00', '2099-08-08 00:00+00');
  RESET ROLE;
  v_n    := jsonb_array_length(v_payload->'cycle_times');
  v_secs := (v_payload->'cycle_times'->0->>'seconds_per_unit')::numeric;
  v_node := (v_payload->'cycle_times'->0->>'node_id')::uuid;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a2', true);
  SET LOCAL ROLE authenticated;
  v_other := jsonb_array_length(
    board_window('plant_1'::ltree, '2099-08-01 00:00+00', '2099-08-08 00:00+00')->'cycle_times');
  RESET ROLE;

  IF v_n = 1 AND v_secs = 90 AND v_node = '30000000-0000-0000-0000-000000000007' AND v_other = 0
  THEN RAISE NOTICE 'PASS C8';
  ELSE RAISE NOTICE 'FAIL C8: n=% secs=% node=% plantC_sees=% (want 1, 90, cell_1, 0)',
    v_n, v_secs, v_node, v_other; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C8;

-- ---------------------------------------------------------------------------
-- C9 — cross-TENANT is the composite FK's refusal, not the guard's. The guard
-- returns early for exactly this reason (0034 §4's argument, reused).
-- ---------------------------------------------------------------------------
\echo 'C9: an org-2 row naming an org-1 node is refused by the composite tenant FK (23503)'
SAVEPOINT sp_C9;
DO $$
DECLARE v_state text := 'no error';
BEGIN
  RESET ROLE;
  BEGIN
    INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
    VALUES ('10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000007',
            '6000000b-0000-0000-0000-000000000001', 90);
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  IF v_state = '23503' THEN RAISE NOTICE 'PASS C9';
  ELSE RAISE NOTICE 'FAIL C9: state=% (want 23503)', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C9;

-- ---------------------------------------------------------------------------
-- C10 — ⚠️ the cascade. delete_node deletes node_shift_templates and
-- node_skill_requirements BY NAME and cannot know about this table; the FK's
-- ON DELETE CASCADE is the only thing that keeps deleting a measured cell from
-- failing with 23503. Deleting the product takes its cycle times too.
-- ---------------------------------------------------------------------------
\echo 'C10 ⭐⭐: delete_node(''delete'') succeeds on a cell that carries a cycle time, and deleting a product removes its cycle times'
SAVEPOINT sp_C10;
DO $$
DECLARE v_cell uuid; v_err text := 'no error'; v_left int; v_after_product int;
BEGIN
  SELECT v INTO v_cell FROM c_fix WHERE k = 'c_cell';
  -- Plant C's own part, measured at Plant C's own cell.
  INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
  VALUES ('10000000-0000-0000-0000-000000000001', v_cell,
          '6c000000-0000-0000-0000-0000000000c1', 300);

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_node(v_cell, 'delete');
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  RESET ROLE;
  SELECT count(*) INTO v_left FROM node_product_cycle_times WHERE node_id = v_cell;

  -- The product half of the cascade, at a surviving cell. A FRESH part, not a
  -- seed one: every seed product is scheduled somewhere, and removing the last
  -- plant covering scheduled work is refused by app_guard_product_site_remove
  -- (0034 §5) — a different rule, already pinned by 61_P7, and not this case.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('6c000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000001',
     'CTDEL', 'Measured, never scheduled');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    ('10000000-0000-0000-0000-000000000001', '6c000000-0000-0000-0000-0000000000c2',
     '30000000-0000-0000-0000-000000000001');
  INSERT INTO node_product_cycle_times (org_id, node_id, product_id, seconds_per_unit)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '6c000000-0000-0000-0000-0000000000c2', 90);
  DELETE FROM products WHERE id = '6c000000-0000-0000-0000-0000000000c2';
  SELECT count(*) INTO v_after_product FROM node_product_cycle_times
   WHERE product_id = '6c000000-0000-0000-0000-0000000000c2';

  IF v_err = 'no error' AND v_left = 0 AND v_after_product = 0 THEN RAISE NOTICE 'PASS C10';
  ELSE RAISE NOTICE 'FAIL C10: delete_node=% rows_left=% after_product_delete=% (want no error, 0, 0)',
    v_err, v_left, v_after_product; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C10;

-- ---------------------------------------------------------------------------
-- C11/C12 — R-319: the add-up choice is a column on `nodes`, carrying the same
-- authority as renaming one. No new policy was written for it, so these two
-- cases are what say that `nodes_update` actually covers it — an untested
-- assumption there would mean either a setting nobody can change or one that
-- any plant can change on another's structure.
-- ---------------------------------------------------------------------------
\echo 'C11: a plant admin sets sums_children on their OWN line, and it reads back'
SAVEPOINT sp_C11;
DO $$
DECLARE v_line uuid; v_err text := 'no error'; v_after boolean;
BEGIN
  -- Line 1 in the seed: not schedulable, and it owns Cells 1-3.
  v_line := '30000000-0000-0000-0000-000000000004';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET sums_children = false WHERE id = v_line;
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  RESET ROLE;
  SELECT sums_children INTO v_after FROM nodes WHERE id = v_line;
  IF v_err = 'no error' AND v_after IS FALSE THEN RAISE NOTICE 'PASS C11';
  ELSE RAISE NOTICE 'FAIL C11: err=% stored=% (want no error, false)', v_err, v_after; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C11;

\echo 'C12 ⭐: the OTHER plant''s admin changes zero rows and raises nothing — the silent no-op again'
SAVEPOINT sp_C12;
DO $$
DECLARE v_line uuid; v_err text := 'no error'; v_rows int; v_after boolean;
BEGIN
  v_line := '30000000-0000-0000-0000-000000000004';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000064a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET sums_children = true WHERE id = v_line;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  RESET ROLE;
  SELECT sums_children INTO v_after FROM nodes WHERE id = v_line;
  -- Unset before and unset after: the write was filtered away, not applied.
  IF v_err = 'no error' AND v_rows = 0 AND v_after IS NULL THEN RAISE NOTICE 'PASS C12';
  ELSE RAISE NOTICE 'FAIL C12: err=% rows=% stored=% (want no error, 0, NULL)',
    v_err, v_rows, v_after; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C12;

\echo 'C13: the column starts unset, so "nobody has said" is distinguishable from "chosen false"'
SAVEPOINT sp_C13;
DO $$
DECLARE v_unset int;
BEGIN
  SELECT count(*) INTO v_unset FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sums_children IS NULL;
  IF v_unset > 0 THEN RAISE NOTICE 'PASS C13';
  ELSE RAISE NOTICE 'FAIL C13: no node is unset, so the migration backfilled a guess'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_C13;

ROLLBACK;
