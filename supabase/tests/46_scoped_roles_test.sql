-- ============================================================================
-- 46_scoped_roles_test.sql — migration 0019, the (role, scope) model.
-- 19 cases, S1-S19. S18 and S19 exist because mutations X14 and X9 were caught
-- by nothing; S11's fixture was rebuilt for the same reason (X6).
--
-- THE FIXTURE IS THE TEST, AGAIN, AND FOR A SHARPER REASON THAN IN 45.
-- Every site admin here is given the ORG-WIDE role 'viewer'. That is not
-- colour: if the fixture made them an org-wide 'admin', `app_is_admin()` would
-- be true and would short-circuit every predicate under test, and all
-- seventeen cases would pass against a migration that did nothing at all.
-- Org-wide 'viewer' + a grant with role 'admin' is the ONLY arrangement in
-- which "the grant carries the power" is a claim the fixture can deliver.
--
-- WHAT 0019 DELIBERATELY DOES NOT DO, pinned by S17: the node RPCs still open
-- with `if not app_is_admin()`, so a site admin can write the `nodes` TABLE and
-- still cannot call `create_node`. That is the migration's stated scope, and
-- when 0020 flips it, S17 is the case that must be rewritten on purpose rather
-- than discovered broken.
--
-- Org 1 tree, for reference:
--   plant_1                                30000000-...-0001  Site
--     plant_1.assembly                     30000000-...-0002  Department
--       plant_1.assembly.line_1            30000000-...-0004  Line
--         plant_1.assembly.line_1.cell_1   30000000-...-0007  Work Cell
--       plant_1.assembly.line_2            30000000-...-0005  Line
--     plant_1.machining                    30000000-...-0003  Department
--       plant_1.machining.cnc_line         30000000-...-0006  Line
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
\echo 'S1: authenticated may EXECUTE all four new functions (D93)'
-- D93: migration 0014 added functions without granting them and every caller
-- got a bare 42501 `permission denied for function`, which no client error code
-- covers and no policy test would ever see. Calling each one as `authenticated`
-- is the only thing that proves the GRANT block ran.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S1;
DO $$
DECLARE v_a boolean; v_b boolean; v_n int; v_c boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c1');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'viewer');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM app_grant_paths_for(ARRAY['admin']);
  SELECT app_is_admin_on_path('plant_1'::ltree) INTO v_a;
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000002') INTO v_b;
  SELECT app_is_admin_anywhere() INTO v_c;
  RESET ROLE;
  IF v_n = 0 AND v_a = false AND v_b = false AND v_c = false THEN RAISE NOTICE 'PASS S1';
  ELSE RAISE NOTICE 'FAIL S1: n=%, on_path=%, for=%, anywhere=%', v_n, v_a, v_b, v_c; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S1;

-- ----------------------------------------------------------------------------
\echo 'S2: the column exists as specified and can_edit is gone'
-- The backfill itself cannot be covered here -- verify-db.sh applies every
-- migration before any seed, so the UPDATE always runs on an empty table. It
-- was measured separately on a real 0018 -> 0019 upgrade (see the migration
-- header). What this case pins is everything that must stay true afterwards.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S2;
DO $$
DECLARE v_notnull boolean; v_default text; v_check int; v_can_edit int; v_idx int; v_bad int;
BEGIN
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO v_notnull, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.profile_grants'::regclass AND a.attname = 'role';

  SELECT count(*) INTO v_check FROM pg_constraint
   WHERE conrelid = 'public.profile_grants'::regclass AND conname = 'profile_grants_role_check';

  SELECT count(*) INTO v_can_edit FROM pg_attribute
   WHERE attrelid = 'public.profile_grants'::regclass AND attname = 'can_edit' AND NOT attisdropped;

  SELECT count(*) INTO v_idx FROM pg_class
   WHERE relname = 'profile_grants_profile_role_idx';

  -- the constraint must reject a fourth value, not merely exist
  BEGIN
    INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
      ('a0000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000005',
       '10000000-0000-0000-0000-000000000001', 'superuser');
    v_bad := 1;
  EXCEPTION WHEN check_violation THEN v_bad := 0;
  END;

  IF v_notnull AND v_default = '''supervisor''::text' AND v_check = 1
     AND v_can_edit = 0 AND v_idx = 1 AND v_bad = 0 THEN
    RAISE NOTICE 'PASS S2';
  ELSE RAISE NOTICE 'FAIL S2: notnull=%, default=%, check=%, can_edit_cols=%, idx=%, bad_accepted=%',
        v_notnull, v_default, v_check, v_can_edit, v_idx, v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL S2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S2;

-- ----------------------------------------------------------------------------
\echo 'S3: a site admin is an admin over their subtree and nowhere else'
-- The whole model in one case. Org-wide role is 'viewer', so every TRUE below
-- comes from the grant and nothing else.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S3;
DO $$
DECLARE v_sys boolean; v_here boolean; v_deep boolean; v_elsewhere boolean; v_root boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c3');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c3';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin() INTO v_sys;                                              -- must be FALSE
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000002') INTO v_here;   -- Assembly: TRUE
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000007') INTO v_deep;   -- Cell 1: TRUE
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000003') INTO v_elsewhere; -- Machining: FALSE
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000001') INTO v_root;   -- Plant 1: FALSE
  RESET ROLE;
  IF v_sys = false AND v_here AND v_deep AND v_elsewhere = false AND v_root = false THEN
    RAISE NOTICE 'PASS S3';
  ELSE RAISE NOTICE 'FAIL S3: sys=%, assembly=%, cell1=%, machining=%, plant=%',
        v_sys, v_here, v_deep, v_elsewhere, v_root; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S3;

-- ----------------------------------------------------------------------------
\echo 'S4: a system admin is an admin over a node no grant of theirs covers'
-- The seed admin holds a grant on the ROOT, so every seeded node is inside it
-- and this case would be vacuous against seed data alone. A second root node
-- is created specifically so there is somewhere the grant does NOT reach.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S4;
DO $$
DECLARE v_new uuid; v_covered boolean; v_admin_for boolean; v_lvl uuid;
BEGIN
  SELECT level_id INTO v_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_lvl, NULL, 'Plant 9')
    RETURNING id INTO v_new;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- assert the fixture: no grant of theirs covers it, or the case proves nothing
  SELECT EXISTS (SELECT 1 FROM nodes n, app_grant_paths(false) gp
                  WHERE n.id = v_new AND n.path <@ gp) INTO v_covered;
  SELECT app_is_admin_for(v_new) INTO v_admin_for;
  RESET ROLE;
  IF v_covered = false AND v_admin_for THEN RAISE NOTICE 'PASS S4';
  ELSE RAISE NOTICE 'FAIL S4: covered_by_grant=%, app_is_admin_for=%', v_covered, v_admin_for; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S4;

-- ----------------------------------------------------------------------------
\echo 'S5: a supervisor grant confers no admin power at all'
-- Ana (seed) has a supervisor grant on Assembly and org-wide role supervisor.
-- She must be admin nowhere -- including on the very node she is granted.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S5;
DO $$
DECLARE v_granted boolean; v_anywhere boolean; v_for boolean; v_on_path boolean;
BEGIN
  -- assert the fixture: she really does hold a grant there
  SELECT EXISTS (SELECT 1 FROM profile_grants
                  WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
                    AND node_id = '30000000-0000-0000-0000-000000000002'
                    AND role = 'supervisor') INTO v_granted;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin_anywhere() INTO v_anywhere;
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000002') INTO v_for;
  SELECT app_is_admin_on_path('plant_1.assembly'::ltree) INTO v_on_path;
  RESET ROLE;
  IF v_granted AND v_anywhere = false AND v_for = false AND v_on_path = false THEN
    RAISE NOTICE 'PASS S5';
  ELSE RAISE NOTICE 'FAIL S5: granted=%, anywhere=%, for=%, on_path=%',
        v_granted, v_anywhere, v_for, v_on_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S5;

-- ----------------------------------------------------------------------------
\echo 'S6: app_is_admin_for is tenant-scoped (0012, re-pinned on the new function)'
-- Org 2's admin asking about an org-1 node. `app_is_admin()` is true for them
-- -- in THEIR org -- so the org predicate inside the function is the only thing
-- standing between them and a cross-tenant true.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S6;
DO $$
DECLARE v_own boolean; v_cross boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin_for('3000000b-0000-0000-0000-000000000001') INTO v_own;    -- their own root
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000002') INTO v_cross;  -- org 1's Assembly
  RESET ROLE;
  IF v_own AND v_cross = false THEN RAISE NOTICE 'PASS S6';
  ELSE RAISE NOTICE 'FAIL S6: own_org=%, cross_org=% -- CROSS-TENANT ADMIN', v_own, v_cross; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S6;

-- ----------------------------------------------------------------------------
\echo 'S7: grants ADD power -- a deeper, weaker grant never subtracts'
-- Admin on Assembly AND viewer on Line 1, which sits inside Assembly. If
-- coverage were "nearest grant wins", the viewer row would demote them on
-- Line 1 and everything under it, and "give this person read access to one
-- line" would silently strip a department admin. Union, strongest wins.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S7;
DO $$
DECLARE v_both int; v_line boolean; v_cell boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c7');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c7', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c7';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000004',
           '10000000-0000-0000-0000-000000000001', 'viewer'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c7';
  -- assert the fixture: two grants, one of each, or the case is about nothing
  SELECT count(*) INTO v_both FROM profile_grants pg
    JOIN user_profiles up ON up.id = pg.profile_id
   WHERE up.user_id = '00000000-0000-0000-0000-0000000000c7';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c7', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000004') INTO v_line;  -- the demoted node
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000007') INTO v_cell;  -- under it
  RESET ROLE;
  IF v_both = 2 AND v_line AND v_cell THEN RAISE NOTICE 'PASS S7';
  ELSE RAISE NOTICE 'FAIL S7: grants=%, line_1=%, cell_1=%', v_both, v_line, v_cell; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S7;

-- ----------------------------------------------------------------------------
\echo 'S8: a site admin may schedule inside their site despite org-wide viewer'
-- 0019 section 5b. `app_can_write()` reads the ORG-WIDE role and is false here;
-- without the added admin-grant term this returns false and a site admin could
-- restructure their site but not move a single shift in it.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S8;
DO $$
DECLARE v_write boolean; v_edit_in boolean; v_edit_out boolean; v_read_out boolean;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c8');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c8', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c8';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c8', true);
  SET LOCAL ROLE authenticated;
  SELECT app_can_write() INTO v_write;                                             -- FALSE: org-wide viewer
  SELECT app_can_edit_node('30000000-0000-0000-0000-000000000007') INTO v_edit_in; -- Cell 1, inside: TRUE
  SELECT app_can_edit_node('3000000a-0000-0000-0000-00000000000c') INTO v_edit_out;-- Cell 6, outside: FALSE
  SELECT app_can_read_node('3000000a-0000-0000-0000-00000000000c') INTO v_read_out;-- and unreadable too
  RESET ROLE;
  IF v_write = false AND v_edit_in AND v_edit_out = false AND v_read_out = false THEN
    RAISE NOTICE 'PASS S8';
  ELSE RAISE NOTICE 'FAIL S8: can_write=%, edit_inside=%, edit_outside=%, read_outside=%',
        v_write, v_edit_in, v_edit_out, v_read_out; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S8;

-- ----------------------------------------------------------------------------
\echo 'S9: nodes_insert admits a site admin inside their subtree only'
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S9;
DO $$
DECLARE v_line_lvl uuid; v_inside boolean := false; v_outside boolean := false;
BEGIN
  SELECT level_id INTO v_line_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c9');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c9', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c9';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
              '30000000-0000-0000-0000-000000000002', 'Line In');
    v_inside := true;
  EXCEPTION WHEN OTHERS THEN v_inside := false; END;

  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
              '30000000-0000-0000-0000-000000000003', 'Line Out');
    v_outside := true;
  EXCEPTION WHEN OTHERS THEN v_outside := false; END;

  RESET ROLE;
  IF v_inside AND v_outside = false THEN RAISE NOTICE 'PASS S9';
  ELSE RAISE NOTICE 'FAIL S9: inside_own_subtree=%, outside=%', v_inside, v_outside; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S9;

-- ----------------------------------------------------------------------------
\echo 'S10: INSERT ... RETURNING sees its own row -- D85 dissolved, not dodged'
-- THE HEADLINE. 0013 rescued `create_node` by putting `app_is_admin()` first in
-- `nodes_select` so admins short-circuit past a self-read. A SITE admin is not
-- `app_is_admin()`, so the moment one creates a node they fall through to the
-- second term -- and under the OLD policy that term called `app_can_read_node`,
-- which reads `nodes` and cannot see an uncommitted row. Silent empty
-- RETURNING, exactly D85. The path-based policy asks the row's own column
-- instead, so the row comes back.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S10;
DO $$
DECLARE v_line_lvl uuid; v_id uuid; v_path ltree; v_sys boolean;
BEGIN
  SELECT level_id INTO v_line_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000ca');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000ca', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000ca';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ca', true);
  SET LOCAL ROLE authenticated;
  -- assert the fixture: they are NOT a system admin, so the short-circuit that
  -- hid D85 for admins is not available to them
  SELECT app_is_admin() INTO v_sys;
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
            '30000000-0000-0000-0000-000000000002', 'Returning Probe')
    RETURNING id, path INTO v_id, v_path;
  RESET ROLE;
  IF v_sys = false AND v_id IS NOT NULL AND v_path = 'plant_1.assembly.returning_probe'::ltree THEN
    RAISE NOTICE 'PASS S10';
  ELSE RAISE NOTICE 'FAIL S10: system_admin=%, id=%, path=% -- EMPTY RETURNING IS D85',
        v_sys, v_id, v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S10;

-- ----------------------------------------------------------------------------
\echo 'S11: an update that straddles the grant boundary is refused, both ways'
-- USING sees the old row, WITH CHECK the new one, and a re-parent changes
-- `path`, so moving OUT fails the WITH CHECK and pulling IN fails the USING.
--
-- ⭐ THE FIXTURE IS THE WHOLE CASE, AND THE FIRST VERSION OF IT WAS VACUOUS.
-- It moved a node to a destination the site admin could not SEE, and
-- `nodes_check_level_adjacency` -- SECURITY INVOKER, resolving the parent
-- through `nodes_select` -- refused it with `level_mismatch` before the policy
-- was ever consulted. Deliberately breaking the WITH CHECK was then caught by
-- nothing (mutation X6): the trigger was doing the refusing, and the case had
-- no way to tell the two apart.
--
-- So the grants here are TWO: 'admin' on Line 1 and 'viewer' on Line 2. Line 2
-- is therefore VISIBLE (any grant confers read) but NOT administered, which is
-- precisely the boundary the policy exists to hold -- and the only arrangement
-- in which the policy is the only thing that can say no.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S11;
DO $$
DECLARE v_visible boolean; v_rename boolean := false; v_out boolean := false; v_in boolean := false;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cb');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cb', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000004',   -- Line 1: ADMIN
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cb';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000005',   -- Line 2: VIEWER
           '10000000-0000-0000-0000-000000000001', 'viewer'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cb';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cb', true);
  SET LOCAL ROLE authenticated;

  -- assert the fixture: Line 2 must be VISIBLE, or the adjacency trigger does
  -- the refusing and this case measures nothing
  SELECT EXISTS (SELECT 1 FROM nodes WHERE id = '30000000-0000-0000-0000-000000000005')
    INTO v_visible;

  -- inside -> inside: allowed (a plain rename stays under the admin grant)
  BEGIN
    UPDATE nodes SET name = 'Cell One' WHERE id = '30000000-0000-0000-0000-000000000007';
    v_rename := FOUND;
  EXCEPTION WHEN OTHERS THEN v_rename := false; END;

  -- inside -> outside: WITH CHECK must refuse (Cell 1 from Line 1 to Line 2)
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000005'
     WHERE id = '30000000-0000-0000-0000-000000000007';
    v_out := FOUND;
  EXCEPTION WHEN OTHERS THEN v_out := false; END;

  -- outside -> inside: USING must refuse (Cell 4 from Line 2 to Line 1)
  BEGIN
    UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000004'
     WHERE id = '3000000a-0000-0000-0000-00000000000a';
    v_in := FOUND;
  EXCEPTION WHEN OTHERS THEN v_in := false; END;

  RESET ROLE;
  IF v_visible AND v_rename AND v_out = false AND v_in = false THEN RAISE NOTICE 'PASS S11';
  ELSE RAISE NOTICE 'FAIL S11: line2_visible=%, rename_inside=%, moved_out=%, pulled_in=%',
        v_visible, v_rename, v_out, v_in; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S11;

-- ----------------------------------------------------------------------------
\echo 'S12: nodes_delete admits a site admin inside their subtree only'
-- A DELETE outside the grant is not an error -- the row is simply invisible, so
-- zero rows match. `FOUND` is the only way to tell the difference between
-- "refused" and "done", which is exactly why it is checked rather than the
-- absence of an exception.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S12;
DO $$
DECLARE v_line_lvl uuid; v_victim uuid; v_in boolean; v_out boolean; v_still int;
BEGIN
  SELECT level_id INTO v_line_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';
  INSERT INTO nodes (org_id, level_id, parent_id, name)
    VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
            '30000000-0000-0000-0000-000000000002', 'Doomed')
    RETURNING id INTO v_victim;

  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cc');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cc', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cc';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cc', true);
  SET LOCAL ROLE authenticated;

  DELETE FROM nodes WHERE id = '30000000-0000-0000-0000-000000000006';  -- CNC Line, outside
  v_out := FOUND;
  DELETE FROM nodes WHERE id = v_victim;                                -- inside
  v_in := FOUND;
  RESET ROLE;

  SELECT count(*) INTO v_still FROM nodes WHERE id = '30000000-0000-0000-0000-000000000006';
  IF v_in AND v_out = false AND v_still = 1 THEN RAISE NOTICE 'PASS S12';
  ELSE RAISE NOTICE 'FAIL S12: deleted_inside=%, deleted_outside=%, cnc_line_rows=%',
        v_in, v_out, v_still; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S12;

-- ----------------------------------------------------------------------------
\echo 'S13: a site admin cannot create a new SITE'
-- "allowed to make changes only to a particular site they belong". A root node
-- has no parent, so its path is under nobody's grant and only a system admin
-- can insert it. This falls out of the model rather than being a rule on top
-- of it, which is why it is worth pinning: a later refactor that special-cased
-- roots would break it silently.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S13;
DO $$
DECLARE v_site_lvl uuid; v_made boolean := false;
BEGIN
  SELECT level_id INTO v_site_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cd');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cd', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cd';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cd', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_site_lvl, NULL, 'Plant Rogue');
    v_made := true;
  EXCEPTION WHEN OTHERS THEN v_made := false; END;
  RESET ROLE;
  IF v_made = false THEN RAISE NOTICE 'PASS S13';
  ELSE RAISE NOTICE 'FAIL S13: a site admin created a new root site'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S13;

-- ----------------------------------------------------------------------------
\echo 'S14: admin-anywhere never authorises a write -- the D98 shape, in-org'
-- 45 closed the CROSS-ORG version of this. The same mistake is available
-- within one org the moment site admins exist: `app_is_admin_anywhere()` is
-- true for a Machining admin, and if any write path reached for it instead of
-- `app_is_admin_for(node)`, that admin would own Assembly too.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S14;
DO $$
DECLARE v_line_lvl uuid; v_anywhere boolean; v_wrote boolean := false;
BEGIN
  SELECT level_id INTO v_line_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000ce');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000ce', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000003',   -- Machining
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000ce';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ce', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin_anywhere() INTO v_anywhere;   -- must be TRUE, or the case is vacuous
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
              '30000000-0000-0000-0000-000000000002', 'Trespass');
    v_wrote := true;
  EXCEPTION WHEN OTHERS THEN v_wrote := false; END;
  RESET ROLE;
  IF v_anywhere AND v_wrote = false THEN RAISE NOTICE 'PASS S14';
  ELSE RAISE NOTICE 'FAIL S14: admin_anywhere=%, wrote_other_subtree=%', v_anywhere, v_wrote; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S14;

-- ----------------------------------------------------------------------------
\echo 'S15: supervisors gained nothing -- Ana still cannot touch the tree'
-- The regression that matters in the other direction. 0019 widened
-- `app_can_edit_node` and rewrote four `nodes` policies; if any of that leaked
-- structural power to an ordinary supervisor, this is where it shows.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S15;
DO $$
DECLARE v_line_lvl uuid; v_ins boolean := false; v_upd boolean; v_del boolean;
BEGIN
  SELECT level_id INTO v_line_lvl FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);  -- Ana
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO nodes (org_id, level_id, parent_id, name)
      VALUES ('10000000-0000-0000-0000-000000000001', v_line_lvl,
              '30000000-0000-0000-0000-000000000002', 'Ana Line');
    v_ins := true;
  EXCEPTION WHEN OTHERS THEN v_ins := false; END;
  UPDATE nodes SET name = 'Renamed By Ana' WHERE id = '30000000-0000-0000-0000-000000000004';
  v_upd := FOUND;
  DELETE FROM nodes WHERE id = '30000000-0000-0000-0000-000000000005';
  v_del := FOUND;
  RESET ROLE;
  IF v_ins = false AND v_upd = false AND v_del = false THEN RAISE NOTICE 'PASS S15';
  ELSE RAISE NOTICE 'FAIL S15: supervisor insert=%, update=%, delete=%', v_ins, v_upd, v_del; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S15;

-- ----------------------------------------------------------------------------
\echo 'S16: the rewritten nodes_select still hides other subtrees'
-- `nodes_select` changed shape in this migration. Ana must still see exactly
-- her department and nothing of Machining -- and, being a supervisor and not a
-- system admin, she is the only kind of user for whom the second term of that
-- policy is ever evaluated.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S16;
DO $$
DECLARE v_assembly int; v_machining int; v_total int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);  -- Ana
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_assembly  FROM nodes WHERE path <@ 'plant_1.assembly'::ltree;
  SELECT count(*) INTO v_machining FROM nodes WHERE path <@ 'plant_1.machining'::ltree;
  SELECT count(*) INTO v_total     FROM nodes;
  RESET ROLE;
  -- Assembly + Line 1 + Line 2 + Cells 1,2,3,4,5 = 8, and nothing else at all
  IF v_assembly = 8 AND v_machining = 0 AND v_total = 8 THEN RAISE NOTICE 'PASS S16';
  ELSE RAISE NOTICE 'FAIL S16: assembly=%, machining=%, total=%', v_assembly, v_machining, v_total; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S16;

-- ----------------------------------------------------------------------------
\echo 'S17: 0020 OPENED the RPC doors -- inside the site only'
-- ⭐ THIS CASE WAS REWRITTEN BY MIGRATION 0020, ON PURPOSE. Its 0019 form
-- asserted the exact opposite -- that a site admin who could write the `nodes`
-- TABLE (S9) still could not call `create_node`, because every node RPC opened
-- with `if not app_is_admin()`. 0019 said so in as many words: "the substrate
-- admits them, the doors are still bolted... S17 pins that on purpose, so 0020
-- has to rewrite it deliberately rather than find it broken." This is that
-- rewrite, and it is the reason 0019 was worth splitting from 0020.
--
-- It asserts all THREE halves of 0020 §8's rule in one place, because the rule
-- is a boundary and a boundary needs both sides:
--   1. inside the grant -> the create SUCCEEDS
--   2. elsewhere in the same company -> `not_permitted`, NOT "not found"
--      (Machining is real and invisible to this admin; §8.0's
--      app_node_exists_in_org is what stops the refusal being a lie)
--   3. a ROOT create -> `not_permitted`, because that creates a SITE
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S17;
DO $$
DECLARE
  v_admin_here boolean; v_made jsonb;
  v_caught_far boolean := false; v_detail_far jsonb;
  v_caught_root boolean := false; v_detail_root jsonb; v_raw text;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000cf');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000cf', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000cf';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000cf', true);
  SET LOCAL ROLE authenticated;
  SELECT app_is_admin_for('30000000-0000-0000-0000-000000000002') INTO v_admin_here;

  -- 1. inside the grant: Assembly is theirs, so a Line under it is theirs.
  v_made := create_node('30000000-0000-0000-0000-000000000002', 'Via RPC', 0, NULL);

  -- 2. Machining is a sibling of Assembly under the same plant. It exists, and
  --    it is invisible to this admin. The refusal must be about permission.
  BEGIN
    PERFORM create_node('30000000-0000-0000-0000-000000000003', 'Trespass', 0, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_caught_far := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail_far := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail_far := NULL; END;
  END;

  -- 3. a root is a SITE, and a site admin does not make sites.
  BEGIN
    PERFORM create_node(NULL, 'Own Empire', 0, '21000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    v_caught_root := true; GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail_root := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail_root := NULL; END;
  END;
  RESET ROLE;

  IF v_admin_here
     AND v_made->>'path' = 'plant_1.assembly.via_rpc'
     AND v_caught_far AND v_detail_far->>'error' = 'not_permitted'
     AND v_caught_root AND v_detail_root->>'error' = 'not_permitted' THEN
    RAISE NOTICE 'PASS S17';
  ELSE RAISE NOTICE 'FAIL S17: admin_here=%, made=%, far=%/%, root=%/%',
        v_admin_here, v_made, v_caught_far, v_detail_far, v_caught_root, v_detail_root; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S17;

-- ----------------------------------------------------------------------------
\echo 'S18: every nodes policy still carries its tenant guard (D83)'
-- ⭐ THIS CASE IS STRUCTURAL, NOT BEHAVIOURAL, AND THAT IS A DELIBERATE
-- CONCESSION -- the honest answer to mutation X14, which deleted
-- `org_id = app_current_org()` from `nodes_insert` and was caught by nothing.
--
-- IT WAS NOT CAUGHT BECAUSE THE GUARD IS CURRENTLY SHADOWED. Two behavioural
-- routes at a cross-tenant insert were measured, and BOTH are refused before
-- the policy is consulted, by `nodes_check_level_adjacency`, which is SECURITY
-- INVOKER:
--
--   under a parent  ->  it resolves the parent from `nodes`; the other org's
--                       node is invisible; `level_mismatch: not exactly one
--                       below its parent's`
--   as a root       ->  it resolves the level from `hierarchy_levels`; the
--                       other org's level is invisible; `level_mismatch: has
--                       no parent but its level is not position 0`
--
-- So no query a client can issue can distinguish the guard being present from
-- the guard being absent. That does NOT make it redundant. It is defended in
-- depth by an accident of the trigger's security mode -- and 0020 is likely to
-- consider making that trigger SECURITY DEFINER, precisely to stop it
-- answering "permission" questions with `level_mismatch`. The moment it does,
-- this guard becomes the only thing standing between two tenants.
--
-- Asserting the policy TEXT is therefore the weakest thing that still catches
-- someone deleting it, which is the failure that matters.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S18;
DO $$
DECLARE r record; v_missing text := '';
BEGIN
  FOR r IN
    SELECT p.polname,
           coalesce(pg_get_expr(p.polqual,      p.polrelid), '') AS using_expr,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS check_expr,
           p.polcmd
      FROM pg_policy p
     WHERE p.polrelid = 'public.nodes'::regclass
  LOOP
    -- SELECT/UPDATE/DELETE must guard USING; INSERT/UPDATE must guard WITH CHECK
    IF r.polcmd IN ('r','w','d') AND r.using_expr NOT LIKE '%org_id = app_current_org()%' THEN
      v_missing := v_missing || r.polname || '.using ';
    END IF;
    IF r.polcmd IN ('a','w') AND r.check_expr NOT LIKE '%org_id = app_current_org()%' THEN
      v_missing := v_missing || r.polname || '.check ';
    END IF;
  END LOOP;
  IF v_missing = '' THEN RAISE NOTICE 'PASS S18';
  ELSE RAISE NOTICE 'FAIL S18: tenant guard missing from: % -- D83 reopened', v_missing; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL S18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S18;

-- ----------------------------------------------------------------------------
\echo 'S19: app_grant_paths(true) counts an admin grant as a writable path'
-- ⭐ ADDED BECAUSE MUTATION X9 WAS CAUGHT BY NOTHING. Dropping 'admin' from
-- the require_edit role list is invisible through `app_can_edit_node`, because
-- 0019's own `app_is_admin_on_path` term short-circuits first and answers TRUE
-- anyway. The function's own contract -- "the paths where I may write" -- has
-- to be asserted directly, or the redundancy hides the regression from every
-- caller that has one.
-- ----------------------------------------------------------------------------
SAVEPOINT sp_S19;
DO $$
DECLARE v_write_paths int; v_read_paths int;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000d9');
  INSERT INTO user_profiles (org_id, user_id, role) VALUES
    ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d9', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000002',
           '10000000-0000-0000-0000-000000000001', 'admin'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000d9';
  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
    SELECT id, '30000000-0000-0000-0000-000000000003',
           '10000000-0000-0000-0000-000000000001', 'viewer'
      FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000d9';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d9', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_write_paths
    FROM app_grant_paths(true) gp WHERE gp = 'plant_1.assembly'::ltree;
  SELECT count(*) INTO v_read_paths FROM app_grant_paths(false);
  RESET ROLE;
  -- the admin grant is writable; the viewer grant is readable but not writable,
  -- so read sees two paths and write sees only the one
  IF v_write_paths = 1 AND v_read_paths = 2 THEN RAISE NOTICE 'PASS S19';
  ELSE RAISE NOTICE 'FAIL S19: admin_path_in_writable=%, readable_paths=%',
        v_write_paths, v_read_paths; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL S19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_S19;

RESET ROLE;
\echo '46_scoped_roles_test.sql: all 19 cases executed (see NOTICE output above for PASS/FAIL per case)'
ROLLBACK;
