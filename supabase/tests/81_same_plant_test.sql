-- ============================================================================
-- 81_same_plant_test.sql --- migration 0058 (R-345, R-346, S39).
--
-- The maintainer, 6 Sept, twice:
--
--   "You should be unable to put Plant B operator in Plant A, only operators
--    within the same plant should be assigned within the plant."
--
--   "If a operator is assigned to higher hierarchy they should automatically
--    become available to all lower hierarchy within that hierarchy ... For
--    other operators in the plant we need to give an option to the supervisor
--    to click through something so show remaining operators."
--
-- Two rules and this file is the server half of both. The FIRST is a refusal
-- the table makes, so it is asked of every writer that can place a person. The
-- SECOND is a LIST: who may be read, and what the board is sent about them. The
-- split into "available by default" and "one click away" is the screen's and is
-- not measured here; what is measured is that the screen is handed the plant's
-- people with each person's home, which is the thing it was missing.
--
-- WHY THE FILE EXISTS AT ALL, IN ONE SENTENCE PER HALF. The area override
-- (D113) crossed ANY boundary before this migration, plants included, so
-- "Plant B's welder on Plant A's line" cost a sentence in a reason box; and
-- `operators_select` was "the same BRANCH as one of my grants", so a supervisor
-- granted Line 1 read the people homed at the plant and at the area ABOVE her
-- and not the people in the area BESIDE her --- which, once the panel narrowed
-- again to homes the board had loaded, left her looking at nothing.
--
-- ⚠️ EVERY CASE THAT MEASURES A REFUSAL RUNS AS `authenticated`. The RPCs are
-- SECURITY INVOKER; psql connects as the superuser, who bypasses RLS and whose
-- `app_current_org()` is NULL. NOBODY IN THIS FIXTURE IS A COMPANY ADMIN except
-- where the case is about one (SP11), because `app_is_admin()` short-circuits
-- half the predicates in sight (46's, 47's, 57's and 78's lesson).
--
-- FIXTURE. Two plants of its own, on a week nothing else in the suite touches,
-- so no operator here is booked anywhere else. All times UTC.
--
--   Plant SA (root) . Area SA1 . Line SA1 . Cell SA1
--                   . Area SA2 . Line SA2 . Cell SA2
--   Plant SB (root) . Area SB1 . Line SB1 . Cell SB1
--
--   People:  Pam   homed at PLANT SA   -- above everything, the default case
--            Ada   homed at AREA SA1   -- above the line
--            Lena  homed at LINE SA1   -- the line itself
--            Ola   homed at AREA SA2   -- the other area: behind the click
--            Bruno homed at PLANT SB   -- the other plant: nowhere at all
--
--   People:  s1  org-wide VIEWER + ADMIN grants on Plant SA AND Plant SB.
--                Not a company admin, and able to edit in both plants --- which
--                is the property SP7 needs, or move_run would refuse for lack
--                of rights and never reach the rule under test.
--            s2  org-wide SUPERVISOR + supervisor grant on LINE SA1 only.
--                The maintainer's Ana. She cannot READ the nodes Plant SA,
--                Area SA1 or Area SA2 at all (`nodes_select` is `path <@ grant`,
--                descendants only) and SP10 measures that before it measures
--                what she is sent.
--            a1  the seed's company admin, for SP11 alone.
--
--   Products: Widget S, made at BOTH plants. Two places on purpose: a run
--             carrying it can legally move from Cell SA1 to Cell SB1, so when
--             SP7's move is refused the refusal is about the CREW and cannot be
--             the product guard answering first.
--   Trainings: Welding S owned by Plant SA and held by all four SA people;
--             Welding B owned by Plant SB and held by Bruno.
--   Rows:     RS  run, Cell SA1, Widget S, Tue 2099-08-04 06:00-14:00, hc 2
--               AS1 Lena, ATTACHED to RS, same window, 1.000
--
-- SP0   the premises every case rests on
-- SP1 ⭐ create_assignment across plants, no override: not_offered_here with
--       detail reason 'other_plant', and nothing written
-- SP2 ⭐⭐ the same call WITH the override and a reason: refused identically ---
--       the door D113 opened does not open here
-- SP3   a raw table INSERT with the override: refused too, because it is the
--       TABLE's guard and not an RPC argument
-- SP4   reassign_assignment onto a person from the other plant, with and
--       without the override: refused, and the row still holds Lena
-- SP5   cross-AREA inside one plant with no override: still the plain
--       not_offered_here, and the detail carries NO 'other_plant'
-- SP6   the same with the override and a reason: still TAKEN, and the row
--       records both (D113's unchanged half, pinned here so this migration
--       cannot quietly take it away)
-- SP7 ⭐⭐ move_run of a run whose crew would land in another plant: refused
--       without the override by move_run's own crew pre-check, refused WITH the
--       override by the trigger with reason 'other_plant' --- and the run did
--       not move either time
-- SP8 ⭐ a supervisor granted ONE LINE reads every person in her plant, and
--       nobody from the other plant
-- SP9   ... and their training records the same way (operator_skills follows
--       the person through app_can_read_operator)
-- SP10 ⭐⭐ board_window called as her returns all four of her plant's people,
--       each carrying site_path --- the two homed on nodes she cannot read
--       included --- and Bruno is not in the payload
-- SP11  the company admin still reads every person in the org; her board is
--       still one plant's people
-- SP12  grants on the three functions this migration adds or re-emits
-- SP13 ⚠⚠ app_operator_homes asked directly: a plant with no grant answers
--       nothing, the same as a bogus slug (the reviewer, session 78)
-- SP14  a raw UPDATE moving the row's cell or swapping its person across
--       plants is refused by the table
-- SP15  the company admin is refused the same way
-- SP16  no grant anywhere: no person, no training row, nothing from the helper
-- SP17  re-homing an assigned person into the other plant is refused
-- SP18 ⭐ a VIEWER granted one cell reads the people at their own places and
--       nobody else in the plant, and the helper says the same
-- SP19  board_window says can_place: false to that viewer and true to the line
--       supervisor and the site admin
-- ============================================================================

BEGIN;

CREATE TEMP TABLE sp_fix (k text primary key, v uuid);
GRANT SELECT ON sp_fix TO PUBLIC;

-- Who is on a row, and the whole row, read as the OWNER after RESET ROLE, so a
-- refusal that half-wrote something cannot hide behind an unreadable row.
CREATE FUNCTION pg_temp.sp_who(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT a.operator_id FROM assignments a WHERE a.id = p_id;
$fn$;

CREATE FUNCTION pg_temp.sp_run_node(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT r.node_id FROM runs r WHERE r.id = p_id;
$fn$;

-- How many assignments exist at a node in the fixture week. Every refusal case
-- reads this back: a refusal that has already written half of itself is the
-- failure worth catching, not the refusal.
CREATE FUNCTION pg_temp.sp_count(p_node uuid) RETURNS int
LANGUAGE sql STABLE AS $fn$
  SELECT count(*)::int FROM assignments a
   WHERE a.node_id = p_node
     AND a.timerange && tstzrange('2099-08-03 00:00+00', '2099-08-10 00:00+00', '[)');
$fn$;

DO $$
DECLARE v_sa uuid; v_sa1 uuid; v_la1 uuid; v_ca1 uuid;
        v_sa2 uuid; v_la2 uuid; v_ca2 uuid;
        v_sb uuid; v_sb1 uuid; v_lb1 uuid; v_cb1 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_sa  := (create_node(NULL,   'Plant SA', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_sa1 := (create_node(v_sa,   'Area SA1', 0)->>'id')::uuid;
  v_la1 := (create_node(v_sa1,  'Line SA1', 0)->>'id')::uuid;
  v_ca1 := (create_node(v_la1,  'Cell SA1', 0)->>'id')::uuid;
  v_sa2 := (create_node(v_sa,   'Area SA2', 1)->>'id')::uuid;
  v_la2 := (create_node(v_sa2,  'Line SA2', 0)->>'id')::uuid;
  v_ca2 := (create_node(v_la2,  'Cell SA2', 0)->>'id')::uuid;
  v_sb  := (create_node(NULL,   'Plant SB', 1, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_sb1 := (create_node(v_sb,   'Area SB1', 0)->>'id')::uuid;
  v_lb1 := (create_node(v_sb1,  'Line SB1', 0)->>'id')::uuid;
  v_cb1 := (create_node(v_lb1,  'Cell SB1', 0)->>'id')::uuid;
  RESET ROLE;
  -- Written AFTER RESET ROLE: `authenticated` cannot write a TEMP table (57).
  INSERT INTO sp_fix (k, v) VALUES
    ('sa', v_sa), ('sa1', v_sa1), ('la1', v_la1), ('ca1', v_ca1),
    ('sa2', v_sa2), ('la2', v_la2), ('ca2', v_ca2),
    ('sb', v_sb), ('sb1', v_sb1), ('lb1', v_lb1), ('cb1', v_cb1);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_sa uuid; v_sa1 uuid; v_la1 uuid; v_ca1 uuid; v_sa2 uuid; v_sb uuid;
BEGIN
  SELECT v INTO v_sa  FROM sp_fix WHERE k = 'sa';
  SELECT v INTO v_sa1 FROM sp_fix WHERE k = 'sa1';
  SELECT v INTO v_la1 FROM sp_fix WHERE k = 'la1';
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  SELECT v INTO v_sa2 FROM sp_fix WHERE k = 'sa2';
  SELECT v INTO v_sb  FROM sp_fix WHERE k = 'sb';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000ca'),
    ('00000000-0000-0000-0000-0000000000cb');
  -- s1's ORG-WIDE role is 'viewer' on purpose: `app_is_admin()` must not be
  -- able to answer anything. Her admin GRANTS are what give her edit rights,
  -- through `app_is_admin_on_path` (0019), in both plants.
  -- s2's org-wide role has to be 'supervisor', not 'viewer': `app_can_edit_node`
  -- reaches a supervisor grant only through `app_can_write()`, which reads the
  -- org-wide role (57's lesson).
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000ca', 'viewer'),
    ('c0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000cb', 'supervisor');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001', v_sa,  v_org, 'admin'),
    ('c0000000-0000-0000-0000-000000000001', v_sb,  v_org, 'admin'),
    ('c0000000-0000-0000-0000-000000000002', v_la1, v_org, 'supervisor');

  -- Four homes at four heights in Plant SA, and one in Plant SB.
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('c5000000-0000-0000-0000-000000000001', v_org, 'Pam',   'EMP-S01', v_sa),
    ('c5000000-0000-0000-0000-000000000002', v_org, 'Ada',   'EMP-S02', v_sa1),
    ('c5000000-0000-0000-0000-000000000003', v_org, 'Lena',  'EMP-S03', v_la1),
    ('c5000000-0000-0000-0000-000000000004', v_org, 'Ola',   'EMP-S04', v_sa2),
    ('c5000000-0000-0000-0000-000000000005', v_org, 'Bruno', 'EMP-S05', v_sb);

  -- ⚠️ TWO PLACES, AND THAT IS SP7'S WHOLE PREMISE. A run carrying a part that
  -- is made in only one plant cannot move to the other for a reason that has
  -- nothing to do with people (app_guard_run_scope / D115), and SP7 would then
  -- pass without ever reaching the rule it is about.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('c6000000-0000-0000-0000-000000000001', v_org, 'WS1', 'Widget S');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'c6000000-0000-0000-0000-000000000001', v_sa),
    (v_org, 'c6000000-0000-0000-0000-000000000001', v_sb);

  -- No node requires either training, so `check_eligibility` never speaks and
  -- every refusal below is the one under test.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('c4000000-0000-0000-0000-000000000001', v_org, 'Welding S', v_sa),
    ('c4000000-0000-0000-0000-000000000002', v_org, 'Welding B', v_sb);
  INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
    ('c5000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', v_org),
    ('c5000000-0000-0000-0000-000000000002', 'c4000000-0000-0000-0000-000000000001', v_org),
    ('c5000000-0000-0000-0000-000000000003', 'c4000000-0000-0000-0000-000000000001', v_org),
    ('c5000000-0000-0000-0000-000000000004', 'c4000000-0000-0000-0000-000000000001', v_org),
    ('c5000000-0000-0000-0000-000000000005', 'c4000000-0000-0000-0000-000000000002', v_org);

  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('c8000000-0000-0000-0000-000000000001', v_org, v_ca1, 'c6000000-0000-0000-0000-000000000001',
     tstzrange('2099-08-04 06:00+00', '2099-08-04 14:00+00', '[)'), 2, 'day shift');
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('c9000000-0000-0000-0000-000000000001', v_org, v_ca1, 'c5000000-0000-0000-0000-000000000003',
     'c8000000-0000-0000-0000-000000000001', NULL,
     tstzrange('2099-08-04 06:00+00', '2099-08-04 14:00+00', '[)'), 1.000);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

RESET ROLE;

\echo 'SP0: the premises every case rests on (two roots, five homes at five heights, the part made in both plants, nobody a company admin)'
SAVEPOINT sp_SP0;
DO $$
DECLARE v_sa uuid; v_sb uuid; v_ca1 uuid; v_cb1 uuid; v_la1 uuid; v_sa2 uuid;
        v_roots int; v_s1 text; v_s2 text; v_offered boolean; v_homes int;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_sa   FROM sp_fix WHERE k = 'sa';
  SELECT v INTO v_sb   FROM sp_fix WHERE k = 'sb';
  SELECT v INTO v_ca1  FROM sp_fix WHERE k = 'ca1';
  SELECT v INTO v_cb1  FROM sp_fix WHERE k = 'cb1';
  SELECT v INTO v_la1  FROM sp_fix WHERE k = 'la1';
  SELECT v INTO v_sa2  FROM sp_fix WHERE k = 'sa2';
  SELECT count(*) INTO v_roots FROM nodes WHERE id IN (v_sa, v_sb) AND parent_id IS NULL;
  SELECT role INTO v_s1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000ca';
  SELECT role INTO v_s2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cb';
  -- The part IS offered at the far cell, asked of the same function the run
  -- guard asks. Without this SP7 could pass for the wrong reason.
  v_offered := app_product_offered_at_in_org('10000000-0000-0000-0000-000000000001',
                 'c6000000-0000-0000-0000-000000000001', v_cb1);
  -- Five people, five distinct homes, and the two plants really are two plants.
  SELECT count(DISTINCT site_node_id) INTO v_homes FROM operators
   WHERE id::text LIKE 'c5000000%';
  IF v_roots <> 2 THEN v_ok := false; v_why := v_why || ' roots=' || v_roots; END IF;
  IF NOT (v_s1 = 'viewer' AND v_s2 = 'supervisor') THEN
    v_ok := false; v_why := v_why || format(' s1=%s s2=%s', v_s1, v_s2); END IF;
  IF NOT v_offered THEN v_ok := false; v_why := v_why || ' Widget S is not offered at Cell SB1'; END IF;
  IF v_homes <> 5 THEN v_ok := false; v_why := v_why || ' distinct homes=' || v_homes; END IF;
  IF (SELECT subpath(path, 0, 1) FROM nodes WHERE id = v_ca1)
     = (SELECT subpath(path, 0, 1) FROM nodes WHERE id = v_cb1) THEN
    v_ok := false; v_why := v_why || ' the two cells share a plant label'; END IF;
  -- Ola's area does not cover Cell SA1 and Lena's line does: the premises SP5,
  -- SP6 and SP7 rest on, asked of the function the trigger asks.
  IF app_owner_covers_in_org('10000000-0000-0000-0000-000000000001', v_sa2, v_ca1) THEN
    v_ok := false; v_why := v_why || ' Area SA2 unexpectedly covers Cell SA1'; END IF;
  IF NOT app_owner_covers_in_org('10000000-0000-0000-0000-000000000001', v_la1, v_ca1) THEN
    v_ok := false; v_why := v_why || ' Line SA1 does not cover Cell SA1'; END IF;
  IF pg_temp.sp_who('c9000000-0000-0000-0000-000000000001') <> 'c5000000-0000-0000-0000-000000000003' THEN
    v_ok := false; v_why := v_why || ' the fixture row does not hold Lena'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP0';
  ELSE RAISE NOTICE 'FAIL SP0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL SP0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP0;

\echo 'SP1 (R-345): create_assignment with Plant SB''s person on a Plant SA cell is refused, and the detail says other_plant'
SAVEPOINT sp_SP1;
DO $$
DECLARE v_ca1 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_before int; v_after int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  v_before := pg_temp.sp_count(v_ca1);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_ca1, 'c5000000-0000-0000-0000-000000000005', NULL,
      'c6000000-0000-0000-0000-000000000001',
      tstzrange('2099-08-05 06:00+00', '2099-08-05 14:00+00', '[)'),
      1.000, NULL, NULL, false, NULL, false, NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.sp_count(v_ca1);
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'error', '') = 'not_offered_here'
          AND COALESCE(v_detail->>'reason', '') = 'other_plant'
          AND COALESCE(v_detail->>'kind', '') = 'operator'
          AND COALESCE(v_detail->>'id', '') = 'c5000000-0000-0000-0000-000000000005'
          AND v_detail->>'node_id' = v_ca1::text)
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP1';
  ELSE RAISE NOTICE 'FAIL SP1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP1;

\echo 'SP2 ⭐⭐ (R-345): the SAME call with the area override and a reason is refused IDENTICALLY --- D113''s door does not open across plants'
SAVEPOINT sp_SP2;
DO $$
DECLARE v_ca1 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_before int; v_after int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  v_before := pg_temp.sp_count(v_ca1);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_ca1, 'c5000000-0000-0000-0000-000000000005', NULL,
      'c6000000-0000-0000-0000-000000000001',
      tstzrange('2099-08-05 06:00+00', '2099-08-05 14:00+00', '[)'),
      1.000, NULL, NULL, false, NULL,
      true, 'borrowing Bruno from Plant SB, cleared with both plant managers');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.sp_count(v_ca1);
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'error', '') = 'not_offered_here'
          AND COALESCE(v_detail->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP2';
  ELSE RAISE NOTICE 'FAIL SP2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP2;

\echo 'SP3: a RAW TABLE INSERT with the override, through no function at all, is refused as well --- the rule is the table''s'
SAVEPOINT sp_SP3;
DO $$
DECLARE v_ca1 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_before int; v_after int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  v_before := pg_temp.sp_count(v_ca1);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency,
                             area_override, area_override_reason)
      VALUES ('10000000-0000-0000-0000-000000000001', v_ca1,
              'c5000000-0000-0000-0000-000000000005', 'c6000000-0000-0000-0000-000000000001',
              tstzrange('2099-08-06 06:00+00', '2099-08-06 14:00+00', '[)'), 1.000,
              true, 'short-handed on nights');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.sp_count(v_ca1);
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP3';
  ELSE RAISE NOTICE 'FAIL SP3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP3;

\echo 'SP4 (R-345): reassign_assignment onto the other plant''s person is refused with and without the override, and Lena is still on the row'
SAVEPOINT sp_SP4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_state2 text := 'allowed'; v_detail2 jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM reassign_assignment('c9000000-0000-0000-0000-000000000001',
                                'c5000000-0000-0000-0000-000000000005');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  BEGIN
    PERFORM reassign_assignment('c9000000-0000-0000-0000-000000000001',
                                'c5000000-0000-0000-0000-000000000005',
                                false, NULL, true, 'covering a gap across the road');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state2 = RETURNED_SQLSTATE;
    BEGIN v_detail2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail2 := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' without=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF NOT (v_state2 = 'PT409' AND v_detail2->>'reason' = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' with=' || v_state2 || '/' || COALESCE(v_detail2::text, 'null'); END IF;
  IF pg_temp.sp_who('c9000000-0000-0000-0000-000000000001') <> 'c5000000-0000-0000-0000-000000000003'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP4';
  ELSE RAISE NOTICE 'FAIL SP4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP4;

\echo 'SP5 (D113 unchanged): a person from another AREA of the SAME plant is refused with the plain not_offered_here, and the detail carries NO other_plant'
SAVEPOINT sp_SP5;
DO $$
DECLARE v_ca1 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed';
        v_before int; v_after int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  v_before := pg_temp.sp_count(v_ca1);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_ca1, 'c5000000-0000-0000-0000-000000000004', NULL,
      'c6000000-0000-0000-0000-000000000001',
      tstzrange('2099-08-05 06:00+00', '2099-08-05 14:00+00', '[)'),
      1.000, NULL, NULL, false, NULL, false, NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.sp_count(v_ca1);
  -- The two refusals must be TELLABLE APART, or the screen cannot say "this one
  -- you may wave through, that one you may not".
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'error', '') = 'not_offered_here'
          AND COALESCE(v_detail->>'kind', '') = 'operator' AND NOT (v_detail ? 'reason'))
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP5';
  ELSE RAISE NOTICE 'FAIL SP5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP5;

\echo 'SP6 (D113 unchanged): the same placement WITH the override and a reason is still TAKEN, and the row records both'
SAVEPOINT sp_SP6;
DO $$
DECLARE v_ca1 uuid; v_res jsonb; v_row assignments%ROWTYPE;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment(v_ca1, 'c5000000-0000-0000-0000-000000000004', NULL,
    'c6000000-0000-0000-0000-000000000001',
    tstzrange('2099-08-05 06:00+00', '2099-08-05 14:00+00', '[)'),
    1.000, NULL, NULL, false, NULL,
    true, 'Ola is helping Area SA1 this week');
  RESET ROLE;
  SELECT * INTO v_row FROM assignments WHERE id = (v_res->'assignment'->>'id')::uuid;
  IF NOT (v_row.id IS NOT NULL AND v_row.operator_id = 'c5000000-0000-0000-0000-000000000004'
          AND v_row.node_id = v_ca1 AND v_row.area_override = true
          AND v_row.area_override_reason = 'Ola is helping Area SA1 this week'
          AND v_row.eligibility_override = false)
  THEN v_ok := false; v_why := v_why || ' row=' || COALESCE(to_jsonb(v_row)::text, 'ABSENT'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP6';
  ELSE RAISE NOTICE 'FAIL SP6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP6;

\echo 'SP7 ⭐⭐ (R-345): move_run into the other plant is refused twice over --- by move_run''s own crew pre-check without the override, and by the TABLE with it --- and the run did not move either time'
SAVEPOINT sp_SP7;
DO $$
DECLARE v_ca1 uuid; v_cb1 uuid; v_raw text; v_detail jsonb; v_detail2 jsonb;
        v_state text := 'allowed'; v_state2 text := 'allowed';
        v_node1 uuid; v_node2 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  SELECT v INTO v_cb1 FROM sp_fix WHERE k = 'cb1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  -- Without the override: move_run computes the crew's scope itself, so it can
  -- name everyone at once. That answer knows nothing about plants --- it is
  -- `app_owner_covers`, the same one-directional test D109 uses --- and it is
  -- the FIRST thing to refuse here, which is correct and is not the rule under
  -- test. It carries no `reason`.
  BEGIN
    PERFORM move_run('c8000000-0000-0000-0000-000000000001', v_cb1,
                     tstzrange('2099-08-04 06:00+00', '2099-08-04 14:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_node1 := pg_temp.sp_run_node('c8000000-0000-0000-0000-000000000001');

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  -- ⭐ WITH the override, that pre-check is SKIPPED ENTIRELY (0050: `IF NOT
  -- p_area_override THEN ... END IF`). The run row is updated first and each
  -- assignment follows, so the trigger fires on UPDATE OF node_id and refuses
  -- there. A plpgsql function is one transaction, so the run comes back with
  -- it --- which is why v_node2 is read at all.
  BEGIN
    PERFORM move_run('c8000000-0000-0000-0000-000000000001', v_cb1,
                     tstzrange('2099-08-04 06:00+00', '2099-08-04 14:00+00', '[)'),
                     true, 'moving the whole line to Plant SB for a week');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state2 = RETURNED_SQLSTATE;
    BEGIN v_detail2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail2 := NULL; END;
  END;
  RESET ROLE;
  v_node2 := pg_temp.sp_run_node('c8000000-0000-0000-0000-000000000001');

  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'error', '') = 'not_offered_here'
          AND v_detail->'operators'->0->>'name' = 'Lena')
  THEN v_ok := false; v_why := v_why || ' without=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF NOT (v_state2 = 'PT409' AND v_detail2->>'error' = 'not_offered_here'
          AND v_detail2->>'reason' = 'other_plant'
          AND v_detail2->>'id' = 'c5000000-0000-0000-0000-000000000003')
  THEN v_ok := false; v_why := v_why || ' with=' || v_state2 || '/' || COALESCE(v_detail2::text, 'null'); END IF;
  IF v_node1 <> v_ca1 OR v_node2 <> v_ca1 THEN
    v_ok := false; v_why := v_why || format(' the run moved: after1=%s after2=%s', v_node1, v_node2); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP7';
  ELSE RAISE NOTICE 'FAIL SP7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP7;

\echo 'SP8 ⭐ (R-346): a supervisor granted ONE LINE reads every person in her plant --- above her, beside her and on her line --- and nobody from the other plant'
SAVEPOINT sp_SP8;
DO $$
DECLARE v_names text[]; v_bruno int; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(display_name ORDER BY display_name) INTO v_names
    FROM operators WHERE id::text LIKE 'c5000000%';
  SELECT count(*) INTO v_bruno FROM operators WHERE id = 'c5000000-0000-0000-0000-000000000005';
  RESET ROLE;
  -- Pam is homed at the PLANT, Ada at the AREA ABOVE her, Lena on her own line,
  -- Ola in the OTHER AREA. Before 0058 the last of those four was invisible to
  -- her, which is the half of the maintainer's complaint the read rule owned.
  IF v_names IS DISTINCT FROM ARRAY['Ada', 'Lena', 'Ola', 'Pam']
  THEN v_ok := false; v_why := v_why || ' names=' || COALESCE(v_names::text, 'null'); END IF;
  IF v_bruno <> 0 THEN v_ok := false; v_why := v_why || ' she can read the other plant''s person'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP8';
  ELSE RAISE NOTICE 'FAIL SP8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP8;

\echo 'SP9 (R-346): the training records follow the person --- she reads all four of her plant''s certificates and not the other plant''s'
SAVEPOINT sp_SP9;
DO $$
DECLARE v_rows int; v_bruno int; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM operator_skills
   WHERE skill_id = 'c4000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_bruno FROM operator_skills
   WHERE operator_id = 'c5000000-0000-0000-0000-000000000005';
  RESET ROLE;
  -- `operator_skills_select` is `app_can_read_operator(operator_id)` and has
  -- not been touched since 0026; it moved because the FUNCTION moved. If this
  -- case ever disagrees with SP8, the two were wired apart.
  IF v_rows <> 4 THEN v_ok := false; v_why := v_why || ' plant rows=' || v_rows; END IF;
  IF v_bruno <> 0 THEN v_ok := false; v_why := v_why || ' she reads the other plant''s certificate'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP9';
  ELSE RAISE NOTICE 'FAIL SP9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP9;

\echo 'SP10 ⭐⭐ (R-346): board_window as the line supervisor sends all four of her plant''s people with site_path --- including the two homed on nodes she cannot read --- and none from the other plant'
SAVEPOINT sp_SP10;
DO $$
DECLARE v_la1 uuid; v_sa uuid; v_sa1 uuid; v_sa2 uuid; v_path ltree;
        v_win jsonb; v_ops jsonb; v_nodes int; v_readable int;
        v_names text[]; v_paths text[]; v_missing int;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_la1 FROM sp_fix WHERE k = 'la1';
  SELECT v INTO v_sa  FROM sp_fix WHERE k = 'sa';
  SELECT v INTO v_sa1 FROM sp_fix WHERE k = 'sa1';
  SELECT v INTO v_sa2 FROM sp_fix WHERE k = 'sa2';
  SELECT path INTO v_path FROM nodes WHERE id = v_la1;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;
  -- ⛔ THE PREMISE THE SECURITY DEFINER HELPER EXISTS FOR, MEASURED FIRST.
  -- `nodes_select` is `path <@ grant` --- descendants only --- so she can read
  -- NEITHER the plant root NOR either area. A board_window that resolved home
  -- paths by joining `nodes` would silently drop Pam, Ada and Ola.
  SELECT count(*) INTO v_readable FROM nodes WHERE id IN (v_sa, v_sa1, v_sa2);
  v_win := board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00');
  RESET ROLE;
  v_ops := v_win->'operators';
  SELECT array_agg(e->>'display_name' ORDER BY e->>'display_name'),
         array_agg(e->>'site_path'    ORDER BY e->>'display_name'),
         count(*) FILTER (WHERE e->>'site_path' IS NULL)
    INTO v_names, v_paths, v_missing
    FROM jsonb_array_elements(v_ops) e;
  SELECT jsonb_array_length(v_win->'nodes') INTO v_nodes;

  IF v_readable <> 0 THEN
    v_ok := false; v_why := v_why || ' premise: she can read ' || v_readable || ' of the three nodes above her'; END IF;
  IF v_names IS DISTINCT FROM ARRAY['Ada', 'Lena', 'Ola', 'Pam']
  THEN v_ok := false; v_why := v_why || ' operators=' || COALESCE(v_names::text, 'null'); END IF;
  IF v_missing <> 0 THEN v_ok := false; v_why := v_why || ' ' || v_missing || ' people came with no site_path'; END IF;
  -- The four paths are the four homes, and they are four DIFFERENT heights ---
  -- which is exactly what the screen needs to tell "above this cell" from
  -- "another area of this plant" without seeing the nodes.
  IF v_paths IS DISTINCT FROM ARRAY[
       (SELECT path::text FROM nodes WHERE id = v_sa1),   -- Ada
       (SELECT path::text FROM nodes WHERE id = v_la1),   -- Lena
       (SELECT path::text FROM nodes WHERE id = v_sa2),   -- Ola
       (SELECT path::text FROM nodes WHERE id = v_sa)]    -- Pam
  THEN v_ok := false; v_why := v_why || ' site_paths=' || COALESCE(v_paths::text, 'null'); END IF;
  -- Her board is still only her line: the people widened, the NODES did not.
  IF v_nodes <> 2 THEN v_ok := false; v_why := v_why || ' nodes in the window=' || v_nodes; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP10';
  ELSE RAISE NOTICE 'FAIL SP10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP10;

\echo 'SP11: the company admin still reads every person in the org (the read rule is unchanged for her), and her board is still ONE plant''s people'
SAVEPOINT sp_SP11;
DO $$
DECLARE v_sa uuid; v_path ltree; v_all int; v_win jsonb; v_names text[];
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_sa FROM sp_fix WHERE k = 'sa';
  SELECT path INTO v_path FROM nodes WHERE id = v_sa;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_all FROM operators WHERE id::text LIKE 'c5000000%';
  v_win := board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00');
  RESET ROLE;
  SELECT array_agg(e->>'display_name' ORDER BY e->>'display_name') INTO v_names
    FROM jsonb_array_elements(v_win->'operators') e
   WHERE e->>'employee_ref' LIKE 'EMP-S%';
  -- app_can_read_in_plant keeps app_is_admin() as its first branch, so all five.
  IF v_all <> 5 THEN v_ok := false; v_why := v_why || ' the admin reads ' || v_all || ' of 5'; END IF;
  -- ⚠️ AND YET HER BOARD IS NARROWER THAN IT WAS. board_window used to send
  -- every operator in the org to everyone; it sends the BOARD'S PLANT now, so
  -- Bruno is absent from a Plant SA board even for her. That is the change
  -- R-345 asks for --- he cannot be placed here, so offering him was a dead
  -- end --- and it is stated here rather than discovered.
  IF v_names IS DISTINCT FROM ARRAY['Ada', 'Lena', 'Ola', 'Pam']
  THEN v_ok := false; v_why := v_why || ' board=' || COALESCE(v_names::text, 'null'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP11';
  ELSE RAISE NOTICE 'FAIL SP11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP11;

\echo 'SP12: EXECUTE on the three functions this migration adds or re-emits is granted to authenticated and revoked from anon and PUBLIC'
SAVEPOINT sp_SP12;
DO $$
DECLARE v_ok boolean := true; v_why text := ''; v_sig text; v_a boolean; v_n boolean; v_p boolean;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['app_can_read_in_plant(uuid)',
                               'app_can_read_operator(uuid)',
                               'app_operator_homes(ltree)'] LOOP
    SELECT has_function_privilege('authenticated', v_sig, 'EXECUTE'),
           has_function_privilege('anon',          v_sig, 'EXECUTE'),
           has_function_privilege('public',        v_sig, 'EXECUTE')
      INTO v_a, v_n, v_p;
    IF NOT (v_a AND NOT v_n AND NOT v_p) THEN
      v_ok := false;
      v_why := v_why || format(' %s: authenticated=%s anon=%s public=%s', v_sig, v_a, v_n, v_p);
    END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS SP12';
  ELSE RAISE NOTICE 'FAIL SP12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL SP12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP12;

\echo 'SP13 ⚠⚠: app_operator_homes asked DIRECTLY, as the line supervisor: her own plant answers, a plant she holds no grant in answers nothing, a bogus slug answers nothing'
SAVEPOINT sp_SP13;
DO $$
DECLARE v_sa ltree; v_sb ltree; v_own int; v_other int; v_guess int; v_bogus int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT path INTO v_sa FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'sa');
  SELECT path INTO v_sb FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'sb');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_own   FROM app_operator_homes(v_sa);
  SELECT count(*) INTO v_other FROM app_operator_homes(v_sb);
  -- The reviewer's probe: no node id needed, a guessed slug is enough.
  SELECT count(*) INTO v_guess FROM app_operator_homes(subpath(v_sb, 0, 1));
  SELECT count(*) INTO v_bogus FROM app_operator_homes('no_such_plant'::ltree);
  RESET ROLE;
  IF NOT (v_own = 4 AND v_other = 0 AND v_guess = 0 AND v_bogus = 0)
  THEN v_ok := false; v_why := v_why || format(' own=%s other=%s guessed=%s bogus=%s', v_own, v_other, v_guess, v_bogus); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP13';
  ELSE RAISE NOTICE 'FAIL SP13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP13;

\echo 'SP14 ⭐ (R-345): a raw UPDATE under the policies --- the row''s cell moved to the other plant, or its person swapped for the other plant''s --- is refused by the table'
SAVEPOINT sp_SP14;
DO $$
DECLARE v_cb1 uuid; v_ca1 uuid; v_s1 text := 'allowed'; v_s2 text := 'allowed'; v_d1 jsonb; v_d2 jsonb; v_raw text;
        v_node uuid; v_op uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_cb1 FROM sp_fix WHERE k = 'cb1';
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  -- A DIRECT row for the cell move: AS1 is attached to a run, and moving an
  -- attached row alone is refused first by the run-consistency rule, which is
  -- a different rule from the one under test.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('c9000000-0000-0000-0000-0000000000d1', '10000000-0000-0000-0000-000000000001', v_ca1,
     'c5000000-0000-0000-0000-000000000003', NULL, 'c6000000-0000-0000-0000-000000000001',
     tstzrange('2099-08-06 06:00+00', '2099-08-06 10:00+00', '[)'), 1.000);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE assignments SET node_id = v_cb1 WHERE id = 'c9000000-0000-0000-0000-0000000000d1';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    UPDATE assignments SET operator_id = 'c5000000-0000-0000-0000-000000000005' WHERE id = 'c9000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  RESET ROLE;
  SELECT node_id INTO v_node FROM assignments WHERE id = 'c9000000-0000-0000-0000-0000000000d1';
  SELECT operator_id INTO v_op FROM assignments WHERE id = 'c9000000-0000-0000-0000-000000000001';
  IF NOT (v_s1 = 'PT409' AND COALESCE(v_d1->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' node move: ' || v_s1 || '/' || COALESCE(v_d1::text, 'null'); END IF;
  IF NOT (v_s2 = 'PT409' AND COALESCE(v_d2->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' person swap: ' || v_s2 || '/' || COALESCE(v_d2::text, 'null'); END IF;
  IF NOT (v_node = v_ca1 AND v_op = 'c5000000-0000-0000-0000-000000000003')
  THEN v_ok := false; v_why := v_why || ' the row moved'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP14';
  ELSE RAISE NOTICE 'FAIL SP14:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP14;

\echo 'SP15 ⭐ (R-345): the COMPANY admin is refused the same way --- app_is_admin() does not open this door'
SAVEPOINT sp_SP15;
DO $$
DECLARE v_ca1 uuid; v_raw text; v_detail jsonb; v_state text := 'allowed'; v_before int; v_after int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  v_before := pg_temp.sp_count(v_ca1);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment(v_ca1, 'c5000000-0000-0000-0000-000000000005', NULL,
      'c6000000-0000-0000-0000-000000000001',
      tstzrange('2099-08-05 06:00+00', '2099-08-05 14:00+00', '[)'),
      1.000, NULL, NULL, false, NULL, true, 'the company admin says so');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_after := pg_temp.sp_count(v_ca1);
  IF NOT (v_state = 'PT409' AND COALESCE(v_detail->>'reason', '') = 'other_plant')
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF v_after <> v_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP15';
  ELSE RAISE NOTICE 'FAIL SP15:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP15;

\echo 'SP16 (R-346''s floor): a signed-in person with no grant anywhere reads nobody, and the helper answers nothing'
SAVEPOINT sp_SP16;
DO $$
DECLARE v_sa ltree; v_people int; v_skills int; v_homes int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT path INTO v_sa FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'sa');
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cc');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cc', 'viewer');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cc', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_people FROM operators WHERE id::text LIKE 'c5000000-%';
  SELECT count(*) INTO v_skills FROM operator_skills WHERE operator_id::text LIKE 'c5000000-%';
  SELECT count(*) INTO v_homes  FROM app_operator_homes(v_sa);
  RESET ROLE;
  IF NOT (v_people = 0 AND v_skills = 0 AND v_homes = 0)
  THEN v_ok := false; v_why := v_why || format(' people=%s skills=%s homes=%s', v_people, v_skills, v_homes); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP16';
  ELSE RAISE NOTICE 'FAIL SP16:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP16;

\echo 'SP17 (R-345 by the other road): re-homing an ASSIGNED person into the other plant is refused, so a cross-plant row cannot arise by moving the person either'
SAVEPOINT sp_SP17;
DO $$
DECLARE v_sb uuid; v_raw text; v_state text := 'allowed'; v_msg text; v_home uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_sb FROM sp_fix WHERE k = 'sb';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET site_node_id = v_sb WHERE id = 'c5000000-0000-0000-0000-000000000003';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RESET ROLE;
  SELECT site_node_id INTO v_home FROM operators WHERE id = 'c5000000-0000-0000-0000-000000000003';
  IF NOT (v_state <> 'allowed' AND v_home = (SELECT v FROM sp_fix WHERE k = 'la1'))
  THEN v_ok := false; v_why := v_why || ' state=' || v_state || ' msg=' || COALESCE(v_msg, '') || ' home_moved=' || (v_home <> (SELECT v FROM sp_fix WHERE k = 'la1'))::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP17';
  ELSE RAISE NOTICE 'FAIL SP17:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP17;

\echo 'SP18 ⭐ (R-346, the viewer clause): a viewer granted Cell SA1 reads Pam, Ada and Lena --- homed above the cell --- and not Ola from the other area; the helper answers the same three'
SAVEPOINT sp_SP18;
DO $$
DECLARE v_ca1 uuid; v_sa ltree; v_names text[]; v_homes text[]; v_skills int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  SELECT path INTO v_sa FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'sa');
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cd');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cd', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000004', v_ca1, '10000000-0000-0000-0000-000000000001', 'viewer');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cd', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(display_name ORDER BY display_name) INTO v_names FROM operators WHERE id::text LIKE 'c5000000-%';
  SELECT array_agg(o.display_name ORDER BY o.display_name) INTO v_homes
    FROM app_operator_homes(v_sa) h JOIN operators o ON o.id = h.operator_id;
  SELECT count(*) INTO v_skills FROM operator_skills WHERE operator_id = 'c5000000-0000-0000-0000-000000000004';
  RESET ROLE;
  IF NOT (v_names = ARRAY['Ada', 'Lena', 'Pam'] AND v_homes = ARRAY['Ada', 'Lena', 'Pam'] AND v_skills = 0)
  THEN v_ok := false; v_why := v_why || format(' people=%s homes=%s ola_skill_rows=%s', v_names, v_homes, v_skills); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP18';
  ELSE RAISE NOTICE 'FAIL SP18:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP18;

\echo 'SP19 (R-346, the viewer clause): board_window says can_place false to the viewer and true to the line supervisor and the site admin'
SAVEPOINT sp_SP19;
DO $$
DECLARE v_ca1 uuid; v_path ltree; v_viewer boolean; v_super boolean; v_admin boolean; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_ca1 FROM sp_fix WHERE k = 'ca1';
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cd');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cd', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000004', v_ca1, '10000000-0000-0000-0000-000000000001', 'viewer');
  SELECT path INTO v_path FROM nodes WHERE id = v_ca1;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cd', true);
  SET LOCAL ROLE authenticated;
  v_viewer := (board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00')->>'can_place')::boolean;
  RESET ROLE;
  SELECT path INTO v_path FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'la1');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;
  v_super := (board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00')->>'can_place')::boolean;
  RESET ROLE;
  SELECT path INTO v_path FROM nodes WHERE id = (SELECT v FROM sp_fix WHERE k = 'sa');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  v_admin := (board_window(v_path, '2099-08-03 00:00+00', '2099-08-10 00:00+00')->>'can_place')::boolean;
  RESET ROLE;
  IF NOT (v_viewer = false AND v_super = true AND v_admin = true)
  THEN v_ok := false; v_why := v_why || format(' viewer=%s supervisor=%s admin=%s', v_viewer, v_super, v_admin); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SP19';
  ELSE RAISE NOTICE 'FAIL SP19:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL SP19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SP19;

ROLLBACK;

\echo '81_same_plant_test.sql complete (20 cases: SP0-SP19)'
