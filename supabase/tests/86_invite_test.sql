-- ============================================================================
-- 86_invite_test.sql --- site_people CARRIES "invited, not yet signed in" (0064).
--
-- Wave 3 lane A (P1-6c, S24). Migration 0064 re-emits site_people with one new
-- field, `invitedPending` = (auth.users.last_sign_in_at IS NULL), so the Access
-- panel can mark a person who has been granted a place but has never signed in.
--
-- WHAT IS PROVED HERE:
--   I1   a person whose auth row has last_sign_in_at = NULL reads
--        invitedPending = true; one who has signed in reads false, IN THE SAME
--        payload, so the flag is per-person and not a whole-call constant.
--   I2   a profile whose auth row is absent (the LEFT JOIN's null side) reads
--        invitedPending = true --- the safe direction, and the same "not here
--        yet" the field means.
--   I3   the invited person still carries their grant and email, so the flag is
--        an ADDITION and did not disturb the row 0021/0060 already built.
--
-- AND 0060 §2's guards are copied forward (the re-emit must not have dropped
-- them), adapted to this file's fixture:
--   G1   site_people(node) with no other argument: returned = total, people is
--        an array (0060 X55).
--   G2   site_people(node, null, 1) caps at 1, total is the full count, and
--        returned < total so the cap is observable (0060 X56).
--   G3   site_people(node, '<email fragment>', null) filters by email to one
--        person (0060 X57).
--   G4   the node-exists and admin-for refusals still fire: a non-admin caller
--        gets not_permitted, a bad node gets invalid_argument (0021 §3/§4).
--   G5   EXECUTE on the re-emitted function is authenticated only (0060 X58).
--
-- Fixture, in the seeded org 1 (node 3...0001 is a plant root the seed builds,
-- 3...0002 a child under it --- the same ids 48 and 83 lean on):
--   sitei1  a site admin (org-wide viewer + admin grant on the plant root)
--   inv1    invited, never signed in (last_sign_in_at NULL), viewer on the root
--   sig1    signed in once (last_sign_in_at set), viewer on the root
--   orph1   a profile whose auth.users row is deleted after creation
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email, last_sign_in_at) VALUES
    ('00000000-0000-0000-0000-0000000000e1', 'sitei1@example.test', now()),
    ('00000000-0000-0000-0000-0000000000e2', 'inv1@example.test',   NULL),
    ('00000000-0000-0000-0000-0000000000e3', 'sig1@example.test',   now()),
    ('00000000-0000-0000-0000-0000000000e4', 'orph1@example.test',  now());

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e1','viewer'),
    ('e0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e2','viewer'),
    ('e0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e3','viewer');

  -- sitei1 administers the plant root; inv1 and sig1 are granted viewer there so
  -- they show as members with a direct grant and email carried through.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','admin'),
    ('e0000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','viewer'),
    ('e0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','viewer');
END $$;

-- orph1: a profile with NO matching auth.users row --- the LEFT JOIN's null
-- side. user_profiles.user_id is a NOT NULL FK with ON DELETE CASCADE, so the
-- auth row cannot simply be deleted (it would take the profile with it) and the
-- id cannot point at nothing (the FK refuses). session_replication_role =
-- replica turns the FK trigger off for this one insert, the standard way to
-- fabricate a dangling reference for a test; it is reset immediately. Requires
-- superuser, which the scratch DB's owner is.
SET session_replication_role = replica;
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e0000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000ee','viewer');
SET session_replication_role = origin;

-- A helper: the invitedPending flag for one email in a site_people payload.
CREATE OR REPLACE FUNCTION pg_temp.invited_of(v jsonb, p_email text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT (p->>'invitedPending')::boolean
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'email' IS NOT DISTINCT FROM p_email
   LIMIT 1;
$$;

\echo 'I1: invited (last_sign_in_at NULL) reads true; signed-in reads false, same payload'
SAVEPOINT sp_I1;
DO $$
DECLARE v jsonb; v_inv boolean; v_sig boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_inv := pg_temp.invited_of(v, 'inv1@example.test');
  v_sig := pg_temp.invited_of(v, 'sig1@example.test');
  IF v_inv IS TRUE AND v_sig IS FALSE
  THEN RAISE NOTICE 'PASS I1';
  ELSE RAISE NOTICE 'FAIL I1: inv1=% sig1=%', v_inv, v_sig; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL I1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_I1;

\echo 'I2: a profile whose auth row is absent reads invitedPending = true'
SAVEPOINT sp_I2;
DO $$
DECLARE v jsonb; v_orph boolean; v_hit int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  -- The orphan carries a null email, so find it by profileId rather than email.
  SELECT (p->>'invitedPending')::boolean, 1 INTO v_orph, v_hit
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'profileId' = 'e0000000-0000-0000-0000-000000000004';
  IF v_hit = 1 AND v_orph IS TRUE
  THEN RAISE NOTICE 'PASS I2';
  ELSE RAISE NOTICE 'FAIL I2: orphan hit=% invitedPending=%', v_hit, v_orph; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL I2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_I2;

\echo 'I3: the invited person still carries their grant and email --- the flag is an addition'
SAVEPOINT sp_I3;
DO $$
DECLARE v jsonb; v_email text; v_grants int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT p->>'email', jsonb_array_length(p->'grants') INTO v_email, v_grants
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'profileId' = 'e0000000-0000-0000-0000-000000000002';
  IF v_email = 'inv1@example.test' AND v_grants = 1
  THEN RAISE NOTICE 'PASS I3';
  ELSE RAISE NOTICE 'FAIL I3: email=% grants=%', v_email, v_grants; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL I3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_I3;

\echo 'G1: site_people(node) with no other argument --- returned=total, people is an array (0060 X55)'
SAVEPOINT sp_G1;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_arr int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  v_arr      := jsonb_array_length(v->'people');
  IF v_total >= 4 AND v_returned = v_total AND v_arr = v_returned
  THEN RAISE NOTICE 'PASS G1 (total=%)', v_total;
  ELSE RAISE NOTICE 'FAIL G1: total=% returned=% arr=%', v_total, v_returned, v_arr; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL G1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_G1;

\echo 'G2: site_people(node, null, 1) caps at 1, total is the full count, returned < total (0060 X56)'
SAVEPOINT sp_G2;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_arr int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001', NULL, 1);
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  v_arr      := jsonb_array_length(v->'people');
  IF v_returned = 1 AND v_arr = 1 AND v_total >= 4 AND v_returned < v_total
  THEN RAISE NOTICE 'PASS G2 (total=%)', v_total;
  ELSE RAISE NOTICE 'FAIL G2: returned=% arr=% total=%', v_returned, v_arr, v_total; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL G2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_G2;

\echo 'G3: site_people(node, ''inv1'', null) filters by email to exactly that one person (0060 X57)'
SAVEPOINT sp_G3;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_email text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001', 'inv1', NULL);
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  v_email    := v->'people'->0->>'email';
  IF v_total = 1 AND v_returned = 1 AND v_email = 'inv1@example.test'
  THEN RAISE NOTICE 'PASS G3';
  ELSE RAISE NOTICE 'FAIL G3: total=% returned=% email=%', v_total, v_returned, v_email; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL G3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_G3;

\echo 'G4: the refusal guards still fire --- non-admin caller not_permitted, bad node invalid_argument'
SAVEPOINT sp_G4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_np boolean := false; v_ia boolean := false;
BEGIN
  -- inv1 is a plain viewer, administers nothing --> not_permitted.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM site_people('30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    v_np := (v_detail->>'error' = 'not_permitted');
  END;
  -- sitei1 asks about a node that does not exist --> invalid_argument.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  BEGIN
    PERFORM site_people('30000000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    v_ia := (v_detail->>'error' = 'invalid_argument');
  END;
  RESET ROLE;
  IF v_np AND v_ia THEN RAISE NOTICE 'PASS G4';
  ELSE RAISE NOTICE 'FAIL G4: not_permitted=% invalid_argument=%', v_np, v_ia; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_G4;

\echo 'G5: EXECUTE on the re-emitted site_people is authenticated only (0060 X58)'
SAVEPOINT sp_G5;
DO $$
DECLARE v_bad text := ''; v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'site_people'
       AND pg_get_function_identity_arguments(p.oid) = 'p_node_id uuid, p_search text, p_limit integer'
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE NOTICE 'FAIL G5: the 3-argument function does not exist'; RETURN;
  END IF;
  IF has_function_privilege('anon', 'site_people(uuid, text, integer)', 'EXECUTE')
     THEN v_bad := v_bad || 'anon has EXECUTE; ';
  END IF;
  IF NOT has_function_privilege('authenticated', 'site_people(uuid, text, integer)', 'EXECUTE')
     THEN v_bad := v_bad || 'authenticated lacks EXECUTE; ';
  END IF;
  IF v_bad = '' THEN RAISE NOTICE 'PASS G5';
  ELSE RAISE NOTICE 'FAIL G5: %', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL G5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_G5;

ROLLBACK;
