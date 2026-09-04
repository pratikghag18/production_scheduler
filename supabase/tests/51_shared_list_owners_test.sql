-- ============================================================================
-- 51_shared_list_owners_test.sql — migration 0023, "the shared lists get an
-- owner, and a product gets a colour of its own."
--
-- THE MAINTAINER'S WORDS (D101/D102):
--   "The shift pattern will be per-site, we can have defaults but I'd rather
--    the site admin set them up for their site, same thing for colours."
--
-- THE FIXTURE IS THE TEST, and it borrows 46's and 47's sharpest lesson:
-- ⭐ EVERY SITE ADMIN BELOW HOLDS THE ORG-WIDE ROLE 'viewer'. If any of them
-- were an org-wide 'admin', `app_is_admin()` would short-circuit every
-- predicate under test and this whole file would pass against a migration that
-- did nothing.
--
-- ⭐ AND IT NEEDS TWO SITES IN ONE ORG, which the seed does not have. Org 1
-- seeds a single root, so "another site" and "another tenant" would be the same
-- fixture — and a cross-TENANT refusal proves nothing about a cross-SITE one,
-- because org scoping already refuses it three layers earlier.
--
-- ⭐⭐ AND IT NEEDS BOTH AN OWNED AND AN UNOWNED ROW OF EVERY KIND. NULL is not
-- an edge case here, it is the company-wide default the maintainer asked for. A fixture
-- in which everything is owned cannot tell "you may not edit that site's row"
-- from "you may not edit a company-wide row", and those are two different
-- refusals reached through two different branches of one predicate.
--
-- People (all org-wide 'viewer', so nothing short-circuits):
--   g1  admin grant on plant_1     — site admin of Plant 1
--   g2  admin grant on plant_2     — site admin of Plant 2
--   g3  admin grant on assembly    — a MID-TREE admin, and therefore the admin
--                                    of no site at all
--   g4  supervisor grant on plant_1 — not an admin anywhere
-- The seed supplies a1, an org-wide company admin.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE q_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  -- Built through the real RPCs, as 47 does, so Plant 2 is a site made the way
  -- a real one is — including 0020 §10's copy-on-root-create.
  v_p2   := (create_node(NULL, 'Plant 2 (Q)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,  'Fabrication', 0)->>'id')::uuid;
  v_line := (create_node(v_dept,'Weld Line',   0)->>'id')::uuid;

  RESET ROLE;

  INSERT INTO q_fix (k, v) VALUES ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_p2 uuid;
BEGIN
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000e1'),
    ('00000000-0000-0000-0000-0000000000e2'),
    ('00000000-0000-0000-0000-0000000000e3'),
    ('00000000-0000-0000-0000-0000000000e4');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','viewer'),
    ('e0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e2','viewer'),
    ('e0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e3','viewer'),
    ('e0000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e4','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin'),
    ('e0000000-0000-0000-0000-000000000002', v_p2,                                  '10000000-0000-0000-0000-000000000001','admin'),
    ('e0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','admin'),
    ('e0000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor');

  -- One owned by Plant 1, one owned by Plant 2, one deliberately UNOWNED.
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
    ('50000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','Q P1 Operator','30000000-0000-0000-0000-000000000001'::uuid),
    ('50000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','Q P2 Operator', v_p2),
    -- ⭐ 0028/D108: was NULL (company-wide) until this migration. Re-homed to
    -- LINE 1, a scope strictly inside Plant 1, so the cases that used it keep
    -- a third owner to talk about instead of losing their subject.
    ('50000000-0000-0000-0000-00000000ee03','10000000-0000-0000-0000-000000000001','Q Line-1 Operator', '30000000-0000-0000-0000-000000000004'::uuid);

  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES
    ('70000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','Q P1 Pattern','30000000-0000-0000-0000-000000000001'::uuid),
    ('70000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','Q P2 Pattern', v_p2),
    ('70000000-0000-0000-0000-00000000ee03','10000000-0000-0000-0000-000000000001','Q Line-1 Pattern', '30000000-0000-0000-0000-000000000004'::uuid);

  INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
    ('71000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-00000000ee01','Q Day', 360, 840),
    ('71000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-00000000ee02','Q Day', 360, 840);

  INSERT INTO shift_breaks (id, org_id, shift_id, name, start_min, end_min) VALUES
    ('72000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-00000000ee01','Q Lunch', 600, 630),
    ('72000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-00000000ee02','Q Lunch', 600, 630);

  -- D115 (0034): a product's place is a product_sites row, not a column. QP1 is
  -- made in Plant 1, QP2 in Plant 2 — one place each, so the who-may-edit-the-
  -- makers-list cases below read exactly as the old single-owner ones did.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('60000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','QP1','Q P1 Product'),
    ('60000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','QP2','Q P2 Product');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-00000000ee01','30000000-0000-0000-0000-000000000001'::uuid),
    ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-00000000ee02', v_p2);

  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('40000000-0000-0000-0000-00000000ee01','10000000-0000-0000-0000-000000000001','Q Welding','30000000-0000-0000-0000-000000000001'::uuid),
    ('40000000-0000-0000-0000-00000000ee02','10000000-0000-0000-0000-000000000001','Q Line-1 Skill', '30000000-0000-0000-0000-000000000004'::uuid),
    -- ⭐ Added by 0028. Q21's unreachable row used to be the SEEDED
    -- company-wide training; the seed now owns it at the Plant 1 root, which
    -- g1 administers, so the case needed a row on the OTHER plant instead.
    ('40000000-0000-0000-0000-00000000ee04','10000000-0000-0000-0000-000000000001','Q P2 Welding', v_p2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- Q0 asserts the fixture itself. D86's corollary: an id typo is
-- indistinguishable from the behaviour under test whenever the honest answer
-- can be empty.
\echo 'Q0: the fixture is well-formed — two sites in ONE org, and EVERY row owned (0028/D108 abolished the unowned state)'
SAVEPOINT sp_Q0;
DO $$
DECLARE v_p2 uuid; v_roots int; v_owned int; v_unowned int; v_admins int;
BEGIN
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  -- Org-scoped: without it this case fails the day org 2 owns an operator,
  -- for a reason that has nothing to do with the fixture it exists to prove.
  -- ⚠️ FIXTURE-SCOPED, not org-scoped. Before 0028 the seed's nine operators
  -- were all unowned, so an org-wide count of owned rows happened to equal this
  -- file's three. They are all owned now and the org-wide number is 12, which
  -- says nothing about this fixture. Count the rows this file inserted.
  SELECT count(*) INTO v_owned FROM operators
   WHERE id::text LIKE '50000000-0000-0000-0000-00000000ee%' AND site_node_id IS NOT NULL;
  SELECT count(*) INTO v_unowned FROM operators
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND site_node_id IS NULL;
  SELECT count(*) INTO v_admins FROM user_profiles
   WHERE id::text LIKE 'e0000000%' AND role = 'admin';
  -- ⭐ 0028 inverted the last term rather than deleting it: a fixture that still
  -- had an unowned row would mean the NOT NULL never took.
  IF v_roots >= 2 AND v_p2 IS NOT NULL AND v_owned = 3 AND v_unowned = 0 AND v_admins = 0
  THEN RAISE NOTICE 'PASS Q0';
  ELSE RAISE NOTICE 'FAIL Q0: roots=% p2=% owned=% unowned=% org_wide_admins_among_g=% (want >=2, not null, 3, 0, 0)',
    v_roots, v_p2, v_owned, v_unowned, v_admins; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q0;

-- ---------------------------------------------------------------------------
-- OPERATORS — the three-way split that is the whole feature: mine / theirs /
-- everybody's.
-- ---------------------------------------------------------------------------
\echo 'Q1: a site admin edits an operator their OWN site owns'
SAVEPOINT sp_Q1;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  UPDATE operators SET display_name = 'renamed by g1'
   WHERE id = '50000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows = 1 THEN RAISE NOTICE 'PASS Q1';
  ELSE RAISE NOTICE 'FAIL Q1: rows=% (want 1) — a site admin cannot edit their own site''s operator', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q1;

\echo 'Q2: ...and cannot touch the OTHER site''s operator'
SAVEPOINT sp_Q2;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET display_name = 'renamed by g1'
     WHERE id = '50000000-0000-0000-0000-00000000ee02';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  -- The SHAPE of the refusal, not just the fact of one (rule 7e). A row that is
  -- invisible to USING gives a silent zero; a row that USING admits and WITH
  -- CHECK rejects RAISES. Asserting only "it was refused" cannot tell a working
  -- policy from one whose USING term has been deleted.
  IF v_rows = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q2';
  ELSE RAISE NOTICE 'FAIL Q2: rows=% sqlstate=% (want 0, silent)', v_rows, v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q2;

\echo 'Q3 ⭐ (rewritten by 0028): ...and cannot MAKE one company-wide either — NULL is not a site, and now not a value'
SAVEPOINT sp_Q3;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  -- Q3 used to assert that a site admin could not EDIT a company-wide operator.
  -- D108 removed the row type, so the question became whether they can CREATE
  -- one -- the door the old case was guarding, one step earlier. `ee01` is a
  -- row g1 owns and may otherwise edit freely (Q1), so a refusal here can only
  -- be about the NULL.
  BEGIN
    UPDATE operators SET site_node_id = NULL
     WHERE id = '50000000-0000-0000-0000-00000000ee01';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  -- ⚠️ 42501, NOT 23502, AND THE REASON IS WORTH KNOWING. The NOT NULL never
  -- gets a chance: an UPDATE's NEW row is checked against the policy's WITH
  -- CHECK first (postgres gotcha 20), and `app_is_admin_for(NULL)` is false, so
  -- RLS refuses before the constraint would. The stronger, constraint-level
  -- refusal is pinned directly in 55_'s N1, where a superuser tries it.
  IF v_state = '42501'
     AND (SELECT site_node_id FROM operators WHERE id='50000000-0000-0000-0000-00000000ee01') IS NOT NULL
  THEN RAISE NOTICE 'PASS Q3';
  ELSE RAISE NOTICE 'FAIL Q3: rows=% sqlstate=% (want 42501 and the row untouched)', v_rows, v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q3;

\echo 'Q4: the company admin edits all three'
SAVEPOINT sp_Q4;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  UPDATE operators SET display_name = display_name || ' (co)'
   WHERE id IN ('50000000-0000-0000-0000-00000000ee01',
                '50000000-0000-0000-0000-00000000ee02',
                '50000000-0000-0000-0000-00000000ee03');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows = 3 THEN RAISE NOTICE 'PASS Q4';
  ELSE RAISE NOTICE 'FAIL Q4: rows=% (want 3)', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q4;

\echo 'Q5 ⭐: a site admin cannot CLAIM another site''s operator (the USING half of UPDATE)'
SAVEPOINT sp_Q5;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET site_node_id = '30000000-0000-0000-0000-000000000001'
     WHERE id = '50000000-0000-0000-0000-00000000ee02';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_rows = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q5';
  ELSE RAISE NOTICE 'FAIL Q5: rows=% (want 0) — a site admin annexed another site''s operator', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q5;

\echo 'Q6 ⭐: ...and cannot PUSH their own onto another site (the WITH CHECK half)'
SAVEPOINT sp_Q6;
DO $$
DECLARE v_p2 uuid; v_rows int; v_state text;
BEGIN
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET site_node_id = v_p2
     WHERE id = '50000000-0000-0000-0000-00000000ee01';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  -- A WITH CHECK violation RAISES 42501; a USING mismatch is silent. Q5 and Q6
  -- are the two halves and they fail differently on purpose.
  IF v_state = '42501' THEN RAISE NOTICE 'PASS Q6';
  ELSE RAISE NOTICE 'FAIL Q6: sqlstate=% rows=% (want 42501) — the new row was not re-checked', v_state, v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q6;

\echo 'Q7: a site admin CREATES an operator owned by their own site'
SAVEPOINT sp_Q7;
DO $$
DECLARE v_state text; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operators (org_id, display_name, site_node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','g1 hire','30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM operators WHERE display_name = 'g1 hire';
  IF v_state IS NULL AND v_n = 1 THEN RAISE NOTICE 'PASS Q7';
  ELSE RAISE NOTICE 'FAIL Q7: sqlstate=% rows=% (want null, 1)', v_state, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q7;

\echo 'Q8 ⭐: ...but cannot create a COMPANY-WIDE one — making a default is not a site admin''s job'
SAVEPOINT sp_Q8;
DO $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operators (org_id, display_name, site_node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','g1 company hire', NULL);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_state = '42501' THEN RAISE NOTICE 'PASS Q8';
  ELSE RAISE NOTICE 'FAIL Q8: sqlstate=% (want 42501)', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q8;

\echo 'Q9: ...and cannot create one owned by the other site'
SAVEPOINT sp_Q9;
DO $$
DECLARE v_p2 uuid; v_state text;
BEGIN
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operators (org_id, display_name, site_node_id)
      VALUES ('10000000-0000-0000-0000-000000000001','g1 poaching', v_p2);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_state = '42501' THEN RAISE NOTICE 'PASS Q9';
  ELSE RAISE NOTICE 'FAIL Q9: sqlstate=% (want 42501)', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q9;

\echo 'Q10 ⭐: a MID-TREE admin administers no SITE, so no shared row is theirs'
SAVEPOINT sp_Q10;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  -- g3 holds an admin grant on Assembly, a Department. The plant above it is
  -- not inside their grant, so `app_is_admin_for(plant_1)` is false. This is
  -- the case that stops the root rule in §2 being decoration.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET display_name = 'renamed by g3'
     WHERE id = '50000000-0000-0000-0000-00000000ee01';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_rows = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q10';
  ELSE RAISE NOTICE 'FAIL Q10: rows=% (want 0) — a department admin edited a site''s operator', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q10;

\echo 'Q11 ⭐⭐: READS ARE SITE-SCOPED NOW (D107/0026). This case CHANGED POLARITY — see the comment.'
SAVEPOINT sp_Q11;
DO $$
DECLARE v_g1 int; v_g4 int; v_sk int; v_os int;
BEGIN
  -- ⭐⭐ THIS CASE USED TO ASSERT THE OPPOSITE, AND IT WAS RIGHT TO. 0023 changed
  -- who may EDIT and nothing else, and this was the tripwire on §9 item 1: it
  -- was written to go red the moment anyone narrowed a `_select`, BEFORE
  -- `check_eligibility` could start silently answering "not eligible".
  --
  -- ⚠️ IT WENT RED ON PURPOSE. Migration 0026 (D107) narrows exactly those
  -- policies, because the maintainer's own frame was always a read statement: "no
  -- member from one plant should see info for other plants". The tripwire did
  -- its job — it made the consequence impossible to ship by accident, and the
  -- consequence it named is now FIXED rather than avoided: `check_eligibility`
  -- is SECURITY DEFINER with its own gate, so its answer no longer depends on
  -- what the caller may list. That property is asserted directly in
  -- `53_read_scoping_test.sql` — R12 (it still names a training the caller
  -- cannot see) and R14 (it refuses a node they cannot see). This is
  -- verification rule 1b-ii: the cases were right and the CONTRACT changed, so
  -- the case is rewritten to assert the same property one indirection along,
  -- not deleted.
  --
  -- What it asserts now: the site admin of Plant 1 and a supervisor on Plant 1
  -- see their own site's operator and the company-wide one, and NOT Plant 2's.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_g1 FROM operators WHERE id IN (
    '50000000-0000-0000-0000-00000000ee01','50000000-0000-0000-0000-00000000ee02','50000000-0000-0000-0000-00000000ee03');
  -- Both owner branches, named separately: `IS NOT NULL OR IS NULL` is `true`
  -- and reads like a guard while guarding nothing.
  SELECT count(*) FILTER (WHERE site_node_id IS NOT NULL)
       + count(*) FILTER (WHERE site_node_id IS NULL) INTO v_sk FROM skills;
  SELECT count(*) INTO v_os FROM operator_skills;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e4', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_g4 FROM operators WHERE id IN (
    '50000000-0000-0000-0000-00000000ee01','50000000-0000-0000-0000-00000000ee02','50000000-0000-0000-0000-00000000ee03');
  RESET ROLE;
  -- 2, not 3: their own site's operator plus the company-wide one. The third
  -- is Plant 2's and is now invisible to both of them.
  IF v_g1 = 2 AND v_g4 = 2 AND v_sk >= 3 AND v_os >= 1 THEN RAISE NOTICE 'PASS Q11';
  ELSE RAISE NOTICE 'FAIL Q11: site_admin_sees=% supervisor_sees=% skills=% operator_skills=% (want 2,2,>=3,>=1)',
    v_g1, v_g4, v_sk, v_os; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q11;

\echo 'Q12: a node INSIDE a site can own a shared row (0025/D103 widened this)'
-- ⚠️ RULE 1b-ii: THIS CASE WAS RIGHT AND THE CONTRACT CHANGED. Until 0025 it
-- asserted the opposite -- that a mid-tree node is refused with
-- reason='not a root node' -- and it was correct for as long as ownership meant
-- only "who may edit". D103 makes it mean "where this applies", and
-- "applies to Assembly and everything under it" is the sentence the product has
-- to be able to express. So the branch is gone and the case now pins the
-- widening in the same place.
--
-- ⭐ THE COVERAGE THE OLD CASE PROVIDED IS NOT LOST. It proved the trigger fires
-- and can refuse; Q13 (another org's node) still proves exactly that, and is now
-- the ONLY refusal branch left in the function, which makes it load-bearing
-- rather than one of two.
SAVEPOINT sp_Q12;
DO $$
DECLARE v_owner uuid; v_err text := NULL;
BEGIN
  -- As the company admin, so the ONLY thing that could refuse this is the trigger.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE operators SET site_node_id = '30000000-0000-0000-0000-000000000002'
     WHERE id = '50000000-0000-0000-0000-00000000ee03';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_err = RETURNED_SQLSTATE;
  END;
  SELECT site_node_id INTO v_owner FROM operators
   WHERE id = '50000000-0000-0000-0000-00000000ee03';
  RESET ROLE;
  -- Asserts the STATE, not merely that nothing was raised: a silent zero-row
  -- refusal by a USING clause looks identical to success from the outside.
  IF v_err IS NULL AND v_owner = '30000000-0000-0000-0000-000000000002'
  THEN RAISE NOTICE 'PASS Q12';
  ELSE RAISE NOTICE 'FAIL Q12: sqlstate=% owner=% (want no error, owner set to the mid-tree node)',
    v_err, v_owner; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q12;

\echo 'Q13: a root belonging to ANOTHER ORG cannot own a shared row, and the reason says "not found"'
SAVEPOINT sp_Q13;
DO $$
DECLARE v_detail jsonb; v_raw text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- org 2's root. It IS a root; it is not in this org.
    UPDATE operators SET site_node_id = '3000000b-0000-0000-0000-000000000001'
     WHERE id = '50000000-0000-0000-0000-00000000ee03';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- "not found" is the HONEST answer here and a lie in Q6 — same words, and the
  -- difference is whether the node is invisible or genuinely absent. That is why
  -- the trigger is DEFINER: it can tell them apart.
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS Q13';
  ELSE RAISE NOTICE 'FAIL Q13: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q13;

-- ---------------------------------------------------------------------------
-- SHIFT PATTERNS (D101) — and the two tables INSIDE a pattern, which follow it.
-- ---------------------------------------------------------------------------
\echo 'Q14: a site admin edits their OWN site''s shift pattern'
SAVEPOINT sp_Q14;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  UPDATE shift_templates SET name = 'Q P1 Pattern (edited)'
   WHERE id = '70000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows = 1 THEN RAISE NOTICE 'PASS Q14';
  ELSE RAISE NOTICE 'FAIL Q14: rows=% (want 1)', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q14;

\echo 'Q15 ⭐ (rewritten by 0028): ...touches the other site''s pattern not at all, and its OWN line''s pattern yes — D109''s ancestor rule'
SAVEPOINT sp_Q15;
DO $$
DECLARE v_other int; v_default int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE shift_templates SET name = 'x' WHERE id = '70000000-0000-0000-0000-00000000ee02';
    GET DIAGNOSTICS v_other = ROW_COUNT;
    UPDATE shift_templates SET name = 'x' WHERE id = '70000000-0000-0000-0000-00000000ee03';
    GET DIAGNOSTICS v_default = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  -- ⭐ The second half INVERTED, and it is the more interesting half now.
  -- `ee03` was company-wide and unreachable; it is owned by Line 1, and g1
  -- administers Plant 1, which CONTAINS Line 1. `app_is_admin_for` is an admin
  -- grant on an ancestor-or-self, so a plant admin edits their own line's rows.
  -- That is D109 working. Pairing it with the untouched other-site row is what
  -- stops "1" here reading as the narrowing having failed.
  IF v_other = 0 AND v_default = 1 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q15';
  ELSE RAISE NOTICE 'FAIL Q15: other_site=% own_line=% (want 0,1)', v_other, v_default; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q15;

\echo 'Q16: a SHIFT follows its pattern — the site admin may edit the one inside their own'
SAVEPOINT sp_Q16;
DO $$
DECLARE v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  UPDATE shifts SET name = 'Q Day (edited)' WHERE id = '71000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows = 1 THEN RAISE NOTICE 'PASS Q16';
  ELSE RAISE NOTICE 'FAIL Q16: rows=% (want 1)', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q16;

\echo 'Q17: ...and not the one inside the other site''s'
SAVEPOINT sp_Q17;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE shifts SET name = 'x' WHERE id = '71000000-0000-0000-0000-00000000ee02';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_rows = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q17';
  ELSE RAISE NOTICE 'FAIL Q17: rows=% (want 0)', v_rows; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q17;

\echo 'Q18 ⭐: a BREAK is two hops from the owner, and both hops are load-bearing'
SAVEPOINT sp_Q18;
DO $$
DECLARE v_mine int; v_theirs int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  UPDATE shift_breaks SET name = 'Q Lunch (edited)' WHERE id = '72000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_mine = ROW_COUNT;
  BEGIN
    UPDATE shift_breaks SET name = 'x' WHERE id = '72000000-0000-0000-0000-00000000ee02';
    GET DIAGNOSTICS v_theirs = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_mine = 1 AND v_theirs = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q18';
  ELSE RAISE NOTICE 'FAIL Q18: mine=% theirs=% (want 1,0)', v_mine, v_theirs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q18;

\echo 'Q19 ⭐: a company-wide pattern can still be ATTACHED to a site''s node — that is what "defaults" buys'
SAVEPOINT sp_Q19;
DO $$
DECLARE v_state text; v_tpl uuid;
BEGIN
  -- 0023 §9 item 3: constraining the attachment to the node's own site would
  -- take the company-wide defaults away. g1 administers Line 1, and the pattern
  -- they attach is the UNOWNED one.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_shift_templates (node_id, org_id, template_id)
      VALUES ('30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',
              '70000000-0000-0000-0000-00000000ee03')
      ON CONFLICT (node_id) DO UPDATE SET template_id = EXCLUDED.template_id;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  SELECT template_id INTO v_tpl FROM node_shift_templates
   WHERE node_id = '30000000-0000-0000-0000-000000000004';
  RESET ROLE;
  IF v_state IS NULL AND v_tpl = '70000000-0000-0000-0000-00000000ee03'
  THEN RAISE NOTICE 'PASS Q19';
  ELSE RAISE NOTICE 'FAIL Q19: sqlstate=% attached=% — the company-wide default became unattachable', v_state, v_tpl; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q19;

-- ---------------------------------------------------------------------------
-- PRODUCTS, SKILLS, OPERATOR_SKILLS
-- ---------------------------------------------------------------------------
\echo 'Q20 ⭐ (rewritten by 0036/D116): a site admin RENAMES a part they wholly make, manages their OWN plant''s makers-list, and cannot touch the other plant''s'
SAVEPOINT sp_Q20;
DO $$
DECLARE v_record int; v_mine int; v_theirs int; v_state text; v_p2 uuid;
BEGIN
  -- ⚠️ Read the TEMP-table value before the role change: `authenticated` cannot
  -- select q_fix and the refusal reads exactly like RLS.
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  -- ⭐⭐ D116 (0036) REOPENS THE SPLIT ON EDIT. D115 made the shared record
  -- company-only; D116 hands it back to a site admin for a part made ONLY within
  -- their own plants. QP1 is made only in Plant 1, which g1 administers, so g1's
  -- rename now removes ONE row (products_update USING app_can_edit_product_record).
  UPDATE products SET name = 'Q P1 Product (edited)' WHERE id = '60000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_record = ROW_COUNT;
  -- The LIST of makers is per-plant. g1 administers Plant 1, so they may remove
  -- Plant 1 as a maker of QP1 (its only run-free place) ...
  DELETE FROM product_sites
   WHERE product_id = '60000000-0000-0000-0000-00000000ee01'
     AND node_id = '30000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_mine = ROW_COUNT;
  -- ... and may NOT remove Plant 2 as a maker of QP2 — the USING half filters it
  -- to zero rows, silently.
  BEGIN
    DELETE FROM product_sites
     WHERE product_id = '60000000-0000-0000-0000-00000000ee02'
       AND node_id = v_p2;
    GET DIAGNOSTICS v_theirs = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_record = 1 AND v_mine = 1 AND v_theirs = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q20';
  ELSE RAISE NOTICE 'FAIL Q20: record_rename=% own_plant_removed=% other_plant_removed=% (want 1,1,0)', v_record, v_mine, v_theirs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q20;

\echo 'Q21 (rewritten by 0028): skills — a site admin edits their own; the OTHER PLANT''s stays out of reach (Q37 has the cross-site half)'
SAVEPOINT sp_Q21;
DO $$
DECLARE v_mine int; v_shared int; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  UPDATE skills SET name = 'Q Welding (edited)' WHERE id = '40000000-0000-0000-0000-00000000ee01';
  GET DIAGNOSTICS v_mine = ROW_COUNT;
  BEGIN
    -- ⭐ was the seeded company-wide training; the seed now owns it at the
    -- Plant 1 root, which g1 administers, so it stopped being unreachable for
    -- a reason that has nothing to do with this case. A Plant 2 row does the
    -- job the old one was doing.
    UPDATE skills SET name = 'x' WHERE id = '40000000-0000-0000-0000-00000000ee04';
    GET DIAGNOSTICS v_shared = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_mine = 1 AND v_shared = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q21';
  ELSE RAISE NOTICE 'FAIL Q21: mine=% other_plant=% (want 1,0)', v_mine, v_shared; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q21;

\echo 'Q22 ⭐: operator_skills follows the OPERATOR, not the skill'
SAVEPOINT sp_Q22;
DO $$
DECLARE v_mine text; v_theirs text;
BEGIN
  -- The skill named here is the company-wide seeded one, which g1 may NOT edit
  -- (Q21). They may still say their own operator holds it — because the
  -- question "what is this person qualified to do" is a question about the
  -- person. Deleting the operator hop and asking about the skill instead
  -- inverts both halves of this case.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operator_skills (operator_id, skill_id, org_id)
      VALUES ('50000000-0000-0000-0000-00000000ee01','40000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001');
    v_mine := 'ok';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_mine = RETURNED_SQLSTATE; END;
  BEGIN
    INSERT INTO operator_skills (operator_id, skill_id, org_id)
      VALUES ('50000000-0000-0000-0000-00000000ee02','40000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001');
    v_theirs := 'ok';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_theirs = RETURNED_SQLSTATE; END;
  RESET ROLE;
  -- ⭐ 0028 CHANGED THE SECOND HALF'S SQLSTATE, AND IT IS A STRENGTHENING, NOT
  -- A MATCHED EXPECTATION. It used to be 42501: g1 may not administer the other
  -- plant's operator. It is now PT409 `not_offered_here`, raised by the scope
  -- guard before RLS is consulted, because a Plant 2 person may not hold a
  -- Plant 1 training AT ALL. The distinction is testable and Q22b tests it: the
  -- COMPANY ADMIN, who passes every permission check, is refused the same row.
  -- A weakening could not do that.
  IF v_mine = 'ok' AND v_theirs = 'PT409' THEN RAISE NOTICE 'PASS Q22';
  ELSE RAISE NOTICE 'FAIL Q22: own_operator=% other_site_operator=% (want ok, PT409)', v_mine, v_theirs; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q22;

\echo 'Q22b ⭐⭐ (new in 0028): and the COMPANY ADMIN is refused the same row — which is what makes Q22 a strengthening rather than a moved goalpost'
SAVEPOINT sp_Q22b;
DO $$
DECLARE v_state text;
BEGIN
  -- Q22's second half changed sqlstate from 42501 to PT409 under 0028. That
  -- reads exactly like an expectation edited to match new behaviour, which is
  -- the thing [[verification-standard]] rule 2e forbids. The difference is
  -- testable: 42501 is about WHO is asking, PT409 is about WHAT is being
  -- written. So ask as the one person no permission check refuses. If this
  -- ever comes back 'ok', the constraint has become advisory and Q22 really
  -- has been weakened.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO operator_skills (operator_id, skill_id, org_id)
      VALUES ('50000000-0000-0000-0000-00000000ee02','40000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001');
    v_state := 'ok';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_state = 'PT409' THEN RAISE NOTICE 'PASS Q22b';
  ELSE RAISE NOTICE 'FAIL Q22b: company admin got % (want PT409)', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL Q22b: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_Q22b;

-- ---------------------------------------------------------------------------
-- COLOUR (D102) — "we can have defaults but I'd rather the site admin set them
-- up for their site."
-- ---------------------------------------------------------------------------
\echo 'Q23: every product has a token, and it is a TOKEN — never a hex'
SAVEPOINT sp_Q23;
DO $$
DECLARE v_null int; v_bad int;
BEGIN
  RESET ROLE;
  SELECT count(*) INTO v_null FROM products WHERE color_token IS NULL;
  SELECT count(*) INTO v_bad  FROM products WHERE color_token !~ '^product-[1-9][0-9]*$';
  IF v_null = 0 AND v_bad = 0 THEN RAISE NOTICE 'PASS Q23';
  ELSE RAISE NOTICE 'FAIL Q23: null=% malformed=% (want 0,0)', v_null, v_bad; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q23;

\echo 'Q24 ⭐: on a FRESH database the trigger assigns in insertion order, one token each'
SAVEPOINT sp_Q24;
DO $$
DECLARE v_distinct int; v_n int; v_wx text;
BEGIN
  RESET ROLE;
  -- ⭐ THIS CASE WAS REWRITTEN BECAUSE ITS FIRST VERSION COULD NOT BE TRUE HERE,
  -- and finding that out is why it exists. It originally asserted that the §4
  -- BACKFILL reproduced the old sku-ordinal assignment — but the numbered suite
  -- only ever runs the FRESH path, where `db:reset` applies every migration to
  -- an empty schema and the backfill correctly does nothing; the seed then
  -- inserts and §3's trigger does the work. So on this database WX is
  -- product-1 (insertion order) and on an upgraded one it is product-3 (the
  -- old sku order), and BOTH are right.
  --
  -- The upgrade half is not droppable, it is just not testable from here:
  -- `upgrade_0023_product_colour.sql` asserts it, via verify-db.sh's
  -- UPGRADE_CHECKS. A case name is a claim, and this one now claims what its
  -- fixture can deliver.
  SELECT count(DISTINCT color_token), count(*) INTO v_distinct, v_n
    FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001'
     AND sku IN ('WX','WY','GZ','RW');
  SELECT color_token INTO v_wx FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku = 'WX';
  IF v_n = 4 AND v_distinct = 4 AND v_wx = 'product-1' THEN RAISE NOTICE 'PASS Q24';
  ELSE RAISE NOTICE 'FAIL Q24: n=% distinct=% wx=% (want 4, 4, product-1 — insertion order)',
    v_n, v_distinct, v_wx; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q24;

\echo 'Q25 ⭐ (rewritten by 0034): a new product takes the LEAST-USED token across the WHOLE ORG — colour is company-wide now'
SAVEPOINT sp_Q25;
DO $$
DECLARE v_expected text; v_got text;
BEGIN
  RESET ROLE;
  -- ⭐⭐ SUPERSEDES THE PER-OWNER BALANCE. D115 drops the single owner, so
  -- app_pick_product_color balances across every product in the org, not within
  -- one scope. Computed the same way the picker does (least count, ties by
  -- palette order), then asserted the trigger chose exactly it. A product needs
  -- no place to be created — its colour does not depend on where it is made.
  SELECT t.token INTO v_expected
    FROM unnest(app_product_palette()) WITH ORDINALITY AS t(token, pos)
    LEFT JOIN products p
      ON p.color_token = t.token AND p.org_id = '10000000-0000-0000-0000-000000000001'
   GROUP BY t.token, t.pos
   ORDER BY count(p.id), t.pos
   LIMIT 1;
  INSERT INTO products (org_id, sku, name)
    VALUES ('10000000-0000-0000-0000-000000000001','QNC','Q New Colour Product')
    RETURNING color_token INTO v_got;
  IF v_got = v_expected THEN RAISE NOTICE 'PASS Q25';
  ELSE RAISE NOTICE 'FAIL Q25: assigned=% (want the org-wide least-used token %)', v_got, v_expected; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q25;

\echo 'Q26 ⭐⭐ (rewritten by 0034): colour is COMPANY-WIDE, so two products take DISTINCT tokens — and inserting one still never re-shuffles another'
SAVEPOINT sp_Q26;
DO $$
DECLARE v_p1 text; v_p2 text; v_gz_before text; v_gz_after text;
BEGIN
  RESET ROLE;
  -- ⭐⭐ INVERTED BY D115. The old case's point was that two SEPARATE owner
  -- scopes could each hold product-1 independently. There is no per-owner scope
  -- any more — colour balances across the whole org — so QP1 and QP2 take
  -- DIFFERENT tokens, and a design that recoloured by scope would break that.
  -- What SURVIVES is the other half, and it is the load-bearing one: inserting a
  -- product never re-colours an existing one (colour is set once, at insert).
  SELECT color_token INTO v_gz_before FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku = 'GZ';
  SELECT color_token INTO v_p1 FROM products WHERE id = '60000000-0000-0000-0000-00000000ee01';
  SELECT color_token INTO v_p2 FROM products WHERE id = '60000000-0000-0000-0000-00000000ee02';
  INSERT INTO products (org_id, sku, name)
    VALUES ('10000000-0000-0000-0000-000000000001','AAA','Q Alphabetically First');
  SELECT color_token INTO v_gz_after FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku = 'GZ';
  IF v_p1 <> v_p2 AND v_gz_before = v_gz_after
  THEN RAISE NOTICE 'PASS Q26';
  ELSE RAISE NOTICE 'FAIL Q26: qp1=% qp2=% gz % -> % (want QP1<>QP2 company-wide, and gz unchanged)',
    v_p1, v_p2, v_gz_before, v_gz_after; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q26;

\echo 'Q27: a lower-case six-digit hex is accepted; every other spelling is not (0025 §2)'
-- ⚠️ RULE 1b-ii AGAIN: this case asserted that '#eb6834' raises 23514, and it
-- was right for as long as the column held only palette tokens. The maintainer asked
-- for a hex on Aug 27, so 0025 widened the CHECK to a UNION of two disjoint
-- shapes.
--
-- ⭐ AND THE COVERAGE IS RESCUED RATHER THAN DELETED. The old case's real job
-- was "the CHECK actually rejects something" -- which a widened constraint can
-- silently stop doing. So this now walks FOUR spellings: the one legal hex, and
-- the three near-misses that must still fail. An implementation that widened to
-- `color_token IS NOT NULL` passes the first and fails the rest.
SAVEPOINT sp_Q27;
DO $$
DECLARE v_ok text; v_short text := NULL; v_upper text := NULL; v_named text := NULL;
BEGIN
  RESET ROLE;
  UPDATE products SET color_token = '#eb6834' WHERE id = '60000000-0000-0000-0000-00000000ee01';
  SELECT color_token INTO v_ok FROM products WHERE id = '60000000-0000-0000-0000-00000000ee01';

  BEGIN UPDATE products SET color_token = '#eb6' WHERE id = '60000000-0000-0000-0000-00000000ee01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_short = RETURNED_SQLSTATE; END;

  BEGIN UPDATE products SET color_token = '#EB6834' WHERE id = '60000000-0000-0000-0000-00000000ee01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_upper = RETURNED_SQLSTATE; END;

  BEGIN UPDATE products SET color_token = 'orange' WHERE id = '60000000-0000-0000-0000-00000000ee01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_named = RETURNED_SQLSTATE; END;

  IF v_ok = '#eb6834' AND v_short = '23514' AND v_upper = '23514' AND v_named = '23514'
  THEN RAISE NOTICE 'PASS Q27';
  ELSE RAISE NOTICE 'FAIL Q27: stored=% short=% upper=% named=% (want #eb6834 then three 23514s)',
    v_ok, v_short, v_upper, v_named; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q27;

\echo 'Q28: changing a product''s makers-list does NOT re-colour it'
SAVEPOINT sp_Q28;
DO $$
DECLARE v_p2 uuid; v_before text; v_after text;
BEGIN
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  RESET ROLE;
  -- D115: "moving a product between owners" is now editing product_sites. Adding
  -- a second plant fires no colour trigger — colour is set once, at insert.
  SELECT color_token INTO v_before FROM products WHERE id = '60000000-0000-0000-0000-00000000ee01';
  INSERT INTO product_sites (org_id, product_id, node_id)
    VALUES ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-00000000ee01', v_p2);
  SELECT color_token INTO v_after FROM products WHERE id = '60000000-0000-0000-0000-00000000ee01';
  IF v_before = v_after THEN RAISE NOTICE 'PASS Q28';
  ELSE RAISE NOTICE 'FAIL Q28: % -> % — a makers-list change re-coloured a product', v_before, v_after; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q28;

\echo 'Q29: board_window hands the colour over, and the rest of its payload survived the re-emission'
SAVEPOINT sp_Q29;
DO $$
DECLARE v jsonb; v_tok text; v_stored text; v_keys int; v_ops int; v_shifts int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v := board_window('plant_1', now() - interval '1 day', now() + interval '7 days');
  RESET ROLE;
  SELECT p->>'color_token' INTO v_tok
    FROM jsonb_array_elements(v->'products') p WHERE p->>'sku' = 'WX';
  SELECT count(*) INTO v_keys   FROM jsonb_object_keys(v);
  SELECT jsonb_array_length(v->'operators') INTO v_ops;
  SELECT jsonb_array_length(v->'shift_templates') INTO v_shifts;
  -- ⭐ The key count is the guard on the EXTRACTION, not on the colour: a
  -- hand-retyped 138-line function is how a subquery goes missing, and a
  -- missing top-level key is what that looks like from here.
  SELECT color_token INTO v_stored FROM products
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND sku = 'WX';
  -- Compared against the ROW, never against a literal: the token depends on
  -- which path assigned it (Q24), and a case that hardcodes one path is a case
  -- that fails on the other for no reason.
  IF v_tok IS NOT NULL AND v_tok = v_stored AND v_keys >= 9 AND v_ops > 0 AND v_shifts > 0
  THEN RAISE NOTICE 'PASS Q29';
  ELSE RAISE NOTICE 'FAIL Q29: wx_token=% stored=% top_level_keys=% operators=% shift_templates=%', v_tok, v_stored, v_keys, v_ops, v_shifts; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q29;

\echo 'Q30 ⭐: nothing new is anon-executable — including resolve_shift_template, open since 0005 (D93)'
SAVEPOINT sp_Q30;
DO $$
DECLARE v_open text[];
BEGIN
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'FAIL Q30: no anon role — this case cannot measure anything here';
    RETURN;
  END IF;
  SELECT array_agg(f) INTO v_open FROM unnest(ARRAY[
    'app_pick_product_color(uuid)',
    'app_product_palette()',
    'app_is_admin_for_operator(uuid)',
    'app_is_admin_for_shift_template(uuid)',
    'app_is_admin_for_shift(uuid)',
    'resolve_shift_template(uuid)'
  ]) AS f WHERE has_function_privilege('anon', f, 'EXECUTE');
  IF v_open IS NULL THEN RAISE NOTICE 'PASS Q30';
  ELSE RAISE NOTICE 'FAIL Q30: anon can execute %', v_open; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q30;

\echo 'Q31 ⭐⭐: the palette is exactly as wide as tokens.css — and this case is the coupling'
SAVEPOINT sp_Q31;
DO $$
DECLARE v_n int; v_last text;
BEGIN
  RESET ROLE;
  -- The DB can hand out any token in app_product_palette(); the board can only
  -- RENDER the ones tokens.css defines. A token wider than the stylesheet is a
  -- product with no colour at all — measured by upgrade_0023's V2, which is the
  -- only reason this case exists.
  --
  -- ⭐ THIS CASE IS MEANT TO BE EDITED, in the same commit that adds
  -- --product-5..N to tokens.css and widens app_product_palette(). It is here
  -- so that widening ONE of the two goes red instead of going unnoticed.
  DECLARE v_pal text[];
  BEGIN
    v_pal := app_product_palette();
    v_n := array_length(v_pal, 1);
    v_last := v_pal[v_n];
  END;
  IF v_n = 4 AND v_last = 'product-4' THEN RAISE NOTICE 'PASS Q31';
  ELSE RAISE NOTICE 'FAIL Q31: palette is % wide, ending %; tokens.css defines --product-1..4. Widen BOTH or neither.',
    v_n, v_last; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q31;

\echo 'Q32 ⭐: app_is_admin_for(NULL) is FALSE, never NULL — the fact two `is not null` guards rest on'
SAVEPOINT sp_Q32;
DO $$
DECLARE v_null boolean; v_val boolean;
BEGIN
  RESET ROLE;
  -- ⭐ THIS CASE EXISTS BECAUSE TWO MUTATIONS WENT NOT CAUGHT (R7, R15), and it
  -- pins WHY rather than papering over them. Both replace
  -- `site_node_id is not null and app_is_admin_for(site_node_id)` with
  -- `app_is_admin_for(site_node_id) is not false` — and both are INERT, because
  -- `app_is_admin_for` is an `EXISTS(...)` and an EXISTS never returns NULL.
  --
  -- So the `is not null` term is a redundant clause (gotcha 17) and it is KEPT
  -- on purpose: it is what makes the predicate say out loud that an unowned row
  -- has no site to be an admin of. What is NOT acceptable is leaving the
  -- inertness as an argument. Measured here — and the day `app_is_admin_for`
  -- stops being an EXISTS, this case goes red in the same run that makes R7 and
  -- R15 live. Rule 7f: an inertness that depends on a neighbouring rule is a
  -- tripwire waiting to be written.
  v_val := app_is_admin_for(NULL);
  v_null := v_val IS NULL;
  IF v_null = false AND v_val = false THEN RAISE NOTICE 'PASS Q32';
  ELSE RAISE NOTICE 'FAIL Q32: app_is_admin_for(NULL) returned % (is_null=%) — R7 and R15 are now LIVE mutations', v_val, v_null; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q32;

\echo 'Q33 ⭐ (rewritten by 0028): the shifts inside a pattern owned by their OWN line are theirs to edit — the hop still follows the template'
SAVEPOINT sp_Q33;
DO $$
DECLARE v_rows int; v_state text;
BEGIN
  -- ⭐ A MISSING CASE, found by R15 rather than by reading. Q15 covers the
  -- company-wide TEMPLATE row, which is guarded by its own column; the shifts
  -- INSIDE it are guarded by `app_is_admin_for_shift_template`, a different
  -- mechanism entirely, and nothing reached it. The default pattern being
  -- editable by any site admin would be the whole feature backwards.
  INSERT INTO shifts (id, org_id, template_id, name, start_min, end_min) VALUES
    ('71000000-0000-0000-0000-00000000ee03','10000000-0000-0000-0000-000000000001',
     '70000000-0000-0000-0000-00000000ee03','Q Standard Day', 360, 840);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE shifts SET name = 'x' WHERE id = '71000000-0000-0000-0000-00000000ee03';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  -- ⭐ INVERTED WITH Q15, for the same reason and by the same mechanism:
  -- `ee03`'s pattern is owned by Line 1, inside the plant g1 administers. What
  -- this case actually pins is that `shifts` still answers through
  -- `app_is_admin_for_shift_template` -- a DIFFERENT mechanism from the
  -- template's own column, and the one nothing reached before R15 found it.
  -- Q15's first half keeps the refusal, on the other plant's template.
  IF v_rows = 1 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q33';
  ELSE RAISE NOTICE 'FAIL Q33: rows=% sqlstate=% (want 1, silent)', v_rows, v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q33;

\echo 'Q34: an operator_skills row cannot name an operator in another org — the FK says so, not a policy'
SAVEPOINT sp_Q34;
DO $$
DECLARE v_state text;
BEGIN
  RESET ROLE;
  -- ⭐ PINS AN IMPOSSIBILITY, the way 48''s X39 does. Mutation R14 deletes
  -- `app_is_admin_for_operator`''s own org term and is NOT CAUGHT — not because
  -- the case list is thin, but because `operator_skills` carries
  -- `foreign key (org_id, operator_id) references operators (org_id, id)`, so a
  -- cross-org pairing cannot be constructed to test it. The masking lives in
  -- migration 0002, a different file, which is exactly when rule 9b says to pin
  -- it here: if that FK is ever relaxed, R14 becomes live and this case is the
  -- only thing that will say so.
  BEGIN
    INSERT INTO operator_skills (operator_id, skill_id, org_id)
      VALUES ('5000000b-0000-0000-0000-000000000001',
              '40000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  IF v_state = '23503' THEN RAISE NOTICE 'PASS Q34';
  ELSE RAISE NOTICE 'FAIL Q34: sqlstate=% (want 23503) — the composite FK no longer masks R14', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q34;

\echo 'Q35 ⭐⭐: the colour picker is reachable by NOBODY — it takes a tenant and bypasses RLS'
SAVEPOINT sp_Q35;
DO $$
DECLARE v_auth boolean; v_anon boolean; v_pal boolean; v_leak text;
BEGIN
  RESET ROLE;
  -- ⭐ THIS CASE EXISTS BECAUSE THE FIRST VERSION OF THIS MIGRATION LEAKED.
  -- app_pick_product_color is SECURITY DEFINER, takes the org as a parameter,
  -- and bypasses RLS. It was granted to `authenticated` and lives in `public`,
  -- so PostgREST exposed it: a viewer in org 1 could ask it about org 2 and
  -- read back which of another tenant's palette slots were least used.
  --
  -- The fix is a grant, not a predicate (a `= app_current_org()` guard returns
  -- NULL during the backfill and the seed, where there is no session profile).
  -- A grant is a thing people delete, so this is the tripwire.
  v_auth := has_function_privilege('authenticated', 'app_pick_product_color(uuid)', 'EXECUTE');
  v_pal  := has_function_privilege('authenticated', 'app_product_palette()', 'EXECUTE');
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    v_anon := has_function_privilege('anon', 'app_pick_product_color(uuid)', 'EXECUTE');
  ELSE
    v_anon := false;
  END IF;
  -- And the thing it would have leaked, so the case says what it is protecting:
  -- org 2's whole-org palette usage, asked about from outside org 2. D115: the
  -- picker takes only the org now (one arg) — there is no per-owner scope.
  SELECT app_pick_product_color('10000000-0000-0000-0000-000000000002') INTO v_leak;
  IF v_auth = false AND v_anon = false AND v_pal = false AND v_leak IS NOT NULL
  THEN RAISE NOTICE 'PASS Q35';
  ELSE RAISE NOTICE 'FAIL Q35: authenticated=% anon=% palette=% (all must be false; owner still gets %)',
    v_auth, v_anon, v_pal, v_leak; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q35;

\echo 'Q36 ⭐ (rewritten by 0034/Split): color_token is NOT NULL — even a COMPANY admin cannot blank a product''s colour'
SAVEPOINT sp_Q36;
DO $$
DECLARE v_state text;
BEGIN
  -- The column shipped nullable with a comment saying "NULL only transiently".
  -- An adversarial reviewer showed the UPDATE path made that untrue: the CHECK
  -- permits NULL and no trigger fires on UPDATE, so a product could render with
  -- no colour at all — the NOT NULL is what forbids it.
  -- ⭐ D115/Split: editing the shared product record is now a COMPANY-admin act,
  -- so the old "site admin" framing would refuse at RLS (0 rows) and never reach
  -- the constraint. Asked as a1 (company admin), whom no policy refuses, the
  -- NOT NULL is the only thing left to bite — and it still does (23502).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE products SET color_token = NULL WHERE id = '60000000-0000-0000-0000-00000000ee01';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_state = '23502' THEN RAISE NOTICE 'PASS Q36';
  ELSE RAISE NOTICE 'FAIL Q36: sqlstate=% (want 23502) — a product can be left colourless', v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q36;

\echo 'Q37: skills — the OTHER SITE''s skill is out of reach too, not just the company-wide one'
SAVEPOINT sp_Q37;
DO $$
DECLARE v_p2 uuid; v_rows int; v_state text;
BEGIN
  -- ⭐ A MISSING BRANCH, found by review rather than by a mutation: the fixture
  -- had a Plant-1 skill and a company-wide skill and no Plant-2 one, so Q21's
  -- "the same" claimed a cross-site pair its fixture could not deliver. A case
  -- name is a claim.
  SELECT v INTO v_p2 FROM q_fix WHERE k = 'p2';
  INSERT INTO skills (id, org_id, name, site_node_id)
    VALUES ('40000000-0000-0000-0000-00000000ee03','10000000-0000-0000-0000-000000000001','Q P2 Skill', v_p2);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE skills SET name = 'x' WHERE id = '40000000-0000-0000-0000-00000000ee03';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  IF v_rows = 0 AND v_state IS NULL THEN RAISE NOTICE 'PASS Q37';
  ELSE RAISE NOTICE 'FAIL Q37: rows=% sqlstate=% (want 0, silent)', v_rows, v_state; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_Q37;

ROLLBACK;

\echo '51_shared_list_owners_test.sql complete (38 cases: Q0-Q37)'
