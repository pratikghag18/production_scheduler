-- ============================================================================
-- 99_home_shift_writers_test.sql --- migration 0083 (R-442; S66-b).
--
-- `set_site_member` and `site_people`, extended to carry the grant's own
-- shift-planning restriction (`profile_grants.plans_shift_id` /
-- `.outside_shift`, 0082). Every answer and refusal is measured as
-- `authenticated` with a real jwt sub, exactly as 98's own header explains.
--
-- FIXTURE --- the SEED's org 1 (Northwind), the same shape 98 uses:
--   Plant 1 (root 30..01)
--     Assembly (30..02)   <- Ana (a2, profile ...a2) supervises here
--   Company admin: profile a1 (jwt sub ...a1), admin at Plant 1.
--   Pattern 3x8h (70..01): Shift 1 (71..01), Shift 2 (71..02), Shift 3 (71..03).
--
-- WS4/WS5 need a SITE admin who is not the company admin, which the seed does
-- not carry (Northwind has one plant root) --- a second plant and a second
-- profile are inserted inline, exactly as HS9 (98) inserts a temporary
-- pattern for its own one case, and rolled back with everything else.
--
-- CASES
--   WS0  a first grant with no shift args: plans_shift_id/outside_shift come
--        back at the columns' own defaults (NULL/true), and site_people's
--        grants array carries them
--   WS1  explicit p_plans_shift_id/p_outside_shift are written and read back
--        both from the function's own return value and from site_people
--   WS2  omitting the two new arguments on a LATER call resets them to the
--        defaults --- deliberate (0083's header): there is no "leave it
--        alone" on the server side, and this is the CLIENT's job
--   WS3  the existing guards cover the new fields too: a caller who does not
--        administer the node is refused before either new column is touched
--   WS4  a SITE admin (of a DIFFERENT plant) may not set a grant on this one
--        even carrying shift args --- the ordinary not_permitted, no new door
--   WS5  a site admin may not touch a company admin's row via the new args
--        either --- the existing company_admin refusal, unbowed
--   WS6  retiring the planned band (deleting the shifts row) leaves the
--        grant's plans_shift_id NULL via the same composite FK 0082 gave it,
--        confirmed through a grant `set_site_member` itself wrote
-- ============================================================================

BEGIN;

\echo 'WS0: a first grant with no shift args reads back at the columns'' own defaults'
SAVEPOINT sp_WS0;
DO $$
DECLARE v_res jsonb; v_people jsonb; v_grant jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'supervisor');
  v_people := site_people('30000000-0000-0000-0000-000000000002');
  RESET ROLE;

  IF v_res->>'plansShiftId' IS NOT NULL THEN v_ok := false; v_why := v_why || format(' plansShiftId=%s', v_res->>'plansShiftId'); END IF;
  IF v_res->>'outsideShift' <> 'true' THEN v_ok := false; v_why := v_why || format(' outsideShift=%s', v_res->>'outsideShift'); END IF;

  SELECT g INTO v_grant FROM jsonb_array_elements(v_people->'people') p,
         jsonb_array_elements(p->'grants') g
   WHERE p->>'profileId' = 'a0000000-0000-0000-0000-000000000002'
     AND g->>'nodeId' = '30000000-0000-0000-0000-000000000002';
  IF v_grant IS NULL THEN v_ok := false; v_why := v_why || ' site_people carried no grant at all';
  ELSE
    IF v_grant->>'plansShiftId' IS NOT NULL THEN v_ok := false; v_why := v_why || ' site_people plansShiftId not null'; END IF;
    IF v_grant->>'outsideShift' <> 'true' THEN v_ok := false; v_why := v_why || format(' site_people outsideShift=%s', v_grant->>'outsideShift'); END IF;
  END IF;

  IF v_ok THEN RAISE NOTICE 'PASS WS0'; ELSE RAISE NOTICE 'FAIL WS0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS0: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS0;

\echo 'WS1: explicit plans_shift_id/outside_shift are written and read back, both ways'
SAVEPOINT sp_WS1;
DO $$
DECLARE v_res jsonb; v_people jsonb; v_grant jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002',
             'supervisor', '71000000-0000-0000-0000-000000000001', false);
  v_people := site_people('30000000-0000-0000-0000-000000000002');
  RESET ROLE;

  IF v_res->>'plansShiftId' <> '71000000-0000-0000-0000-000000000001' THEN
    v_ok := false; v_why := v_why || format(' return plansShiftId=%s', v_res->>'plansShiftId');
  END IF;
  IF v_res->>'outsideShift' <> 'false' THEN v_ok := false; v_why := v_why || ' return outsideShift not false'; END IF;

  SELECT g INTO v_grant FROM jsonb_array_elements(v_people->'people') p,
         jsonb_array_elements(p->'grants') g
   WHERE p->>'profileId' = 'a0000000-0000-0000-0000-000000000002'
     AND g->>'nodeId' = '30000000-0000-0000-0000-000000000002';
  IF v_grant->>'plansShiftId' <> '71000000-0000-0000-0000-000000000001' THEN
    v_ok := false; v_why := v_why || format(' site_people plansShiftId=%s', v_grant->>'plansShiftId');
  END IF;
  IF v_grant->>'outsideShift' <> 'false' THEN v_ok := false; v_why := v_why || ' site_people outsideShift not false'; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS WS1'; ELSE RAISE NOTICE 'FAIL WS1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS1;

\echo 'WS2: omitting the two new arguments on a LATER call resets them to the defaults (deliberate, 0083)'
SAVEPOINT sp_WS2;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002',
             'supervisor', '71000000-0000-0000-0000-000000000001', false);
  -- A later call naming only the role -- exactly what a client that forgot to
  -- resend the shift fields would send.
  v_res := set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'supervisor');
  RESET ROLE;

  IF v_res->>'plansShiftId' IS NOT NULL THEN v_ok := false; v_why := v_why || ' plansShiftId survived the omission'; END IF;
  IF v_res->>'outsideShift' <> 'true' THEN v_ok := false; v_why := v_why || ' outsideShift did not reset to true'; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS WS2'; ELSE RAISE NOTICE 'FAIL WS2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS2;

\echo 'WS3: the existing "you do not administer this place" guard covers the new fields too'
SAVEPOINT sp_WS3;
DO $$
DECLARE v_raised boolean := false; v_ok boolean := true;
BEGIN
  -- Marco (a3) supervises Machining, not Assembly -- he does not administer
  -- Assembly at all, so this must refuse before either new column is touched.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003',
               'supervisor', '71000000-0000-0000-0000-000000000001', false);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%do not administer%' THEN v_raised := true;
    ELSE v_ok := false;
    END IF;
  END;
  RESET ROLE;
  IF NOT v_raised THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS WS3'; ELSE RAISE NOTICE 'FAIL WS3: refused for the wrong reason, or not refused'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS3;

\echo 'WS4/WS5: a SITE admin of a DIFFERENT plant is refused here, and refused on a company admin''s row, shift args or not'
SAVEPOINT sp_WS4;
DO $$
DECLARE
  v_plant2   uuid := gen_random_uuid();
  v_profile2 uuid := gen_random_uuid();
  v_user2    uuid := gen_random_uuid();
  v_raised4  boolean := false;
  v_raised5  boolean := false;
  v_ok boolean := true; v_why text := '';
BEGIN
  -- A second plant root, and a profile who administers ONLY it -- the site
  -- admin persona the single-plant seed does not carry (mirrors HS9's own
  -- temporary-fixture shape, rolled back with everything else).
  INSERT INTO auth.users (id) VALUES (v_user2);
  INSERT INTO nodes (id, org_id, parent_id, level_id, name, path, sort_order)
    SELECT v_plant2, '10000000-0000-0000-0000-000000000001', NULL, level_id,
           'S66b Temp Plant', 's66btempplant'::ltree, 999
      FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode)
    VALUES (v_profile2, '10000000-0000-0000-0000-000000000001', v_user2, 'supervisor', 'run');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    VALUES (v_profile2, v_plant2, '10000000-0000-0000-0000-000000000001', 'admin');

  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- WS4: this site admin does not administer Plant 1's Assembly.
    PERFORM set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002',
               'supervisor', '71000000-0000-0000-0000-000000000001', false);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%do not administer%' THEN v_raised4 := true; ELSE v_ok := false; v_why := v_why || format(' WS4 wrong reason: %s', SQLERRM); END IF;
  END;
  BEGIN
    -- WS5: even on their OWN plant, a company admin's row is not a site
    -- admin's to edit -- carrying shift args changes nothing about that rule.
    PERFORM set_site_member(v_plant2, 'a0000000-0000-0000-0000-000000000001',
               'viewer', '71000000-0000-0000-0000-000000000001', false);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%company_admin%' OR SQLERRM ILIKE '%company admins are not managed%' THEN v_raised5 := true;
    ELSE v_ok := false; v_why := v_why || format(' WS5 wrong reason: %s', SQLERRM);
    END IF;
  END;
  RESET ROLE;

  IF NOT v_raised4 THEN v_ok := false; v_why := v_why || ' WS4 was not refused'; END IF;
  IF NOT v_raised5 THEN v_ok := false; v_why := v_why || ' WS5 was not refused'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS WS4/WS5'; ELSE RAISE NOTICE 'FAIL WS4/WS5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS4/WS5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS4;

\echo 'WS6: retiring the planned band leaves the grant''s plans_shift_id NULL (the same FK 0082 gave home_shift_id)'
SAVEPOINT sp_WS6;
DO $$
DECLARE v_plans uuid; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002',
             'supervisor', '71000000-0000-0000-0000-000000000001', false);
  RESET ROLE;

  DELETE FROM shifts WHERE id = '71000000-0000-0000-0000-000000000001';

  SELECT plans_shift_id INTO v_plans FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id = '30000000-0000-0000-0000-000000000002';
  IF v_plans IS NOT NULL THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS WS6'; ELSE RAISE NOTICE 'FAIL WS6: plans_shift_id=% (expected NULL after the band was retired)', v_plans; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL WS6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_WS6;

ROLLBACK;

\echo '99_home_shift_writers_test.sql complete (WS0-WS6)'
