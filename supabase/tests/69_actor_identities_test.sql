-- ============================================================================
-- 69_actor_identities_test.sql — migration 0046, "the Activity screen's Who
-- column can name a person."
--
-- THE DECISION: *"the who needs to show a user, it is currently not that
-- helpful."* The only identity this system stores is an EMAIL, and it lives in
-- `auth.users`, which PostgREST does not expose. 0046 opens exactly one door
-- onto it: `audit_actor_identities()`.
--
-- ⛔⛔ WHAT THIS FILE IS REALLY FOR, AND IT IS NOT THE HAPPY PATH. A function
-- that hands out email addresses is a DISCLOSURE, and the screen it serves is
-- narrower than the table it reads: `audit_log_select` is
--
--     app_is_admin() and org_id = app_current_org()
--
-- so the door must be exactly that wide and not one person wider. Two ways to
-- get it wrong, and this file exists to catch both:
--
--   * TOO WIDE ACROSS ROLES — a SITE admin (org-wide `viewer` plus an admin
--     GRANT) reads no audit rows at all, so they must read no addresses either.
--   * TOO WIDE ACROSS TENANTS — a company admin in org 1 must never see an
--     address belonging to org 2. This is the one that matters most, because
--     `auth.users` has no org column of its own; the scoping is entirely the
--     `user_profiles` join and one `app_current_org()`.
--
-- ⛔ AND THE TRAP THE BRIEF NAMES: **a refusal and an empty table look
-- identical.** A function that was simply broken — that returned nothing to
-- everybody, always — would sail through "the site admin gets none" and
-- "org 2's addresses are absent" and prove precisely nothing. So:
--
--   * E1 and E5 are POSITIVE: two DIFFERENT company admins, in two different
--     orgs, each get a NON-EMPTY set, and each set is checked to EQUAL that
--     admin's own org's profiles — not merely to be non-empty, and not merely
--     to exclude the other org. If the org filter were dropped, E1 and E5 both
--     see five-plus rows and both fail on the set comparison.
--   * E3 and E4 assert a TYPED REFUSAL (`not_permitted`, PT403), which no
--     always-empty function can produce. "You got nothing" and "you were told
--     no" are different observations here, deliberately, so that the gate is
--     provable from outside rather than inferable.
--
-- ⚠️ RUN AS `authenticated` WITH A JWT CLAIM, NOT AS THE OWNER. The opposite
-- discipline to 68: there, triggers were under test and the table owner was the
-- honest driver. Here the GATE is under test, and the gate is
-- `app_is_admin()` / `app_current_org()`, both of which read the acting
-- profile. Driven as the owner every case would pass for the wrong reason.
--
-- Everything is inside one BEGIN/ROLLBACK, each case savepointed.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The fixture. Three additions to what the seed already supplies.
--
-- The seed gives org 1 a1 (org-wide ADMIN, admin grant on Plant 1),
-- a2/a3 (supervisors) and org 2 b1 (org-wide ADMIN) and b2 (supervisor), each
-- with an address. Added here:
--
--   f1  org 1, org-wide VIEWER + admin GRANT on Plant 1  -- "the site admin"
--   f3  org 1, supervisor whose auth.users row has a NULL email
--
-- ⭐ f1 MUST BE AN ORG-WIDE VIEWER. If it were an `admin` row `app_is_admin()`
-- short-circuits true and E3 passes against a function with no gate at all —
-- 46's lesson, and 47's, and 49's.
--
-- ⭐ f3 IS NOT DECORATION EITHER. `auth.users.email` is nullable (a phone-only
-- signup has none), and the client's `ActorIdentity.email` is `string | null`
-- because of it. A function that filtered `email IS NOT NULL` — the obvious
-- tidying-up — or a client guard that required a string would DROP this person,
-- and a missing row in a map is indistinguishable from an actor who is not in
-- this company at all, so the screen would go quietly back to "Supervisor ·
-- 0000b2" for somebody it can at least name the role of. E6 is the case that
-- notices; it was measured against that exact sabotage and went red.
--
-- ⚠️ WHAT f3 DOES *NOT* PIN, said out loud so nobody reads more into it than is
-- there: `user_profiles.user_id` is NOT NULL with an FK to `auth.users`
-- (ON DELETE CASCADE), so a profile with no auth row is unreachable on this
-- schema and an INNER join would pass every case in this file. The LEFT join in
-- 0046 is defensive, matching `site_people`; the NULLABLE thing that is really
-- there, and really tested, is the ADDRESS.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-0000-0000-0000000000f1', 'sitef1@example.test'),
    ('00000000-0000-0000-0000-0000000000f3', NULL);

  INSERT INTO user_profiles (id, org_id, user_id, role, display_name) VALUES
    ('f0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f1', 'viewer', 'Fiona Site'),
    -- ⭐ f3 CARRIES NEITHER A NAME NOR AN ADDRESS, deliberately: the doubly-null
    -- person is the one the client's fallback ladder has to reach the bottom of.
    ('f0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000f3', 'supervisor', NULL);

  -- ⭐ ORG 2 GETS A NAME TOO, and E11 is the reason. A tenant boundary proved
  -- only on addresses would say nothing about the column added beside them; a
  -- `display_name` selected outside the `app_current_org()` filter would leak
  -- exactly as an address would, and would leak something friendlier to read.
  UPDATE user_profiles SET display_name = 'Bruno Two'
   WHERE id = 'a000000b-0000-0000-0000-000000000001';

  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001', 'admin');
END $$;

\echo 'E0 GUARD: the fixture is the world these cases describe'
SAVEPOINT sp_E0;
DO $$
DECLARE v_f1 text; v_f1_grant text; v_f3_email text; v_a1 text; v_b1 text; v_org2 int;
        v_f1_name text; v_f3_name text; v_b1_name text;
BEGIN
  SELECT role INTO v_f1 FROM user_profiles WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT role INTO v_f1_grant FROM profile_grants
   WHERE profile_id = 'f0000000-0000-0000-0000-000000000001'
     AND node_id    = '30000000-0000-0000-0000-000000000001';
  SELECT u.email INTO v_f3_email FROM auth.users u
   WHERE u.id = '00000000-0000-0000-0000-0000000000f3';
  SELECT role INTO v_a1 FROM user_profiles WHERE id = 'a0000000-0000-0000-0000-000000000001';
  SELECT role INTO v_b1 FROM user_profiles WHERE id = 'a000000b-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_org2 FROM user_profiles
   WHERE org_id = '10000000-0000-0000-0000-000000000002';
  SELECT display_name INTO v_f1_name FROM user_profiles
   WHERE id = 'f0000000-0000-0000-0000-000000000001';
  SELECT display_name INTO v_f3_name FROM user_profiles
   WHERE id = 'f0000000-0000-0000-0000-000000000003';
  SELECT display_name INTO v_b1_name FROM user_profiles
   WHERE id = 'a000000b-0000-0000-0000-000000000001';

  -- f1 is a SITE admin: viewer org-wide, admin on the plant. a1 and b1 are the
  -- two company admins the positive cases are driven as. Org 2 has people, or
  -- E5 would be asserting an empty set equals an empty set.
  -- The name half of the fixture: f1 HAS one, f3 has none, and org 2 holds a
  -- name for the boundary case to look for. All three are read back rather
  -- than assumed, because a fixture that silently failed to set a column would
  -- make E9 and E11 pass by describing a world that is not there.
  IF v_f1 = 'viewer' AND v_f1_grant = 'admin' AND v_f3_email IS NULL
     AND v_a1 = 'admin' AND v_b1 = 'admin' AND v_org2 > 0
     AND v_f1_name IS NOT NULL AND v_f3_name IS NULL AND v_b1_name IS NOT NULL
  THEN RAISE NOTICE 'PASS E0';
  ELSE RAISE NOTICE 'FAIL E0: f1=% (want viewer), f1_grant=% (want admin), f3_email=% (want NULL), a1=% b1=% org2_profiles=% f1_name=% (want a name) f3_name=% (want NULL) b1_name=% (want a name)',
       v_f1, v_f1_grant, v_f3_email, v_a1, v_b1, v_org2, v_f1_name, v_f3_name, v_b1_name; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL E0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E0;

-- ---------------------------------------------------------------------------
-- ⚠️ NO ADDRESS IS TYPED OUT ANYWHERE BELOW, AND THE FIRST DRAFT OF THIS FILE
-- PROVED WHY. It asked for `admin@northwind.example`, which is what the seed's
-- `INSERT INTO auth.users` creates — and then failed, because a LATER block in
-- the same seed (the GoTrue dev-login fix, Aug 22) UPDATEs those three rows to
-- `*@example.test` so the local sign-in works. Two spellings of the same fact,
-- a hundred and eighty lines apart, and the test believed the wrong one.
--
-- So every expectation is READ FROM THE DATABASE (CLAUDE.md s4, "extract, never
-- retype"). It also makes the leak checks strictly stronger: they ask "none of
-- the OTHER org's addresses, whatever they happen to be" rather than "not these
-- two strings", which is the question that actually matters and the one that
-- keeps working when somebody adds a third person to org 2.
-- ---------------------------------------------------------------------------

\echo 'E1 the company admin gets EXACTLY their own org''s people, with addresses'
SAVEPOINT sp_E1;
DO $$
DECLARE v_got uuid[]; v_want uuid[]; v_admin_email text; v_want_email text; v_n int;
BEGIN
  SELECT array_agg(user_id ORDER BY user_id) INTO v_want FROM user_profiles
   WHERE org_id = '10000000-0000-0000-0000-000000000001';
  SELECT email INTO v_want_email FROM auth.users
   WHERE id = '00000000-0000-0000-0000-0000000000a1';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(user_id ORDER BY user_id), count(*)
    INTO v_got, v_n FROM audit_actor_identities();
  SELECT email INTO v_admin_email FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  RESET ROLE;

  -- ⚠️ SET EQUALITY, NOT "more than zero". A function that ignored
  -- app_current_org() would return org 2's people as well and this comparison
  -- is the thing that notices; a count-only check would too, but only by
  -- accident of the two orgs having different sizes.
  IF v_got = v_want AND v_n > 0
     AND v_want_email IS NOT NULL AND v_admin_email = v_want_email
  THEN RAISE NOTICE 'PASS E1';
  ELSE RAISE NOTICE 'FAIL E1: n=% admin_email=% (want %) got=% want=%',
       v_n, v_admin_email, v_want_email, v_got, v_want; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E1;

\echo 'E2 ⛔ THE TENANT BOUNDARY: org 1''s admin sees NONE of org 2''s addresses'
SAVEPOINT sp_E2;
DO $$
DECLARE v_seen text[]; v_leaked int; v_own int; v_own_want int;
BEGIN
  -- ⚠️ THE ADDRESSES ARE CARRIED OUT OF THE `authenticated` BLOCK IN AN ARRAY
  -- and compared afterwards as the owner. Reading a temp table while the role
  -- is switched fails on grants, and a failure there would be reported as a
  -- refusal by the function under test — a red for the wrong reason.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(a.email) INTO v_seen FROM audit_actor_identities() a WHERE a.email IS NOT NULL;
  RESET ROLE;

  -- Every address belonging to the OTHER org, whatever it happens to be.
  SELECT count(*) INTO v_leaked FROM user_profiles up
    JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = '10000000-0000-0000-0000-000000000002'
     AND u.email = ANY (coalesce(v_seen, ARRAY[]::text[]));
  -- ...against how many of the caller's own org's people have one at all.
  SELECT count(*) INTO v_own_want FROM user_profiles up
    JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = '10000000-0000-0000-0000-000000000001' AND u.email IS NOT NULL;
  v_own := coalesce(array_length(v_seen, 1), 0);

  -- ⚠️ v_own IS HALF THE CASE. Zero leaked rows means nothing on its own — a
  -- function that returned nothing at all would score zero here too. The second
  -- count says the call WORKED, returned every address it should have, and
  -- still declined to cross the boundary.
  IF v_leaked = 0 AND v_own_want > 0 AND v_own = v_own_want
  THEN RAISE NOTICE 'PASS E2';
  ELSE RAISE NOTICE 'FAIL E2: other_org_addresses=% (want 0), own_addresses=% (want %)',
       v_leaked, v_own, v_own_want; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E2;

\echo 'E3 ⭐ a SITE admin is REFUSED — a typed no, not an empty list'
SAVEPOINT sp_E3;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text := 'none'; v_n int := -1;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO v_n FROM audit_actor_identities();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;

  -- PT403 is api_raise's code for `not_permitted`. Asserting the CODE as well
  -- as the payload is what makes this case impossible to pass by accident: an
  -- always-empty function leaves v_state = 'none' and v_n = 0.
  IF v_detail->>'error' = 'not_permitted' AND v_detail->>'reason' = 'not_company_admin'
     AND v_state = 'PT403' AND v_n = -1
  THEN RAISE NOTICE 'PASS E3';
  ELSE RAISE NOTICE 'FAIL E3: detail=% sqlstate=% rows=% (wanted a refusal, not a count)',
       v_detail, v_state, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_E3;

\echo 'E4 an ordinary supervisor is refused the same way'
SAVEPOINT sp_E4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text := 'none'; v_n int := -1;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO v_n FROM audit_actor_identities();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'not_permitted' AND v_state = 'PT403' AND v_n = -1
  THEN RAISE NOTICE 'PASS E4';
  ELSE RAISE NOTICE 'FAIL E4: detail=% sqlstate=% rows=%', v_detail, v_state, v_n; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_E4;

\echo 'E5 ⛔ THE MIRROR: org 2''s admin gets org 2''s people and NONE of org 1''s'
SAVEPOINT sp_E5;
DO $$
DECLARE v_got uuid[]; v_want uuid[]; v_seen text[]; v_leaked int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(user_id ORDER BY user_id) INTO v_got FROM audit_actor_identities();
  SELECT array_agg(a.email) INTO v_seen FROM audit_actor_identities() a WHERE a.email IS NOT NULL;
  RESET ROLE;

  SELECT array_agg(user_id ORDER BY user_id) INTO v_want FROM user_profiles
   WHERE org_id = '10000000-0000-0000-0000-000000000002';
  -- Org 1's addresses, read from the database rather than typed (see above).
  SELECT count(*) INTO v_leaked FROM user_profiles up
    JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = '10000000-0000-0000-0000-000000000001'
     AND u.email = ANY (coalesce(v_seen, ARRAY[]::text[]));

  -- ⭐ THE CASE A HARDCODED ORG WOULD FAIL. E1 and E2 alone are satisfied by a
  -- function that always answers "org 1"; this one is driven by a different
  -- admin and must come back with a different, non-empty answer.
  IF v_got = v_want AND array_length(v_got, 1) > 0 AND v_leaked = 0
  THEN RAISE NOTICE 'PASS E5';
  ELSE RAISE NOTICE 'FAIL E5: got=% want=% org1_addresses=% (want 0)', v_got, v_want, v_leaked; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E5;

\echo 'E6 a person with no address is still LISTED, with email NULL'
SAVEPOINT sp_E6;
DO $$
DECLARE v_rows int; v_email text; v_role text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f3';
  SELECT email, role INTO v_email, v_role FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f3';
  RESET ROLE;

  -- The row must be PRESENT and its email NULL. Dropping it would be worse
  -- than useless: the client can still say "Supervisor", and a missing key in
  -- the map cannot be told from an actor who left the company.
  IF v_rows = 1 AND v_email IS NULL AND v_role = 'supervisor'
  THEN RAISE NOTICE 'PASS E6';
  ELSE RAISE NOTICE 'FAIL E6: rows=% (want 1) email=% (want NULL) role=%', v_rows, v_email, v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E6;

\echo 'E7 the role carried is the ORG-WIDE role, which is what the gate is spelled in'
SAVEPOINT sp_E7;
DO $$
DECLARE v_f1 text; v_a1 text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT role INTO v_f1 FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f1';
  SELECT role INTO v_a1 FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  RESET ROLE;

  -- f1 holds an admin GRANT on Plant 1 and is a `viewer` org-wide. The column
  -- reports `viewer`, the same value `fetchAuditActors` used to return, so the
  -- screen's existing fallback label does not change meaning under it.
  IF v_f1 = 'viewer' AND v_a1 = 'admin'
  THEN RAISE NOTICE 'PASS E7';
  ELSE RAISE NOTICE 'FAIL E7: site_admin_role=% (want viewer), company_admin_role=% (want admin)', v_f1, v_a1; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E7;

\echo 'E8 the grants: authenticated may call it, anon and PUBLIC may not'
SAVEPOINT sp_E8;
DO $$
DECLARE v_auth boolean; v_anon boolean; v_pub boolean; v_secdef boolean; v_path text[];
BEGIN
  v_auth := has_function_privilege('authenticated', 'audit_actor_identities()', 'EXECUTE');
  v_anon := has_function_privilege('anon',          'audit_actor_identities()', 'EXECUTE');
  -- `public` is the pseudo-role PostgreSQL grants EXECUTE to by default; the
  -- REVOKE in the migration is the only reason this is false (api.md §6.2).
  v_pub  := has_function_privilege('public',        'audit_actor_identities()', 'EXECUTE');
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_actor_identities';

  -- SECURITY DEFINER with a pinned search_path is the whole reason it can read
  -- `auth.users` at all; an unpinned one is a hijack waiting for a schema.
  IF v_auth AND NOT v_anon AND NOT v_pub AND v_secdef
     AND v_path @> ARRAY['search_path=public, pg_temp']
  THEN RAISE NOTICE 'PASS E8';
  ELSE RAISE NOTICE 'FAIL E8: authenticated=% anon=% public=% secdef=% config=%',
       v_auth, v_anon, v_pub, v_secdef, v_path; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL E8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E8;

-- ===========================================================================
-- THE NAME (migration 0047). `user_profiles.display_name`, the first place in
-- this schema a person's own name can be stored, returned as a fourth column
-- of the same function under the same gate.
--
-- THE REWRITE IS THE RISK, AND E1-E5 ARE WHAT MEASURE IT. Adding the column
-- meant touching the SELECT list one line above
-- `WHERE up.org_id = app_current_org()`, which is the entire tenant boundary on
-- `auth.users`; every case above is re-run against the rewritten function and
-- is what says the gate and the boundary survived. E11 then asks the boundary
-- question again about the NEW column specifically, because a leak of names is
-- a leak, and a friendlier-reading one than a leak of addresses.
--
-- NOTHING WRITES THIS COLUMN YET AND THESE CASES DO NOT PRETEND OTHERWISE.
-- The fixture sets it directly as the table owner. `user_profiles_update` is
-- `app_is_admin() AND org_id = app_current_org()`, so on the running product a
-- company admin could set anybody's name and nobody could set their own -- an
-- asymmetry that is the maintainer's to resolve, not this file's to assume.
-- ===========================================================================

\echo 'E9 a profile WITH a name returns it, beside the role and the address'
SAVEPOINT sp_E9;
DO $$
DECLARE v_want text; v_got text; v_email text; v_role text;
BEGIN
  -- Read, never retyped: the same discipline as the addresses above, and for
  -- the same reason -- a literal here would pin the fixture, not the function.
  SELECT display_name INTO v_want FROM user_profiles
   WHERE id = 'f0000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT display_name, email, role INTO v_got, v_email, v_role
    FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f1';
  RESET ROLE;

  -- THE OTHER THREE COLUMNS ARE ASSERTED TOO. The name is an ADDITION, and a
  -- function that returned the name while dropping the address would satisfy a
  -- name-only case while breaking every actor the client still falls back on.
  IF v_want IS NOT NULL AND v_got = v_want AND v_email IS NOT NULL AND v_role = 'viewer'
  THEN RAISE NOTICE 'PASS E9';
  ELSE RAISE NOTICE 'FAIL E9: display_name=% (want %) email=% (want an address) role=% (want viewer)',
       v_got, v_want, v_email, v_role; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E9;

\echo 'E10 a profile with NO name is still LISTED, with display_name NULL'
SAVEPOINT sp_E10;
DO $$
DECLARE v_rows int; v_name text; v_email text; v_role text; v_unnamed int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f3';
  SELECT display_name, email, role INTO v_name, v_email, v_role
    FROM audit_actor_identities()
   WHERE user_id = '00000000-0000-0000-0000-0000000000f3';
  -- The column is nullable and WILL BE NULL ON ALMOST EVERY ROW for a long
  -- time, because nothing writes it yet. "Most of the company is unnamed" is
  -- the ordinary state here, not an edge, and the function must be
  -- uninterested in it.
  SELECT count(*) INTO v_unnamed FROM audit_actor_identities() WHERE display_name IS NULL;
  RESET ROLE;

  -- E6's argument, one column further along: filtering to the named people
  -- would be the obvious tidying-up and would be the same mistake. A missing
  -- key in the client's map is indistinguishable from an actor who is not in
  -- this company at all, so a nameless person must arrive nameless rather than
  -- not arrive.
  IF v_rows = 1 AND v_name IS NULL AND v_email IS NULL AND v_role = 'supervisor'
     AND v_unnamed > 0
  THEN RAISE NOTICE 'PASS E10';
  ELSE RAISE NOTICE 'FAIL E10: rows=% (want 1) display_name=% (want NULL) email=% (want NULL) role=% unnamed_rows=% (want > 0)',
       v_rows, v_name, v_email, v_role, v_unnamed; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E10;

\echo 'E11 THE TENANT BOUNDARY, ASKED ABOUT THE NEW COLUMN: no other org NAMES'
SAVEPOINT sp_E11;
DO $$
DECLARE v_seen text[]; v_leaked int; v_own int; v_own_want int;
BEGIN
  -- Carried out of the `authenticated` block in an array and compared as the
  -- owner afterwards, exactly as E2 does and for the same grant reason.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(a.display_name) INTO v_seen
    FROM audit_actor_identities() a WHERE a.display_name IS NOT NULL;
  RESET ROLE;

  -- Every NAME belonging to the other org, whatever it happens to be.
  SELECT count(*) INTO v_leaked FROM user_profiles up
   WHERE up.org_id = '10000000-0000-0000-0000-000000000002'
     AND up.display_name = ANY (coalesce(v_seen, ARRAY[]::text[]));
  SELECT count(*) INTO v_own_want FROM user_profiles up
   WHERE up.org_id = '10000000-0000-0000-0000-000000000001'
     AND up.display_name IS NOT NULL;
  v_own := coalesce(array_length(v_seen, 1), 0);

  -- v_own IS HALF THE CASE, as it is in E2. Zero leaked names is what a
  -- function returning no names AT ALL would also score; the second count says
  -- the column is genuinely populated on the caller's own side.
  IF v_leaked = 0 AND v_own_want > 0 AND v_own = v_own_want
  THEN RAISE NOTICE 'PASS E11';
  ELSE RAISE NOTICE 'FAIL E11: other_org_names=% (want 0), own_names=% (want %)',
       v_leaked, v_own, v_own_want; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL E11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E11;

\echo 'E12 the declared result columns are the four the client writes down'
SAVEPOINT sp_E12;
DO $$
DECLARE v_cols text[]; v_notnull boolean;
BEGIN
  -- THE CLIENT KEEPS A COPY OF THIS LIST (`ACTOR_IDENTITY_COLUMNS` in
  -- `src/lib/api/audit.ts`), because an RPC has no column list to send and so
  -- nothing else would notice the two drifting apart. This is the server-side
  -- half of that pair; `apiAuditShape.test.ts` holds the other.
  SELECT array_agg(a.name ORDER BY a.name) INTO v_cols
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) AS a(name)
   WHERE n.nspname = 'public' AND p.proname = 'audit_actor_identities';

  SELECT attnotnull INTO v_notnull FROM pg_attribute
   WHERE attrelid = 'user_profiles'::regclass AND attname = 'display_name';

  -- AND THE COLUMN IS NULLABLE ON THE TABLE, asserted rather than assumed.
  -- `supabase gen types` cannot see nullability through a RETURNS TABLE and
  -- will type `display_name: string`; the fact that makes that a lie lives
  -- here (F-085).
  IF v_cols = ARRAY['display_name','email','role','user_id'] AND v_notnull = false
  THEN RAISE NOTICE 'PASS E12';
  ELSE RAISE NOTICE 'FAIL E12: result_columns=% (want display_name,email,role,user_id) display_name_notnull=% (want false)',
       v_cols, v_notnull; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL E12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_E12;

ROLLBACK;
