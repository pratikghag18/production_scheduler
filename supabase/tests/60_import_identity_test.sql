-- ============================================================================
-- 60_import_identity_test.sql — migration 0033, the missing premises for CSV
-- import (stage 23).
--
-- Two claims, and they fail differently:
--
--   0033a  THE HIERARCHY CAN BE IMPORTED AT ALL. A node carries the id its
--          exporting system knows the place by, and that id names ONE place in
--          the company. W1-W5.
--   0033b  A PRODUCTS RE-IMPORT UPDATES INSTEAD OF DUPLICATING, and it does so
--          PER OWNER, so two plants may each bring their own catalog — over a
--          table where every row HAS an owner to be scoped by. W6-W9.
--
-- and a third thing the migration only records:
--
--   0033c  THE COLUMNS GAVE NOBODY ANY NEW RIGHT (W10-W11), and the tables do
--          NOT agree with each other about what "already exists" means (W12) —
--          which an importer has to know before it writes a single row.
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

\echo 'W6 ⭐⭐: TWO PLANTS MAY EACH IMPORT SKU-100 — two site admins, two uploads, two products'
SAVEPOINT sp_W6;
DO $$
DECLARE v_a text := 'none'; v_b text := 'none'; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-100', 'Widget',
       '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-100');
    v_a := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_a := SQLSTATE; END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006030', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B-100', 'Widget',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'SKU-100');
    v_b := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_b := SQLSTATE; END;
  RESET ROLE;

  SELECT count(*) INTO v_n FROM products WHERE external_id = 'SKU-100';
  -- ⭐ 0031's rule, one table further: a product is owned by a place, and two
  -- plants each bringing their own SKU-100 from their own system is the
  -- ORDINARY case. An org-wide rule would refuse the second plant's whole
  -- upload on a collision that is not a collision.
  IF v_a = 'allowed' AND v_b = 'allowed' AND v_n = 2 THEN RAISE NOTICE 'PASS W6';
  ELSE RAISE NOTICE 'FAIL W6: plant A=% plant B=% rows=% (want allowed/allowed/2)', v_a, v_b, v_n; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W6: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W6;

\echo 'W7 ⭐: and one plant may not hold SKU-100 twice — the duplicate 0033 exists to stop'
SAVEPOINT sp_W7;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'A-100', 'Widget',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-100');
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-100-B', 'Widget, second upload',
       '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-100');
    v_state := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  -- Before 0033 this was 'allowed', and the second run of the same spreadsheet
  -- doubled the catalog with nothing to say which row was the live one.
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
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-M1', 'Typed In One',
       '23111111-0000-0000-0000-0000000000a0'),
      ('11111111-0000-0000-0000-000000000060', 'A-M2', 'Typed In Two',
       '23111111-0000-0000-0000-0000000000a0');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM products
   WHERE site_node_id = '23111111-0000-0000-0000-0000000000a0' AND external_id IS NULL;
  RESET ROLE;
  IF v_state = 'allowed' AND v_n = 2 THEN RAISE NOTICE 'PASS W8';
  ELSE RAISE NOTICE 'FAIL W8: state=% typed-in rows=% (want allowed/2)', v_state, v_n; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W8: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W8;

\echo 'W9 ⭐⭐: the per-owner rule has no escape hatch — every product HAS an owner'
SAVEPOINT sp_W9;
DO $$
DECLARE v_nullable text; v_state text := 'none';
BEGIN
  -- ⭐⭐ THIS CASE PINS A NEIGHBOURING RULE THAT 0033 LEANS ON WITHOUT OWNING.
  -- A per-owner unique index over a NULLABLE owner is a leaky rule: NULL is not
  -- equal to itself in an index, so every unowned row would slip past W7's
  -- refusal and a re-import of the company-wide catalog would duplicate anyway,
  -- silently and with the index still looking correct.
  --
  -- That does not happen HERE only because 0028 §2 (D108) got there first:
  -- `products.site_node_id` is NOT NULL — *"there is no company-wide product."*
  -- 0033 never restates that rule, so nothing else in this file would notice it
  -- going away. If this case ever fails, W6 and W7 are still green and the
  -- import is quietly duplicating rows.
  SELECT is_nullable INTO v_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'site_node_id';

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'CW-100', 'Company Widget',
       NULL, 'csv', 'SKU-100');
    v_state := 'allowed';
  EXCEPTION WHEN not_null_violation THEN v_state := SQLSTATE;
            WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;

  IF v_nullable = 'NO' AND v_state = '23502' THEN RAISE NOTICE 'PASS W9';
  ELSE RAISE NOTICE 'FAIL W9: site_node_id nullable=% unowned insert=% (want NO/23502) — the per-owner index now has rows it cannot see', v_nullable, v_state; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W9: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W9;

\echo 'W10 ⭐⭐: an external id is not a back door — the catalog rules are exactly what they were'
SAVEPOINT sp_W10;
DO $$
DECLARE v_other text := 'none'; v_sup text := 'none';
BEGIN
  -- The migration adds a column and an index and touches no policy. This is the
  -- case that says so out loud: importing is still an OWNER's act. A site admin
  -- of Plant A may not import into Plant B, and a supervisor whose grant is not
  -- an admin grant may not import at all — the same two refusals that existed
  -- before 0033.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006020', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B-200', 'Reaching Into B',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'SKU-200');
    v_other := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_other := SQLSTATE; END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006040', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-201', 'Supervisor Upload',
       '23111111-0000-0000-0000-0000000000a0', 'csv', 'SKU-201');
    v_sup := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_sup := SQLSTATE; END;
  RESET ROLE;

  IF v_other = '42501' AND v_sup = '42501' THEN RAISE NOTICE 'PASS W10';
  ELSE RAISE NOTICE 'FAIL W10: other plant=% plain supervisor=% (want 42501/42501)', v_other, v_sup; END IF;
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

\echo 'W12 ⚠️⚠️: THE TABLES DISAGREE — the same code is TWO products but ONE operator'
SAVEPOINT sp_W12;
DO $$
DECLARE v_prod text := 'none'; v_op text := 'none'; v_sku text := 'none';
BEGIN
  -- ⚠️⚠️ THE INCONSISTENCY 0033 RECORDS RATHER THAN FIXES, MEASURED. `operators`
  -- has answered "does this row already exist?" ORG-WIDE since 0002; products
  -- and skills now answer PER OWNER. So an importer given one spreadsheet per
  -- plant must match on a different key per table, and the operator upload's
  -- second plant is a hard 23505 rather than an update.
  --
  -- Changing `operators` is a separate decision about PEOPLE (are two plants
  -- each holding EMP-1044 two payroll systems, or one person duplicated?), not
  -- about indexes, and 0033 deliberately leaves it alone. This case exists so
  -- the disagreement is a measured fact the importer is written against.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000006010', true);
  SET LOCAL ROLE authenticated;

  INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
    ('11111111-0000-0000-0000-000000000060', 'A-300', 'Widget',
     '23111111-0000-0000-0000-0000000000a0', 'csv', 'CODE-1');
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'B-300', 'Widget',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'CODE-1');
    v_prod := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_prod := SQLSTATE; END;

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

  -- ⚠️ AND A THIRD DISAGREEMENT THE IMPORT SCREEN WILL MEET FIRST. `products`
  -- is `unique (org_id, sku)` — ORG-WIDE, from 0002 and untouched by 0033 — so
  -- the two plants above only got their own rows because their SKUs differ. An
  -- importer that uses the exported code AS the sku collides here no matter
  -- what the external_id index says. Whether a sku is a company-wide name or a
  -- plant's name is an open decision; this pins today's answer.
  BEGIN
    INSERT INTO products (org_id, sku, name, site_node_id, source, external_id) VALUES
      ('11111111-0000-0000-0000-000000000060', 'A-300', 'Same sku, other plant',
       '23111111-0000-0000-0000-0000000000b0', 'csv', 'CODE-2');
    v_sku := 'allowed';
  EXCEPTION WHEN unique_violation THEN v_sku := SQLSTATE;
            WHEN OTHERS THEN v_sku := SQLSTATE; END;
  RESET ROLE;

  IF v_prod = 'allowed' AND v_op = '23505' AND v_sku = '23505' THEN RAISE NOTICE 'PASS W12';
  ELSE RAISE NOTICE 'FAIL W12: product=% operator=% sku=% (want allowed/23505/23505)', v_prod, v_op, v_sku; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL W12: unexpected % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W12;

ROLLBACK;
