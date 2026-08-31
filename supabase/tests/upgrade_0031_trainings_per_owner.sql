-- ============================================================================
-- upgrade_0031_trainings_per_owner.sql — 0031 against a database that already
-- has trainings in it.
--
-- ⭐ WHY THIS FILE EXISTS, when 0031 writes no data at all and the new
-- constraint admits a strict SUPERSET of what the old one did.
--
-- Because "the argument is not the evidence" (rule 5b), and because the three
-- things that can actually go wrong here are invisible on the fresh path:
--
--   * `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` **builds an index over every
--     existing row**. On a fresh database `skills` is empty when the migration
--     runs, so the build cannot fail and cannot prove anything. U31-1 puts real
--     rows under it first.
--
--   * ⭐⭐ **DROPPING A UNIQUE CONSTRAINT DROPS ITS INDEX**, and any other
--     object that had quietly come to depend on it goes with it. `skills` is
--     referenced by two COMPOSITE foreign keys — `operator_skills` and
--     `node_skill_requirements` both point at `skills(org_id, id)` — and if
--     the wrong unique were dropped they would fail to re-validate. U31-5 pins
--     that the one they need is still there and still doing its job.
--
--   * The whole POINT of the migration is a thing that was refused before and
--     must be accepted after. A test that only inspects `pg_constraint` would
--     pass against a constraint that exists and guards the wrong columns.
--     U31-3 and U31-4 do it by INSERT, in both directions.
--
-- Run against a database at migration 0030 with NO seed. The file applies 0031
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000031', 'Upgrade Org 0031');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000031', 'U31 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000031',
   '21111111-0000-0000-0000-000000000031', 0, 'Plant', false),
  ('22111111-0000-0000-0000-000000000032', '11111111-0000-0000-0000-000000000031',
   '21111111-0000-0000-0000-000000000031', 1, 'Line', true);

-- TWO plants, which is the whole shape of the problem: a name Plant A used is
-- what Plant B could not have.
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-00000000003a', '11111111-0000-0000-0000-000000000031',
   '22111111-0000-0000-0000-000000000031', NULL, 'U31 Plant A'),
  ('23111111-0000-0000-0000-00000000003b', '11111111-0000-0000-0000-000000000031',
   '22111111-0000-0000-0000-000000000031', NULL, 'U31 Plant B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-00000000003c', '11111111-0000-0000-0000-000000000031',
   '22111111-0000-0000-0000-000000000032', '23111111-0000-0000-0000-00000000003a', 'U31 Line 1');

-- ⭐ CREATED BEFORE THE MIGRATION, so the new index has something real to be
-- built over. A held ticket hangs off it too (U31-5): the composite FK from
-- `operator_skills` is the object most at risk from dropping the wrong unique.
INSERT INTO skills (id, org_id, name, site_node_id) VALUES
  ('24111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000031',
   'TRN-4471', '23111111-0000-0000-0000-00000000003a');
INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('25111111-0000-0000-0000-000000000031', '11111111-0000-0000-0000-000000000031',
   'U31 Operator', '23111111-0000-0000-0000-00000000003a');
INSERT INTO operator_skills (org_id, operator_id, skill_id) VALUES
  ('11111111-0000-0000-0000-000000000031', '25111111-0000-0000-0000-000000000031',
   '24111111-0000-0000-0000-000000000031');

-- ---------------------------------------------------------------------------
\echo 'U31-0: this file is running against 0030 — the OLD rule is in force'
DO $$
DECLARE v_old int; v_new int; v_refused boolean := false;
BEGIN
  SELECT count(*) INTO v_old FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_org_id_name_key';
  SELECT count(*) INTO v_new FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_owner_name_unique';

  -- ⭐ AND THE OLD RULE IS DEMONSTRATED, NOT JUST COUNTED. This INSERT is the
  -- maintainer's exact complaint: Plant B cannot have a name Plant A used.
  -- If it ever stops being refused here, this file is not testing an upgrade.
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000031', 'TRN-4471',
       '23111111-0000-0000-0000-00000000003b');
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;

  IF v_old = 1 AND v_new = 0 AND v_refused THEN RAISE NOTICE 'PASS U31-0';
  ELSE RAISE NOTICE 'FAIL U31-0: old=% (want 1), new=% (want 0), second plant refused=% (want true) — this file is not running against 0030',
    v_old, v_new, v_refused; END IF;
END $$;

-- ---------------------------------------------------------------------------
\i :mig
-- ---------------------------------------------------------------------------

\echo 'U31-1: the trainings that were already there survived the index build'
DO $$
DECLARE v_n int; v_owner uuid;
BEGIN
  -- ⚠️ NOT `min(site_node_id)` — THERE IS NO `min(uuid)` IN POSTGRES, which
  -- this project has already written down once (postgres_gotchas 24) and which
  -- this file walked into anyway. Count and fetch separately.
  SELECT count(*) INTO v_n
    FROM skills WHERE org_id = '11111111-0000-0000-0000-000000000031';
  SELECT site_node_id INTO v_owner
    FROM skills WHERE org_id = '11111111-0000-0000-0000-000000000031'
    ORDER BY name LIMIT 1;
  IF v_n = 1 AND v_owner = '23111111-0000-0000-0000-00000000003a' THEN RAISE NOTICE 'PASS U31-1';
  ELSE RAISE NOTICE 'FAIL U31-1: % trainings survived (want 1), owner=% ', v_n, v_owner; END IF;
END $$;

\echo 'U31-2: the old company-wide rule is gone and the per-owner one is in force and VALIDATED'
DO $$
DECLARE v_old int; v_def text; v_validated boolean;
BEGIN
  SELECT count(*) INTO v_old FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_org_id_name_key';
  SELECT pg_get_constraintdef(oid), convalidated INTO v_def, v_validated
    FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_owner_name_unique';
  -- ⚠️ `convalidated` is asked for on purpose: NOT VALID is a legal thing for a
  -- migration to reach for, and a constraint that exists but was never checked
  -- against the existing rows is not the same promise.
  IF v_old = 0 AND v_def = 'UNIQUE (org_id, site_node_id, name)' AND v_validated
    THEN RAISE NOTICE 'PASS U31-2';
  ELSE RAISE NOTICE 'FAIL U31-2: old still present=%, def=%, validated=%', v_old, v_def, v_validated; END IF;
END $$;

\echo 'U31-3 ⭐⭐: the thing that was REFUSED before now works — two plants, one document number'
DO $$
DECLARE v_ok boolean := false;
BEGIN
  INSERT INTO skills (org_id, name, site_node_id) VALUES
    ('11111111-0000-0000-0000-000000000031', 'TRN-4471',
     '23111111-0000-0000-0000-00000000003b');
  v_ok := true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL U31-3: still refused after the upgrade — % (%)', SQLERRM, SQLSTATE;
END $$;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM skills
   WHERE org_id = '11111111-0000-0000-0000-000000000031' AND name = 'TRN-4471';
  IF v_n = 2 THEN RAISE NOTICE 'PASS U31-3';
  ELSE RAISE NOTICE 'FAIL U31-3: % rows named TRN-4471 (want 2, one per plant)', v_n; END IF;
END $$;

\echo 'U31-4: and the rule still bites where it should — one owner may not hold the same name twice'
DO $$
DECLARE v_refused boolean := false; v_state text;
BEGIN
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000031', 'TRN-4471',
       '23111111-0000-0000-0000-00000000003a');
  EXCEPTION WHEN unique_violation THEN v_refused := true; v_state := SQLSTATE;
  END;
  IF v_refused AND v_state = '23505' THEN RAISE NOTICE 'PASS U31-4';
  ELSE RAISE NOTICE 'FAIL U31-4: refused=% state=% (want true/23505) — the constraint is not guarding its own owner',
    v_refused, v_state; END IF;
END $$;

\echo 'U31-5 ⭐⭐: the composite unique the two foreign keys need is still there, and still enforced'
DO $$
DECLARE v_key int; v_fks int; v_blocked boolean := false;
BEGIN
  SELECT count(*) INTO v_key FROM pg_constraint
   WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_org_id_id_key';
  SELECT count(*) INTO v_fks FROM pg_constraint
   WHERE confrelid = 'public.skills'::regclass AND contype = 'f';
  -- Demonstrated, not counted: the held ticket inserted above must still be
  -- unable to name a training from another tenant.
  BEGIN
    INSERT INTO operator_skills (org_id, operator_id, skill_id) VALUES
      ('11111111-0000-0000-0000-000000000031', '25111111-0000-0000-0000-000000000031',
       '24111111-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN foreign_key_violation THEN v_blocked := true;
  END;
  IF v_key = 1 AND v_fks = 2 AND v_blocked THEN RAISE NOTICE 'PASS U31-5';
  ELSE RAISE NOTICE 'FAIL U31-5: (org_id,id) unique=% (want 1), fks=% (want 2), bad ref blocked=% (want true)',
    v_key, v_fks, v_blocked; END IF;
END $$;

\echo 'U31-6 ⚠️: site_node_id is still NOT NULL — a nullable owner silently un-guards these rows'
DO $$
DECLARE v_nullable text;
BEGIN
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'skills' AND column_name = 'site_node_id';
  -- ⭐ THIS IS NOT PARANOIA, IT IS THE CONSTRAINT'S PRECONDITION. A unique
  -- constraint skips any row with a NULL in it, so the day `site_node_id`
  -- becomes nullable again, two company-wide trainings could both be called
  -- "Forklift" and neither would collide — the rule would still exist, still
  -- look right in `pg_constraint`, and guard nothing at all.
  IF v_nullable = 'NO' THEN RAISE NOTICE 'PASS U31-6';
  ELSE RAISE NOTICE 'FAIL U31-6: skills.site_node_id is_nullable=% (want NO) — skills_owner_name_unique no longer covers unowned rows', v_nullable; END IF;
END $$;

ROLLBACK;
