-- ============================================================================
-- 45_acting_scope_test.sql — D98 / migration 0018. 11 cases, A1-A11.
--
-- THE FIXTURE IS THE TEST. Every one of these needs a person holding TWO
-- profiles, and nothing in seed.sql creates one -- which is precisely why this
-- hole survived. `unique (org_id, user_id)` permits the same user_id in two
-- different orgs; the seed simply never does it. So each case builds the
-- fixture itself, inside its own savepoint.
--
-- The user is deliberately VIEWER in Northwind (org ...0001) and ADMIN in
-- Contoso (org ...0002). `app_current_profile_id()` orders by org_id, so the
-- acting profile is the Northwind one -- the org where they have NO rights.
-- That is the arrangement that produced the escalation.
-- ============================================================================

BEGIN;

\echo 'A1: viewer-here + admin-elsewhere CANNOT write here -- the escalation, closed'
SAVEPOINT sp_A1;
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f1');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', 'viewer'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f1', 'admin');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_node(NULL, 'Escalated', 0, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS A1';
  ELSE RAISE NOTICE 'FAIL A1: caught=%, detail=% -- A NODE WAS CREATED WHERE THIS USER IS A VIEWER',
        v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A1;

\echo 'A2: app_is_admin() is FALSE in the org they are acting in, TRUE nowhere else matters'
SAVEPOINT sp_A2;
DO $$
DECLARE v_admin boolean; v_org uuid; v_role text; v_other_admin boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f2');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'viewer'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f2', 'admin');
  -- assert the fixture: they really ARE an admin somewhere, or this proves nothing
  SELECT EXISTS (SELECT 1 FROM user_profiles
                  WHERE user_id = '00000000-0000-0000-0000-0000000000f2' AND role = 'admin')
    INTO v_other_admin;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin(), app_current_org() INTO v_admin, v_org;
  RESET ROLE;
  SELECT role INTO v_role FROM user_profiles
   WHERE user_id = '00000000-0000-0000-0000-0000000000f2' AND org_id = v_org;
  IF v_other_admin AND v_admin = false AND v_role = 'viewer' THEN RAISE NOTICE 'PASS A2';
  ELSE RAISE NOTICE 'FAIL A2: admin_somewhere=%, app_is_admin=%, acting_role=%',
        v_other_admin, v_admin, v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A2;

\echo 'A3: app_current_org() and app_current_profile_id() name the SAME profile row'
SAVEPOINT sp_A3;
DO $$
DECLARE v_org uuid; v_pid uuid; v_pid_org uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f3');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f3', 'viewer'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f3', 'admin');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  SELECT app_current_org(), app_current_profile_id() INTO v_org, v_pid;
  RESET ROLE;
  SELECT org_id INTO v_pid_org FROM user_profiles WHERE id = v_pid;
  IF v_org IS NOT NULL AND v_org = v_pid_org THEN RAISE NOTICE 'PASS A3';
  ELSE RAISE NOTICE 'FAIL A3: current_org=%, profile_org=% -- the two disagree', v_org, v_pid_org; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A3;

\echo 'A4: the acting org is DETERMINISTIC -- the lowest org_id, not an arbitrary row'
SAVEPOINT sp_A4;
DO $$
DECLARE v_org uuid; v_lowest uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f4');
  -- inserted HIGH org first, so a heap-order LIMIT 1 would very likely pick it
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f4', 'admin');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f4', 'viewer');
  -- `min(uuid)` does not exist in Postgres (42883). ORDER BY / LIMIT 1 is the
  -- uuid equivalent, and it is also exactly what the function under test does,
  -- so this derives the expectation the same way -- deliberately, because the
  -- claim IS "lowest org_id", not a hardcoded org.
  SELECT org_id INTO v_lowest FROM user_profiles
   WHERE user_id = '00000000-0000-0000-0000-0000000000f4'
   ORDER BY org_id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f4', true);
  SET LOCAL ROLE authenticated;
  SELECT app_current_org() INTO v_org;
  RESET ROLE;
  IF v_org = v_lowest THEN RAISE NOTICE 'PASS A4';
  ELSE RAISE NOTICE 'FAIL A4: acting org % is not the lowest (%)', v_org, v_lowest; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A4;

\echo 'A5: repeated calls in one statement agree with each other'
SAVEPOINT sp_A5;
DO $$
DECLARE v_a uuid; v_b uuid; v_c uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f5');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f5', 'viewer'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000f5', 'admin');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f5', true);
  SET LOCAL ROLE authenticated;
  SELECT app_current_org(), app_current_org(), app_current_org() INTO v_a, v_b, v_c;
  RESET ROLE;
  IF v_a = v_b AND v_b = v_c AND v_a IS NOT NULL THEN RAISE NOTICE 'PASS A5';
  ELSE RAISE NOTICE 'FAIL A5: %, %, %', v_a, v_b, v_c; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A5;

-- ---------------------------------------------------------------------------
-- A6-A10 are the REGRESSION half. A security fix that quietly breaks the
-- ordinary single-profile case is not a fix. Every one of these passed before
-- 0018 and must still pass after it.
-- ---------------------------------------------------------------------------

\echo 'A6: an ordinary single-profile admin is unaffected'
SAVEPOINT sp_A6;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_admin boolean; v_write boolean; v_org uuid;
BEGIN
  SELECT app_is_admin(), app_can_write(), app_current_org() INTO v_admin, v_write, v_org;
  IF v_admin AND v_write AND v_org = '10000000-0000-0000-0000-000000000001' THEN
    RAISE NOTICE 'PASS A6';
  ELSE RAISE NOTICE 'FAIL A6: admin=%, write=%, org=%', v_admin, v_write, v_org; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL A6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A6;

\echo 'A7: an ordinary single-profile supervisor is unaffected -- can write, is not admin'
SAVEPOINT sp_A7;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_admin boolean; v_write boolean;
BEGIN
  SELECT app_is_admin(), app_can_write() INTO v_admin, v_write;
  IF v_admin = false AND v_write = true THEN RAISE NOTICE 'PASS A7';
  ELSE RAISE NOTICE 'FAIL A7: admin=%, write=%', v_admin, v_write; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL A7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A7;

-- ⭐ A8 is D85's guard, restated for this migration. `app_is_admin()` is the
-- one term in `nodes_select` that answers WITHOUT reading `nodes`, which is
-- what lets INSERT ... RETURNING see its own row. 0018 changes that function's
-- body, so this case exists to prove the property survived. If a future
-- version of app_is_admin() ever consults `nodes`, this is what breaks.
\echo 'A8: create_node still returns its own row -- the D85 property survives 0018'
SAVEPOINT sp_A8;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := create_node('30000000-0000-0000-0000-000000000001', 'D85 Guard', 0, NULL);
  IF v_result->>'id' IS NOT NULL AND v_result->>'name' = 'D85 Guard' THEN RAISE NOTICE 'PASS A8';
  ELSE RAISE NOTICE 'FAIL A8: create_node returned %', v_result; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL A8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A8;

\echo 'A9: a signed-in user with NO profile is nobody -- null org, not admin, cannot write'
SAVEPOINT sp_A9;
DO $$
DECLARE v_org uuid; v_admin boolean; v_write boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f9');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f9', true);
  SET LOCAL ROLE authenticated;
  SELECT app_current_org(), app_is_admin(), app_can_write() INTO v_org, v_admin, v_write;
  RESET ROLE;
  IF v_org IS NULL AND v_admin = false AND v_write = false THEN RAISE NOTICE 'PASS A9';
  ELSE RAISE NOTICE 'FAIL A9: org=%, admin=%, write=%', v_org, v_admin, v_write; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A9;

-- A10 checks the OTHER direction of the escalation, which A1 alone cannot see:
-- being an admin in the acting org must still work even when a second,
-- lower-privilege profile exists elsewhere. A fix that made multi-profile users
-- powerless everywhere would pass A1 and be just as wrong.
\echo 'A10: admin-here + viewer-elsewhere CAN still write here'
SAVEPOINT sp_A10;
DO $$
DECLARE v_result jsonb; v_org uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000fa');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000fa', 'admin'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000fa', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000001',
           '10000000-0000-0000-0000-000000000001', 'supervisor'
      FROM user_profiles
     WHERE user_id = '00000000-0000-0000-0000-0000000000fa'
       AND org_id = '10000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000fa', true);
  SET LOCAL ROLE authenticated;
  SELECT app_current_org() INTO v_org;
  v_result := create_node('30000000-0000-0000-0000-000000000001', 'Legitimate', 0, NULL);
  RESET ROLE;
  IF v_org = '10000000-0000-0000-0000-000000000001' AND v_result->>'name' = 'Legitimate' THEN
    RAISE NOTICE 'PASS A10';
  ELSE RAISE NOTICE 'FAIL A10: org=%, result=%', v_org, v_result; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A10;

-- ⭐ A11 exists because a mutation found it missing. Reverting `app_can_write`
-- to its unscoped form was caught by NOTHING: A2 covers app_is_admin for the
-- multi-profile case and A7 covers app_can_write for the single-profile case,
-- and between them they left the one combination that matters uncovered.
-- `app_can_write` gates every subtree edit through `app_can_edit_node`, so
-- "can write anywhere" is the same class of escalation as "admin anywhere".
\echo 'A11: viewer-here + supervisor-elsewhere CANNOT write here'
SAVEPOINT sp_A11;
DO $$
DECLARE v_write boolean; v_elsewhere boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000fb');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000fb', 'viewer'),
    ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000fb', 'supervisor');
  -- assert the fixture: they really ARE a supervisor somewhere, or this is vacuous
  SELECT EXISTS (SELECT 1 FROM user_profiles
                  WHERE user_id = '00000000-0000-0000-0000-0000000000fb' AND role = 'supervisor')
    INTO v_elsewhere;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000fb', true);
  SET LOCAL ROLE authenticated;
  SELECT app_can_write() INTO v_write;
  RESET ROLE;
  IF v_elsewhere AND v_write = false THEN RAISE NOTICE 'PASS A11';
  ELSE RAISE NOTICE 'FAIL A11: supervisor_elsewhere=%, app_can_write=%', v_elsewhere, v_write; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL A11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A11;

RESET ROLE;
\echo '45_acting_scope_test.sql: all 11 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;
