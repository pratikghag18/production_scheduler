-- ============================================================================
-- 47_site_ownership_test.sql — migration 0020, "each site is its own instance."
--
-- Pratik's frame, and the one test it gives, which decides every case below:
--
--   "the system-admin or company-admin has access to all sites across the
--    company and they basically can change whatever they want at any site, but
--    the site-admin who are locked to the site can do whatever changes are
--    needed for that particular site... It is like each site could have their
--    own instance for the app."
--
--   -> CAN A SITE ADMIN DO THIS WITHOUT TOUCHING ANOTHER SITE?
--
-- ⭐ THIS FILE WAS SPECIFIED BY A MUTATION RUN, NOT WRITTEN AND THEN MUTATED.
-- With §1-§7 built and no test file, ten mutations were run against 0020 and
-- SEVEN escaped. That list was not a report card; it was the requirements
-- document for this file, and every one of those seven names a case here.
--
-- THE FIXTURE IS THE TEST, and it borrows 46's sharpest lesson: EVERY SITE
-- ADMIN BELOW HOLDS THE ORG-WIDE ROLE 'viewer'. If any of them were an
-- org-wide 'admin', `app_is_admin()` would short-circuit every predicate under
-- test and this whole file would pass against a migration that did nothing.
--
-- AND IT NEEDS TWO SITES IN ONE ORG, which the seed does not have. Org 1 seeds
-- a single root, so "another site" and "another tenant" would be the same
-- fixture -- and a cross-TENANT refusal proves nothing about a cross-SITE one,
-- because org scoping already refuses it three layers earlier. Plant 2 is
-- built below, in the same org, from the same shape.
--
-- Org 1 tree after the fixture:
--   plant_1                                30000000-...-0001  Site
--     plant_1.assembly                     30000000-...-0002  Department
--       plant_1.assembly.line_1            30000000-...-0004  Line
--         .cell_1 / .cell_2 / .cell_3      30000000-...-0007/8/9
--       plant_1.assembly.line_2            30000000-...-0005  Line
--     plant_1.machining                    30000000-...-0003  Department
--       plant_1.machining.cnc_line         30000000-...-0006  Line
--   plant_2                                v_p2       (its OWN copy of the shape)
--     plant_2.fabrication                  v_p2_dept
--       plant_2.fabrication.weld_line      v_p2_line
--         plant_2.fabrication.weld_line.weld_cell  v_p2_cell
--
-- People (all org-wide 'viewer'):
--   d1  admin grant on plant_1     -- site admin of Plant 1
--   d2  admin grant on plant_2     -- site admin of Plant 2
--   d3  admin grant on assembly    -- a mid-tree admin, NOT a site admin
--   d4  supervisor grant on plant_1 -- not an admin at all
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- FIXTURE. Built through the real RPCs as org 1's company admin, not by direct
-- insert, so that §10's copy-on-root-create is exercised by the fixture itself
-- and every case below runs against a site whose structure was made the way a
-- real one would be.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE w_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid; v_line uuid; v_cell uuid; v_orphan uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  v_p2   := (create_node(NULL, 'Plant 2', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2,  'Fabrication', 0)->>'id')::uuid;
  v_line := (create_node(v_dept,'Weld Line',   0)->>'id')::uuid;
  v_cell := (create_node(v_line,'Weld Cell',   0)->>'id')::uuid;

  -- An UNOWNED structure: created and deliberately never claimed by a site.
  -- This is the state §1 calls "born unowned", and mutation Z5 turned it into
  -- a structure any site admin in the org could edit.
  v_orphan := (create_hierarchy_template('Orphan Shape')->>'id')::uuid;
  PERFORM save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Site', 'is_schedulable', false),
    jsonb_build_object('id', NULL, 'name', 'Line', 'is_schedulable', true)
  ), v_orphan);

  RESET ROLE;

  INSERT INTO w_fix (k, v) VALUES
    ('p2', v_p2), ('p2_dept', v_dept), ('p2_line', v_line), ('p2_cell', v_cell),
    ('orphan', v_orphan),
    ('p2_tpl', (SELECT hl.template_id FROM nodes n
                  JOIN hierarchy_levels hl ON hl.id = n.level_id WHERE n.id = v_p2));

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000d1'),
    ('00000000-0000-0000-0000-0000000000d2'),
    ('00000000-0000-0000-0000-0000000000d3'),
    ('00000000-0000-0000-0000-0000000000d4'),
    ('00000000-0000-0000-0000-0000000000d5');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d1','viewer'),
    ('d0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d2','viewer'),
    ('d0000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d3','viewer'),
    ('d0000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d4','viewer'),
    ('d0000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d5','viewer');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000002', v_p2,                                  '10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','supervisor'),
    -- ⭐ d3's SECOND grant, and it is the difference between a test list that
    -- looks complete and one that is. A node a caller cannot SEE is already
    -- refused by §8.0's existence lookup, so a fixture in which "not mine"
    -- always means "invisible" cannot tell §8's own guards from that earlier
    -- refusal -- measured: deleting move_node's source check and its
    -- destination check were BOTH `NOT CAUGHT` until this line existed.
    -- A supervisor grant on Machining makes it visible to d3 and still not
    -- theirs to administer, which is the only state those guards cover alone.
    ('d0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','supervisor'),
    -- ⭐ d5 exists for ONE case, W23's second arm, and could not be d3. To reach
    -- §8.5's WITH CHECK term at all a caller needs an admin grant ON a node that
    -- can be legally re-parented to somewhere they can SEE: Line 1 sits one rung
    -- below Machining, and the supervisor grant makes Machining visible without
    -- making it theirs. Without both grants on one person the mutation that
    -- drops `parent_id is null` is caught by nothing.
    ('d0000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','admin'),
    ('d0000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','supervisor');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- W0 asserts the fixture itself. D86's corollary: an id typo is
-- indistinguishable from the behaviour under test whenever the honest answer
-- can be empty, so the fixture gets its own case rather than being assumed.
\echo 'W0: the fixture is well-formed -- two sites in ONE org, each owning its own structure'
SAVEPOINT sp_W0;
DO $$
DECLARE
  v_p2 uuid; v_p2_tpl uuid; v_orphan uuid;
  v_roots int; v_owned int; v_grants int;
BEGIN
  SELECT v INTO v_p2      FROM w_fix WHERE k = 'p2';
  SELECT v INTO v_p2_tpl  FROM w_fix WHERE k = 'p2_tpl';
  SELECT v INTO v_orphan  FROM w_fix WHERE k = 'orphan';

  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  SELECT count(*) INTO v_owned FROM hierarchy_templates
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND site_node_id IS NOT NULL;
  SELECT count(*) INTO v_grants FROM profile_grants
   WHERE profile_id::text LIKE 'd0000000%';

  IF v_roots = 2
     AND v_p2_tpl IS DISTINCT FROM '21000000-0000-0000-0000-000000000001'
     AND (SELECT site_node_id FROM hierarchy_templates WHERE id = v_p2_tpl) = v_p2
     AND (SELECT site_node_id FROM hierarchy_templates WHERE id = v_orphan) IS NULL
     AND v_owned = 2
     AND v_grants = 7
     -- and nobody in this file is an org-wide admin, which is the property the
     -- whole file rests on
     AND NOT EXISTS (SELECT 1 FROM user_profiles
                      WHERE id::text LIKE 'd0000000%' AND role = 'admin')
  THEN RAISE NOTICE 'PASS W0';
  ELSE RAISE NOTICE 'FAIL W0: roots=%, p2_tpl=%, owned=%, grants=% (want 7)', v_roots, v_p2_tpl, v_owned, v_grants;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W0;

-- ############################################################################
-- PART A — A SITE OWNS ITS STRUCTURE (§1-§7). W1-W12.
-- Every case here exists because a mutation escaped: Z2 (W1), Z3 (W2),
-- Z4 (W3), Z5 (W4/W5), Z6 (W6/W7), Z7 (W8), Z8 (W9), Z9/Z10 (W12).
-- ############################################################################

\echo 'W1 (Z2): one site, one structure -- a second template cannot claim a claimed site'
SAVEPOINT sp_W1;
RESET ROLE;
DO $$
DECLARE v_state text := ''; v_id uuid;
BEGIN
  -- As the TABLE OWNER, so RLS cannot be what refuses this. The unique index
  -- is the only thing standing between "one site, one structure" and two
  -- structures answering the same question -- the D87 hazard, one table over.
  BEGIN
    INSERT INTO hierarchy_templates (org_id, name, site_node_id)
      VALUES ('10000000-0000-0000-0000-000000000001', 'Second Claim',
              '30000000-0000-0000-0000-000000000001')
      RETURNING id INTO v_id;
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  IF v_state = '23505' THEN RAISE NOTICE 'PASS W1';
  ELSE RAISE NOTICE 'FAIL W1: sqlstate=% (expected 23505), inserted=%', v_state, v_id; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_W1;

\echo 'W2 (Z3): a structure can only be owned by a ROOT, not by a node inside one'
SAVEPOINT sp_W2;
RESET ROLE;
DO $$
DECLARE v_err text; v_raw text; v_detail jsonb;
BEGIN
  -- Assembly is a Department. Letting it own a structure would hand its admin
  -- the level vocabulary of the whole plant above it.
  BEGIN
    INSERT INTO hierarchy_templates (org_id, name, site_node_id)
      VALUES ('10000000-0000-0000-0000-000000000001', 'Departmental',
              '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    v_err := v_detail->>'error';
  END;
  IF v_err = 'invalid_argument' AND v_detail->>'reason' = 'not a root node'
  THEN RAISE NOTICE 'PASS W2';
  ELSE RAISE NOTICE 'FAIL W2: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_W2;

\echo 'W3 (Z4): app_is_admin_for_template is org-scoped, asserted with RLS BYPASSED'
SAVEPOINT sp_W3;
RESET ROLE;
DO $$
DECLARE v_far boolean; v_near boolean;
BEGIN
  -- RESET ROLE for the reason T18/T22/T32 do it (gotcha 15, verification rule
  -- 10): under `authenticated` the hierarchy_templates SELECT policy already
  -- supplies the org scope, so the function's OWN `t.org_id = app_current_org()`
  -- is never the thing under test and deleting it changes nothing observable.
  --
  -- The caller must be a COMPANY admin for this to bite. `app_is_admin()` is
  -- the first branch of the OR and is not org-scoped, so without the function's
  -- own org predicate org 1's company admin answers TRUE for org 2's structure.
  -- A site admin would not expose it: the second branch delegates to
  -- app_is_admin_for, which carries its own org scope.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SELECT app_is_admin_for_template('2100000b-0000-0000-0000-000000000001') INTO v_far;
  SELECT app_is_admin_for_template('21000000-0000-0000-0000-000000000001') INTO v_near;
  IF v_far = false AND v_near = true THEN RAISE NOTICE 'PASS W3';
  ELSE RAISE NOTICE 'FAIL W3: other org=% (want false), own org=% (want true)', v_far, v_near; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL W3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W3;

\echo 'W4 (Z5): an UNOWNED structure is company-admin-only -- a site admin cannot edit it'
SAVEPOINT sp_W4;
DO $$
DECLARE v_orphan uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  SELECT v INTO v_orphan FROM w_fix WHERE k = 'orphan';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM save_hierarchy_levels(jsonb_build_array(
      jsonb_build_object('id', NULL, 'name', 'Hijacked', 'is_schedulable', true)
    ), v_orphan);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- NULL is not a site anybody administers. That is what makes the nullable
  -- column in §1 a safe default rather than a hole.
  IF v_caught AND v_detail->>'error' = 'not_permitted' THEN RAISE NOTICE 'PASS W4';
  ELSE RAISE NOTICE 'FAIL W4: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W4;

\echo 'W5 (Z5): the same UNOWNED structure IS editable by the company admin'
SAVEPOINT sp_W5;
DO $$
DECLARE v_orphan uuid; v_res jsonb;
BEGIN
  -- W4's other half. Without it, a mutation that made EVERY structure
  -- uneditable would pass W4 and be caught by nothing -- the classic
  -- refuse-everything mutation that a one-sided permission suite cannot see.
  SELECT v INTO v_orphan FROM w_fix WHERE k = 'orphan';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := save_hierarchy_levels(jsonb_build_array(
    jsonb_build_object('id', NULL, 'name', 'Reworked', 'is_schedulable', true)
  ), v_orphan);
  RESET ROLE;
  IF jsonb_array_length(v_res) = 1 AND v_res->0->>'name' = 'Reworked'
  THEN RAISE NOTICE 'PASS W5';
  ELSE RAISE NOTICE 'FAIL W5: %', v_res; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W5;

\echo 'W6 (Z6): ⭐ a site admin CAN rename their own site''s levels -- the feature itself'
SAVEPOINT sp_W6;
DO $$
DECLARE v_res jsonb; v_names text[];
BEGIN
  -- This is the thing Pratik corrected me about: level vocabulary is a site
  -- admin's job, not a company admin's. It was only ever unsafe because
  -- structures were unowned, and §1-§3 fixed that.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := save_hierarchy_levels((
    SELECT jsonb_agg(jsonb_build_object('id', hl.id,
             'name', CASE hl.position WHEN 3 THEN 'Cell Group' ELSE hl.name END,
             'is_schedulable', hl.is_schedulable) ORDER BY hl.position)
      FROM hierarchy_levels hl WHERE hl.template_id = '21000000-0000-0000-0000-000000000001'
  ), '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_names
    FROM hierarchy_levels hl WHERE hl.template_id = '21000000-0000-0000-0000-000000000001';
  IF v_names = ARRAY['Site','Department','Line','Cell Group'] THEN RAISE NOTICE 'PASS W6';
  ELSE RAISE NOTICE 'FAIL W6: names=%, res=%', v_names, v_res; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W6;

\echo 'W7 (Z6): ...and cannot rename ANOTHER site''s levels'
SAVEPOINT sp_W7;
DO $$
DECLARE v_p2_tpl uuid; v_caught boolean := false; v_raw text; v_detail jsonb; v_names text[];
BEGIN
  -- The reach half of W6, and the pair is the point: a mutation that opens the
  -- door for everyone passes W6, and a mutation that shuts it for everyone
  -- passes W7. Only both together pin "their own site and no other".
  SELECT v INTO v_p2_tpl FROM w_fix WHERE k = 'p2_tpl';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM save_hierarchy_levels((
      SELECT jsonb_agg(jsonb_build_object('id', hl.id, 'name', 'Meddled ' || hl.position,
               'is_schedulable', hl.is_schedulable) ORDER BY hl.position)
        FROM hierarchy_levels hl WHERE hl.template_id = v_p2_tpl), v_p2_tpl);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_names
    FROM hierarchy_levels hl WHERE hl.template_id = v_p2_tpl;
  IF v_caught AND v_detail->>'error' = 'not_permitted'
     AND v_names = ARRAY['Site','Department','Line','Work Cell']
  THEN RAISE NOTICE 'PASS W7';
  ELSE RAISE NOTICE 'FAIL W7: caught=%, detail=%, names=%', v_caught, v_detail, v_names; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W7;

\echo 'W8 (Z7): hierarchy_levels UPDATE -- the WITH CHECK stops a level being pushed into another site'
SAVEPOINT sp_W8;
DO $$
DECLARE v_p2_tpl uuid; v_state text := ''; v_moved int;
BEGIN
  -- ASSERTED DIRECTLY ON THE TABLE, not through the RPC (verification rule 9:
  -- an UPDATE isolation case routed through a function is a read-path test in
  -- disguise). USING passes here -- the OLD row is Plant 1's level, which this
  -- admin owns -- so ONLY the WITH CHECK can refuse the new row. That is
  -- precisely what mutation Z7 deletes.
  SELECT v INTO v_p2_tpl FROM w_fix WHERE k = 'p2_tpl';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE hierarchy_levels SET template_id = v_p2_tpl
     WHERE id = '20000000-0000-0000-0000-000000000003';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_moved FROM hierarchy_levels
   WHERE id = '20000000-0000-0000-0000-000000000003' AND template_id = v_p2_tpl;
  IF v_state = '42501' AND v_moved = 0 THEN RAISE NOTICE 'PASS W8';
  ELSE RAISE NOTICE 'FAIL W8: sqlstate=% (expected 42501), moved=%', v_state, v_moved; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W8;

\echo 'W9 (Z8): a site admin cannot create a structure -- neither by INSERT nor by RPC'
SAVEPOINT sp_W9;
DO $$
DECLARE v_state text := ''; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- Creating a structure from nothing is not a site's business (§5). Both
  -- routes are checked because they are guarded by different things: the
  -- INSERT by the policy that Z8 mutates, the RPC by create_hierarchy_template's
  -- own app_is_admin(). A case covering only one leaves the other open.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO hierarchy_templates (org_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', 'Shadow Shape');
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  BEGIN
    PERFORM create_hierarchy_template('Shadow Shape 2');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_state = '42501' AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W9';
  ELSE RAISE NOTICE 'FAIL W9: insert=%, rpc caught=%, detail=%', v_state, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W9;

\echo 'W10: rename/delete of a structure follows the same ownership rule'
SAVEPOINT sp_W10;
DO $$
DECLARE
  v_p2_tpl uuid; v_renamed jsonb;
  v_c1 boolean := false; v_d1 jsonb; v_c2 boolean := false; v_d2 jsonb; v_raw text;
BEGIN
  SELECT v INTO v_p2_tpl FROM w_fix WHERE k = 'p2_tpl';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_renamed := rename_hierarchy_template('21000000-0000-0000-0000-000000000001', 'Plant 1 Shape');
  BEGIN PERFORM rename_hierarchy_template(v_p2_tpl, 'Stolen');
  EXCEPTION WHEN OTHERS THEN
    v_c1 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END; END;
  BEGIN PERFORM delete_hierarchy_template(v_p2_tpl);
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  RESET ROLE;
  IF v_renamed->>'name' = 'Plant 1 Shape'
     AND v_c1 AND v_d1->>'error' = 'not_permitted'
     AND v_c2 AND v_d2->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W10';
  ELSE RAISE NOTICE 'FAIL W10: renamed=%, rename_other=%/%, delete_other=%/%',
    v_renamed, v_c1, v_d1, v_c2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W10;

\echo 'W11: existence still beats permission -- a typo''d template id says "not found", not "not yours"'
SAVEPOINT sp_W11;
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- THE ORDERING IS THE CONTRACT, and three existing cases (T9, T10a, T18)
  -- found it the hard way when the §7 guard was first written at the TOP of
  -- these functions: every mistyped id in the caller's own org started
  -- answering `not_permitted`. This case pins the ordering from the site
  -- admin's side, where the guard is no longer a formality.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM rename_hierarchy_template('99999999-9999-9999-9999-999999999999', 'Nowhere');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_caught AND v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS W11';
  ELSE RAISE NOTICE 'FAIL W11: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W11;

\echo 'W12 (Z9/Z10): every function 0020 creates -- revoked from anon, granted to authenticated'
SAVEPOINT sp_W12;
RESET ROLE;
DO $$
DECLARE
  fns text[] := ARRAY['app_is_admin_for_template(uuid)',
                      'app_node_exists_in_org(uuid)',
                      'app_is_admin_on_grant_node(uuid)'];
  f text; v_bad int := 0;
BEGIN
  -- D93's lesson in its general form: a guard that checks ONE member of a set a
  -- migration created will not tell you the migration forgot the set. All three
  -- are walked, in both directions -- an over-broad revoke that locks
  -- `authenticated` out is just as much a defect as a missing one, and the
  -- second loop is the only thing that would catch it.
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W12: anon can execute %', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W12: authenticated cannot execute %', f; END IF;
  END LOOP;
  IF v_bad = 0 THEN RAISE NOTICE 'PASS W12';
  ELSE RAISE NOTICE 'FAIL W12: % privilege problems above', v_bad; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_W12;

-- ############################################################################
-- PART B — THE NODE RPCs (§8). W13-W26.
--
-- Every case is a PAIR by design: the same call inside the site and outside it.
-- A permission suite written only in refusals passes against a migration that
-- refuses everybody, which is the failure mode this project has hit before
-- (S17's 0019 form asserted a refusal that turned out to be the bug).
--
-- ⭐ AND THE REFUSALS ASSERT `not_permitted`, NOT MERELY "an error". A site
-- admin naming a node outside their reach used to get `invalid_argument /
-- not found` -- true of what the RLS-scoped lookup could see, false about the
-- world -- which is the same class of defect as §19.44's `level_mismatch`
-- standing in for a permission refusal. §8.0 is what fixed it and these cases
-- are what hold it.
-- ############################################################################

\echo 'W13: create_node -- a child inside the site succeeds, one in another site says not_permitted'
SAVEPOINT sp_W13;
DO $$
DECLARE
  v_p2_line uuid; v_made jsonb;
  v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  SELECT v INTO v_p2_line FROM w_fix WHERE k = 'p2_line';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_made := create_node('30000000-0000-0000-0000-000000000004', 'Cell 8', 0);
  BEGIN PERFORM create_node(v_p2_line, 'Trespass Cell', 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  IF v_made->>'path' = 'plant_1.assembly.line_1.cell_8'
     AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W13';
  ELSE RAISE NOTICE 'FAIL W13: made=%, caught=%, detail=%', v_made, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W13;

\echo 'W14 (§8.0): a real-but-unreachable node says not_permitted; a made-up id still says not found'
SAVEPOINT sp_W14;
DO $$
DECLARE
  v_c1 boolean := false; v_d1 jsonb; v_c2 boolean := false; v_d2 jsonb;
  v_c3 boolean := false; v_d3 jsonb; v_raw text; v_far uuid;
BEGIN
  -- Read the fixture table BEFORE switching role: `w_fix` is a TEMP table owned
  -- by the session user, and `authenticated` cannot read it -- which surfaces
  -- as a raw permission error with no DETAIL, i.e. as a case failure that looks
  -- like the code under test refusing for the wrong reason. Every other case in
  -- this file reads w_fix first for the same reason; this one did not, and the
  -- first run said `unreachable=<NULL>`.
  SELECT v INTO v_far FROM w_fix WHERE k = 'p2_line';
  -- THE THREE-WAY DISTINCTION IS THE WHOLE OF §8.0, and it needs all three
  -- arms or it is not a distinction:
  --   a Plant 2 node -- exists, same company, INVISIBLE to d3 -> not_permitted
  --   a random uuid  -- does not exist at all                  -> not found
  --   an org 2 node  -- exists, ANOTHER COMPANY                -> not found
  -- The third arm is the one that keeps the tenant boundary silent. A helper
  -- that answered "it's there, just not yours" across tenants would leak the
  -- existence of another customer's ids, and T9/T10a/T18 exist to stop exactly
  -- that.
  --
  -- The first arm must be a node d3 cannot SEE, which is what §8.0 is for. Since
  -- d3 now also holds a supervisor grant on Machining (see the fixture),
  -- Machining is visible and would be refused one step later, by §8's own guard
  -- rather than by this one -- a perfectly good refusal that measures nothing
  -- here. W17 and W18 are where that other state is tested.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM create_node(v_far, 'Sneak', 0);
  EXCEPTION WHEN OTHERS THEN
    v_c1 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END; END;
  BEGIN PERFORM create_node('39999999-9999-9999-9999-999999999999', 'Ghost', 0);
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  BEGIN PERFORM create_node('3000000b-0000-0000-0000-000000000004', 'Tenant Sneak', 0);
  EXCEPTION WHEN OTHERS THEN
    v_c3 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d3 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d3 := NULL; END; END;
  RESET ROLE;
  IF v_c1 AND v_d1->>'error' = 'not_permitted'
     AND v_c2 AND v_d2->>'error' = 'invalid_argument' AND v_d2->>'reason' = 'not found'
     AND v_c3 AND v_d3->>'error' = 'invalid_argument' AND v_d3->>'reason' = 'not found'
  THEN RAISE NOTICE 'PASS W14';
  ELSE RAISE NOTICE 'FAIL W14: unreachable=%, absent=%, other-tenant=%', v_d1, v_d2, v_d3; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W14;

\echo 'W15: creating a SITE stays a company action'
SAVEPOINT sp_W15;
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb; v_made jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM create_node(NULL, 'Empire', 0, '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_made := create_node(NULL, 'Plant 4', 0, '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  IF v_caught AND v_detail->>'error' = 'not_permitted' AND v_made->>'path' = 'plant_4'
  THEN RAISE NOTICE 'PASS W15';
  ELSE RAISE NOTICE 'FAIL W15: site admin caught=%/%, company admin made=%', v_caught, v_detail, v_made; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W15;

\echo 'W16: rename_node -- inside yes, another site no, and a site admin MAY rename their own site'
SAVEPOINT sp_W16;
DO $$
DECLARE
  v_p2 uuid; v_in jsonb; v_root jsonb; v_kids int;
  v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- Renaming a root is allowed here on purpose, and it is the one place §8's
  -- table departs from "a root operation is a company operation". A rename
  -- neither creates, destroys nor re-parents a site -- it changes one site's
  -- own wording, which is the frame's answer, and app_is_admin_for(root) is
  -- true only for an admin grant on that very root.
  --
  -- ⭐ AND IT DID NOT WORK UNTIL §8.5. The RPC allowed it and RLS refused it,
  -- because a grant is stored as an id but used as a PATH, so renaming the
  -- grant node moved the scope out from under the row. This case is the reason
  -- that section exists; the whole subtree following the rename is asserted
  -- too, because the cascade was the half that stayed broken after the obvious
  -- fix.
  SELECT v INTO v_p2 FROM w_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_in   := rename_node('30000000-0000-0000-0000-000000000004', 'Line One');
  v_root := rename_node('30000000-0000-0000-0000-000000000001', 'Plant One');
  BEGIN PERFORM rename_node(v_p2, 'Mine Now');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  SELECT count(*) INTO v_kids FROM nodes WHERE path <@ 'plant_one'::ltree;
  IF v_in->>'name' = 'Line One' AND v_root->>'path' = 'plant_one'
     AND v_kids = 13
     AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W16';
  ELSE RAISE NOTICE 'FAIL W16: in=%, root=%, subtree=%, caught=%, detail=%',
    v_in, v_root, v_kids, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W16;

\echo 'W17: ⭐ move_node to another site says not_permitted, NOT level_mismatch (§19.44''s defect)'
SAVEPOINT sp_W17;
DO $$
DECLARE
  v_p2_dept uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
  v_c2 boolean := false; v_d2 jsonb;
BEGIN
  -- THIS IS THE HEADLINE CASE OF §8/§11. Weld Line sits at the Line rung of
  -- Plant 2, exactly one below Fabrication -- so the destination is LEVEL-VALID
  -- and the ONLY thing wrong with this move is that Plant 2 is not d1's site.
  -- Choosing a level-valid destination is what makes the case able to fail:
  -- against a level-INVALID one, `level_mismatch` would be the right answer and
  -- the case could not tell a fixed migration from a broken one.
  --
  -- Before §8's step 4b the answer here was `level_mismatch`, because the
  -- destination's level was read through RLS and came back empty. The client
  -- switches on a closed set of twelve codes, so the wrong code is a contract
  -- defect, not cosmetics.
  SELECT v INTO v_p2_dept FROM w_fix WHERE k = 'p2_dept';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM move_node('30000000-0000-0000-0000-000000000004', v_p2_dept);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;

  -- ⭐ SECOND ARM, AND THE MUTATION RUN IS WHY IT EXISTS. The arm above is
  -- refused by §8.0's existence lookup, one step BEFORE the destination check
  -- -- so deleting the destination check entirely came back `NOT CAUGHT`.
  -- This arm is the only state that check covers on its own: a destination the
  -- caller can SEE and does not administer. d3 administers Assembly and holds
  -- a SUPERVISOR grant on Machining, so Machining is visible; Line 1 is theirs
  -- and sits exactly one rung below Machining, so the move is level-valid and
  -- permission is the only thing wrong with it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM move_node('30000000-0000-0000-0000-000000000004',
                          '30000000-0000-0000-0000-000000000003');
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  RESET ROLE;

  IF v_caught AND v_detail->>'error' = 'not_permitted'
     AND v_detail->>'node_id' = v_p2_dept::text
     AND v_c2 AND v_d2->>'error' = 'not_permitted'
     AND v_d2->>'node_id' = '30000000-0000-0000-0000-000000000003'
  THEN RAISE NOTICE 'PASS W17';
  ELSE RAISE NOTICE 'FAIL W17: invisible dest=%/%, visible-not-mine dest=%/%',
    v_caught, v_detail, v_c2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W17;

\echo 'W18: move_node inside the site succeeds -- and the SOURCE end is checked too'
SAVEPOINT sp_W18;
DO $$
DECLARE
  v_moved jsonb; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- Two halves, and the second is not covered by W17: a source the caller can
  -- SEE and does not administer, with a destination they DO administer, so the
  -- source check is the only thing that can refuse it.
  --
  -- ⭐ THE FIRST DRAFT USED PLANT 2'S WELD LINE AS THE SOURCE and deleting the
  -- source check came back `NOT CAUGHT` -- Plant 2 is invisible to d3, so
  -- §8.0's existence lookup refused it first and the guard under test never
  -- ran. CNC Line is visible to d3 through their supervisor grant on Machining,
  -- is not theirs to administer, and sits one rung below Assembly, which is.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_moved := move_node('30000000-0000-0000-0000-000000000009',
                       '30000000-0000-0000-0000-000000000005');
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM move_node('30000000-0000-0000-0000-000000000006',
                          '30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  IF v_moved->>'path' = 'plant_1.assembly.line_2.cell_3'
     AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W18';
  ELSE RAISE NOTICE 'FAIL W18: moved=%, caught=%, detail=%', v_moved, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W18;

\echo 'W19: detaching a node into a site of its own is a company action'
SAVEPOINT sp_W19;
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- move_node(node, NULL) makes the node a root, which IS creating a site --
  -- the same act create_node's root branch reserves. Without this branch a
  -- site admin could reach the one operation §8 most carefully closed by
  -- coming at it sideways. d1 administers Plant 1, so the SOURCE end passes
  -- and only the null-destination branch can refuse.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM move_node('30000000-0000-0000-0000-000000000002', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  IF v_caught AND v_detail->>'error' = 'not_permitted'
     AND v_detail->>'reason' = 'a parentless node is a site'
  THEN RAISE NOTICE 'PASS W19';
  ELSE RAISE NOTICE 'FAIL W19: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W19;

\echo 'W20: moving a SITE is a company action'
SAVEPOINT sp_W20;
DO $$
DECLARE v_p2 uuid; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- The other root branch of move_node: the node being moved IS a site. d2
  -- administers Plant 2 and would otherwise pass the source check, so this can
  -- only be refused by the "source is a root" branch.
  SELECT v INTO v_p2 FROM w_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM move_node(v_p2, '30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  IF v_caught AND v_detail->>'error' = 'not_permitted'
     AND v_detail->>'reason' = 'the node being moved is a site'
  THEN RAISE NOTICE 'PASS W20';
  ELSE RAISE NOTICE 'FAIL W20: caught=%, detail=%', v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W20: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W20;

\echo 'W21: delete_node -- inside yes, another site no, and a SITE is never a site admin''s to remove'
SAVEPOINT sp_W21;
DO $$
DECLARE
  v_p2_cell uuid; v_del jsonb; v_fresh uuid;
  v_c1 boolean := false; v_d1 jsonb; v_c2 boolean := false; v_d2 jsonb; v_raw text;
BEGIN
  -- The root arm covers `deactivate` as much as `delete`: deactivating a root
  -- deactivates its whole subtree, so it removes a site from the product just
  -- as effectively. `deactivate` is delete_node's DEFAULT mode, which is why
  -- that is the arm asserted here.
  SELECT v INTO v_p2_cell FROM w_fix WHERE k = 'p2_cell';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  -- A node created for the purpose: every seeded cell carries runs or
  -- assignments, and `delete_node`'s hard-delete branch refuses those with
  -- `node_in_use` -- a refusal about WORK, not about permission, which would
  -- have made this case pass for the wrong reason had it been asserted loosely.
  v_fresh := (create_node('30000000-0000-0000-0000-000000000004', 'Cell 9', 0)->>'id')::uuid;
  v_del := delete_node(v_fresh, 'delete');
  BEGIN PERFORM delete_node(v_p2_cell, 'delete');
  EXCEPTION WHEN OTHERS THEN
    v_c1 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END; END;
  BEGIN PERFORM delete_node('30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  RESET ROLE;
  IF v_del->>'deleted' = '1'
     AND v_c1 AND v_d1->>'error' = 'not_permitted'
     AND v_c2 AND v_d2->>'error' = 'not_permitted'
     AND v_d2->>'reason' = 'the node is a site'
  THEN RAISE NOTICE 'PASS W21';
  ELSE RAISE NOTICE 'FAIL W21: del=%, other=%/%, own root=%/%', v_del, v_c1, v_d1, v_c2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W21: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W21;

\echo 'W22: place_node carries no guard of its own and is protected by move_node''s'
SAVEPOINT sp_W22;
DO $$
DECLARE
  v_p2_line uuid; v_res jsonb; v_caught boolean := false; v_raw text; v_detail jsonb;
BEGIN
  -- §8 deliberately DELETED place_node's own `if not app_is_admin()` rather
  -- than scoping it, because a second copy could not be mutation-tested -- no
  -- case can distinguish deleting it from leaving it while move_node's check
  -- stands (gotcha 17). This case is what makes that deletion safe rather than
  -- merely tidy: it proves the remaining guard actually covers this entry
  -- point, in both directions.
  SELECT v INTO v_p2_line FROM w_fix WHERE k = 'p2_line';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := place_node('30000000-0000-0000-0000-000000000009',
                      '30000000-0000-0000-0000-000000000004', 0);
  BEGIN PERFORM place_node('30000000-0000-0000-0000-000000000009', v_p2_line, 0);
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END; END;
  RESET ROLE;
  IF v_res->0->>'name' = 'Cell 3' AND (v_res->0->>'sort_order')::int = 0
     AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W22';
  ELSE RAISE NOTICE 'FAIL W22: res=%, caught=%, detail=%', v_res, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W22: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W22;

\echo 'W23 (§8.5): the `parent_id is null` condition is load-bearing -- a grant node can be neither detached nor re-parented'
SAVEPOINT sp_W23;
DO $$
DECLARE v_state text := ''; v_msg text; v_still uuid; v_state2 text := ''; v_still2 uuid;
BEGIN
  -- §8.5's WITH CHECK term reads "or (parent_id is null and I hold a grant on
  -- this node)". Without the `parent_id is null`, a mid-tree admin could
  -- re-parent their own grant node into another site by a direct table update;
  -- WITH it, the only way to reach the term is to make the node parentless --
  -- which `nodes_check_level_adjacency` refuses independently, because a
  -- parentless node must sit on a position-0 level.
  --
  -- ⭐ THIS CASE EXISTS BECAUSE THAT ARGUMENT IS A SHADOW. "It is safe because
  -- something else refuses it first" is precisely the shape gotcha 18 keeps
  -- catching this project with, and an argument is not a measurement. d3
  -- administers Assembly, which is a Department at position 1.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET parent_id = NULL WHERE id = '30000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  RESET ROLE;
  SELECT parent_id INTO v_still FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002';

  -- ⭐ SECOND ARM, ADDED BECAUSE THE FIRST WAS NOT ENOUGH. Detaching is the
  -- route the ADJACENCY TRIGGER refuses; RE-PARENTING is the route only
  -- `parent_id is null` refuses, and dropping that condition was caught by
  -- nothing until this arm existed. d5 holds an admin grant on Line 1 and a
  -- supervisor grant on Machining, so Line 1 is theirs, Machining is visible,
  -- and Line 1 sits exactly one rung below it -- every other check passes and
  -- the condition under test is the only thing left saying no.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d5', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000003'
     WHERE id = '30000000-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN v_state2 := SQLSTATE;
  END;
  RESET ROLE;
  SELECT parent_id INTO v_still2 FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';

  IF v_state <> '' AND v_still = '30000000-0000-0000-0000-000000000001'
     AND v_state2 = '42501' AND v_still2 = '30000000-0000-0000-0000-000000000002'
  THEN RAISE NOTICE 'PASS W23';
  ELSE RAISE NOTICE 'FAIL W23: detach sqlstate=% (%), parent now=%; re-parent sqlstate=%, Line 1 parent now=%',
    v_state, v_msg, v_still, v_state2, v_still2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W23: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W23;

\echo 'W24 (§8.5): the KNOWN LIMITATION -- a mid-tree admin still cannot rename their own grant node'
SAVEPOINT sp_W24;
DO $$
DECLARE v_caught boolean := false; v_name text;
BEGIN
  -- ⚠️ THIS CASE ASSERTS A REFUSAL THAT IS NOT WANTED. It is here so the
  -- limitation is a recorded fact rather than folklore, and so that whoever
  -- fixes it properly -- by stopping grants being resolved through a mutable
  -- path, which is a schema change and its own migration -- has to delete this
  -- case ON PURPOSE, the way 0019's S17 had to be deleted by this one.
  --
  -- A SITE admin is unaffected: their grant is on the site root, and W16 shows
  -- that case working. This bites a DEPARTMENT admin renaming their department.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM rename_node('30000000-0000-0000-0000-000000000002', 'Fab Shop');
  EXCEPTION WHEN OTHERS THEN v_caught := true;
  END;
  RESET ROLE;
  SELECT name INTO v_name FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002';
  IF v_caught AND v_name = 'Assembly' THEN RAISE NOTICE 'PASS W24';
  ELSE RAISE NOTICE 'FAIL W24: caught=%, name=% -- if this now SUCCEEDS the limitation is fixed and this case should be deleted', v_caught, v_name; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W24: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W24;

\echo 'W25: promote_node -- inside the site yes, out of the site no, into a SITE never'
SAVEPOINT sp_W25;
DO $$
DECLARE
  v_ok jsonb; v_spare uuid;
  v_c1 boolean := false; v_d1 jsonb; v_c2 boolean := false; v_d2 jsonb; v_raw text;
BEGIN
  -- THREE ARMS, one per branch of app_relevel_subtree's guard:
  --  1. d1 (admin on plant_1) promotes a FRESH cell -- source and destination
  --     (Assembly) both inside the grant -> allowed. Fresh, because every
  --     seeded cell carries runs, and promoting one off the schedulable rung
  --     is refused by `schedulable_level_locked` -- a refusal about WORK, which
  --     would have made this arm pass for a reason that has nothing to do with
  --     permission.
  --  2. d3 (admin on assembly) promotes Line 1 -- the DESTINATION is the
  --     grandparent, Plant 1, which sits ABOVE their grant. A grant covers a
  --     subtree downward and never upward, so checking only the source would
  --     let them walk a line clean out of their department. This arm is the
  --     one a single-ended guard passes.
  --  3. d1 promotes Assembly -- its parent is a root, so the derived
  --     grandparent is NULL and the node would become a SITE.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_spare := (create_node('30000000-0000-0000-0000-000000000004', 'Spare Cell', 0)->>'id')::uuid;
  v_ok := promote_node(v_spare);
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM promote_node('30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    v_c1 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END; END;
  RESET ROLE;
  IF jsonb_array_length(v_ok) >= 1
     AND v_c1 AND v_d1->>'error' = 'not_permitted'
     AND v_c2 AND v_d2->>'error' = 'not_permitted'
     AND v_d2->>'reason' = 'a parentless node is a site'
  THEN RAISE NOTICE 'PASS W25';
  ELSE RAISE NOTICE 'FAIL W25: ok=%, above-grant=%/%, into-site=%/%', v_ok, v_c1, v_d1, v_c2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W25: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W25;

\echo 'W26: demote_node and a DIRECT app_relevel_subtree call are both guarded'
SAVEPOINT sp_W26;
DO $$
DECLARE
  v_p2_line uuid; v_ok jsonb; v_spare uuid;
  v_c1 boolean := false; v_d1 jsonb; v_c2 boolean := false; v_d2 jsonb; v_raw text;
BEGIN
  -- The direct arm is not decoration: case M30 in 75_node_mobility_test.sql
  -- asserts `authenticated` can EXECUTE app_relevel_subtree, so it is a public
  -- entry point whatever anyone intended. promote_node and demote_node carry
  -- NO guard of their own precisely so that this one is the only copy -- and
  -- a single guard is only safe if something proves it is reachable from every
  -- direction, which is what these three arms do.
  SELECT v INTO v_p2_line FROM w_fix WHERE k = 'p2_line';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  -- A fresh CHILDLESS line: a demote needs a rung below every level in the
  -- moved subtree, and the seeded lines already reach the bottom of the
  -- template. Line 2 would fail with `level_mismatch` -- again a refusal that
  -- is nothing to do with permission.
  v_spare := (create_node('30000000-0000-0000-0000-000000000002', 'Spare Line', 0)->>'id')::uuid;
  v_ok := demote_node(v_spare, '30000000-0000-0000-0000-000000000004');
  BEGIN PERFORM demote_node(v_p2_line, '30000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    v_c1 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END; END;
  BEGIN PERFORM app_relevel_subtree(v_p2_line, '30000000-0000-0000-0000-000000000004', 1);
  EXCEPTION WHEN OTHERS THEN
    v_c2 := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END; END;
  RESET ROLE;
  IF jsonb_array_length(v_ok) >= 1
     AND v_c1 AND v_d1->>'error' = 'not_permitted'
     AND v_c2 AND v_d2->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W26';
  ELSE RAISE NOTICE 'FAIL W26: ok=%, demote=%/%, direct=%/%', v_ok, v_c1, v_d1, v_c2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W26: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W26;

\echo 'W27: a SUPERVISOR grant is not an admin grant -- every node RPC refuses'
SAVEPOINT sp_W27;
DO $$
DECLARE v_bad int := 0; v_raw text; v_detail jsonb; v_err text;
BEGIN
  -- 0019's X13 mutation treated supervisor grants as admin grants and was
  -- caught by S5/S15 on the PREDICATES. This is the same mutation seen from
  -- the RPC side, which is where it would actually be felt. d4 holds a
  -- supervisor grant on plant_1 -- the same node d1 administers -- so the only
  -- difference between them is the role, which is the whole (role, scope)
  -- model in one comparison.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d4', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM create_node('30000000-0000-0000-0000-000000000004', 'Nope', 0);
    v_bad := v_bad + 1; RAISE NOTICE 'W27: create_node allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_detail->>'error' IS DISTINCT FROM 'not_permitted' THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W27: create_node gave %', v_detail; END IF; END;
  BEGIN PERFORM rename_node('30000000-0000-0000-0000-000000000004', 'Nope');
    v_bad := v_bad + 1; RAISE NOTICE 'W27: rename_node allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_detail->>'error' IS DISTINCT FROM 'not_permitted' THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W27: rename_node gave %', v_detail; END IF; END;
  BEGIN PERFORM move_node('30000000-0000-0000-0000-000000000009',
                          '30000000-0000-0000-0000-000000000005');
    v_bad := v_bad + 1; RAISE NOTICE 'W27: move_node allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_detail->>'error' IS DISTINCT FROM 'not_permitted' THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W27: move_node gave %', v_detail; END IF; END;
  BEGIN PERFORM delete_node('30000000-0000-0000-0000-000000000009');
    v_bad := v_bad + 1; RAISE NOTICE 'W27: delete_node allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_detail->>'error' IS DISTINCT FROM 'not_permitted' THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W27: delete_node gave %', v_detail; END IF; END;
  BEGIN PERFORM save_hierarchy_levels(jsonb_build_array(
          jsonb_build_object('id', NULL, 'name', 'Nope', 'is_schedulable', true)),
          '21000000-0000-0000-0000-000000000001');
    v_bad := v_bad + 1; RAISE NOTICE 'W27: save_hierarchy_levels allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_detail->>'error' IS DISTINCT FROM 'not_permitted' THEN
      v_bad := v_bad + 1; RAISE NOTICE 'W27: save_hierarchy_levels gave %', v_detail; END IF; END;
  RESET ROLE;
  IF v_bad = 0 THEN RAISE NOTICE 'PASS W27';
  ELSE RAISE NOTICE 'FAIL W27: % problems above', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W27: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W27;

-- ############################################################################
-- PART C — WHO MAY HAND OUT ACCESS (§9). W28-W33.
--
-- ⭐ W28 IS THE ESCALATION CASE, and it is the reason 0019 refused to touch
-- `profile_grants` at all: "if 0020 lets a site admin write profile_grants
-- without a subtree predicate, a site admin grants themselves 'admin' on the
-- root and the whole model is decorative." Written the way D98's was.
-- ############################################################################

\echo 'W28 (⭐ escalation): nobody can grant themselves reach they do not already have'
SAVEPOINT sp_W28;
DO $$
DECLARE
  v_p2 uuid; v_bad int := 0; v_state text;
BEGIN
  -- TWO DIRECTIONS, because a grant covers a subtree DOWNWARD and the two ways
  -- out of a scope are up and sideways:
  --   d3 (admin on Assembly) grants themselves admin on PLANT 1  -- upward
  --   d1 (admin on Plant 1)  grants themselves admin on PLANT 2  -- sideways
  -- Both are direct table INSERTs, because that is the shape of the attack:
  -- there is no RPC to blame, only the policy.
  SELECT v INTO v_p2 FROM w_fix WHERE k = 'p2';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role)
      VALUES ('d0000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',
              '10000000-0000-0000-0000-000000000001','admin');
    v_bad := v_bad + 1; RAISE NOTICE 'W28: UPWARD escalation ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    IF v_state <> '42501' THEN v_bad := v_bad + 1;
      RAISE NOTICE 'W28: upward gave sqlstate % (wanted 42501)', v_state; END IF;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role)
      VALUES ('d0000000-0000-0000-0000-000000000001', v_p2,
              '10000000-0000-0000-0000-000000000001','admin');
    v_bad := v_bad + 1; RAISE NOTICE 'W28: SIDEWAYS escalation ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    IF v_state <> '42501' THEN v_bad := v_bad + 1;
      RAISE NOTICE 'W28: sideways gave sqlstate % (wanted 42501)', v_state; END IF;
  END;
  RESET ROLE;

  IF v_bad = 0 THEN RAISE NOTICE 'PASS W28';
  ELSE RAISE NOTICE 'FAIL W28: % escalation(s) above', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W28: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W28;

\echo 'W29: ⭐ a site admin CAN give someone access to their own site -- what Pratik asked for'
SAVEPOINT sp_W29;
DO $$
DECLARE v_n int;
BEGIN
  -- "Site admins can't create people" was the wrong conclusion from a right
  -- worry (§9). Access to a PLACE is theirs; the company-admin flag is not,
  -- and W33 is that half. Without this case the whole section is one long
  -- refusal and a migration that granted nothing would pass it all.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    VALUES ('d0000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000004',
            '10000000-0000-0000-0000-000000000001','admin');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000004'
     AND node_id = '30000000-0000-0000-0000-000000000004' AND role = 'admin';
  IF v_n = 1 THEN RAISE NOTICE 'PASS W29';
  ELSE RAISE NOTICE 'FAIL W29: rows=%', v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W29: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W29;

\echo 'W30: profile_grants UPDATE -- both the USING and the WITH CHECK carry their weight'
SAVEPOINT sp_W30;
DO $$
DECLARE v_p2 uuid; v_moved int; v_stolen int; v_shadow int;
BEGIN
  -- Verification rule 9: assert the edit predicate DIRECTLY, because an
  -- isolation case routed through a function is a read-path test in disguise.
  -- 0019's S11 property, one table over, and the two halves fail differently:
  --   WITH CHECK -- d1 pushes their OWN grant out onto Plant 2 (old row theirs)
  --   USING      -- d1 picks up d2's Plant 2 grant and drags it home
  -- An UPDATE that matches no row is not an error, so both are asserted by
  -- COUNTING rows afterwards rather than by catching an exception.
  SELECT v INTO v_p2 FROM w_fix WHERE k = 'p2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE profile_grants SET node_id = v_p2
     WHERE profile_id = 'd0000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    UPDATE profile_grants SET node_id = '30000000-0000-0000-0000-000000000004'
     WHERE profile_id = 'd0000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  SELECT count(*) INTO v_moved FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000001' AND node_id = v_p2;
  SELECT count(*) INTO v_stolen FROM profile_grants
   WHERE profile_id = 'd0000000-0000-0000-0000-000000000002'
     AND node_id = '30000000-0000-0000-0000-000000000004';

  -- ⭐ AND THE INVARIANT THAT MAKES THE `USING` CLAUSE UNTESTABLE, ASSERTED
  -- DIRECTLY RATHER THAN LEFT AS FOLKLORE. Deleting the USING scope was caught
  -- by nothing, and MEASURED the reason is that `profile_grants_select` already
  -- hides every row the USING clause would refuse: there is no row a caller can
  -- SELECT that is neither their own nor inside their admin scope. The edit
  -- rule is shadowed by the read rule.
  --
  -- The clause stays -- it is the semantically correct place for an edit rule,
  -- and the read rule may legitimately widen later (letting people see who else
  -- is on their team is a reasonable future change). This assertion is what
  -- turns "widening SELECT quietly un-guards UPDATE" from a surprise into a red
  -- test pointing at this comment.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_shadow FROM profile_grants pg
   WHERE pg.profile_id <> app_current_profile_id()
     AND NOT app_is_admin_for(pg.node_id);
  RESET ROLE;

  IF v_moved = 0 AND v_stolen = 0 AND v_shadow = 0 THEN RAISE NOTICE 'PASS W30';
  ELSE RAISE NOTICE 'FAIL W30: pushed out=%, dragged home=%, selectable-but-not-editable rows=%',
    v_moved, v_stolen, v_shadow; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W30: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W30;

\echo 'W31: profile_grants DELETE -- inside the site yes, another site''s no'
SAVEPOINT sp_W31;
DO $$
DECLARE v_mine int; v_theirs int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM profile_grants WHERE profile_id = 'd0000000-0000-0000-0000-000000000004';
  DELETE FROM profile_grants WHERE profile_id = 'd0000000-0000-0000-0000-000000000002';
  RESET ROLE;
  SELECT count(*) INTO v_mine   FROM profile_grants WHERE profile_id = 'd0000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_theirs FROM profile_grants WHERE profile_id = 'd0000000-0000-0000-0000-000000000002';
  -- d4's supervisor grant is ON plant_1, which d1 administers -> gone.
  -- d2's admin grant is on plant_2 -> untouched, and silently so: a DELETE
  -- that matches no visible row is not an error, which is exactly why this
  -- is asserted by counting.
  IF v_mine = 0 AND v_theirs = 1 THEN RAISE NOTICE 'PASS W31';
  ELSE RAISE NOTICE 'FAIL W31: own site left=%, other site left=%', v_mine, v_theirs; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W31: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W31;

\echo 'W32: profile_grants SELECT -- a site admin sees their own site''s grants and no others'
SAVEPOINT sp_W32;
DO $$
DECLARE v_seen int; v_p2_seen int; v_own int; v_org2_seen int;
BEGIN
  SELECT count(*) INTO v_own FROM profile_grants;   -- as the owner: everything
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM profile_grants;
  SELECT count(*) INTO v_p2_seen FROM profile_grants pg
    JOIN nodes n ON n.id = pg.node_id WHERE n.path <@ 'plant_2'::ltree;
  SELECT count(*) INTO v_org2_seen FROM profile_grants
   WHERE org_id = '10000000-0000-0000-0000-000000000002';
  RESET ROLE;
  -- MEASURED, not guessed: twelve grants exist (five seeded, seven from this
  -- file's fixture) and d1 sees exactly nine -- everything on plant_1's
  -- subtree, including grants belonging to other people, which is the point:
  -- a site admin has to be able to see who has access to their site. Hidden:
  -- d2's grant on plant_2, and org 2's two.
  --
  -- The org-2 arm matters on its own. The site term (`app_is_admin_for`) is
  -- org-scoped internally, so this cross-TENANT count would stay 0 even if the
  -- policy's own org guard were deleted -- it is asserted here as the visible
  -- half of a property S18 has to state structurally, not as proof of it.
  IF v_own = 12 AND v_seen = 9 AND v_p2_seen = 0 AND v_org2_seen = 0
  THEN RAISE NOTICE 'PASS W32';
  ELSE RAISE NOTICE 'FAIL W32: owner=%, site admin=%, plant_2 visible=%, org 2 visible=%',
    v_own, v_seen, v_p2_seen, v_org2_seen; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W32: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W32;

\echo 'W33: the company-admin FLAG is still company-admin-only -- user_profiles did not move'
SAVEPOINT sp_W33;
DO $$
DECLARE v_role text; v_added int;
BEGIN
  -- ⭐ THE ONE FIELD THAT IS A REAL ESCALATION. `user_profiles.role = 'admin'`
  -- is company-wide reach, so writing it -- and creating company membership at
  -- all -- stays a company action. §9 moved `profile_grants` and deliberately
  -- did not move this, and "deliberately" is only true if something checks.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE user_profiles SET role = 'admin'
     WHERE id = 'd0000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    INSERT INTO user_profiles (org_id, user_id, role)
      VALUES ('10000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-0000000000a1', 'admin');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  SELECT role INTO v_role FROM user_profiles WHERE id = 'd0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_added FROM user_profiles
   WHERE org_id = '10000000-0000-0000-0000-000000000001';
  -- Three seeded profiles plus this file's five. The count is a literal, and
  -- it moves whenever the fixture gains a person -- which is the point: the
  -- INSERT arm passes silently if nothing counts the rows afterwards, because
  -- a refused insert and a successful one look identical from inside a
  -- swallowed exception handler.
  IF v_role = 'viewer' AND v_added = 8 THEN RAISE NOTICE 'PASS W33';
  ELSE RAISE NOTICE 'FAIL W33: role=% (wanted viewer), org 1 profiles=% (wanted 8)', v_role, v_added; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W33: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W33;

-- ############################################################################
-- PART D — A NEW SITE GETS ITS OWN COPY (§10), WHAT HANGS OFF A NODE (§12),
-- AND THE CHANGE THIS MIGRATION REFUSED TO MAKE (§11). W34-W39.
-- ############################################################################

\echo 'W34 (§10): a new site is built from a chosen shape and gets a COPY of it'
SAVEPOINT sp_W34;
DO $$
DECLARE
  v_made jsonb; v_tpl uuid; v_names text[]; v_src_names text[]; v_sched int;
BEGIN
  -- Pratik, asked and answered: a new site is set up by choosing an existing
  -- shape, and it gets a copy, not a reference. Four things are asserted
  -- because four different mistakes are possible: the copy exists, it is NOT
  -- the source, it carries the source's wording, and it carries the
  -- SCHEDULABLE FLAG -- a copy that lost the flag would produce a site nothing
  -- can be booked on, and `save_hierarchy_levels` check 5 would then refuse
  -- every later edit of it, which is a dead end with no way out from the UI.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_made := create_node(NULL, 'Plant 7', 0, '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_tpl := (v_made->>'template_id')::uuid;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_names
    FROM hierarchy_levels hl WHERE hl.template_id = v_tpl;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_src_names
    FROM hierarchy_levels hl WHERE hl.template_id = '21000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_sched FROM hierarchy_levels
   WHERE template_id = v_tpl AND is_schedulable;
  IF v_tpl IS NOT NULL
     AND v_tpl <> '21000000-0000-0000-0000-000000000001'
     AND v_names = ARRAY['Site','Department','Line','Work Cell']
     AND v_src_names = ARRAY['Site','Department','Line','Work Cell']
     AND v_sched = 1
     AND (SELECT site_node_id FROM hierarchy_templates WHERE id = v_tpl)
           = (v_made->>'id')::uuid
     AND (SELECT hl.template_id FROM hierarchy_levels hl
           WHERE hl.id = (v_made->>'level_id')::uuid) = v_tpl
  THEN RAISE NOTICE 'PASS W34';
  ELSE RAISE NOTICE 'FAIL W34: made=%, copy levels=%, source levels=%, schedulable=%',
    v_made, v_names, v_src_names, v_sched; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W34: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W34;

\echo 'W35 (§10): ⭐ the two sites can then DIVERGE -- editing the copy leaves the source alone'
SAVEPOINT sp_W35;
DO $$
DECLARE
  v_made jsonb; v_tpl uuid; v_copy_names text[]; v_src_names text[];
BEGIN
  -- THE WHOLE REASON COPYING WAS THE RIGHT ANSWER, and the thing a shared
  -- reference could never do. It is also the case that makes the copy
  -- *matter*: without it, "a copy was made" is a fact about ids that nobody
  -- would notice if the two structures were secretly still one.
  --
  -- Done as the NEW SITE'S OWN ADMIN, not as the company admin, so it doubles
  -- as the end-to-end version of the feature: create a site, hand it to
  -- somebody, and they can immediately shape it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_made := create_node(NULL, 'Plant 8', 0, '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_tpl := (v_made->>'template_id')::uuid;
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    VALUES ('d0000000-0000-0000-0000-000000000002', (v_made->>'id')::uuid,
            '10000000-0000-0000-0000-000000000001', 'admin');

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  SET LOCAL ROLE authenticated;
  PERFORM save_hierarchy_levels((
    SELECT jsonb_agg(jsonb_build_object('id', hl.id,
             'name', CASE hl.position WHEN 1 THEN 'Area' WHEN 3 THEN 'Station' ELSE hl.name END,
             'is_schedulable', hl.is_schedulable) ORDER BY hl.position)
      FROM hierarchy_levels hl WHERE hl.template_id = v_tpl), v_tpl);
  RESET ROLE;

  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_copy_names
    FROM hierarchy_levels hl WHERE hl.template_id = v_tpl;
  SELECT array_agg(hl.name ORDER BY hl.position) INTO v_src_names
    FROM hierarchy_levels hl WHERE hl.template_id = '21000000-0000-0000-0000-000000000001';
  IF v_copy_names = ARRAY['Site','Area','Line','Station']
     AND v_src_names = ARRAY['Site','Department','Line','Work Cell']
  THEN RAISE NOTICE 'PASS W35';
  ELSE RAISE NOTICE 'FAIL W35: copy=%, source=%', v_copy_names, v_src_names; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W35: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W35;

\echo 'W36 (§10): the copy is named for the site, and a name already taken gets a suffix'
SAVEPOINT sp_W36;
DO $$
DECLARE v_a jsonb; v_b jsonb; v_na text; v_nb text;
BEGIN
  -- `hierarchy_templates` is `unique (org_id, name)`, so the suffix loop is a
  -- real path rather than defensive padding: create a structure called
  -- "Plant 6" first and the site of that name must still be creatable. This is
  -- the arm that a naive `insert ... values (v_org_id, v_name)` fails on, with
  -- a raw 23505 outside the twelve-code set.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM create_hierarchy_template('Plant 6');
  v_a := create_node(NULL, 'Plant 6', 0, '21000000-0000-0000-0000-000000000001');
  v_b := create_node(NULL, 'Plant 5', 0, '21000000-0000-0000-0000-000000000001');
  RESET ROLE;
  SELECT name INTO v_na FROM hierarchy_templates WHERE id = (v_a->>'template_id')::uuid;
  SELECT name INTO v_nb FROM hierarchy_templates WHERE id = (v_b->>'template_id')::uuid;
  IF v_na = 'Plant 6 (2)' AND v_nb = 'Plant 5' THEN RAISE NOTICE 'PASS W36';
  ELSE RAISE NOTICE 'FAIL W36: collided name=% (wanted "Plant 6 (2)"), free name=%', v_na, v_nb; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W36: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W36;

\echo 'W37 (§12): node_skill_requirements follows the node'
SAVEPOINT sp_W37;
DO $$
DECLARE v_p2_cell uuid; v_mine int; v_theirs int; v_s1 text := 'ok'; v_s2 text := 'ok';
BEGIN
  -- Pure per-node configuration: which skills a cell needs touches nothing
  -- outside the site. Straight yes on the frame test. `app_is_admin_for(node_id)`
  -- is safe in a WITH CHECK here because node_id names a row in a DIFFERENT
  -- table, committed before this statement -- which is the whole of D85's rule.
  SELECT v INTO v_p2_cell FROM w_fix WHERE k = 'p2_cell';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001',
              '30000000-0000-0000-0000-000000000009',
              (SELECT id FROM skills WHERE org_id = '10000000-0000-0000-0000-000000000001' LIMIT 1));
  EXCEPTION WHEN OTHERS THEN v_s1 := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN
    INSERT INTO node_skill_requirements (org_id, node_id, skill_id)
      VALUES ('10000000-0000-0000-0000-000000000001', v_p2_cell,
              (SELECT id FROM skills WHERE org_id = '10000000-0000-0000-0000-000000000001' LIMIT 1));
  EXCEPTION WHEN OTHERS THEN v_s2 := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_mine FROM node_skill_requirements
   WHERE node_id = '30000000-0000-0000-0000-000000000009';
  SELECT count(*) INTO v_theirs FROM node_skill_requirements WHERE node_id = v_p2_cell;
  IF v_mine = 1 AND v_theirs = 0 AND v_s1 = 'ok' AND v_s2 = '42501'
  THEN RAISE NOTICE 'PASS W37';
  ELSE RAISE NOTICE 'FAIL W37: own site=% [%], other site=% [sqlstate %]',
    v_mine, v_s1, v_theirs, v_s2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W37: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W37;

\echo 'W38 (§12): node_shift_templates follows the node'
SAVEPOINT sp_W38;
DO $$
DECLARE v_p2_line uuid; v_tpl uuid; v_mine int; v_theirs int; v_s1 text := 'ok'; v_s2 text := 'ok';
BEGIN
  -- Both tables, not one. D93's lesson: a guard that checks ONE member of a
  -- set a migration touched will not tell you the migration forgot the set.
  --
  -- The sqlstate of each attempt is CAPTURED rather than discarded. The first
  -- draft of this case swallowed both exceptions into NULL and reported
  -- "own site=0" -- which reads as a permission failure and was in fact a
  -- wrong COLUMN NAME. An instrument that hides the error message turns its
  -- own bug into a finding about the code (verification rule 6).
  SELECT v INTO v_p2_line FROM w_fix WHERE k = 'p2_line';
  SELECT id INTO v_tpl FROM shift_templates
   WHERE org_id = '10000000-0000-0000-0000-000000000001' LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO node_shift_templates (org_id, node_id, template_id)
      VALUES ('10000000-0000-0000-0000-000000000001',
              '30000000-0000-0000-0000-000000000009', v_tpl);
  EXCEPTION WHEN OTHERS THEN v_s1 := SQLSTATE || ' ' || SQLERRM; END;
  BEGIN
    INSERT INTO node_shift_templates (org_id, node_id, template_id)
      VALUES ('10000000-0000-0000-0000-000000000001', v_p2_line, v_tpl);
  EXCEPTION WHEN OTHERS THEN v_s2 := SQLSTATE; END;
  RESET ROLE;
  SELECT count(*) INTO v_mine FROM node_shift_templates
   WHERE node_id = '30000000-0000-0000-0000-000000000009';
  SELECT count(*) INTO v_theirs FROM node_shift_templates WHERE node_id = v_p2_line;
  IF v_mine = 1 AND v_theirs = 0 AND v_s1 = 'ok' AND v_s2 = '42501'
  THEN RAISE NOTICE 'PASS W38';
  ELSE RAISE NOTICE 'FAIL W38: own site=% [%], other site=% [sqlstate %]',
    v_mine, v_s1, v_theirs, v_s2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W38: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W38;

\echo 'W39 (§11): ⭐ the level-adjacency bypass is STILL owner-only -- D97 has not been undone'
SAVEPOINT sp_W39;
DO $$
DECLARE v_caught boolean := false; v_raw text; v_detail jsonb; v_secdef boolean;
BEGIN
  -- ⛔ THIS CASE GUARDS A CHANGE THAT WAS PLANNED AND THEN REFUSED. §19.44 told
  -- 0020 to make `nodes_check_level_adjacency` SECURITY DEFINER, so that a
  -- destination a site admin cannot see stops being reported as
  -- `level_mismatch`. MEASURED on this schema: doing that reopens the escape
  -- hatch D97 closed at Pratik's request, because D97's gate is
  -- `pg_has_role(current_user, <owner>, 'USAGE')` and inside a SECURITY DEFINER
  -- function `current_user` IS the owner -- so the test becomes true for
  -- everybody signed in.
  --
  --   trigger as it ships (INVOKER):  set app.hierarchy_migration -> REFUSED
  --   same trigger as DEFINER:        identical statements        -> ACCEPTED
  --
  -- The wrong code was fixed a different way (§8's step 4b and §8.0), which
  -- W17 proves. This case asserts BOTH halves of the refusal -- the behaviour
  -- and the security mode -- so that anyone later "finishing" §11 by flipping
  -- the flag is stopped by a red test rather than by nobody.
  SELECT prosecdef INTO v_secdef FROM pg_proc
   WHERE proname = 'nodes_check_level_adjacency' AND pronamespace = 'public'::regnamespace;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('app.hierarchy_migration', 'on', true);
  BEGIN
    UPDATE nodes SET level_id = level_id WHERE id = '30000000-0000-0000-0000-000000000004';
  EXCEPTION WHEN OTHERS THEN
    v_caught := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  PERFORM set_config('app.hierarchy_migration', '', true);
  RESET ROLE;
  IF v_secdef = false AND v_caught AND v_detail->>'error' = 'not_permitted'
  THEN RAISE NOTICE 'PASS W39';
  ELSE RAISE NOTICE 'FAIL W39: security_definer=% (must be false), caught=%, detail=%',
    v_secdef, v_caught, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL W39: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_W39;

RESET ROLE;
\echo '47_site_ownership_test.sql: all 40 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;
