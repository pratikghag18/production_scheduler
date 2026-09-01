-- ============================================================================
-- 61_product_places_test.sql — migration 0034, D115: "a product belongs to a
-- LIST of plants, not one."
--
-- THE MAINTAINER'S WORDS (31 Aug / 1 Sept):
--   "A Product can be assigned to multiple plants as there can be different
--    plants at different geo locations within the company manufacturing the
--    same part number." "It could be one plant, a number of plants or all
--    plants... we need to be flexible."
--
-- One column (products.site_node_id) did three jobs — READ, OFFER, EDIT — and
-- D115 splits them, then makes only OFFER/READ a list while EDIT becomes the
-- Split decision. This file pins D115's own rules, in the idiom of 55_/56_
-- (savepoint per case, RAISE NOTICE PASS/FAIL):
--
--   P1   a part made in two plants is readable by BOTH plants' admins, neither a third
--   P2   product_sites_select hides the other plant's place row from a plant admin
--   P3   a run/assignment is schedulable where ANY place covers, refused where none do
--   P4   a plant admin adds/removes THEIR OWN plant's place, not another's (42501)
--   P5   the Split: products insert/update/delete refused to a site admin, allowed to a company admin
--   P6   delete_owned_row('product',...) refused to a site admin, allowed to a company admin
--   P7   the strand guard blocks removing the LAST plant covering a scheduled run
--   P8   ...and ALLOWS the removal when another plant still covers it
--   P9   adding a plant is never stranded; and colour picks with no owner
--
-- FIXTURE, and the reasons (borrowed from 55_/56_):
--   * two extra PLANTS in the SAME org (Plant P, Plant Q) built through
--     create_node, because a cross-TENANT refusal proves nothing about a
--     cross-PLANT one — org scoping refuses that three layers earlier;
--   * every plant admin holds the org-wide role 'viewer', so app_is_admin()
--     cannot short-circuit any predicate under test;
--   * SHARED is made in Plant 1 AND Plant P — the list is the whole point.
--
-- People (all org-wide 'viewer'):
--   pa  admin grant on Plant 1          — site admin of Plant 1
--   pb  admin grant on Plant P          — site admin of Plant P
--   pc  admin grant on Plant Q          — a third plant, sees neither of the above
-- The seed supplies a1, an org-wide company admin.
--
-- Seed nodes: plant_1 …0001, assembly …0002 (both cover Cell 1), cell_1 …0007.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE p_fix (k text primary key, v uuid);

-- Two extra plants, built through create_node so each is a real root (0020 §10's
-- copy-on-root-create included). Ids captured in scalars and written to the temp
-- table AFTER RESET ROLE — `authenticated` cannot write a TEMP table and the
-- refusal reads exactly like RLS (instrument failure 34).
DO $$
DECLARE v_pp uuid; v_pq uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pp := (create_node(NULL, 'Plant P (places)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_pq := (create_node(NULL, 'Plant Q (places)', 1, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  RESET ROLE;
  INSERT INTO p_fix (k, v) VALUES ('pp', v_pp), ('pq', v_pq);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- Runs as the owner (no SET ROLE): RLS is bypassed for the fixture, triggers
-- still fire. Products carry no place column; their makers are product_sites.
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_pp uuid; v_pq uuid;
BEGIN
  SELECT v INTO v_pp FROM p_fix WHERE k = 'pp';
  SELECT v INTO v_pq FROM p_fix WHERE k = 'pq';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000061a1'),
    ('00000000-0000-0000-0000-0000000061a2'),
    ('00000000-0000-0000-0000-0000000061a3');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e6000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000061a1', 'viewer'),
    ('e6000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000061a2', 'viewer'),
    ('e6000000-0000-0000-0000-000000000003', v_org, '00000000-0000-0000-0000-0000000061a3', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e6000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001', v_org, 'admin'),
    ('e6000000-0000-0000-0000-000000000002', v_pp,                                  v_org, 'admin'),
    ('e6000000-0000-0000-0000-000000000003', v_pq,                                  v_org, 'admin');

  -- Four products, all company-wide records; their makers differ.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('6a000000-0000-0000-0000-0000000000f1', v_org, 'SHARED', 'Made in Two Plants'),
    ('6a000000-0000-0000-0000-0000000000f2', v_org, 'PONLY',  'Made only in Plant P'),
    ('6a000000-0000-0000-0000-0000000000f3', v_org, 'COVER',  'Two places both cover Cell 1'),
    ('6a000000-0000-0000-0000-0000000000f4', v_org, 'FREE',   'Plant 1 only, never scheduled');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    -- SHARED: Plant 1 (covers Cell 1) and Plant P (covers neither seed cell).
    (v_org, '6a000000-0000-0000-0000-0000000000f1', '30000000-0000-0000-0000-000000000001'),
    (v_org, '6a000000-0000-0000-0000-0000000000f1', v_pp),
    -- PONLY: Plant P only.
    (v_org, '6a000000-0000-0000-0000-0000000000f2', v_pp),
    -- COVER: Plant 1 root AND Assembly — both are ancestors of Cell 1.
    (v_org, '6a000000-0000-0000-0000-0000000000f3', '30000000-0000-0000-0000-000000000001'),
    (v_org, '6a000000-0000-0000-0000-0000000000f3', '30000000-0000-0000-0000-000000000002'),
    -- FREE: Plant 1 only.
    (v_org, '6a000000-0000-0000-0000-0000000000f4', '30000000-0000-0000-0000-000000000001');

  -- SHARED and COVER are each scheduled once at Cell 1 (which Plant 1 covers),
  -- so the strand guard has real history to protect.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
    ('6a800000-0000-0000-0000-0000000000f1', v_org, '30000000-0000-0000-0000-000000000007',
     '6a000000-0000-0000-0000-0000000000f1', tstzrange('2099-08-01 06:00+00','2099-08-01 14:00+00'), 1),
    ('6a800000-0000-0000-0000-0000000000f3', v_org, '30000000-0000-0000-0000-000000000007',
     '6a000000-0000-0000-0000-0000000000f3', tstzrange('2099-08-02 06:00+00','2099-08-02 14:00+00'), 1);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- A fixture that half-builds measures a world missing the thing the cases are about.
\echo 'P0: the fixture is well-formed — SHARED made in two plants, three plant admins, none of them an org-wide admin'
SAVEPOINT sp_P0;
DO $$
DECLARE v_places int; v_admins int; v_runs int;
BEGIN
  SELECT count(*) INTO v_places FROM product_sites WHERE product_id = '6a000000-0000-0000-0000-0000000000f1';
  SELECT count(*) INTO v_admins FROM user_profiles WHERE id::text LIKE 'e6000000%' AND role = 'admin';
  SELECT count(*) INTO v_runs FROM runs WHERE id::text LIKE '6a800000%';
  IF v_places = 2 AND v_admins = 0 AND v_runs = 2 THEN RAISE NOTICE 'PASS P0';
  ELSE RAISE NOTICE 'FAIL P0: shared_places=% org_wide_admins=% runs=% (want 2, 0, 2)', v_places, v_admins, v_runs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P0;

-- ---------------------------------------------------------------------------
-- P1 — READING. A part made in two plants is readable by BOTH, and by no third.
-- ---------------------------------------------------------------------------
\echo 'P1 ⭐: SHARED is readable by the Plant 1 admin AND the Plant P admin, and NOT by the Plant Q admin'
SAVEPOINT sp_P1;
DO $$
DECLARE v_a int; v_b int; v_c int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_a FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_b FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a3', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  -- ⚠️ All three: seeing it from either plant is the point; the third plant NOT
  -- seeing it is what stops "readable by two" from meaning "readable by anyone".
  IF v_a = 1 AND v_b = 1 AND v_c = 0 THEN RAISE NOTICE 'PASS P1';
  ELSE RAISE NOTICE 'FAIL P1: plant1=% plantP=% plantQ=% (want 1,1,0)', v_a, v_b, v_c; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P1;

-- ---------------------------------------------------------------------------
-- P2 — product_sites_select hides the other plant's place row.
-- ---------------------------------------------------------------------------
\echo 'P2 ⭐⭐: a plant admin sees only THEIR OWN plant''s place row for SHARED; only a company admin sees the whole list'
SAVEPOINT sp_P2;
DO $$
DECLARE v_pp uuid; v_pa int; v_pa_node uuid; v_all int;
BEGIN
  SELECT v INTO v_pp FROM p_fix WHERE k = 'pp';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a1', true);
  SET LOCAL ROLE authenticated;
  -- product_sites_select is scoped by app_can_read_node (at-or-below your grant),
  -- so the Plant 1 admin sees the Plant 1 place and NOT the Plant P one.
  SELECT count(*) INTO v_pa FROM product_sites WHERE product_id = '6a000000-0000-0000-0000-0000000000f1';
  SELECT node_id INTO v_pa_node FROM product_sites
   WHERE product_id = '6a000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_all FROM product_sites WHERE product_id = '6a000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  IF v_pa = 1 AND v_pa_node = '30000000-0000-0000-0000-000000000001' AND v_all = 2
  THEN RAISE NOTICE 'PASS P2';
  ELSE RAISE NOTICE 'FAIL P2: plant1_admin_sees=% (node=%) company_admin_sees=% (want 1 / Plant 1 / 2)', v_pa, v_pa_node, v_all; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P2;

-- ---------------------------------------------------------------------------
-- P3 — OFFERING. Schedulable where ANY place covers, refused where none do.
-- ---------------------------------------------------------------------------
\echo 'P3 ⭐: a run is accepted at Cell 1 for a product made in Plant 1 (a place that covers it), and refused for one made only in Plant P'
SAVEPOINT sp_P3;
DO $$
DECLARE v_ok text := 'no error'; v_bad text := 'no error'; v_kind text; v_detail text; v_keys text := '-';
BEGIN
  RESET ROLE;
  -- SHARED is made in Plant 1, which covers Cell 1 — accepted.
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '6a000000-0000-0000-0000-0000000000f1',
            tstzrange('2099-08-03 06:00+00','2099-08-03 14:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE || ' ' || SQLERRM; END;
  -- PONLY is made only in Plant P, which covers no Plant 1 node — refused.
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '6a000000-0000-0000-0000-0000000000f2',
            tstzrange('2099-08-04 06:00+00','2099-08-04 14:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN
    v_bad := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
    v_keys := coalesce((SELECT string_agg(k, ',' ORDER BY k)
                          FROM jsonb_object_keys(nullif(v_detail,'')::jsonb) k), '-');
  END;
  IF v_ok = 'no error' AND v_bad = 'PT409' AND v_kind = 'product' AND v_keys = 'error,id,kind,node_id'
  THEN RAISE NOTICE 'PASS P3';
  ELSE RAISE NOTICE 'FAIL P3: covered=% uncovered=% kind=% keys=% (want no error, PT409, product, error,id,kind,node_id)',
    v_ok, v_bad, v_kind, v_keys; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P3;

\echo 'P3b: the same for a direct ASSIGNMENT — offered where a place covers, refused (not_offered_here) where none do'
SAVEPOINT sp_P3b;
DO $$
DECLARE v_ok text := 'no error'; v_bad text := 'no error'; v_kind text; v_detail text;
BEGIN
  RESET ROLE;
  -- An assignment must identify a person too; Maria is a seed Plant 1 operator,
  -- so her own scope covers Cell 1 and only the PRODUCT half is under test.
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-0000000000f1',
            tstzrange('2099-08-05 06:00+00','2099-08-05 14:00+00'), 1.000);
  EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-0000000000f2',
            tstzrange('2099-08-06 06:00+00','2099-08-06 14:00+00'), 1.000);
  EXCEPTION WHEN OTHERS THEN
    v_bad := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
  END;
  IF v_ok = 'no error' AND v_bad = 'PT409' AND v_kind = 'product' THEN RAISE NOTICE 'PASS P3b';
  ELSE RAISE NOTICE 'FAIL P3b: covered=% uncovered=% kind=% (want no error, PT409, product)', v_ok, v_bad, v_kind; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P3b;

-- ---------------------------------------------------------------------------
-- P4 — the makers-list is per-plant: a plant admin adds/removes their own.
-- ---------------------------------------------------------------------------
\echo 'P4 ⭐: the Plant 1 admin may INSERT and DELETE a Plant 1 place, but not a Plant P one'
SAVEPOINT sp_P4;
DO $$
DECLARE v_pp uuid; v_add_own text := 'no error'; v_add_other text := 'no error';
        v_del_own int; v_del_other int; v_del_state text;
BEGIN
  SELECT v INTO v_pp FROM p_fix WHERE k = 'pp';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a1', true);
  SET LOCAL ROLE authenticated;
  -- INSERT a place under their own plant (Assembly, inside Plant 1): allowed.
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-0000000000f4',
              '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_add_own = RETURNED_SQLSTATE; END;
  -- INSERT a place in Plant P: WITH CHECK refuses (app_is_admin_for(Plant P) is false).
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-0000000000f4', v_pp);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_add_other = RETURNED_SQLSTATE; END;
  -- DELETE their own plant's place from FREE (no runs, so no strand): allowed.
  DELETE FROM product_sites
   WHERE product_id = '6a000000-0000-0000-0000-0000000000f4'
     AND node_id = '30000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_del_own = ROW_COUNT;
  -- DELETE Plant P's place from PONLY: USING filters it to zero rows, silently.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '6a000000-0000-0000-0000-0000000000f2' AND node_id = v_pp;
    GET DIAGNOSTICS v_del_other = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_del_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_add_own = 'no error' AND v_add_other = '42501'
     AND v_del_own = 1 AND v_del_other = 0 AND v_del_state IS NULL
  THEN RAISE NOTICE 'PASS P4';
  ELSE RAISE NOTICE 'FAIL P4: add_own=% add_other=% del_own=% del_other=% del_state=% (want no error/42501/1/0/null)',
    v_add_own, v_add_other, v_del_own, v_del_other, v_del_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P4;

-- ---------------------------------------------------------------------------
-- P5 — THE SPLIT. The shared record is company property.
-- ---------------------------------------------------------------------------
\echo 'P5 ⭐⭐: products insert/update/delete are refused to a site admin and allowed to a company admin'
SAVEPOINT sp_P5;
DO $$
DECLARE v_ins text := 'no error'; v_upd int; v_del int;
        v_ins_co text := 'no error'; v_upd_co int; v_del_co int;
BEGIN
  -- Site admin (Plant 1): the shared record is not theirs to create, rename or
  -- delete. INSERT raises 42501; UPDATE/DELETE filter to zero rows (USING).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name)
      VALUES ('10000000-0000-0000-0000-000000000001','SA-NEW','Site Admin Product');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_ins = RETURNED_SQLSTATE; END;
  UPDATE products SET name = 'renamed by pa' WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  DELETE FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  GET DIAGNOSTICS v_del = ROW_COUNT;
  RESET ROLE;
  -- Company admin: all three allowed.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO products (org_id, sku, name)
      VALUES ('10000000-0000-0000-0000-000000000001','CO-NEW','Company Product');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_ins_co = RETURNED_SQLSTATE; END;
  UPDATE products SET name = 'renamed by a1' WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  GET DIAGNOSTICS v_upd_co = ROW_COUNT;
  DELETE FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  GET DIAGNOSTICS v_del_co = ROW_COUNT;
  RESET ROLE;
  IF v_ins = '42501' AND v_upd = 0 AND v_del = 0
     AND v_ins_co = 'no error' AND v_upd_co = 1 AND v_del_co = 1
  THEN RAISE NOTICE 'PASS P5';
  ELSE RAISE NOTICE 'FAIL P5: site(ins=% upd=% del=%) company(ins=% upd=% del=%) (want 42501/0/0 and no error/1/1)',
    v_ins, v_upd, v_del, v_ins_co, v_upd_co, v_del_co; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P5;

-- ---------------------------------------------------------------------------
-- P6 — delete_owned_row('product',...) is a company-admin act.
-- ---------------------------------------------------------------------------
\echo 'P6 ⭐: delete_owned_row(''product'',...) is refused to a site admin (not_permitted) and allowed to a company admin'
SAVEPOINT sp_P6;
DO $$
DECLARE v_site text := 'none'; v_left int; v_co text := 'none'; v_gone int;
BEGIN
  -- FREE is made only in Plant 1, which the Plant 1 admin administers — so the
  -- refusal is about the Split, not about reach.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000061a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('product','6a000000-0000-0000-0000-0000000000f4');
    v_site := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_site := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_left FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM delete_owned_row('product','6a000000-0000-0000-0000-0000000000f4');
    v_co := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_co := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_gone FROM products WHERE id = '6a000000-0000-0000-0000-0000000000f4';
  IF v_site = 'PT403' AND v_left = 1 AND v_co = 'allowed' AND v_gone = 0 THEN RAISE NOTICE 'PASS P6';
  ELSE RAISE NOTICE 'FAIL P6: site=% left_after_site=% company=% gone=% (want PT403/1/allowed/0)',
    v_site, v_left, v_co, v_gone; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL P6: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_P6;

-- ---------------------------------------------------------------------------
-- P7/P8/P9 — THE STRAND GUARD. Removing the last covering plant is blocked;
-- removing one while another still covers is allowed; adding never strands.
-- ---------------------------------------------------------------------------
\echo 'P7 ⭐⭐: removing the LAST plant that covers a scheduled run is refused (owner_change_blocked), and the place survives'
SAVEPOINT sp_P7;
DO $$
DECLARE v_state text := 'no error'; v_keys text := '-'; v_detail text; v_left int;
BEGIN
  RESET ROLE;
  -- SHARED is scheduled at Cell 1, which only its Plant 1 place covers (Plant P
  -- covers no Plant 1 node). Removing Plant 1 strands that run.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '6a000000-0000-0000-0000-0000000000f1'
       AND node_id = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_keys := coalesce((SELECT string_agg(k, ',' ORDER BY k)
                          FROM jsonb_object_keys(nullif(v_detail,'')::jsonb) k), '-');
  END;
  SELECT count(*) INTO v_left FROM product_sites
   WHERE product_id = '6a000000-0000-0000-0000-0000000000f1'
     AND node_id = '30000000-0000-0000-0000-000000000001';
  IF v_state = 'PT409' AND v_left = 1 AND v_keys = 'error,id,kind,removed_node_id,stranded'
  THEN RAISE NOTICE 'PASS P7';
  ELSE RAISE NOTICE 'FAIL P7: sqlstate=% place_left=% keys=% (want PT409, 1, error,id,kind,removed_node_id,stranded)',
    v_state, v_left, v_keys; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P7;

\echo 'P7b: removing a NON-covering plant (Plant P) from the same scheduled product strands nothing'
SAVEPOINT sp_P7b;
DO $$
DECLARE v_pp uuid; v_state text := 'no error'; v_left int;
BEGIN
  SELECT v INTO v_pp FROM p_fix WHERE k = 'pp';
  RESET ROLE;
  -- Plant P covers no Plant 1 node, so removing it cannot strand the Cell 1 run.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '6a000000-0000-0000-0000-0000000000f1' AND node_id = v_pp;
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_left FROM product_sites
   WHERE product_id = '6a000000-0000-0000-0000-0000000000f1' AND node_id = v_pp;
  IF v_state = 'no error' AND v_left = 0 THEN RAISE NOTICE 'PASS P7b';
  ELSE RAISE NOTICE 'FAIL P7b: state=% place_left=% (want no error, 0)', v_state, v_left; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P7b;

\echo 'P8 ⭐⭐: removing a covering plant is ALLOWED when another remaining plant still covers the run'
SAVEPOINT sp_P8;
DO $$
DECLARE v_state text := 'no error'; v_left int;
BEGIN
  RESET ROLE;
  -- COVER is scheduled at Cell 1 and made in BOTH Plant 1 and Assembly, each an
  -- ancestor of Cell 1. Removing the Plant 1 place leaves Assembly covering it.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '6a000000-0000-0000-0000-0000000000f3'
       AND node_id = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_left FROM product_sites
   WHERE product_id = '6a000000-0000-0000-0000-0000000000f3';
  -- Assembly remains, so the removal is clean and the run is still covered.
  IF v_state = 'no error' AND v_left = 1 THEN RAISE NOTICE 'PASS P8';
  ELSE RAISE NOTICE 'FAIL P8: state=% places_left=% (want no error, 1 — Assembly still covers Cell 1)', v_state, v_left; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P8;

\echo 'P9 ⭐: ADDING a plant to a scheduled product is never stranded; and the colour picker works with no owner'
SAVEPOINT sp_P9;
DO $$
DECLARE v_pq uuid; v_add text := 'no error'; v_tok text;
BEGIN
  SELECT v INTO v_pq FROM p_fix WHERE k = 'pq';
  RESET ROLE;
  -- The strand guard is BEFORE DELETE only — adding a maker cannot strand
  -- history, so extending SHARED to Plant Q is always allowed.
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-0000000000f1', v_pq);
  EXCEPTION WHEN OTHERS THEN v_add := SQLSTATE || ' ' || SQLERRM; END;
  -- D115: colour balances across the whole org's products and takes only the
  -- org now (one argument) — no owner scope.
  SELECT app_pick_product_color('10000000-0000-0000-0000-000000000001') INTO v_tok;
  IF v_add = 'no error' AND v_tok ~ '^product-[1-9][0-9]*$' THEN RAISE NOTICE 'PASS P9';
  ELSE RAISE NOTICE 'FAIL P9: add_plant=% colour=% (want no error and a product-N token)', v_add, v_tok; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_P9;

ROLLBACK;

\echo '61_product_places_test.sql complete (12 cases: P0-P9, with P3b and P7b)'
