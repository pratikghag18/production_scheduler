-- ============================================================================
-- upgrade_0030_area_override.sql — 0030 against a database that already has
-- assignments in it.
--
-- ⭐ WHY THIS FILE EXISTS. 0030 writes no data either, and 0029's upgrade file
-- already argued that "writes no data" is not a reason to skip the check. This
-- one adds three more reasons of its own:
--
--   * `ADD COLUMN area_override boolean NOT NULL DEFAULT false` on a populated
--     table. Every assignment that already exists must come out NOT overridden.
--     Coming out `true` would retroactively claim that every shift ever
--     scheduled had a rule waved through for it, and the fresh path cannot show
--     it because the table is empty when the column is added.
--
--   * `ADD CONSTRAINT ... CHECK (area_override = (area_override_reason IS NOT
--     NULL))` scans every existing row.
--
--   * ⭐⭐ `DROP FUNCTION` TAKES ITS GRANTS WITH IT (gotcha 2), and 0030 drops
--     and re-creates `create_assignment` and `move_run`. On the fresh path the
--     suite's own fixtures run as the table owner, who needs no grant — so a
--     forgotten regrant passes every numbered test and breaks every real user
--     the moment they schedule anything. U30-3 is that case.
--
-- Run against a database at migration 0029 with NO seed. The file applies 0030
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000030', 'Upgrade Org 0030');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030', 'U30 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   '21111111-0000-0000-0000-000000000030', 0, 'Plant', false),
  ('22111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000030',
   '21111111-0000-0000-0000-000000000030', 1, 'Line', false),
  ('22111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000030',
   '21111111-0000-0000-0000-000000000030', 2, 'Cell', true);
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   '22111111-0000-0000-0000-000000000030', NULL, 'U30 Plant');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000030',
   '22111111-0000-0000-0000-000000000031', '23111111-0000-0000-0000-000000000030', 'U30 Line A'),
  ('23111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000030',
   '22111111-0000-0000-0000-000000000031', '23111111-0000-0000-0000-000000000030', 'U30 Line B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-000000000033', '11111111-0000-0000-0000-000000000030',
   '22111111-0000-0000-0000-000000000032', '23111111-0000-0000-0000-000000000031', 'U30 Cell A'),
  ('23111111-0000-0000-0000-000000000034', '11111111-0000-0000-0000-000000000030',
   '22111111-0000-0000-0000-000000000032', '23111111-0000-0000-0000-000000000032', 'U30 Cell B');

INSERT INTO products (id, org_id, sku, name, site_node_id) VALUES
  ('26111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   'U30', 'U30 Product', '23111111-0000-0000-0000-000000000030');
-- Owned by LINE A, so Cell B is outside their area and the override has
-- something real to be about after the upgrade (U30-4).
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('25111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   'U30 Operator', '23111111-0000-0000-0000-000000000031');

INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
  ('28111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   '23111111-0000-0000-0000-000000000033', '26111111-0000-0000-0000-000000000030',
   tstzrange('2020-05-01 06:00+00','2020-05-01 14:00+00'), 1);
INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
  ('29111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   '23111111-0000-0000-0000-000000000033', '25111111-0000-0000-0000-000000000030',
   '28111111-0000-0000-0000-000000000030', NULL,
   tstzrange('2020-05-01 06:00+00','2020-05-01 14:00+00'), 0.500);

-- A company admin, because U30-4 calls a SECURITY INVOKER RPC and there is no
-- current org without a session.
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-00000000ee30');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e9111111-0000-0000-0000-000000000030', '11111111-0000-0000-0000-000000000030',
   '00000000-0000-0000-0000-00000000ee30', 'admin');

\echo 'U30-0: we really are at 0029 — no area_override column, and create_assignment takes ten arguments'
DO $$
DECLARE v_col int; v_args int;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='assignments' AND column_name LIKE 'area_override%';
  SELECT pronargs INTO v_args FROM pg_proc WHERE proname = 'create_assignment';
  IF v_col = 0 AND v_args = 10 THEN RAISE NOTICE 'PASS U30-0';
  ELSE RAISE NOTICE 'FAIL U30-0: area columns=% (want 0), create_assignment arity=% (want 10) — this file is not running against 0029', v_col, v_args; END IF;
END $$;

\i :mig

\echo 'U30-1 ⭐: every assignment that already existed comes out NOT overridden'
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM assignments WHERE area_override OR area_override_reason IS NOT NULL;
  IF v_n = 0 THEN RAISE NOTICE 'PASS U30-1';
  ELSE RAISE NOTICE 'FAIL U30-1: % legacy assignments came out claiming an override nobody made', v_n; END IF;
END $$;

\echo 'U30-2: the new CHECK was VALIDATED against the rows that were already there, not merely declared'
DO $$
DECLARE v_ok boolean;
BEGIN
  -- NOT VALID is a legal thing to ask for and exactly what a migration reaches
  -- for when its own check is wrong. `convalidated` is the difference between
  -- "the constraint exists" and "every legacy row passes it".
  SELECT convalidated INTO v_ok FROM pg_constraint
   WHERE conname = 'assignments_area_override_reasoned' AND contype = 'c';
  IF v_ok THEN RAISE NOTICE 'PASS U30-2';
  ELSE RAISE NOTICE 'FAIL U30-2: constraint present-and-validated = %', v_ok; END IF;
END $$;

\echo 'U30-3 ⭐⭐: the two re-created functions kept their grants — DROP FUNCTION takes them and the suite runs as the owner, who would never notice'
DO $$
DECLARE v_ca boolean; v_mr boolean; v_ca_anon boolean; v_mr_anon boolean;
BEGIN
  SELECT has_function_privilege('authenticated',
    'create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)','EXECUTE') INTO v_ca;
  SELECT has_function_privilege('authenticated','move_run(uuid,uuid,tstzrange,boolean,text)','EXECUTE') INTO v_mr;
  SELECT has_function_privilege('anon',
    'create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)','EXECUTE') INTO v_ca_anon;
  SELECT has_function_privilege('anon','move_run(uuid,uuid,tstzrange,boolean,text)','EXECUTE') INTO v_mr_anon;
  IF v_ca AND v_mr AND NOT v_ca_anon AND NOT v_mr_anon THEN RAISE NOTICE 'PASS U30-3';
  ELSE RAISE NOTICE 'FAIL U30-3: authenticated ca=% mr=%, anon ca=% mr=% (want true/true/false/false)',
    v_ca, v_mr, v_ca_anon, v_mr_anon; END IF;
END $$;

\echo 'U30-4 ⭐⭐: an upgraded database can actually do the thing the migration is for'
DO $$
DECLARE v_state text := 'none'; v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ee30', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- The operator belongs to Line A; Cell B is under Line B. Refused before
    -- 0030, allowed with a reason after it.
    v_res := create_assignment('23111111-0000-0000-0000-000000000034',
      '25111111-0000-0000-0000-000000000030', NULL, '26111111-0000-0000-0000-000000000030',
      tstzrange('2099-05-01 06:00+00','2099-05-01 14:00+00'),
      1.000, NULL, NULL, false, NULL, true, 'covering Line B tonight');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'allowed' AND (v_res->'assignment'->>'area_override')::boolean
     AND v_res->'assignment'->>'area_override_reason' = 'covering Line B tonight'
  THEN RAISE NOTICE 'PASS U30-4';
  ELSE RAISE NOTICE 'FAIL U30-4: state=% row=%', v_state, v_res->'assignment'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL U30-4: % (%)', SQLERRM, SQLSTATE;
END $$;

\echo 'U30-5: and a legacy row still moves normally — the upgrade did not make ordinary scheduling need a reason'
DO $$
DECLARE v_state text := 'none'; v_flag boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ee30', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- Cell A is inside Line A, so nothing is overridden and nothing should be
    -- claimed. This is the regression a too-eager guard would cause.
    PERFORM create_assignment('23111111-0000-0000-0000-000000000033',
      '25111111-0000-0000-0000-000000000030', NULL, '26111111-0000-0000-0000-000000000030',
      tstzrange('2099-05-02 06:00+00','2099-05-02 14:00+00'));
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT area_override INTO v_flag FROM assignments
   WHERE timerange = tstzrange('2099-05-02 06:00+00','2099-05-02 14:00+00');
  IF v_state = 'allowed' AND v_flag IS FALSE THEN RAISE NOTICE 'PASS U30-5';
  ELSE RAISE NOTICE 'FAIL U30-5: state=% flag=%', v_state, v_flag; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL U30-5: % (%)', SQLERRM, SQLSTATE;
END $$;

ROLLBACK;
