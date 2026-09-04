-- ============================================================================
-- upgrade_0032_training_record.sql — 0032 against a database that already has
-- people holding trainings.
--
-- ⭐ THREE THINGS HERE CAN ONLY FAIL ON A POPULATED DATABASE, and the fresh
-- path cannot show any of them:
--
--   * `ADD COLUMN source text NOT NULL DEFAULT 'manual'` on a populated
--     `skills`. Every training that already exists must come out `'manual'` —
--     an existing row claiming to have come from a CSV would be a lie about
--     provenance, and the fresh path adds the column to an empty table.
--
--   * ⭐⭐ THE POLICY SWAP IS A WIDENING AND MUST TAKE NOTHING AWAY. 0032 drops
--     six policies and recreates them. A site admin who could keep the training
--     record before must still be able to afterwards; U32-3 is that case, and
--     it is the one a "supervisors can now write" change is most likely to
--     break while looking correct.
--
--   * `DROP FUNCTION`-adjacent risk: `app_can_edit_operator` is CREATE OR
--     REPLACE, so it carries no grant of its own until this migration issues
--     one. On the fresh path the suite runs as the owner, who needs no grant —
--     so a forgotten GRANT passes every numbered test and refuses every real
--     user. U32-4 is that case, and it is 0030's lesson repeated.
--
-- Run against a database at migration 0031 with NO seed. The file applies 0032
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000032', 'Upgrade Org 0032');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032', 'U32 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032',
   '21111111-0000-0000-0000-000000000032', 0, 'Plant', true);
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032',
   '22111111-0000-0000-0000-000000000032', NULL, 'U32 Plant');

-- ⭐ CREATED BEFORE THE MIGRATION, so the column additions have real rows to
-- rewrite and the new NOT NULL default has something to default.
INSERT INTO skills (id, org_id, name, site_node_id) VALUES
  ('24111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032',
   'U32 Welding', '23111111-0000-0000-0000-000000000032');
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('25111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032',
   'U32 Operator', '23111111-0000-0000-0000-000000000032');
INSERT INTO operator_skills (org_id, operator_id, skill_id, expires_at) VALUES
  ('11111111-0000-0000-0000-000000000032', '25111111-0000-0000-0000-000000000032',
   '24111111-0000-0000-0000-000000000032', DATE '2027-01-01');

-- A SITE ADMIN who could keep this record before the migration.
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000032a0');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e1111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000032',
   '00000000-0000-0000-0000-0000000032a0', 'supervisor');
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('e1111111-0000-0000-0000-000000000032', '23111111-0000-0000-0000-000000000032',
   '11111111-0000-0000-0000-000000000032', 'admin');

-- ---------------------------------------------------------------------------
\echo 'U32-0: this file is running against 0031 — the new columns are not there yet'
DO $$
DECLARE v_cols int; v_fn int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'operator_skills' AND column_name = 'signed_off_by')
       OR (table_name = 'skills' AND column_name IN ('source','external_id')));
  SELECT count(*) INTO v_fn FROM pg_proc WHERE proname = 'app_can_edit_operator';
  IF v_cols = 0 AND v_fn = 0 THEN RAISE NOTICE 'PASS U32-0';
  ELSE RAISE NOTICE 'FAIL U32-0: columns=% (want 0), helper=% (want 0) — not running against 0031', v_cols, v_fn; END IF;
END $$;

-- ---------------------------------------------------------------------------
\i :mig
-- ---------------------------------------------------------------------------

\echo 'U32-1 ⭐: every training that already existed came out marked as entered by hand'
DO $$
DECLARE v_bad int; v_ext int;
BEGIN
  SELECT count(*) INTO v_bad FROM skills
   WHERE org_id = '11111111-0000-0000-0000-000000000032' AND source <> 'manual';
  SELECT count(*) INTO v_ext FROM skills
   WHERE org_id = '11111111-0000-0000-0000-000000000032' AND external_id IS NOT NULL;
  -- ⚠️ An existing row claiming a CSV provenance it never had would be a lie
  -- the import screen would then act on, and it cannot be told apart later.
  IF v_bad = 0 AND v_ext = 0 THEN RAISE NOTICE 'PASS U32-1';
  ELSE RAISE NOTICE 'FAIL U32-1: % rows not manual, % with an external id (want 0/0)', v_bad, v_ext; END IF;
END $$;

\echo 'U32-2: the held training survived, and its new sign-off is empty rather than invented'
DO $$
DECLARE v_signed text; v_when date; v_expires date;
BEGIN
  SELECT signed_off_by, certified_at, expires_at INTO v_signed, v_when, v_expires
    FROM operator_skills WHERE org_id = '11111111-0000-0000-0000-000000000032';
  IF v_signed IS NULL AND v_when IS NULL AND v_expires = DATE '2027-01-01'
    THEN RAISE NOTICE 'PASS U32-2';
  ELSE RAISE NOTICE 'FAIL U32-2: signed=% certified=% expires=% (want null/null/2027-01-01)',
    v_signed, v_when, v_expires; END IF;
END $$;

\echo 'U32-3 ⭐⭐: the widening took NOTHING away — a site admin can still keep the record'
DO $$
DECLARE v_skill text := 'none'; v_hold text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000032a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000032', 'U32 After',
       '23111111-0000-0000-0000-000000000032');
    v_skill := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_skill := SQLSTATE; END;
  BEGIN
    UPDATE operator_skills SET signed_off_by = 'D. Reyes'
     WHERE org_id = '11111111-0000-0000-0000-000000000032';
    v_hold := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_hold := SQLSTATE; END;
  RESET ROLE;
  -- ⚠️ Six policies were dropped and recreated. A swap that admits supervisors
  -- and quietly stops admitting admins would pass every "can a supervisor
  -- write" case in `59_` and break every existing user.
  IF v_skill = 'allowed' AND v_hold = 'allowed' THEN RAISE NOTICE 'PASS U32-3';
  ELSE RAISE NOTICE 'FAIL U32-3: skill=% holding=% (want allowed/allowed)', v_skill, v_hold; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL U32-3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;

\echo 'U32-4 ⭐⭐: the new helper is executable by real users, not just by the owner'
DO $$
DECLARE v_auth boolean; v_anon boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'app_can_edit_operator(uuid)', 'EXECUTE')
    INTO v_auth;
  SELECT has_function_privilege('anon', 'app_can_edit_operator(uuid)', 'EXECUTE')
    INTO v_anon;
  -- 0030's lesson: the suite runs as the owner, who needs no grant, so a
  -- forgotten GRANT is invisible to every numbered case and refuses every
  -- real user the moment they open the screen.
  IF v_auth AND NOT v_anon THEN RAISE NOTICE 'PASS U32-4';
  ELSE RAISE NOTICE 'FAIL U32-4: authenticated=% anon=% (want true/false)', v_auth, v_anon; END IF;
END $$;

\echo 'U32-5: the partial index exists and is the per-owner one'
DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'skills_owner_external_id_unique';
  IF v_def LIKE '%UNIQUE%' AND v_def LIKE '%org_id, site_node_id, external_id%'
     AND v_def LIKE '%external_id IS NOT NULL%'
    THEN RAISE NOTICE 'PASS U32-5';
  ELSE RAISE NOTICE 'FAIL U32-5: %', coalesce(v_def, '<missing>'); END IF;
END $$;

ROLLBACK;
