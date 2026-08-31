-- ============================================================================
-- 59_training_record_test.sql — migration 0032, D114.
--
-- THE MAINTAINER, 31 August: *"I think a supervisor should be able to see
-- operators and trainings now that I think about it. The supervisor will be the
-- one who enters or uploads the training information."*
--
-- Two claims, and they fail differently:
--
--   D114a  A SUPERVISOR WITH A GRANT MAY KEEP THE TRAINING RECORD on their own
--          branch, and nowhere else. V1-V6.
--   D114b  THE RECORD HOLDS A SIGN-OFF AND A CSV IDENTITY, and neither is
--          entangled with anything it should not be. V7-V11.
--
-- ⚠️⚠️ EVERY CASE RUNS AS `authenticated`, AS A NAMED PERSON. The owner of these
-- tables is not subject to RLS, so a suite that ran as the owner would pass
-- against policies that admit nobody — which is exactly the screen this change
-- exists to stop producing.
--
-- ⭐ THE FIXTURE'S POINT IS THE TWO NEGATIVES, and they are different negatives:
--   * `sup_a`   org-wide 'supervisor', GRANTED Plant A  -> the person this is for
--   * `sup_none` org-wide 'supervisor', NO grant at all -> the role alone is not enough
--   * `viewer_a` org-wide 'viewer',    GRANTED Plant A  -> the grant alone is not enough
-- A fixture with only one of those cannot tell which half of `app_can_edit_node`
-- is load-bearing, and would pass with either half deleted.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000059', 'Org 59');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000059', '11111111-0000-0000-0000-000000000059', 'T59 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000059', '11111111-0000-0000-0000-000000000059',
   '21111111-0000-0000-0000-000000000059', 0, 'Plant', false),
  ('22111111-0000-0000-0000-00000000005a', '11111111-0000-0000-0000-000000000059',
   '21111111-0000-0000-0000-000000000059', 1, 'Line', true);

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000059',
   '22111111-0000-0000-0000-000000000059', NULL, 'T59 Plant A'),
  ('23111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000059',
   '22111111-0000-0000-0000-000000000059', NULL, 'T59 Plant B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000059',
   '22111111-0000-0000-0000-00000000005a', '23111111-0000-0000-0000-0000000000a0', 'T59 Line 1');

INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('25111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000059',
   'T59 Person A', '23111111-0000-0000-0000-0000000000a0'),
  ('25111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000059',
   'T59 Person B', '23111111-0000-0000-0000-0000000000b0');

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000059a0'),
  ('00000000-0000-0000-0000-0000000059c0'),
  ('00000000-0000-0000-0000-0000000059d0');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e1111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000059',
   '00000000-0000-0000-0000-0000000059a0', 'supervisor'),
  ('e1111111-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000059',
   '00000000-0000-0000-0000-0000000059c0', 'viewer'),
  ('e1111111-0000-0000-0000-0000000000d0', '11111111-0000-0000-0000-000000000059',
   '00000000-0000-0000-0000-0000000059d0', 'supervisor');
-- ⭐ sup_a and viewer_a hold the SAME grant on the SAME node. The only thing
-- separating them is the org-wide role, which is `app_can_write`'s half.
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('e1111111-0000-0000-0000-0000000000a0', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000059', 'supervisor'),
  ('e1111111-0000-0000-0000-0000000000c0', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000059', 'supervisor');
-- sup_none gets no grant at all: same role as sup_a, nothing else.

-- ---------------------------------------------------------------------------
\echo 'V1 ⭐⭐: a SUPERVISOR with a grant can create a training on their own branch — the change'
SAVEPOINT sp_V1;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS V1';
  ELSE RAISE NOTICE 'FAIL V1: state=% (want allowed) — a supervisor still cannot create a training', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V1;

\echo 'V2: and not one owned by a plant their grant does not cover'
SAVEPOINT sp_V2;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift',
       '23111111-0000-0000-0000-0000000000b0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = '42501' THEN RAISE NOTICE 'PASS V2';
  ELSE RAISE NOTICE 'FAIL V2: state=% (want 42501) — the grant is not bounding anything', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V2;

\echo 'V3 ⭐: a supervisor grant reaches BELOW the granted node — a training owned by the line'
SAVEPOINT sp_V3;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Line 1 Cert',
       '23111111-0000-0000-0000-0000000000a1');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS V3';
  ELSE RAISE NOTICE 'FAIL V3: state=% (want allowed) — the grant is not covering its own subtree', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V3;

\echo 'V4 ⭐⭐: the ROLE alone is not enough — an ungranted supervisor is refused'
SAVEPOINT sp_V4;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059d0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  -- Same org-wide role as V1's actor and no grant. If this ever passes,
  -- `app_can_edit_node`'s grant arm has stopped being consulted and every
  -- supervisor in the company can write every plant's trainings.
  IF v_state = '42501' THEN RAISE NOTICE 'PASS V4';
  ELSE RAISE NOTICE 'FAIL V4: state=% (want 42501) — the grant half is not load-bearing', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V4;

\echo 'V5 ⭐⭐: and the GRANT alone is not enough — a viewer holding the same grant is refused'
SAVEPOINT sp_V5;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059c0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  -- Identical grant to V1's actor, differing only in the org-wide role. V4 and
  -- V5 together are what pin `app_can_write() AND <grant>` as a conjunction;
  -- either case alone passes with the other half deleted.
  IF v_state = '42501' THEN RAISE NOTICE 'PASS V5';
  ELSE RAISE NOTICE 'FAIL V5: state=% (want 42501) — a viewer can write trainings', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V5;

\echo 'V6 ⭐: a supervisor can record a training against a person on their branch, and not one elsewhere'
SAVEPOINT sp_V6;
DO $$
DECLARE v_mine text := 'none'; v_theirs text := 'none';
BEGIN
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('24111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000059',
     'Forklift', '23111111-0000-0000-0000-0000000000a0');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operator_skills (org_id, operator_id, skill_id, certified_at, signed_off_by)
    VALUES ('11111111-0000-0000-0000-000000000059',
            '25111111-0000-0000-0000-0000000000a0', '24111111-0000-0000-0000-0000000000a0',
            DATE '2026-03-14', 'D. Reyes');
    v_mine := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_mine := SQLSTATE; END;
  BEGIN
    INSERT INTO operator_skills (org_id, operator_id, skill_id)
    VALUES ('11111111-0000-0000-0000-000000000059',
            '25111111-0000-0000-0000-0000000000b0', '24111111-0000-0000-0000-0000000000a0');
    v_theirs := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_theirs := SQLSTATE; END;
  RESET ROLE;
  IF v_mine = 'allowed' AND v_theirs <> 'allowed' THEN RAISE NOTICE 'PASS V6';
  ELSE RAISE NOTICE 'FAIL V6: own branch=% other branch=% (want allowed / refused)', v_mine, v_theirs; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V6;

\echo 'V7 ⭐⭐: the sign-off is FREE TEXT and stores a person who has no login at all'
SAVEPOINT sp_V7;
DO $$
DECLARE v_who text; v_when date;
BEGIN
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('24111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000059',
     'Welding', '23111111-0000-0000-0000-0000000000a0');
  INSERT INTO operator_skills (org_id, operator_id, skill_id, certified_at, signed_off_by)
  VALUES ('11111111-0000-0000-0000-000000000059',
          '25111111-0000-0000-0000-0000000000a0', '24111111-0000-0000-0000-0000000000a1',
          DATE '2026-03-14', 'K. Osei (external assessor, Vendor Ltd)');
  SELECT signed_off_by, certified_at INTO v_who, v_when FROM operator_skills
   WHERE skill_id = '24111111-0000-0000-0000-0000000000a1';
  -- ⭐ The whole point of the decision: this string names somebody the system
  -- has never heard of and never will, which a user_profiles reference could
  -- not have held and a CSV could not have supplied.
  IF v_who = 'K. Osei (external assessor, Vendor Ltd)' AND v_when = DATE '2026-03-14'
    THEN RAISE NOTICE 'PASS V7';
  ELSE RAISE NOTICE 'FAIL V7: who=% when=%', v_who, v_when; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V7;

\echo 'V8 ⚠️: the date and the sign-off are INDEPENDENT — either alone is storable'
SAVEPOINT sp_V8;
DO $$
DECLARE v_n int;
BEGIN
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('24111111-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000059',
     'First Aid', '23111111-0000-0000-0000-0000000000a0');
  -- A date and no signer, then a signer and no date. ⚠️ A CHECK tying the two
  -- together would refuse both of these, and a half-known record is the
  -- ORDINARY case when a spreadsheet arrives with one column filled in. 0030's
  -- area_override is the opposite treatment on purpose: there the pair IS the
  -- decision, here they are two independent facts.
  INSERT INTO operator_skills (org_id, operator_id, skill_id, certified_at)
  VALUES ('11111111-0000-0000-0000-000000000059',
          '25111111-0000-0000-0000-0000000000a0', '24111111-0000-0000-0000-0000000000a2',
          DATE '2026-03-14');
  UPDATE operator_skills SET certified_at = NULL, signed_off_by = 'D. Reyes'
   WHERE skill_id = '24111111-0000-0000-0000-0000000000a2';
  SELECT count(*) INTO v_n FROM operator_skills
   WHERE skill_id = '24111111-0000-0000-0000-0000000000a2'
     AND certified_at IS NULL AND signed_off_by = 'D. Reyes';
  IF v_n = 1 THEN RAISE NOTICE 'PASS V8';
  ELSE RAISE NOTICE 'FAIL V8: % rows survived with one half set (want 1)', v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V8;

\echo 'V9 ⭐: a CSV identity is unique PER OWNER — two plants may each import TRN-4471'
SAVEPOINT sp_V9;
DO $$
DECLARE v_state text := 'none'; v_n int;
BEGIN
  INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000059', 'Forklift',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'TRN-4471');
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'TRN-4471');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM skills WHERE external_id = 'TRN-4471';
  IF v_state = 'allowed' AND v_n = 2 THEN RAISE NOTICE 'PASS V9';
  ELSE RAISE NOTICE 'FAIL V9: state=% rows=% (want allowed/2)', v_state, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V9;

\echo 'V10: and one owner may not hold the same external id twice — a re-import updates, never duplicates'
SAVEPOINT sp_V10;
DO $$
DECLARE v_state text := 'none';
BEGIN
  INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000059', 'Forklift',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'TRN-4471');
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Forklift Refresher',
       '23111111-0000-0000-0000-0000000000a0', 'csv', 'TRN-4471');
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE; END;
  IF v_state = '23505' THEN RAISE NOTICE 'PASS V10';
  ELSE RAISE NOTICE 'FAIL V10: state=% (want 23505) — a re-import would duplicate', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V10;

\echo 'V11 ⚠️: rows with NO external id do not collide with each other'
SAVEPOINT sp_V11;
DO $$
DECLARE v_n int;
BEGIN
  -- ⭐ The partial index exists so the manual rows are not indexed at all. If it
  -- were ever rewritten as a plain unique over three columns it would still
  -- behave this way (NULLs do not collide), which is exactly why the index says
  -- WHERE external_id IS NOT NULL in the schema rather than relying on that.
  INSERT INTO skills (org_id, name, site_node_id) VALUES
    ('11111111-0000-0000-0000-000000000059', 'Manual One', '23111111-0000-0000-0000-0000000000a0'),
    ('11111111-0000-0000-0000-000000000059', 'Manual Two', '23111111-0000-0000-0000-0000000000a0');
  SELECT count(*) INTO v_n FROM skills
   WHERE external_id IS NULL AND site_node_id = '23111111-0000-0000-0000-0000000000a0';
  IF v_n = 2 THEN RAISE NOTICE 'PASS V11';
  ELSE RAISE NOTICE 'FAIL V11: % unowned-external rows (want 2)', v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V11;

\echo 'V12: a site ADMIN can still do everything they could before — the widening took nothing away'
SAVEPOINT sp_V12;
DO $$
DECLARE v_state text := 'none';
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000059e0');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e1111111-0000-0000-0000-0000000000e0', '11111111-0000-0000-0000-000000000059',
     '00000000-0000-0000-0000-0000000059e0', 'supervisor');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e1111111-0000-0000-0000-0000000000e0', '23111111-0000-0000-0000-0000000000b0',
     '11111111-0000-0000-0000-000000000059', 'admin');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059e0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Welding',
       '23111111-0000-0000-0000-0000000000b0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'allowed' THEN RAISE NOTICE 'PASS V12';
  ELSE RAISE NOTICE 'FAIL V12: state=% (want allowed) — an admin grant stopped working', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V12: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V12;

\echo 'V13 ⭐⭐: a supervisor granted a LINE controls that line and NOT the plant above it'
SAVEPOINT sp_V13;
DO $$
DECLARE v_own text := 'none'; v_above text := 'none';
BEGIN
  -- The maintainer, 31 Aug: *"The supervisor is assigned to a line, so can give
  -- them control only for the line they're assigned to?"* This is that case.
  -- The grant is a SUBTREE (`n.path <@ gp`), so it reaches down and never up.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000059f0');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e1111111-0000-0000-0000-0000000000f0', '11111111-0000-0000-0000-000000000059',
     '00000000-0000-0000-0000-0000000059f0', 'supervisor');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e1111111-0000-0000-0000-0000000000f0', '23111111-0000-0000-0000-0000000000a1',
     '11111111-0000-0000-0000-000000000059', 'supervisor');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000059f0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Line 1 Cert',
       '23111111-0000-0000-0000-0000000000a1');
    v_own := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_own := SQLSTATE; END;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000059', 'Plant Wide Thing',
       '23111111-0000-0000-0000-0000000000a0');
    v_above := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_above := SQLSTATE; END;
  RESET ROLE;
  IF v_own = 'allowed' AND v_above = '42501' THEN RAISE NOTICE 'PASS V13';
  ELSE RAISE NOTICE 'FAIL V13: own line=% plant above=% (want allowed / 42501)', v_own, v_above; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V13: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V13;

\echo 'V14 ⚠️: and they can still READ the plant-owned training they cannot edit'
SAVEPOINT sp_V14;
DO $$
DECLARE v_seen int; v_edited text := 'none';
BEGIN
  -- ⚠️⚠️ THE CONSEQUENCE FOR THE SCREEN, AND IT IS WHY THIS CASE EXISTS.
  -- Read-scoping (0026) lets somebody see a row whose owner sits ABOVE their
  -- grant, so a line supervisor's Trainings tab will list the plant's trainings.
  -- They cannot edit them. **The tab has no permission preview**, so today it
  -- offers Rename and Retire on rows the server will refuse -- the exact shape
  -- 19.77 is about, arriving from the other direction. Recorded here so the
  -- gap is a known debt with a case behind it rather than a surprise.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-000000005a10');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e1111111-0000-0000-0000-000000000a10', '11111111-0000-0000-0000-000000000059',
     '00000000-0000-0000-0000-000000005a10', 'supervisor');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e1111111-0000-0000-0000-000000000a10', '23111111-0000-0000-0000-0000000000a1',
     '11111111-0000-0000-0000-000000000059', 'supervisor');
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('24111111-0000-0000-0000-0000000000c0', '11111111-0000-0000-0000-000000000059',
     'Plant Welding', '23111111-0000-0000-0000-0000000000a0');

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000005a10', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM skills WHERE id = '24111111-0000-0000-0000-0000000000c0';
  BEGIN
    UPDATE skills SET name = 'Renamed By Line Supervisor'
     WHERE id = '24111111-0000-0000-0000-0000000000c0';
    GET DIAGNOSTICS v_edited = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_edited := SQLSTATE; END;
  RESET ROLE;
  -- ⚠️ An RLS-refused UPDATE removes zero rows and raises NOTHING (19.63), so
  -- "no error" is not "it happened" -- the row count is the answer.
  IF v_seen = 1 AND v_edited = '0' THEN RAISE NOTICE 'PASS V14';
  ELSE RAISE NOTICE 'FAIL V14: seen=% (want 1) edited=% (want 0 rows)', v_seen, v_edited; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL V14: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_V14;

ROLLBACK;
