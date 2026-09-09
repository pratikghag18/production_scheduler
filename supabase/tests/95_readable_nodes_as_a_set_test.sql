-- ============================================================================
-- 95_readable_nodes_as_a_set_test.sql --- migration 0074 (R-363, F-124).
--
-- `runs_select` and `assignments_select` used to be `app_can_read_node(node_id)`,
-- evaluated once per row. They are now `node_id IN (SELECT
-- app_readable_node_ids())` --- the SAME predicate, asked once per query. On a
-- plant-sized board that took board_window from ~2,630ms to ~700ms.
--
-- ⛔ WHAT THIS FILE GUARDS IS NOT THE SPEED. It is that the two formulations
-- ANSWER THE SAME. A faster policy that shows one extra row to a line supervisor
-- is not an optimisation, it is a breach, and nothing about the timing matters
-- until that is settled. So every case here compares the set-based answer against
-- the per-row helper ROW BY ROW rather than by count --- two sets of the same
-- size can still be different sets.
--
-- ⚠️ AND IT MUST KEEP WORKING IF SOMEBODY "OPTIMISES" THIS AGAIN. The obvious
-- wrong move is to drop the org filter from `app_readable_node_ids` (an admin of
-- org 1 would then see org 2's nodes, and the count for a single-org fixture
-- would not move at all). RN1 and RN2 compare against the helper for a person in
-- EACH org, so that mutation turns them red rather than passing quietly.
--
-- FIXTURE --- the SEED's two orgs, whose shape is fixed:
--   org 1 (Northwind): Plant 1 / Assembly (Ana a2) / Machining (Marco a3),
--                      a1 company admin, b1 a viewer on Plant 1
--   org 2 (Contoso):   its own Plant 1, admin b-something
--
-- CASES
--   RN0 premises: the function exists, is definer/stable, and both policies use it
--   RN1 company admin: the set equals exactly the nodes app_can_read_node admits
--   RN2 Assembly supervisor: the same, and it is a PROPER SUBSET of the admin's
--   RN3 Machining supervisor: the same, and disjoint from Assembly's below the top
--   RN4 the runs a supervisor can SELECT are exactly those app_can_read_node admits
--   RN5 the same for assignments
--   RN6 a supervisor cannot see the other department's runs --- a positive refusal,
--       so RN4 cannot pass by everything being invisible
--   RN7 the function is authenticated-only, like every other definer helper
-- ============================================================================

\set ON_ERROR_STOP off
BEGIN;

\echo 'RN0: premises --- the function exists, is stable+definer, and both policies use it'
SAVEPOINT sp_RN0;
DO $$
DECLARE v_ok boolean := true; v_why text := ''; v_def text; v_qual text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc WHERE proname = 'app_readable_node_ids';
  IF v_def IS NULL THEN
    v_ok := false; v_why := v_why || ' the function is missing';
  ELSE
    IF v_def NOT ILIKE '%SECURITY DEFINER%' THEN v_ok := false; v_why := v_why || ' not definer'; END IF;
    IF v_def NOT ILIKE '%STABLE%' THEN v_ok := false; v_why := v_why || ' not stable'; END IF;
    IF v_def NOT ILIKE '%search_path%' THEN v_ok := false; v_why := v_why || ' no search_path'; END IF;
  END IF;
  FOR v_qual IN
    SELECT qual FROM pg_policies WHERE tablename IN ('runs','assignments') AND policyname LIKE '%_select'
  LOOP
    IF v_qual NOT ILIKE '%app_readable_node_ids%' THEN
      v_ok := false; v_why := v_why || format(' a select policy does not use the set: %s', v_qual);
    END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS RN0'; ELSE RAISE NOTICE 'FAIL RN0:%', v_why; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_RN0;

-- One comparison, run for whoever is passed in: the SET the policy uses against
-- the per-row helper it replaced, over every node in the database.
CREATE OR REPLACE FUNCTION pg_temp.agrees(p_sub text)
RETURNS TABLE(only_in_set bigint, only_in_helper bigint, in_both bigint)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  RETURN QUERY
  WITH s AS (SELECT app_readable_node_ids() AS id),
       h AS (SELECT n.id FROM nodes n WHERE app_can_read_node(n.id))
  SELECT (SELECT count(*) FROM (SELECT id FROM s EXCEPT SELECT id FROM h) x),
         (SELECT count(*) FROM (SELECT id FROM h EXCEPT SELECT id FROM s) y),
         (SELECT count(*) FROM (SELECT id FROM s INTERSECT SELECT id FROM h) z);
END $$;

\echo 'RN1: company admin --- the set is exactly what app_can_read_node admits'
SAVEPOINT sp_RN1;
DO $$
DECLARE r record; v_ok boolean := true; v_why text := '';
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT * INTO r FROM pg_temp.agrees('00000000-0000-0000-0000-0000000000a1');
  RESET ROLE;
  IF r.only_in_set <> 0 THEN
    v_ok := false; v_why := v_why || format(' %s nodes the SET admits and the helper does not --- a WIDENED read', r.only_in_set);
  END IF;
  IF r.only_in_helper <> 0 THEN
    v_ok := false; v_why := v_why || format(' %s nodes the helper admits and the set does not --- a NARROWED read', r.only_in_helper);
  END IF;
  IF r.in_both = 0 THEN
    v_ok := false; v_why := v_why || ' they agree on NOTHING --- the comparison is vacuous';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN1 (% nodes, both ways)', r.in_both; ELSE RAISE NOTICE 'FAIL RN1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN1;

\echo 'RN2: Assembly supervisor --- agrees, and sees strictly less than the admin'
SAVEPOINT sp_RN2;
DO $$
DECLARE r record; v_sup bigint; v_adm bigint; v_ok boolean := true; v_why text := '';
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT * INTO r FROM pg_temp.agrees('00000000-0000-0000-0000-0000000000a2');
  v_sup := r.in_both;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SELECT count(*) INTO v_adm FROM (SELECT app_readable_node_ids()) x;
  RESET ROLE;
  IF r.only_in_set <> 0 OR r.only_in_helper <> 0 THEN
    v_ok := false; v_why := v_why || format(' disagree: +%s / -%s', r.only_in_set, r.only_in_helper);
  END IF;
  IF v_sup = 0 THEN v_ok := false; v_why := v_why || ' the supervisor sees nothing --- vacuous'; END IF;
  -- The comparison that makes RN1 non-trivial: these are DIFFERENT people.
  IF v_sup >= v_adm THEN
    v_ok := false; v_why := v_why || format(' supervisor sees %s of the admin''s %s --- not narrower', v_sup, v_adm);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN2 (% nodes vs the admin''s %)', v_sup, v_adm; ELSE RAISE NOTICE 'FAIL RN2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN2;

\echo 'RN3: Machining supervisor --- agrees, and does not see Assembly'
SAVEPOINT sp_RN3;
DO $$
DECLARE r record; v_ok boolean := true; v_why text := ''; v_leak bigint;
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT * INTO r FROM pg_temp.agrees('00000000-0000-0000-0000-0000000000a3');
  SELECT count(*) INTO v_leak
    FROM (SELECT app_readable_node_ids() AS id) s
    JOIN nodes n ON n.id = s.id
   WHERE n.path <@ 'plant_1.assembly';
  RESET ROLE;
  IF r.only_in_set <> 0 OR r.only_in_helper <> 0 THEN
    v_ok := false; v_why := v_why || format(' disagree: +%s / -%s', r.only_in_set, r.only_in_helper);
  END IF;
  IF v_leak <> 0 THEN
    v_ok := false; v_why := v_why || format(' Machining''s supervisor can read %s Assembly nodes', v_leak);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN3'; ELSE RAISE NOTICE 'FAIL RN3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN3;

\echo 'RN4: the runs a supervisor can SELECT are exactly those the helper admits'
SAVEPOINT sp_RN4;
DO $$
DECLARE v_seen bigint; v_should bigint; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Through the policy.
  SELECT count(*) INTO v_seen FROM runs;
  -- What the per-row helper would have admitted, asked directly.
  SELECT count(*) INTO v_should FROM runs r WHERE app_can_read_node(r.node_id);
  RESET ROLE;
  IF v_seen <> v_should THEN
    v_ok := false; v_why := v_why || format(' policy shows %s, helper admits %s', v_seen, v_should);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN4 (% runs)', v_seen; ELSE RAISE NOTICE 'FAIL RN4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN4;

\echo 'RN5: the same for assignments'
SAVEPOINT sp_RN5;
DO $$
DECLARE v_seen bigint; v_should bigint; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM assignments;
  SELECT count(*) INTO v_should FROM assignments a WHERE app_can_read_node(a.node_id);
  RESET ROLE;
  IF v_seen <> v_should THEN
    v_ok := false; v_why := v_why || format(' policy shows %s, helper admits %s', v_seen, v_should);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN5 (% assignments)', v_seen; ELSE RAISE NOTICE 'FAIL RN5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN5;

\echo 'RN6: a supervisor cannot see the other department''s runs --- a positive refusal'
SAVEPOINT sp_RN6;
DO $$
DECLARE v_cell uuid; v_run uuid; v_seen_by_a3 bigint; v_seen_by_a2 bigint; v_ok boolean := true; v_why text := '';
BEGIN
  -- A run on an ASSEMBLY cell, made by the person who may.
  SELECT n.id INTO v_cell FROM nodes n JOIN hierarchy_levels l ON l.id = n.level_id
   WHERE n.path <@ 'plant_1.assembly' AND l.is_schedulable ORDER BY n.path LIMIT 1;
  IF v_cell IS NULL THEN RAISE NOTICE 'FAIL RN6: no schedulable cell under Assembly'; RETURN; END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := (create_run(v_cell,
              (SELECT id FROM products WHERE org_id = app_current_org() ORDER BY created_at LIMIT 1),
              tstzrange(now() + interval '40 days', now() + interval '40 days 8 hours', '[)'),
              NULL, NULL)->'run'->>'id')::uuid;
  SELECT count(*) INTO v_seen_by_a2 FROM runs WHERE id = v_run;

  -- Marco supervises Machining, not Assembly. He must not see it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SELECT count(*) INTO v_seen_by_a3 FROM runs WHERE id = v_run;
  RESET ROLE;

  IF v_seen_by_a2 <> 1 THEN
    v_ok := false; v_why := v_why || ' the person who made it cannot see it --- the case proves nothing';
  END IF;
  IF v_seen_by_a3 <> 0 THEN
    v_ok := false; v_why := v_why || ' Machining''s supervisor CAN see an Assembly run';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN6'; ELSE RAISE NOTICE 'FAIL RN6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RN6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN6;

\echo 'RN7: the function is authenticated-only'
SAVEPOINT sp_RN7;
DO $$
DECLARE v_ok boolean := true; v_why text := '';
BEGIN
  IF has_function_privilege('anon', 'public.app_readable_node_ids()', 'EXECUTE') THEN
    v_ok := false; v_why := v_why || ' anon may execute it';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.app_readable_node_ids()', 'EXECUTE') THEN
    v_ok := false; v_why := v_why || ' authenticated may NOT execute it';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RN7'; ELSE RAISE NOTICE 'FAIL RN7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL RN7: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RN7;

ROLLBACK;

\echo '95_readable_nodes_as_a_set_test.sql complete (RN0-RN7)'
