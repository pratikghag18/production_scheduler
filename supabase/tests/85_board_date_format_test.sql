-- ============================================================================
-- 85_board_date_format_test.sql -- migration 0062, "the BOARD carries its date
-- format." (R-333, DEF-0017)
--
-- WHAT 0051/0058 LEFT FOR THE DATE FORMAT. 0051 made eligibility_policy
-- resolvable per node in board_window (node_policies); 74 proved a supervisor's
-- board carries the plant's block even though she cannot read the plant root.
-- The DATE FORMAT was the twin the client still got wrong: BoardPage read it
-- from useDateFormat(canQuery, root), which answers the ROOT node's OWN
-- node_settings row, else the company value. A board rooted at a LINE (or, here,
-- a Department) has no row of its own, and the plant's row sits above the grant
-- where node_settings_select will not hand it to her -- so her board showed the
-- COMPANY format on a plant that had chosen otherwise (DEF-0017).
--
-- THE FIX MIRRORS node_policies EXACTLY. board_window gains one top-level key,
-- date_format, resolved for the board's own root through app_resolve_node_setting
-- (SECURITY DEFINER, 0050), COALESCEd to 'd_mon_yyyy' (the key's own default).
--
-- B1 IS THE CASE THIS FILE EXISTS FOR, and it means something only because B0
-- is true: Ana (a supervisor granted plant_1.assembly) can read NEITHER the
-- plant root NOR the override row on it, so a browser-side walk would have
-- nothing to resolve FROM. B1 then measures that her payload nevertheless
-- carries the plant's ymd_slash, because the walk happens on the server -- and
-- it asks app_resolve_node_setting AS Ana for the same node, so the two are the
-- SAME question and not merely two things that both say ymd_slash. A case that
-- only drove the company admin would PASS against the broken version: a1 holds a
-- grant on plant_1 itself, reads the override row, and resolves it anywhere.
--
-- AS authenticated EVERYWHERE. board_window is SECURITY INVOKER; psql connects
-- as the superuser, who bypasses RLS entirely and whose app_current_org() is
-- NULL -- a case that forgets this measures nothing.
--
-- FIXTURE (the seed's own, no new nodes):
--   plant_1               30000000-...-0001  the seed's only plant
--     .assembly           30000000-...-0002  Ana's grant, and hers alone
--       .line_1           30000000-...-0004
--   a1  ...a1  company admin (user_profiles.role = 'admin'), granted plant_1
--   a2  ...a2  Ana, org-wide supervisor, granted plant_1.assembly ONLY
--
-- Everything is inside one BEGIN/ROLLBACK; each case is savepointed.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- B0  THE GROUND B1 STANDS ON: Ana can read NEITHER the plant root NOR the
--     date_format override row sitting on it.
-- ----------------------------------------------------------------------------
\echo 'B0: a supervisor granted the department can see neither the plant root nor its date_format row'
SAVEPOINT sp_B0;
DO $$
DECLARE v_root int; v_rows int; v_dept int;
BEGIN
  -- The override is placed by the company admin, who may.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'ymd_slash');
  RESET ROLE;

  -- Now as Ana: what can she read?
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_root FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_rows FROM node_settings
    WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'date_format';
  SELECT count(*) INTO v_dept FROM nodes WHERE id = '30000000-0000-0000-0000-000000000002';
  RESET ROLE;

  IF v_root = 0 AND v_rows = 0 AND v_dept = 1
  THEN RAISE NOTICE 'PASS B0';
  ELSE RAISE NOTICE 'FAIL B0: readable_plant_root=% (want 0) readable_override_rows=% (want 0) readable_own_dept=% (want 1)',
    v_root, v_rows, v_dept; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL B0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_B0;

-- ----------------------------------------------------------------------------
-- B1  THE CASE THIS FILE EXISTS FOR: the supervisor's own board carries the
--     plant's ymd_slash, inherited from a node she cannot read -- and it is the
--     SAME answer app_resolve_node_setting reaches for her, asked AS her.
--     Grants unchanged: can_place stays true, node_policies stays populated.
-- ----------------------------------------------------------------------------
\echo 'B1: a supervisor whose plant sets ymd_slash gets a board carrying date_format ymd_slash'
SAVEPOINT sp_B1;
DO $$
DECLARE v_pay jsonb; v_fmt text; v_srv text; v_can_place boolean; v_npol int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'date_format', 'ymd_slash');
  RESET ROLE;

  -- Ana's board, rooted at the ONLY place she may open, one level BELOW the node
  -- carrying the override.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_pay := board_window('plant_1.assembly'::ltree,
                        timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  -- ...and the server's own resolver for the board's root, asked AS Ana, so the
  -- payload and the resolver are the SAME question.
  v_srv := app_resolve_node_setting('30000000-0000-0000-0000-000000000002', 'date_format');
  RESET ROLE;

  v_fmt       := v_pay->>'date_format';
  v_can_place := (v_pay->>'can_place')::boolean;
  SELECT count(*) INTO v_npol FROM jsonb_array_elements(v_pay->'node_policies');

  IF v_fmt = 'ymd_slash' AND v_srv = 'ymd_slash'
     AND v_can_place = true AND v_npol > 0
  THEN RAISE NOTICE 'PASS B1';
  ELSE RAISE NOTICE 'FAIL B1: payload_date_format=% (want ymd_slash) resolver=% (want ymd_slash) can_place=% (want t) node_policies=% (want >0)',
    v_fmt, v_srv, v_can_place, v_npol; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL B1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_B1;

-- ----------------------------------------------------------------------------
-- B2  THE COMPANY ADMIN ON A PLANT WITH NO OVERRIDE carries the COMPANY's
--     value. The seed's company bag has no date_format key at all, so the admin
--     sets one first; the plant carries no node_settings row of its own.
-- ----------------------------------------------------------------------------
\echo 'B2: the company admin on a plant with no override carries the company value'
SAVEPOINT sp_B2;
DO $$
DECLARE v_pay jsonb; v_fmt text; v_can_place boolean; v_override int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  -- The company default, set through the real RPC. No plant override anywhere.
  PERFORM set_org_date_format('iso');
  SELECT count(*) INTO v_override FROM node_settings
    WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'date_format';
  v_pay := board_window('plant_1'::ltree,
                        timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  RESET ROLE;

  v_fmt       := v_pay->>'date_format';
  v_can_place := (v_pay->>'can_place')::boolean;

  IF v_fmt = 'iso' AND v_override = 0 AND v_can_place = true
  THEN RAISE NOTICE 'PASS B2';
  ELSE RAISE NOTICE 'FAIL B2: payload_date_format=% (want iso) plant_override_rows=% (want 0) can_place=% (want t)',
    v_fmt, v_override, v_can_place; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL B2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_B2;

-- ----------------------------------------------------------------------------
-- B3  THE KEY'S OWN DEFAULT: nobody anywhere has set a date_format (the seed's
--     out-of-the-box state), so the resolver returns NULL and the COALESCE at
--     the call site sends 'd_mon_yyyy' -- never a JSON null the client would
--     reject as a shape mismatch.
-- ----------------------------------------------------------------------------
\echo 'B3: with no override and no company value, the payload carries the coalesced default d_mon_yyyy (never null)'
SAVEPOINT sp_B3;
DO $$
DECLARE v_pay jsonb; v_fmt text; v_type text; v_has_company boolean;
BEGIN
  -- Confirm the seed has no company date_format, so this is the real zero state.
  SELECT settings ? 'date_format' INTO v_has_company
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pay := board_window('plant_1'::ltree,
                        timestamptz '2026-10-01 00:00+00', timestamptz '2026-10-03 00:00+00');
  RESET ROLE;

  v_fmt  := v_pay->>'date_format';
  v_type := jsonb_typeof(v_pay->'date_format');

  IF v_has_company = false AND v_fmt = 'd_mon_yyyy' AND v_type = 'string'
  THEN RAISE NOTICE 'PASS B3';
  ELSE RAISE NOTICE 'FAIL B3: company_has_key=% (want f) date_format=% (want d_mon_yyyy) type=% (want string)',
    v_has_company, v_fmt, v_type; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL B3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_B3;

ROLLBACK;

\echo '85_board_date_format_test.sql complete (4 cases: B0-B3)'
