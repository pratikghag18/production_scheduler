-- ============================================================================
-- 63_org_date_format_test.sql — migration 0037, "a system admin sets the
-- org-wide date-display format, and nobody else can."
--
-- The function is `set_org_date_format(text)`. It writes ONE key into
-- `orgs.settings` and is the loud front door onto a write that `orgs_update`
-- (0008) would otherwise let a non-admin attempt and silently drop. This file
-- makes each of those claims falsifiable.
--
-- Fixture is the seed's: org 1 (Northwind), a1 the company/system admin
-- (org-wide role 'admin'), a2 a supervisor (org-wide 'supervisor'). If a2 were
-- an admin the not_permitted cases would pass against a function that did
-- nothing, so X0 asserts the two roles up front, the way 48 does.
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed so a
-- committed-within-txn UPDATE cannot leak into the next.
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

\echo 'X1: the admin sets a format, and the siblings in the settings bag survive'
SAVEPOINT sp_X1;
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v := set_org_date_format('dmy_slash');
  RESET ROLE;
  -- The returned value is what is STORED, not an echo, and capacity_cap /
  -- eligibility_policy (0001's defaults) are still there -- `||` merged one key.
  IF v->>'date_format' = 'dmy_slash'
     AND (v->>'capacity_cap') IS NOT NULL
     AND v->>'eligibility_policy' = 'warn'
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: %', v; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2: the write persists -- reading orgs.settings back shows the new format'
SAVEPOINT sp_X2;
DO $$
DECLARE v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_org_date_format('iso');
  RESET ROLE;
  SELECT settings->>'date_format' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_stored = 'iso'
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: stored=%', v_stored; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3: an unknown token is refused invalid_argument and nothing is written'
SAVEPOINT sp_X3;
DO $$
DECLARE v_raw text; v_detail jsonb; v_stored text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_date_format('MM-DD-YYYY');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT settings->>'date_format' INTO v_stored
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'field' = 'date_format'
     AND v_stored IS NULL
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: detail=% stored=%', v_detail, v_stored; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4: a supervisor is refused not_permitted, and the setting is untouched'
SAVEPOINT sp_X4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_stored text; v_cap text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_date_format('iso');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT settings->>'date_format', settings->>'capacity_cap' INTO v_stored, v_cap
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  -- The refusal is typed, no date_format was written, and the bag it could not
  -- reach is intact.
  IF v_detail->>'error' = 'not_permitted' AND v_stored IS NULL AND v_cap IS NOT NULL
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: detail=% stored=% cap=%', v_detail, v_stored, v_cap; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5: a null format is invalid_argument, not a crash and not a silent write'
SAVEPOINT sp_X5;
DO $$
DECLARE v_raw text; v_detail jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_date_format(NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'field' = 'date_format'
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: detail=%', v_detail; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;

ROLLBACK;

\echo '63_org_date_format_test.sql complete (6 cases: X0-X5)'
