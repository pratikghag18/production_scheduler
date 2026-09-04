-- ============================================================================
-- upgrade_0029_delete_keeps_the_past.sql — 0029 on a database that already has
-- rows in it.
--
-- ⭐ WHY THIS FILE EXISTS. 0029 writes no data, so it is tempting to call it a
-- pure schema migration and skip the upgrade check. It is not one. It does
-- four things that are invisible on the fresh path and decided entirely by
-- rows that already exist:
--
--   * `ADD COLUMN active boolean NOT NULL DEFAULT true` on two populated
--     tables — every existing training and pattern has to come out ACTIVE.
--     Coming out inactive would retire a whole org's shift patterns overnight
--     and nothing on the fresh path could ever show it, because on the fresh
--     path the tables are empty when the column is added.
--
--   * `ADD CONSTRAINT ... CHECK` on two populated tables. `ALTER TABLE` scans
--     every row, so a check that is subtly wrong about what a legacy row looks
--     like does not fail a test — it fails the customer's migration.
--
--   * `DROP CONSTRAINT assignments_check` BY ITS AUTO-GENERATED NAME. A name
--     PostgreSQL chose is a name that can differ; if it ever does, the
--     migration dies at that line on a real tenant and nowhere else.
--
--   * four foreign keys re-created with `ON DELETE CASCADE`. The whole point
--     is what happens to rows that were written before the cascade existed,
--     which is the one thing a fresh database has none of.
--
-- Run against a database at migration 0028 with NO seed. The file applies 0029
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- A small org at 0028: one plant, one cell, and one of every row 0029 touches.
INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000029', 'Upgrade Org 0029');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029', 'U29 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   '21111111-0000-0000-0000-000000000029', 0, 'Plant', false),
  ('22111111-0000-0000-0000-00000000002a', '11111111-0000-0000-0000-000000000029',
   '21111111-0000-0000-0000-000000000029', 1, 'Cell', true);
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   '22111111-0000-0000-0000-000000000029', NULL, 'U29 Plant');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-00000000002a', '11111111-0000-0000-0000-000000000029',
   '22111111-0000-0000-0000-00000000002a', '23111111-0000-0000-0000-000000000029', 'U29 Cell');

INSERT INTO products (id, org_id, sku, name, site_node_id) VALUES
  ('26111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   'U29', 'U29 Product', '23111111-0000-0000-0000-000000000029');
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('25111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   'U29 Operator', '23111111-0000-0000-0000-000000000029');
INSERT INTO skills (id, org_id, name, site_node_id) VALUES
  ('24111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   'U29 Training', '23111111-0000-0000-0000-000000000029');
INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
  ('27111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   'U29 Pattern', '23111111-0000-0000-0000-000000000029');

-- The join rows the cascades are about, written BEFORE the cascades existed.
INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
  ('25111111-0000-0000-0000-000000000029', '24111111-0000-0000-0000-000000000029',
   '11111111-0000-0000-0000-000000000029');
INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
  ('23111111-0000-0000-0000-00000000002a', '24111111-0000-0000-0000-000000000029',
   '11111111-0000-0000-0000-000000000029');
INSERT INTO node_shift_templates (node_id, org_id, template_id) VALUES
  ('23111111-0000-0000-0000-00000000002a', '11111111-0000-0000-0000-000000000029',
   '27111111-0000-0000-0000-000000000029');

-- A run and both assignment shapes, so the two new CHECKs meet legacy rows of
-- every legal form. `2020` is deliberately in the past: this file is not about
-- the clock, but a row on the started side is the one a bad check would eat.
INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
  ('28111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   '23111111-0000-0000-0000-00000000002a', '26111111-0000-0000-0000-000000000029',
   tstzrange('2020-04-01 06:00+00','2020-04-01 14:00+00'), 1);
INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
  ('29111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   '23111111-0000-0000-0000-00000000002a', '25111111-0000-0000-0000-000000000029',
   '28111111-0000-0000-0000-000000000029', NULL,
   tstzrange('2020-04-01 06:00+00','2020-04-01 14:00+00'), 0.500),
  ('29111111-0000-0000-0000-00000000002a', '11111111-0000-0000-0000-000000000029',
   '23111111-0000-0000-0000-00000000002a', '25111111-0000-0000-0000-000000000029', NULL,
   '26111111-0000-0000-0000-000000000029',
   tstzrange('2020-04-02 06:00+00','2020-04-02 14:00+00'), 0.500);

-- A company admin for this org: `delete_owned_row` is SECURITY INVOKER and
-- asks who the caller is, so U29-5 cannot be run as the superuser — with no
-- JWT claim there is no current org and the answer is `not_permitted`, which
-- would look exactly like the migration being broken.
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-00000000ee29');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e9111111-0000-0000-0000-000000000029', '11111111-0000-0000-0000-000000000029',
   '00000000-0000-0000-0000-00000000ee29', 'admin');

\echo 'U29-0: we really are at 0028 — runs.product_id is NOT NULL and skills has no `active` column'
DO $$
DECLARE v_nullable text; v_active int;
BEGIN
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema='public' AND table_name='runs' AND column_name='product_id';
  SELECT count(*) INTO v_active FROM information_schema.columns
   WHERE table_schema='public' AND table_name IN ('skills','shift_templates') AND column_name='active';
  IF v_nullable = 'NO' AND v_active = 0 THEN RAISE NOTICE 'PASS U29-0';
  ELSE RAISE NOTICE 'FAIL U29-0: product_id nullable=% (want NO), active columns=% (want 0) — this file is not running against 0028', v_nullable, v_active; END IF;
END $$;

\i :mig

\echo 'U29-1 ⭐: every training and pattern that already existed comes out ACTIVE'
DO $$
DECLARE v_s int; v_t int;
BEGIN
  SELECT count(*) INTO v_s FROM skills          WHERE active IS NOT TRUE;
  SELECT count(*) INTO v_t FROM shift_templates WHERE active IS NOT TRUE;
  IF v_s = 0 AND v_t = 0 THEN RAISE NOTICE 'PASS U29-1';
  ELSE RAISE NOTICE 'FAIL U29-1: % trainings and % patterns came out inactive — an upgrade must not retire anything', v_s, v_t; END IF;
END $$;

\echo 'U29-2: nothing was lost or rewritten — the run still names its product by id, and its snapshot is empty'
DO $$
DECLARE r record; v_asg int;
BEGIN
  SELECT product_id, product_sku, product_name, product_color_token INTO r
    FROM runs WHERE id = '28111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_asg FROM assignments
   WHERE id IN ('29111111-0000-0000-0000-000000000029','29111111-0000-0000-0000-00000000002a')
     AND operator_id IS NOT NULL AND operator_display_name IS NULL;
  IF r.product_id = '26111111-0000-0000-0000-000000000029'
     AND r.product_sku IS NULL AND r.product_name IS NULL AND r.product_color_token IS NULL
     AND v_asg = 2
  THEN RAISE NOTICE 'PASS U29-2';
  ELSE RAISE NOTICE 'FAIL U29-2: run product_id=% sku=% ; assignments with a live operator and no snapshot=% (want 2)',
    r.product_id, r.product_sku, v_asg; END IF;
END $$;

\echo 'U29-3 ⭐: the three new CHECKs were VALIDATED against the rows that were already there, not merely declared'
DO $$
DECLARE v_n int;
BEGIN
  -- NOT VALID is a legal thing to ask for and is exactly what a migration
  -- reaches for when its own check is wrong. Asserting `convalidated` is the
  -- difference between "the constraint exists" and "every legacy row passes
  -- it", which is the only claim worth making here.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname IN ('runs_product_identified','assignments_work_identified','assignments_operator_identified')
     AND contype = 'c' AND convalidated;
  IF v_n = 3 THEN RAISE NOTICE 'PASS U29-3';
  ELSE RAISE NOTICE 'FAIL U29-3: % of 3 checks present and validated', v_n; END IF;
END $$;

\echo 'U29-4 ⭐⭐: the cascades reach rows written before the cascades existed'
DO $$
DECLARE v_hold int; v_req int; v_att int; v_shifts int;
BEGIN
  DELETE FROM skills WHERE id = '24111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_hold FROM operator_skills WHERE skill_id = '24111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_req  FROM node_skill_requirements WHERE skill_id = '24111111-0000-0000-0000-000000000029';
  DELETE FROM shift_templates WHERE id = '27111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_att  FROM node_shift_templates WHERE template_id = '27111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_shifts FROM shifts WHERE template_id = '27111111-0000-0000-0000-000000000029';
  IF v_hold = 0 AND v_req = 0 AND v_att = 0 AND v_shifts = 0 THEN RAISE NOTICE 'PASS U29-4';
  ELSE RAISE NOTICE 'FAIL U29-4: holdings=% requirements=% attachments=% shifts=% (want 0 all) — a legacy join row blocked its parent', v_hold, v_req, v_att, v_shifts; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U29-4: deleting a legacy owner raised % (%) — the cascade did not take', SQLERRM, SQLSTATE;
END $$;

\echo 'U29-5 ⭐⭐: an upgraded database can actually do the thing the migration is for'
DO $$
DECLARE v_run record; v_prod int;
BEGIN
  -- The whole migration, exercised end to end on rows that predate it: the
  -- 2020 run has started, so it must survive with the product's identity
  -- copied onto it, and the direct assignment beside it too. Nothing else in
  -- this file would notice if `delete_owned_row` could not run at all here.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ee29', true);
  SET LOCAL ROLE authenticated;
  PERFORM delete_owned_row('product','26111111-0000-0000-0000-000000000029');
  RESET ROLE;
  SELECT product_id, product_sku, product_name INTO v_run
    FROM runs WHERE id = '28111111-0000-0000-0000-000000000029';
  SELECT count(*) INTO v_prod FROM products WHERE id = '26111111-0000-0000-0000-000000000029';
  IF v_prod = 0 AND v_run.product_id IS NULL AND v_run.product_sku = 'U29'
     AND v_run.product_name = 'U29 Product'
  THEN RAISE NOTICE 'PASS U29-5';
  ELSE RAISE NOTICE 'FAIL U29-5: products left=% run product_id=% sku=% name=%', v_prod, v_run.product_id, v_run.product_sku, v_run.product_name; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL U29-5: % (%)', SQLERRM, SQLSTATE;
END $$;

ROLLBACK;
