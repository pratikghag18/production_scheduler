-- ============================================================================
-- 87_plant_timezone_test.sql -- migration 0063, "a plant has a TIME ZONE."
-- (D88a/D88b, R-353/R-354)
--
-- The zone is the THIRD key of node_settings, resolved nearest-ancestor with a
-- company (orgs.settings) fallback, exactly as date_format is (0052/0062), and
-- carried on board_window as one resolved top-level key -- so a line supervisor
-- who cannot read her plant root nevertheless gets her plant's zone, because
-- app_resolve_node_setting is SECURITY DEFINER and the walk happens on the
-- server (the twin of DEF-0016/DEF-0017's fix).
--
-- T4 IS THE CASE THIS FILE EXISTS FOR, and it means something only because T3
-- is true: Ana (a supervisor granted plant_1.assembly) can read NEITHER the
-- plant root NOR the timezone override row on it, so a browser-side walk would
-- have nothing to resolve FROM. T4 then measures that her board payload
-- nevertheless carries the plant's America/Chicago, and it asks
-- app_resolve_node_setting AS Ana for the same node so the two are the SAME
-- question.
--
-- AS authenticated EVERYWHERE. board_window is SECURITY INVOKER; psql connects
-- as the superuser, who bypasses RLS entirely and whose app_current_org() is
-- NULL -- a case that forgets this measures nothing.
--
-- FIXTURE (the seed's own, no new nodes):
--   plant_1               30000000-...-0001  the seed's only plant
--     .assembly           30000000-...-0002  Ana's grant, and hers alone
--   a1  ...a1  company admin (user_profiles.role = 'admin'), granted plant_1
--   a2  ...a2  Ana, org-wide supervisor, granted plant_1.assembly ONLY
--
-- Everything is inside one BEGIN/ROLLBACK; each case is savepointed.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- T1  AN INVALID ZONE IS REFUSED invalid_argument NAMING THE FIELD. The plant
--     admin, who MAY write, is refused on a name pg_timezone_names does not
--     hold -- the friendly refusal the writer raises ahead of the loose CHECK.
-- ----------------------------------------------------------------------------
\echo 'T1: an invalid IANA name is refused invalid_argument on the write'
SAVEPOINT sp_T1;
DO $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'timezone', 'Mars/Phobos');
    v_state := 'NO-RAISE';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;

  -- api_raise maps invalid_argument to SQLSTATE 'PT400'.
  IF v_state = 'PT400'
  THEN RAISE NOTICE 'PASS T1';
  ELSE RAISE NOTICE 'FAIL T1: sqlstate=% (want PT400 invalid_argument)', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T1;

-- ----------------------------------------------------------------------------
-- T2  A PLANT OVERRIDE BEATS THE COMPANY DEFAULT. The company is set to
--     Europe/London; the plant sets America/Chicago; the resolver for the plant
--     answers America/Chicago, and for a sibling with no override answers the
--     company's Europe/London.
-- ----------------------------------------------------------------------------
\echo 'T2: a plant override beats the company default; an untouched sibling follows the company'
SAVEPOINT sp_T2;
DO $$
DECLARE v_plant text; v_sibling text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_org_timezone('Europe/London');
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'timezone', 'America/Chicago');
  -- the plant itself (has the override)
  v_plant   := app_resolve_node_setting('30000000-0000-0000-0000-000000000001', 'timezone');
  -- Machining (30...0003), a plant child with NO timezone override of its own,
  -- inherits the plant's override -- nearest ancestor wins.
  v_sibling := app_resolve_node_setting('30000000-0000-0000-0000-000000000003', 'timezone');
  RESET ROLE;

  IF v_plant = 'America/Chicago' AND v_sibling = 'America/Chicago'
  THEN RAISE NOTICE 'PASS T2';
  ELSE RAISE NOTICE 'FAIL T2: plant=% (want America/Chicago) child=% (want America/Chicago inherited)',
    v_plant, v_sibling; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T2;

-- ----------------------------------------------------------------------------
-- T3  AN UNTOUCHED PLANT FOLLOWS THE COMPANY DEFAULT, AND WITH NO ANSWER
--     ANYWHERE THE COALESCE SENDS 'UTC' (never a JSON null). Two halves: the
--     company sets Europe/London and the plant, with no override, resolves to
--     it; and out of the box (seed has no timezone anywhere) the board payload
--     carries the coalesced 'UTC' as a string.
-- ----------------------------------------------------------------------------
\echo 'T3: an untouched plant follows the company; with nothing set the payload carries UTC (never null)'
SAVEPOINT sp_T3;
DO $$
DECLARE v_follow text; v_seed_has boolean; v_pay jsonb; v_tz text; v_type text;
BEGIN
  -- Confirm the seed has no company timezone: this is the real zero state.
  SELECT settings ? 'timezone' INTO v_seed_has
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  -- Zero state: no override, no company value -> board carries the COALESCE 'UTC'.
  v_pay  := board_window('plant_1'::ltree,
                         timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  v_tz   := v_pay->>'timezone';
  v_type := jsonb_typeof(v_pay->'timezone');

  -- Now the company sets a value and the untouched plant follows it.
  PERFORM set_org_timezone('Europe/London');
  v_follow := app_resolve_node_setting('30000000-0000-0000-0000-000000000001', 'timezone');
  RESET ROLE;

  IF v_seed_has = false AND v_tz = 'UTC' AND v_type = 'string' AND v_follow = 'Europe/London'
  THEN RAISE NOTICE 'PASS T3';
  ELSE RAISE NOTICE 'FAIL T3: seed_has_tz=% (want f) zero_payload_tz=% (want UTC) type=% (want string) follows_company=% (want Europe/London)',
    v_seed_has, v_tz, v_type, v_follow; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T3;

-- ----------------------------------------------------------------------------
-- T3b  THE GROUND T4 STANDS ON: Ana can read NEITHER the plant root NOR the
--      timezone override row sitting on it.
-- ----------------------------------------------------------------------------
\echo 'T3b: a supervisor granted the department can see neither the plant root nor its timezone row'
SAVEPOINT sp_T3b;
DO $$
DECLARE v_root int; v_rows int; v_dept int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'timezone', 'America/Chicago');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_root FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_rows FROM node_settings
    WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'timezone';
  SELECT count(*) INTO v_dept FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002';
  RESET ROLE;

  IF v_root = 0 AND v_rows = 0 AND v_dept = 1
  THEN RAISE NOTICE 'PASS T3b';
  ELSE RAISE NOTICE 'FAIL T3b: readable_plant_root=% (want 0) readable_override_rows=% (want 0) readable_own_dept=% (want 1)',
    v_root, v_rows, v_dept; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T3b: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T3b;

-- ----------------------------------------------------------------------------
-- T4  THE CASE THIS FILE EXISTS FOR: the supervisor's own board carries the
--     plant's America/Chicago, inherited from a node she cannot read -- and it
--     is the SAME answer app_resolve_node_setting reaches for her, asked AS her.
--     Grants unchanged: can_place stays true.
-- ----------------------------------------------------------------------------
\echo 'T4: a supervisor whose plant sets America/Chicago gets a board carrying timezone America/Chicago'
SAVEPOINT sp_T4;
DO $$
DECLARE v_pay jsonb; v_tz text; v_srv text; v_can_place boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'timezone', 'America/Chicago');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_pay := board_window('plant_1.assembly'::ltree,
                        timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  v_srv := app_resolve_node_setting('30000000-0000-0000-0000-000000000002', 'timezone');
  RESET ROLE;

  v_tz        := v_pay->>'timezone';
  v_can_place := (v_pay->>'can_place')::boolean;

  IF v_tz = 'America/Chicago' AND v_srv = 'America/Chicago' AND v_can_place = true
  THEN RAISE NOTICE 'PASS T4';
  ELSE RAISE NOTICE 'FAIL T4: payload_timezone=% (want America/Chicago) resolver=% (want America/Chicago) can_place=% (want t)',
    v_tz, v_srv, v_can_place; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T4;

-- ----------------------------------------------------------------------------
-- T5  A SUPERVISOR IS REFUSED ON THE WRITE. Ana holds no admin grant on the
--     plant (she is a supervisor on a line), so set_node_setting refuses her
--     with not_permitted -- and the override row is NOT written.
-- ----------------------------------------------------------------------------
\echo 'T5: a supervisor is refused not_permitted on writing the plant timezone, and nothing is stored'
SAVEPOINT sp_T5;
DO $$
DECLARE v_state text; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000002', 'timezone', 'America/Chicago');
    v_state := 'NO-RAISE';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;

  -- As the admin, confirm no row landed on the department.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM node_settings
    WHERE node_id = '30000000-0000-0000-0000-000000000002' AND key = 'timezone';
  RESET ROLE;

  -- api_raise maps not_permitted to SQLSTATE 'PT403'.
  IF v_state = 'PT403' AND v_rows = 0
  THEN RAISE NOTICE 'PASS T5';
  ELSE RAISE NOTICE 'FAIL T5: sqlstate=% (want PT403 not_permitted) stored_rows=% (want 0)', v_state, v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL T5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_T5;

ROLLBACK;

\echo '87_plant_timezone_test.sql complete (6 cases: T1, T2, T3, T3b, T4, T5)'
