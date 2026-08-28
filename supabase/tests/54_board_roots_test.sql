-- ============================================================================
-- 54_board_roots_test.sql — migration 0027, `visible_board_roots()`.
--
-- WHAT IT IS FOR: the board asked the server for the hardcoded path
-- `plant_1` for every user, in every session, since P1-4a. This function is
-- what lets it ask "where should I open for THIS person" instead.
--
-- ⭐⭐ THE CASE THAT DECIDES THE WHOLE DESIGN IS V3. "The roots you can see"
-- (`parent_id IS NULL`) is right for a company admin and for a site admin and
-- returns NOTHING for a supervisor, because a grant sits on a DEPARTMENT and
-- `nodes_select` gives them that department and below, never the root above
-- it. A fixture with only company admins and site admins in it passes against
-- the naive implementation and the supervisor's board ships empty.
--
-- The four shapes of person, all of whom must get a sensible answer:
--   a1  company admin                    -> every real root
--   a2  supervisor on Assembly (mid-tree) -> Assembly
--   dana admin grant on the Plant 1 root  -> Plant 1
--   quinn admin grant on the Plant 2 root -> Plant 2
-- ⭐ THE FIXTURE IS BUILT HERE, not borrowed from `dev_demo.sql`. An earlier
-- draft gated the whole file on Plant 2 existing and SKIPPED itself when it did
-- not — and `db:reset` wipes `dev_demo.sql` every single time, so in the
-- standard suite run every case would have skipped and the file would have
-- reported nothing while looking green. A test that skips itself in the normal
-- run is a test that does not exist.
--
-- Ana (a2) comes from `seed.sql` and is already a supervisor on Assembly, so
-- the case that matters most needs nothing built at all.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE v_fix (k text primary key, v uuid);

DO $$
DECLARE v_p2 uuid; v_dept uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_p2   := (create_node(NULL, 'Plant V', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_p2, 'Fabrication V', 0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO v_fix (k, v) VALUES ('p2', v_p2), ('p2_dept', v_dept);

  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c1')
    ON CONFLICT DO NOTHING;
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000c1','viewer') ON CONFLICT DO NOTHING;
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('c0000000-0000-0000-0000-000000000001', v_p2,
     '10000000-0000-0000-0000-000000000001','admin') ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

\echo 'V0: the fixture is well-formed — two sites, and a supervisor whose grant is MID-TREE'
SAVEPOINT sp_V0;
DO $$
DECLARE v_roots int; v_midtree int;
BEGIN
  SELECT count(*) INTO v_roots FROM nodes
   WHERE org_id = '10000000-0000-0000-0000-000000000001' AND parent_id IS NULL;
  -- ⭐ the property V3 depends on: a2's grant must NOT be on a root, or the
  -- naive implementation passes this file and ships an empty board.
  SELECT count(*) INTO v_midtree
    FROM profile_grants pg
    JOIN nodes n ON n.id = pg.node_id
    JOIN user_profiles up ON up.id = pg.profile_id
   WHERE up.user_id = '00000000-0000-0000-0000-0000000000a2'
     AND n.parent_id IS NOT NULL;
  IF v_roots >= 2 AND v_midtree >= 1 THEN RAISE NOTICE 'PASS V0';
  ELSE RAISE NOTICE 'FAIL V0: roots=% midtree_grants=% (want >=2, >=1)', v_roots, v_midtree; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V0;

\echo 'V1: a company admin gets every real root'
SAVEPOINT sp_V1;
DO $$
DECLARE v_tops text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_tops FROM visible_board_roots();
  RESET ROLE;
  IF v_tops = 'Plant 1, Plant V' THEN RAISE NOTICE 'PASS V1';
  ELSE RAISE NOTICE 'FAIL V1: got [%] (want "Plant 1, Plant V")', v_tops; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V1;

\echo 'V2: a site admin gets their own plant and only their own'
SAVEPOINT sp_V2;
DO $$
DECLARE v_tops text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_tops FROM visible_board_roots();
  RESET ROLE;
  IF v_tops = 'Plant V' THEN RAISE NOTICE 'PASS V2';
  ELSE RAISE NOTICE 'FAIL V2: got [%] (want "Plant V")', v_tops; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V2;

\echo 'V3 ⭐⭐: a MID-TREE supervisor gets their department, NOT nothing'
SAVEPOINT sp_V3;
DO $$
DECLARE v_tops text; v_naive int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT string_agg(name, ', ' ORDER BY name) INTO v_tops FROM visible_board_roots();
  -- ⚠️ AND THE NAIVE ANSWER, MEASURED IN THE SAME BREATH. Without this term the
  -- case cannot tell "the implementation is right" from "this person happens to
  -- hold a root grant", and the whole point of V3 is that they do not.
  SELECT count(*) INTO v_naive FROM nodes WHERE parent_id IS NULL;
  RESET ROLE;
  IF v_tops = 'Assembly' AND v_naive = 0 THEN RAISE NOTICE 'PASS V3';
  ELSE RAISE NOTICE 'FAIL V3: got [%] (want "Assembly"); parent_id IS NULL would have given % rows (want 0)',
    v_tops, v_naive; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V3;

\echo 'V4: every row it returns, the caller could have SELECTed for themselves'
SAVEPOINT sp_V4;
DO $$
DECLARE v_returned int; v_selectable int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_returned FROM visible_board_roots();
  SELECT count(*) INTO v_selectable
    FROM visible_board_roots() v JOIN nodes n ON n.id = v.id;
  RESET ROLE;
  -- The join runs under `nodes_select`, so a row the function invented would
  -- drop out of it. This is what "SECURITY INVOKER means it can never widen"
  -- looks like as an assertion rather than as a comment.
  IF v_returned > 0 AND v_returned = v_selectable THEN RAISE NOTICE 'PASS V4';
  ELSE RAISE NOTICE 'FAIL V4: returned=% selectable=% (want equal and non-zero)', v_returned, v_selectable; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V4;

\echo 'V5 ⭐: it is SECURITY INVOKER — DEFINER would silently turn it into "the real roots of the org"'
SAVEPOINT sp_V5;
DO $$
DECLARE v_secdef boolean;
BEGIN
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'visible_board_roots';
  IF v_secdef IS FALSE THEN RAISE NOTICE 'PASS V5';
  ELSE RAISE NOTICE 'FAIL V5: prosecdef=% (want false — DEFINER makes V2 and V3 leak)', v_secdef; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V5;

\echo 'V6: an ACTIVE top sorts before an inactive one, so "the first row" is never a dead site'
SAVEPOINT sp_V6;
DO $$
DECLARE v_first text; v_count int;
BEGIN
  UPDATE nodes SET active = false WHERE parent_id IS NULL AND name = 'Plant 1';
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT name INTO v_first FROM visible_board_roots() LIMIT 1;
  SELECT count(*) INTO v_count FROM visible_board_roots();
  RESET ROLE;
  -- ⚠️ BOTH HALVES. The deactivated plant must sort DOWN, and must still be
  -- RETURNED — someone whose only site is deactivated needs a board that opens
  -- and explains itself, not an empty list.
  IF v_first = 'Plant V' AND v_count = 2 THEN RAISE NOTICE 'PASS V6';
  ELSE RAISE NOTICE 'FAIL V6: first=[%] count=% (want "Plant V", 2)', v_first, v_count; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V6;

\echo 'V7: it never returns another tenant''s root'
SAVEPOINT sp_V7;
DO $$
DECLARE v_foreign int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_foreign
    FROM visible_board_roots() v JOIN nodes n ON n.id = v.id
   WHERE n.org_id <> '10000000-0000-0000-0000-000000000001';
  RESET ROLE;
  IF v_foreign = 0 THEN RAISE NOTICE 'PASS V7';
  ELSE RAISE NOTICE 'FAIL V7: % foreign root(s) returned', v_foreign; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V7;

\echo 'V8: a person with no grants at all gets an EMPTY list — the client must have a screen for it'
SAVEPOINT sp_V8;
DO $$
DECLARE v_n int;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000b9')
    ON CONFLICT DO NOTHING;
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('b9000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000b9','viewer') ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b9', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM visible_board_roots();
  RESET ROLE;
  -- Not a failure of the function: an org-wide viewer with no grant genuinely
  -- has nowhere to open. It is pinned so the CLIENT's empty state is a
  -- deliberate screen and not a crash on `roots[0].path`.
  IF v_n = 0 THEN RAISE NOTICE 'PASS V8';
  ELSE RAISE NOTICE 'FAIL V8: a grantless viewer got % top(s)', v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V8;

\echo 'V9 ⭐: the org term is NOT redundant — it is the only guard left when RLS is bypassed'
SAVEPOINT sp_V9;
DO $$
DECLARE v_all int; v_mine int;
BEGIN
  -- ⚠️ WHY THIS CASE EXISTS. Deleting `org_id = app_current_org()` from the
  -- function was mutation P3, and it came back NOT CAUGHT: `nodes_select`
  -- carries the same term, the function is SECURITY INVOKER, so under RLS the
  -- policy refuses another tenant first and the function's own term never
  -- decides anything. A guard that cannot be mutation-tested is a guard nobody
  -- is testing (rule 7d).
  --
  -- It is not redundant, though: `service_role` has BYPASSRLS, so anything
  -- calling this from the server side gets NO policy at all, and the org term
  -- becomes the only thing standing between one tenant and another. So rather
  -- than delete it, this case makes it LIVE — and P3 goes from NOT CAUGHT to
  -- caught here.
  -- No SET ROLE: this file's own session is the table owner, which bypasses RLS
  -- the same way `service_role` does and needs no grants to exist. `v_all`
  -- proves the bypass is real before `v_mine` is believed.
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
  SELECT count(*) INTO v_all  FROM nodes WHERE parent_id IS NULL;
  SELECT count(*) INTO v_mine FROM visible_board_roots();
  IF v_all > v_mine AND v_mine = 2 THEN RAISE NOTICE 'PASS V9';
  ELSE RAISE NOTICE 'FAIL V9: with RLS bypassed the org has % roots and the function returned % (want fewer, and exactly 2 for org 1)',
    v_all, v_mine; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_V9;

ROLLBACK;
