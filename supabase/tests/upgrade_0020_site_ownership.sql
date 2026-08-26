-- ============================================================================
-- upgrade_0020_site_ownership.sql — 0020's backfill, on the path that actually
-- runs it.
--
-- WHY THIS IS NOT IN THE NUMBERED SUITE, and why the answer is sharper here
-- than it was for 0019. `verify-db.sh` (and `db:reset`) apply every migration
-- to an EMPTY schema and only then run the seed — so at backfill time there are
-- no nodes, nothing is claimed, and the statement is a no-op. **That is not a
-- hypothetical: it is what happened.** The first run of 0020 left every
-- template unowned and no site admin could have edited their own level names,
-- and the numbered suite was entirely green while it did.
--
-- Ownership on a fresh database is therefore established by the SEED (which now
-- asserts that zero templates are left unowned) and by `create_node`. The
-- migration's backfill exists for ONE path only — an existing, populated
-- database being upgraded — and this file is the only thing that exercises it.
--
-- Run against a database at migration 0019 with NO seed. The file applies 0020
-- itself; see verify-db.sh step 5c.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- ----------------------------------------------------------------------------
-- Two templates, deliberately different cases.
--   Solo   — used by exactly one root. MUST be claimed.
--   Shared — used by TWO roots. MUST be left unowned, not arbitrarily given to
--            one of them, because assigning it would silently make one site's
--            admin the landlord of another site's structure.
-- ----------------------------------------------------------------------------
INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000002', 'Ownership Co');

INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('22222222-0000-0000-0000-000000000010', '11111111-0000-0000-0000-000000000002', 'Solo'),
  ('22222222-0000-0000-0000-000000000011', '11111111-0000-0000-0000-000000000002', 'Shared');

INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('33333333-0000-0000-0000-000000000010', '11111111-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000010', 0, 'Site', false),
  ('33333333-0000-0000-0000-000000000011', '11111111-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000010', 1, 'Cell', true),
  ('33333333-0000-0000-0000-000000000012', '11111111-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000011', 0, 'Site', false),
  ('33333333-0000-0000-0000-000000000013', '11111111-0000-0000-0000-000000000002',
   '22222222-0000-0000-0000-000000000011', 1, 'Cell', true);

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('44444444-0000-0000-0000-000000000010', '11111111-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000010', NULL, 'Solo Plant'),
  ('44444444-0000-0000-0000-000000000011', '11111111-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000012', NULL, 'Shared Plant A'),
  ('44444444-0000-0000-0000-000000000012', '11111111-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000012', NULL, 'Shared Plant B');

-- Assert the fixture BEFORE upgrading. The whole file is about a column that
-- does not exist yet, so proving we are really at 0019 is not ceremony.
DO $$
DECLARE v_has_col int; v_solo_roots int; v_shared_roots int;
BEGIN
  SELECT count(*) INTO v_has_col FROM pg_attribute
   WHERE attrelid = 'public.hierarchy_templates'::regclass
     AND attname = 'site_node_id' AND NOT attisdropped;
  SELECT count(*) INTO v_solo_roots FROM nodes n
    JOIN hierarchy_levels l ON l.id = n.level_id
   WHERE l.template_id = '22222222-0000-0000-0000-000000000010' AND n.parent_id IS NULL;
  SELECT count(*) INTO v_shared_roots FROM nodes n
    JOIN hierarchy_levels l ON l.id = n.level_id
   WHERE l.template_id = '22222222-0000-0000-0000-000000000011' AND n.parent_id IS NULL;
  IF v_has_col = 0 AND v_solo_roots = 1 AND v_shared_roots = 2 THEN RAISE NOTICE 'PASS V0';
  ELSE RAISE NOTICE 'FAIL V0: site_node_id_cols=%, solo_roots=%, shared_roots=% -- not a 0019 database with the intended fixture',
        v_has_col, v_solo_roots, v_shared_roots; END IF;
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
\i :mig
-- ----------------------------------------------------------------------------

DO $$
DECLARE v_owner uuid;
BEGIN
  SELECT site_node_id INTO v_owner FROM hierarchy_templates
   WHERE id = '22222222-0000-0000-0000-000000000010';
  IF v_owner = '44444444-0000-0000-0000-000000000010' THEN RAISE NOTICE 'PASS V1';
  ELSE RAISE NOTICE 'FAIL V1: the solo template was claimed by %, expected Solo Plant', v_owner; END IF;
END $$;

DO $$
DECLARE v_owner uuid;
BEGIN
  SELECT site_node_id INTO v_owner FROM hierarchy_templates
   WHERE id = '22222222-0000-0000-0000-000000000011';
  IF v_owner IS NULL THEN RAISE NOTICE 'PASS V2';
  ELSE RAISE NOTICE 'FAIL V2: a template shared by two roots was handed to % -- one site''s admin now owns another site''s structure', v_owner; END IF;
END $$;

-- The uniqueness guarantee the model rests on: no site owns two structures.
DO $$
DECLARE v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT site_node_id FROM hierarchy_templates
     WHERE site_node_id IS NOT NULL GROUP BY site_node_id HAVING count(*) > 1) d;
  IF v_dupes = 0 THEN RAISE NOTICE 'PASS V3';
  ELSE RAISE NOTICE 'FAIL V3: % site(s) own more than one structure', v_dupes; END IF;
END $$;

-- A structure may only be owned by a ROOT. A Work Cell claiming one would
-- quietly widen that cell's admin to the whole plant's vocabulary.
DO $$
DECLARE v_child uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('11111111-0000-0000-0000-000000000002',
            '33333333-0000-0000-0000-000000000011',
            '44444444-0000-0000-0000-000000000010', 'A Cell')
    RETURNING id INTO v_child;
  BEGIN
    UPDATE hierarchy_templates SET site_node_id = v_child
     WHERE id = '22222222-0000-0000-0000-000000000011';
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF v_caught AND v_detail->>'error' = 'invalid_argument' THEN RAISE NOTICE 'PASS V4';
  ELSE RAISE NOTICE 'FAIL V4: caught=%, detail=% -- a non-root claimed a structure', v_caught, v_detail; END IF;
END $$;

\echo 'upgrade_0020_site_ownership.sql: all 5 cases executed (V0-V4)'
