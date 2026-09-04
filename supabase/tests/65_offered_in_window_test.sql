-- ============================================================================
-- 65_offered_in_window_test.sql — migration 0042, "the board is told which
-- parts it may offer, instead of working it out from a list it cannot see all
-- of." (DEF-0005)
--
-- THE DEFECT THIS FILE EXISTS FOR. A supervisor granted a DEPARTMENT opened her
-- own board. Its legend showed four parts; her Product dropdown offered one;
-- and the server, asked about her own cell, accepted all four. The cause was
-- not the rule but its MATERIAL: `product_sites` is RLS-filtered on read and
-- reading is downward from a grant, so a part made at the PLANT above her had
-- its only place row dropped before it reached her client, which then read "no
-- places" as "made nowhere".
--
-- ⭐ SO THESE CASES ARE ABOUT THE GAP BETWEEN TWO ANSWERS, and X1 is the whole
-- defect in one comparison: for the same part, the same person and the same
-- cell, the readable place list is EMPTY while `app_product_offered_at` says
-- TRUE. A test that only asked the second would have passed all along — the
-- server was always right. What was missing was anything asking whether the
-- CLIENT was told enough to agree with it.
--
-- ⚠️ AS `authenticated`, WHEREVER RLS IS THE POINT. psql connects as the
-- superuser, who bypasses RLS entirely; a case about a filtered list that
-- forgets to switch role is measuring nothing. X1 and X2 switch and reset.
--
-- ⚠️ AND THE SECURITY HALF IS NOT AN AFTERTHOUGHT. `app_offered_product_nodes`
-- is SECURITY DEFINER: it bypasses RLS on `product_sites` on purpose, so it
-- must not bypass it on `nodes`. X4–X6 are the cases that would catch it
-- becoming a way to enumerate a department, a plant, or another tenant.
--
-- Fixture is the seed's, and it happens to be the defect's own shape: org 1's
-- four products are all made at `plant_1`, a1 is the company admin granted
-- `plant_1`, and a2 is a supervisor granted `plant_1.assembly` — a department,
-- below the only place any part is made. a3 is granted `plant_1.machining`, the
-- sibling. Org 2 uses THE SAME PATHS, which is what makes X6 real. X0 asserts
-- the grants the rest of the file rests on, the way 63 does.
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed.
-- ============================================================================

BEGIN;

\echo 'X0: a2 is a supervisor who can read her department and NOT the plant above it'
SAVEPOINT sp_X0;
DO $$
DECLARE v_role text; v_can_dept boolean; v_can_plant boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SELECT role INTO v_role FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  SELECT app_can_read_node(id) INTO v_can_dept
    FROM nodes WHERE org_id = app_current_org() AND path = 'plant_1.assembly'::ltree;
  SELECT app_can_read_node(id) INTO v_can_plant
    FROM nodes WHERE org_id = app_current_org() AND path = 'plant_1'::ltree;
  IF v_role = 'supervisor' AND v_can_dept AND NOT v_can_plant
  THEN RAISE NOTICE 'PASS X0';
  ELSE RAISE NOTICE 'FAIL X0: role=% (want supervisor) can_dept=% (want t) can_plant=% (want f)',
    v_role, v_can_dept, v_can_plant; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X0;

\echo 'X1 ⭐ THE DEFECT: the places she can read are NONE, while the server offers the part at her own cell'
SAVEPOINT sp_X1;
DO $$
DECLARE v_places int; v_offered boolean; v_cell uuid; v_product uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO v_cell FROM nodes
   WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_1.cell_1'::ltree;
  SELECT id INTO v_product FROM products WHERE org_id = app_current_org() AND sku = 'WX';
  -- What she can READ about where it is made: nothing. It is made at the plant
  -- and she is granted a department, and reading is downward from a grant.
  SELECT count(*) INTO v_places FROM product_sites ps WHERE ps.product_id = v_product;
  -- What the server ANSWERS about her own cell.
  SELECT app_product_offered_at(v_product, v_cell) INTO v_offered;
  RESET ROLE;
  IF v_places = 0 AND v_offered
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: readable_places=% (want 0) offered=% (want t)', v_places, v_offered; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2 ⭐ THE FIX: board_window tells her that EVERY part on her board is offered at her cell'
SAVEPOINT sp_X2;
DO $$
DECLARE v_win jsonb; v_cell text; v_offered int; v_total int; v_places int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT id::text INTO v_cell FROM nodes
   WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_1.cell_1'::ltree;
  v_win := board_window('plant_1.assembly'::ltree, now(), now() + interval '1 day');
  SELECT count(*) INTO v_total FROM jsonb_array_elements(v_win->'products');
  -- ⭐ COUNTING ALL OF THEM, NOT NAMING ONE. The reported symptom was "one part
  -- out of four", so a case that checked a single part could pass on the one
  -- that always worked.
  SELECT count(*) INTO v_offered
    FROM jsonb_array_elements(v_win->'products') p
   WHERE p->'offered_node_ids' ? v_cell;
  -- ⚠️ AND THE OLD FIELD IS STILL EMPTY, deliberately asserted: `site_node_ids`
  -- keeps its old meaning (the raw, reader-scoped place list) and is still
  -- unable to answer this question. If a later change "fixed" the defect by
  -- widening the read policy instead, this number would move and this case
  -- would say so rather than passing quietly.
  SELECT count(*) INTO v_places
    FROM jsonb_array_elements(v_win->'products') p
   WHERE jsonb_array_length(p->'site_node_ids') > 0;
  RESET ROLE;
  IF v_total = 4 AND v_offered = 4 AND v_places = 0
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: products=% (want 4) offered_at_her_cell=% (want 4) with_readable_places=% (want 0)',
    v_total, v_offered, v_places; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3 ⚠ the answer is still PER NODE: a part narrowed to one line is not offered on the next one'
SAVEPOINT sp_X3;
DO $$
DECLARE v_here boolean; v_there boolean; v_c1 uuid; v_c4 uuid; v_line1 uuid; v_product uuid;
BEGIN
  -- Asked as the company admin, so this case is about the RULE rather than
  -- about what anyone may see. Every seeded part is made at the plant, which is
  -- offered everywhere by construction — so this case NARROWS one to a single
  -- line first, inside the savepoint, and then asks about a cell on each line.
  -- Without that there is nothing here a "true for everything" bug would fail.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SELECT id INTO v_c1 FROM nodes WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_1.cell_1'::ltree;
  SELECT id INTO v_c4 FROM nodes WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_2.cell_4'::ltree;
  SELECT id INTO v_line1 FROM nodes WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_1'::ltree;
  SELECT id INTO v_product FROM products WHERE org_id = app_current_org() AND sku = 'WX';
  UPDATE product_sites SET node_id = v_line1 WHERE product_id = v_product;
  SELECT EXISTS (SELECT 1 FROM app_offered_product_nodes('plant_1'::ltree) op
                  WHERE op.product_id = v_product AND op.node_id = v_c1) INTO v_here;
  SELECT EXISTS (SELECT 1 FROM app_offered_product_nodes('plant_1'::ltree) op
                  WHERE op.product_id = v_product AND op.node_id = v_c4) INTO v_there;
  IF v_here AND NOT v_there
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: at_line_1_cell=% (want t) at_line_2_cell=% (want f)', v_here, v_there; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4 ⚠⚠ SECURITY DEFINER MUST NOT MEAN "reads everything": asking about the whole plant returns only her own nodes'
SAVEPOINT sp_X4;
DO $$
DECLARE v_outside int; v_inside int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  -- She asks about a root ABOVE her grant. Every row that comes back must be a
  -- node she may read; anything else makes this function a way to enumerate a
  -- plant she has no grant on — which is precisely the disclosure that widening
  -- `product_sites_select` would have caused, and the reason it was not.
  SELECT count(*) INTO v_outside
    FROM app_offered_product_nodes('plant_1'::ltree) op
    JOIN nodes n ON n.id = op.node_id
   WHERE NOT (n.path <@ 'plant_1.assembly'::ltree);
  SELECT count(*) INTO v_inside FROM app_offered_product_nodes('plant_1'::ltree);
  IF v_outside = 0 AND v_inside > 0
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: rows_outside_her_grant=% (want 0) rows_inside=% (want >0)', v_outside, v_inside; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5 ⚠ nor a way to look into the sibling department she has no grant on'
SAVEPOINT sp_X5;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SELECT count(*) INTO v_rows FROM app_offered_product_nodes('plant_1.machining'::ltree);
  IF v_rows = 0
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: rows=% (want 0)', v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;

\echo 'X6 ⚠⚠ nor across the tenant boundary — the other org uses the SAME paths'
SAVEPOINT sp_X6;
DO $$
DECLARE v_foreign int; v_own int;
BEGIN
  -- ⭐ THE PATHS COLLIDE ON PURPOSE, and that is migration 0012's whole lesson:
  -- paths are unique per (org_id, path), so 'plant_1' names a real node in BOTH
  -- orgs. A function that tested paths instead of org-scoped ids would answer
  -- here about the other tenant's plant. b2 is org 2's supervisor.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
  SELECT count(*) INTO v_foreign
    FROM app_offered_product_nodes('plant_1'::ltree) op
    JOIN nodes n ON n.id = op.node_id
   WHERE n.org_id <> app_current_org();
  SELECT count(*) INTO v_own FROM app_offered_product_nodes('plant_1'::ltree);
  IF v_foreign = 0 AND v_own > 0
  THEN RAISE NOTICE 'PASS X6';
  ELSE RAISE NOTICE 'FAIL X6: cross_tenant_rows=% (want 0) own_rows=% (want >0, or the case proves nothing)',
    v_foreign, v_own; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X6;

\echo 'X7: the admin''s own board is unchanged — the same parts offered at the same cell'
SAVEPOINT sp_X7;
DO $$
DECLARE v_win jsonb; v_cell text; v_offered int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT id::text INTO v_cell FROM nodes
   WHERE org_id = app_current_org() AND path = 'plant_1.assembly.line_1.cell_1'::ltree;
  v_win := board_window('plant_1'::ltree, now(), now() + interval '1 day');
  SELECT count(*) INTO v_offered
    FROM jsonb_array_elements(v_win->'products') p
   WHERE p->'offered_node_ids' ? v_cell;
  RESET ROLE;
  -- The four parts made at the plant, all of which cover this cell. Nobody's
  -- board loses anything: this migration only ever ADDS the answer.
  IF v_offered = 4
  THEN RAISE NOTICE 'PASS X7';
  ELSE RAISE NOTICE 'FAIL X7: offered_at_cell_1=% (want 4)', v_offered; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X7;

ROLLBACK;
