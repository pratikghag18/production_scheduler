-- ============================================================================
-- 53_read_scoping_test.sql — migration 0026, D107: "ownership decides who may
-- READ, not only who may edit."
--
-- PRATIK'S WORDS (Aug 27, looking at the Products catalogue as the Plant 2
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
-- *BELOW* AN OWNER. The rule has two directions and only one is obvious.
-- "Owner below your grant" is the site admin looking down. "Owner ABOVE your
-- grant" is a line supervisor who must still see the plant-wide product list
-- or their board is empty. g3 (admin on Assembly) and g4 (supervisor on the
-- Plant 1 root) are the two people who can tell those apart.
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

  INSERT INTO products (id, org_id, sku, name, site_node_id) VALUES
    ('60000000-0000-0000-0000-00000000ff01', v_org,'RP1','R P1 Product','30000000-0000-0000-0000-000000000001'::uuid),
    ('60000000-0000-0000-0000-00000000ff02', v_org,'RP2','R P2 Product', v_p2),
    ('60000000-0000-0000-0000-00000000ff03', v_org,'RSH','R Shared Product', NULL),
    -- ⭐ owned by ASSEMBLY, strictly BELOW the Plant 1 root: the mirror of the
    -- row g3 uses. Without it, a rule written as "owner above me only" passes
    -- every other case in this file.
    ('60000000-0000-0000-0000-00000000ff04', v_org,'RSUB','R Sub-node Product','30000000-0000-0000-0000-000000000002'::uuid);

  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
    ('50000000-0000-0000-0000-00000000ff01', v_org,'R P1 Operator','30000000-0000-0000-0000-000000000001'::uuid),
    ('50000000-0000-0000-0000-00000000ff02', v_org,'R P2 Operator', v_p2),
    ('50000000-0000-0000-0000-00000000ff03', v_org,'R Shared Operator', NULL);

  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('40000000-0000-0000-0000-00000000ff01', v_org,'R P1 Training','30000000-0000-0000-0000-000000000001'::uuid),
    ('40000000-0000-0000-0000-00000000ff02', v_org,'R P2 Training', v_p2),
    ('40000000-0000-0000-0000-00000000ff03', v_org,'R Shared Training', NULL);

  INSERT INTO operator_skills (org_id, operator_id, skill_id) VALUES
    (v_org,'50000000-0000-0000-0000-00000000ff01','40000000-0000-0000-0000-00000000ff03'),
    (v_org,'50000000-0000-0000-0000-00000000ff02','40000000-0000-0000-0000-00000000ff03');

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('70000000-0000-0000-0000-00000000ff01', v_org,'R P1 Pattern','30000000-0000-0000-0000-000000000001'::uuid),
    ('70000000-0000-0000-0000-00000000ff02', v_org,'R P2 Pattern', v_p2),
    ('70000000-0000-0000-0000-00000000ff03', v_org,'R Standard Pattern', NULL);

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

\echo 'R0: the fixture is well-formed — two sites in one org, owned AND unowned rows, and a grant BELOW an owner'
SAVEPOINT sp_R0;
DO $$
DECLARE v_p2 uuid; v_roots int; v_owned int; v_unowned int; v_orgadmins int; v_below int;
BEGIN
  SELECT v INTO v_p2 FROM r_fix WHERE k='p2';
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id='10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT count(*) INTO v_owned FROM products
   WHERE org_id='10000000-0000-0000-0000-000000000001' AND site_node_id IS NOT NULL;
  SELECT count(*) INTO v_unowned FROM products
   WHERE org_id='10000000-0000-0000-0000-000000000001' AND site_node_id IS NULL;
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
  IF v_roots >= 2 AND v_owned >= 2 AND v_unowned >= 1 AND v_orgadmins = 0 AND v_below = 1
  THEN RAISE NOTICE 'PASS R0';
  ELSE RAISE NOTICE 'FAIL R0: roots=% owned=% unowned=% org_admins=% grant_below_root=% (want >=2,>=2,>=1,0,1)',
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

\echo 'R2: ...but company-wide rows stay visible to that same person — NULL is a VALUE, not an absence'
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
  IF p=1 AND o=1 AND s=1 AND t=1 THEN RAISE NOTICE 'PASS R2';
  ELSE RAISE NOTICE 'FAIL R2: product=% operator=% training=% pattern=% (want all 1)', p,o,s,t; END IF;
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

\echo 'R4 ⭐: OWNER ABOVE YOUR GRANT is visible — the admin of Assembly still sees the plant-wide list'
SAVEPOINT sp_R4;
DO $$
DECLARE p1 int; p2 int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO p1 FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';  -- owned by the root above them
  SELECT count(*) INTO p2 FROM products WHERE id='60000000-0000-0000-0000-00000000ff02';  -- the other plant
  RESET ROLE;
  -- ⚠️ BOTH HALVES. Seeing the row above you is the point; still not seeing the
  -- other plant is what stops "either direction" from meaning "everything".
  IF p1=1 AND p2=0 THEN RAISE NOTICE 'PASS R4';
  ELSE RAISE NOTICE 'FAIL R4: own-branch=% other-plant=% (want 1,0)', p1, p2; END IF;
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
\echo 'R9 ⭐: a Plant 1 product scheduled on a Plant 2 node stays READABLE to the Plant 2 admin'
SAVEPOINT sp_R9;
DO $$
DECLARE v_line uuid; v_seen int;
BEGIN
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
  VALUES ('10000000-0000-0000-0000-000000000001', v_line,
          '60000000-0000-0000-0000-00000000ff01',
          tstzrange(now(), now()+interval '2 hours'), 'planned', 1);
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF v_seen=1 THEN RAISE NOTICE 'PASS R9';
  ELSE RAISE NOTICE 'FAIL R9: the product on their own board is invisible to them (saw %)', v_seen; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R9;

\echo 'R10: the CONTROL for R9 — without that run the same product is invisible, so R9 is not vacuous'
SAVEPOINT sp_R10;
DO $$
DECLARE v_seen int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF v_seen=0 THEN RAISE NOTICE 'PASS R10';
  ELSE RAISE NOTICE 'FAIL R10: visible with no run — R9 proves nothing (saw %)', v_seen; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R10;

\echo 'R11: and a run on the OTHER plant does not make it readable — the run must be one you can see'
SAVEPOINT sp_R11;
DO $$
DECLARE v_seen int;
BEGIN
  INSERT INTO runs (org_id, node_id, product_id, timerange, status, planned_headcount)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '60000000-0000-0000-0000-00000000ff01', tstzrange(now(), now()+interval '2 hours'), 'planned', 1);
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM products WHERE id='60000000-0000-0000-0000-00000000ff01';
  RESET ROLE;
  IF v_seen=0 THEN RAISE NOTICE 'PASS R11';
  ELSE RAISE NOTICE 'FAIL R11: a run they cannot see made the product readable (saw %)', v_seen; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_R11;

-- ---------------------------------------------------------------------------
-- ⭐⭐ `check_eligibility`. R12 is the case 0023 said made this whole migration
-- impossible; R13 is a hole that was ALREADY OPEN before it.
-- ---------------------------------------------------------------------------
\echo 'R12 ⭐⭐: the qualification check still names a training the CALLER cannot list'
SAVEPOINT sp_R12;
DO $$
DECLARE v_ans jsonb; v_can_list int; v_line uuid;
BEGIN
  -- ⚠️ EVERY FIXTURE VALUE IS READ BEFORE THE ROLE CHANGE. `r_fix` is a TEMP
  -- table and `authenticated` cannot select from it, and the refusal arrives as
  -- "permission denied for table r_fix" -- indistinguishable, at a glance, from
  -- the RLS refusal this case exists to measure.
  SELECT v INTO v_line FROM r_fix WHERE k='p2_line';
  -- a requirement for a PLANT 1 training, on a PLANT 2 cell, asked by the Plant 2 admin
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id)
  VALUES (v_line, '40000000-0000-0000-0000-00000000ff01','10000000-0000-0000-0000-000000000001')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_can_list FROM skills WHERE id='40000000-0000-0000-0000-00000000ff01';
  v_ans := check_eligibility(v_line,
                             '50000000-0000-0000-0000-00000000ff02',
                             tstzrange(now(), now()+interval '1 day'));
  RESET ROLE;
  -- ⚠️ THE WHOLE POINT: they cannot LIST the training (v_can_list = 0) and the
  -- answer must STILL be "not eligible, and here is which one". This is 0023's
  -- stated hazard asserted directly instead of avoided.
  IF v_can_list = 0
     AND (v_ans->>'eligible')::boolean = false
     AND jsonb_array_length(v_ans->'missing_skills') = 1
  THEN RAISE NOTICE 'PASS R12';
  ELSE RAISE NOTICE 'FAIL R12: can_list=% eligible=% missing=% (want 0,false,1)',
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

\echo 'R15: WRITES are untouched — 0023 still decides who may edit, and it still says yes to the owner'
SAVEPOINT sp_R15;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  UPDATE products SET name = 'R P2 Product (renamed)' WHERE id='60000000-0000-0000-0000-00000000ff02';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows=1 THEN RAISE NOTICE 'PASS R15';
  ELSE RAISE NOTICE 'FAIL R15: the owner can no longer edit their own row (% rows)', v_rows; END IF;
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
