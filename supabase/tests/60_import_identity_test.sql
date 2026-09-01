-- ============================================================================
-- 60_import_identity_test.sql — migration 0033, the missing premises for CSV
-- import (stage 23).
--
-- Two claims, and they fail differently:
--
--   0033a  THE HIERARCHY CAN BE IMPORTED AT ALL. A node carries the id its
--          exporting system knows the place by, and that id names ONE place in
--          the company. W1-W5.
--   0033b  A PRODUCTS RE-IMPORT UPDATES INSTEAD OF DUPLICATING. ⚠️ 0034 (D115)
--          RE-SETTLED THE KEY: a part number is COMPANY-WIDE now, so external_id
--          is unique ORG-WIDE (not per owner), the products.site_node_id column
--          is gone, and creating the shared record is a company-admin act (the
--          Split). Two plants making one part is ONE product with a product_sites
--          row per plant, not two products. W6-W9 pin the new rules.
--
-- and a third thing the migration only records:
--
--   0033c  THE COLUMNS GAVE NOBODY ANY NEW RIGHT (W10-W11) — under 0034 the
--          shared product record is company-only and the makers-list is
--          per-plant — and the tables do NOT all agree about what "already
--          exists" means (W12): products and operators now match ORG-WIDE, only
--          skills stay per owner. An importer must know this before it writes.
--
-- ⚠️⚠️ EVERY CASE RUNS AS `authenticated`, AS A NAMED PERSON. The owner of these
-- tables is not subject to RLS, so a suite that ran as the owner would pass
-- against policies that admit nobody.
--
-- ⭐ THE FIXTURE'S POINT IS THAT PLANT A AND PLANT B HAVE DIFFERENT PEOPLE.
-- "Two plants may each import the same code" is not a statement about one admin
-- typing twice; it is two site admins who have never met, each running their own
-- upload. A fixture with a single company admin doing both would pass with the
-- ownership half of the index deleted.
--   * `adm`    org-wide 'admin'                          -> the whole company
--   * `sa_a`   'supervisor' + an ADMIN grant on Plant A   -> site admin of A
--   * `sa_b`   'supervisor' + an ADMIN grant on Plant B   -> site admin of B
--   * `sup_a`  'supervisor' + a SUPERVISOR grant on A     -> may edit, not own
-- ============================================================================

\set ON_ERROR_STOP off

BEGIN;

INSERT INTO orgs (id, name) VALUES
  ('11111111-0000-0000-0000-000000000060', 'Org 60');
INSERT INTO hierarchy_templates (id, org_id, name) VALUES
  ('21111111-0000-0000-0000-000000000060', '11111111-0000-0000-0000-000000000060', 'T60 Shape');
INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable) VALUES
  ('22111111-0000-0000-0000-000000000060', '11111111-0000-0000-0000-000000000060',
   '21111111-0000-0000-0000-000000000060', 0, 'Plant', false),
  ('22111111-0000-0000-0000-00000000006a', '11111111-0000-0000-0000-000000000060',
   '21111111-0000-0000-0000-000000000060', 1, 'Line', true);

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a0', '11111111-0000-0000-0000-000000000060',
   '22111111-0000-0000-0000-000000000060', NULL, 'T60 Plant A'),
  ('23111111-0000-0000-0000-0000000000b0', '11111111-0000-0000-0000-000000000060',
   '22111111-0000-0000-0000-000000000060', NULL, 'T60 Plant B');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('23111111-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000060',
   '22111111-0000-0000-0000-00000000006a', '23111111-0000-0000-0000-0000000000a0', 'T60 Line A1'),
  ('23111111-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000060',
   '22111111-0000-0000-0000-00000000006a', '23111111-0000-0000-0000-0000000000b0', 'T60 Line B1');

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-000000006010'),
  ('00000000-0000-0000-0000-000000006020'),
  ('00000000-0000-0000-0000-000000006030'),
  ('00000000-0000-0000-0000-000000006040');
INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
  ('e1111111-0000-0000-0000-000000006010', '11111111-0000-0000-0000-000000000060',
   '00000000-0000-0000-0000-000000006010', 'admin'),
  ('e1111111-0000-0000-0000-000000006020', '11111111-0000-0000-0000-000000000060',
   '00000000-0000-0000-0000-000000006020', 'supervisor'),
  ('e1111111-0000-0000-0000-000000006030', '11111111-0000-0000-0000-000000000060',
   '00000000-0000-0000-0000-000000006030', 'supervisor'),
  ('e1111111-0000-0000-0000-000000006040', '11111111-0000-0000-0000-000000000060',
   '00000000-0000-0000-0000-000000006040', 'supervisor');
-- ⭐ sa_a and sup_a hold a grant on the SAME node. The only thing separating
-- them is the grant's ROLE, which is what owning a list turns on (0023).
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('e1111111-0000-0000-0000-000000006020', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000060', 'admin'),
  ('e1111111-0000-0000-0000-000000006030', '23111111-0000-0000-0000-0000000000b0',
   '11111111-0000-0000-0000-000000000060', 'admin'),
  ('e1111111-0000-0000-0000-000000006040', '23111111-0000-0000-0000-0000000000a0',
   '11111111-0000-0000-0000-000000000060', 'supervisor');

-- ---------------------------------------------------------------------------
\echo 'W1 ⭐⭐: a place can carry the id its own system knows it by — the premise the hierarchy import lacked'
SAVEPOINT sp_W1;
DO $$
DECLARE v_rows text := 'none'; v_ext text; v_src text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET external_id = 'LOC-7', source = 'csv'
     WHERE id = '23111111-0000-0000-0000-0000000000a0';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_rows := SQLSTATE; END;
  SELECT external_id, source INTO v_ext, v_src FROM nodes
   WHERE id = '23111111-0000-0000-0000-0000000000a0';
  RESET ROLE;
  -- Before 0033 there was no column here at all, so an import had nothing to
  -- match a spreadsheet row against and "import the structure" was impossible
  -- rather than merely unbuilt.
  IF v_rows = '1' AND v_ext = 'LOC-7' AND v_src = 'csv' THEN RAISE NOTICE 'PASS W1';
  ELSE RAISE NOTICE 'FAIL W1: rows=% external_id=% source=% (want 1/LOC-7/csv)', v_rows, v_ext, v_src; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W1: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W1;

\echo 'W2 ⭐: and a second place cannot claim the same id — a re-import updates, never duplicates'
SAVEPOINT sp_W2;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  UPDATE nodes SET external_id = 'LOC-7' WHERE id = '23111111-0000-0000-0000-0000000000a0';
  BEGIN
    UPDATE nodes SET external_id = 'LOC-7' WHERE id = '23111111-0000-0000-0000-0000000000a1';
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = '23505' THEN RAISE NOTICE 'PASS W2';
  ELSE RAISE NOTICE 'FAIL W2: state=% (want 23505) — a second upload would double the hierarchy', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W2: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W2;

\echo 'W3 ⭐⭐: a place id is ORG-WIDE — two DIFFERENT plants cannot each claim LOC-7'
SAVEPOINT sp_W3;
DO $$
DECLARE v_state text := 'none';
BEGIN
  -- ⭐⭐ THE CASE THAT SEPARATES `nodes` FROM `products`. The lines below sit in
  -- two different plants, so a PER-OWNER index — the shape products and skills
  -- use — would happily allow both. A node has no owner above it to be scoped
  -- within, so a place is identified within the company. If this case ever
  -- passes with 'allowed', the nodes index has acquired a site_node_id it has
  -- no business having, and two plants can each claim to be the same place.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  UPDATE nodes SET external_id = 'LOC-7' WHERE id = '23111111-0000-0000-0000-0000000000a1';
  BEGIN
    UPDATE nodes SET external_id = 'LOC-7' WHERE id = '23111111-0000-0000-0000-0000000000b1';
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = '23505' THEN RAISE NOTICE 'PASS W3';
  ELSE RAISE NOTICE 'FAIL W3: state=% (want 23505) — the node rule is not org-wide', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W3: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W3;

\echo 'W4 ⚠️: places with NO external id do not collide with each other'
SAVEPOINT sp_W4;
DO $$
DECLARE v_state text := 'none'; v_n int;
BEGIN
  -- ⭐ The index is PARTIAL so the hand-built hierarchy — which is nearly every
  -- node there will ever be — is not indexed at all. A plain unique over
  -- (org_id, external_id) would behave the same way today, because NULLs never
  -- collide; the WHERE clause is there to say so in the schema rather than
  -- leaving it to be rediscovered.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name) VALUES
      ('11111111-0000-0000-0000-000000000060', '22111111-0000-0000-0000-00000000006a',
       '23111111-0000-0000-0000-0000000000a0', 'T60 Line A2'),
      ('11111111-0000-0000-0000-000000000060', '22111111-0000-0000-0000-00000000006a',
       '23111111-0000-0000-0000-0000000000a0', 'T60 Line A3');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM nodes
   WHERE org_id = '11111111-0000-0000-0000-000000000060' AND external_id IS NULL;
  RESET ROLE;
  IF v_state = 'allowed' AND v_n = 6 THEN RAISE NOTICE 'PASS W4';
  ELSE RAISE NOTICE 'FAIL W4: state=% unimported nodes=% (want allowed/6)', v_state, v_n; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W4: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W4;

\echo 'W5 ⭐: a place built by hand says so, without anyone having to say so'
SAVEPOINT sp_W5;
DO $$
DECLARE v_src text; v_ext text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
    ('23111111-0000-0000-0000-0000000000a9', '11111111-0000-0000-0000-000000000060',
     '22111111-0000-0000-0000-00000000006a', '23111111-0000-0000-0000-0000000000a0',
     'T60 Line A9');
  SELECT source, external_id INTO v_src, v_ext FROM nodes
   WHERE id = '23111111-0000-0000-0000-0000000000a9';
  RESET ROLE;
  -- ⚠️ The default is the whole point of the NOT NULL. A node whose provenance
  -- is unknown would let an import screen guess, and the guess it would make is
  -- "the CSV owns this row" — which is how hand-built structure gets overwritten
  -- by an upload nobody meant to apply to it.
  IF v_src = 'manual' AND v_ext IS NULL THEN RAISE NOTICE 'PASS W5';
  ELSE RAISE NOTICE 'FAIL W5: source=% external_id=% (want manual/null)', v_src, v_ext; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W5: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W5;

\echo 'W6 ⭐⭐ (inverted by 0034): a part number is COMPANY-WIDE — SKU-100 is ONE product made in two plants, not two products'
SAVEPOINT sp_W6;
DO $$
DECLARE v_a text := 'none'; v_dup text := 'none'; v_plants int; v_rows int;
BEGIN
  -- ⭐⭐ THIS CASE INVERTED. Until 0034 external_id was per owner and two plants
  -- each imported their own SKU-100 as two products. D115 makes a part
  -- company-wide: external_id is unique ORG-WIDE, so SKU-100 names ONE product,
  -- and "made in two plants" is a product_sites row per plant. Creating the
  -- shared record is a company-admin act (the Split), so `adm` does it.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-100', 'Widget', 'csv', 'SKU-100');
    v_a := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_a := SQLSTATE; END;
  -- A SECOND product row carrying the same part number is refused ORG-WIDE.
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B-100', 'Widget', 'csv', 'SKU-100');
    v_dup := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_dup := SQLSTATE; WHEN OTHERS THEN v_dup := SQLSTATE; END;
  -- The right model: ONE product, a product_sites row in each plant.
  INSERT INTO product_sites (org_id, product_id, node_id)
    SELECT '11111111-0000-0000-0000-000000000060', p.id, n.id
      FROM products p, (VALUES ('23111111-0000-0000-0000-0000000000a0'::uuid),
                               ('23111111-0000-0000-0000-0000000000b0'::uuid)) n(id)
     WHERE p.external_id = 'SKU-100';
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM products WHERE external_id = 'SKU-100';
  SELECT count(*) INTO v_plants FROM product_sites ps JOIN products p ON p.id = ps.product_id
   WHERE p.external_id = 'SKU-100';
  IF v_a = 'allowed' AND v_dup = '23505' AND v_rows = 1 AND v_plants = 2 THEN RAISE NOTICE 'PASS W6';
  ELSE RAISE NOTICE 'FAIL W6: first=% second=% product_rows=% plants=% (want allowed/23505/1/2 — one part, two plants)', v_a, v_dup, v_rows, v_plants; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W6;

\echo 'W7 ⭐: a re-import of the same part number does not duplicate — the second row is refused, org-wide'
SAVEPOINT sp_W7;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO products (org_id, sku, name, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'A-100', 'Widget', 'csv', 'SKU-100');
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-100-B', 'Widget, second upload', 'csv', 'SKU-100');
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  -- Before 0033 this was 'allowed'; 0033 stopped it per owner and 0034 widened
  -- it to the whole company. An importer must UPDATE the existing row, not add.
  IF v_state = '23505' THEN RAISE NOTICE 'PASS W7';
  ELSE RAISE NOTICE 'FAIL W7: state=% (want 23505) — a re-import still duplicates', v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W7: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W7;

\echo 'W8 ⚠️: products with NO external id do not collide with each other'
SAVEPOINT sp_W8;
DO $$
DECLARE v_state text := 'none'; v_n int;
BEGIN
  -- The index is PARTIAL (WHERE external_id IS NOT NULL), so hand-typed products
  -- with no part number are not indexed and never collide. Creating them is a
  -- company-admin act now (the Split), so `adm` does it.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-M1', 'Typed In One'),
      ('11111111-0000-0000-0000-000000000060', 'A-M2', 'Typed In Two');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM products
   WHERE sku IN ('A-M1','A-M2') AND external_id IS NULL;
  RESET ROLE;
  IF v_state = 'allowed' AND v_n = 2 THEN RAISE NOTICE 'PASS W8';
  ELSE RAISE NOTICE 'FAIL W8: state=% typed-in rows=% (want allowed/2)', v_state, v_n; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W8: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W8;

\echo 'W9 ⭐⭐ (rewritten by 0034): the part-number index is ORG-WIDE and PARTIAL, and products.site_node_id is GONE — the index rename is pinned'
SAVEPOINT sp_W9;
DO $$
DECLARE v_col int; v_old int; v_new_def text;
BEGIN
  -- ⭐⭐ SUPERSEDES THE OLD "every product HAS an owner" CASE. The old W9 leaned
  -- on products.site_node_id being NOT NULL so a per-owner index had no NULL
  -- escape hatch. D115 removes the column entirely and re-keys the part number
  -- company-wide, so the rule that guards a re-import is now a single org-wide
  -- partial index. This pins the migration's rename directly: the column is
  -- gone, the old per-owner index is gone, and the org-wide one is exactly as
  -- specified. If any of these regresses, W6/W7 could silently duplicate.
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_schema='public' AND table_name='products' AND column_name='site_node_id';
  SELECT count(*) INTO v_old FROM pg_indexes
   WHERE schemaname='public' AND indexname='products_owner_external_id_unique';
  SELECT indexdef INTO v_new_def FROM pg_indexes
   WHERE schemaname='public' AND indexname='products_org_external_id_unique';
  IF v_col = 0 AND v_old = 0
     AND v_new_def LIKE '%UNIQUE%'
     AND v_new_def LIKE '%(org_id, external_id)%'
     AND v_new_def LIKE '%WHERE (external_id IS NOT NULL)%'
  THEN RAISE NOTICE 'PASS W9';
  ELSE RAISE NOTICE 'FAIL W9: site_node_id_cols=% old_index=% new_def=% (want 0/0 and an org-wide partial unique)', v_col, v_old, v_new_def; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W9: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W9;

\echo 'W10 ⭐⭐ (rewritten by 0034/Split): importing the shared product RECORD is company-only; the makers-list is per-plant'
SAVEPOINT sp_W10;
DO $$
DECLARE v_sa text := 'none'; v_sup text := 'none'; v_adm text := 'none';
        v_own_place text := 'none'; v_other_place text := 'none'; v_pid uuid;
BEGIN
  -- ⭐⭐ THE SPLIT (D115) CHANGED WHO MAY IMPORT. Until 0034 importing a product
  -- was an OWNER's act and a site admin uploaded their own plant's catalog. Now
  -- the shared record is company property: creating a product is a company-admin
  -- act, so BOTH a site admin (sa_a) and a plain supervisor (sup_a) are refused.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-200', 'Site Admin Upload', 'csv', 'SKU-200');
    v_sa := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_sa := SQLSTATE; END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006040', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-201', 'Supervisor Upload', 'csv', 'SKU-201');
    v_sup := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_sup := SQLSTATE; END;
  RESET ROLE;

  -- The company admin creates the record; the site admin then adds THEIR OWN
  -- plant to its makers-list (product_sites) but not the other plant's.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-202', 'Company Upload', 'csv', 'SKU-202')
      RETURNING id INTO v_pid;
    v_adm := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_adm := SQLSTATE; END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id) VALUES
      ('11111111-0000-0000-0000-000000000060', v_pid, '23111111-0000-0000-0000-0000000000a0');
    v_own_place := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_own_place := SQLSTATE; END;
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id) VALUES
      ('11111111-0000-0000-0000-000000000060', v_pid, '23111111-0000-0000-0000-0000000000b0');
    v_other_place := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_other_place := SQLSTATE; END;
  RESET ROLE;

  IF v_sa = '42501' AND v_sup = '42501' AND v_adm = 'allowed'
     AND v_own_place = 'allowed' AND v_other_place = '42501' THEN RAISE NOTICE 'PASS W10';
  ELSE RAISE NOTICE 'FAIL W10: site_admin_record=% supervisor_record=% company_record=% own_plant_place=% other_plant_place=% (want 42501/42501/allowed/allowed/42501)',
    v_sa, v_sup, v_adm, v_own_place, v_other_place; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W10: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W10;

\echo 'W11 ⭐: nor on the hierarchy — a site admin may label their own branch and not another'
SAVEPOINT sp_W11;
DO $$
DECLARE v_own text := 'none'; v_other text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET external_id = 'LOC-A1', source = 'csv'
     WHERE id = '23111111-0000-0000-0000-0000000000a1';
    GET DIAGNOSTICS v_own = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_own := SQLSTATE; END;
  BEGIN
    UPDATE nodes SET external_id = 'LOC-B1', source = 'csv'
     WHERE id = '23111111-0000-0000-0000-0000000000b1';
    GET DIAGNOSTICS v_other = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_other := SQLSTATE; END;
  RESET ROLE;
  -- ⚠️ An RLS-refused UPDATE removes zero rows and raises NOTHING (19.63), so
  -- '0' is the refusal here, not an exception. A case that only checked for an
  -- error would pass against a policy that had stopped applying entirely.
  IF v_own = '1' AND v_other = '0' THEN RAISE NOTICE 'PASS W11';
  ELSE RAISE NOTICE 'FAIL W11: own branch=% rows other branch=% rows (want 1/0)', v_own, v_other; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W11: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W11;

\echo 'W12 ⚠️⚠️ (rewritten by 0034): the tables now MOSTLY AGREE — the same code is ONE product and ONE operator (org-wide), but TWO skills (per owner)'
SAVEPOINT sp_W12;
DO $$
DECLARE v_prod text := 'none'; v_op text := 'none'; v_skill text := 'none'; v_sku text := 'none';
BEGIN
  -- ⚠️⚠️ 0033 RECORDED A DISAGREEMENT; 0034 HALF-RESOLVED IT, AND THIS MEASURES
  -- WHAT IS LEFT. `operators` answered "already exists?" ORG-WIDE since 0002;
  -- 0033 made products and skills answer PER OWNER; 0034 (D115) re-keyed
  -- PRODUCTS to org-wide too. So products and operators now MATCH — a second row
  -- with CODE-1 is a hard 23505 in both — and only SKILLS still answer per
  -- owner, where two plants may each hold CODE-1. An importer matches on a
  -- different key for skills than for products/operators, and this pins it.
  -- All three creates run as the company admin: a product is company-only now,
  -- and adm can also create operators and skills anywhere.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;

  INSERT INTO products (org_id, sku, name, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'A-300', 'Widget', 'csv', 'CODE-1');
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B-300', 'Widget', 'csv', 'CODE-1');
    v_prod := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_prod := SQLSTATE; WHEN OTHERS THEN v_prod := SQLSTATE; END;

  INSERT INTO operators (org_id, display_name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'A. Nowak',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'CODE-1');
  BEGIN
    INSERT INTO operators (org_id, display_name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B. Nowak',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'CODE-1');
    v_op := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_op := SQLSTATE;
            WHEN OTHERS THEN v_op := SQLSTATE; END;

  -- Skills stay per owner: two owners may each carry CODE-1.
  INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'Training A',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'CODE-1');
  BEGIN
    INSERT INTO skills (org_id, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'Training B',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'CODE-1');
    v_skill := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_skill := SQLSTATE;
            WHEN OTHERS THEN v_skill := SQLSTATE; END;

  -- ⚠️ THE SKU IS STILL ORG-WIDE (`unique (org_id, sku)`, from 0002, untouched)
  -- — reusing A-300 collides no matter what the external_id index says.
  BEGIN
    INSERT INTO products (org_id, sku, name, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-300', 'Same sku again', 'csv', 'CODE-2');
    v_sku := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_sku := SQLSTATE;
            WHEN OTHERS THEN v_sku := SQLSTATE; END;
  RESET ROLE;

  IF v_prod = '23505' AND v_op = '23505' AND v_skill = 'allowed' AND v_sku = '23505' THEN RAISE NOTICE 'PASS W12';
  ELSE RAISE NOTICE 'FAIL W12: product=% operator=% skill=% sku=% (want 23505/23505/allowed/23505)', v_prod, v_op, v_skill, v_sku; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W12: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W12;

ROLLBACK;
