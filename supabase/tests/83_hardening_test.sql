-- ============================================================================
-- 83_hardening_test.sql --- migration 0060, the three rough edges.
--
-- The server halves of the three standing-note items:
--
--   sec.1  a DIRECT PostgREST DELETE on profile_grants now gets the same answer
--          remove_site_member gives: a site admin may not delete a company
--          admin's grant (X50-X54). This is the close of case X46 in
--          49_company_admin_rows_test.sql, which is flipped in that file from
--          "asserts the gap" to "asserts the close".
--   sec.2  site_people takes an optional p_search and p_limit and reports a
--          total, so the list can be bounded without a colleague vanishing
--          silently, and a p_node_id-only call is unchanged (X55-X58).
--   sec.3  is a finding, not a build (0060 §3): a legacy department admin is
--          moot after R-340 and still sees their department on the board. There
--          is nothing new to measure, so no case --- X59 only re-confirms the
--          premise that there are no below-root admin grants to strand.
--
-- ⚠️ EVERY CASE THAT MEASURES A REFUSAL RUNS AS `authenticated`. The functions
-- are SECURITY INVOKER (the trigger) or read app_current_org (site_people);
-- psql connects as the superuser, who bypasses RLS and the owner-gated trigger
-- and whose app_current_org() is NULL. So each case sets request.jwt.claim.sub
-- and SET LOCAL ROLE authenticated, the way 49 and 81 do.
--
-- FIXTURE (org 1, on top of the seed; f-series exactly as 49 builds them):
--   f1  org-wide VIEWER, admin grant on Plant 1   -- the site admin, "Dana"
--   f2  org-wide ADMIN,  no grant anywhere        -- a second company admin
-- The seed supplies a1 (org-wide admin WITH an admin grant on Plant 1),
-- a2 (supervisor on Assembly) and a3 (supervisor on Machining).
--
-- X50   the fixture is what the rest of the file assumes
-- X51 ⭐ a site admin's DIRECT DELETE of a company admin's grant is refused by
--       the table, typed reason company_admin, and the row survives
-- X52   ...and it does NOT over-reach: the same site admin's DIRECT DELETE of
--       an ordinary person's grant succeeds, the row is gone
-- X53   two company admins are peers: a company admin's DIRECT DELETE of the
--       other company admin's grant succeeds
-- X54   the trigger does not break remove_site_member: the RPC still removes an
--       ordinary person for the site admin
-- X55   site_people(node) with no other argument is unchanged: returned=total,
--       people is an array, nodeName is Plant 1
-- X56 ⭐ site_people(node, null, 2) caps at 2 rows, total is the full count, and
--       returned < total so the cap is observable
-- X57   site_people(node, 'sitef1', null) filters by email to exactly that one
-- X58   grants on the re-emitted site_people: authenticated yes, public/anon no
-- X59   the §3 premise: no below-root admin grant exists to be stranded
-- X60 ⭐ a site admin's direct UPDATE demoting a company admin's grant
--       (admin -> viewer) is refused, and the role is unchanged
-- X61 ⭐ a site admin's direct UPDATE re-pointing a company admin's grant's
--       profile_id is refused, and the grant still belongs to the company admin
-- X62   ...and it does NOT over-reach: the same site admin's direct UPDATE of an
--       ordinary person's grant role succeeds
-- X63   two company admins are peers: a company admin's direct UPDATE of the
--       other's grant succeeds
-- X64   the NEW side: a site admin re-pointing an ordinary grant ONTO a company
--       admin is refused too (mirrors set_site_member guarding the target)
-- ============================================================================

BEGIN;

DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000f1', 'sitef1@example.test'),
    ('00000000-0000-0000-0000-0000000000f2', 'bossf2@example.test');

  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f1','viewer'),
    ('f0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f2','admin');

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001','admin');
END $$;

\echo 'X50: the fixture is what the rest of this file assumes'
SAVEPOINT sp_X50;
RESET ROLE;
DO $$
DECLARE v_f1 text; v_f2 text; v_f2_grants int; v_a1_grant text; v_a2_grant text;
BEGIN
  SELECT role INTO v_f1 FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT role INTO v_f2 FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO v_f2_grants FROM profile_grants
   WHERE profile_id = 'f0000000-0000-0000-0000-000000000002';
  SELECT role INTO v_a1_grant FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  SELECT role INTO v_a2_grant FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_f1 = 'viewer' AND v_f2 = 'admin' AND v_f2_grants = 0
     AND v_a1_grant = 'admin' AND v_a2_grant = 'supervisor'
  THEN RAISE NOTICE 'PASS X50';
  ELSE RAISE NOTICE 'FAIL X50: f1=% f2=% f2_grants=% a1_grant=% a2_grant=%',
       v_f1, v_f2, v_f2_grants, v_a1_grant, v_a2_grant;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X50: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X50;

\echo 'X51 ⭐: a site admin''s DIRECT DELETE of a company admin''s grant is refused, and the row survives'
SAVEPOINT sp_X51;
DO $$
DECLARE v_raw text; v_detail jsonb; v_left int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    DELETE FROM profile_grants
     WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
       AND node_id    = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- Read the row back as the owner: a refused DELETE that half-worked cannot
  -- hide behind an unreadable row (48's X28, 0022's reasoning).
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'company_admin' AND v_left = 1
  THEN RAISE NOTICE 'PASS X51';
  ELSE RAISE NOTICE 'FAIL X51: detail=% rows_left=% (want 1)', v_detail, v_left; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X51;

\echo 'X52: the trigger does NOT over-reach -- a site admin''s DIRECT DELETE of an ordinary person''s grant succeeds'
SAVEPOINT sp_X52;
DO $$
DECLARE v_left int;
BEGIN
  -- a2 (Ana) is a supervisor granted Assembly, which sits under Plant 1, so f1
  -- administers it. Refusing everybody would pass X51 and break the feature.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  RESET ROLE;
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_left = 0 THEN RAISE NOTICE 'PASS X52';
  ELSE RAISE NOTICE 'FAIL X52: rows_left=% (want 0)', v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X52: the trigger refused an ordinary person: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X52;

\echo 'X53: two company admins are peers -- a company admin''s DIRECT DELETE of the other''s grant succeeds'
SAVEPOINT sp_X53;
DO $$
DECLARE v_left int;
BEGIN
  -- f2 is an org-wide admin, so app_is_admin() is true and NOT app_is_admin()
  -- -- the whole trigger condition -- is false.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  RESET ROLE;
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_left = 0 THEN RAISE NOTICE 'PASS X53';
  ELSE RAISE NOTICE 'FAIL X53: rows_left=% (want 0)', v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X53: a company admin was refused: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X53;

\echo 'X54: the trigger does not break the RPC -- remove_site_member still removes an ordinary person'
SAVEPOINT sp_X54;
DO $$
DECLARE v_left int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM remove_site_member('30000000-0000-0000-0000-000000000002',
                             'a0000000-0000-0000-0000-000000000002');
  RESET ROLE;
  SELECT count(*) INTO v_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_left = 0 THEN RAISE NOTICE 'PASS X54';
  ELSE RAISE NOTICE 'FAIL X54: rows_left=% (want 0)', v_left; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X54: the RPC was refused: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X54;

\echo 'X55: site_people(node) with no other argument is unchanged -- returned=total, people is an array'
SAVEPOINT sp_X55;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_arr int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001');
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  v_arr      := jsonb_array_length(v->'people');
  IF v_total >= 3 AND v_returned = v_total AND v_arr = v_returned
     AND v->>'nodeName' = 'Plant 1'
  THEN RAISE NOTICE 'PASS X55 (total=%)', v_total;
  ELSE RAISE NOTICE 'FAIL X55: total=% returned=% arr=% nodeName=%',
       v_total, v_returned, v_arr, v->>'nodeName'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X55: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X55;

\echo 'X56 ⭐: site_people(node, null, 2) caps at 2, total is the full count, returned < total'
SAVEPOINT sp_X56;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_arr int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001', NULL, 2);
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  v_arr      := jsonb_array_length(v->'people');
  -- total counts BEFORE the limit, so a client can see the list was capped.
  IF v_returned = 2 AND v_arr = 2 AND v_total >= 3 AND v_returned < v_total
  THEN RAISE NOTICE 'PASS X56 (returned=2 total=%)', v_total;
  ELSE RAISE NOTICE 'FAIL X56: returned=% arr=% total=%', v_returned, v_arr, v_total; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X56: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X56;

\echo 'X57: site_people(node, ''sitef1'', null) filters by email to exactly that one person'
SAVEPOINT sp_X57;
DO $$
DECLARE v jsonb; v_total int; v_returned int; v_email text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v := site_people('30000000-0000-0000-0000-000000000001', 'sitef1', NULL);
  RESET ROLE;
  v_total    := (v->>'total')::int;
  v_returned := (v->>'returned')::int;
  SELECT (v->'people'->0)->>'email' INTO v_email;
  IF v_total = 1 AND v_returned = 1 AND v_email = 'sitef1@example.test'
  THEN RAISE NOTICE 'PASS X57';
  ELSE RAISE NOTICE 'FAIL X57: total=% returned=% email=%', v_total, v_returned, v_email; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X57: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X57;

\echo 'X58: EXECUTE on the re-emitted site_people is authenticated only'
SAVEPOINT sp_X58;
RESET ROLE;
DO $$
DECLARE v_oid oid; v_bad text := '';
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'site_people'
     AND pg_get_function_identity_arguments(p.oid) = 'p_node_id uuid, p_search text, p_limit integer';
  IF v_oid IS NULL THEN
    RAISE NOTICE 'FAIL X58: the 3-argument function does not exist'; RETURN;
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'PUBLIC; '; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'not authenticated; '; END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN v_bad := v_bad || 'anon; '; END IF;
  IF v_bad = '' THEN RAISE NOTICE 'PASS X58';
  ELSE RAISE NOTICE 'FAIL X58: %', v_bad; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X58: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X58;

\echo 'X59: the §3 premise -- no below-root admin grant exists to be stranded (R-340)'
SAVEPOINT sp_X59;
RESET ROLE;
DO $$
DECLARE v_below int;
BEGIN
  SELECT count(*) INTO v_below
    FROM profile_grants pg
    JOIN nodes n ON n.id = pg.node_id
   WHERE pg.role = 'admin' AND n.parent_id IS NOT NULL;
  IF v_below = 0 THEN RAISE NOTICE 'PASS X59';
  ELSE RAISE NOTICE 'FAIL X59: % below-root admin grant(s) exist -- §3 is not moot, re-open it', v_below; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X59: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X59;

\echo 'X60 ⭐: a site admin''s direct UPDATE demoting a company admin''s grant is refused, role unchanged'
SAVEPOINT sp_X60;
DO $$
DECLARE v_raw text; v_detail jsonb; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE profile_grants SET role = 'viewer'
     WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
       AND node_id    = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'company_admin' AND v_role = 'admin'
  THEN RAISE NOTICE 'PASS X60';
  ELSE RAISE NOTICE 'FAIL X60: detail=% role_now=% (want admin)', v_detail, v_role; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X60;

\echo 'X61 ⭐: a site admin''s direct UPDATE re-pointing a company admin''s grant is refused'
SAVEPOINT sp_X61;
DO $$
DECLARE v_raw text; v_detail jsonb; v_owner_left int; v_a2_admin int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE profile_grants SET profile_id = 'a0000000-0000-0000-0000-000000000002'
     WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
       AND node_id    = '30000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  -- The grant still belongs to the company admin, and a2 did NOT gain admin.
  SELECT count(*) INTO v_owner_left FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001' AND role = 'admin';
  SELECT count(*) INTO v_a2_admin FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_detail->>'reason' = 'company_admin' AND v_owner_left = 1 AND v_a2_admin = 0
  THEN RAISE NOTICE 'PASS X61';
  ELSE RAISE NOTICE 'FAIL X61: detail=% owner_left=% a2_on_plant1=%', v_detail, v_owner_left, v_a2_admin; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X61;

\echo 'X62: no over-reach -- a site admin''s direct UPDATE of an ordinary person''s grant role succeeds'
SAVEPOINT sp_X62;
DO $$
DECLARE v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  UPDATE profile_grants SET role = 'viewer'
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS X62';
  ELSE RAISE NOTICE 'FAIL X62: role=% (want viewer)', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X62: the trigger refused an ordinary person: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X62;

\echo 'X63: two company admins are peers -- a company admin''s direct UPDATE of the other''s grant succeeds'
SAVEPOINT sp_X63;
DO $$
DECLARE v_role text;
BEGIN
  -- f2 is an org-wide admin; app_is_admin() is true so the guard passes it.
  -- Demote to viewer, which the admin-at-root trigger also allows (not admin).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  UPDATE profile_grants SET role = 'viewer'
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  RESET ROLE;
  SELECT role INTO v_role FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  IF v_role = 'viewer' THEN RAISE NOTICE 'PASS X63';
  ELSE RAISE NOTICE 'FAIL X63: role=% (want viewer)', v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X63: a company admin was refused: % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X63;

\echo 'X64: the NEW side -- a site admin re-pointing an ordinary grant ONTO a company admin is refused'
SAVEPOINT sp_X64;
DO $$
DECLARE v_raw text; v_detail jsonb; v_a1_on_assembly int;
BEGIN
  -- a2's supervisor grant sits on Assembly (under Plant 1, so f1 administers
  -- it). Re-pointing profile_id a2 -> a1 would hand the company admin a grant.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE profile_grants SET profile_id = 'a0000000-0000-0000-0000-000000000001'
     WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
       AND node_id    = '30000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_a1_on_assembly FROM profile_grants
   WHERE profile_id = 'a0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000002';
  IF v_detail->>'reason' = 'company_admin' AND v_a1_on_assembly = 0
  THEN RAISE NOTICE 'PASS X64';
  ELSE RAISE NOTICE 'FAIL X64: detail=% a1_on_assembly=% (want 0)', v_detail, v_a1_on_assembly; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X64;

ROLLBACK;

\echo '83_hardening_test.sql complete (15 cases: X50-X64)'
