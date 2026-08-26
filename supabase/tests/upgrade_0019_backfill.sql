-- ============================================================================
-- upgrade_0019_backfill.sql — the ONE thing the ordinary suite structurally
-- cannot cover.
--
-- WHY IT LIVES OUTSIDE supabase/tests/[1-9]*.sql. `verify-db.sh` applies every
-- migration and THEN the seed, so by the time any numbered test runs, 0019's
-- backfill UPDATE has already executed against an EMPTY table. Every case in
-- 46_scoped_roles_test.sql could be green against a backfill that mapped every
-- row to 'viewer' and locked every existing grantee out of their own subtree
-- on the morning of the upgrade.
--
-- So verify-db.sh runs this file in its own database, built to 0018 and no
-- further, with a fixture in the OLD shape. It applies 0019 itself and then
-- asserts the translation, row by row. Mutation X8 -- backfilling can_edit=true
-- to 'admin' instead of 'supervisor', which would silently hand every existing
-- subtree grantee the power to restructure the hierarchy -- is caught by U2.
--
-- Run against a database at migration 0018 with NO seed. The file applies 0019
-- itself; see verify-db.sh step 5b.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- ----------------------------------------------------------------------------
-- The old world: three grants, one per branch of the backfill's CASE.
-- ----------------------------------------------------------------------------
INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Upgrade Co');

INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Default');

INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('33333333-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000001', 0, 'Site', false),
  ('33333333-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000001', 1, 'Cell', true);

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('44444444-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '33333333-0000-0000-0000-000000000001', NULL, 'Site A');

INSERT INTO auth.users (id) VALUES
  ('55555555-0000-0000-0000-000000000001'),
  ('55555555-0000-0000-0000-000000000002'),
  ('55555555-0000-0000-0000-000000000003');

INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('66666666-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000001', 'admin'),
  ('66666666-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000002', 'supervisor'),
  ('66666666-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001',
   '55555555-0000-0000-0000-000000000003', 'viewer');

-- one row per CASE branch: org-wide admin / can_edit true / can_edit false
INSERT INTO profile_grants (profile_id, node_id, org_id, can_edit) VALUES
  ('66666666-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', true),
  ('66666666-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', true),
  ('66666666-0000-0000-0000-000000000003', '44444444-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001', false);

-- assert the fixture BEFORE upgrading: three rows, in the old shape, or every
-- assertion below is about nothing.
DO $$
DECLARE v_rows int; v_has_can_edit int;
BEGIN
  SELECT count(*) INTO v_rows FROM profile_grants
   WHERE org_id = '11111111-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_has_can_edit FROM pg_attribute
   WHERE attrelid = 'public.profile_grants'::regclass AND attname = 'can_edit' AND NOT attisdropped;
  IF v_rows = 3 AND v_has_can_edit = 1 THEN RAISE NOTICE 'PASS U0';
  ELSE RAISE NOTICE 'FAIL U0: pre-upgrade rows=%, can_edit_column=% -- this database is not at 0018',
        v_rows, v_has_can_edit; END IF;
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
-- The upgrade itself.
-- ----------------------------------------------------------------------------
\i :mig

-- ----------------------------------------------------------------------------
-- The translation, one assertion per branch.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = '66666666-0000-0000-0000-000000000001';
  IF v_role = 'admin' THEN RAISE NOTICE 'PASS U1';
  ELSE RAISE NOTICE 'FAIL U1: org-wide admin''s grant became %, expected admin', v_role; END IF;
END $$;

DO $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = '66666666-0000-0000-0000-000000000002';
  IF v_role = 'supervisor' THEN RAISE NOTICE 'PASS U2';
  ELSE RAISE NOTICE 'FAIL U2: can_edit=true became %, expected supervisor -- '
                    '''admin'' here hands every existing grantee the hierarchy', v_role; END IF;
END $$;

DO $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = '66666666-0000-0000-0000-000000000003';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS U3';
  ELSE RAISE NOTICE 'FAIL U3: can_edit=false became %, expected viewer', v_role; END IF;
END $$;

-- No row may be left behind: NOT NULL would have failed the migration, but a
-- backfill whose join silently missed rows and then defaulted them is exactly
-- the failure this asserts against.
DO $$
DECLARE v_total int; v_distinct int;
BEGIN
  SELECT count(*), count(DISTINCT role) INTO v_total, v_distinct
    FROM profile_grants WHERE org_id = '11111111-0000-0000-0000-000000000001';
  IF v_total = 3 AND v_distinct = 3 THEN RAISE NOTICE 'PASS U4';
  ELSE RAISE NOTICE 'FAIL U4: rows=%, distinct roles=% -- expected 3 rows, 3 different roles',
        v_total, v_distinct; END IF;
END $$;

\echo 'upgrade_0019_backfill.sql: all 5 cases executed (U0-U4)'
