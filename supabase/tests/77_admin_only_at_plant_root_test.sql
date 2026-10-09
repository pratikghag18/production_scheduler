-- ============================================================================
-- 77_admin_only_at_plant_root_test.sql — migrations 0053, 0054 and 0056.
--
-- The maintainer: "the admin level should only be applied to the plant root."
-- 0053 put that into `set_site_member` and shipped with no file here, so the
-- tester could remove its whole block on a scratch copy and the suite stayed
-- bit-for-bit identical (DEF-0012). 0054 puts the rule in the table as well,
-- and re-assembles the function from 0022 so the company-admin guard 0053
-- dropped is back (DEF-0011). This file asks all of it, the way 48 and 49 ask
-- 0021 and 0022, with the row read back after every write.
--
-- People added here (g-series, org 1):
--   g1  org-wide VIEWER, admin grant on Plant 1   -- a site admin, not a company admin
-- The seed supplies a1 (org-wide admin WITH an admin grant on Plant 1),
-- a2 (supervisor on Assembly) and a3 (supervisor on Machining).
-- Nodes: Plant 1 (root) 0001, Assembly 0002, Line 1 0004.
--
-- AR1-AR4  the RPC: admin at a root stored, admin below refused, the other
--          roles still go anywhere, a site admin can still give admin at a root
-- AR5-AR7  the TABLE: a direct INSERT and a direct UPDATE are refused by the
--          trigger, and a direct INSERT at a root is not (no over-reach)
-- AR8      DEF-0011's twin: the company-admin guard is in the same function
-- AR9      the owner is not bound (fixtures and migrations are), and an old
--          below-root admin can still be demoted: it refuses creating the
--          state, not repairing it
-- AR10     DEF-0013 / R-341: the definer helper is org-scoped. Asked about
--          the other company's root, its leaf and a uuid that exists nowhere,
--          it says false to all three, and the trigger gives a foreign root
--          the same refusal as a bogus uuid, so no bit escapes
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000c1', 'siteg1@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000c1','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','admin');
END $$;

\echo 'AR1: admin at a plant root is stored, through the RPC'
SAVEPOINT sp_AR1;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'a0000000-0000-0000-0000-000000000002', 'admin');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'admin' THEN RAISE NOTICE 'PASS AR1';
  ELSE RAISE NOTICE 'FAIL AR1: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR1: refused at a root: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR1;

\echo 'AR2 ⭐⭐: admin one level down is refused with admin_below_root, and the row is untouched'
SAVEPOINT sp_AR2;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000002',
                            'a0000000-0000-0000-0000-000000000002', 'admin');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_detail->>'reason' = 'admin_below_root' AND v_role = 'supervisor'
  THEN RAISE NOTICE 'PASS AR2';
  ELSE RAISE NOTICE 'FAIL AR2: detail=% role_now=%', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_AR2;

\echo 'AR3: supervisor one level down still goes through -- only admin was narrowed'
SAVEPOINT sp_AR3;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000004',
                          'a0000000-0000-0000-0000-000000000003', 'supervisor');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000004';
  IF v_role = 'supervisor' THEN RAISE NOTICE 'PASS AR3';
  ELSE RAISE NOTICE 'FAIL AR3: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR3: the narrowing over-reached: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR3;

\echo 'AR4: a SITE admin can still give admin at the root they run'
SAVEPOINT sp_AR4;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'a0000000-0000-0000-0000-000000000003', 'admin');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'admin' THEN RAISE NOTICE 'PASS AR4';
  ELSE RAISE NOTICE 'FAIL AR4: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR4: a site admin was refused at their own root: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR4;

\echo 'AR5 ⛔: a direct INSERT of admin below a root is refused by the TABLE, not only the RPC'
SAVEPOINT sp_AR5;
DO $$
DECLARE v_raw text; v_detail jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
      ('a0000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004',
       '10000000-0000-0000-0000-000000000001', 'admin');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000004';
  IF v_detail->>'reason' = 'admin_below_root' AND v_n = 0
  THEN RAISE NOTICE 'PASS AR5';
  ELSE RAISE NOTICE 'FAIL AR5: detail=% rows=%', v_detail, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_AR5;

\echo 'AR6 ⛔: ...and so is a direct UPDATE of a supervisor grant up to admin'
SAVEPOINT sp_AR6;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE profile_grants SET role = 'admin'
     WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
       AND node_id    = '30000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_detail->>'reason' = 'admin_below_root' AND v_role = 'supervisor'
  THEN RAISE NOTICE 'PASS AR6';
  ELSE RAISE NOTICE 'FAIL AR6: detail=% role_now=%', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_AR6;

\echo 'AR7: the trigger does not over-reach -- a direct INSERT of admin AT a root still stores'
SAVEPOINT sp_AR7;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('a0000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001', 'admin');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'admin' THEN RAISE NOTICE 'PASS AR7';
  ELSE RAISE NOTICE 'FAIL AR7: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR7: the trigger refused admin at a root: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR7;

\echo 'AR8 ⭐ (DEF-0011): the company-admin guard is in the SAME function as the root rule'
SAVEPOINT sp_AR8;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  -- g1, a site admin, re-roles the company admin's grant on the plant they
  -- both administer. 0022 refused it; 0053 forgot it; 49's X42 is the same
  -- question asked of 0022 and this one asks it of the LAST definition.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'a0000000-0000-0000-0000-000000000001', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'reason' = 'company_admin' AND v_role = 'admin'
  THEN RAISE NOTICE 'PASS AR8';
  ELSE RAISE NOTICE 'FAIL AR8: detail=% role_now=%', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_AR8;

\echo 'AR9 ⭐: the trigger binds what RLS binds and not the owner, and it refuses CREATING the state, not repairing it'
SAVEPOINT sp_AR9;
DO $$
DECLARE v_role text;
BEGIN
  -- The owner is the migration and fixture tool: this INSERT is the row 0053
  -- promised to leave alone, made the way 46's fixtures make one, and the
  -- trigger lets it through where AR5 refused the same row to a signed-in
  -- COMPANY admin. Then the company admin demotes it through the RPC, which
  -- is the repair an administrator makes and which must not be refused.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('a0000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004',
     '10000000-0000-0000-0000-000000000001', 'admin');

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000004',
                          'a0000000-0000-0000-0000-000000000003', 'supervisor');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000004';
  IF v_role = 'supervisor' THEN RAISE NOTICE 'PASS AR9';
  ELSE RAISE NOTICE 'FAIL AR9: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR9: the repair was refused: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR9;

\echo 'AR10 ⚠⚠: the definer helper says nothing about another company: foreign root, foreign leaf and bogus uuid all get the same answer'
SAVEPOINT sp_AR10;
DO $$
DECLARE
  v_root   boolean;
  v_leaf   boolean;
  v_bogus  boolean;
  v_own    boolean;
  v_state_root  text;
  v_state_bogus text;
  v_n int;
BEGIN
  -- Ana (a2): org 1 supervisor on Assembly, no admin grant anywhere --- the
  -- least-privileged signed-in person the seed has. Org 2's Plant 1 is
  -- 3000000b-...-0001, its Assembly 3000000b-...-0002 (seed.sql).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_root  := app_node_is_plant_root('3000000b-0000-0000-0000-000000000001');
  v_leaf  := app_node_is_plant_root('3000000b-0000-0000-0000-000000000002');
  v_bogus := app_node_is_plant_root('ffffffff-ffff-4fff-8fff-ffffffffffff');
  -- And her own company's root, which she cannot administer but which IS a
  -- root here: true, so the case cannot pass by the helper saying false to all.
  v_own   := app_node_is_plant_root('30000000-0000-0000-0000-000000000001');
  RESET ROLE;

  -- The same bit through the trigger, as the site admin g1: a direct INSERT of
  -- admin on the other company's root and on a bogus uuid must come back with
  -- the SAME sqlstate, and store nothing.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
      ('a0000000-0000-0000-0000-000000000002', '3000000b-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000001', 'admin');
    v_state_root := 'stored';
  EXCEPTION WHEN OTHERS THEN v_state_root := SQLSTATE;
  END;
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
      ('a0000000-0000-0000-0000-000000000002', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
       '10000000-0000-0000-0000-000000000001', 'admin');
    v_state_bogus := 'stored';
  EXCEPTION WHEN OTHERS THEN v_state_bogus := SQLSTATE;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002' AND role = 'admin';

  IF NOT v_root AND NOT v_leaf AND NOT v_bogus AND v_own
     AND v_state_root = v_state_bogus AND v_state_root <> 'stored' AND v_n = 0
  THEN RAISE NOTICE 'PASS AR10';
  ELSE RAISE NOTICE 'FAIL AR10: foreign_root=% foreign_leaf=% bogus=% own_root=% insert_root=% insert_bogus=% admin_rows=%',
       v_root, v_leaf, v_bogus, v_own, v_state_root, v_state_bogus, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL AR10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AR10;

ROLLBACK;
