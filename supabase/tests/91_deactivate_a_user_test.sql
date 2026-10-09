-- ============================================================================
-- 91_deactivate_a_user_test.sql — migration 0076, "deactivate a user".
--
-- A reversible alternative to removing access: `set_profile_active` flips
-- `user_profiles.active`, and the identity chokepoint `app_current_profile_id`
-- gained `AND active`, so a deactivated person resolves to NULL there and is
-- locked out of the whole org. This file makes both falsifiable.
--
-- Uses the seeded org 1 (company admin a1 = ...00a1, plant_1 root =
-- 30000000-...-0001) and adds its own people, the way 48 does:
--   f1  supervisor in org 1, grant on plant_1   -- the ordinary target
--   f2  a SECOND company admin (org-wide 'admin')-- so a1 is never the sole admin
--   f3  a SITE admin: org-wide 'viewer' + admin grant on plant_1
--       -- deactivate is org-wide, so a site admin must be REFUSED it (Y4)
--
-- ⭐ THE ENFORCEMENT CASE IS Y2: after a1 deactivates f1, acting AS f1 the
-- chokepoint answers NULL. A flag nothing consults would pass every other case
-- here and fail only this one.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000f1', 'fern@example.test'),
    ('00000000-0000-0000-0000-0000000000f2', 'gita@example.test'),
    ('00000000-0000-0000-0000-0000000000f3', 'huan@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','supervisor'),
    ('f0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','admin'),
    ('f0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f3','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor'),
    ('f0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin');
END $$;

\echo 'Y0: the fixture is what the rest of this file assumes'
SAVEPOINT sp_Y0;
DO $$
DECLARE v_f1_active boolean; v_a1_admin boolean;
BEGIN
  SELECT active INTO v_f1_active FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT (role = 'admin') INTO v_a1_admin FROM user_profiles WHERE id::text LIKE '%00a1%'
     AND org_id = '10000000-0000-0000-0000-000000000001' LIMIT 1;
  IF v_f1_active IS TRUE THEN RAISE NOTICE 'PASS Y0';
  ELSE RAISE NOTICE 'FAIL Y0: f1_active=% a1_admin=%', v_f1_active, v_a1_admin; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y0: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y0;

\echo 'Y1: a company admin deactivates a person; the row flips and the grant survives'
SAVEPOINT sp_Y1;
DO $$
DECLARE v_out jsonb; v_active boolean; v_grants int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_out := set_profile_active('f0000000-0000-0000-0000-000000000001', false);
  RESET ROLE;
  SELECT active INTO v_active FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_grants FROM profile_grants WHERE profile_id = 'f0000000-0000-0000-0000-000000000001';
  IF v_out->>'active' = 'false' AND (v_out->>'changed')::boolean = true
     AND v_active = false AND v_grants = 1
  THEN RAISE NOTICE 'PASS Y1';
  ELSE RAISE NOTICE 'FAIL Y1: out=% active=% grants=%', v_out, v_active, v_grants; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y1;

\echo 'Y2 ⭐: a deactivated person is locked out — the chokepoint resolves to NULL'
SAVEPOINT sp_Y2;
DO $$
DECLARE v_before uuid; v_after uuid;
BEGIN
  -- Active first: the chokepoint knows f1.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_before := app_current_profile_id();
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', false);
  RESET ROLE;

  -- Deactivated: the SAME query now answers NULL, so app_current_org() and
  -- every RLS check below it deny.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_after := app_current_profile_id();
  RESET ROLE;

  IF v_before = 'f0000000-0000-0000-0000-000000000001' AND v_after IS NULL
  THEN RAISE NOTICE 'PASS Y2';
  ELSE RAISE NOTICE 'FAIL Y2: before=% after=% (want id then NULL)', v_before, v_after; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y2;

\echo 'Y3: reactivation lets them back in'
SAVEPOINT sp_Y3;
DO $$
DECLARE v_after uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', false);
  PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', true);
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_after := app_current_profile_id();
  RESET ROLE;

  IF v_after = 'f0000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS Y3';
  ELSE RAISE NOTICE 'FAIL Y3: after=% (want the id back)', v_after; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y3;

\echo 'Y4 ⭐: a SITE admin is refused — deactivate is org-wide, not node-scoped'
SAVEPOINT sp_Y4;
DO $$
DECLARE v_refused boolean := false; v_active boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', false);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  SELECT active INTO v_active FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  IF v_refused AND v_active = true
  THEN RAISE NOTICE 'PASS Y4';
  ELSE RAISE NOTICE 'FAIL Y4: refused=% still_active=%', v_refused, v_active; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y4;

\echo 'Y5 ⭐: you cannot deactivate your OWN account'
SAVEPOINT sp_Y5;
DO $$
DECLARE v_refused boolean := false; v_me uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_me := app_current_profile_id();
  BEGIN
    PERFORM set_profile_active(v_me, false);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  IF v_refused AND (SELECT active FROM user_profiles WHERE id = v_me) = true
  THEN RAISE NOTICE 'PASS Y5';
  ELSE RAISE NOTICE 'FAIL Y5: refused=%', v_refused; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y5;

\echo 'Y6 ⭐: a bogus / foreign profile id answers "no such person", no existence leak'
SAVEPOINT sp_Y6;
DO $$
DECLARE v_refused boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_profile_active('99999999-9999-9999-9999-999999999999', false);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  RESET ROLE;
  IF v_refused THEN RAISE NOTICE 'PASS Y6';
  ELSE RAISE NOTICE 'FAIL Y6: a bogus id was not refused'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y6;

\echo 'Y7: site_people carries the active flag, and it follows the switch'
SAVEPOINT sp_Y7;
DO $$
DECLARE v_people jsonb; v_flag_off jsonb; v_flag_on jsonb;
BEGIN
  -- Deactivate, then read the plant's people as the company admin.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', false);
  v_people := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT p INTO v_flag_off FROM jsonb_array_elements(v_people->'people') p
   WHERE p->>'profileId' = 'f0000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_profile_active('f0000000-0000-0000-0000-000000000001', true);
  v_people := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT p INTO v_flag_on FROM jsonb_array_elements(v_people->'people') p
   WHERE p->>'profileId' = 'f0000000-0000-0000-0000-000000000001';

  IF v_flag_off->>'active' = 'false' AND v_flag_on->>'active' = 'true'
  THEN RAISE NOTICE 'PASS Y7';
  ELSE RAISE NOTICE 'FAIL Y7: off=% on=%', v_flag_off->>'active', v_flag_on->>'active'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL Y7: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Y7;

ROLLBACK;
