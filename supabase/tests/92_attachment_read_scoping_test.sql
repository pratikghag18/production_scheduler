-- ============================================================================
-- 92_attachment_read_scoping_test.sql --- migration 0028 §7 (R-266).
--
-- THE REQUIREMENT UNDER TEST, in one sentence: node_skill_requirements and
-- node_shift_templates are readable only for nodes the reader can read, so a
-- Plant 2 supervisor cannot list which trainings Plant 1's cells require or
-- which pattern each runs.
--
-- Distinct from check_eligibility's own scoping (53_read_scoping_test.sql
-- R12/R13), which asks a different question (is this person eligible here)
-- through a SECURITY DEFINER function -- this file asks whether a caller can
-- SELECT the attachment rows directly, as themselves, under RLS alone.
--
-- FIXTURE, same shape and same reasons as 53_read_scoping_test.sql: every
-- site admin below holds the org-wide role 'viewer' (an org-wide 'admin'
-- would short-circuit app_is_admin() and pass against a migration that did
-- nothing), and the row under test is attached to a node under Plant 1's
-- CNC Line (30000000-0000-0000-0000-000000000006), which the seed already
-- populates with one node_skill_requirements row and one node_shift_templates
-- row.
--   g1  admin grant on Plant 1 root (30000000-...-000001)
--   g2  admin grant on a freshly created Plant 2 root
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE rt_fix (k text primary key, v uuid);

\echo 'fixture: a second plant, and two viewer-base people with plant-root admin grants'
DO $$
DECLARE v_p2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2 := (create_node(NULL, 'Plant 2 (RT)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  RESET ROLE;
  INSERT INTO rt_fix (k, v) VALUES ('p2', v_p2);

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000e1'),
    ('00000000-0000-0000-0000-0000000000e2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e1', 'viewer'),
    ('e0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001', 'admin'),
    ('e0000000-0000-0000-0000-000000000002', v_p2,
     '10000000-0000-0000-0000-000000000001', 'admin');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

\echo 'RT1: Plant 1''s admin sees the CNC Line''s skill requirement row (it is theirs to read)'
SAVEPOINT sp_RT1;
DO $$
DECLARE v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000006';
  RESET ROLE;
  IF v_count = 1 THEN RAISE NOTICE 'PASS RT1';
  ELSE RAISE NOTICE 'FAIL RT1: count=% (want 1)', v_count; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RT1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RT1;

\echo 'RT2 ⭐: Plant 2''s admin gets ZERO skill-requirement rows for Plant 1''s CNC Line -- the headline'
SAVEPOINT sp_RT2;
DO $$
DECLARE v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000006';
  RESET ROLE;
  IF v_count = 0 THEN RAISE NOTICE 'PASS RT2';
  ELSE RAISE NOTICE 'FAIL RT2: count=% (want 0 -- Plant 2 admin read Plant 1''s row)', v_count; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RT2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RT2;

\echo 'RT3: Plant 1''s admin sees the CNC Line''s shift-template row'
SAVEPOINT sp_RT3;
DO $$
DECLARE v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM node_shift_templates
   WHERE node_id = '30000000-0000-0000-0000-000000000006';
  RESET ROLE;
  IF v_count = 1 THEN RAISE NOTICE 'PASS RT3';
  ELSE RAISE NOTICE 'FAIL RT3: count=% (want 1)', v_count; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RT3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RT3;

\echo 'RT4 ⭐: Plant 2''s admin gets ZERO shift-template rows for Plant 1''s CNC Line'
SAVEPOINT sp_RT4;
DO $$
DECLARE v_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_count FROM node_shift_templates
   WHERE node_id = '30000000-0000-0000-0000-000000000006';
  RESET ROLE;
  IF v_count = 0 THEN RAISE NOTICE 'PASS RT4';
  ELSE RAISE NOTICE 'FAIL RT4: count=% (want 0 -- Plant 2 admin read Plant 1''s row)', v_count; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RT4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RT4;

\echo 'RT5: Plant 2''s admin CAN read their own plant''s attachment rows -- the refusal is scoped, not global'
SAVEPOINT sp_RT5;
DO $$
DECLARE v_p2 uuid; v_line uuid; v_skill_count int; v_tmpl_count int; v_skill uuid; v_tmpl uuid;
BEGIN
  SELECT v INTO v_p2 FROM rt_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_line := (create_node(v_p2, 'RT Line', 0)->>'id')::uuid;
  -- Owned AT v_p2 itself so the structure-containment guard on the attachment
  -- accepts it -- reusing Plant 1's skill/template (owned elsewhere) is
  -- exactly the cross-plant case this migration exists to refuse, and would
  -- fail here for the RIGHT reason but the wrong test.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('e0000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-000000000001', 'RT Skill', v_p2)
    RETURNING id INTO v_skill;
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('e0000000-0000-0000-0000-0000000000f2', '10000000-0000-0000-0000-000000000001', 'RT Template', v_p2)
    RETURNING id INTO v_tmpl;
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    (v_line, v_skill, '10000000-0000-0000-0000-000000000001');
  INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
    (v_line, '10000000-0000-0000-0000-000000000001', v_tmpl);
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_skill_count FROM node_skill_requirements WHERE node_id = v_line;
  SELECT count(*) INTO v_tmpl_count FROM node_shift_templates WHERE node_id = v_line;
  RESET ROLE;

  IF v_skill_count = 1 AND v_tmpl_count = 1 THEN RAISE NOTICE 'PASS RT5';
  ELSE RAISE NOTICE 'FAIL RT5: skill_count=% tmpl_count=% (want 1, 1)', v_skill_count, v_tmpl_count; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RT5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RT5;

ROLLBACK;

\echo '92_attachment_read_scoping_test.sql complete (RT1-RT5)'
