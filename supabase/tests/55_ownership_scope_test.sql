-- ============================================================================
-- 55_ownership_scope_test.sql — migration 0028, D108 and D109.
--
-- THE MAINTAINER'S WORDS (Aug 28, after finding a Plant 2 product in the Plant 1
-- admin's catalogue and being told the two admins behaved differently):
--   "we should remove company-wide as an option for products and operators.
--    Each site (or the highest hierarchy level) has its own set of products
--    and operators. No product or operator can be assigned where it does not
--    belong. ... a person under no circumstances should be able to see data
--    for other plants unless they are system admin, period."
--
-- Two claims, and this file separates them on purpose:
--
--   D108  THERE IS NO COMPANY-WIDE ROW. `site_node_id` is NOT NULL on
--         products, operators, skills and shift templates. N1, N14, N17.
--
--   D109  OWNERSHIP IS A SCOPE, AT ANY LEVEL, AND IT BINDS SCHEDULING. A
--         run's product, an assignment's operator, a cell's training
--         requirement and a cell's shift pattern must each be owned by an
--         ancestor-or-self of the node in question (N2-N8), and it cannot be
--         moved out from under its own history (N9-N11).
--
-- ⭐⭐ N12 AND N13 ARE THE POINT OF THE WHOLE MIGRATION. 0026 kept one
-- deliberate exception to the read rule -- a foreign-owned row stayed readable
-- while it sat on a run you could see -- and §19.71 is the record of that
-- exception leaking into the products catalogue, which is what the maintainer
-- reported. D109 makes the exception's precondition impossible, so 0028
-- deleted it. N12 measures the invariant that justifies the deletion across
-- every row in the database; N13 asserts the deleted function has not come
-- back. Between them they are why this is a fix rather than a third patch.
--
-- FIXTURE, and the reasons are 51's and 53's:
--   * two sites in ONE org -- a cross-TENANT refusal proves nothing about a
--     cross-SITE one, org scoping refuses it three layers earlier;
--   * both site admins hold the org-wide role 'viewer' -- one org-wide 'admin'
--     and `app_is_admin()` short-circuits every predicate under test;
--   * an owner strictly BELOW a plant root (Line 1), because "any level" is
--     half of D109 and a fixture of roots alone cannot see it.
--
-- People (both org-wide 'viewer'):
--   b1  admin grant on plant_1   — site admin of Plant 1
--   b2  admin grant on Plant 2 (N)
-- The seed supplies a1, an org-wide company admin.
--
-- Seed nodes used: plant_1 ...0001, assembly ...0002, line_1 ...0004,
-- cell_1 ...0007, cell_2 ...0008, cell_3 ...0009.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE n_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL, 'Plant 2 (N)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,  'Fabrication N', 0)->>'id')::uuid;
  v_line := (create_node(v_dept,'Weld Line N',   0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO n_fix (k, v) VALUES ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_p2 uuid; v_line uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  SELECT v INTO v_p2   FROM n_fix WHERE k = 'p2';
  SELECT v INTO v_line FROM n_fix WHERE k = 'p2_line';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-00000000bb01'),
    ('00000000-0000-0000-0000-00000000bb02');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e1000000-0000-0000-0000-000000000001', v_org,'00000000-0000-0000-0000-00000000bb01','viewer'),
    ('e1000000-0000-0000-0000-000000000002', v_org,'00000000-0000-0000-0000-00000000bb02','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e1000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001', v_org,'admin'),
    ('e1000000-0000-0000-0000-000000000002', v_p2,                                  v_org,'admin');

  -- Three scopes, which is the fewest that can tell "is" from "contains" from
  -- "elsewhere": the Plant 1 ROOT, LINE 1 strictly below it, and the other
  -- plant. A fixture of roots alone cannot fail on D109's "any level" half.
  -- D115 (0034): a product's place is a product_sites row, not a column. Each
  -- product below carries exactly ONE place, at what used to be its owner, so
  -- the offering guard (app_product_offered_at) answers exactly as the old
  -- single owner did -- every N2-N8 outcome is preserved by construction.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('62000000-0000-0000-0000-0000000000c1', v_org,'NP1','N Plant-1 Product'),
    ('62000000-0000-0000-0000-0000000000c2', v_org,'NL1','N Line-1 Product'),
    ('62000000-0000-0000-0000-0000000000c3', v_org,'NP2','N Plant-2 Product'),
    -- Made in a single CELL. N4 needs a place that is neither an ancestor of
    -- nor equal to the node under test, while still being inside Plant 1 --
    -- otherwise "refused" cannot be told from "refused because other plant".
    ('62000000-0000-0000-0000-0000000000c4', v_org,'NC1','N Cell-1 Product');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org,'62000000-0000-0000-0000-0000000000c1','30000000-0000-0000-0000-000000000001'),
    (v_org,'62000000-0000-0000-0000-0000000000c2','30000000-0000-0000-0000-000000000004'),
    (v_org,'62000000-0000-0000-0000-0000000000c3', v_p2),
    (v_org,'62000000-0000-0000-0000-0000000000c4','30000000-0000-0000-0000-000000000007');

  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
    ('52000000-0000-0000-0000-0000000000c1', v_org,'N Plant-1 Operator','30000000-0000-0000-0000-000000000001'),
    ('52000000-0000-0000-0000-0000000000c3', v_org,'N Plant-2 Operator', v_p2);

  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('42000000-0000-0000-0000-0000000000c1', v_org,'N Plant-1 Training','30000000-0000-0000-0000-000000000001'),
    ('42000000-0000-0000-0000-0000000000c2', v_org,'N Line-1 Training', '30000000-0000-0000-0000-000000000004'),
    ('42000000-0000-0000-0000-0000000000c3', v_org,'N Plant-2 Training', v_p2);

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('72000000-0000-0000-0000-0000000000c1', v_org,'N Plant-1 Pattern','30000000-0000-0000-0000-000000000001'),
    ('72000000-0000-0000-0000-0000000000c3', v_org,'N Plant-2 Pattern', v_p2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

\echo 'N0: the fixture is well-formed — two sites in one org, three scopes, no org-wide admin among the two site admins'
SAVEPOINT sp_N0;
DO $$
DECLARE v_roots int; v_scopes int; v_admins int; v_below int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id='10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  -- D115: the scope is a product_sites place now, not a column. Each of the four
  -- products carries exactly one, so four distinct places is four owners.
  SELECT count(DISTINCT node_id) INTO v_scopes FROM product_sites
   WHERE product_id::text LIKE '62000000-0000-0000-0000-0000000000c%';
  SELECT count(*) INTO v_admins FROM user_profiles
   WHERE id::text LIKE 'e1000000%' AND role = 'admin';
  -- at least one product place strictly below a root, or D109's "any level"
  -- half is never exercised by this file
  SELECT count(*) INTO v_below FROM product_sites ps JOIN nodes n ON n.id = ps.node_id
   WHERE ps.product_id::text LIKE '62000000-0000-0000-0000-0000000000c%' AND n.parent_id IS NOT NULL;
  IF v_roots >= 2 AND v_scopes = 4 AND v_admins = 0 AND v_below >= 2
  THEN RAISE NOTICE 'PASS N0';
  ELSE RAISE NOTICE 'FAIL N0: roots=% scopes=% org_wide_admins=% owners_below_a_root=% (want >=2, 4, 0, >=2)',
    v_roots, v_scopes, v_admins, v_below; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N0;

-- ---------------------------------------------------------------------------
-- D108 — THERE IS NO COMPANY-WIDE ROW.
-- ---------------------------------------------------------------------------
\echo 'N1 ⭐ (rewritten by 0034): NULL ownership is refused by the CONSTRAINT on the three tables that still own a single node — and a PLACELESS product is now an ordinary catalogue state, not a refusal'
SAVEPOINT sp_N1;
DO $$
DECLARE v_p int; v_o int; v_s int; v_t int;
BEGIN
  -- ⚠️ AS THE SUPERUSER, ON PURPOSE. 51's Q3 shows a site admin gets 42501
  -- here, because an UPDATE's new row meets the policy's WITH CHECK before the
  -- constraint (postgres gotcha 20) and `app_is_admin_for(NULL)` is false.
  -- That is a real refusal but it is a refusal about the CALLER. This case is
  -- about the COLUMN, so it asks as the one caller no policy applies to.
  RESET ROLE;
  -- ⭐⭐ SUPERSEDES THE OLD PRODUCTS ARM. D115 (0034) drops products.site_node_id:
  -- a product is company-wide and its makers are a LIST in product_sites, so a
  -- product with NO places is a catalogue entry not yet assigned anywhere (the
  -- migration header's "ordinary state"). There is no NULL to refuse. This
  -- creates one and asserts it is ACCEPTED, exactly inverting the old arm.
  BEGIN INSERT INTO products (org_id, sku, name)
    VALUES ('10000000-0000-0000-0000-000000000001','NNUL','N Placeless');
    v_p := 1; EXCEPTION WHEN OTHERS THEN v_p := -1; END;
  -- operators, skills and shift_templates are UNCHANGED by D115 — they still own
  -- exactly one node and NULL is still refused by the NOT NULL constraint.
  BEGIN INSERT INTO operators (org_id, display_name, site_node_id)
    VALUES ('10000000-0000-0000-0000-000000000001','N Null Op', NULL);
    v_o := 0; EXCEPTION WHEN not_null_violation THEN v_o := 1; WHEN OTHERS THEN v_o := -1; END;
  BEGIN INSERT INTO skills (org_id, name, site_node_id)
    VALUES ('10000000-0000-0000-0000-000000000001','N Null Skill', NULL);
    v_s := 0; EXCEPTION WHEN not_null_violation THEN v_s := 1; WHEN OTHERS THEN v_s := -1; END;
  BEGIN INSERT INTO shift_templates (org_id, name, site_node_id)
    VALUES ('10000000-0000-0000-0000-000000000001','N Null Pattern', NULL);
    v_t := 0; EXCEPTION WHEN not_null_violation THEN v_t := 1; WHEN OTHERS THEN v_t := -1; END;
  IF v_p=1 AND v_o=1 AND v_s=1 AND v_t=1 THEN RAISE NOTICE 'PASS N1';
  ELSE RAISE NOTICE 'FAIL N1: placeless_product_accepted=% operators=% skills=% shift_templates=% (want product 1=accepted; other three 1=refused; 0/-1=wrong)',
    v_p, v_o, v_s, v_t; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N1;

\echo 'N14 ⭐: app_can_read_owned(NULL) is FALSE — the company-wide branch is gone, not merely unused'
SAVEPOINT sp_N14;
DO $$
DECLARE v_ans boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000bb02', true);
  SET LOCAL ROLE authenticated;
  SELECT app_can_read_owned(NULL) INTO v_ans;
  RESET ROLE;
  -- Before 0028 this returned TRUE for everybody: `p_site_node IS NULL` was
  -- the first branch. Deleting the branch is the whole of D108 at the read
  -- layer, and a NOT NULL column alone would not prove it went.
  IF v_ans IS NOT TRUE THEN RAISE NOTICE 'PASS N14';
  ELSE RAISE NOTICE 'FAIL N14: app_can_read_owned(NULL) = % (want false/null)', v_ans; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL N14: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N14;

-- ---------------------------------------------------------------------------
-- D109 — OWNERSHIP BINDS SCHEDULING. Every refusal below is paired with the
-- legal write in the same shape, because a constraint that refuses everything
-- passes every negative case in this section.
-- ---------------------------------------------------------------------------
\echo 'N2: the legal shape — a run at Cell 1 with a product owned by the plant above it is accepted'
SAVEPOINT sp_N2;
DO $$
DECLARE v_err text := 'no error'; v_n int;
BEGIN
  RESET ROLE;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '62000000-0000-0000-0000-0000000000c1',
            tstzrange('2099-06-01 08:00+00','2099-06-01 10:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_n FROM runs WHERE product_id = '62000000-0000-0000-0000-0000000000c1';
  IF v_err = 'no error' AND v_n = 1 THEN RAISE NOTICE 'PASS N2';
  ELSE RAISE NOTICE 'FAIL N2: err=% runs=% (want no error, 1)', v_err, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N2;

\echo 'N3 ⭐: a run at Cell 1 with the OTHER PLANT''s product is refused, with the payload the client parses'
SAVEPOINT sp_N3;
DO $$
DECLARE v_err text := 'no error'; v_keys text := '-'; v_n int; v_detail text;
BEGIN
  RESET ROLE;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '62000000-0000-0000-0000-0000000000c3',
            tstzrange('2099-06-01 08:00+00','2099-06-01 10:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_keys := coalesce((SELECT string_agg(k, ',' ORDER BY k)
                          FROM jsonb_object_keys(nullif(v_detail,'')::jsonb) k), '-');
  END;
  SELECT count(*) INTO v_n FROM runs WHERE product_id = '62000000-0000-0000-0000-0000000000c3';
  -- The KEYS, not the message. doc_drift rule 7: a refusal a screen renders is
  -- a contract, and `schedulable_level_locked` shipped with the wrong shape
  -- for a day because only the code was ever asserted.
  -- ⭐ D115: the product refusal no longer carries `owner_node_id` — a product
  -- has no single owner to name, only a LIST of places, none of which covers
  -- this node. The run-scope guard emits kind/id/node_id and nothing more.
  IF v_err = 'PT409' AND v_n = 0 AND v_keys = 'error,id,kind,node_id'
  THEN RAISE NOTICE 'PASS N3';
  ELSE RAISE NOTICE 'FAIL N3: sqlstate=% runs=% keys=% (want PT409, 0, error,id,kind,node_id)',
    v_err, v_n, v_keys; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N3;

\echo 'N4 ⭐: and a product owned by a SIBLING cell in the SAME plant is refused too — "same plant" is not the rule, "at or under the owner" is'
SAVEPOINT sp_N4;
DO $$
DECLARE v_err text := 'no error'; v_n int;
BEGIN
  RESET ROLE;
  BEGIN
    -- product owned by Cell 1, run at Cell 2. Both inside Plant 1.
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000008',
            '62000000-0000-0000-0000-0000000000c4',
            tstzrange('2099-06-01 08:00+00','2099-06-01 10:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM runs WHERE product_id = '62000000-0000-0000-0000-0000000000c4';
  IF v_err = 'PT409' AND v_n = 0 THEN RAISE NOTICE 'PASS N4';
  ELSE RAISE NOTICE 'FAIL N4: sqlstate=% runs=% (want PT409, 0)', v_err, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N4;

\echo 'N5: the SAME cell-owned product IS accepted on its own cell — N4 is a scope refusal, not a broken product'
SAVEPOINT sp_N5;
DO $$
DECLARE v_err text := 'no error'; v_n int;
BEGIN
  RESET ROLE;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '62000000-0000-0000-0000-0000000000c4',
            tstzrange('2099-06-02 08:00+00','2099-06-02 10:00+00'), 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_n FROM runs WHERE product_id = '62000000-0000-0000-0000-0000000000c4';
  IF v_err = 'no error' AND v_n = 1 THEN RAISE NOTICE 'PASS N5';
  ELSE RAISE NOTICE 'FAIL N5: err=% runs=% (want no error, 1)', v_err, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N5;

\echo 'N6 ⭐: an assignment naming the other plant''s OPERATOR is refused; the plant''s own operator is accepted'
SAVEPOINT sp_N6;
DO $$
DECLARE v_bad text := 'no error'; v_good text := 'no error'; v_n int;
BEGIN
  RESET ROLE;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '52000000-0000-0000-0000-0000000000c3','62000000-0000-0000-0000-0000000000c1',
            tstzrange('2099-06-03 08:00+00','2099-06-03 10:00+00'), 1.000);
  EXCEPTION WHEN OTHERS THEN v_bad := SQLSTATE; END;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '52000000-0000-0000-0000-0000000000c1','62000000-0000-0000-0000-0000000000c1',
            tstzrange('2099-06-03 08:00+00','2099-06-03 10:00+00'), 1.000);
  EXCEPTION WHEN OTHERS THEN v_good := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_n FROM assignments
   WHERE operator_id = '52000000-0000-0000-0000-0000000000c3';
  IF v_bad = 'PT409' AND v_good = 'no error' AND v_n = 0 THEN RAISE NOTICE 'PASS N6';
  ELSE RAISE NOTICE 'FAIL N6: foreign=% own=% stored_foreign=% (want PT409, no error, 0)',
    v_bad, v_good, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N6;

\echo 'N7 ⭐: a cell may only require a training owned at or above it — and operator_skills may only pair rows on ONE branch'
SAVEPOINT sp_N7;
DO $$
DECLARE v_req_bad text := 'no error'; v_req_good text := 'no error';
        v_os_bad text := 'no error'; v_os_good text := 'no error';
BEGIN
  RESET ROLE;
  BEGIN  -- other plant's training on a Plant 1 cell
    INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
              '42000000-0000-0000-0000-0000000000c3');
  EXCEPTION WHEN OTHERS THEN v_req_bad := SQLSTATE; END;
  BEGIN  -- the plant's own training on the same cell
    INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
              '42000000-0000-0000-0000-0000000000c1');
  EXCEPTION WHEN OTHERS THEN v_req_good := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN  -- a Plant 2 person holding a Plant 1 training
    INSERT INTO operator_skills (org_id, operator_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-0000000000c3',
              '42000000-0000-0000-0000-0000000000c1');
  EXCEPTION WHEN OTHERS THEN v_os_bad := SQLSTATE; END;
  BEGIN  -- ⭐ a Plant-1-wide person holding a LINE 1 training: legal, and the
         -- reason the operator_skills rule is comparability rather than
         -- containment. Asserting only the refusal would let a guard that
         -- demands equality pass.
    INSERT INTO operator_skills (org_id, operator_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-0000000000c1',
              '42000000-0000-0000-0000-0000000000c2');
  EXCEPTION WHEN OTHERS THEN v_os_good := SQLSTATE || ' ' || SQLERRM; END;
  IF v_req_bad='PT409' AND v_req_good='no error' AND v_os_bad='PT409' AND v_os_good='no error'
  THEN RAISE NOTICE 'PASS N7';
  ELSE RAISE NOTICE 'FAIL N7: req_foreign=% req_own=% held_foreign=% held_below=% (want PT409, no error, PT409, no error)',
    v_req_bad, v_req_good, v_os_bad, v_os_good; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N7;

\echo 'N8: a cell may only run a shift pattern owned at or above it, and an operator''s home cell must be inside their own site'
SAVEPOINT sp_N8;
DO $$
DECLARE v_tpl_bad text := 'no error'; v_tpl_good text := 'no error';
        v_home_bad text := 'no error'; v_p2_line uuid;
BEGIN
  SELECT v INTO v_p2_line FROM n_fix WHERE k='p2_line';
  RESET ROLE;
  BEGIN
    INSERT INTO node_shift_templates (org_id, node_id, template_id)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
              '72000000-0000-0000-0000-0000000000c3');
  EXCEPTION WHEN OTHERS THEN v_tpl_bad := SQLSTATE; END;
  BEGIN
    INSERT INTO node_shift_templates (org_id, node_id, template_id)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
              '72000000-0000-0000-0000-0000000000c1')
    ON CONFLICT (node_id) DO UPDATE SET template_id = EXCLUDED.template_id;
  EXCEPTION WHEN OTHERS THEN v_tpl_good := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN
    -- a Plant 1 operator whose home cell is in Plant 2: the field would
    -- silently contradict the owner, and "where do they work" is the one
    -- place a reader would trust it.
    UPDATE operators SET home_node_id = v_p2_line
     WHERE id = '52000000-0000-0000-0000-0000000000c1';
  EXCEPTION WHEN OTHERS THEN v_home_bad := SQLSTATE; END;
  IF v_tpl_bad='PT409' AND v_tpl_good='no error' AND v_home_bad='PT409'
  THEN RAISE NOTICE 'PASS N8';
  ELSE RAISE NOTICE 'FAIL N8: foreign_pattern=% own_pattern=% foreign_home=% (want PT409, no error, PT409)',
    v_tpl_bad, v_tpl_good, v_home_bad; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N8;

-- ---------------------------------------------------------------------------
-- ⭐⭐ N9-N11 — A THING CANNOT BE MOVED OUT FROM UNDER ITS OWN HISTORY.
--
-- This is the same defect the maintainer reported, arriving by a door no INSERT
-- guards. For OPERATORS (N11) it is still the re-home guard: an owner column
-- being moved. For PRODUCTS (N9), D115 replaced the single owner with a LIST, so
-- there is no owner to re-home; the equivalent hazard is REMOVING the last plant
-- a part is still scheduled under. The strand guard moved from re-home to
-- un-assign accordingly (0034 §5), and N9/N10 follow it. [[doc-drift]] shape 4:
-- an invariant checked once at write time and never re-checked has an expiry.
-- ---------------------------------------------------------------------------
\echo 'N9 ⭐⭐ (rewritten by 0034): removing the LAST plant a product is still scheduled under is refused, and the place row survives'
SAVEPOINT sp_N9;
DO $$
DECLARE v_err text := 'no error'; v_keys text := '-'; v_detail text; v_places int;
BEGIN
  RESET ROLE;
  -- c1 is made only in Plant 1, and now scheduled there.
  INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '62000000-0000-0000-0000-0000000000c1',
          tstzrange('2099-07-01 08:00+00','2099-07-01 10:00+00'), 1);
  -- Removing that plant would strand the run — no remaining plant covers Cell 1.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '62000000-0000-0000-0000-0000000000c1'
       AND node_id = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_keys := coalesce((SELECT string_agg(k, ',' ORDER BY k)
                          FROM jsonb_object_keys(nullif(v_detail,'')::jsonb) k), '-');
  END;
  -- The place must still be there: a refusal that already removed the row is no
  -- refusal. The strand payload names the plant being removed, not a new owner.
  SELECT count(*) INTO v_places FROM product_sites
   WHERE product_id='62000000-0000-0000-0000-0000000000c1'
     AND node_id='30000000-0000-0000-0000-000000000001';
  IF v_err = 'PT409'
     AND v_places = 1
     AND v_keys = 'error,id,kind,removed_node_id,stranded'
  THEN RAISE NOTICE 'PASS N9';
  ELSE RAISE NOTICE 'FAIL N9: sqlstate=% place_rows=% keys=% (want PT409, 1, error,id,kind,removed_node_id,stranded)',
    v_err, v_places, v_keys; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N9;

\echo 'N10: the CONTROL for N9 — with no runs in the way the same plant can be removed, so N9 is not just "places are immutable"'
SAVEPOINT sp_N10;
DO $$
DECLARE v_err text := 'no error'; v_places int;
BEGIN
  RESET ROLE;
  -- c1 has no runs against it here, so its sole plant may be removed cleanly,
  -- leaving a placeless catalogue entry (an ordinary state under D115).
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '62000000-0000-0000-0000-0000000000c1'
       AND node_id = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM; END;
  SELECT count(*) INTO v_places FROM product_sites
   WHERE product_id='62000000-0000-0000-0000-0000000000c1';
  IF v_err = 'no error' AND v_places = 0 THEN RAISE NOTICE 'PASS N10';
  ELSE RAISE NOTICE 'FAIL N10: err=% remaining_places=% (want no error, 0)', v_err, v_places; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N10;

\echo 'N11: and the same guard on OPERATORS — a person with assignments cannot be moved out from under them'
SAVEPOINT sp_N11;
DO $$
DECLARE v_p2 uuid; v_err text := 'no error'; v_owner uuid;
BEGIN
  SELECT v INTO v_p2 FROM n_fix WHERE k='p2';
  RESET ROLE;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '52000000-0000-0000-0000-0000000000c1','62000000-0000-0000-0000-0000000000c1',
          tstzrange('2099-07-02 08:00+00','2099-07-02 10:00+00'), 1.000);
  BEGIN
    UPDATE operators SET site_node_id = v_p2 WHERE id = '52000000-0000-0000-0000-0000000000c1';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT site_node_id INTO v_owner FROM operators WHERE id='52000000-0000-0000-0000-0000000000c1';
  IF v_err = 'PT409' AND v_owner = '30000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS N11';
  ELSE RAISE NOTICE 'FAIL N11: sqlstate=% owner=% (want PT409, plant_1)', v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N11;

-- ---------------------------------------------------------------------------
-- ⭐⭐ N12 AND N13 — WHY THE READ EXCEPTION COULD BE DELETED.
-- ---------------------------------------------------------------------------
\echo 'N12 ⭐⭐: THE INVARIANT, MEASURED OVER EVERY ROW IN THE DATABASE — no scheduled thing is owned outside where it is scheduled'
SAVEPOINT sp_N12;
DO $$
DECLARE v_runs int; v_asg_op int; v_asg_prod int; v_req int; v_tpl int; v_total int;
BEGIN
  RESET ROLE;
  -- ⚠️ NOT SCOPED TO THIS FILE'S FIXTURE, ON PURPOSE. The claim the migration
  -- makes is about the whole database: it is what licenses deleting
  -- `app_product_on_visible_schedule`, and a fixture-scoped count would say
  -- nothing about the seed's own 9 operators and 4 products. If the seed, a
  -- later migration or another test file ever writes a row that breaks it,
  -- this is where it surfaces -- before a user sees "(unknown product)".
  -- D115: a run's product is well-placed when SOME product_sites place is an
  -- ancestor-or-self of the run's node — the list-aware successor to "the single
  -- owner covers it". A run whose product no remaining plant covers is the
  -- "(unknown product)" band this invariant exists to make impossible.
  SELECT count(*) INTO v_runs FROM runs r
    JOIN products p ON p.id = r.product_id
    JOIN nodes rn ON rn.id = r.node_id
   WHERE NOT EXISTS (
     SELECT 1 FROM product_sites ps JOIN nodes po ON po.id = ps.node_id
      WHERE ps.product_id = p.id AND po.path @> rn.path);
  SELECT count(*) INTO v_asg_op FROM assignments a
    JOIN operators o ON o.id = a.operator_id
    JOIN nodes oo ON oo.id = o.site_node_id
    JOIN nodes an ON an.id = a.node_id
   WHERE NOT (oo.path @> an.path);
  SELECT count(*) INTO v_asg_prod FROM assignments a
    JOIN products p ON p.id = a.product_id
    JOIN nodes an ON an.id = a.node_id
   WHERE NOT EXISTS (
     SELECT 1 FROM product_sites ps JOIN nodes po ON po.id = ps.node_id
      WHERE ps.product_id = p.id AND po.path @> an.path);
  SELECT count(*) INTO v_req FROM node_skill_requirements q
    JOIN skills s ON s.id = q.skill_id
    JOIN nodes so ON so.id = s.site_node_id
    JOIN nodes qn ON qn.id = q.node_id
   WHERE NOT (so.path @> qn.path);
  SELECT count(*) INTO v_tpl FROM node_shift_templates q
    JOIN shift_templates t ON t.id = q.template_id
    JOIN nodes to_ ON to_.id = t.site_node_id
    JOIN nodes qn ON qn.id = q.node_id
   WHERE NOT (to_.path @> qn.path);
  -- and the fixture must be non-empty, or all five zeroes prove nothing
  SELECT count(*) INTO v_total FROM runs;
  IF v_runs=0 AND v_asg_op=0 AND v_asg_prod=0 AND v_req=0 AND v_tpl=0 AND v_total > 0
  THEN RAISE NOTICE 'PASS N12';
  ELSE RAISE NOTICE 'FAIL N12: runs=% asg_op=% asg_prod=% requirements=% patterns=% total_runs=% (want all 0 over a non-empty database)',
    v_runs, v_asg_op, v_asg_prod, v_req, v_tpl, v_total; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N12;

\echo 'N13 ⭐⭐: the read exception is GONE — the two functions that implemented it no longer exist'
SAVEPOINT sp_N13;
DO $$
DECLARE v_fns int; v_policy text;
BEGIN
  SELECT count(*) INTO v_fns FROM pg_proc
   WHERE proname IN ('app_product_on_visible_schedule','app_operator_on_visible_schedule');
  SELECT qual INTO v_policy FROM pg_policies
   WHERE schemaname='public' AND tablename='products' AND policyname='products_select';
  -- Both halves. Dropping the function while leaving the policy referencing it
  -- would not compile; leaving the function while removing it from the policy
  -- would leave a loaded gun for the next person who "restores" a helper that
  -- looks unused. §19.71 is what happens when this exception is reachable from
  -- a screen it was not written for.
  IF v_fns = 0 AND v_policy NOT LIKE '%visible_schedule%'
  THEN RAISE NOTICE 'PASS N13';
  ELSE RAISE NOTICE 'FAIL N13: functions=% products_select=% (want 0, no visible_schedule term)',
    v_fns, v_policy; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_N13;

-- ---------------------------------------------------------------------------
-- N15-N18 — THE THINGS FOUND WHILE WRITING THE MIGRATION.
-- ---------------------------------------------------------------------------
\echo 'N15 ⭐: node_skill_requirements and node_shift_templates were org-wide until 0028 — the other plant''s rows are no longer listable'
SAVEPOINT sp_N15;
DO $$
DECLARE v_p2_line uuid; v_req int; v_tpl int; v_mine int;
BEGIN
  SELECT v INTO v_p2_line FROM n_fix WHERE k='p2_line';
  RESET ROLE;
  INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
    VALUES ('10000000-0000-0000-0000-000000000001', v_p2_line, '42000000-0000-0000-0000-0000000000c3');
  INSERT INTO node_shift_templates (org_id, node_id, template_id)
    VALUES ('10000000-0000-0000-0000-000000000001', v_p2_line, '72000000-0000-0000-0000-0000000000c3');
  INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000009',
            '42000000-0000-0000-0000-0000000000c1');
  -- asked as the PLANT 1 admin, about PLANT 2's rows
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000bb01', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_req FROM node_skill_requirements WHERE node_id = v_p2_line;
  SELECT count(*) INTO v_tpl FROM node_shift_templates    WHERE node_id = v_p2_line;
  -- ...and their own, so "0" is not simply "this table reads empty"
  SELECT count(*) INTO v_mine FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000009';
  RESET ROLE;
  IF v_req = 0 AND v_tpl = 0 AND v_mine = 1 THEN RAISE NOTICE 'PASS N15';
  ELSE RAISE NOTICE 'FAIL N15: their_requirements=% their_patterns=% own_requirements=% (want 0,0,1)',
    v_req, v_tpl, v_mine; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL N15: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N15;

\echo 'N17 ⭐ (rewritten by 0034/Split): a plant admin may add a MAKER inside their plant, and may not add one in the other plant — the product RECORD itself is company-only'
SAVEPOINT sp_N17;
DO $$
DECLARE v_p2 uuid; v_record text := 'no error'; v_line text := 'no error'; v_other text := 'no error'; v_n int;
BEGIN
  SELECT v INTO v_p2 FROM n_fix WHERE k='p2';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000bb01', true);
  SET LOCAL ROLE authenticated;
  -- ⭐⭐ THE SPLIT (D115). Creating the shared product RECORD is company property
  -- now — a plant admin cannot do it. This supersedes the old case, which had a
  -- plant admin CREATE a product. `app_is_admin()` is false for a Plant 1 site
  -- admin, so products_insert refuses (42501) before anything is written.
  BEGIN
    INSERT INTO products (org_id, sku, name)
      VALUES ('10000000-0000-0000-0000-000000000001','NNEW','N New Product');
  EXCEPTION WHEN OTHERS THEN v_record := SQLSTATE; END;
  -- But the LIST of makers is per-plant: D109's ancestor rule still does its
  -- job through product_sites_insert. `app_is_admin_for` is an admin grant on an
  -- ancestor-or-self, so the Plant 1 admin may add any place under their plant.
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','62000000-0000-0000-0000-0000000000c1',
              '30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN v_line := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN
    INSERT INTO product_sites (org_id, product_id, node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','62000000-0000-0000-0000-0000000000c1', v_p2);
  EXCEPTION WHEN OTHERS THEN v_other := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM product_sites
   WHERE product_id='62000000-0000-0000-0000-0000000000c1' AND node_id = v_p2;
  IF v_record = '42501' AND v_line = 'no error' AND v_other = '42501' AND v_n = 0
  THEN RAISE NOTICE 'PASS N17';
  ELSE RAISE NOTICE 'FAIL N17: create_record=% own_line_place=% other_plant_place=% stored=% (want 42501, no error, 42501, 0)',
    v_record, v_line, v_other, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL N17: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N17;

\echo 'N18 ⭐: app_owner_covers is SELF-SCOPED — a node pair from another tenant answers false, not true'
SAVEPOINT sp_N18;
DO $$
DECLARE v_cross boolean; v_same boolean;
BEGIN
  -- [[site-instance-model]] shape 1: a SECURITY DEFINER function that takes an
  -- id as a parameter is a leak unless it is self-scoped. This one takes TWO,
  -- so the question is asked twice as hard. Org 2's tree has the same paths as
  -- org 1's by construction (the seed says so), which is exactly the shape
  -- that turns a missing org term into a true answer about somebody else.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000bb01', true);
  SET LOCAL ROLE authenticated;
  SELECT app_owner_covers('3000000b-0000-0000-0000-000000000001',
                          '3000000b-0000-0000-0000-000000000007') INTO v_cross;
  SELECT app_owner_covers('30000000-0000-0000-0000-000000000001',
                          '30000000-0000-0000-0000-000000000007') INTO v_same;
  RESET ROLE;
  IF v_cross IS NOT TRUE AND v_same IS TRUE THEN RAISE NOTICE 'PASS N18';
  ELSE RAISE NOTICE 'FAIL N18: other_tenant=% own_tenant=% (want false, true)', v_cross, v_same; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL N18: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_N18;

ROLLBACK;
