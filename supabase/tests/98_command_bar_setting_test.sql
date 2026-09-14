-- ============================================================================
-- 98_command_bar_setting_test.sql — migration 0081, "a plant decides how much
-- of the bar its people get." (R-403, D129)
--
-- The maintainer, session 164, 14 Sept: "Is there a way we can enable and
-- disable the chatbot from the settings? I'm thinking if I want to limit the
-- feature during the initial getting used to period." Shown off/typed/voice:
-- "Yes, go."
--
-- Same shape as 63_org_date_format_test.sql (the company writer) and
-- 73_plant_settings_test.sql (the per-plant table, resolver and writers),
-- because command_bar IS a node_settings key, the fourth. Ten cases:
--
--   C0  the fixture's own properties (roles, no stray override)
--   C1  the value CHECK: the three values accepted, junk and NULL refused
--   C2  set_node_setting by the plant's own admin stores and returns effective
--   C3  a supervisor with no grant on the plant is refused (not_permitted)
--   C4  clear_node_setting removes the row; effective falls to the company's
--   C5  set_org_command_bar: stores, siblings survive, a non-admin refused
--   C6  app_resolve_node_setting: a line answers from its PLANT's override
--   C7  ⛔ the fail-open case (73's P16 twin): a supervisor who cannot read
--       the plant root still gets board_window's command_bar from it
--   C8  with no row anywhere, board_window answers 'voice' (the default)
--   C9  an unknown value through set_node_setting is invalid_argument
--       naming command_bar
--
-- FIXTURE (the seed's, nothing built): org 1 (Northwind).
--   plant_1              30000000-...-0001   the seed's only plant
--     .assembly          30000000-...-0002
--       .line_1          30000000-...-0004   C6 rests on this (a line, no
--                                             override of its own)
--     .machining         30000000-...-0003   Marco's ONLY grant (supervisor)
--       .cnc_line        30000000-...-0006   C7 rests on this: Marco CAN read
--                                             it (inside his grant) though he
--                                             cannot read plant_1 (above it)
--   a1  ...a1  company/system admin
--   a2  ...a2  org-wide supervisor, no grant anywhere in particular -- C3's
--              refusal (not admin, not admin_for(plant_1))
--   a3  ...a3  Marco, supervisor granted Machining ALONE -- C7's point
--
-- Everything runs inside one BEGIN/ROLLBACK; each case is savepointed so one
-- case's write cannot leak into the next.
-- ============================================================================

BEGIN;

CREATE FUNCTION pg_temp.t(p_day int, p_minute int) RETURNS timestamptz
LANGUAGE sql STABLE AS $fn$
  SELECT date_trunc('week', current_date)::timestamptz + (p_day * 1440 + p_minute) * interval '1 minute';
$fn$;

\echo 'C0: the fixture''s own properties -- roles, and no stray command_bar row or org value anywhere'
SAVEPOINT sp_C0;
DO $$
DECLARE v_a1 text; v_a2 text; v_a3 text; v_marco_node uuid; v_overrides int; v_org_has boolean;
BEGIN
  SELECT role INTO v_a1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  SELECT role INTO v_a2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  SELECT role INTO v_a3 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a3';
  SELECT pg.node_id INTO v_marco_node FROM profile_grants pg
    JOIN user_profiles up ON up.id = pg.profile_id
   WHERE up.user_id = '00000000-0000-0000-0000-0000000000a3';
  SELECT count(*) INTO v_overrides FROM node_settings WHERE key = 'command_bar';
  SELECT (settings ? 'command_bar') INTO v_org_has
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  IF v_a1 = 'admin' AND v_a2 = 'supervisor' AND v_a3 = 'supervisor'
     AND v_marco_node = '30000000-0000-0000-0000-000000000003'
     AND v_overrides = 0 AND NOT v_org_has
  THEN RAISE NOTICE 'PASS C0';
  ELSE RAISE NOTICE 'FAIL C0: a1=% a2=% a3=% marco_node=% overrides=% org_has=%',
    v_a1, v_a2, v_a3, v_marco_node, v_overrides, v_org_has; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL C0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C0;

\echo 'C1: the value CHECK accepts off/typed/voice, refuses junk and the string ''null'' (23514), and NOT NULL refuses an actual null (23502)'
SAVEPOINT sp_C1;
DO $$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  -- The three legal values, each inserted then removed so the next one has a
  -- clean slot at the same (node_id, key).
  FOR v_state IN SELECT unnest(ARRAY['off', 'typed', 'voice']) LOOP
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'command_bar',
            '10000000-0000-0000-0000-000000000001', v_state);
    DELETE FROM node_settings
     WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'command_bar';
  END LOOP;
  RESET ROLE;
  RAISE NOTICE 'PASS C1 (part 1: off/typed/voice all accepted)';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C1 (part 1): unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C1;

SAVEPOINT sp_C1b;
DO $$
DECLARE v_on_state text; v_empty_state text; v_nullword_state text; v_null_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'command_bar',
            '10000000-0000-0000-0000-000000000001', 'on');
  EXCEPTION WHEN OTHERS THEN v_on_state := SQLSTATE; END;

  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'command_bar',
            '10000000-0000-0000-0000-000000000001', '');
  EXCEPTION WHEN OTHERS THEN v_empty_state := SQLSTATE; END;

  -- The JSON literal spelled out as TEXT -- not a real null (that is the next
  -- prong), but the word somebody might type thinking it clears the row.
  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'command_bar',
            '10000000-0000-0000-0000-000000000001', 'null');
  EXCEPTION WHEN OTHERS THEN v_nullword_state := SQLSTATE; END;

  BEGIN
    INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'command_bar',
            '10000000-0000-0000-0000-000000000001', NULL);
  EXCEPTION WHEN OTHERS THEN v_null_state := SQLSTATE; END;
  RESET ROLE;

  IF v_on_state = '23514' AND v_empty_state = '23514' AND v_nullword_state = '23514'
     AND v_null_state = '23502'
  THEN RAISE NOTICE 'PASS C1 (part 2: on/empty/"null" refused 23514, a real null refused 23502)';
  ELSE RAISE NOTICE 'FAIL C1 (part 2): on=% empty=% nullword=% null=%',
    v_on_state, v_empty_state, v_nullword_state, v_null_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C1 (part 2): unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C1b;

\echo 'C2: set_node_setting(plant, command_bar, typed) by the plant''s own admin stores it and returns effective=typed'
SAVEPOINT sp_C2;
DO $$
DECLARE v_ret jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_ret := set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'typed');
  RESET ROLE;
  IF v_ret->>'value' = 'typed' AND (v_ret->>'is_override') = 'true'
     AND v_ret->>'effective' = 'typed' AND v_ret->>'org_value' IS NULL
  THEN RAISE NOTICE 'PASS C2';
  ELSE RAISE NOTICE 'FAIL C2: %', v_ret; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C2;

\echo 'C3: a supervisor with no admin grant on this plant is refused not_permitted (PT403), and nothing is stored'
SAVEPOINT sp_C3;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'typed');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'command_bar';
  IF v_detail->>'error' = 'not_permitted' AND v_state = 'PT403' AND v_rows = 0
  THEN RAISE NOTICE 'PASS C3';
  ELSE RAISE NOTICE 'FAIL C3: detail=% state=% rows=%', v_detail, v_state, v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C3;

\echo 'C4: clear_node_setting removes the row, and effective falls back to the company''s answer'
SAVEPOINT sp_C4;
DO $$
DECLARE v_company jsonb; v_set jsonb; v_clear jsonb; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_company := set_org_command_bar('off');
  v_set   := set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'typed');
  v_clear := clear_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar');
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'command_bar';
  IF v_company->>'command_bar' = 'off'
     AND v_set->>'effective' = 'typed'
     AND v_clear->>'effective' = 'off' AND (v_clear->>'is_override') = 'false'
     AND v_clear->>'value' IS NULL AND v_rows = 0
  THEN RAISE NOTICE 'PASS C4';
  ELSE RAISE NOTICE 'FAIL C4: company=% set=% clear=% rows=%', v_company, v_set, v_clear, v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C4;

\echo 'C5: set_org_command_bar(off) by the system admin stores it and the settings bag''s siblings survive; a supervisor is refused'
SAVEPOINT sp_C5;
DO $$
DECLARE v_ret jsonb; v_raw text; v_detail jsonb; v_state text; v_org_after text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_ret := set_org_command_bar('off');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_org_command_bar('typed');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;

  SELECT settings->>'command_bar' INTO v_org_after
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';

  IF v_ret->>'command_bar' = 'off'
     AND (v_ret->>'eligibility_policy') IS NOT NULL  -- a sibling key, untouched
     AND (v_ret->>'capacity_cap') IS NOT NULL          -- another sibling, untouched
     AND v_detail->>'error' = 'not_permitted' AND v_state = 'PT403'
     AND v_org_after = 'off'  -- a2's refused call changed nothing
  THEN RAISE NOTICE 'PASS C5';
  ELSE RAISE NOTICE 'FAIL C5: ret=% refusal=%/% org_after=%', v_ret, v_detail, v_state, v_org_after; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C5;

\echo 'C6: app_resolve_node_setting(line, command_bar) answers the PLANT''s override for a line under it, with no row of its own'
SAVEPOINT sp_C6;
DO $$
DECLARE v_line text; v_root text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'typed');
  -- Line 1 (plant_1.assembly.line_1) carries no override of its own.
  v_line := app_resolve_node_setting('30000000-0000-0000-0000-000000000004', 'command_bar');
  v_root := app_resolve_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar');
  RESET ROLE;
  IF v_line = 'typed' AND v_root = 'typed'
  THEN RAISE NOTICE 'PASS C6';
  ELSE RAISE NOTICE 'FAIL C6: line=% root=%', v_line, v_root; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C6;

\echo 'C7 (⛔ the fail-open case, 73''s P16 twin): a supervisor who cannot read the plant root still gets board_window''s command_bar from it'
SAVEPOINT sp_C7;
DO $$
DECLARE v_can_read boolean; v_win jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'off');
  RESET ROLE;

  -- Marco: supervisor granted Machining alone. cnc_line sits INSIDE his grant
  -- (he can read it and board it); plant_1, where the override actually
  -- lives, sits ABOVE it (he cannot read it at all).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SET LOCAL ROLE authenticated;
  v_can_read := app_can_read_node('30000000-0000-0000-0000-000000000001');
  v_win := board_window('plant_1.machining.cnc_line'::ltree, pg_temp.t(3, 0), pg_temp.t(4, 0));
  RESET ROLE;

  -- ⭐ THE FIRST ASSERTION IS THE POINT OF THE CASE, exactly as 73's P16: if
  -- board_window's resolver were INVOKER instead of the DEFINER
  -- app_resolve_node_setting is, Marco's ancestry walk would be RLS-filtered,
  -- the plant's override row would drop out, and this would read 'voice'
  -- (the company/default) instead of the plant's actual 'off' -- a switch
  -- meant to LIMIT the feature quietly permissive for exactly the person who
  -- schedules that line all day.
  IF v_can_read = false AND v_win->>'command_bar' = 'off'
  THEN RAISE NOTICE 'PASS C7';
  ELSE RAISE NOTICE 'FAIL C7: marco_can_read_plant_root=% command_bar=%', v_can_read, v_win->>'command_bar'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C7;

\echo 'C8: with no row anywhere -- no override, no company value -- board_window answers voice, the default'
SAVEPOINT sp_C8;
DO $$
DECLARE v_win jsonb; v_org_has boolean;
BEGIN
  SELECT (settings ? 'command_bar') INTO v_org_has
    FROM orgs WHERE id = '10000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_win := board_window('plant_1'::ltree, pg_temp.t(3, 0), pg_temp.t(4, 0));
  RESET ROLE;
  IF NOT v_org_has AND v_win->>'command_bar' = 'voice'
  THEN RAISE NOTICE 'PASS C8';
  ELSE RAISE NOTICE 'FAIL C8: org_has_key=% command_bar=%', v_org_has, v_win->>'command_bar'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C8;

\echo 'C9: an unknown value through set_node_setting is invalid_argument (PT400) naming command_bar, and nothing is stored'
SAVEPOINT sp_C9;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_rows int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_node_setting('30000000-0000-0000-0000-000000000001', 'command_bar', 'on');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_rows FROM node_settings
   WHERE node_id = '30000000-0000-0000-0000-000000000001' AND key = 'command_bar';
  IF v_detail->>'error' = 'invalid_argument' AND v_detail->>'field' = 'command_bar'
     AND v_detail->>'value' = 'on' AND v_state = 'PT400' AND v_rows = 0
  THEN RAISE NOTICE 'PASS C9';
  ELSE RAISE NOTICE 'FAIL C9: detail=% state=% rows=%', v_detail, v_state, v_rows; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL C9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_C9;

ROLLBACK;

\echo '98_command_bar_setting_test.sql complete (10 cases: C0-C9)'
