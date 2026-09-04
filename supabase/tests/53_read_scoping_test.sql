-- ============================================================================
-- 53_read_scoping_test.sql — migration 0026, D107: "ownership decides who may
-- READ, not only who may edit."
--
-- THE MAINTAINER'S WORDS (Aug 27, looking at the Products catalogue as the Plant 2
-- site admin):
--   "why am I seeing product which is assigned to Plant 1? No member from one
--    plant should see info for other plants, this is irrespective of whether
--    I'm in products or operators or shifts or anything."
--
-- ⭐ THE FIXTURE IS 51's, AND FOR 51's REASONS, WHICH ARE WORTH RESTATING
-- BECAUSE THEY ARE WHAT MAKES THIS FILE ABLE TO FAIL AT ALL:
--   * every site admin below holds the org-wide role 'viewer' — one org-wide
--     'admin' anywhere and `app_is_admin()` short-circuits every predicate
--     under test and the whole file passes against a migration that did
--     nothing;
--   * two sites in ONE org, because a cross-TENANT refusal proves nothing
--     about a cross-SITE one — org scoping already refuses it three layers
--     earlier;
--   * an owned AND an unowned row of every kind, because NULL is not an edge
--     case here, it is the company-wide default, and a fixture in which
--     everything is owned cannot tell "not your site's row" from "a
--     company-wide row" — two different answers through two branches.
--
-- ⭐⭐ AND ONE THING 51's FIXTURE DID NOT NEED AND THIS ONE DOES: A GRANT
-- *BELOW* AN OWNER. For OPERATORS/SKILLS/PATTERNS the read rule is
-- bidirectional (app_can_read_owned): "owner below your grant" is the site
-- admin looking down, "owner above your grant" is a line supervisor looking up.
-- ⭐ FOR PRODUCTS, D115 (0034) KEEPS THAT EITHER-DIRECTION READ — but it took a
-- SECURITY DEFINER helper to do it. A product is read through `app_can_read_product`,
-- which reads product_sites as the owner (bypassing product_sites_select's
-- DOWNWARD-only scope) and lets app_can_read_owned apply the bidirectional test.
-- So R4 holds the same shape as the single-owner rule did: g3 (admin on Assembly,
-- below the Plant 1 root) DOES see a part placed only at that root above them.
-- R17 keeps the downward direction. g3 and g4 (supervisor on the Plant 1 root)
-- are the two people who tell those apart. (An inline EXISTS in the policy had
-- RLS defeat the upward read; §8 of the migration records that fix.)
--
-- People (all org-wide 'viewer'):
--   g1  admin grant on plant_1        — site admin of Plant 1
--   g2  admin grant on plant_2        — site admin of Plant 2
--   g3  admin grant on assembly       — grant BELOW plant_1
--   g4  supervisor grant on plant_1   — not an admin anywhere
-- The seed supplies a1, an org-wide company admin.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE r_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL, 'Plant 2 (R)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,  'Fabrication R', 0)->>'id')::uuid;
  v_line := (create_node(v_dept,'Weld Line R',   0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO r_fix (k, v) VALUES ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_p2 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  SELECT v INTO v_p2 FROM r_fix WHERE k = 'p2';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000f1'),
    ('00000000-0000-0000-0000-0000000000f2'),
    ('00000000-0000-0000-0000-0000000000f3'),
    ('00000000-0000-0000-0000-0000000000f4');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001', v_org,'00000000-0000-0000-0000-0000000000f1','viewer'),
    ('f0000000-0000-0000-0000-000000000002', v_org,'00000000-0000-0000-0000-0000000000f2','viewer'),
    ('f0000000-0000-0000-0000-000000000003', v_org,'00000000-0000-0000-0000-0000000000f3','viewer'),
    ('f0000000-0000-0000-0000-000000000004', v_org,'00000000-0000-0000-0000-0000000000f4','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001', v_org,'admin'),
    ('f0000000-0000-0000-0000-000000000002', v_p2,                                  v_org,'admin'),
    ('f0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000002', v_org,'admin'),
    ('f0000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001', v_org,'supervisor');

  -- D115 (0034): a product's place is a product_sites row, not a column. Each
  -- product below is made in exactly ONE place, so app_can_read_owned(that place)
  -- answers exactly as the old single owner did — every read case's polarity is
  -- preserved by construction, and product_sites carries the owner the read rule
  -- now consults through products_select's EXISTS.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('60000000-0000-0000-0000-00000000ff01', v_org,'RP1','R P1 Product'),
    ('60000000-0000-0000-0000-00000000ff02', v_org,'RP2','R P2 Product'),
    -- ⭐ 0028/D108: THERE IS NO COMPANY-WIDE ROW ANY MORE. This row was NULL
    -- until 0028 and every case that used it asserted "everyone sees it".
    -- It is now made in LINE 1 -- a third scope, two levels down -- so the
    -- same cases now assert the opposite and the file keeps a row whose place
    -- is neither of the two plant roots.
    ('60000000-0000-0000-0000-00000000ff03', v_org,'RL1','R Line-1 Product'),
    -- ⭐ made in ASSEMBLY, strictly BELOW the Plant 1 root: the mirror of the
    -- row g3 uses. Without it, a rule written as "owner above me only" passes
    -- every other case in this file.
    ('60000000-0000-0000-0000-00000000ff04', v_org,'RSUB','R Sub-node Product');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org,'60000000-0000-0000-0000-00000000ff01','30000000-0000-0000-0000-000000000001'),
    (v_org,'60000000-0000-0000-0000-00000000ff02', v_p2),
    (v_org,'60000000-0000-0000-0000-00000000ff03','30000000-0000-0000-0000-000000000004'),
    (v_org,'60000000-0000-0000-0000-00000000ff04','30000000-0000-0000-0000-000000000002');

  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
    ('50000000-0000-0000-0000-00000000ff01', v_org,'R P1 Operator','30000000-0000-0000-0000-000000000001'::uuid),
    ('50000000-0000-0000-0000-00000000ff02', v_org,'R P2 Operator', v_p2),
    ('50000000-0000-0000-0000-00000000ff03', v_org,'R Line-1 Operator', '30000000-0000-0000-0000-000000000004'::uuid);

  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('40000000-0000-0000-0000-00000000ff01', v_org,'R P1 Training','30000000-0000-0000-0000-000000000001'::uuid),
    ('40000000-0000-0000-0000-00000000ff02', v_org,'R P2 Training', v_p2),
    ('40000000-0000-0000-0000-00000000ff03', v_org,'R Line-1 Training', '30000000-0000-0000-0000-000000000004'::uuid),
    -- A second PLANT 2 training that nobody holds. R12 needs a requirement
    -- the operator FAILS, and ff02 is the one they hold.
    ('40000000-0000-0000-0000-00000000ff05', v_org,'R P2 Training Two', v_p2);

  -- ⚠️ 0028 constrains this join too: a person may only hold a training on
  -- their own branch. The P1 operator (owner = Plant 1 root) may hold the
  -- Line-1 training because the two are comparable; the P2 operator may not,
  -- so they hold their own plant's. 55_'s N7 asserts the refusal.
  INSERT INTO operator_skills (org_id, operator_id, skill_id) VALUES
    (v_org,'50000000-0000-0000-0000-00000000ff01','40000000-0000-0000-0000-00000000ff03'),
    (v_org,'50000000-0000-0000-0000-00000000ff02','40000000-0000-0000-0000-00000000ff02');

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('70000000-0000-0000-0000-00000000ff01', v_org,'R P1 Pattern','30000000-0000-0000-0000-000000000001'::uuid),
    ('70000000-0000-0000-0000-00000000ff02', v_org,'R P2 Pattern', v_p2),
    ('70000000-0000-0000-0000-00000000ff03', v_org,'R Line-1 Pattern', '30000000-0000-0000-0000-000000000004'::uuid);

  INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
    ('71000000-0000-0000-0000-00000000ff01', v_org,'70000000-0000-0000-0000-00000000ff01','R Day', 360, 840),
    ('71000000-0000-0000-0000-00000000ff02', v_org,'70000000-0000-0000-0000-00000000ff02','R Day', 360, 840),
    ('71000000-0000-0000-0000-00000000ff03', v_org,'70000000-0000-0000-0000-00000000ff03','R Day', 360, 840);

  INSERT INTO shift_breaks (id, org_id, shift_id, name, start_min, end_min) VALUES
    ('72000000-0000-0000-0000-00000000ff01', v_org,'71000000-0000-0000-0000-00000000ff01','R Lunch', 600, 630),
    ('72000000-0000-0000-0000-00000000ff02', v_org,'71000000-0000-0000-0000-00000000ff02','R Lunch', 600, 630),
    ('72000000-0000-0000-0000-00000000ff03', v_org,'71000000-0000-0000-0000-00000000ff03','R Lunch', 600, 630);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

\echo 'R0: the fixture is well-formed — two sites in one org, EVERY row owned, and a grant BELOW an owner'
SAVEPOINT sp_R0;
DO $$
DECLARE v_p2 uuid; v_roots int; v_owned int; v_unowned int; v_orgadmins int; v_below int;
BEGIN
  SELECT v INTO v_p2 FROM r_fix WHERE k='p2';
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id='10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  -- D115: "owned" is now "has a place". Count this file's four products that
  -- carry at least one product_sites row, and any that carry none.
  SELECT count(*) INTO v_owned FROM products p
   WHERE p.org_id='10000000-0000-0000-0000-000000000001'
     AND p.id::text LIKE '60000000-0000-0000-0000-00000000ff%'
     AND EXISTS (SELECT 1 FROM product_sites ps WHERE ps.product_id = p.id);
  SELECT count(*) INTO v_unowned FROM products p
   WHERE p.org_id='10000000-0000-0000-0000-000000000001'
     AND p.id::text LIKE '60000000-0000-0000-0000-00000000ff%'
     AND NOT EXISTS (SELECT 1 FROM product_sites ps WHERE ps.product_id = p.id);
  -- ⭐ the short-circuit check: none of the four may be an org-wide admin
  SELECT count(*) INTO v_orgadmins FROM user_profiles
   WHERE id::text LIKE 'f0000000%' AND role = 'admin';
  -- ⭐ and g3's grant must be strictly BELOW the Plant 1 root, or the
  -- owner-above-you direction is never exercised by this file at all
  SELECT count(*) INTO v_below FROM profile_grants pg
    JOIN nodes gn ON gn.id = pg.node_id
    JOIN nodes rt ON rt.id = '30000000-0000-0000-0000-000000000001'
   WHERE pg.profile_id = 'f0000000-0000-0000-0000-000000000003'
     AND gn.path <@ rt.path AND gn.path <> rt.path;
  -- ⭐ 0028/D108 INVERTED THIS TERM. It used to demand at least one UNOWNED row,
  -- because company-wide was a state the file had to exercise. There is no such
  -- state now, and a fixture that still had one would mean the NOT NULL did not
  -- take -- so the same count is asserted at zero rather than deleted.
  IF v_roots >= 2 AND v_owned >= 2 AND v_unowned = 0 AND v_orgadmins = 0 AND v_below = 1
  THEN RAISE NOTICE 'PASS R0';
  ELSE RAISE NOTICE 'FAIL R0: roots=% owned=% unowned=% org_admins=% grant_below_root=% (want >=2,>=2,0,0,1)',
    v_roots, v_owned, v_unowned, v_orgadmins, v_below; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R0;

-- ---------------------------------------------------------------------------
-- The rule itself
-- ---------------------------------------------------------------------------
\echo 'R1: the Plant 2 site admin cannot LIST any Plant 1 row — product, person, training, pattern'
SAVEPOINT sp_R1;
DO $$
DECLARE p int; o int; s int; t int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p FROM products        WHERE id='60000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO o FROM operators       WHERE id='50000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO s FROM skills          WHERE id='40000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO t FROM shift_templates WHERE id='70000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF p=0 AND o=0 AND s=0 AND t=0 THEN RAISE NOTICE 'PASS R1';
  ELSE RAISE NOTICE 'FAIL R1: product=% operator=% training=% pattern=% (want all 0)', p,o,s,t; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R1;

\echo 'R2 ⭐ (rewritten by 0028): the row that USED to be company-wide is now owned by Line 1, and the Plant 2 admin sees none of it. D108: there is no row everybody can see.'
SAVEPOINT sp_R2;
DO $$
DECLARE p int; o int; s int; t int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p FROM products        WHERE id='60000000-0000-0000-0000-00000000ff03';
  SELECT count(*) INTO o FROM operators       WHERE id='50000000-0000-0000-0000-00000000ff03';
  SELECT count(*) INTO s FROM skills          WHERE id='40000000-0000-0000-0000-00000000ff03';
  SELECT count(*) INTO t FROM shift_templates WHERE id='70000000-0000-0000-0000-00000000ff03';
  RESET ROLE;
  IF p=0 AND o=0 AND s=0 AND t=0 THEN RAISE NOTICE 'PASS R2';
  ELSE RAISE NOTICE 'FAIL R2: product=% operator=% training=% pattern=% (want all 0)', p,o,s,t; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R2;

\echo 'R3: and the Plant 1 site admin still sees their own — the narrowing must not eat the owner'
SAVEPOINT sp_R3;
DO $$
DECLARE p int; o int; s int; t int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p FROM products        WHERE id='60000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO o FROM operators       WHERE id='50000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO s FROM skills          WHERE id='40000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO t FROM shift_templates WHERE id='70000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF p=1 AND o=1 AND s=1 AND t=1 THEN RAISE NOTICE 'PASS R3';
  ELSE RAISE NOTICE 'FAIL R3: product=% operator=% training=% pattern=% (want all 1)', p,o,s,t; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R3;

\echo 'R4 ⭐⭐ (D115): a product whose ONLY place is ABOVE your grant IS visible — the either-direction read of D108 survives, now over the list. The other plant is still not.'
SAVEPOINT sp_R4;
DO $$
DECLARE p1 int; p2 int;
BEGIN
  -- ⭐⭐ THIS IS D108's EITHER-DIRECTION READ, PRESERVED ACROSS D115, AND IT COST
  -- A REGRESSION TO GET RIGHT. products_select reads a product through
  -- `app_can_read_product` (0034 §8), a SECURITY DEFINER function whose
  -- `from product_sites` bypasses product_sites_select's DOWNWARD-only scope and
  -- lets `app_can_read_owned` apply the bidirectional grant test. So g3 (admin on
  -- Assembly, BELOW the Plant 1 root) CAN read RP1, whose sole place is the Plant
  -- 1 ROOT above them -- a plant-wide part is offered down to their area, so they
  -- must see it. RP2's only place is the OTHER plant, off g3's branch entirely, so
  -- that one stays invisible. ⚠️ An earlier cut wrote the EXISTS inline in the
  -- policy; RLS then applied to it and hid the place above the grant, so g3 saw
  -- RP1's runs but read "(unknown product)" for the part. §8's header records the
  -- fix; this case is what would go red if it were reverted.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p1 FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';  -- placed at the root ABOVE them
  SELECT count(*) INTO p2 FROM products WHERE id='60000000-0000-0000-0000-00000000ff02';  -- the other plant
  RESET ROLE;
  IF p1=1 AND p2=0 THEN RAISE NOTICE 'PASS R4';
  ELSE RAISE NOTICE 'FAIL R4: place-above-grant=% other-plant=% (want 1,0 — either-direction read survives, other plant does not)', p1, p2; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R4;

\echo 'R5: a SUPERVISOR grant reads the same as an admin one — visibility comes from the grant, not the role'
SAVEPOINT sp_R5;
DO $$
DECLARE p1 int; p2 int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f4', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p1 FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO p2 FROM products WHERE id='60000000-0000-0000-0000-00000000ff02';
  RESET ROLE;
  IF p1=1 AND p2=0 THEN RAISE NOTICE 'PASS R5';
  ELSE RAISE NOTICE 'FAIL R5: own-plant=% other-plant=% (want 1,0)', p1, p2; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R5;

\echo 'R6: the company admin still sees everything'
SAVEPOINT sp_R6;
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM products WHERE id IN
    ('60000000-0000-0000-0000-00000000ff01','60000000-0000-0000-0000-00000000ff02','60000000-0000-0000-0000-00000000ff03');
  RESET ROLE;
  IF n=3 THEN RAISE NOTICE 'PASS R6'; ELSE RAISE NOTICE 'FAIL R6: saw % of 3', n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R6;

-- ---------------------------------------------------------------------------
-- The dependent tables. 0023 gave these no owner column of their own, so each
-- must ask its PARENT. A row joining a Plant-1 operator to a company-wide
-- training has no derivable owner — which is why it follows the OPERATOR.
-- ---------------------------------------------------------------------------
\echo 'R7: shifts follow their pattern, and breaks follow their shift'
SAVEPOINT sp_R7;
DO $$
DECLARE s_own int; s_other int; b_own int; b_other int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO s_own   FROM shifts       WHERE id='71000000-0000-0000-0000-00000000ff02';
  SELECT count(*) INTO s_other FROM shifts       WHERE id='71000000-0000-0000-0000-00000000ff01';
  SELECT count(*) INTO b_own   FROM shift_breaks WHERE id='72000000-0000-0000-0000-00000000ff02';
  SELECT count(*) INTO b_other FROM shift_breaks WHERE id='72000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF s_own=1 AND s_other=0 AND b_own=1 AND b_other=0 THEN RAISE NOTICE 'PASS R7';
  ELSE RAISE NOTICE 'FAIL R7: own shift=% other shift=% own break=% other break=% (want 1,0,1,0)',
    s_own, s_other, b_own, b_other; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R7;

\echo 'R8: an operator_skills row follows the OPERATOR, not the training'
SAVEPOINT sp_R8;
DO $$
DECLARE own int; other int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  -- both rows point at the SAME company-wide training; only the operator differs
  SELECT count(*) INTO own   FROM operator_skills WHERE operator_id='50000000-0000-0000-0000-00000000ff02';
  SELECT count(*) INTO other FROM operator_skills WHERE operator_id='50000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF own=1 AND other=0 THEN RAISE NOTICE 'PASS R8';
  ELSE RAISE NOTICE 'FAIL R8: own operator=% other plant operator=% (want 1,0)', own, other; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R8;

-- ---------------------------------------------------------------------------
-- ⭐⭐ HISTORY. Case S18 in 52 says "narrowing what is OFFERED must not
-- un-schedule history". These two are that rule with teeth: the same product,
-- the same person, differing only in whether it is on a schedule they can see.
-- Without R9 every historical band on their board renders "(unknown product)"
-- and `BoardGrid`'s colour lookup collapses them all to one palette token.
-- ---------------------------------------------------------------------------
\echo 'R9 ⭐⭐ (rewritten by 0028): a Plant 1 product CANNOT BE SCHEDULED on a Plant 2 node at all'
-- ---------------------------------------------------------------------------
-- ⭐⭐ THESE THREE CASES USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT.
--
-- Until 0028 the read rule carried an exception -- a foreign-owned product on
-- a run you can see stayed readable -- so that the board could name its own
-- history. R9 built exactly that configuration and asserted the product was
-- visible. §19.71 then showed the same exception leaking into the products
-- CATALOGUE, where the maintainer found it.
--
-- D109 removes the configuration instead of the exception. A run's product
-- must be owned by an ancestor-or-self of the run's node, so "a Plant 1
-- product on a Plant 2 board" is not a thing that can exist, and the
-- exception it justified was deleted in 0028 §6. R9-R11 are the empirical
-- half of that migration's proof: R9 that the write is refused, R10 that a
-- legal write in the same shape still succeeds (or R9 would pass with the
-- feature broken), R11 that the products a person can see are exactly the
-- ones their own board can name -- which is what the exception was for.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_R9;
DO $$
DECLARE v_line uuid; v_err text := 'no error'; v_detail text := '-'; v_runs int;
BEGIN
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001', v_line,
            '60000000-0000-0000-0000-00000000ff01',
            tstzrange(now(), now()+interval '2 hours'), 'planned', 1);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
    -- The payload SHAPE, by key, not the message (doc_drift rule 7).
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_detail := coalesce(
      (SELECT string_agg(k, ',' ORDER BY k)
         FROM jsonb_object_keys(nullif(v_detail, '')::jsonb) k), '-');
  END;
  SELECT count(*) INTO v_runs FROM runs
   WHERE node_id = v_line AND product_id = '60000000-0000-0000-0000-00000000ff01';
  -- ⭐ D115: the product refusal names kind/id/node_id, no owner_node_id — a
  -- product has a LIST of places, not a single owner to point at.
  IF v_err = 'PT409' AND v_runs = 0 AND v_detail = 'error,id,kind,node_id'
  THEN RAISE NOTICE 'PASS R9';
  ELSE RAISE NOTICE 'FAIL R9: sqlstate=% runs=% detail_keys=% (want PT409, 0, error,id,kind,node_id)',
    v_err, v_runs, v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R9;

\echo 'R10: the CONTROL for R9 — the SAME write with the plant''s OWN product succeeds, so R9 is not passing because runs are broken'
SAVEPOINT sp_R10;
DO $$
DECLARE v_line uuid; v_err text := 'no error'; v_runs int;
BEGIN
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001', v_line,
            '60000000-0000-0000-0000-00000000ff02',
            tstzrange(now(), now()+interval '2 hours'), 'planned', 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_runs FROM runs
   WHERE node_id = v_line AND product_id = '60000000-0000-0000-0000-00000000ff02';
  IF v_err = 'no error' AND v_runs = 1 THEN RAISE NOTICE 'PASS R10';
  ELSE RAISE NOTICE 'FAIL R10: err=% runs=% (want no error, 1)', v_err, v_runs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R10;

\echo 'R11 ⭐⭐: THE PROOF, MEASURED — every product on a run the Plant 2 admin can read is a product they can read'
SAVEPOINT sp_R11;
DO $$
DECLARE v_line uuid; v_unnameable int;
BEGIN
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  -- Their own board, populated legally.
  INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
  VALUES ('10000000-0000-0000-0000-000000000001', v_line,
          '60000000-0000-0000-0000-00000000ff02',
          tstzrange(now(), now()+interval '2 hours'), 'planned', 1);
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  -- Read every run RLS lets them have, then ask how many name a product RLS
  -- does NOT let them have. Under the deleted exception this could only be
  -- zero because of the exception; now it is zero by construction, and if a
  -- future change breaks the constraint this counts the "(unknown product)"
  -- bands before a user has to.
  SELECT count(*) INTO v_unnameable
    FROM runs r
   WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = r.product_id);
  RESET ROLE;
  IF v_unnameable = 0 THEN RAISE NOTICE 'PASS R11';
  ELSE RAISE NOTICE 'FAIL R11: % run(s) on their own board name a product they cannot read', v_unnameable; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL R11: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_R11;

-- ---------------------------------------------------------------------------
-- ⭐⭐ `check_eligibility`. R12 was the case 0023 said made this whole migration
-- impossible; R13 is a hole that was ALREADY OPEN before it.
--
-- ⭐⭐ 0028 REWROTE R12, AND THE REASON IS THE SECOND COROLLARY OF ITS PROOF.
-- R12 used to place a PLANT 1 training requirement on a PLANT 2 cell and assert
-- that the Plant 2 admin, who could not LIST that training, still got a correct
-- "not eligible, and here is which one". D109 makes that configuration
-- impossible -- a requirement's training must be owned by an ancestor-or-self
-- of the node -- and the same ancestor-chain argument that killed the history
-- clause applies here: if you can read the CELL, the owner of anything required
-- there is comparable to one of your grants, so you can read the TRAINING too.
-- Hazard (a) of 0026 §3 is now unreachable rather than handled.
--
-- So R12 asserts the corollary instead of the workaround: the caller CAN list
-- it, and the answer is still right. ⚠️ THIS DOES NOT MAKE THE DEFINER GATE
-- UNNECESSARY -- hazard (b), the ancestor walk through the scoped `nodes`
-- table, is a different mechanism and R13 is still the case that measures it.
-- ---------------------------------------------------------------------------
\echo 'R12 ⭐⭐ (rewritten by 0028): a training required where you can see is a training you can list — and the answer still names it'
SAVEPOINT sp_R12;
DO $$
DECLARE v_ans jsonb; v_can_list int; v_line uuid;
BEGIN
  -- ⚠️ EVERY FIXTURE VALUE IS READ BEFORE THE ROLE CHANGE. `r_fix` is a TEMP
  -- table and `authenticated` cannot select from it, and the refusal arrives as
  -- "permission denied for table r_fix" -- indistinguishable, at a glance, from
  -- the RLS refusal this case exists to measure.
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  -- A requirement on a PLANT 2 cell, for PLANT 2's OWN training. Under D109
  -- there is no other legal shape; 55_'s N6 asserts the illegal one is refused.
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
  VALUES (v_line, '40000000-0000-0000-0000-00000000ff05','10000000-0000-0000-0000-000000000001')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_can_list FROM skills WHERE id='40000000-0000-0000-0000-00000000ff05';
  v_ans := check_eligibility(v_line,
                             '50000000-0000-0000-0000-00000000ff02',
                             tstzrange(now(), now()+interval '1 day'));
  RESET ROLE;
  -- ⚠️ THE WHOLE POINT, INVERTED BY 0028: they CAN list the training now
  -- (v_can_list = 1, the corollary), and the answer is still "not eligible,
  -- and here is which one". Both halves matter -- asserting only the listing
  -- would pass with `check_eligibility` returning nonsense.
  IF v_can_list = 1
     AND (v_ans->>'eligible')::boolean = false
     AND jsonb_array_length(v_ans->'missing_skills') = 1
  THEN RAISE NOTICE 'PASS R12';
  ELSE RAISE NOTICE 'FAIL R12: can_list=% eligible=% missing=% (want 1,false,1)',
    v_can_list, v_ans->>'eligible', v_ans->'missing_skills'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R12;

\echo 'R13 ⭐⭐: two people, one cell, one operator, ONE answer — a requirement above your grant no longer vanishes'
SAVEPOINT sp_R13;
DO $$
DECLARE v_admin jsonb; v_sup jsonb;
BEGIN
  -- the requirement sits on the PLANT 1 ROOT, which f3 (admin of Assembly) cannot read
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
  VALUES ('30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-00000000ff01',
          '10000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_admin := check_eligibility('30000000-0000-0000-0000-000000000007',
               '50000000-0000-0000-0000-00000000ff03', tstzrange(now(), now()+interval '1 day'));
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  v_sup := check_eligibility('30000000-0000-0000-0000-000000000007',
               '50000000-0000-0000-0000-00000000ff03', tstzrange(now(), now()+interval '1 day'));
  RESET ROLE;
  -- Before 0026 this file measured `eligible=false` for the company admin and
  -- `eligible=true` for the mid-tree admin: a SAFETY CHECK THAT FAILED OPEN for
  -- exactly the people who use it most.
  IF (v_admin->>'eligible') = (v_sup->>'eligible') AND (v_sup->>'eligible')::boolean = false
  THEN RAISE NOTICE 'PASS R13';
  ELSE RAISE NOTICE 'FAIL R13: company admin says eligible=%, the Assembly admin says eligible=% (want both false)',
    v_admin->>'eligible', v_sup->>'eligible'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R13;

\echo 'R14: and asking about a place you cannot see is REFUSED (PT403), not answered'
SAVEPOINT sp_R14;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM check_eligibility('30000000-0000-0000-0000-000000000007',
              '50000000-0000-0000-0000-00000000ff03', tstzrange(now(), now()+interval '1 day'));
    v_state := 'answered';
  EXCEPTION WHEN sqlstate 'PT403' THEN v_state := 'PT403';
            WHEN others THEN v_state := 'other:' || SQLSTATE;
  END;
  RESET ROLE;
  -- ⚠️ THE REPLACEMENT FOR THE GUARD THIS MIGRATION LOOSENS. 60_api_test item
  -- 26 asserts these functions are SECURITY INVOKER; `check_eligibility` is now
  -- exempt, so the property that exemption costs is asserted HERE instead. A
  -- guard that is only weakened is a guard that is gone.
  IF v_state = 'PT403' THEN RAISE NOTICE 'PASS R14';
  ELSE RAISE NOTICE 'FAIL R14: got % (want PT403)', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R14;

\echo 'R15 ⭐ (rewritten by 0036/D116): a plant admin RENAMES a part they wholly make, and still manages their OWN plant''s makers-list — reads narrowed, both writes work'
SAVEPOINT sp_R15;
DO $$
DECLARE v_record int; v_place text := 'no error'; v_line uuid;
BEGIN
  -- ⚠️ Read the TEMP-table fixture value before the role change; `authenticated`
  -- cannot select r_fix and the refusal reads exactly like RLS.
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  -- ⭐⭐ D116 (0036) HANDS THE OWNER BACK THEIR EDIT. ff02 is made only in Plant
  -- 2, which f2 administers, so renaming it is theirs again (products_update USING
  -- app_can_edit_product_record) — ONE row, not the zero the Split gave. The read
  -- narrowing of 0026 is what this case still has to prove does not eat the write.
  UPDATE products SET name = 'R P2 Product (renamed)' WHERE id='60000000-0000-0000-0000-00000000ff02';
  GET DIAGNOSTICS v_record = ROW_COUNT;
  -- But the LIST of makers is still per-plant, so they may add a place inside
  -- their own plant (product_sites_insert / app_is_admin_for). That is the write
  -- 0026's read-narrowing must not have eaten.
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-00000000ff02', v_line);
  EXCEPTION WHEN OTHERS THEN v_place := SQLSTATE; END;
  RESET ROLE;
  IF v_record = 1 AND v_place = 'no error' THEN RAISE NOTICE 'PASS R15';
  ELSE RAISE NOTICE 'FAIL R15: record_rename_rows=% own_plant_place=% (want 1, no error — wholly-owned record editable, list per-plant)', v_record, v_place; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R15;

\echo 'R16: and the tenant boundary is unchanged — org 2 is still invisible, by org_id and not by grant'
SAVEPOINT sp_R16;
DO $$
DECLARE v_seen int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM products WHERE org_id='10000000-0000-0000-0000-000000000002';
  RESET ROLE;
  IF v_seen=0 THEN RAISE NOTICE 'PASS R16';
  ELSE RAISE NOTICE 'FAIL R16: a company admin of org 1 read % of org 2''s products', v_seen; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R16;

\echo 'R17 ⭐: OWNER BELOW YOUR GRANT is visible too — the site admin looking down'
SAVEPOINT sp_R17;
DO $$
DECLARE p_root int; p_other int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p_root FROM products WHERE id='60000000-0000-0000-0000-00000000ff04';
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p_other FROM products WHERE id='60000000-0000-0000-0000-00000000ff04';
  RESET ROLE;
  -- ⚠️ R4 and R17 are the two directions of one rule. Either one alone passes
  -- against a predicate that implements only the other half.
  IF p_root=1 AND p_other=0 THEN RAISE NOTICE 'PASS R17';
  ELSE RAISE NOTICE 'FAIL R17: plant-1 admin sees sub-node row=% (want 1), plant-2 admin sees=% (want 0)',
    p_root, p_other; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R17;

ROLLBACK;
