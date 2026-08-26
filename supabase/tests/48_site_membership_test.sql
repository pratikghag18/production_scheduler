-- ============================================================================
-- 48_site_membership_test.sql — migration 0021, "who can get in, and who
-- a site admin is allowed to see."
--
-- 0020 §9 shipped a hole it named itself: a site admin could WRITE a grant for
-- a person they could not READ. 0021 closes it with one read function and two
-- write functions, and this file is what makes each of them falsifiable.
--
-- THE FIXTURE IS 47's, DELIBERATELY, and for the reason 47 built it: org 1
-- seeds a single root, so "another site" and "another tenant" would be the
-- same fixture, and a cross-TENANT refusal proves nothing about a cross-SITE
-- one. Two plants in one company, or nothing here means anything.
--
-- ⭐ AND EVERY SITE ADMIN BELOW HOLDS THE ORG-WIDE ROLE 'viewer'. If any of
-- them were an org-wide 'admin', `app_is_admin()` would short-circuit the
-- first branch of every predicate under test and this whole file would pass
-- against a migration that did nothing. 46 learned it, 47 repeated it, and it
-- is the single property this file rests on -- X0 asserts it.
--
-- Org 1 tree after the fixture:
--   plant_1                              30000000-...-0001  Site
--     plant_1.assembly                   30000000-...-0002  Department
--       plant_1.assembly.line_1          30000000-...-0004  Line
--       plant_1.assembly.line_2          30000000-...-0005  Line
--     plant_1.machining                  30000000-...-0003  Department
--   plant_2                              v_p2               (its OWN copy)
--     plant_2.fabrication                v_p2_dept
--
-- People in org 1 (the d-series are all org-wide 'viewer'):
--   a1  company admin (seed)                admin@example.test
--   a2, a3  seed supervisors with grants inside Plant 1
--   d1  admin grant on plant_1              -- site admin of Plant 1
--   d2  admin grant on plant_2              -- site admin of Plant 2
--   d3  admin grant on assembly             -- a mid-tree admin, NOT a site admin
--   d4  supervisor grant on plant_1         -- not an admin at all
--   d6  NO GRANT ANYWHERE                   -- the person the picker exists for
--
-- ⭐ d6 IS NOT DECORATION. Every "add a member" case needs a person who is not
-- already a member, and a fixture whose only candidates are existing members
-- cannot tell "added" from "already there".
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- FIXTURE. Plant 2 is built through the real RPCs as org 1's company admin,
-- so §10's copy-on-root-create is exercised by the fixture itself.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE x_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_orphan uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  v_p2   := (create_node(NULL, 'Plant 2', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,  'Fabrication', 0)->>'id')::uuid;

  -- An UNOWNED structure, the state 0020 §1 calls "born unowned". It must be
  -- editable by a company admin and by NOBODY else -- X1 and X5.
  v_orphan := (create_hierarchy_template('Orphan Shape')->>'id')::uuid;

  RESET ROLE;

  INSERT INTO x_fix (k, v) VALUES
    ('p2', v_p2), ('p2_dept', v_dept), ('orphan', v_orphan),
    ('p2_tpl', (SELECT hl.template_id FROM nodes n
                  JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_p2));

  -- ⭐ EMAILS, and they are the point of §3. `user_profiles` has no name
  -- column and the seed sets `raw_user_meta_data` to '{}', so the sign-in
  -- address is the only human-readable thing the picker can show. A fixture
  -- without emails would let a mutation that returns NULL for every one of
  -- them pass unnoticed.
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000d1', 'dana@example.test'),
    ('00000000-0000-0000-0000-0000000000d2', 'quinn@example.test'),
    ('00000000-0000-0000-0000-0000000000d3', 'raj@example.test'),
    ('00000000-0000-0000-0000-0000000000d4', 'sam@example.test'),
    ('00000000-0000-0000-0000-0000000000d6', 'nobody@example.test'),
    -- ⭐ e1 EXISTS FOR ONE CASE, X8, AND COULD NOT BE THE SEED'S ADMIN. The
    -- seeded company admin a1 holds an admin GRANT on Plant 1 as well as the
    -- org-wide flag, so "a company admin reaches everything without a grant"
    -- cannot be measured against them -- the grant explains the access on its
    -- own. e1 has the flag and nothing else, which is the only state that
    -- tells `companyAdmin` from `grants`.
    ('00000000-0000-0000-0000-0000000000e1', 'boss@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d1','viewer'),
    ('d0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d2','viewer'),
    ('d0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d3','viewer'),
    ('d0000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d4','viewer'),
    ('d0000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d6','viewer'),
    ('e0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','admin');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000002', v_p2,                                  '10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor');
END $$;

\echo 'X0: the fixture is what the rest of this file assumes'
SAVEPOINT sp_X0;
RESET ROLE;
DO $$
DECLARE
  v_roots int; v_org1_people int; v_no_email int; v_d6_grants int; v_admins int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT count(*) INTO v_org1_people FROM user_profiles
   WHERE org_id = '10000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_no_email FROM user_profiles up
    JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = '10000000-0000-0000-0000-000000000001' AND u.email IS NULL;
  SELECT count(*) INTO v_d6_grants FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000006';
  SELECT count(*) INTO v_admins FROM user_profiles
   WHERE id::text LIKE 'd0000000%' AND role = 'admin';

  IF v_roots = 2 AND v_org1_people = 9 AND v_no_email = 0
     AND v_d6_grants = 0 AND v_admins = 0
  THEN RAISE NOTICE 'PASS X0';
  ELSE RAISE NOTICE 'FAIL X0: roots=% (want 2), people=% (want 9), missing_email=% (want 0), d6_grants=% (want 0), org_admins_among_d=% (want 0)',
       v_roots, v_org1_people, v_no_email, v_d6_grants, v_admins;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X0;


-- ############################################################################
-- PART A — editable_shape_ids (§2). The shape picker's filter.
-- ############################################################################

\echo 'X1: a company admin may edit every structure in their own company'
SAVEPOINT sp_X1;
DO $$
DECLARE v_out jsonb; v_n int; v_p2_tpl text; v_orphan text;
BEGIN
  -- ⭐ THE FIXTURE TABLE IS READ BEFORE THE ROLE CHANGE, EVERY TIME. A TEMP
  -- table belongs to the session user, and `authenticated` gets `42501
  -- permission denied for table x_fix` -- which arrives with NO DETAIL and is
  -- indistinguishable, at a glance, from the RLS refusal X16 is about.
  -- Instrument failure 34: the first draft of X16 read as "the pre-check is
  -- missing" for exactly this reason, and the pre-check was fine.
  SELECT v::text INTO v_p2_tpl FROM x_fix WHERE k = 'p2_tpl';
  SELECT v::text INTO v_orphan FROM x_fix WHERE k = 'orphan';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_out := editable_shape_ids();
  RESET ROLE;
  SELECT jsonb_array_length(v_out) INTO v_n;
  -- Standard Plant (Plant 1's), Plant 2's own copy, and the orphan.
  IF v_n = 3
     AND v_out ? '21000000-0000-0000-0000-000000000001'
     AND v_out ? v_p2_tpl
     AND v_out ? v_orphan
     AND NOT (v_out ? '2100000b-0000-0000-0000-000000000001')  -- org 2's
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: n=% v=%', v_n, v_out; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2: a SITE admin may edit exactly one structure -- their own site''s'
SAVEPOINT sp_X2;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := editable_shape_ids();
  RESET ROLE;
  IF v = jsonb_build_array('21000000-0000-0000-0000-000000000001')
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3: with RLS BYPASSED, the picker filter still never reports another tenant''s structure'
SAVEPOINT sp_X3;
RESET ROLE;
DO $$
DECLARE v jsonb;
BEGIN
  -- ⭐ THIS CASE CHANGED ITS MEANING AFTER THE MUTATION RUN, AND THE OLD
  -- MEANING WAS WRONG. It was written to test `editable_shape_ids`' OWN
  -- `t.org_id = app_current_org()` term, on the usual rule-10 argument: under
  -- `authenticated` the SELECT policy supplies the org scope, so only the
  -- TABLE OWNER can see whether the function carries one. Mutation Y3 deleted
  -- that term and was NOT CAUGHT -- `app_is_admin_for_template` is SECURITY
  -- DEFINER and scopes the org itself, refusing org 2's structure before this
  -- query sees it. The term is gone; the case stays, testing the COMPOSITION
  -- with RLS off, which is a real property and the one that would break if
  -- either half were changed.
  --
  -- The caller must be a COMPANY admin: app_is_admin() is not org-scoped and
  -- is the first branch of the OR inside the delegate.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  v := editable_shape_ids();
  IF NOT (v ? '2100000b-0000-0000-0000-000000000001')
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: org 2''s structure leaked to org 1: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4: somebody who administers nothing gets [], and it is [] and not NULL'
SAVEPOINT sp_X4;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  v := editable_shape_ids();
  RESET ROLE;
  -- The distinction is the whole point of the coalesce: a client that has to
  -- tell "no shapes" from "the call failed" will eventually fail to.
  IF v = '[]'::jsonb AND v IS NOT NULL
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: % (is null: %)', v, (v IS NULL); END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5: a MID-TREE admin edits no structure -- a structure is owned by a ROOT'
SAVEPOINT sp_X5;
DO $$
DECLARE v jsonb;
BEGIN
  -- d3 administers Assembly, a Department. 0020 §1 refuses a non-root owner,
  -- so there is no structure whose site_node_id is inside d3's grant, and the
  -- level vocabulary of the whole plant above them stays out of reach.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  v := editable_shape_ids();
  RESET ROLE;
  IF v = '[]'::jsonb
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: a department admin reached %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;


-- ############################################################################
-- PART B — site_people (§3). The reciprocal read 0020 §9 promised.
-- ############################################################################

\echo 'X6: a site admin sees every person in their COMPANY, with emails, and nobody from another'
SAVEPOINT sp_X6;
DO $$
DECLARE v jsonb; v_n int; v_emails int; v_foreign int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT jsonb_array_length(v->'people') INTO v_n;
  SELECT count(*) INTO v_emails
    FROM jsonb_array_elements(v->'people') p WHERE p->>'email' IS NOT NULL;
  SELECT count(*) INTO v_foreign
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'email' LIKE '%@contoso.example';
  IF v_n = 9 AND v_emails = 9 AND v_foreign = 0
     AND v->>'nodeName' = 'Plant 1'
  THEN RAISE NOTICE 'PASS X6';
  ELSE RAISE NOTICE 'FAIL X6: people=% (want 9), with_email=% (want 9), other_tenant=% (want 0), nodeName=%',
       v_n, v_emails, v_foreign, v->>'nodeName'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X6;

\echo 'X7: a grant is reported with the NAME of the place it sits on'
SAVEPOINT sp_X7;
DO $$
DECLARE v jsonb; g jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT p->'grants'->0 INTO g
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'profileId' = 'd0000000-0000-0000-0000-000000000004';
  -- Without the name the screen can say "Sam has access" and not WHERE, which
  -- on a plant with four departments is not an answer.
  IF g->>'role' = 'supervisor' AND g->>'nodeName' = 'Plant 1'
     AND g->>'nodeId' = '30000000-0000-0000-0000-000000000001'
  THEN RAISE NOTICE 'PASS X7';
  ELSE RAISE NOTICE 'FAIL X7: %', g; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X7;

\echo 'X8: a company admin has NO grant and still reaches everything -- the screen must say so'
SAVEPOINT sp_X8;
DO $$
DECLARE v jsonb; p jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT e INTO p FROM jsonb_array_elements(v->'people') e
   WHERE e->>'profileId' = 'e0000000-0000-0000-0000-000000000001';
  -- Without `companyAdmin` the screen lists the company admin under "no
  -- access" next to a button that would do nothing useful for them.
  IF (p->>'companyAdmin')::boolean IS TRUE
     AND p->>'orgRole' = 'admin'
     AND p->'grants' = '[]'::jsonb
  THEN RAISE NOTICE 'PASS X8';
  ELSE RAISE NOTICE 'FAIL X8: %', p; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X8;

\echo 'X9 ⭐: grants are gathered over the SUBTREE, not the one node asked about'
SAVEPOINT sp_X9;
DO $$
DECLARE v jsonb; g jsonb;
BEGIN
  -- d3's admin grant sits on Assembly, one rung BELOW Plant 1. A site admin
  -- looking at their plant must see the four people who can already edit
  -- inside it; listing only grants whose node_id equals the node asked about
  -- shows an empty list on a plant four people administer, which is worse than
  -- useless -- it is misleading.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT p->'grants'->0 INTO g
    FROM jsonb_array_elements(v->'people') p
   WHERE p->>'profileId' = 'd0000000-0000-0000-0000-000000000003';
  IF g->>'role' = 'admin' AND g->>'nodeName' = 'Assembly'
  THEN RAISE NOTICE 'PASS X9';
  ELSE RAISE NOTICE 'FAIL X9: a grant below the node was not seen: %', g; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X9;

\echo 'X9b ⭐: ...and the subtree EXCLUDES -- Plant 2''s admin sees no Plant 1 grants'
SAVEPOINT sp_X9b;
DO $$
DECLARE v_out jsonb; v_with int; v_p2 uuid;
BEGIN
  -- The other half of X9, and the half a `TRUE` containment predicate passes.
  -- X9 alone is green against `gn.path <@ gn.path`, against `true`, and against
  -- dropping the containment term entirely.
  SELECT v INTO v_p2 FROM x_fix WHERE k = 'p2';   -- before the role change (X1's note)
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  SET LOCAL ROLE authenticated;
  v_out := site_people(v_p2);
  RESET ROLE;
  SELECT count(*) INTO v_with
    FROM jsonb_array_elements(v_out->'people') p
   WHERE jsonb_array_length(p->'grants') > 0
     AND p->>'profileId' <> 'd0000000-0000-0000-0000-000000000002';
  IF v_with = 0
  THEN RAISE NOTICE 'PASS X9b';
  ELSE RAISE NOTICE 'FAIL X9b: % people outside Plant 2 reported grants inside it', v_with; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X9b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X9b;

\echo 'X10: a supervisor is refused -- administering the place is what buys the read'
SAVEPOINT sp_X10;
DO $$
DECLARE v_raw text; v_detail jsonb; v_err text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM site_people('30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    v_err := v_detail->>'error';
  END;
  RESET ROLE;
  IF v_err = 'not_permitted'
  THEN RAISE NOTICE 'PASS X10';
  ELSE RAISE NOTICE 'FAIL X10: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X10;

\echo 'X11: a node that does not exist is invalid_argument, not not_permitted'
SAVEPOINT sp_X11;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM site_people('99999999-9999-9999-9999-999999999999');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X11';
  ELSE RAISE NOTICE 'FAIL X11: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X11;

\echo 'X12: another tenant''s node is "not found", never "not permitted"'
SAVEPOINT sp_X12;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- Told apart on purpose: "not permitted" on a real id in another company
  -- confirms the id is real. app_node_exists_in_org is org-scoped, so org 2's
  -- root simply does not exist as far as org 1 is concerned.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM site_people('3000000b-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X12';
  ELSE RAISE NOTICE 'FAIL X12: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X12;

\echo 'X13: existence is checked BEFORE permission (0020 §8''s ordering, one file over)'
SAVEPOINT sp_X13;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- d4 administers nothing AND the node is fictional. The refusal must name
  -- the node, not the permission -- otherwise a typo reads as a permissions
  -- problem and the admin goes looking in the wrong place.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM site_people('99999999-9999-9999-9999-999999999999');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument'
  THEN RAISE NOTICE 'PASS X13';
  ELSE RAISE NOTICE 'FAIL X13: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X13;


-- ############################################################################
-- PART C — set_site_member (§4). Add a person, or change the role they hold.
-- ############################################################################

\echo 'X14: a site admin adds somebody who had no access at all'
SAVEPOINT sp_X14;
DO $$
DECLARE v jsonb; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := set_site_member('30000000-0000-0000-0000-000000000001',
                       'd0000000-0000-0000-0000-000000000006', 'supervisor');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000006'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'supervisor'
     AND v->>'role' = 'supervisor'
     AND v->>'profileId' = 'd0000000-0000-0000-0000-000000000006'
  THEN RAISE NOTICE 'PASS X14';
  ELSE RAISE NOTICE 'FAIL X14: row=% returned=%', v_role, v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X14;

\echo 'X15: changing a role edits the row it already has -- one row, not two'
SAVEPOINT sp_X15;
DO $$
DECLARE v_n int; v_role text;
BEGIN
  -- profile_grants is keyed (profile_id, node_id), so "add" and "re-role" are
  -- the same row. A second row would be a second answer to one question.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'd0000000-0000-0000-0000-000000000006', 'supervisor');
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'd0000000-0000-0000-0000-000000000006', 'viewer');
  RESET ROLE;
  SELECT count(*), min(role) INTO v_n, v_role FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000006';
  IF v_n = 1 AND v_role = 'viewer'
  THEN RAISE NOTICE 'PASS X15';
  ELSE RAISE NOTICE 'FAIL X15: rows=% role=%', v_n, v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X15;

\echo 'X16 ⭐: refused across sites -- AND the refusal is typed, not a raw 42501'
SAVEPOINT sp_X16;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_rows int; v_p2 uuid;
BEGIN
  -- THE SHAPE OF THE REFUSAL IS THE ASSERTION. Delete the pre-check and RLS
  -- still refuses -- as `42501 new row violates row-level security policy`,
  -- which reaches the user as a database error instead of a sentence. That is
  -- the mutation this case exists to catch; asserting "it was refused" alone
  -- would pass against the deletion.
  SELECT v INTO v_p2 FROM x_fix WHERE k = 'p2';   -- before the role change (X1's note)
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member(v_p2, 'd0000000-0000-0000-0000-000000000006', 'admin');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000006';
  IF v_detail->>'error' = 'not_permitted' AND v_state = 'PT403' AND v_rows = 0
  THEN RAISE NOTICE 'PASS X16';
  ELSE RAISE NOTICE 'FAIL X16: sqlstate=% detail=% rows_written=%', v_state, v_detail, v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X16;

\echo 'X17 ⭐: the escalation -- a mid-tree admin cannot grant themselves the plant'
SAVEPOINT sp_X17;
DO $$
DECLARE v_raw text; v_detail jsonb; v_rows int;
BEGIN
  -- d3 administers Assembly. Writing themselves an admin row on Plant 1 --
  -- the node ABOVE their grant -- would hand them the whole plant, and a grant
  -- covers a subtree DOWNWARD, never upward. This is 0020's stated escalation
  -- arriving through the new front door.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'd0000000-0000-0000-0000-000000000003', 'admin');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000003'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_rows = 0
  THEN RAISE NOTICE 'PASS X17';
  ELSE RAISE NOTICE 'FAIL X17: detail=% rows=%', v_detail, v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X17;

\echo 'X18: an unknown role is invalid_argument naming the field, not a check violation'
SAVEPOINT sp_X18;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'd0000000-0000-0000-0000-000000000006', 'owner');
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- 23514 would be the CHECK constraint doing the refusing, which tells the
  -- user nothing they can act on.
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'field' = 'role'
     AND v_state = 'PT400'
  THEN RAISE NOTICE 'PASS X18';
  ELSE RAISE NOTICE 'FAIL X18: sqlstate=% detail=%', v_state, v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X18;

\echo 'X19: a NULL role is the same refusal -- NOT NULL would otherwise decide it'
SAVEPOINT sp_X19;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- `p_role NOT IN (...)` is NULL, not FALSE, when p_role is NULL -- which is
  -- exactly how a NULL slips past a membership test and lands on the column's
  -- NOT NULL as a 23502. The explicit `p_role IS NULL` term is what this case
  -- is for, and it is the term a mutation removes first.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'd0000000-0000-0000-0000-000000000006', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'field' = 'role'
  THEN RAISE NOTICE 'PASS X19';
  ELSE RAISE NOTICE 'FAIL X19: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X19;

\echo 'X20 ⭐: a site admin cannot take away their OWN admin access here (asserted on purpose)'
SAVEPOINT sp_X20;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  -- A PRODUCT RULE, NOT A SAFETY ONE, pinned the way 0020's W24 pins its
  -- unwanted refusal: whoever decides this is wrong has to delete this case
  -- deliberately rather than discover it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'd0000000-0000-0000-0000-000000000001', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'self'
     AND v_role = 'admin'
  THEN RAISE NOTICE 'PASS X20';
  ELSE RAISE NOTICE 'FAIL X20: detail=% role_now=%', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X20;

\echo 'X21 ⭐: ...and the rule is NARROW -- a harmless self-grant elsewhere is allowed'
SAVEPOINT sp_X21;
DO $$
DECLARE v jsonb; v_role text;
BEGIN
  -- ⭐ THE CASE THE BROAD VERSION FAILS. The first draft refused any change to
  -- your own row; its own comment described the narrow rule. d1 adding
  -- themselves as a viewer on Assembly takes nothing away -- their admin grant
  -- on Plant 1 above still covers it, because the strongest covering grant
  -- wins (0019) -- so refusing it would refuse a harmless thing with a
  -- frightening message.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := set_site_member('30000000-0000-0000-0000-000000000002',
                       'd0000000-0000-0000-0000-000000000001', 'viewer');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v->>'role' = 'viewer' AND v_role = 'viewer'
  THEN RAISE NOTICE 'PASS X21';
  ELSE RAISE NOTICE 'FAIL X21: returned=% row=%', v, v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X21: refused a harmless self-grant: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X21;

\echo 'X22: re-asserting your own admin role is not a demotion and is allowed'
SAVEPOINT sp_X22;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := set_site_member('30000000-0000-0000-0000-000000000001',
                       'd0000000-0000-0000-0000-000000000001', 'admin');
  RESET ROLE;
  IF v->>'role' = 'admin' THEN RAISE NOTICE 'PASS X22';
  ELSE RAISE NOTICE 'FAIL X22: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X22: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X22;

\echo 'X23: a company admin may demote a site admin'
SAVEPOINT sp_X23;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'd0000000-0000-0000-0000-000000000001', 'viewer');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS X23';
  ELSE RAISE NOTICE 'FAIL X23: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X23: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X23;

\echo 'X24: an unknown person is invalid_argument, and reachable only by an admin here'
SAVEPOINT sp_X24;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            '88888888-8888-8888-8888-888888888888', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
     AND v_detail ? 'profile_id'
  THEN RAISE NOTICE 'PASS X24';
  ELSE RAISE NOTICE 'FAIL X24: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X24;

\echo 'X25 ⭐: for a PERSON the order inverts -- permission is checked BEFORE existence'
SAVEPOINT sp_X25;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- 0020 §8 puts existence first so a caller who MAY act is told the thing is
  -- missing. Here the subject is a person, and "does an account for this
  -- address exist in the company" is not a question an outsider gets to ask.
  -- d4 administers nothing, so they must be refused BEFORE the lookup runs --
  -- otherwise this function is a membership oracle for anybody signed in.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            '88888888-8888-8888-8888-888888888888', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS X25';
  ELSE RAISE NOTICE 'FAIL X25: detail=% (a non-admin learned whether a profile exists)', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X25;

\echo 'X26: a person from another tenant does not exist here'
SAVEPOINT sp_X26;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                            'a000000b-0000-0000-0000-000000000002', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X26';
  ELSE RAISE NOTICE 'FAIL X26: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X26;


-- ############################################################################
-- PART D — remove_site_member (§5). The one whose refusal would be SILENT.
-- ############################################################################

\echo 'X27: a site admin takes somebody''s access away'
SAVEPOINT sp_X27;
DO $$
DECLARE v jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v := remove_site_member('30000000-0000-0000-0000-000000000001',
                          'd0000000-0000-0000-0000-000000000004');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000004'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_n = 0 AND v->>'removedRole' = 'supervisor'
  THEN RAISE NOTICE 'PASS X27';
  ELSE RAISE NOTICE 'FAIL X27: rows_left=% returned=%', v_n, v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X27: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X27;

\echo 'X28 ⭐⭐: refused across sites -- and the row is STILL THERE'
SAVEPOINT sp_X28;
DO $$
DECLARE v_raw text; v_detail jsonb; v_n int;
BEGIN
  -- THIS IS THE CASE THE FUNCTION EXISTS FOR. A DELETE under RLS removes the
  -- rows the USING clause admits and reports success for the rest: wired
  -- straight to PostgREST, Plant 2's admin clicking "remove" on Plant 1's
  -- admin gets a green tick, the row disappears from the list, and the next
  -- refetch puts it back with no explanation. Asserting the refusal is only
  -- half -- the row count is the other half, and it is the half that fails if
  -- the guard moves after the DELETE.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'd0000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_n = 1
  THEN RAISE NOTICE 'PASS X28';
  ELSE RAISE NOTICE 'FAIL X28: detail=% rows_left=% (want 1)', v_detail, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X28;

\echo 'X29: removing access that is not there is a refusal, not a shrug'
SAVEPOINT sp_X29;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- Two admins with the same screen open should not both be told they
  -- succeeded at removing the same person.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'd0000000-0000-0000-0000-000000000006');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X29';
  ELSE RAISE NOTICE 'FAIL X29: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X29;

\echo 'X30: a site admin cannot remove their own admin access'
SAVEPOINT sp_X30;
DO $$
DECLARE v_raw text; v_detail jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'd0000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'self' AND v_n = 1
  THEN RAISE NOTICE 'PASS X30';
  ELSE RAISE NOTICE 'FAIL X30: detail=% rows_left=%', v_detail, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X30;

\echo 'X31 ⭐: ...but they may drop a non-admin grant of their own'
SAVEPOINT sp_X31;
DO $$
DECLARE v jsonb; v_n int; v_other int;
BEGIN
  -- The narrowing again, from the DELETE side. Only the row that currently
  -- makes them an admin OF THIS NODE is protected. A broad "never your own
  -- row" rule passes X30 and fails here.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000002',
                          'd0000000-0000-0000-0000-000000000001', 'viewer');
  v := remove_site_member('30000000-0000-0000-0000-000000000002',
                          'd0000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  -- ⭐ AND THE OTHER GRANT MUST SURVIVE. A DELETE that forgets its node_id term
  -- removes every grant that person holds anywhere -- and every case that only
  -- counts the row it asked about is green against it.
  SELECT count(*) INTO v_other FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_n = 0 AND v_other = 1 AND v->>'removedRole' = 'viewer'
  THEN RAISE NOTICE 'PASS X31';
  ELSE RAISE NOTICE 'FAIL X31: rows_left=% other_grants_left=% (want 1) returned=%', v_n, v_other, v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X31: refused a harmless self-removal: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X31;

\echo 'X32: a supervisor removes nobody'
SAVEPOINT sp_X32;
DO $$
DECLARE v_raw text; v_detail jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000001',
                               'd0000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_n = 1
  THEN RAISE NOTICE 'PASS X32';
  ELSE RAISE NOTICE 'FAIL X32: detail=% rows=%', v_detail, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X32;


\echo 'X34: the people list comes back in a deterministic, collation-independent order'
SAVEPOINT sp_X34;
DO $$
DECLARE v_out jsonb; v_sorted boolean;
BEGIN
  -- Migration 0011's lesson, one function over: a collation-dependent
  -- comparison gave two machines two answers once already, so the order is
  -- `email COLLATE "C"` -- code points, never the database default. Without a
  -- case the ORDER BY is free to disappear and every other case here still
  -- passes, because they all look a person up by id.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_out := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT bool_and(prev IS NULL OR prev < cur) INTO v_sorted FROM (
    SELECT lag(p->>'email') OVER (ORDER BY ord) AS prev, p->>'email' AS cur
      FROM jsonb_array_elements(v_out->'people') WITH ORDINALITY t(p, ord)
  ) z;
  IF v_sorted THEN RAISE NOTICE 'PASS X34';
  ELSE RAISE NOTICE 'FAIL X34: not ascending by email: %',
       (SELECT jsonb_agg(p->>'email') FROM jsonb_array_elements(v_out->'people') p); END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X34: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X34;

\echo 'X35: set_site_member on a node that does not exist names the NODE'
SAVEPOINT sp_X35;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_site_member('99999999-9999-9999-9999-999999999999',
                            'd0000000-0000-0000-0000-000000000006', 'viewer');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- `node_id` in the detail, not `profile_id`: the two invalid_argument
  -- refusals in this function are told apart by which key they carry, and a
  -- case that only checks the error name cannot tell them apart at all.
  IF v_detail->>'error' = 'invalid_argument' AND v_detail ? 'node_id'
     AND NOT (v_detail ? 'profile_id')
  THEN RAISE NOTICE 'PASS X35';
  ELSE RAISE NOTICE 'FAIL X35: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X35;

\echo 'X36: a company admin IS exempt from the self-rule'
SAVEPOINT sp_X36;
DO $$
DECLARE v_role text;
BEGIN
  -- a1 is the seeded company admin and holds an admin grant on Plant 1 as
  -- well. Demoting that grant costs them nothing -- the org-wide flag still
  -- reaches every site -- so the rule must not fire. Without this case the
  -- `NOT app_is_admin()` term can be deleted and nothing goes red.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_site_member('30000000-0000-0000-0000-000000000001',
                          'a0000000-0000-0000-0000-000000000001', 'viewer');
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS X36';
  ELSE RAISE NOTICE 'FAIL X36: role=%', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X36: the self-rule fired on a company admin: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X36;

\echo 'X37: "nothing here to remove" is the truer sentence than "not your own"'
SAVEPOINT sp_X37;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  -- Both conditions hold at once: it is d1's own profile AND there is no row
  -- on Assembly. The not-found check runs first on purpose, and this is the
  -- only state that can tell the two orderings apart.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM remove_site_member('30000000-0000-0000-0000-000000000002',
                               'd0000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS X37';
  ELSE RAISE NOTICE 'FAIL X37: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X37;


\echo 'X38: the editable-shape ids come back in a deterministic order'
SAVEPOINT sp_X38;
DO $$
DECLARE v_out jsonb; v_sorted boolean;
BEGIN
  -- ⭐ THE CONTRACT IS "ASCENDING BY ID", AND THAT IS WHAT THIS ASSERTS -- not
  -- "the ORDER BY clause is present", which is a different and weaker claim
  -- than it looks. Mutation Y5b removes the ordering entirely, and it was
  -- **NOT CAUGHT on one run and CAUGHT on the next, with nothing changed
  -- between them** -- measured, not suspected. Two of the three fixture
  -- structures get `gen_random_uuid()` ids, so the heap order is ascending by
  -- luck often enough that a case asserting order passes against the
  -- unordered mutant a good share of the time. A fixture row with a
  -- deliberately low id was added to break the tie and did not: the planner
  -- reuses free slots, so PHYSICAL ORDER IS NOT SOMETHING A TEST MAY ASSUME,
  -- and the row was removed again rather than left looking load-bearing.
  --
  -- Y5 (`ORDER BY t.id DESC`) is the mutation this case does catch, on every
  -- run and at any fixture size, and it is the one that matters: it is the
  -- shape a careless edit actually takes. Y5b stays in the table, marked NOT
  -- CAUGHT and environment-dependent, so nobody re-derives this.
  --
  -- Determinism is a property this project pays for elsewhere -- 0011's
  -- collation lesson, D92's heap-order precondition -- which is why the
  -- ORDER BY stays rather than being deleted as untestable.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_out := editable_shape_ids();
  RESET ROLE;
  SELECT bool_and(prev IS NULL OR prev < cur) INTO v_sorted FROM (
    SELECT lag(e #>> '{}') OVER (ORDER BY ord) AS prev, e #>> '{}' AS cur
      FROM jsonb_array_elements(v_out) WITH ORDINALITY z(e, ord)
  ) q;
  -- The premise, checked rather than assumed (rule 3b): "ascending" says
  -- nothing about a one-element array.
  IF jsonb_array_length(v_out) < 2 THEN
    RAISE NOTICE 'FAIL X38: only % shape(s) -- the fixture cannot show an order', jsonb_array_length(v_out);
  ELSIF v_sorted THEN RAISE NOTICE 'PASS X38';
  ELSE RAISE NOTICE 'FAIL X38: not ascending: %', v_out; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X38: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X38;

\echo 'X39 ⭐: the impossibility that makes site_people''s org terms inert, pinned directly'
SAVEPOINT sp_X39;
RESET ROLE;
DO $$
DECLARE v_state text := ''; 
BEGIN
  -- ⭐ A SHADOW CASE, the same device 0020 §9 used for its shadowed UPDATE
  -- clause. `site_people`'s grant subquery carries `pg.org_id = v_org` and
  -- `gn.org_id = v_org`, and mutation Y12 removed BOTH and was NOT CAUGHT --
  -- not because the terms are pointless (a path is unique only per
  -- `(org_id, path)`, so org 2 has its own `plant_1.assembly` and it IS
  -- contained in `plant_1`) but because `profile_grants`' composite foreign
  -- keys make the leaking row unconstructable.
  --
  -- That masking lives in ANOTHER MIGRATION (0006's D3 idiom), so this case
  -- asserts it here: relax either FK and X39 goes red, which is the signal to
  -- come back and re-read Y12 rather than discover a cross-tenant leak.
  --
  -- As the TABLE OWNER, so RLS cannot be what refuses it -- the foreign key
  -- must be, and 23503 is the proof.
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role)
      VALUES ('d0000000-0000-0000-0000-000000000001',      -- org 1's person
              '3000000b-0000-0000-0000-000000000002',      -- org 2's Assembly
              '10000000-0000-0000-0000-000000000001', 'admin');
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  IF v_state = '23503' THEN RAISE NOTICE 'PASS X39';
  ELSE RAISE NOTICE 'FAIL X39: sqlstate=% (expected 23503 -- a cross-tenant grant became constructable)', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X39;


-- ############################################################################
-- PART E — the grants themselves (§6).
-- ############################################################################

\echo 'X33: EXECUTE is granted to authenticated, and to nobody else'
SAVEPOINT sp_X33;
RESET ROLE;
DO $$
DECLARE
  v_fns text[] := ARRAY['app_profile_exists_in_org','editable_shape_ids',
                        'site_people','set_site_member','remove_site_member'];
  v_fn text; v_bad text := '';
BEGIN
  -- PostgreSQL grants EXECUTE on a NEW FUNCTION to PUBLIC by default, unlike
  -- tables -- api.md §6.2 records that as a deviation found the hard way. A
  -- missing REVOKE is invisible in every other case in this file, because
  -- `authenticated` is granted anyway and every case runs as somebody.
  FOREACH v_fn IN ARRAY v_fns LOOP
    IF has_function_privilege('public', (SELECT p.oid FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname = v_fn LIMIT 1), 'EXECUTE')
    THEN v_bad := v_bad || v_fn || ' reachable by PUBLIC; ';
    END IF;
    IF NOT has_function_privilege('authenticated', (SELECT p.oid FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname = v_fn LIMIT 1), 'EXECUTE')
    THEN v_bad := v_bad || v_fn || ' NOT reachable by authenticated; ';
    END IF;
    IF has_function_privilege('anon', (SELECT p.oid FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname = v_fn LIMIT 1), 'EXECUTE')
    THEN v_bad := v_bad || v_fn || ' reachable by anon; ';
    END IF;
  END LOOP;
  IF v_bad = '' THEN RAISE NOTICE 'PASS X33';
  ELSE RAISE NOTICE 'FAIL X33: %', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X33: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X33;

ROLLBACK;

\echo '48_site_membership_test.sql complete (41 cases: X0-X39 plus X9b)'
