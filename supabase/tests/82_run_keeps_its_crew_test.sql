-- ============================================================================
-- 82_run_keeps_its_crew_test.sql --- migration 0059 (DEF-0014, R-037).
--
-- THE RULE. R-037: a run moves to another cell like any block, and THE CREW
-- MOVES WITH IT. `assignments_run_consistency` (0003) already refuses a crew
-- row that disagrees with its run; before 0059 nothing on the RUN side refused
-- a run that walked away from its crew, so a bare `UPDATE runs SET node_id`
-- (a `PATCH /rest/v1/runs`) stranded the crew on the old cell. 0059 adds a
-- DEFERRABLE INITIALLY DEFERRED constraint trigger on runs that, at COMMIT,
-- refuses a run whose node_id changed while any crew row still points at a
-- different cell (reason 'run_moved_without_crew').
--
-- ⚠️ HOW A DEFERRED REFUSAL IS MEASURED INSIDE ONE ROLLED-BACK TRANSACTION.
-- The whole file is one BEGIN...ROLLBACK, so it can never COMMIT, and a deferred
-- constraint trigger otherwise fires only at commit. Each move-then-check is
-- therefore wrapped in an inner BEGIN...EXCEPTION block (a subtransaction) and
-- forced with `SET CONSTRAINTS ALL IMMEDIATE`, which makes every pending
-- deferred event fire THERE. A refusal raises inside the subtransaction, is
-- caught, and the subtransaction rolls the offending UPDATE back --- which is
-- why the run is read back afterwards and must still be on its old cell. This
-- is the "commit a subtransaction" route the file's style allows, done with
-- SET CONSTRAINTS rather than a real COMMIT the suite cannot make.
--
-- WHY move_run STILL PASSES. move_run (0050) updates the run first and then
-- every crew row (its loop is `SELECT * FROM assignments WHERE run_id = ...`,
-- ALL rows, no status filter) inside one transaction; by the time the deferred
-- check fires the crew has followed, so it passes. A bare PATCH is its own
-- transaction and moves nothing but the run, so it is refused.
--
-- ⚠️ EVERY REFUSAL CASE RUNS AS `authenticated`. The RPCs are SECURITY INVOKER;
-- psql connects as the superuser, who bypasses RLS. d1 below is a SITE ADMIN
-- (org-wide viewer + admin grant on the plant), the shape of Dana in DEF-0014:
-- she may edit the cell, which is exactly why the bare PATCH reaches the table.
--
-- FIXTURE. One plant, on a week nothing else in the suite touches (2099-09).
--
--   Plant P (root) . Area A1 . Line L1 . Cell C1   -- RUN with one crew member
--                                      . Cell C2   -- free target for the move
--                                      . Cell C3   -- a second run, NO crew
--                                      . Cell C4   -- free target for that one
--                                      . Cell C5   -- requires skill S (unmet)
--
--   People:  Op1  homed at PLANT P (so app_owner_covers passes for any move
--                 inside the plant --- the crew rule is not what is on trial).
--   Users:   d1   org-wide VIEWER + ADMIN grant on Plant P. A site admin who
--                 may edit every cell of the plant and is NOT a company admin
--                 (app_is_admin would short-circuit the checks otherwise).
--            a1   the seed company admin, used only to build the nodes.
--   Product: Widget P, offered at Plant P (so offered at every cell below it),
--            so runs_scope_guard never answers first on any move.
--   Skill:   S owned by Plant P; REQUIRED at Cell C5; Op1 does NOT hold it.
--   Policy:  eligibility_policy = 'block' on the plant root, so a move whose
--            crew is not eligible for the target is refused before any write.
--   Rows:    RR  run, Cell C1, Widget P, 2099-09-01 06:00-14:00, hc 2
--            AR  Op1 ATTACHED to RR, same window        (the crew that follows)
--            RN  run, Cell C3, Widget P, same window, NO crew
--
-- RK0   the premises every case rests on
-- RK1 ⭐⭐ a raw UPDATE of RR's node by the site admin, with crew, is refused at
--        commit with reason run_moved_without_crew, and RR is still on C1
-- RK2 ⭐ a raw UPDATE of RN (NO crew) still succeeds --- the guard is about the
--        crew, not the move
-- RK3 ⭐⭐ move_run of RR with its crew succeeds; forced immediate it does NOT
--        raise, and the crew arrives on C2 with the run
-- RK4 ⭐ move_run refused for another reason (crew not eligible for C5 under
--        block) leaves RR on C1 and its crew on C1 --- the new trigger never
--        half-applies a move move_run itself rejected
-- RK5   move_run's grants are unchanged (authenticated yes, anon no, public no)
-- ============================================================================

BEGIN;

CREATE TEMP TABLE rk_fix (k text primary key, v uuid);
GRANT SELECT ON rk_fix TO PUBLIC;

-- The run's node and its crew's nodes, read as the OWNER (after RESET ROLE) so
-- a refusal that half-wrote something cannot hide behind an unreadable row.
CREATE FUNCTION pg_temp.rk_run_node(p_run uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT r.node_id FROM runs r WHERE r.id = p_run;
$fn$;

CREATE FUNCTION pg_temp.rk_crew_nodes(p_run uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT string_agg(DISTINCT a.node_id::text, ',' ORDER BY a.node_id::text)
    FROM assignments a WHERE a.run_id = p_run;
$fn$;

DO $$
DECLARE v_p uuid; v_a1 uuid; v_l1 uuid; v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid; v_c5 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p  := (create_node(NULL, 'Plant P', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_a1 := (create_node(v_p,  'Area A1', 0)->>'id')::uuid;
  v_l1 := (create_node(v_a1, 'Line L1', 0)->>'id')::uuid;
  v_c1 := (create_node(v_l1, 'Cell C1', 0)->>'id')::uuid;
  v_c2 := (create_node(v_l1, 'Cell C2', 1)->>'id')::uuid;
  v_c3 := (create_node(v_l1, 'Cell C3', 2)->>'id')::uuid;
  v_c4 := (create_node(v_l1, 'Cell C4', 3)->>'id')::uuid;
  v_c5 := (create_node(v_l1, 'Cell C5', 4)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO rk_fix (k, v) VALUES
    ('p', v_p), ('a1', v_a1), ('l1', v_l1),
    ('c1', v_c1), ('c2', v_c2), ('c3', v_c3), ('c4', v_c4), ('c5', v_c5);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_p uuid; v_c1 uuid; v_c3 uuid; v_c5 uuid;
BEGIN
  SELECT v INTO v_p  FROM rk_fix WHERE k = 'p';
  SELECT v INTO v_c1 FROM rk_fix WHERE k = 'c1';
  SELECT v INTO v_c3 FROM rk_fix WHERE k = 'c3';
  SELECT v INTO v_c5 FROM rk_fix WHERE k = 'c5';

  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000d1');
  -- d1's ORG-WIDE role is 'viewer' on purpose: app_is_admin() must not answer
  -- for her. Her admin GRANT on the plant is what lets her edit its cells.
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000d1', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_p, v_org, 'admin');

  -- Op1 is homed at the PLANT, above every cell, so app_owner_covers passes for
  -- any move inside the plant and the crew's PLACE is never the reason a move is
  -- refused --- only its ELIGIBILITY (RK4) is.
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('d5000000-0000-0000-0000-000000000001', v_org, 'Op1', 'EMP-P01', v_p);

  -- Offered at the plant root -> offered at every cell below, so runs_scope_guard
  -- never answers first on any move under test.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('d6000000-0000-0000-0000-000000000001', v_org, 'WP1', 'Widget P');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'd6000000-0000-0000-0000-000000000001', v_p);

  -- Skill S required at C5 and NOT held by Op1: the unmet requirement RK4 needs.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('d4000000-0000-0000-0000-000000000001', v_org, 'Skill S', v_p);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    (v_c5, 'd4000000-0000-0000-0000-000000000001', v_org);

  -- The plant is strict: a move whose crew is ineligible for the target is
  -- refused before anything is written (move_run's block pre-check, 0050).
  INSERT INTO node_settings (node_id, key, org_id, value) VALUES
    (v_p, 'eligibility_policy', v_org, 'block');

  -- RR on C1 with Op1 attached; RN on C3 with no crew.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('d8000000-0000-0000-0000-000000000001', v_org, v_c1, 'd6000000-0000-0000-0000-000000000001',
     tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'), 2, 'day shift'),
    ('d8000000-0000-0000-0000-000000000002', v_org, v_c3, 'd6000000-0000-0000-0000-000000000001',
     tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'), 2, 'crewless');
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-000000000001', v_org, v_c1, 'd5000000-0000-0000-0000-000000000001',
     'd8000000-0000-0000-0000-000000000001', NULL,
     tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'), 1.000);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

RESET ROLE;

\echo 'RK0: the premises (one plant of five cells, Op1 homed at the plant, the part offered plant-wide, C5 requires an unheld skill, the plant is block, RR holds Op1, RN is crewless)'
SAVEPOINT rk_RK0;
DO $$
DECLARE v_p uuid; v_c1 uuid; v_c5 uuid; v_offered boolean; v_covers boolean;
        v_policy text; v_elig boolean; v_run_crew uuid; v_rn_crew int;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_p  FROM rk_fix WHERE k = 'p';
  SELECT v INTO v_c1 FROM rk_fix WHERE k = 'c1';
  SELECT v INTO v_c5 FROM rk_fix WHERE k = 'c5';
  v_offered := app_product_offered_at_in_org('10000000-0000-0000-0000-000000000001',
                 'd6000000-0000-0000-0000-000000000001', v_c5);
  v_covers  := app_owner_covers_in_org('10000000-0000-0000-0000-000000000001', v_p, v_c1);
  v_policy  := COALESCE(app_resolve_node_setting(v_c5, 'eligibility_policy'), 'warn');
  v_elig    := (check_eligibility(v_c5, 'd5000000-0000-0000-0000-000000000001',
                 tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'))->>'eligible')::boolean;
  v_run_crew := pg_temp.rk_run_node('d8000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_rn_crew FROM assignments WHERE run_id = 'd8000000-0000-0000-0000-000000000002';
  IF NOT v_offered THEN v_ok := false; v_why := v_why || ' Widget P not offered at C5'; END IF;
  IF NOT v_covers THEN v_ok := false; v_why := v_why || ' the plant home does not cover C1'; END IF;
  IF v_policy <> 'block' THEN v_ok := false; v_why := v_why || ' policy at C5=' || v_policy; END IF;
  IF v_elig THEN v_ok := false; v_why := v_why || ' Op1 is unexpectedly eligible at C5'; END IF;
  IF v_run_crew <> v_c1 THEN v_ok := false; v_why := v_why || ' RR is not on C1'; END IF;
  IF v_rn_crew <> 0 THEN v_ok := false; v_why := v_why || ' RN is not crewless'; END IF;
  IF pg_temp.rk_crew_nodes('d8000000-0000-0000-0000-000000000001') <> v_c1::text THEN
    v_ok := false; v_why := v_why || ' RR''s crew is not on C1'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK0';
  ELSE RAISE NOTICE 'FAIL RK0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL RK0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK0;

\echo 'RK1 (DEF-0014): a raw UPDATE of RR''s node by the site admin, with crew, is refused at commit with reason run_moved_without_crew, and RR is still on C1'
SAVEPOINT rk_RK1;
DO $$
DECLARE v_c1 uuid; v_c2 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_after uuid; v_crew text; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM rk_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM rk_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  -- The bare PATCH, then force the deferred check inside this subtransaction.
  BEGIN
    UPDATE runs SET node_id = v_c2 WHERE id = 'd8000000-0000-0000-0000-000000000001';
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.rk_run_node('d8000000-0000-0000-0000-000000000001');
  v_crew  := pg_temp.rk_crew_nodes('d8000000-0000-0000-0000-000000000001');
  IF NOT (v_state = 'PT409'
          AND COALESCE(v_detail->>'error', '') = 'run_node_mismatch'
          AND COALESCE(v_detail->>'reason', '') = 'run_moved_without_crew'
          AND v_detail->>'run_id' = 'd8000000-0000-0000-0000-000000000001'
          AND v_detail->>'node_id' = v_c2::text
          AND v_detail->'stranded'->0->>'assignment_id' = 'd9000000-0000-0000-0000-000000000001')
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_c1 THEN v_ok := false; v_why := v_why || ' the run moved: on ' || v_after::text; END IF;
  IF v_crew <> v_c1::text THEN v_ok := false; v_why := v_why || ' the crew moved: on ' || COALESCE(v_crew, 'null'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK1';
  ELSE RAISE NOTICE 'FAIL RK1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RK1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK1;

\echo 'RK2: a raw UPDATE of RN (NO crew) still succeeds when forced immediate --- the guard is about the crew, not the move'
SAVEPOINT rk_RK2;
DO $$
DECLARE v_c4 uuid; v_state text := 'ok'; v_raw text; v_after uuid;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c4 FROM rk_fix WHERE k = 'c4';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE runs SET node_id = v_c4 WHERE id = 'd8000000-0000-0000-0000-000000000002';
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  v_after := pg_temp.rk_run_node('d8000000-0000-0000-0000-000000000002');
  IF v_state <> 'ok' THEN v_ok := false; v_why := v_why || ' the crewless move was refused: ' || v_state || '/' || COALESCE(v_raw, ''); END IF;
  IF v_after <> v_c4 THEN v_ok := false; v_why := v_why || ' RN did not move: on ' || v_after::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK2';
  ELSE RAISE NOTICE 'FAIL RK2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RK2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK2;

\echo 'RK3 (R-037): move_run of RR with its crew succeeds; forced immediate it does NOT raise, and the crew arrives on C2 with the run'
SAVEPOINT rk_RK3;
DO $$
DECLARE v_c2 uuid; v_state text := 'ok'; v_raw text; v_after uuid; v_crew text;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c2 FROM rk_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- ⚠️ RESET THE MODE TO DEFERRED FIRST. A prior case's successful
    -- `SET CONSTRAINTS ALL IMMEDIATE` runs inside a plpgsql subtransaction that
    -- RELEASES, and that mode change survives the case's `ROLLBACK TO SAVEPOINT`
    -- (measured: it does). If the transaction were left IMMEDIATE here,
    -- move_run's `UPDATE runs` would fire the constraint trigger BETWEEN the run
    -- move and the crew move --- exactly the mid-move state 0059 must not see ---
    -- and refuse a legitimate move_run. Deferred is what move_run relies on.
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM move_run('d8000000-0000-0000-0000-000000000001', v_c2,
                     tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'));
    -- Force the deferred check NOW: move_run carried the crew, so it must pass.
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  v_after := pg_temp.rk_run_node('d8000000-0000-0000-0000-000000000001');
  v_crew  := pg_temp.rk_crew_nodes('d8000000-0000-0000-0000-000000000001');
  IF v_state <> 'ok' THEN v_ok := false; v_why := v_why || ' move_run was refused: ' || v_state || '/' || COALESCE(v_raw, ''); END IF;
  IF v_after <> v_c2 THEN v_ok := false; v_why := v_why || ' the run did not move: on ' || v_after::text; END IF;
  IF v_crew <> v_c2::text THEN v_ok := false; v_why := v_why || ' the crew did not follow: on ' || COALESCE(v_crew, 'null'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK3';
  ELSE RAISE NOTICE 'FAIL RK3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RK3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK3;

\echo 'RK4 (R-037): move_run refused for another reason (crew not eligible for C5 under block) leaves RR on C1 and its crew on C1'
SAVEPOINT rk_RK4;
DO $$
DECLARE v_c1 uuid; v_c5 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_after uuid; v_crew text; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM rk_fix WHERE k = 'c1';
  SELECT v INTO v_c5 FROM rk_fix WHERE k = 'c5';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- Deferred, for the same reason RK3 says: move_run must run both its steps
    -- before any check. Here it is refused by its OWN block pre-check before it
    -- writes anything, so 0059's trigger never even queues.
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM move_run('d8000000-0000-0000-0000-000000000001', v_c5,
                     tstzrange('2099-09-01 06:00+00', '2099-09-01 14:00+00', '[)'));
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.rk_run_node('d8000000-0000-0000-0000-000000000001');
  v_crew  := pg_temp.rk_crew_nodes('d8000000-0000-0000-0000-000000000001');
  -- Refused by move_run's OWN block pre-check (not_eligible), not by 0059.
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'error', '') = 'not_eligible')
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_c1 THEN v_ok := false; v_why := v_why || ' the run moved: on ' || v_after::text; END IF;
  IF v_crew <> v_c1::text THEN v_ok := false; v_why := v_why || ' the crew moved: on ' || COALESCE(v_crew, 'null'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK4';
  ELSE RAISE NOTICE 'FAIL RK4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RK4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK4;

\echo 'RK5: move_run''s grants are unchanged --- EXECUTE to authenticated, revoked from anon and PUBLIC'
SAVEPOINT rk_RK5;
DO $$
DECLARE v_sig text := 'move_run(uuid,uuid,tstzrange,boolean,text)';
        v_a boolean; v_n boolean; v_p boolean; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT has_function_privilege('authenticated', v_sig, 'EXECUTE'),
         has_function_privilege('anon',          v_sig, 'EXECUTE'),
         has_function_privilege('public',        v_sig, 'EXECUTE')
    INTO v_a, v_n, v_p;
  IF NOT (v_a AND NOT v_n AND NOT v_p) THEN
    v_ok := false;
    v_why := v_why || format(' %s: authenticated=%s anon=%s public=%s', v_sig, v_a, v_n, v_p);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RK5';
  ELSE RAISE NOTICE 'FAIL RK5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL RK5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT rk_RK5;

ROLLBACK;

\echo '82_run_keeps_its_crew_test.sql complete (6 cases: RK0-RK5)'
