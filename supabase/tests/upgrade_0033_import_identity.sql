-- ============================================================================
-- upgrade_0033_import_identity.sql — 0033 against a database that already has a
-- hierarchy and a catalog in it.
--
-- ⭐ THREE THINGS HERE CAN ONLY FAIL ON A POPULATED DATABASE, and the fresh path
-- cannot show any of them:
--
--   * `ADD COLUMN source text NOT NULL DEFAULT 'manual'` REWRITES A POPULATED
--     `nodes`. Every place that already exists must come out `'manual'` — a node
--     claiming to have come from a CSV would be a lie about provenance, and an
--     import screen acts on exactly that field when it decides whether an upload
--     may overwrite a row. On the fresh path the column is added to an empty
--     table and the default is never exercised.
--
--   * ⭐⭐ A UNIQUE INDEX ADDED TO A POPULATED `products` MUST ACTUALLY BUILD.
--     `products.external_id` has carried no rule since 0002, so the rows that
--     exist were written under no constraint at all. If the index were widened
--     to org-wide, the perfectly ordinary fixture below — two plants that each
--     imported their own `SKU-9` — would abort the migration on the morning of
--     the upgrade. The fresh path indexes zero rows and cannot notice.
--
--   * THE MIGRATION MUST TAKE NOTHING AWAY. It adds columns to a table every
--     policy in the app reads. A site admin who could keep the catalog before
--     must still be able to afterwards; U33-6 is that case.
--
-- Run against a database at migration 0032 with NO seed. The file applies 0033
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000033', 'Upgrade Org 0033');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000033', '11111111-0000-0000-0000-000000000033', 'U33 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000033', '11111111-0000-0000-0000-000000000033',
   '21111111-0000-0000-0000-000000000033', 0, 'Plant', false),
  ('22111111-0000-0000-0000-00000000003a', '11111111-0000-0000-0000-000000000033',
   '21111111-0000-0000-0000-000000000033', 1, 'Line', true);

-- ⭐ CREATED BEFORE THE MIGRATION, so `ADD COLUMN ... NOT NULL DEFAULT` has real
-- rows to rewrite and the default has something to default.
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000033',
   '22111111-0000-0000-0000-000000000033', NULL, 'U33 Plant A'),
  ('23111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000033',
   '22111111-0000-0000-0000-000000000033', NULL, 'U33 Plant B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000033',
   '22111111-0000-0000-0000-00000000003a', '23111111-0000-0000-0000-0000000000a0', 'U33 Line 1');

-- ⭐⭐ THE FIXTURE THAT DECIDES THE SHAPE. Two plants that each already imported
-- their own `SKU-9` — legal today (products has no rule), legal after 0033 (the
-- rule is per owner), and an ABORTED MIGRATION if the index is ever widened to
-- (org_id, external_id). Plus two rows with no external id at all, which a
-- non-partial index over a nullable column would still tolerate but which pin
-- that the migration does not somehow reject them.
INSERT INTO products (id, org_id, sku, name, site_node_id, source, external_id) VALUES
  ('26111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000033',
   'A-9', 'U33 Widget A', '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-9'),
  ('26111111-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000033',
   'B-9', 'U33 Widget B', '23111111-0000-0000-0000-0000000000b0', 'csv', 'SKU-9'),
  ('26111111-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000033',
   'A-M1', 'U33 Manual One', '23111111-0000-0000-0000-0000000000a0', 'manual', NULL),
  ('26111111-0000-0000-0000-0000000000a3', '11111111-0000-0000-0000-000000000033',
   'A-M2', 'U33 Manual Two', '23111111-0000-0000-0000-0000000000a0', 'manual', NULL);

-- A SITE ADMIN who could keep this catalog before the migration.
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000033a0');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e1111111-0000-0000-0000-000000000033', '11111111-0000-0000-0000-000000000033',
   '00000000-0000-0000-0000-0000000033a0', 'supervisor');
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('e1111111-0000-0000-0000-000000000033', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000033', 'admin');

-- ---------------------------------------------------------------------------
\echo 'U33-0: this file is running against 0032 — neither premise is there yet'
DO $$
DECLARE v_cols int; v_idx int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'nodes'
     AND column_name IN ('source','external_id');
  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname IN ('nodes_org_external_id_unique','products_owner_external_id_unique');
  IF v_cols = 0 AND v_idx = 0 THEN RAISE NOTICE 'PASS U33-0';
  ELSE RAISE NOTICE 'FAIL U33-0: node columns=% (want 0), indexes=% (want 0) — not running against 0032', v_cols, v_idx; END IF;
END $$;

-- ---------------------------------------------------------------------------
\i :mig
-- ---------------------------------------------------------------------------

\echo 'U33-1 ⭐: every place that already existed came out marked as entered by hand'
DO $$
DECLARE v_bad int; v_ext int; v_n int;
BEGIN
  SELECT count(*) INTO v_n   FROM nodes WHERE org_id = '11111111-0000-0000-0000-000000000033';
  SELECT count(*) INTO v_bad FROM nodes
   WHERE org_id = '11111111-0000-0000-0000-000000000033' AND source IS DISTINCT FROM 'manual';
  SELECT count(*) INTO v_ext FROM nodes
   WHERE org_id = '11111111-0000-0000-0000-000000000033' AND external_id IS NOT NULL;
  -- ⚠️ An existing node claiming a CSV provenance it never had is a lie the
  -- import screen acts on when it decides whether an upload may overwrite the
  -- row, and it cannot be told apart later.
  IF v_n = 3 AND v_bad = 0 AND v_ext = 0 THEN RAISE NOTICE 'PASS U33-1';
  ELSE RAISE NOTICE 'FAIL U33-1: % nodes (want 3), % not manual, % with an external id (want 0/0)', v_n, v_bad, v_ext; END IF;
END $$;

\echo 'U33-2 ⭐⭐: the unique index BUILT over a populated products, and changed no row'
DO $$
DECLARE v_n int; v_dup int;
BEGIN
  SELECT count(*) INTO v_n   FROM products WHERE org_id = '11111111-0000-0000-0000-000000000033';
  SELECT count(*) INTO v_dup FROM products
   WHERE org_id = '11111111-0000-0000-0000-000000000033' AND external_id = 'SKU-9';
  -- ⭐⭐ THIS IS THE CASE A WIDENED INDEX FAILS. Two plants each holding their
  -- own SKU-9 is ordinary data; an org-wide index cannot be built over it, so
  -- the migration would abort here rather than at a developer's desk. The
  -- surviving pair is the per-owner decision, measured on real rows.
  IF v_n = 4 AND v_dup = 2 THEN RAISE NOTICE 'PASS U33-2';
  ELSE RAISE NOTICE 'FAIL U33-2: % products survived (want 4), % share SKU-9 (want 2)', v_n, v_dup; END IF;
END $$;

\echo 'U33-3: and the rule now bites — one plant may not hold SKU-9 twice'
DO $$
DECLARE v_state text := 'none';
BEGIN
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000033', 'A-9-DUP', 'U33 Widget A Again',
       '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-9');
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  -- Without this the migration could have added a non-unique index, or none,
  -- and U33-2 would still pass on every count it makes.
  IF v_state = '23505' THEN RAISE NOTICE 'PASS U33-3';
  ELSE RAISE NOTICE 'FAIL U33-3: state=% (want 23505) — a re-import would still duplicate', v_state; END IF;
END $$;

\echo 'U33-4: the nodes index is the ORG-WIDE partial one'
DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'nodes_org_external_id_unique';
  -- ⚠️ `site_node_id` must NOT appear: a node has no owner to be scoped within,
  -- and an index that acquired one would silently let two plants each claim the
  -- same place id.
  IF v_def LIKE '%UNIQUE%' AND v_def LIKE '%(org_id, external_id)%'
     AND v_def LIKE '%external_id IS NOT NULL%'
    THEN RAISE NOTICE 'PASS U33-4';
  ELSE RAISE NOTICE 'FAIL U33-4: %', coalesce(v_def, '<missing>'); END IF;
END $$;

\echo 'U33-5: the products index is the PER-OWNER partial one, matching skills'
DO $$
DECLARE v_def text; v_skills text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'products_owner_external_id_unique';
  SELECT indexdef INTO v_skills FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'skills_owner_external_id_unique';
  -- ⭐ The two owned lists must agree; 0031 settled the shape and 0032 applied
  -- it to skills. Comparing them here is what stops products drifting back.
  IF v_def LIKE '%UNIQUE%' AND v_def LIKE '%(org_id, site_node_id, external_id)%'
     AND v_def LIKE '%external_id IS NOT NULL%'
     AND v_skills LIKE '%(org_id, site_node_id, external_id)%'
    THEN RAISE NOTICE 'PASS U33-5';
  ELSE RAISE NOTICE 'FAIL U33-5: products=% skills=%', coalesce(v_def, '<missing>'), coalesce(v_skills, '<missing>'); END IF;
END $$;

\echo 'U33-6 ⭐: the additions took NOTHING away — a site admin can still keep the catalog'
DO $$
DECLARE v_product text := 'none'; v_rename text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000033a0', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000033', 'A-AFTER', 'U33 After',
       '23111111-0000-0000-0000-0000000000a0');
    v_product := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_product := SQLSTATE; END;
  BEGIN
    UPDATE products SET name = 'U33 Widget A (renamed)'
     WHERE id = '26111111-0000-0000-0000-0000000000a1';
    GET DIAGNOSTICS v_rename = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_rename := SQLSTATE; END;
  RESET ROLE;
  -- ⚠️ An RLS-refused UPDATE removes zero rows and raises NOTHING (19.63), so
  -- the row count is the answer and "no error" is not "it happened".
  IF v_product = 'allowed' AND v_rename = '1' THEN RAISE NOTICE 'PASS U33-6';
  ELSE RAISE NOTICE 'FAIL U33-6: insert=% rename=% rows (want allowed/1)', v_product, v_rename; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL U33-6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;

ROLLBACK;
