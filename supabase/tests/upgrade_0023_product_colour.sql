-- ============================================================================
-- upgrade_0023_product_colour.sql — 0023's ONE data transform, on the path that
-- actually runs it.
--
-- ⭐ THIS FILE EXISTS BECAUSE THE MIGRATION SAID IT WOULD NOT.
-- 0023's §9 originally stated, in writing, that there was no `UPGRADE_CHECKS`
-- row and no upgrade test — reasoning that ownership is deliberately NOT
-- backfilled, so nothing is transformed. That was three-quarters right and the
-- missing quarter is `products.color_token`, which IS a transform, and the
-- standing rule is unconditional: **any migration that transforms existing data
-- needs a row in `verify-db.sh`'s UPGRADE_CHECKS.**
--
-- It was not caught by reading. It was caught by case Q24 going red: Q24
-- claimed the backfill reproduced the old sku-ordinal assignment, and on the
-- numbered suite's fresh database that claim cannot be true — `db:reset`
-- applies every migration to an EMPTY schema and only then runs the seed, so
-- the backfill correctly does nothing and §3's insert trigger does the work
-- instead. Q24 now asserts the fresh path; this file asserts the other one.
--
-- THE PROPERTY THAT MATTERS HERE: an existing board must not change colour
-- under the upgrade. Every product on it has been rendering in the colour its
-- sku-ordinal gave it, and if the backfill picked differently every band on
-- every screen would move at once, for no reason a user could name.
--
-- Run against a database at migration 0022 with NO seed. The file applies 0023
-- itself; see verify-db.sh's UPGRADE_CHECKS.
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000023', 'Upgrade Org 0023');

-- Six products, so the palette WRAPS. Four would let a broken modulo look
-- right: with exactly four rows "ordinal + 1" and "ordinal % 4 + 1" agree on
-- every row, and the wrap is the whole arithmetic. Skus are chosen so that
-- alphabetical order is NOT insertion order — if the two agreed, this file
-- could not tell the backfill's rule from the trigger's.
INSERT INTO products (id, org_id, sku, name) VALUES
  ('66666666-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000023', 'ZZ', 'Zeta'),
  ('66666666-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000023', 'YY', 'Yankee'),
  ('66666666-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000023', 'XX', 'X-ray'),
  ('66666666-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000023', 'WW', 'Whisky'),
  ('66666666-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000023', 'VV', 'Victor'),
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000023', 'UU', 'Uniform');

-- Assert the fixture BEFORE upgrading. The whole file is about a column that
-- does not exist yet, so proving we are really at 0022 is not ceremony.
DO $$
DECLARE v_has_col int; v_n int;
BEGIN
  SELECT count(*) INTO v_has_col FROM pg_attribute
   WHERE attrelid = 'public.products'::regclass
     AND attname = 'color_token' AND NOT attisdropped;
  SELECT count(*) INTO v_n FROM products WHERE org_id = '11111111-0000-0000-0000-000000000023';
  IF v_has_col = 0 AND v_n = 6 THEN RAISE NOTICE 'PASS V0';
  ELSE RAISE NOTICE 'FAIL V0: color_token_cols=% products=% -- not a 0022 database with the intended fixture',
        v_has_col, v_n; END IF;
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
\i :mig
-- ----------------------------------------------------------------------------

DO $$
DECLARE v_mismatch int; v_got text;
BEGIN
  -- The rule the client has used since P1-1, reproduced exactly: board_window
  -- emits products ORDER BY sku, and BoardGrid takes the row's ordinal mod 4.
  -- UU..ZZ sort to UU,VV,WW,XX,YY,ZZ -> product-1,2,3,4,1,2.
  SELECT count(*) INTO v_mismatch FROM (
    SELECT p.color_token,
           'product-' || (((row_number() OVER (ORDER BY p.sku)) - 1) % 4 + 1) AS old_rule
      FROM products p WHERE p.org_id = '11111111-0000-0000-0000-000000000023'
  ) t WHERE t.color_token <> t.old_rule;
  IF v_mismatch = 0 THEN RAISE NOTICE 'PASS V1';
  ELSE RAISE NOTICE 'FAIL V1: % of 6 products changed colour under the upgrade', v_mismatch; END IF;

  -- The wrap, named on its own row so a broken modulo cannot hide inside a count.
  SELECT color_token INTO v_got FROM products WHERE id = '66666666-0000-0000-0000-000000000002'; -- YY, 5th by sku
  IF v_got = 'product-1' THEN RAISE NOTICE 'PASS V2';
  ELSE RAISE NOTICE 'FAIL V2: the 5th product by sku got % (want product-1 -- the palette wraps)', v_got; END IF;
END $$;

DO $$
DECLARE v_null int; v_bad int;
BEGIN
  SELECT count(*) INTO v_null FROM products WHERE color_token IS NULL;
  SELECT count(*) INTO v_bad  FROM products WHERE color_token !~ '^product-[1-9][0-9]*$';
  IF v_null = 0 AND v_bad = 0 THEN RAISE NOTICE 'PASS V3';
  ELSE RAISE NOTICE 'FAIL V3: null=% malformed=% after the backfill (want 0,0)', v_null, v_bad; END IF;
END $$;

DO $$
DECLARE v_owned int;
BEGIN
  -- ⭐ THE NON-CHANGE, ASSERTED. 0023 deliberately does not backfill ownership:
  -- every row that existed was created under the company-wide regime and is
  -- correctly company-wide now, and claiming one for a site would silently hand
  -- somebody else's list to a site admin. An intention nobody asserts is an
  -- intention somebody helpfully "fixes" later.
  SELECT count(*) INTO v_owned FROM products WHERE site_node_id IS NOT NULL;
  IF v_owned = 0 THEN RAISE NOTICE 'PASS V4';
  ELSE RAISE NOTICE 'FAIL V4: % product(s) were claimed by a site during the upgrade', v_owned; END IF;
END $$;

DO $$
DECLARE v_tok text;
BEGIN
  -- The backfill and the trigger are the same rule reached two ways, so a row
  -- inserted after the upgrade must continue the same scope's sequence rather
  -- than restarting it. Six products already hold 1,2,3,4,1,2 -> the least-used
  -- tokens are 3 and 4, and palette order breaks the tie.
  INSERT INTO products (org_id, sku, name)
    VALUES ('11111111-0000-0000-0000-000000000023', 'TT', 'Tango')
    RETURNING color_token INTO v_tok;
  IF v_tok = 'product-3' THEN RAISE NOTICE 'PASS V5';
  ELSE RAISE NOTICE 'FAIL V5: a post-upgrade insert got % (want product-3 -- least used in scope)', v_tok; END IF;
END $$;

\echo 'upgrade_0023_product_colour.sql complete (6 cases: V0-V5)'
