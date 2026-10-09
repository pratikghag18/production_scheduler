-- ============================================================================
-- 92_make_a_system_admin_test.sql — migration 0078, "make a system admin".
--
-- `set_system_admin` flips `user_profiles.role` between 'admin' (system admin,
-- `app_is_admin()`) and 'viewer'. System admins only; not your own row; the
-- person keeps their node grants on demotion. Uses the seeded org 1 (company
-- admin a1 = ...00a1, plant_1 root = 30000000-...-0001) and adds its own people:
--   g1  org-wide 'viewer', no grants          -- the ordinary promotion target
--   g2  a SECOND system admin (org-wide 'admin')-- the demotion target
--   g3  a SITE admin: 'viewer' + admin grant on plant_1
--       -- a site admin must be REFUSED (only a system admin may promote)
--
-- ⭐ Z1 is the point: after a1 promotes g1, acting AS g1, `app_is_admin()` is
-- true. A flag nothing reads would pass the row check and fail this.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000c1', 'ivan@example.test'),
    ('00000000-0000-0000-0000-0000000000c2', 'juno@example.test'),
    ('00000000-0000-0000-0000-0000000000c3', 'kira@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('90000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','viewer'),
    ('90000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c2','admin'),
    ('90000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c3','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('90000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor'),
    ('90000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin');
END $$;

\echo 'Z0: the fixture is what the rest of this file assumes'
SAVEPOINT sp_Z0;
DO $$
DECLARE v_g1 text; v_g2 text;
BEGIN
  SELECT role INTO v_g1 FROM user_profiles WHERE id = '90000000-0000-0000-0000-000000000001';
  SELECT role INTO v_g2 FROM user_profiles WHERE id = '90000000-0000-0000-0000-000000000002';
  IF v_g1 = 'viewer' AND v_g2 = 'admin' THEN RAISE NOTICE 'PASS Z0';
  ELSE RAISE NOTICE 'FAIL Z0: g1=% g2=%', v_g1, v_g2; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z0: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z0;

\echo 'Z1 ⭐: a system admin promotes a viewer, and the promoted person IS a system admin'
SAVEPOINT sp_Z1;
DO $$
DECLARE v_out jsonb; v_role text; v_is_admin boolean; v_grants int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_out := set_system_admin('90000000-0000-0000-0000-000000000001', true);
  RESET ROLE;
  SELECT role INTO v_role FROM user_profiles WHERE id = '90000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_grants FROM profile_grants WHERE profile_id = '90000000-0000-0000-0000-000000000001';

  -- app_is_admin() resolves through the caller, so check it AS the promoted person.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_is_admin := app_is_admin();
  RESET ROLE;

  IF v_out->>'isAdmin' = 'true' AND (v_out->>'changed')::boolean = true
     AND v_role = 'admin' AND v_is_admin = true AND v_grants = 1
  THEN RAISE NOTICE 'PASS Z1';
  ELSE RAISE NOTICE 'FAIL Z1: out=% role=% is_admin=% grants=%', v_out, v_role, v_is_admin, v_grants; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z1;

\echo 'Z2: demotion sets viewer and keeps the person''s node grants'
SAVEPOINT sp_Z2;
DO $$
DECLARE v_role text; v_is_admin boolean;
BEGIN
  -- Give g2 a grant first so "keeps grants" is measurable.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    VALUES ('90000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor')
    ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_system_admin('90000000-0000-0000-0000-000000000002', false);
  RESET ROLE;
  SELECT role INTO v_role FROM user_profiles WHERE id = '90000000-0000-0000-0000-000000000002';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
  SET LOCAL ROLE authenticated;
  v_is_admin := app_is_admin();
  RESET ROLE;

  IF v_role = 'viewer' AND v_is_admin = false
     AND EXISTS (SELECT 1 FROM profile_grants WHERE profile_id = '90000000-0000-0000-0000-000000000002')
  THEN RAISE NOTICE 'PASS Z2';
  ELSE RAISE NOTICE 'FAIL Z2: role=% is_admin=%', v_role, v_is_admin; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z2;

\echo 'Z3 ⭐: a SITE admin is refused — only a system admin may promote'
SAVEPOINT sp_Z3;
DO $$
DECLARE v_refused boolean := false; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_system_admin('90000000-0000-0000-0000-000000000001', true);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM user_profiles WHERE id = '90000000-0000-0000-0000-000000000001';
  IF v_refused AND v_role = 'viewer' THEN RAISE NOTICE 'PASS Z3';
  ELSE RAISE NOTICE 'FAIL Z3: refused=% role=%', v_refused, v_role; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z3;

\echo 'Z4 ⭐: you cannot change your OWN system-admin status'
SAVEPOINT sp_Z4;
DO $$
DECLARE v_refused boolean := false; v_me uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_me := app_current_profile_id();
  BEGIN
    PERFORM set_system_admin(v_me, false);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  IF v_refused AND (SELECT role FROM user_profiles WHERE id = v_me) = 'admin'
  THEN RAISE NOTICE 'PASS Z4';
  ELSE RAISE NOTICE 'FAIL Z4: refused=%', v_refused; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z4;

\echo 'Z5 ⭐: a bogus / foreign profile id answers "no such person", no existence leak'
SAVEPOINT sp_Z5;
DO $$
DECLARE v_refused boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_system_admin('88888888-8888-8888-8888-888888888888', true);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  IF v_refused THEN RAISE NOTICE 'PASS Z5';
  ELSE RAISE NOTICE 'FAIL Z5: a bogus id was not refused'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Z5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Z5;

ROLLBACK;
