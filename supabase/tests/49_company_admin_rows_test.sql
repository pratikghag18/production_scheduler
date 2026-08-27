-- ============================================================================
-- 49_company_admin_rows_test.sql — migration 0022.
--
-- "I logged in as Dana and I have ability to remove the company admin."
-- Reported from the running app. Measured before anything was changed:
--
--   site admin removes the company admin's grant  -> ALLOWED, row deleted
--   the company admin immediately afterwards      -> app_is_admin = true,
--                                                    admin_for(Plant 1) = true,
--                                                    every node still visible
--
-- Not an escalation, and it took nothing away -- a company admin's authority
-- is `user_profiles.role`, which a site admin cannot write (0020 §9). It is
-- still a role inversion, and a button that claims to do something it does
-- not. 0022 refuses it at the server, which is what makes hiding it on the
-- screen honest rather than a lie of omission.
--
-- ⭐ THE FIXTURE NEEDS A COMPANY ADMIN *WITHOUT* A GRANT, and that is not
-- decoration: X45 is the ordering case, and "there is nothing here to remove"
-- can only be told from "you may not edit that person" by somebody for whom
-- both are true at once.
--
-- People added here (f-series, all in org 1):
--   f1  org-wide VIEWER, admin grant on Plant 1   -- the site admin, "Dana"
--   f2  org-wide ADMIN,  no grant anywhere        -- a second company admin
-- The seed supplies a1 (org-wide admin WITH an admin grant on Plant 1),
-- a2 (supervisor on Assembly) and a3 (supervisor on Machining).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000f1', 'sitef1@example.test'),
    ('00000000-0000-0000-0000-0000000000f2', 'bossf2@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f1','viewer'),
    ('f0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f2','admin');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','admin');
END $$;

\echo 'X40: the fixture is what the rest of this file assumes'
SAVEPOINT sp_X40;
RESET ROLE;
DO $$
DECLARE v_f1 text; v_f2 text; v_f2_grants int; v_a1_grant text;
BEGIN
  SELECT role INTO v_f1 FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT role INTO v_f2 FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO v_f2_grants FROM profile_grants
   WHERE profile_id = 'f0000000-0000-0000-0000-000000000002';
  SELECT role INTO v_a1_grant FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';

  -- f1 must be an org-wide VIEWER or `app_is_admin()` short-circuits the guard
  -- and this whole file passes against a migration that did nothing (46's
  -- lesson, and 47's, and 48's).
  IF v_f1 = 'viewer' AND v_f2 = 'admin' AND v_f2_grants = 0 AND v_a1_grant = 'admin'
  THEN RAISE NOTICE 'PASS X40';
  ELSE RAISE NOTICE 'FAIL X40: f1=% (want viewer), f2=% (want admin), f2_grants=% (want 0), a1_grant=% (want admin)',
       v_f1, v_f2, v_f2_grants, v_a1_grant;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X40: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X40;

\echo 'X41 ⭐: a site admin cannot REMOVE a company admin''s grant, and the row survives'
SAVEPOINT sp_X41;
DO $$
DECLARE v_raw text; v_detail jsonb; v_left int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'a0000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- Asserting the row count as well as the refusal: 48's X28 is the reason.
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'company_admin' AND v_left = 1
  THEN RAISE NOTICE 'PASS X41';
  ELSE RAISE NOTICE 'FAIL X41: detail=% rows_left=% (want 1)', v_detail, v_left; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X41;

\echo 'X42 ⭐: ...nor change the role they hold'
SAVEPOINT sp_X42;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
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
  THEN RAISE NOTICE 'PASS X42';
  ELSE RAISE NOTICE 'FAIL X42: detail=% role_now=%', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X42;

\echo 'X43 ⭐: and it does NOT over-reach -- an ordinary person is still theirs to manage'
SAVEPOINT sp_X43;
DO $$
DECLARE v_role text;
BEGIN
  -- The half a `NOT app_is_admin()`-only guard would fail: refusing everybody
  -- would pass X41 and X42 and break the entire feature.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'a0000000-0000-0000-0000-000000000002', 'viewer');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS X43';
  ELSE RAISE NOTICE 'FAIL X43: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X43: the guard refused an ordinary person: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X43;

\echo 'X44: two company admins are peers -- one may edit the other'
SAVEPOINT sp_X44;
DO $$
DECLARE v_left int;
BEGIN
  -- `NOT app_is_admin()` is the whole condition, and f2 is a company admin.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                             'a0000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_left = 0 THEN RAISE NOTICE 'PASS X44';
  ELSE RAISE NOTICE 'FAIL X44: rows_left=%', v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X44: a company admin was refused: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X44;

\echo 'X45 ⭐: "nothing here to remove" outranks "you may not edit that person"'
SAVEPOINT sp_X45;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- ⭐ THE ORDERING CASE, AND THE ONLY STATE THAT CAN TELL THE TWO APART: f2 is
  -- a company admin AND holds no grant on Plant 1, so both rules are live at
  -- once. The absent row is the truer sentence -- and putting the new guard
  -- first would answer "you may not edit that person" about a row that is not
  -- there, sending the admin to argue about permissions over a typo.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'f0000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X45';
  ELSE RAISE NOTICE 'FAIL X45: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X45;

\echo 'X46 ⭐: the gap this migration does NOT close, asserted rather than left to be found'
SAVEPOINT sp_X46;
DO $$
DECLARE v_left int;
BEGIN
  -- ⭐ A CASE THAT PINS A LIMITATION, the way 0020's W24 does. `profile_grants`'
  -- RLS is untouched, so a caller reaching PostgREST directly -- not through
  -- the RPC -- can still delete a company admin's grant on a node they
  -- administer. 0022 §3 records why the policy was left alone: putting it
  -- there means `profile_grants_delete` reading `user_profiles`, and a policy
  -- that delegates into another table's contents greps clean and inherits
  -- every hole of the thing it reads (verification rule 9).
  --
  -- Whoever closes that gap deletes this case deliberately, rather than
  -- discovering the hole.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  RESET ROLE;
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_left = 0
  THEN RAISE NOTICE 'PASS X46';
  ELSE RAISE NOTICE 'FAIL X46: the direct DELETE was refused -- the policy now guards this, so 0022 §3 and this case are both out of date'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X46: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X46;

\echo 'X47: the helper is org-scoped and answers false for a stranger'
SAVEPOINT sp_X47;
DO $$
DECLARE v_own boolean; v_other boolean; v_ghost boolean; v_plain boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_own   := app_profile_is_company_admin('a0000000-0000-0000-0000-000000000001');
  v_plain := app_profile_is_company_admin('a0000000-0000-0000-0000-000000000002');
  -- org 2's company admin: a real company admin, and not in this org.
  v_other := app_profile_is_company_admin('a000000b-0000-0000-0000-000000000001');
  v_ghost := app_profile_is_company_admin('88888888-8888-8888-8888-888888888888');
  RESET ROLE;
  IF v_own AND NOT v_plain AND NOT v_other AND NOT v_ghost
  THEN RAISE NOTICE 'PASS X47';
  ELSE RAISE NOTICE 'FAIL X47: own=% plain=% other_org=% ghost=%', v_own, v_plain, v_other, v_ghost; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X47;

\echo 'X48: EXECUTE on the new helper is granted to authenticated and to nobody else'
SAVEPOINT sp_X48;
RESET ROLE;
DO $$
DECLARE v_oid oid; v_bad text := '';
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'app_profile_is_company_admin';
  IF v_oid IS NULL THEN
    RAISE NOTICE 'FAIL X48: the function does not exist'; RETURN;
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'PUBLIC; '; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'not authenticated; '; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'anon; '; END IF;
  IF v_bad = '' THEN RAISE NOTICE 'PASS X48';
  ELSE RAISE NOTICE 'FAIL X48: %', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X48: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X48;

ROLLBACK;

\echo '49_company_admin_rows_test.sql complete (9 cases: X40-X48)'
