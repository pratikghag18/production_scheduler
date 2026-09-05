-- ============================================================================
-- 73_plant_settings_test.sql — migration 0050, "a setting is answered for a
-- plant, not only for the company." (R-331)
--
-- The maintainer, session 62: "These settings I think cannot be applied plant
-- wise which defeats the purpose of both options. Lets make it possible to
-- assign settings individually for each plant."
--
-- ⭐ THE CASE THIS FILE EXISTS FOR IS P10, AND EVERYTHING ELSE IS PLUMBING.
-- Storage, a resolver, a write RPC and a clear RPC are all easy to get green
-- while the thing the maintainer asked for does not happen — because the
-- functions that DECIDE WHETHER A WRITE IS ALLOWED could still be reading the
-- company's bag. So P10 puts the requirement itself under test: ONE run, ONE
-- crew, ONE day, moved into two different branches of the same company, and
-- `move_run` must REFUSE one and ALLOW the other. P11 is its control — with no
-- override anywhere, the refused move is allowed — so a green P10 cannot be a
-- function that simply became stricter for everybody. P12 asks the same of
-- `create_assignment`, which this migration never touched and which must follow
-- anyway, because it branches on the policy `check_eligibility` resolved.
--
-- ⛔ THE SECOND TRAP IS "ABSENT" AND "SET TO NOTHING" LOOKING ALIKE. F-088
-- measured it: `settings->>'k'` reads back SQL NULL both for a missing key and
-- for a key holding a JSON null, and `check (... in ('warn','block'))` CANNOT
-- REJECT the second, because `NULL IN (...)` is NULL and a CHECK only refuses on
-- FALSE. A per-plant setting that inherited that hole would leave the Settings
-- screen unable to say which plant is overriding. P6 is the case: it asserts
-- that the two states are told apart in the RETURNED shape, and that a null can
-- never be STORED at all — refused by NOT NULL (23502), which is the separate
-- guard F-088 says you have to write.
--
-- ⛔ AND THE THIRD: A REFUSAL AND A SILENT NO-OP LOOK THE SAME FROM OUTSIDE.
-- P8 pins the typed refusal (`not_permitted`, PT403) that no zero-row write can
-- produce, and stands it beside the plain DELETE a screen would otherwise have
-- been wired to — same person, same intent, no exception, ROW_COUNT 0, the
-- override still there and nothing said. That pair is the argument for the RPC,
-- exactly as 72's X7/X8 is for 0049's.
--
-- ⚠️ EVERY CASE THAT MEASURES A POLICY RUNS AS `authenticated`. `move_run` and
-- the two writers are SECURITY INVOKER and psql connects as the superuser, who
-- bypasses RLS entirely and whose `app_current_org()` is NULL — a case that
-- forgets this measures nothing, or fails for the wrong reason.
--
-- FIXTURE, built at the top and shared by every case (it sits before the first
-- savepoint, so no ROLLBACK TO reaches it):
--
--   plant_1                     30000000-...-0001   the seed's only plant
--     .assembly                 30000000-...-0002   ⚠️ CNC required here BY THIS
--                                                   FILE, so that both branches
--                                                   of Plant 1 are places Elena
--                                                   is ineligible and the only
--                                                   thing that differs between
--                                                   them is the POLICY.
--       .line_1.cell_1          30000000-...-0007   run r1 lives here
--       .line_1.cell_2          30000000-...-0008
--     .machining                30000000-...-0003
--       .cnc_line               30000000-...-0006   CNC required (the seed's)
--         .cell_6              3000000a-...-000c
--   plant_2                     v_p2                built here through the real
--     .fabrication              v_dept              RPCs, as 47 does, because
--       .weld_line              v_line              the seed has ONE plant and
--         .weld_cell            v_cell              "another plant" and
--                                                   "another tenant" must not
--                                                   be the same fixture.
--
--   Elena  50000000-...-0004  holds NO training at all
--   Tom    50000000-...-0005  holds NO training at all
--   r1     80000000-...-0001  Cell 1, Widget X, day 1 06:00-14:00, Elena + Tom
--   a1     ...a1  company admin      a2  ...a2  supervisor (org-wide)
--   e2     ...e2  org-wide VIEWER holding an admin grant on plant_2 ALONE —
--                 P14 rests on him, and on his org-wide role NOT being admin,
--                 or `app_is_admin()` would short-circuit the predicate under
--                 test (46's and 47's lesson).
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed so one
-- case's write cannot leak into the next.
-- ============================================================================

BEGIN;

-- Fixed relative time, since the seed's own `seed_t` is dropped at the end of
-- seed.sql. Day 3 and day 4 are empty everywhere in the seed, which is why the
-- moves and the creates below use them.
CREATE FUNCTION pg_temp.t(p_day int, p_minute int) RETURNS timestamptz
LANGUAGE sql STABLE AS $fn$
  SELECT date_trunc('week', current_date)::timestamptz + (p_day * 1440 + p_minute) * interval '1 minute';
$fn$;

-- ⚠️ The GRANT is not decoration. Half the cases below read this table while
-- `SET LOCAL ROLE authenticated` is in force, and a temp table created by the
-- superuser is not readable by that role -- the first red run of this file
-- reported `permission denied for table p_fix` and measured nothing.
CREATE TEMP TABLE p_fix (k text primary key, v uuid);
GRANT SELECT ON p_fix TO PUBLIC;

-- CNC is required at plant_1.machining.cnc_line by the seed. Requiring it at
-- plant_1.assembly TOO is what makes P10 a fair comparison: without it the
-- assembly move would succeed because everybody is eligible there, which would
-- prove nothing about the policy.
INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
VALUES ('30000000-0000-0000-0000-000000000002',
        '40000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001');

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid; v_cell uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL, 'Plant 2', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,   'Fabrication', 0)->>'id')::uuid;
  v_line := (create_node(v_dept, 'Weld Line',   0)->>'id')::uuid;
  v_cell := (create_node(v_line, 'Weld Cell',   0)->>'id')::uuid;
  RESET ROLE;

  INSERT INTO p_fix (k, v) VALUES
    ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line), ('p2_cell', v_cell);

  -- A training owned by Plant 2 and required at its cell, so that a person is
  -- ineligible on BOTH plants and only the policy differs.
  INSERT INTO skills (id, org_id, name, site_node_id)
  VALUES ('40000000-0000-0000-0000-0000000000e1',
          '10000000-0000-0000-0000-000000000001', 'Welding', v_p2);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
  VALUES (v_cell, '40000000-0000-0000-0000-0000000000e1',
          '10000000-0000-0000-0000-000000000001');

  -- Zoe: untrained and, unlike every seeded operator, entirely unbooked. P17
  -- needs somebody who can take a whole shift on the CNC run without the
  -- CAPACITY cap firing first and reporting the wrong refusal (Noah, the
  -- obvious pick, already holds 0.75 of day 1).
  INSERT INTO operators (id, org_id, home_node_id, display_name, employee_ref, source, site_node_id)
  VALUES ('50000000-0000-0000-0000-0000000000e1',
          '10000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000003', 'Zoe', 'EMP-E01', 'manual',
          '30000000-0000-0000-0000-000000000001');

  -- e2: a SITE admin of Plant 2 and nothing else. Org-wide 'viewer' on purpose.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000e2');
  INSERT INTO user_profiles (id, org_id, user_id, role)
  VALUES ('e0000000-0000-0000-0000-000000000002',
          '10000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000e2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
  VALUES ('e0000000-0000-0000-0000-000000000002', v_p2,
          '10000000-0000-0000-0000-000000000001', 'admin');
END $$;

RESET ROLE;

\echo 'P0: the properties every case below rests on (two plants, warn, the right people, nobody trained)'
SAVEPOINT sp_P0;
DO $$
DECLARE v_roots int; v_org text; v_a1 text; v_a2 text; v_e2 text;
        v_elena int; v_req_assembly int; v_req_p2 int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT settings->>'eligibility_policy' INTO v_org
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  SELECT role INTO v_a1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  SELECT role INTO v_a2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  SELECT role INTO v_e2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000e2';
  SELECT count(*) INTO v_elena FROM operator_skills
   WHERE operator_id = '50000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_req_assembly FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO v_req_p2 FROM node_skill_requirements
   WHERE node_id = (SELECT v FROM p_fix WHERE k = 'p2_cell');
  -- No override may exist yet, anywhere: the whole file measures the difference
  -- one makes, and a stray row would make P1 and P11 meaningless.
  IF v_roots = 2 AND v_org = 'warn' AND v_a1 = 'admin' AND v_a2 = 'supervisor'
     AND v_e2 = 'viewer' AND v_elena = 0 AND v_req_assembly = 1 AND v_req_p2 = 1
     AND NOT EXISTS (SELECT 1 FROM node_settings)
  THEN RAISE NOTICE 'PASS P0';
  ELSE RAISE NOTICE 'FAIL P0: roots=% org=% a1=% a2=% e2=% elena_skills=% req_assembly=% req_p2=% overrides=%',
    v_roots, v_org, v_a1, v_a2, v_e2, v_elena, v_req_assembly, v_req_p2,
    (SELECT count(*) FROM node_settings); END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P0;

\echo 'P1: with no override anywhere, every plant reads the company''s answer -- yesterday''s behaviour, unchanged'
SAVEPOINT sp_P1;
DO $$
DECLARE v_p1 jsonb; v_p2 jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p1 := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                            '50000000-0000-0000-0000-000000000004',
                            tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  v_p2 := check_eligibility((SELECT v FROM p_fix WHERE k = 'p2_cell'),
                            '50000000-0000-0000-0000-000000000004',
                            tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  RESET ROLE;
  -- Both ineligible (Elena holds nothing) and both on the company's 'warn'.
  IF v_p1->>'policy' = 'warn' AND v_p2->>'policy' = 'warn'
     AND (v_p1->>'eligible') = 'false' AND (v_p2->>'eligible') = 'false'
  THEN RAISE NOTICE 'PASS P1';
  ELSE RAISE NOTICE 'FAIL P1: plant1=% plant2=%', v_p1, v_p2; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P1;

\echo 'P2/P3 (⭐): a plant override wins where it is set, and the plant WITHOUT one still follows the company'
SAVEPOINT sp_P2;
DO $$
DECLARE v_ret jsonb; v_p1 jsonb; v_p2 jsonb; v_win tstzrange;
BEGIN
  v_win := tstzrange(pg_temp.t(3,360), pg_temp.t(3,840));
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_ret := set_node_setting((SELECT v FROM p_fix WHERE k = 'p2'), 'eligibility_policy', 'block');
  v_p1  := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                             '50000000-0000-0000-0000-000000000004', v_win);
  v_p2  := check_eligibility((SELECT v FROM p_fix WHERE k = 'p2_cell'),
                             '50000000-0000-0000-0000-000000000004', v_win);
  RESET ROLE;
  -- ⭐ THE SENTENCE THE MAINTAINER ASKED FOR: one strict plant, one permissive
  -- one, in the same company, at the same instant, for the same person.
  IF v_p2->>'policy' = 'block' AND v_p1->>'policy' = 'warn'
     AND v_ret->>'value' = 'block' AND (v_ret->>'is_override') = 'true'
     AND v_ret->>'effective' = 'block' AND v_ret->>'org_value' = 'warn'
  THEN RAISE NOTICE 'PASS P2/P3';
  ELSE RAISE NOTICE 'FAIL P2/P3: returned=% plant1=% plant2=%', v_ret, v_p1->>'policy', v_p2->>'policy'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P2/P3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P2;

\echo 'P4: an override may be MORE PERMISSIVE than the company -- the other half of "one strict plant and one permissive one"'
SAVEPOINT sp_P4;
DO $$
DECLARE v_p1 jsonb; v_p2 jsonb; v_win tstzrange;
BEGIN
  v_win := tstzrange(pg_temp.t(3,360), pg_temp.t(3,840));
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_org_eligibility_policy('block');            -- the company gets strict
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001',
                           'eligibility_policy', 'warn'); -- Plant 1 stays lenient
  v_p1 := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                            '50000000-0000-0000-0000-000000000004', v_win);
  v_p2 := check_eligibility((SELECT v FROM p_fix WHERE k = 'p2_cell'),
                            '50000000-0000-0000-0000-000000000004', v_win);
  RESET ROLE;
  IF v_p1->>'policy' = 'warn' AND v_p2->>'policy' = 'block'
  THEN RAISE NOTICE 'PASS P4';
  ELSE RAISE NOTICE 'FAIL P4: plant1=% (want warn) plant2=% (want block)',
    v_p1->>'policy', v_p2->>'policy'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P4;

\echo 'P5: clearing an override returns the plant to INHERITING -- the row is gone, not blanked'
SAVEPOINT sp_P5;
DO $$
DECLARE v_set jsonb; v_clear jsonb; v_after jsonb; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_set   := set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  v_clear := clear_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy');
  v_after := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                               '50000000-0000-0000-0000-000000000004',
                               tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001';
  IF v_set->>'effective' = 'block' AND v_clear->>'effective' = 'warn'
     AND (v_clear->>'is_override') = 'false' AND v_rows = 0
     AND v_after->>'policy' = 'warn'
  THEN RAISE NOTICE 'PASS P5';
  ELSE RAISE NOTICE 'FAIL P5: set=% clear=% rows_left=% resolved=%',
    v_set, v_clear, v_rows, v_after->>'policy'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P5;

\echo 'P6 (⛔ F-088): "inheriting" and "set" are different states, and a null can never be STORED'
SAVEPOINT sp_P6;
DO $$
DECLARE v_set jsonb; v_clear jsonb; v_state text; v_stored_null boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_set   := set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'warn');
  v_clear := clear_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy');
  RESET ROLE;

  -- ⭐ THE TWO STATES AGREE ON `effective` AND DISAGREE ON EVERYTHING THAT
  -- MATTERS. Plant 1 set to 'warn' and Plant 1 inheriting the company's 'warn'
  -- resolve to the same answer TODAY -- and must still be distinguishable, or
  -- the screen cannot say which plant is overriding, and moving the company to
  -- 'block' would silently move a plant somebody deliberately set.
  IF NOT (v_set->>'effective' = 'warn' AND v_clear->>'effective' = 'warn'
          AND (v_set->>'is_override') = 'true' AND (v_clear->>'is_override') = 'false'
          AND v_set->>'value' = 'warn' AND v_clear->>'value' IS NULL) THEN
    RAISE NOTICE 'FAIL P6: set=% clear=%', v_set, v_clear;
    RETURN;
  END IF;

  -- And the hole F-088 found in the jsonb bag does not exist here: the column
  -- refuses a null outright (23502 not_null_violation) rather than a CHECK
  -- passing on unknown.
  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy',
            '10000000-0000-0000-0000-000000000001', NULL);
    v_stored_null := true;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;

  IF NOT v_stored_null AND v_state = '23502'
  THEN RAISE NOTICE 'PASS P6';
  ELSE RAISE NOTICE 'FAIL P6: a null was stored=% sqlstate=%', v_stored_null, v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P6;

\echo 'P7: NEAREST ancestor-or-self wins -- a department''s answer beats its plant''s'
SAVEPOINT sp_P7;
DO $$
DECLARE v_cell6 jsonb; v_cell1 jsonb; v_plant text; v_win tstzrange;
BEGIN
  v_win := tstzrange(pg_temp.t(3,360), pg_temp.t(3,840));
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block'); -- plant_1
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000002', 'eligibility_policy', 'warn');  -- plant_1.assembly
  v_cell6 := check_eligibility('3000000a-0000-0000-0000-00000000000c',   -- under machining
                               '50000000-0000-0000-0000-000000000004', v_win);
  v_cell1 := check_eligibility('30000000-0000-0000-0000-000000000007',   -- under assembly
                               '50000000-0000-0000-0000-000000000004', v_win);
  -- Ancestor-OR-SELF: the plant root answers from its own row, which is what
  -- makes "a node with no plant above it" not a special case.
  v_plant := app_resolve_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy');
  RESET ROLE;
  IF v_cell6->>'policy' = 'block' AND v_cell1->>'policy' = 'warn' AND v_plant = 'block'
  THEN RAISE NOTICE 'PASS P7';
  ELSE RAISE NOTICE 'FAIL P7: cell6=% cell1=% plant_self=%',
    v_cell6->>'policy', v_cell1->>'policy', v_plant; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P7;

\echo 'P8 (⛔): a supervisor is TOLD NO (PT403); the plain DELETE they would otherwise use is the SILENT no-op'
SAVEPOINT sp_P8;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text;
        v_set_state text; v_clear_state text;
        v_rows int; v_left text; v_threw boolean := false;
BEGIN
  -- An override put there by the admin, so the supervisor has something to fail
  -- to change and something to fail to remove.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;

  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'warn');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_set_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;

  BEGIN
    PERFORM clear_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_clear_state = RETURNED_SQLSTATE;
  END;

  -- The same person, the same intent, through the write a settings screen would
  -- otherwise have been wired to. No exception, zero rows, nothing said.
  BEGIN
    DELETE FROM node_settings
     WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'eligibility_policy';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_threw := true;
  END;
  RESET ROLE;

  SELECT value INTO v_left FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'eligibility_policy';

  IF v_detail->>'error' = 'not_permitted' AND v_set_state = 'PT403'
     AND v_clear_state = 'PT403'
     AND NOT v_threw AND v_rows = 0 AND v_left = 'block'
  THEN RAISE NOTICE 'PASS P8';
  ELSE RAISE NOTICE 'FAIL P8: detail=% set_state=% clear_state=% delete_threw=% delete_rows=% still=%',
    v_detail, v_set_state, v_clear_state, v_threw, v_rows, v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P8;

\echo 'P9: a bad value, a null value and an unknown key are refused by the FUNCTION (PT400) naming the field, not by the table CHECK (23514)'
SAVEPOINT sp_P9;
DO $$
DECLARE v_raw text; v_bad jsonb; v_bad_state text;
        v_null jsonb; v_key jsonb; v_key_state text; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  BEGIN PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'strict');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_bad_state = RETURNED_SQLSTATE;
    BEGIN v_bad := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_bad := NULL; END;
  END;

  BEGIN PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_null := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_null := NULL; END;
  END;

  -- ⚠️ AMENDED BY R-333 (migration 0052), AND THE AMENDMENT IS A CONTRACT
  -- CHANGE RATHER THAN A WRONG CASE BEING QUIETLY RELAXED (CLAUDE.md §4). This
  -- prong read `set_node_setting(plant_1, 'date_format', 'iso')` and expected
  -- "unknown setting" -- true of 0050, whose header argued the date format was
  -- a reader's display convention and not a plant's rule. The maintainer has
  -- since decided a plant answers it too, so `date_format` is now a KNOWN key
  -- and this prong was passing for a reason that has stopped being true.
  -- `capacity_cap` replaces it: a real `orgs.settings` key that 0050 and 0052
  -- both deliberately leave company-wide, so the prong still asks the thing it
  -- was written to ask -- an unvalidated key is refused by the FUNCTION, in
  -- words, before the table CHECK ever sees it. P22 holds the same line from
  -- the other side.
  BEGIN PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'capacity_cap', '0.8');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_key_state = RETURNED_SQLSTATE;
    BEGIN v_key := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_key := NULL; END;
  END;
  RESET ROLE;

  SELECT count(*) INTO v_rows FROM node_settings;
  -- PT400 is api_raise's code for invalid_argument. 23514 would mean the value
  -- reached the row and the CHECK caught it -- refused, but unreadably, and
  -- saying the same thing about every key in the table.
  IF v_bad->>'error' = 'invalid_argument' AND v_bad->>'field' = 'eligibility_policy'
     AND v_bad_state = 'PT400'
     AND v_null->>'error' = 'invalid_argument' AND v_null->>'field' = 'eligibility_policy'
     AND v_key->>'error' = 'invalid_argument' AND v_key->>'field' = 'key'
     AND v_key_state = 'PT400'
     AND v_rows = 0
  THEN RAISE NOTICE 'PASS P9';
  ELSE RAISE NOTICE 'FAIL P9: bad=%/% null=% key=%/% rows=%',
    v_bad, v_bad_state, v_null, v_key, v_key_state, v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P9;

\echo 'P10 (⭐⭐ THE REQUIREMENT): move_run REFUSES into the strict branch and ALLOWS into the permissive one -- same run, same crew, same day'
SAVEPOINT sp_P10;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text;
        v_moved jsonb; v_node_after uuid; v_node_final uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- The company stays on 'warn'. Machining alone is made strict.
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000003', 'eligibility_policy', 'block');

  -- (a) into machining: refused outright, and NOTHING moves -- the block
  -- pre-check runs before the first UPDATE for exactly this reason.
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000001',
                     '3000000a-0000-0000-0000-00000000000c',
                     tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT node_id INTO v_node_after FROM runs WHERE id = '80000000-0000-0000-0000-000000000001';

  -- (b) into assembly, where the company's 'warn' still rules: the SAME crew,
  -- just as untrained (this file requires CNC on assembly too), moves -- and is
  -- reported as a warning rather than a refusal.
  v_moved := move_run('80000000-0000-0000-0000-000000000001',
                      '30000000-0000-0000-0000-000000000008',
                      tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  RESET ROLE;
  SELECT node_id INTO v_node_final FROM runs WHERE id = '80000000-0000-0000-0000-000000000001';

  IF v_detail->>'error' = 'not_eligible' AND v_detail->>'policy' = 'block'
     AND v_node_after = '30000000-0000-0000-0000-000000000007'          -- did not move
     AND jsonb_array_length(v_moved->'eligibility_warnings') = 2        -- Elena and Tom
     AND v_node_final = '30000000-0000-0000-0000-000000000008'          -- did move
  THEN RAISE NOTICE 'PASS P10';
  ELSE RAISE NOTICE 'FAIL P10: refusal=% sqlstate=% node_after_refusal=% warnings=% node_final=%',
    v_detail, v_state, v_node_after, v_moved->'eligibility_warnings', v_node_final; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P10;

\echo 'P11 (the control for P10): with NO override, the move P10 refused is ALLOWED -- so the refusal was the override and not a function that got stricter for everybody'
SAVEPOINT sp_P11;
DO $$
DECLARE v_moved jsonb; v_node uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_moved := move_run('80000000-0000-0000-0000-000000000001',
                      '3000000a-0000-0000-0000-00000000000c',
                      tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  RESET ROLE;
  SELECT node_id INTO v_node FROM runs WHERE id = '80000000-0000-0000-0000-000000000001';
  IF v_node = '3000000a-0000-0000-0000-00000000000c'
     AND jsonb_array_length(v_moved->'eligibility_warnings') = 2
  THEN RAISE NOTICE 'PASS P11';
  ELSE RAISE NOTICE 'FAIL P11: node=% warnings=%', v_node, v_moved->'eligibility_warnings'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P11;

\echo 'P12 (⭐): create_assignment follows the plant''s rule too, though 0050 never touched it -- it branches on the policy check_eligibility resolved'
SAVEPOINT sp_P12;
DO $$
DECLARE v_raw text; v_detail jsonb; v_ok jsonb; v_win tstzrange;
BEGIN
  v_win := tstzrange(pg_temp.t(4,360), pg_temp.t(4,840));
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000003', 'eligibility_policy', 'block');

  -- In the strict branch, no override and no typed reason gets past it.
  BEGIN
    PERFORM create_assignment('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000004',
                              NULL, '60000000-0000-0000-0000-000000000001', v_win,
                              1.000, NULL, NULL, true, 'she can pick it up');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;

  -- In the permissive branch, the identical call is allowed on the override.
  -- ⚠️ A DIFFERENT PERSON on purpose. If the refusal above ever stopped
  -- happening, Elena would already hold this window and the second create would
  -- fail on the CAPACITY cap instead -- red either way, but naming the wrong
  -- thing. Tom is just as untrained and has nothing on day 4.
  v_ok := create_assignment('30000000-0000-0000-0000-000000000007',
                            '50000000-0000-0000-0000-000000000005',
                            NULL, '60000000-0000-0000-0000-000000000001', v_win,
                            1.000, NULL, NULL, true, 'she can pick it up');
  RESET ROLE;

  IF v_detail->>'error' = 'not_eligible' AND v_detail->>'policy' = 'block'
     AND (v_ok->'assignment'->>'eligibility_override') = 'true'
     AND v_ok->'assignment'->>'override_reason' = 'she can pick it up'
     AND v_ok->'eligibility'->>'policy' = 'warn'
  THEN RAISE NOTICE 'PASS P12';
  ELSE RAISE NOTICE 'FAIL P12: refusal=% allowed=%', v_detail, v_ok; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P12;

\echo 'P13: a PLANT''S OWN ADMIN sets their plant''s rule and is refused on somebody else''s'
SAVEPOINT sp_P13;
DO $$
DECLARE v_own jsonb; v_raw text; v_detail jsonb; v_state text; v_p1_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  v_own := set_node_setting((SELECT v FROM p_fix WHERE k = 'p2'), 'eligibility_policy', 'block');
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_p1_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001';
  IF v_own->>'value' = 'block'
     AND v_detail->>'error' = 'not_permitted' AND v_state = 'PT403' AND v_p1_rows = 0
  THEN RAISE NOTICE 'PASS P13';
  ELSE RAISE NOTICE 'FAIL P13: own=% other=%/% plant1_rows=%', v_own, v_detail, v_state, v_p1_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P13;

\echo 'P14: RLS is on, the four policies exist, EXECUTE is granted to authenticated and revoked from PUBLIC'
SAVEPOINT sp_P14;
DO $$
DECLARE v_rls boolean; v_policies int;
        v_pub_set boolean; v_auth_set boolean;
        v_pub_clear boolean; v_auth_clear boolean;
        v_pub_res boolean; v_auth_res boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE relname = 'node_settings';
  SELECT count(*) INTO v_policies FROM pg_policies WHERE tablename = 'node_settings';
  SELECT has_function_privilege('public',        'set_node_setting(uuid, text, text)', 'EXECUTE'),
         has_function_privilege('authenticated', 'set_node_setting(uuid, text, text)', 'EXECUTE'),
         has_function_privilege('public',        'clear_node_setting(uuid, text)', 'EXECUTE'),
         has_function_privilege('authenticated', 'clear_node_setting(uuid, text)', 'EXECUTE'),
         has_function_privilege('public',        'app_resolve_node_setting(uuid, text)', 'EXECUTE'),
         has_function_privilege('authenticated', 'app_resolve_node_setting(uuid, text)', 'EXECUTE')
    INTO v_pub_set, v_auth_set, v_pub_clear, v_auth_clear, v_pub_res, v_auth_res;
  IF v_rls AND v_policies = 4
     AND NOT v_pub_set AND v_auth_set
     AND NOT v_pub_clear AND v_auth_clear
     AND NOT v_pub_res AND v_auth_res
  THEN RAISE NOTICE 'PASS P14';
  ELSE RAISE NOTICE 'FAIL P14: rls=% policies=% set=%/% clear=%/% resolve=%/%',
    v_rls, v_policies, v_pub_set, v_auth_set, v_pub_clear, v_auth_clear, v_pub_res, v_auth_res; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P14;

\echo 'P15: deleting the plant takes its settings with it -- configuration about a place, not history of one'
SAVEPOINT sp_P15;
DO $$
DECLARE v_spare uuid; v_before int; v_after int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- A leaf of its own, so this case measures the CASCADE and not the self-FK
  -- that (rightly) refuses to delete a plant with departments still under it.
  v_spare := (create_node((SELECT v FROM p_fix WHERE k = 'p2_line'), 'Spare Cell', 1)->>'id')::uuid;
  PERFORM set_node_setting(v_spare, 'eligibility_policy', 'block');
  RESET ROLE;
  SELECT count(*) INTO v_before FROM node_settings WHERE node_id = v_spare;
  -- Straight DELETE as the owner: the point is the CASCADE on the composite FK,
  -- not delete_node's own bookkeeping (which knows nothing about this table and
  -- cannot, since it shipped first -- 0040's stated reason for the cascade).
  DELETE FROM nodes WHERE id = v_spare;
  SELECT count(*) INTO v_after FROM node_settings WHERE node_id = v_spare;
  IF v_before = 1 AND v_after = 0
  THEN RAISE NOTICE 'PASS P15';
  ELSE RAISE NOTICE 'FAIL P15: before=% after=%', v_before, v_after; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P15;

\echo 'P16 (⛔ the fail-open case): a SUPERVISOR who cannot read the plant root still gets the plant root''s answer'
SAVEPOINT sp_P16;
DO $$
DECLARE v_can_read boolean; v_elig jsonb; v_resolved text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;

  -- Marco is a supervisor granted plant_1.machining and NOTHING above it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SET LOCAL ROLE authenticated;
  v_can_read := app_can_read_node('30000000-0000-0000-0000-000000000001');
  v_elig := check_eligibility('3000000a-0000-0000-0000-00000000000c',
                              '50000000-0000-0000-0000-000000000004',
                              tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  v_resolved := app_resolve_node_setting('3000000a-0000-0000-0000-00000000000c', 'eligibility_policy');
  RESET ROLE;

  -- ⭐ THE FIRST ASSERTION IS THE POINT OF THE CASE. Marco genuinely cannot
  -- SEE the node the override sits on. If `app_resolve_node_setting` were
  -- SECURITY INVOKER like `resolve_shift_template`, the ancestry walk would be
  -- RLS-filtered, the plant's row would drop out, and the answer would fall
  -- through to the company's 'warn' -- a plant set to `block` quietly permissive
  -- for exactly the people who schedule against it all day. This is the same
  -- defect 0023 fixed INSIDE check_eligibility, in a new place.
  IF v_can_read = false AND v_elig->>'policy' = 'block' AND v_resolved = 'block'
  THEN RAISE NOTICE 'PASS P16';
  ELSE RAISE NOTICE 'FAIL P16: supervisor_can_read_root=% policy=% resolved=%',
    v_can_read, v_elig->>'policy', v_resolved; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P16;

\echo 'P17 (⛔ the fail-open case, through move_run): a SUPERVISOR''s move is refused by an override they cannot see'
SAVEPOINT sp_P17;
DO $$
DECLARE v_raw text; v_detail jsonb; v_node uuid;
BEGIN
  -- Under the company's 'warn', put an untrained person on the CNC run with a
  -- ticked override -- the ordinary thing a planner does today.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM create_assignment('3000000a-0000-0000-0000-00000000000c',
                            '50000000-0000-0000-0000-0000000000e1',  -- Zoe, untrained, unbooked
                            '80000000-0000-0000-0000-000000000005', NULL,
                            (SELECT timerange FROM runs WHERE id = '80000000-0000-0000-0000-000000000005'),
                            1.000, NULL, NULL, true, 'covering a gap');
  -- Then the company decides Plant 1 is strict. The override sits on the ROOT.
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  RESET ROLE;

  -- ⭐ MARCO IS THE POINT. He supervises Machining and cannot read the plant
  -- root the override lives on. `move_run` is SECURITY INVOKER, so if the
  -- resolver it calls were invoker too, HIS walk would be RLS-filtered, the
  -- override would vanish, and this move would go through under 'warn' -- the
  -- rule failing open for the person who actually schedules the line.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000005',
                     '3000000a-0000-0000-0000-00000000000d',   -- Cell 7, same line
                     tstzrange(pg_temp.t(3,360), pg_temp.t(3,840)));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT node_id INTO v_node FROM runs WHERE id = '80000000-0000-0000-0000-000000000005';

  IF v_detail->>'error' = 'not_eligible' AND v_detail->>'policy' = 'block'
     AND v_node = '3000000a-0000-0000-0000-00000000000c'   -- did not move
  THEN RAISE NOTICE 'PASS P17';
  ELSE RAISE NOTICE 'FAIL P17: refusal=% node=%', v_detail, v_node; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P17;

-- ============================================================================
-- P18-P22 -- THE SECOND KEY (R-333, migration 0052).
--
-- The maintainer, session 62: "There is a filter at the top for selecting
-- plants. Once we select the plant at the top we should be able to assign the
-- settings to that particular plant, and it should be all types of settings on
-- the settings tab, not just this one."
--
-- ⛔ THIS OVERRULES 0050's OWN HEADER, which recorded `date_format` as
-- deliberately left company-wide on the reasoning that it is "a reader's
-- display convention, not a plant's rule". The maintainer has decided
-- otherwise and that is the answer; the reasoning is left standing in 0050
-- rather than edited out, because a migration is a record of what was believed
-- at the time.
--
-- ⭐ WHAT THESE CASES ARE FOR IS THE CLAIM 0050 MADE ABOUT ITSELF: "the table,
-- the resolver and the writers are generic and a second key is one branch in
-- each of three places." That claim is a promise about a SHAPE, and the only
-- way to hold it is to add the second key and ask the generic machinery the
-- same questions the first key was asked. P18 is the resolver, P19 the two
-- guards (the typed RPC refusal AND the table CHECK behind it), P20 the way
-- back to inheriting, P21 that the two keys do not read each other, and P22
-- that "generic" did not become "anything goes".
--
-- ⚠️ THE COMPANY BAG HAS NO `date_format` KEY AT ALL in the seed, which makes
-- this a better test of the resolver than eligibility_policy was: the fallback
-- chain runs all the way to NULL, and "the plant has an answer" therefore has
-- to come from node_settings or from nowhere.
-- ============================================================================

\echo 'P18: a plant answers the date format for everything under it, without touching the company bag'
SAVEPOINT sp_P18;
DO $$
DECLARE v_at_cell text; v_at_root text; v_other_plant text; v_org jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'iso');
  RESET ROLE;

  -- Resolved from a CELL four levels down, which is the ancestor walk doing
  -- real work rather than the root reading its own row.
  v_at_cell := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'date_format');
  v_at_root := app_resolve_node_setting('30000000-0000-0000-0000-000000000001', 'date_format');
  -- Plant 2 was never touched. The company bag has no date_format key at all,
  -- so the honest answer there is NULL and the CLIENT applies its own default
  -- -- 0050's "the coded default belongs to the KEY, not to the resolver".
  v_other_plant := app_resolve_node_setting((SELECT v FROM p_fix WHERE k = 'p2_cell'), 'date_format');
  SELECT settings INTO v_org FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  IF v_at_cell = 'iso' AND v_at_root = 'iso' AND v_other_plant IS NULL
     AND NOT (v_org ? 'date_format')
  THEN RAISE NOTICE 'PASS P18';
  ELSE RAISE NOTICE 'FAIL P18: cell=% root=% other=% org_bag=%',
    v_at_cell, v_at_root, v_other_plant, v_org; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P18;

\echo 'P19: a junk date format is a TYPED refusal naming the key, and the table CHECK refuses it underneath'
SAVEPOINT sp_P19;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_check_state text; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'warn');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;

  -- ⛔ 'warn' IS THE POINT OF THE CHOSEN JUNK VALUE. It is a perfectly legal
  -- value for the OTHER key, so a CASE that fell through to a shared
  -- `p_value IN ('warn','block')` -- the shape a careless second branch takes
  -- -- would accept it here and store a date format of "warn".
  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'date_format';

  -- And the guard BEHIND the RPC, which is the one that holds when somebody
  -- writes the table directly. 23514 = check_violation.
  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'date_format',
            '10000000-0000-0000-0000-000000000001', 'not_a_format');
  EXCEPTION WHEN OTHERS THEN v_check_state := SQLSTATE;
  END;

  IF v_state = 'PT400' AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'date_format' AND v_detail->>'value' = 'warn'
     AND v_rows = 0 AND v_check_state = '23514'
  THEN RAISE NOTICE 'PASS P19';
  ELSE RAISE NOTICE 'FAIL P19: state=% detail=% rows=% check_state=%',
    v_state, v_detail, v_rows, v_check_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P19;

\echo 'P20: clearing the date format returns the plant to inheriting -- the same separate verb, not a null'
SAVEPOINT sp_P20;
DO $$
DECLARE v_set text; v_after text; v_ret jsonb; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- Give the company an answer first, so "inheriting" has something to land on
  -- and the case cannot pass by everything being NULL.
  PERFORM set_org_date_format('dmy_slash');
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'iso');
  v_set := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'date_format');
  v_ret := clear_node_setting('30000000-0000-0000-0000-000000000001', 'date_format');
  v_after := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'date_format');
  RESET ROLE;

  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'date_format';

  IF v_set = 'iso' AND v_after = 'dmy_slash' AND v_rows = 0
     AND v_ret->>'is_override' = 'false' AND v_ret->>'effective' = 'dmy_slash'
     AND v_ret->>'org_value' = 'dmy_slash'
  THEN RAISE NOTICE 'PASS P20';
  ELSE RAISE NOTICE 'FAIL P20: set=% after=% rows=% ret=%', v_set, v_after, v_rows, v_ret; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P20: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P20;

\echo 'P21: the two keys at one plant are two answers -- setting one does not move or clear the other'
SAVEPOINT sp_P21;
DO $$
DECLARE v_fmt text; v_pol text; v_fmt_after text; v_pol_after text; v_keys text[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'ymd_slash');
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'eligibility_policy', 'block');
  v_fmt := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'date_format');
  v_pol := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'eligibility_policy');

  -- ⛔ THE PRIMARY KEY IS (node_id, key), and this is the case that says so out
  -- loud. A writer that keyed on the node alone -- the shape an "upsert the
  -- plant's setting" helper takes -- would have the second write REPLACE the
  -- first, and the screen would show one setting silently unsetting another.
  PERFORM clear_node_setting('30000000-0000-0000-0000-000000000001', 'date_format');
  v_fmt_after := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'date_format');
  v_pol_after := app_resolve_node_setting('30000000-0000-0000-0000-000000000007', 'eligibility_policy');
  RESET ROLE;

  SELECT array_agg(key ORDER BY key) INTO v_keys FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001';

  IF v_fmt = 'ymd_slash' AND v_pol = 'block'
     AND v_fmt_after IS NULL AND v_pol_after = 'block'
     AND v_keys = ARRAY['eligibility_policy']
  THEN RAISE NOTICE 'PASS P21';
  ELSE RAISE NOTICE 'FAIL P21: fmt=% pol=% fmt_after=% pol_after=% keys=%',
    v_fmt, v_pol, v_fmt_after, v_pol_after, v_keys; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P21: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P21;

\echo 'P22: generic did not become anything-goes -- an unvalidated key is still refused by both writers and by the table'
SAVEPOINT sp_P22;
DO $$
DECLARE v_set_state text; v_clear_state text; v_check_state text;
        v_set_detail jsonb; v_raw text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- `capacity_cap` is a REAL key in orgs.settings that this migration
  -- deliberately does not move. Storing it here would be a setting nobody
  -- validates and nobody reads -- 0050's "an unvalidated key would be a value
  -- nobody checks".
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'capacity_cap', '0.8');
  EXCEPTION WHEN OTHERS THEN
    v_set_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_set_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_set_detail := NULL; END;
  END;
  BEGIN
    PERFORM clear_node_setting('30000000-0000-0000-0000-000000000001', 'capacity_cap');
  EXCEPTION WHEN OTHERS THEN v_clear_state := SQLSTATE;
  END;
  RESET ROLE;

  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'capacity_cap',
            '10000000-0000-0000-0000-000000000001', '0.8');
  EXCEPTION WHEN OTHERS THEN v_check_state := SQLSTATE;
  END;

  IF v_set_state = 'PT400' AND v_clear_state = 'PT400' AND v_check_state = '23514'
     AND v_set_detail->>'field' = 'key' AND v_set_detail->>'value' = 'capacity_cap'
  THEN RAISE NOTICE 'PASS P22';
  ELSE RAISE NOTICE 'FAIL P22: set=% clear=% check=% detail=%',
    v_set_state, v_clear_state, v_check_state, v_set_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL P22: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P22;

ROLLBACK;

\echo '73_plant_settings_test.sql complete (23 cases: P0-P22)'
