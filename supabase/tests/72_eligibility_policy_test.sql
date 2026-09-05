-- ============================================================================
-- 72_eligibility_policy_test.sql — migration 0049, "a system admin chooses
-- whether an untrained person can be scheduled with a recorded reason, or not
-- at all."
--
-- THE SETTING WAS ALWAYS THERE AND WAS NEVER WRITEABLE. `orgs.settings`
-- (0001) has carried `eligibility_policy` since the first migration, with a
-- table CHECK pinning it to ('warn','block'), and the server has read it in
-- `create_assignment` / `move_run` / `apply_split_coverage` (0009, 0026, 0030,
-- 0043, 0044) all along. What the bag never had was a WRITE function for it —
-- `set_org_date_format` (0037/0038) was the only one — so every org sat on the
-- 0001 default of 'warn' unless somebody edited jsonb by hand. 0049 adds the
-- switch, in 0037's shape exactly. This file makes each of its claims
-- falsifiable.
--
-- ⛔ THE CASE THIS FILE EXISTS FOR IS X6, THE SIBLING KEYS. `orgs.settings` is
-- ONE flat bag holding capacity_cap, week_start, default_snap_minutes,
-- date_format and this. A settings writer that builds the bag whole — the
-- obvious `SET settings = jsonb_build_object('eligibility_policy', ...)` — is
-- green on every other case in this file and silently DESTROYS the other four
-- settings: the board's capacity cap reverts to its coded default, the week
-- starts on a different day, and nobody connects it to the eligibility switch
-- somebody flipped a fortnight earlier. X6 compares the whole bag before and
-- after with `- 'eligibility_policy'` on both sides, so it fails on ANY other
-- key that moved, including one added after this file was written.
--
-- ⛔ AND THE SECOND TRAP: A REFUSAL AND A SILENT NO-OP LOOK THE SAME FROM THE
-- OUTSIDE. `orgs_update` (0008) is `app_is_admin() and id = app_current_org()`,
-- so a non-admin's UPDATE is filtered to ZERO ROWS and raises NOTHING. "The
-- supervisor did not change it" is therefore worth nothing on its own — it is
-- equally true of a plain UPDATE, of a working RPC, and of a function that was
-- simply broken for everybody. So X4 asserts a TYPED refusal (`not_permitted`,
-- SQLSTATE PT403), which no zero-row write can produce, and X5 stands the two
-- side by side: the same person, the same intent, through the UPDATE a settings
-- screen would otherwise have been wired to — no exception, ROW_COUNT 0,
-- nothing changed and nothing said. X5 is the whole argument for the RPC.
--
-- ⚠️ X3 CHECKS THE SQLSTATE, NOT JUST THE WORD. A bad value must be refused by
-- the FUNCTION (`invalid_argument`, PT400) and not by the table CHECK, which
-- surfaces as 23514 "new row violates check constraint
-- orgs_settings_check" — a true refusal, but unreadable, unlabelled, and
-- indistinguishable to the client from any other constraint on the row. The
-- assertion on PT400 is what tells the two apart.
--
-- Fixture is the seed's, as 63 uses: org 1 (Northwind), a1 the company/system
-- admin (org-wide role 'admin'), a2 a supervisor (org-wide 'supervisor'). If a2
-- were an admin the refusal cases would pass against a function with no gate at
-- all, so X0 asserts the two roles up front, the way 48 and 63 do.
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed so one
-- case's write cannot leak into the next.
-- ============================================================================

BEGIN;

\echo 'X0: a1 is an org-wide admin and a2 is not (the property the refusals rest on)'
SAVEPOINT sp_X0;
DO $$
DECLARE v_a1 text; v_a2 text;
BEGIN
  SELECT role INTO v_a1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  SELECT role INTO v_a2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  IF v_a1 = 'admin' AND v_a2 = 'supervisor'
  THEN RAISE NOTICE 'PASS X0';
  ELSE RAISE NOTICE 'FAIL X0: a1=% (want admin), a2=% (want supervisor)', v_a1, v_a2; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X0;

\echo 'X1: the org starts on warn -- the 0001 default the whole feature has been stuck on'
SAVEPOINT sp_X1;
DO $$
DECLARE v_stored text;
BEGIN
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_stored = 'warn'
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: stored=% (want warn)', v_stored; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2: the admin sets block, and the returned bag is what is STORED, not an echo'
SAVEPOINT sp_X2;
DO $$
DECLARE v jsonb; v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v := set_org_eligibility_policy('block');
  RESET ROLE;
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v->>'eligibility_policy' = 'block' AND v_stored = 'block'
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: returned=% stored=%', v, v_stored; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3: block goes back to warn -- the switch turns both ways, not just on'
SAVEPOINT sp_X3;
DO $$
DECLARE v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_org_eligibility_policy('block');
  PERFORM set_org_eligibility_policy('warn');
  RESET ROLE;
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_stored = 'warn'
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: stored=% (want warn)', v_stored; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4: a value outside the pair is refused by the FUNCTION (invalid_argument/PT400), not the table CHECK (23514)'
SAVEPOINT sp_X4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_eligibility_policy('strict');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  -- PT400 is api_raise's code for invalid_argument. 23514 would mean the value
  -- reached the row and the CHECK caught it -- refused, but not readably.
  IF v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'eligibility_policy'
     AND v_state = 'PT400'
     AND v_stored = 'warn'
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: detail=% sqlstate=% stored=%', v_detail, v_state, v_stored; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5: a null policy is invalid_argument, not a crash and not a silent write'
SAVEPOINT sp_X5;
DO $$
DECLARE v_raw text; v_detail jsonb; v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_eligibility_policy(NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'invalid_argument'
     AND v_detail->>'field' = 'eligibility_policy'
     AND v_stored = 'warn'
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: detail=% stored=%', v_detail, v_stored; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;

\echo 'X6: EVERY other settings key survives the write -- the whole bag is compared, not a chosen few'
SAVEPOINT sp_X6;
DO $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  -- Set a date_format first, so the bag under test carries the OTHER RPC's key
  -- as well as 0001's four defaults. A writer that clobbered the bag would take
  -- the company's date format with it, and this is the arrangement that notices.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_org_date_format('iso');
  RESET ROLE;

  SELECT settings INTO v_before FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  SET LOCAL ROLE authenticated;
  PERFORM set_org_eligibility_policy('block');
  RESET ROLE;

  SELECT settings INTO v_after FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  -- Everything except the one key this function owns must be byte-identical,
  -- and the bag must actually have had the siblings in it for that to mean
  -- anything (jsonb '{}' minus a key equals jsonb '{}' minus a key).
  IF (v_before - 'eligibility_policy') = (v_after - 'eligibility_policy')
     AND v_before ? 'capacity_cap' AND v_before ? 'week_start'
     AND v_before ? 'default_snap_minutes' AND v_before ? 'date_format'
     AND v_after->>'date_format' = 'iso'
     AND v_after->>'eligibility_policy' = 'block'
  THEN RAISE NOTICE 'PASS X6';
  ELSE RAISE NOTICE 'FAIL X6: before=% after=%', v_before, v_after; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X6;

\echo 'X7: a supervisor is TOLD NO (not_permitted / PT403) and the policy is untouched'
SAVEPOINT sp_X7;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_stored text; v_cap text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_eligibility_policy('block');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT settings->>'eligibility_policy', settings->>'capacity_cap' INTO v_stored, v_cap
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  -- A typed exception is the observation that a zero-row UPDATE cannot make.
  IF v_detail->>'error' = 'not_permitted' AND v_state = 'PT403'
     AND v_stored = 'warn' AND v_cap IS NOT NULL
  THEN RAISE NOTICE 'PASS X7';
  ELSE RAISE NOTICE 'FAIL X7: detail=% sqlstate=% stored=% cap=%', v_detail, v_state, v_stored, v_cap; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X7;

\echo 'X8: the plain UPDATE this RPC replaces is the SILENT no-op -- no error, zero rows, nothing said'
SAVEPOINT sp_X8;
DO $$
DECLARE v_rows int; v_stored text; v_threw boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE orgs SET settings = settings || jsonb_build_object('eligibility_policy', 'block')
     WHERE id = '10000000-0000-0000-0000-000000000001';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_threw := true;
  END;
  RESET ROLE;
  SELECT settings->>'eligibility_policy' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  -- This is the failure mode X7 proves the RPC does NOT have: the supervisor's
  -- write "succeeded", touched nothing, and said nothing. Same person, same
  -- intent, no exception -- which is exactly why the screen calls the function.
  IF NOT v_threw AND v_rows = 0 AND v_stored = 'warn'
  THEN RAISE NOTICE 'PASS X8';
  ELSE RAISE NOTICE 'FAIL X8: threw=% rows=% stored=%', v_threw, v_rows, v_stored; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X8;

\echo 'X9: EXECUTE is granted to authenticated and revoked from PUBLIC'
SAVEPOINT sp_X9;
DO $$
DECLARE v_public boolean; v_auth boolean;
BEGIN
  SELECT has_function_privilege('public', 'set_org_eligibility_policy(text)', 'EXECUTE'),
         has_function_privilege('authenticated', 'set_org_eligibility_policy(text)', 'EXECUTE')
    INTO v_public, v_auth;
  IF v_public = false AND v_auth = true
  THEN RAISE NOTICE 'PASS X9';
  ELSE RAISE NOTICE 'FAIL X9: public=% authenticated=%', v_public, v_auth; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X9;

ROLLBACK;

\echo '72_eligibility_policy_test.sql complete (10 cases: X0-X9)'
