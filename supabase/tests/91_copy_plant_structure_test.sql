-- ============================================================================
-- 91_copy_plant_structure_test.sql --- migration 0035 (R-293).
--
-- THE REQUIREMENT UNDER TEST, in one sentence: `copy_plant_structure(source,
-- name)` creates a new plant as a copy of an existing plant's node tree ---
-- structure only, empty of parts and people --- in one atomic call that
-- loops over `create_node`, so the copy is permission-checked as the caller
-- (company-admin only, the same rule a root create already enforces) and
-- parents are always created before their children.
--
-- Same conventions as 88_absences_test.sql / 90_hierarchy_template_test.sql:
-- each case is its own SAVEPOINT + DO block with an outer `EXCEPTION WHEN
-- OTHERS` that turns any unexpected error into `RAISE NOTICE 'FAIL ...'`, so
-- one broken case never hides the rest. Assertions are on the error text
-- `api_raise` embeds (matched case-insensitively), never on SQLSTATE alone.
--
-- FIXTURE --- the SEED's org 1 (Northwind Manufacturing), Plant 1's real
-- shape (supabase/seed.sql, not paraphrased):
--   Plant 1        30..01  (root, template 21..01 "Standard Plant")
--     Assembly     30..02
--       Line 1     30..04
--         Cell 1   30..07 / Cell 2 30..08 / Cell 3 30..09  (schedulable)
--       Line 2     30..05
--         Cell 4   3000000a-...-0a / Cell 5 3000000a-...-0b
--     Machining    30..03
--       CNC Line   30..06
--         Cell 6   3000000a-...-0c / Cell 7 3000000a-...-0d
--   12 descendants under Plant 1 (2 departments, 3 lines, 7 cells).
--   a1 company admin; a2 Ana, a Line-1-scoped supervisor (not company admin).
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

\echo 'CP1: copy_plant_structure as company admin succeeds and returns the right shape'
SAVEPOINT sp_CP1;
DO $$
DECLARE
  v_res jsonb; v_new_root uuid; v_count int; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := copy_plant_structure('30000000-0000-0000-0000-000000000001', 'Plant 1 Library Copy');
  RESET ROLE;
  v_new_root := (v_res ->> 'id')::uuid;
  v_count := (v_res ->> 'nodes_copied')::int;
  IF v_res ->> 'name' <> 'Plant 1 Library Copy' THEN v_ok := false; v_why := v_why || ' wrong name in result'; END IF;
  IF v_count <> 12 THEN v_ok := false; v_why := v_why || format(' nodes_copied=%s, expected 12', v_count); END IF;
  IF v_new_root IS NULL THEN v_ok := false; v_why := v_why || ' no id returned'; END IF;
  IF NOT EXISTS (SELECT 1 FROM nodes WHERE id = v_new_root AND parent_id IS NULL AND name = 'Plant 1 Library Copy') THEN
    v_ok := false; v_why := v_why || ' new root row not found as a top-level node';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CP1'; ELSE RAISE NOTICE 'FAIL CP1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP1;

\echo 'CP2: the copy reproduces the source shape --- same descendant count, names and depth, actually read back'
SAVEPOINT sp_CP2;
DO $$
DECLARE
  v_res jsonb; v_new_root uuid; v_new_path ltree; v_src_path ltree;
  v_src_names text[]; v_new_names text[]; v_src_depths int[]; v_new_depths int[];
  v_ok boolean := true; v_why text := '';
BEGIN
  SELECT path INTO v_src_path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := copy_plant_structure('30000000-0000-0000-0000-000000000001', 'Plant 1 Shape Copy');
  RESET ROLE;
  v_new_root := (v_res ->> 'id')::uuid;
  SELECT path INTO v_new_path FROM nodes WHERE id = v_new_root;

  SELECT array_agg(name ORDER BY name), array_agg(nlevel(path) - nlevel(v_src_path) ORDER BY name)
    INTO v_src_names, v_src_depths
    FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001'
      AND path <@ v_src_path AND id <> '30000000-0000-0000-0000-000000000001';

  SELECT array_agg(name ORDER BY name), array_agg(nlevel(path) - nlevel(v_new_path) ORDER BY name)
    INTO v_new_names, v_new_depths
    FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001'
      AND path <@ v_new_path AND id <> v_new_root;

  IF v_new_names IS DISTINCT FROM v_src_names THEN
    v_ok := false; v_why := v_why || format(' names differ: source %s vs copy %s', v_src_names, v_new_names);
  END IF;
  -- relative depth (each node's depth minus its own root's depth) must match between
  -- source and copy, so the tree SHAPE (not just the name set) is proven, not assumed.
  IF v_new_depths IS DISTINCT FROM v_src_depths THEN
    v_ok := false; v_why := v_why || format(' relative depths differ: source %s vs copy %s', v_src_depths, v_new_depths);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CP2'; ELSE RAISE NOTICE 'FAIL CP2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP2;

\echo 'CP3: the copy is empty of parts and people --- no operator or product_sites row references it'
SAVEPOINT sp_CP3;
DO $$
DECLARE
  v_res jsonb; v_new_path ltree; v_op_count int; v_site_count int; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := copy_plant_structure('30000000-0000-0000-0000-000000000001', 'Plant 1 Empty Copy');
  RESET ROLE;
  SELECT path INTO v_new_path FROM nodes WHERE id = (v_res ->> 'id')::uuid;

  SELECT count(*) INTO v_op_count FROM operators o
    JOIN nodes n ON n.id = o.home_node_id
   WHERE n.path <@ v_new_path;
  SELECT count(*) INTO v_site_count FROM product_sites ps
    JOIN nodes n ON n.id = ps.node_id
   WHERE n.path <@ v_new_path;

  IF v_op_count <> 0 THEN v_ok := false; v_why := v_why || format(' %s operator(s) homed under the copy', v_op_count); END IF;
  IF v_site_count <> 0 THEN v_ok := false; v_why := v_why || format(' %s product_sites row(s) under the copy', v_site_count); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CP3'; ELSE RAISE NOTICE 'FAIL CP3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP3;

\echo 'CP4a: Ana (base role supervisor, no grant reaching the root) cannot even read Plant 1, so the source lookup itself refuses her'
SAVEPOINT sp_CP4a;
DO $$
DECLARE v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_plant_structure('30000000-0000-0000-0000-000000000001', 'Ana''s Illicit Copy');
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CP4a: Ana was allowed to create a plant';
  ELSIF v_code NOT ILIKE '%not found%' AND v_code NOT ILIKE '%not yours to read%' THEN
    RAISE NOTICE 'FAIL CP4a: refused but not as not-found/not-yours-to-read: %', v_code;
  ELSE RAISE NOTICE 'PASS CP4a'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP4a: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP4a;

\echo 'CP4b: even granted supervisor AT the plant root (so she CAN read it), Ana is still refused --- by app_is_admin(), the actual gate the claim names'
SAVEPOINT sp_CP4b;
DO $$
DECLARE v_code text; v_ok boolean := true; v_before int; v_after int;
BEGIN
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('a0000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001', 'supervisor');
  SELECT count(*) INTO v_before FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_plant_structure('30000000-0000-0000-0000-000000000001', 'Ana''s Illicit Copy 2');
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_after FROM nodes WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CP4b: Ana was allowed to create a plant once she could read the root';
  ELSIF v_code NOT ILIKE '%not_permitted%' AND v_code NOT ILIKE '%company-admin%' THEN
    RAISE NOTICE 'FAIL CP4b: refused but not as not_permitted/company-admin: %', v_code;
  ELSIF v_after <> v_before THEN
    RAISE NOTICE 'FAIL CP4b: refused, but the root count still changed (% -> %)', v_before, v_after;
  ELSE RAISE NOTICE 'PASS CP4b'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP4b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP4b;

\echo 'CP5: a source that is not a top-level plant (Line 1, which has a parent) is refused invalid_argument'
SAVEPOINT sp_CP5;
DO $$
DECLARE v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_plant_structure('30000000-0000-0000-0000-000000000004', 'Line 1 As A Plant');
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CP5: a non-root node was copied as if it were a plant';
  ELSIF v_code NOT ILIKE '%invalid_argument%' AND v_code NOT ILIKE '%top-level%' THEN
    RAISE NOTICE 'FAIL CP5: refused but not as invalid_argument/top-level: %', v_code;
  ELSE RAISE NOTICE 'PASS CP5'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP5;

\echo 'CP6: an unknown source root is refused invalid_argument, not a null-pointer-shaped crash'
SAVEPOINT sp_CP6;
DO $$
DECLARE v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_plant_structure('99999999-0000-0000-0000-000000000099', 'Nowhere');
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL CP6: an unknown source root was accepted';
  ELSIF v_code NOT ILIKE '%invalid_argument%' AND v_code NOT ILIKE '%not found%' THEN
    RAISE NOTICE 'FAIL CP6: refused but not as invalid_argument/not found: %', v_code;
  ELSE RAISE NOTICE 'PASS CP6'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CP6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP6;

\echo 'CP7: grants --- authenticated only, revoked from anon and PUBLIC'
SAVEPOINT sp_CP7;
DO $$
DECLARE v_auth boolean; v_anon boolean; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT has_function_privilege('authenticated', 'copy_plant_structure(uuid, text)', 'EXECUTE') INTO v_auth;
  SELECT has_function_privilege('anon', 'copy_plant_structure(uuid, text)', 'EXECUTE') INTO v_anon;
  IF NOT v_auth THEN v_ok := false; v_why := v_why || ' authenticated cannot execute'; END IF;
  IF v_anon THEN v_ok := false; v_why := v_why || ' anon CAN execute'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CP7'; ELSE RAISE NOTICE 'FAIL CP7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL CP7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CP7;

ROLLBACK;

\echo '91_copy_plant_structure_test.sql complete (CP1-CP7 with CP4a/CP4b)'
