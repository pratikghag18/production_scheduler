-- ============================================================================
-- 52_scope_and_colour_test.sql — migration 0025, D103: "belongs to" becomes a
-- SCOPE, and a colour may be a colour.
--
-- THE MAINTAINER'S WORDS (D103):
--   "The products/operators/shifts could belong to a particular hierarchy
--    within the plant and not necessarily to the whole plant... how do we
--    assign them to a specific hierarchy level so the lower levels inherit
--    them?"
--   "The color should show a colour picker and an ability to enter hex code."
--
-- ⭐⭐ WHAT THIS FILE IS ACTUALLY FOR, AND IT IS NOT THE OBVIOUS THING.
-- 0025 is a WIDENING. A widening is the one shape where a suite can go green
-- against a migration that went too far, because everything that used to be
-- legal is still legal and every existing case still passes. So more than half
-- the cases below assert what must STILL BE REFUSED — the org boundary, the
-- three near-miss colour spellings, the site admin who may not reach outside
-- their grant. **A test file for a widening that only tests the widening is a
-- test file that cannot fail in the direction that matters.**
--
-- ⭐ AND THE INHERITANCE RULE IS ASSERTED HERE EVEN THOUGH THE CLIENT
-- IMPLEMENTS IT. `target.path <@ scope.path` is a CONTRACT between this schema
-- and `src/features/admin/lib/scope.ts`, and 0024's whole lesson was that a
-- rule nobody asserts on the server is a rule the client is free to get wrong
-- quietly. S9-S11 pin the arithmetic in the place that owns the paths.
--
-- THE FIXTURE reuses 51's shape deliberately — two sites in ONE org, every
-- admin org-wide 'viewer' so `app_is_admin()` cannot short-circuit anything —
-- and adds the thing 51 had no use for: a DEEP chain under Plant 1, so
-- "scoped to a department" and "scoped to a line" are different answers.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE s_fix (k text primary key, v uuid);

DO $$
DECLARE v_dept uuid; v_line_a uuid; v_line_b uuid; v_cell_a uuid; v_cell_b uuid; v_p2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  -- A second site, built through the real RPC so it is a site made the way a
  -- real one is (0020 §10's copy-on-root-create included).
  v_p2 := (create_node(NULL, 'Plant 2 (S)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;

  -- ⭐ A DEEP CHAIN IS THE POINT. With only roots, "scoped to a node" and
  -- "scoped to a site" are the same fixture and every inheritance case below
  -- would pass against a migration that only ever accepted roots.
  v_dept   := (create_node('30000000-0000-0000-0000-000000000001', 'S Dept', 9)->>'id')::uuid;
  v_line_a := (create_node(v_dept, 'S Line A', 0)->>'id')::uuid;
  v_line_b := (create_node(v_dept, 'S Line B', 1)->>'id')::uuid;
  v_cell_a := (create_node(v_line_a, 'S Cell A', 0)->>'id')::uuid;
  v_cell_b := (create_node(v_line_b, 'S Cell B', 0)->>'id')::uuid;

  RESET ROLE;

  INSERT INTO s_fix (k, v) VALUES
    ('p2', v_p2), ('dept', v_dept), ('line_a', v_line_a), ('line_b', v_line_b),
    ('cell_a', v_cell_a), ('cell_b', v_cell_b);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_line_a uuid; v_dept uuid;
BEGIN
  SELECT v INTO v_line_a FROM s_fix WHERE k = 'line_a';
  SELECT v INTO v_dept   FROM s_fix WHERE k = 'dept';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000f1'),
    ('00000000-0000-0000-0000-0000000000f2'),
    ('00000000-0000-0000-0000-0000000000f3');

  -- Both org-wide 'viewer'. f1 administers the DEPARTMENT (mid-tree, which
  -- before 0020/0019 was not a thing anyone could be); f2 administers Plant 1.
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','viewer'),
    ('f0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','viewer'),
    ('f0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f3','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001', v_dept, '10000000-0000-0000-0000-000000000001','admin'),
    ('f0000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin'),
    -- A SUPERVISOR on the same department f1 administers. S8 needs someone who
    -- can SEE the row and still may not write it; anyone who cannot see it
    -- would be refused one layer earlier and prove nothing about the policy.
    ('f0000000-0000-0000-0000-000000000003', v_dept, '10000000-0000-0000-0000-000000000001','supervisor');

  -- One product scoped to a LINE, one to the DEPARTMENT above it, one to the
  -- PLANT ROOT above that. Three answers to "is this offered at Cell A", and
  -- ⭐ the third used to be company-wide (NULL) -- 0028/D108 abolished that
  -- state, so the widest scope this file can express is now the root.
  INSERT INTO products (id, org_id, sku, name, site_node_id) VALUES
    ('61000000-0000-0000-0000-00000000ff01','10000000-0000-0000-0000-000000000001','SLA','S Line A Product', v_line_a),
    ('61000000-0000-0000-0000-00000000ff02','10000000-0000-0000-0000-000000000001','SDP','S Dept Product',   v_dept),
    ('61000000-0000-0000-0000-00000000ff03','10000000-0000-0000-0000-000000000001','SCW','S Plant-wide Product', '30000000-0000-0000-0000-000000000001'::uuid),
    -- Scoped to the OTHER site. S18 needs a product that must never be OFFERED
    -- under plant_1 and must still be RETURNED by the read.
    ('61000000-0000-0000-0000-00000000ff04','10000000-0000-0000-0000-000000000001','SP2','S Plant 2 Product',
     (SELECT v FROM s_fix WHERE k = 'p2'));

  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
    ('51000000-0000-0000-0000-00000000ff01','10000000-0000-0000-0000-000000000001','S Line A Person', v_line_a);

  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('41000000-0000-0000-0000-00000000ff01','10000000-0000-0000-0000-000000000001','S Line A Training', v_line_a);

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('71000000-0000-0000-0000-00000000ff01','10000000-0000-0000-0000-000000000001','S Line A Pattern', v_line_a);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- ---------------------------------------------------------------------------
-- S0 — the fixture itself. D86's corollary: an id typo is indistinguishable
-- from the behaviour under test whenever the honest answer can be empty.
-- ---------------------------------------------------------------------------
\echo 'S0: the fixture is well-formed — a chain four deep, two branches, and a mid-tree admin who is org-wide viewer'
SAVEPOINT sp_S0;
DO $$
DECLARE v_depth int; v_branches int; v_admins int; v_scoped int;
BEGIN
  SELECT nlevel(path) INTO v_depth FROM nodes WHERE id = (SELECT v FROM s_fix WHERE k = 'cell_a');
  SELECT count(*) INTO v_branches FROM nodes WHERE parent_id = (SELECT v FROM s_fix WHERE k = 'dept');
  SELECT count(*) INTO v_admins FROM user_profiles WHERE id::text LIKE 'f0000000%' AND role = 'admin';
  SELECT count(*) INTO v_scoped FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku IN ('SLA','SDP','SCW','SP2');
  IF v_depth = 4 AND v_branches = 2 AND v_admins = 0 AND v_scoped = 4
  THEN RAISE NOTICE 'PASS S0';
  ELSE RAISE NOTICE 'FAIL S0: depth=% branches=% org_wide_admins=% products=% (want 4, 2, 0, 4)',
    v_depth, v_branches, v_admins, v_scoped; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S0;

-- ---------------------------------------------------------------------------
-- THE WIDENING — every level is now a legal scope.
-- ---------------------------------------------------------------------------
\echo 'S1: a product can belong to a LINE, four levels down'
SAVEPOINT sp_S1;
DO $$
DECLARE v_line_a uuid; v_got uuid; v_err text := NULL;
BEGIN
  SELECT v INTO v_line_a FROM s_fix WHERE k = 'line_a';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE products SET site_node_id = v_line_a WHERE id = '61000000-0000-0000-0000-00000000ff03';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE; END;
  SELECT site_node_id INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff03';
  RESET ROLE;
  -- Asserts the STATE, not merely the absence of an error: a `USING` clause
  -- refuses by matching zero rows, which from out here looks like success.
  IF v_err IS NULL AND v_got = v_line_a THEN RAISE NOTICE 'PASS S1';
  ELSE RAISE NOTICE 'FAIL S1: sqlstate=% scope=% (want no error, scope = the line)', v_err, v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S1;

\echo 'S2: so can an operator, a training and a shift pattern — all four tables share one trigger'
SAVEPOINT sp_S2;
DO $$
DECLARE v_cell_b uuid; v_o uuid; v_s uuid; v_t uuid;
BEGIN
  SELECT v INTO v_cell_b FROM s_fix WHERE k = 'cell_b';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  UPDATE operators       SET site_node_id = v_cell_b WHERE id = '51000000-0000-0000-0000-00000000ff01';
  UPDATE skills          SET site_node_id = v_cell_b WHERE id = '41000000-0000-0000-0000-00000000ff01';
  UPDATE shift_templates SET site_node_id = v_cell_b WHERE id = '71000000-0000-0000-0000-00000000ff01';
  SELECT site_node_id INTO v_o FROM operators       WHERE id = '51000000-0000-0000-0000-00000000ff01';
  SELECT site_node_id INTO v_s FROM skills          WHERE id = '41000000-0000-0000-0000-00000000ff01';
  SELECT site_node_id INTO v_t FROM shift_templates WHERE id = '71000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  -- All four tables, because 0025 changes ONE function and four triggers call
  -- it. A case that only walked `products` would pass if three of the four
  -- triggers had been dropped.
  IF v_o = v_cell_b AND v_s = v_cell_b AND v_t = v_cell_b THEN RAISE NOTICE 'PASS S2';
  ELSE RAISE NOTICE 'FAIL S2: operator=% training=% pattern=% (want all = the cell)', v_o, v_s, v_t; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S2;

\echo 'S3 ⭐ (inverted by 0028): NULL no longer means company-wide — it is refused, because there is no company-wide'
SAVEPOINT sp_S3;
DO $$
DECLARE v_got uuid; v_err text := NULL;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE products SET site_node_id = NULL WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE; END;
  SELECT site_node_id INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  -- ⭐⭐ INVERTED BY 0028. 0025 widened the scope picker so a site admin could
  -- clear a product back to company-wide, and S3 asserted that widening. D108
  -- removes the destination: there is nowhere to clear it TO. The refusal is
  -- the NOT NULL constraint itself (23502), and the row must be untouched --
  -- asserting only the error would pass if the update half-applied.
  IF v_err = '23502' AND v_got IS NOT NULL THEN RAISE NOTICE 'PASS S3';
  ELSE RAISE NOTICE 'FAIL S3: sqlstate=% scope=% (want 23502, unchanged)', v_err, v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S3;

-- ---------------------------------------------------------------------------
-- WHAT MUST STILL BE REFUSED. More than half this file, on purpose — see the
-- header. A widening is the shape where the suite goes green over a migration
-- that went too far.
-- ---------------------------------------------------------------------------
\echo 'S4: a node in ANOTHER ORG is still refused, and the reason still says "not found"'
SAVEPOINT sp_S4;
DO $$
DECLARE v_detail jsonb; v_raw text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- Org 2's root. It exists; it is not in this org. This is the ONLY refusal
    -- branch the trigger has left, which makes it load-bearing rather than one
    -- of two — the org scope is now the whole of what this function protects.
    UPDATE products SET site_node_id = '3000000b-0000-0000-0000-000000000001'
     WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS S4';
  ELSE RAISE NOTICE 'FAIL S4: detail=% (want invalid_argument / not found)', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S4;

\echo 'S5: a node id that exists NOWHERE is refused the same way'
SAVEPOINT sp_S5;
DO $$
DECLARE v_detail jsonb; v_raw text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE products SET site_node_id = '3fffffff-ffff-ffff-ffff-ffffffffffff'
     WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'reason' = 'not found' THEN RAISE NOTICE 'PASS S5';
  ELSE RAISE NOTICE 'FAIL S5: detail=% (want not found)', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S5;

\echo 'S6: a DEPARTMENT admin may scope a product to a line inside their grant'
SAVEPOINT sp_S6;
DO $$
DECLARE v_line_b uuid; v_got uuid; v_rows int;
BEGIN
  SELECT v INTO v_line_b FROM s_fix WHERE k = 'line_b';
  -- ⭐ f1 is an admin of the DEPARTMENT and an org-wide VIEWER. Before 0019
  -- there was no such person; after 0025 they are the whole point of the
  -- feature. `app_is_admin()` cannot short-circuit anything for them.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  UPDATE products SET site_node_id = v_line_b WHERE id = '61000000-0000-0000-0000-00000000ff01';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT site_node_id INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF v_rows = 1 AND v_got = v_line_b THEN RAISE NOTICE 'PASS S6';
  ELSE RAISE NOTICE 'FAIL S6: rows=% scope=% (want 1 and the line)', v_rows, v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S6;

\echo 'S7: that same admin may NOT touch a row outside their grant — and it is the POLICY that says so, silently'
SAVEPOINT sp_S7;
DO $$
DECLARE v_p2 uuid; v_line_b uuid; v_rows int; v_got uuid; v_err text := NULL;
BEGIN
  SELECT v INTO v_p2     FROM s_fix WHERE k = 'p2';
  SELECT v INTO v_line_b FROM s_fix WHERE k = 'line_b';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- ⚠️ THE TARGET VALUE MUST BE ONE THE ROW DOES NOT ALREADY HOLD. Written
    -- first as "set Plant 2's product to Plant 2", which the fixture had
    -- already done — so the case passed or failed on whether a no-op is a
    -- refusal, which is not the question. Rule 3b: measure whether the fixture
    -- can deliver the claim in the case's name. It moves toward the admin's
    -- OWN line, which is the tempting direction and still not theirs to do.
    UPDATE products SET site_node_id = v_line_b WHERE id = '61000000-0000-0000-0000-00000000ff04';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE; END;
  RESET ROLE;
  SELECT site_node_id INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff04';
  -- ⚠️ 0023's lesson, and §19.63's: a `USING` clause FILTERS. The refusal is
  -- zero rows and NO error, so asserting "it threw" would fail against correct
  -- code and asserting "rows = 0" alone cannot tell a refusal from a no-op.
  -- All three: no error, no rows, and the value still where it was.
  IF v_err IS NULL AND v_rows = 0 AND v_got = v_p2
  THEN RAISE NOTICE 'PASS S7';
  ELSE RAISE NOTICE 'FAIL S7: sqlstate=% rows=% scope=% (want no error, 0 rows, still Plant 2)',
    v_err, v_rows, v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S7;

\echo 'S8: and the widening did NOT hand a supervisor the pencil'
SAVEPOINT sp_S8;
DO $$
DECLARE v_line_a uuid; v_rows int;
BEGIN
  SELECT v INTO v_line_a FROM s_fix WHERE k = 'line_a';
  -- f3: a SUPERVISOR on the department, org-wide viewer, not an admin anywhere.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  UPDATE products SET site_node_id = v_line_a WHERE id = '61000000-0000-0000-0000-00000000ff01';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows = 0 THEN RAISE NOTICE 'PASS S8';
  ELSE RAISE NOTICE 'FAIL S8: rows=% (want 0 — a supervisor is not an admin)', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S8;

-- ---------------------------------------------------------------------------
-- THE INHERITANCE ARITHMETIC — the contract the client implements.
-- ---------------------------------------------------------------------------
\echo 'S9: a scope covers everything at or below it, and nothing beside it'
SAVEPOINT sp_S9;
DO $$
DECLARE v_line_a uuid; v_cell_a uuid; v_cell_b uuid;
        v_self boolean; v_below boolean; v_sibling boolean; v_above boolean;
BEGIN
  SELECT v INTO v_line_a FROM s_fix WHERE k = 'line_a';
  SELECT v INTO v_cell_a FROM s_fix WHERE k = 'cell_a';
  SELECT v INTO v_cell_b FROM s_fix WHERE k = 'cell_b';
  -- `<@` is REFLEXIVE, and that is load-bearing: a product scoped to Line A is
  -- offered ON Line A, not only under it. An implementation using a strict
  -- descendant test passes every other case in this file.
  SELECT t.path <@ s.path INTO v_self
    FROM nodes t, nodes s WHERE t.id = v_line_a AND s.id = v_line_a;
  SELECT t.path <@ s.path INTO v_below
    FROM nodes t, nodes s WHERE t.id = v_cell_a AND s.id = v_line_a;
  SELECT t.path <@ s.path INTO v_sibling
    FROM nodes t, nodes s WHERE t.id = v_cell_b AND s.id = v_line_a;
  SELECT t.path <@ s.path INTO v_above
    FROM nodes t, nodes s WHERE t.id = (SELECT v FROM s_fix WHERE k = 'dept') AND s.id = v_line_a;
  IF v_self AND v_below AND NOT v_sibling AND NOT v_above THEN RAISE NOTICE 'PASS S9';
  ELSE RAISE NOTICE 'FAIL S9: self=% below=% sibling=% above=% (want t,t,f,f)',
    v_self, v_below, v_sibling, v_above; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S9;

\echo 'S10: the nearer scope wins nothing — every covering scope applies, unlike a shift pattern'
SAVEPOINT sp_S10;
DO $$
DECLARE v_cell_a uuid; v_n int;
BEGIN
  SELECT v INTO v_cell_a FROM s_fix WHERE k = 'cell_a';
  -- ⚠️ THE ONE PLACE THIS DIFFERS FROM `resolve_shift_template`, and it is
  -- worth a case because the two rules look identical from a distance. A node
  -- runs exactly ONE shift pattern, so that resolution is nearest-ancestor-WINS.
  -- A node can offer MANY products, so this is nearest-ancestor-UNION: the line
  -- product, the department product above it and the company-wide one are all
  -- offered at Cell A. Anyone reusing `resolve_shift_template`'s ORDER BY /
  -- LIMIT 1 shape here would silently offer one product out of three.
  SELECT count(*) INTO v_n
    FROM products p
    LEFT JOIN nodes s ON s.id = p.site_node_id
   WHERE p.org_id = '10000000-0000-0000-0000-000000000001'
     AND p.sku IN ('SLA','SDP','SCW')
     AND (p.site_node_id IS NULL
          OR (SELECT t.path FROM nodes t WHERE t.id = v_cell_a) <@ s.path);
  IF v_n = 3 THEN RAISE NOTICE 'PASS S10';
  ELSE RAISE NOTICE 'FAIL S10: offered=% (want 3 — line, department and company-wide all apply)', v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S10;

\echo 'S11: and a cell on the OTHER line is offered two of the three, not three'
SAVEPOINT sp_S11;
DO $$
DECLARE v_cell_b uuid; v_n int; v_skus text;
BEGIN
  SELECT v INTO v_cell_b FROM s_fix WHERE k = 'cell_b';
  -- The half S10 cannot see. If the predicate were `true` for everything, S10
  -- would still report 3 and pass.
  SELECT count(*), string_agg(p.sku, ',' ORDER BY p.sku) INTO v_n, v_skus
    FROM products p
    LEFT JOIN nodes s ON s.id = p.site_node_id
   WHERE p.org_id = '10000000-0000-0000-0000-000000000001'
     AND p.sku IN ('SLA','SDP','SCW')
     AND (p.site_node_id IS NULL
          OR (SELECT t.path FROM nodes t WHERE t.id = v_cell_b) <@ s.path);
  IF v_n = 2 AND v_skus = 'SCW,SDP' THEN RAISE NOTICE 'PASS S11';
  ELSE RAISE NOTICE 'FAIL S11: offered=% (%) (want 2: SCW,SDP — Line A''s product must not reach Line B)',
    v_n, v_skus; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S11;

-- ---------------------------------------------------------------------------
-- COLOUR — the union, and the three near-misses.
-- ---------------------------------------------------------------------------
\echo 'S12: a lower-case six-digit hex is stored as written'
SAVEPOINT sp_S12;
DO $$
DECLARE v_got text;
BEGIN
  RESET ROLE;
  UPDATE products SET color_token = '#1baf7a' WHERE id = '61000000-0000-0000-0000-00000000ff01';
  SELECT color_token INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff01';
  IF v_got = '#1baf7a' THEN RAISE NOTICE 'PASS S12';
  ELSE RAISE NOTICE 'FAIL S12: stored=% (want #1baf7a)', v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S12;

\echo 'S13: a palette token is still stored, so the union really is a union'
SAVEPOINT sp_S13;
DO $$
DECLARE v_got text;
BEGIN
  RESET ROLE;
  UPDATE products SET color_token = 'product-3' WHERE id = '61000000-0000-0000-0000-00000000ff01';
  SELECT color_token INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff01';
  IF v_got = 'product-3' THEN RAISE NOTICE 'PASS S13';
  ELSE RAISE NOTICE 'FAIL S13: stored=% (want product-3)', v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S13;

\echo 'S14: five near-miss spellings are still refused, and NULL still is too'
SAVEPOINT sp_S14;
DO $$
DECLARE v_short text := NULL; v_upper text := NULL; v_named text := NULL;
        v_hash text := NULL; v_inside text := NULL; v_null text := NULL;
BEGIN
  RESET ROLE;
  -- ⭐ THIS IS THE CASE THAT FAILS IF SOMEONE "SIMPLIFIES" THE CHECK. A widened
  -- constraint can stop rejecting anything at all and every other case in this
  -- file still passes. One canonical spelling per colour is what stops `#FFF`,
  -- `#ffffff` and `white` being three rows that mean one thing.
  BEGIN UPDATE products SET color_token = '#1ba'    WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_short = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = '#1BAF7A' WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_upper = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = 'teal'    WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_named = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = '1baf7a'  WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hash = RETURNED_SQLSTATE; END;
  -- ⭐ FOUND BY MUTATION S8, NOT BY READING. Dropping the `^` and `$` anchors
  -- from the hex arm went NOT CAUGHT: every other spelling in this case fails
  -- for the wrong reason (no `#`, wrong length, no hex digits at all), so none
  -- of them can tell an ANCHORED pattern from a CONTAINS one. A string that
  -- holds a perfectly good hex and is not one is the only input that separates
  -- them -- and it is exactly what a paste from a design tool looks like.
  BEGIN UPDATE products SET color_token = 'teal #1baf7a' WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_inside = RETURNED_SQLSTATE; END;
  BEGIN UPDATE products SET color_token = NULL      WHERE id = '61000000-0000-0000-0000-00000000ff01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_null = RETURNED_SQLSTATE; END;
  IF v_short = '23514' AND v_upper = '23514' AND v_named = '23514' AND v_hash = '23514'
     AND v_inside = '23514' AND v_null = '23502'
  THEN RAISE NOTICE 'PASS S14';
  ELSE RAISE NOTICE 'FAIL S14: short=% upper=% named=% no_hash=% embedded=% null=% (want five 23514 then 23502)',
    v_short, v_upper, v_named, v_hash, v_inside, v_null; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S14;

\echo 'S15: the trigger still writes a TOKEN on insert — a hex is only ever a human choice'
SAVEPOINT sp_S15;
DO $$
DECLARE v_got text;
BEGIN
  RESET ROLE;
  INSERT INTO products (org_id, sku, name, site_node_id)
    VALUES ('10000000-0000-0000-0000-000000000001','SNEW','S New Product', '30000000-0000-0000-0000-000000000001'::uuid);
  SELECT color_token INTO v_got FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku = 'SNEW';
  -- ⭐ D102 SURVIVES 0025 INTACT. Widening what the column ACCEPTS must not
  -- change what the system CHOOSES. If this ever returns a hex, something has
  -- taught the automatic picker to invent colours.
  IF v_got ~ '^product-[1-9][0-9]*$' THEN RAISE NOTICE 'PASS S15';
  ELSE RAISE NOTICE 'FAIL S15: auto-assigned=% (want a product-N token)', v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S15;

\echo 'S16: and a hand-set hex survives a rename — the trigger is INSERT-only'
SAVEPOINT sp_S16;
DO $$
DECLARE v_got text;
BEGIN
  RESET ROLE;
  UPDATE products SET color_token = '#eda100' WHERE id = '61000000-0000-0000-0000-00000000ff01';
  UPDATE products SET name = 'S Renamed'      WHERE id = '61000000-0000-0000-0000-00000000ff01';
  SELECT color_token INTO v_got FROM products WHERE id = '61000000-0000-0000-0000-00000000ff01';
  IF v_got = '#eda100' THEN RAISE NOTICE 'PASS S16';
  ELSE RAISE NOTICE 'FAIL S16: after rename=% (want #eda100 — a rename must not re-colour)', v_got; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S16;

-- ---------------------------------------------------------------------------
-- THE READ — the client cannot filter by a scope it is never told.
-- ---------------------------------------------------------------------------
\echo 'S17: board_window reports where each product, person and training belongs'
SAVEPOINT sp_S17;
DO $$
DECLARE v_w jsonb; v_line_a uuid;
        v_prod_has boolean; v_op_has boolean; v_skill_has boolean;
BEGIN
  SELECT v INTO v_line_a FROM s_fix WHERE k = 'line_a';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_w := board_window('plant_1', now() - interval '1 day', now() + interval '1 day');
  RESET ROLE;

  -- ⚠️ ASSERTS THE VALUE, NOT THE KEY'S PRESENCE. `jsonb_build_object` will
  -- happily emit `"site_node_id": null` for every row if the column reference
  -- is wrong, and a `? 'site_node_id'` test passes against exactly that.
  SELECT (e->>'site_node_id')::uuid = v_line_a INTO v_prod_has
    FROM jsonb_array_elements(v_w->'products') e WHERE e->>'sku' = 'SLA';
  SELECT (e->>'site_node_id')::uuid = v_line_a INTO v_op_has
    FROM jsonb_array_elements(v_w->'operators') e WHERE e->>'display_name' = 'S Line A Person';
  SELECT (e->>'site_node_id')::uuid = v_line_a INTO v_skill_has
    FROM jsonb_array_elements(v_w->'skills') e WHERE e->>'name' = 'S Line A Training';

  IF v_prod_has AND v_op_has AND v_skill_has THEN RAISE NOTICE 'PASS S17';
  ELSE RAISE NOTICE 'FAIL S17: product=% operator=% training=% (want all true)',
    v_prod_has, v_op_has, v_skill_has; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S17;

\echo 'S18: and it still returns the WHOLE org — narrowing what is OFFERED must not un-schedule history'
SAVEPOINT sp_S18;
DO $$
DECLARE v_w jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_w := board_window('plant_1', now() - interval '1 day', now() + interval '1 day');
  RESET ROLE;
  -- ⚠️ THIS CASE ASKS AS THE COMPANY ADMIN (a1), so after 0026 it can only
  -- catch a filter added INSIDE `board_window` — it cannot catch one added in
  -- the POLICIES, because a company admin passes those. That half is measured
  -- in `53_read_scoping_test.sql` R9/R10/R11, which ask as a site admin whose
  -- plant does not own the product but whose board carries it. Both halves are
  -- needed and neither subsumes the other; this comment exists so the next
  -- person does not read a green S18 as covering more than it does.
  -- ⭐⭐ THE CASE THAT STOPS THE OBVIOUS "IMPROVEMENT". Someone will eventually
  -- read D103 and move the filter into this function. If they do, a run that
  -- legitimately carried a product before it was re-scoped renders with no
  -- product at all -- scoping what is OFFERED must never change what the board
  -- can DRAW. Plant 2's product has no business being offered under plant_1 and
  -- must still be RETURNED.
  SELECT count(*) INTO v_n
    FROM jsonb_array_elements(v_w->'products') e WHERE e->>'sku' = 'SP2';
  IF v_n = 1 THEN RAISE NOTICE 'PASS S18';
  ELSE RAISE NOTICE 'FAIL S18: plant-2 product returned % times (want 1 — the read is not the picker)', v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_S18;

ROLLBACK;
