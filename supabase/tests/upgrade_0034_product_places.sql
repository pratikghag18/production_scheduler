-- ============================================================================
-- upgrade_0034_product_places.sql — 0034 (D115) against a database that already
-- has products in it, each with the single owner column 0034 is about to drop.
--
-- ⭐ WHY THIS FILE EXISTS, when the numbered suite only ever runs the FRESH path.
--
-- Migration 0034 §2 BACKFILLS product_sites from products.site_node_id and §13
-- then DROPS that column. On `db:reset` the backfill sees nothing — migrations
-- run against an empty schema and seed.sql inserts its own product_sites rows
-- afterwards — so the fresh path exercises neither the backfill nor the drop
-- over real data. The three things that can actually go wrong here are invisible
-- there:
--
--   * ⭐⭐ THE BACKFILL. `insert into product_sites select org_id, id,
--     site_node_id from products` must produce exactly one place per existing
--     product, carrying its old owner. A widening in meaning (one plant becomes
--     a one-element list), so nothing legal may become illegal. U34-1 plants two
--     products in two plants first and checks the rows that come out.
--
--   * ⭐ DROPPING THE COLUMN. §13 drops products.site_node_id and its FK/index.
--     If a later re-emission still read it, the drop would fail; if the column
--     survived, the "two homes for one fact" trap is back. U34-2 pins it gone.
--
--   * THE IMPORT KEY MOVED. §12 drops the per-owner external_id index and adds
--     an ORG-WIDE partial one. A test that only inspected the new index would
--     pass while the old one still sat there admitting per-owner duplicates.
--     U34-3 pins the rename in both directions.
--
-- Run against a database at migration 0033 with NO seed. The file applies 0034
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000034', 'Upgrade Org 0034');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000034', '11111111-0000-0000-0000-000000000034', 'U34 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000034', '11111111-0000-0000-0000-000000000034',
   '21111111-0000-0000-0000-000000000034', 0, 'Plant', false),
  ('22111111-0000-0000-0000-000000000035', '11111111-0000-0000-0000-000000000034',
   '21111111-0000-0000-0000-000000000034', 1, 'Line', true);

-- TWO plants, because "one place per product carrying ITS OWN owner" is only
-- testable if two products carry two different owners.
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a4', '11111111-0000-0000-0000-000000000034',
   '22111111-0000-0000-0000-000000000034', NULL, 'U34 Plant A'),
  ('23111111-0000-0000-0000-0000000000b4', '11111111-0000-0000-0000-000000000034',
   '22111111-0000-0000-0000-000000000034', NULL, 'U34 Plant B');

-- ⭐ CREATED BEFORE THE MIGRATION, so the backfill has real rows to transform.
-- Each carries the single owner column 0034 drops, and an external_id so U34-3's
-- index rename has something to have indexed. color_token is filled by the
-- products_set_color_token trigger on insert.
INSERT INTO products (id, org_id, sku, name, site_node_id, source, external_id) VALUES
  ('64111111-0000-0000-0000-000000000034', '11111111-0000-0000-0000-000000000034',
   'UP-A', 'U34 Product A', '23111111-0000-0000-0000-0000000000a4', 'manual', 'UP-1'),
  ('64111111-0000-0000-0000-000000000035', '11111111-0000-0000-0000-000000000034',
   'UP-B', 'U34 Product B', '23111111-0000-0000-0000-0000000000b4', 'manual', 'UP-2');

-- ---------------------------------------------------------------------------
\echo 'U34-0: this file is running against 0033 — products.site_node_id exists and product_sites does not'
DO $$
DECLARE v_col int; v_tbl int; v_owner uuid;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='products' AND column_name='site_node_id';
  SELECT count(*) INTO v_tbl FROM information_schema.tables
   WHERE table_schema='public' AND table_name='product_sites';
  -- ...and the owner is really set, or the backfill below would have nothing to
  -- carry and U34-1 could pass over empty inputs.
  SELECT site_node_id INTO v_owner FROM products WHERE id = '64111111-0000-0000-0000-000000000034';
  IF v_col = 1 AND v_tbl = 0 AND v_owner = '23111111-0000-0000-0000-0000000000a4'
    THEN RAISE NOTICE 'PASS U34-0';
  ELSE RAISE NOTICE 'FAIL U34-0: site_node_id_col=% product_sites_table=% owner=% (want 1, 0, Plant A) — this file is not running against 0033',
    v_col, v_tbl, v_owner; END IF;
END $$;

-- ---------------------------------------------------------------------------
\i :mig
-- ---------------------------------------------------------------------------

\echo 'U34-1 ⭐⭐: the backfill produced exactly one place per product, each carrying its OLD owner'
DO $$
DECLARE v_n int; v_a uuid; v_b uuid;
BEGIN
  SELECT count(*) INTO v_n FROM product_sites
   WHERE product_id IN ('64111111-0000-0000-0000-000000000034','64111111-0000-0000-0000-000000000035');
  -- ⚠️ Fetched separately, not via min(uuid) — there is no min(uuid) in Postgres
  -- (postgres_gotchas 24), a trap upgrade_0031 walked into and this file avoids.
  SELECT node_id INTO v_a FROM product_sites WHERE product_id = '64111111-0000-0000-0000-000000000034';
  SELECT node_id INTO v_b FROM product_sites WHERE product_id = '64111111-0000-0000-0000-000000000035';
  IF v_n = 2
     AND v_a = '23111111-0000-0000-0000-0000000000a4'
     AND v_b = '23111111-0000-0000-0000-0000000000b4'
    THEN RAISE NOTICE 'PASS U34-1';
  ELSE RAISE NOTICE 'FAIL U34-1: places=% A_owner=% B_owner=% (want 2, Plant A, Plant B)', v_n, v_a, v_b; END IF;
END $$;

\echo 'U34-2 ⭐: products.site_node_id is GONE — the fused column did not survive the migration'
DO $$
DECLARE v_col int;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='products' AND column_name='site_node_id';
  IF v_col = 0 THEN RAISE NOTICE 'PASS U34-2';
  ELSE RAISE NOTICE 'FAIL U34-2: products.site_node_id still present (% columns) — the two-homes-for-one-fact trap is back', v_col; END IF;
END $$;

\echo 'U34-3: the import key moved company-wide — the per-owner index is gone and the org-wide one is in force'
DO $$
DECLARE v_old int; v_def text;
BEGIN
  SELECT count(*) INTO v_old FROM pg_indexes
   WHERE schemaname='public' AND indexname='products_owner_external_id_unique';
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname='public' AND indexname='products_org_external_id_unique';
  IF v_old = 0
     AND v_def LIKE '%UNIQUE%'
     AND v_def LIKE '%(org_id, external_id)%'
     AND v_def LIKE '%WHERE (external_id IS NOT NULL)%'
    THEN RAISE NOTICE 'PASS U34-3';
  ELSE RAISE NOTICE 'FAIL U34-3: old_per_owner_index=% new_def=% (want 0 and an org-wide partial unique)', v_old, v_def; END IF;
END $$;

ROLLBACK;
