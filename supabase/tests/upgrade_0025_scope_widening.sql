-- ============================================================================
-- upgrade_0025_scope_widening.sql — 0025 transforms NO data, and this file is
-- what makes that claim evidence rather than an argument.
--
-- ⭐ WHY IT EXISTS AT ALL. 0025's header says, correctly, that every existing
-- row holds NULL or a root id and both stay legal, so there is nothing to
-- backfill. [[verification-standard]] rule 5b is the reason that paragraph is
-- not enough: **an argument that a test is unnecessary is not evidence.** 0023
-- made exactly that argument, at length and plausibly, and writing the upgrade
-- test anyway found a palette twice as wide as the stylesheet.
--
-- ⭐⭐ AND A WIDENING IS THE WORST SHAPE FOR A SUITE TO GUARD. Everything legal
-- before is legal after, so every pre-existing case passes no matter how far
-- the migration went. The numbered suite (52_) proves the new value is
-- accepted; this file proves the OLD data survived it untouched, and that the
-- boundary the widening was NOT supposed to move has not moved.
--
-- Run against a database at migration 0024 with NO seed. The file applies 0025
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000025', 'Upgrade Org 0025');

INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('11111111-0000-0000-0000-000000000125', '11111111-0000-0000-0000-000000000025', 'U25 Shape');

INSERT INTO hierarchy_levels (id, org_id, template_id, name, position, is_schedulable) VALUES
  ('11111111-0000-0000-0000-000000000225','11111111-0000-0000-0000-000000000025','11111111-0000-0000-0000-000000000125','Site', 0, false),
  ('11111111-0000-0000-0000-000000000226','11111111-0000-0000-0000-000000000025','11111111-0000-0000-0000-000000000125','Line', 1, true);

-- A root and a child, as they exist BEFORE 0025. Under 0024's trigger only the
-- root is a legal owner; the child is what the widening is about.
INSERT INTO nodes (id, org_id, parent_id, level_id, name, sort_order) VALUES
  ('11111111-0000-0000-0000-000000000325','11111111-0000-0000-0000-000000000025', NULL,
   '11111111-0000-0000-0000-000000000225','U25 Plant', 0),
  ('11111111-0000-0000-0000-000000000326','11111111-0000-0000-0000-000000000025',
   '11111111-0000-0000-0000-000000000325','11111111-0000-0000-0000-000000000226','U25 Line', 0);

-- The two shapes that exist in a real pre-0025 database, and nothing else:
-- owned by a ROOT, and company-wide.
INSERT INTO products (id, org_id, sku, name, site_node_id, color_token) VALUES
  ('11111111-0000-0000-0000-000000000425','11111111-0000-0000-0000-000000000025','UROOT','Root Owned',
   '11111111-0000-0000-0000-000000000325','product-2'),
  ('11111111-0000-0000-0000-000000000426','11111111-0000-0000-0000-000000000025','UWIDE','Company Wide',
   NULL,'product-3');

INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('11111111-0000-0000-0000-000000000525','11111111-0000-0000-0000-000000000025','U25 Person',
   '11111111-0000-0000-0000-000000000325');

SAVEPOINT before_migration;

\echo '--- applying 0025 ---'
\i :mig

-- ---------------------------------------------------------------------------
\echo 'U25-1: the pre-0025 rows are byte-for-byte unchanged'
DO $$
DECLARE v_root uuid; v_wide uuid; v_c1 text; v_c2 text; v_op uuid;
BEGIN
  SELECT site_node_id, color_token INTO v_root, v_c1 FROM products
   WHERE id = '11111111-0000-0000-0000-000000000425';
  SELECT site_node_id, color_token INTO v_wide, v_c2 FROM products
   WHERE id = '11111111-0000-0000-0000-000000000426';
  SELECT site_node_id INTO v_op FROM operators
   WHERE id = '11111111-0000-0000-0000-000000000525';
  -- ⭐ THE WHOLE POINT OF A NO-TRANSFORM MIGRATION, asserted rather than argued.
  -- A migration that "helpfully" pushed every root-owned row down to its
  -- schedulable children, or normalised NULL to the root, would pass 52_
  -- completely and silently re-scope every list in every existing database.
  IF v_root = '11111111-0000-0000-0000-000000000325' AND v_c1 = 'product-2'
     AND v_wide IS NULL AND v_c2 = 'product-3'
     AND v_op = '11111111-0000-0000-0000-000000000325'
  THEN RAISE NOTICE 'PASS U25-1';
  ELSE RAISE NOTICE 'FAIL U25-1: product_root=% (%) product_wide=% (%) operator=%',
    v_root, v_c1, v_wide, v_c2, v_op; END IF;
END $$;

\echo 'U25-2: a CHILD node is a legal owner now, on data that predates the change'
DO $$
DECLARE v_got uuid; v_err text := NULL;
BEGIN
  BEGIN
    UPDATE products SET site_node_id = '11111111-0000-0000-0000-000000000326'
     WHERE id = '11111111-0000-0000-0000-000000000425';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE; END;
  SELECT site_node_id INTO v_got FROM products WHERE id = '11111111-0000-0000-0000-000000000425';
  IF v_err IS NULL AND v_got = '11111111-0000-0000-0000-000000000326'
  THEN RAISE NOTICE 'PASS U25-2';
  ELSE RAISE NOTICE 'FAIL U25-2: sqlstate=% owner=% (want no error, the child node)', v_err, v_got; END IF;
END $$;

\echo 'U25-3: the ORG boundary did not move with it'
DO $$
DECLARE v_raw text; v_detail jsonb; v_got uuid;
BEGIN
  -- The only refusal branch the trigger has left. If the widening was written
  -- as "return new" the migration still applies, 52_'s S1-S3 still pass, and
  -- one tenant can point a product at another tenant's node.
  BEGIN
    UPDATE products SET site_node_id = '30000000-0000-0000-0000-000000000001'
     WHERE id = '11111111-0000-0000-0000-000000000426';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  SELECT site_node_id INTO v_got FROM products WHERE id = '11111111-0000-0000-0000-000000000426';
  IF v_detail->>'reason' = 'not found' AND v_got IS NULL
  THEN RAISE NOTICE 'PASS U25-3';
  ELSE RAISE NOTICE 'FAIL U25-3: detail=% owner=% (want not found, and unchanged)', v_detail, v_got; END IF;
END $$;

\echo 'U25-4: an existing token colour is still legal, and a hex is legal now'
DO $$
DECLARE v_tok text; v_hex text;
BEGIN
  UPDATE products SET color_token = 'product-1' WHERE id = '11111111-0000-0000-0000-000000000425';
  SELECT color_token INTO v_tok FROM products WHERE id = '11111111-0000-0000-0000-000000000425';
  UPDATE products SET color_token = '#2a78d6' WHERE id = '11111111-0000-0000-0000-000000000425';
  SELECT color_token INTO v_hex FROM products WHERE id = '11111111-0000-0000-0000-000000000425';
  IF v_tok = 'product-1' AND v_hex = '#2a78d6' THEN RAISE NOTICE 'PASS U25-4';
  ELSE RAISE NOTICE 'FAIL U25-4: token=% hex=% (want product-1 then #2a78d6)', v_tok, v_hex; END IF;
END $$;

\echo 'U25-5: and the CHECK still refuses everything else, on an upgraded database'
DO $$
DECLARE v_a text := NULL; v_b text := NULL; v_c text := NULL;
BEGIN
  -- Re-asserted HERE and not only in 52_, because `alter table ... drop
  -- constraint / add constraint` is the one statement in this migration that
  -- can leave an EXISTING table with no constraint at all if the add half is
  -- mis-typed — and on a fresh database the numbered suite would never notice,
  -- since 52_ builds its rows after the constraint is already in place.
  BEGIN UPDATE products SET color_token = '#2A78D6' WHERE id = '11111111-0000-0000-0000-000000000426';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_a = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = 'blue'    WHERE id = '11111111-0000-0000-0000-000000000426';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_b = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = '#2a78'   WHERE id = '11111111-0000-0000-0000-000000000426';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_c = RETURNED_SQLSTATE; END;
  IF v_a = '23514' AND v_b = '23514' AND v_c = '23514' THEN RAISE NOTICE 'PASS U25-5';
  ELSE RAISE NOTICE 'FAIL U25-5: upper=% named=% short=% (want three 23514)', v_a, v_b, v_c; END IF;
END $$;

ROLLBACK;
