-- ============================================================================
-- 62_product_lifecycle_test.sql — migration 0036, D116: "a site admin may make
-- (and wholly own) a product at their own plant."
--
-- THE MAINTAINER'S WORDS (2 Sept):
--   "right now a site admin cannot add a new product, I feel we should allow
--    that since a product is going to have unique part number, there is little
--    to no risk to let a site admin add a new product."
--   Chosen shape: create at a plant they administer, and own the part's whole
--   lifecycle (rename/recolour/delete) WHILE only their plant makes it.
--
-- 61 pins the EDIT half (P5 rename, P6 delete) now that D116 has widened it.
-- This file pins the CREATE half and the transition that bounds it:
--
--   Q1  create_product_at_node lets a site admin make a part AT their plant,
--       assigned to it in one act, and read it straight back
--   Q2  ...and refuses a plant they do not administer (PT403), creating nothing
--   Q3  a company admin may create_product_at_node at any plant
--   Q4  once a SECOND plant adopts the part, its identity is company property
--       again — the original maker can no longer rename or delete it
--
-- FIXTURE (idiom of 61): two extra plants in the SAME org built through
-- create_node (a cross-tenant refusal would prove nothing about a cross-plant
-- one); every site admin holds the org-wide role 'viewer' so app_is_admin()
-- cannot short-circuit a predicate under test.
--
-- People (org-wide 'viewer'):
--   qa  admin grant on Plant R
--   qb  admin grant on Plant S
-- The seed supplies a1, an org-wide company admin.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE q_fix (k text primary key, v uuid);

-- Two extra plants, built through create_node so each is a real root. Ids are
-- captured after RESET ROLE — `authenticated` cannot write a TEMP table, and
-- that refusal reads exactly like RLS.
DO $$
DECLARE v_r uuid; v_s uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_r := (create_node(NULL, 'Plant R (lifecycle)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_s := (create_node(NULL, 'Plant S (lifecycle)', 1, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  RESET ROLE;
  INSERT INTO q_fix (k, v) VALUES ('r', v_r), ('s', v_s);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- People and grants, as the owner (RLS bypassed for the fixture).
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_r uuid; v_s uuid;
BEGIN
  SELECT v INTO v_r FROM q_fix WHERE k = 'r';
  SELECT v INTO v_s FROM q_fix WHERE k = 's';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000062a1'),
    ('00000000-0000-0000-0000-0000000062a2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e7000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000062a1', 'viewer'),
    ('e7000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000062a2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e7000000-0000-0000-0000-000000000001', v_r, v_org, 'admin'),
    ('e7000000-0000-0000-0000-000000000002', v_s, v_org, 'admin');
END $$;

-- ---------------------------------------------------------------------------
-- Q1 — create AT the caller's own plant, assigned in one act.
-- ---------------------------------------------------------------------------
\echo 'Q1 ⭐: create_product_at_node lets a site admin make a part AT their plant, assigned in one act and readable back'
SAVEPOINT sp_Q1;
DO $$
DECLARE v_r uuid; v_id uuid; v_prod int; v_sites int; v_at_r int;
BEGIN
  SELECT v INTO v_r FROM q_fix WHERE k = 'r';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000062a1', true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO v_id FROM create_product_at_node('Q-NEW', 'Made by qa', v_r);
  -- Read back AS the same site admin: RLS admits the part (its maker is theirs).
  SELECT count(*) INTO v_prod  FROM products      WHERE id = v_id;
  SELECT count(*) INTO v_sites FROM product_sites WHERE product_id = v_id;
  SELECT count(*) INTO v_at_r  FROM product_sites WHERE product_id = v_id AND node_id = v_r;
  RESET ROLE;
  IF v_prod = 1 AND v_sites = 1 AND v_at_r = 1 THEN RAISE NOTICE 'PASS Q1';
  ELSE RAISE NOTICE 'FAIL Q1: prod=% sites=% at_r=% (want 1/1/1)', v_prod, v_sites, v_at_r; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL Q1: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Q1;

-- ---------------------------------------------------------------------------
-- Q2 — a plant the caller does not administer is refused, and creates nothing.
-- ---------------------------------------------------------------------------
\echo 'Q2 ⭐: create_product_at_node refuses a plant the site admin does not administer (PT403), and creates nothing'
SAVEPOINT sp_Q2;
DO $$
DECLARE v_s uuid; v_state text := 'allowed'; v_made int;
BEGIN
  SELECT v INTO v_s FROM q_fix WHERE k = 's';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000062a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_product_at_node('Q-BAD', 'Nope', v_s);
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_made FROM products
    WHERE sku = 'Q-BAD' AND org_id = '10000000-0000-0000-0000-000000000001';
  IF v_state = 'PT403' AND v_made = 0 THEN RAISE NOTICE 'PASS Q2';
  ELSE RAISE NOTICE 'FAIL Q2: state=% made=% (want PT403/0)', v_state, v_made; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q2;

-- ---------------------------------------------------------------------------
-- Q3 — a company admin may create at any plant.
-- ---------------------------------------------------------------------------
\echo 'Q3: a company admin may create_product_at_node at any plant'
SAVEPOINT sp_Q3;
DO $$
DECLARE v_s uuid; v_id uuid; v_at_s int;
BEGIN
  SELECT v INTO v_s FROM q_fix WHERE k = 's';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO v_id FROM create_product_at_node('Q-CO', 'Company at S', v_s);
  SELECT count(*) INTO v_at_s FROM product_sites WHERE product_id = v_id AND node_id = v_s;
  RESET ROLE;
  IF v_at_s = 1 THEN RAISE NOTICE 'PASS Q3';
  ELSE RAISE NOTICE 'FAIL Q3: at_s=% (want 1)', v_at_s; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL Q3: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Q3;

-- ---------------------------------------------------------------------------
-- Q4 — adoption flips the lifecycle back to company property.
-- ---------------------------------------------------------------------------
\echo 'Q4 ⭐⭐: once a second plant adopts the part, the original maker can no longer rename (0) or delete (PT403) it'
SAVEPOINT sp_Q4;
DO $$
DECLARE v_r uuid; v_s uuid; v_id uuid; v_before int; v_after int; v_del text := 'none';
BEGIN
  SELECT v INTO v_r FROM q_fix WHERE k = 'r';
  SELECT v INTO v_s FROM q_fix WHERE k = 's';
  -- qa makes a part wholly in Plant R and, while sole maker, renames it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000062a1', true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO v_id FROM create_product_at_node('Q-ADOPT', 'Adopted later', v_r);
  UPDATE products SET name = 'renamed while sole maker' WHERE id = v_id;
  GET DIAGNOSTICS v_before = ROW_COUNT;
  RESET ROLE;
  -- A company admin adds Plant S as a second maker.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO product_sites (org_id, product_id, node_id)
    VALUES ('10000000-0000-0000-0000-000000000001', v_id, v_s);
  RESET ROLE;
  -- qa now administers only one of the part's two plants: rename filters to 0,
  -- delete is refused with PT403.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000062a1', true);
  SET LOCAL ROLE authenticated;
  UPDATE products SET name = 'renamed after adoption' WHERE id = v_id;
  GET DIAGNOSTICS v_after = ROW_COUNT;
  BEGIN
    PERFORM delete_owned_row('product', v_id);
    v_del := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_del := SQLSTATE; END;
  RESET ROLE;
  IF v_before = 1 AND v_after = 0 AND v_del = 'PT403' THEN RAISE NOTICE 'PASS Q4';
  ELSE RAISE NOTICE 'FAIL Q4: before=% after=% del=% (want 1/0/PT403)', v_before, v_after, v_del; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL Q4: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Q4;

ROLLBACK;

\echo '62_product_lifecycle_test.sql complete (4 cases: Q1-Q4)'
