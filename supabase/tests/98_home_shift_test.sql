-- ============================================================================
-- 98_home_shift_test.sql --- migration 0082 (R-441, R-442, R-443).
--
-- Every answer and refusal is measured as `authenticated` with a real jwt sub;
-- psql connects as the superuser, who bypasses RLS and whose app_current_org()
-- is NULL, which is NOT the context these cases are about (that context is
-- exercised separately, HS_OWNER, mirroring 88's AB33).
--
-- FIXTURE --- the SEED's org 1 (Northwind), whose shape is fixed:
--   Plant 1 (root 30..01)
--     Assembly (30..02)          <- Ana supervises (a2); pattern 3x8h attached
--       Line 1 (30..04)
--         Cell 1 (30..07)        <- schedulable; inherits 3x8h from Assembly
--         Cell 2 (30..08)        <- schedulable; inherits 3x8h from Assembly
--     Machining (30..03)         <- Marco supervises (a3); no pattern of its own
--       CNC Line (30..06)        <- pattern 2x10h attached
--   People: Elena (50..04) home Assembly, owned by Plant 1
--           Maria (50..01) home Machining, owned by Plant 1
--   Pattern 3x8h (70..01): Shift 1 (71..01, 360-840 = 06:00-14:00),
--     Shift 2 (71..02, 840-1320 = 14:00-22:00), Shift 3 (71..03, 1320-1800 =
--     22:00-06:00 next day, a night band).
--   Pattern 2x10h (70..02): Days (71..04, 360-960), Nights (71..05, 960-1560).
--   Product Widget X (60..01), made at Plant 1.
--   Org 2 (Contoso) shift "Day" (7000000b-..-11, 360-840) --- a foreign band.
--   No timezone override anywhere in org 1's settings, so app_resolve_node_
--   setting(..,'timezone') resolves NULL and shift_fit/supervisor_shift_allows
--   fall back to their key's own default, UTC --- the times above ARE UTC.
--
-- CASES
--   HS0  premises: the two columns exist, default to NULL/true, and change
--        nothing for a grant or an operator that never sets them
--   HS1  a person given a band: operators.home_shift_id set, reads back
--   HS2  rename the band (shifts.name) --- the person, resolved by id, still
--        carries the new name
--   HS3  retire the band (DELETE the shifts row) --- ON DELETE SET NULL
--        (home_shift_id) leaves the person visibly without one
--   HS4  a company-B band is refused by the composite FK, not silently NULLed
--   HS5  shift_fit: in (a window fully inside the home band)
--   HS6  shift_fit: overtime, with the correct overtime_minutes
--   HS7  shift_fit: no_shift, both ways --- no home band, and a home band at a
--        node whose pattern doesn't hold it (Machining has no pattern at all)
--   HS8  shift_fit across a NIGHT band (Shift 3, end_min > 1440): in, and
--        overtime the morning after with the right minutes
--   HS9  a cell whose pattern is a DIFFERENT template: the band is matched by
--        NAME, case-insensitive (R-443's last sentence)
--   HS10 supervisor_shift_allows: true by default (no plans_shift_id set)
--   HS11 supervisor_shift_allows: false for a grant that plans Shift 1 with
--        outside_shift=false and a range at 15:00; true again once
--        outside_shift=true
--   HS12 every writer's envelope carries `shift` (or move_run's
--        `shift_overtime`): create_assignment, reassign_assignment,
--        move_assignment, move_run
--   HS13 the resize guard re-asks supervisor_shift_allows: a plain UPDATE
--        moving a block outside the acting supervisor's planned shift is
--        refused `outside_shift`; one that stays inside it succeeds
--   HS15 create_assignment itself refuses outside_shift as the restricted supervisor
--        (never 42501), writes nothing, and with outside_shift true names the
--        placement overtime with its minutes (the S66-a review gap)
--   HS14 board_window: Ana (rooted at Assembly) and the company admin (rooted
--        at Plant 1) read the SAME home_shift_id for Elena (DEF-0016 shape);
--        `me` reflects each caller's own planning grant
--   HS_OWNER  owner context (no jwt sub at all): shift_fit and
--        supervisor_shift_allows both resolve unbounded / true, the same
--        exemption resolve_shift_template takes
-- ============================================================================

BEGIN;

\echo 'HS0: premises --- the columns exist, default to NULL/true'
SAVEPOINT sp_HS0;
DO $$
DECLARE v_home uuid; v_plans uuid; v_outside boolean; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT home_shift_id INTO v_home FROM operators WHERE id = '50000000-0000-0000-0000-000000000004';
  IF v_home IS NOT NULL THEN v_ok := false; v_why := v_why || ' Elena already has a home_shift_id'; END IF;
  SELECT plans_shift_id, outside_shift INTO v_plans, v_outside
    FROM profile_grants WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';
  IF v_plans IS NOT NULL THEN v_ok := false; v_why := v_why || ' Ana''s grant already plans a shift'; END IF;
  IF v_outside IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || format(' outside_shift default is %s, not true', v_outside); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS0'; ELSE RAISE NOTICE 'FAIL HS0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS0: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS0;

\echo 'HS1: a person given a band --- reads back'
SAVEPOINT sp_HS1;
DO $$
DECLARE v_home uuid; v_ok boolean := true;
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  SELECT home_shift_id INTO v_home FROM operators WHERE id = '50000000-0000-0000-0000-000000000004';
  IF v_home IS DISTINCT FROM '71000000-0000-0000-0000-000000000002' THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS1'; ELSE RAISE NOTICE 'FAIL HS1: home_shift_id=%', v_home; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS1;

\echo 'HS2: rename the band --- the person still resolves to it, under the new name'
SAVEPOINT sp_HS2;
DO $$
DECLARE v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  UPDATE shifts SET name = 'Second Shift' WHERE id = '71000000-0000-0000-0000-000000000002';
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' fit=%s', v_fit->>'fit'); END IF;
  IF v_fit->>'band' <> 'Second Shift' THEN v_ok := false; v_why := v_why || format(' band=%s (expected renamed)', v_fit->>'band'); END IF;
  IF (v_fit->>'band_start_min')::int <> 840 THEN v_ok := false; v_why := v_why || ' band_start_min drifted'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS2'; ELSE RAISE NOTICE 'FAIL HS2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS2;

\echo 'HS3: retire the band (delete it) --- the person''s home_shift_id goes NULL'
SAVEPOINT sp_HS3;
DO $$
DECLARE v_home uuid; v_ok boolean := true;
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  DELETE FROM shifts WHERE id = '71000000-0000-0000-0000-000000000002';
  SELECT home_shift_id INTO v_home FROM operators WHERE id = '50000000-0000-0000-0000-000000000004';
  IF v_home IS NOT NULL THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS3'; ELSE RAISE NOTICE 'FAIL HS3: home_shift_id=% (expected NULL after the band was retired)', v_home; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS3;

\echo 'HS4: a company-B band is refused by the composite FK, never a silent NULL'
SAVEPOINT sp_HS4;
DO $$
DECLARE v_raised boolean := false; v_ok boolean := true;
BEGIN
  BEGIN
    UPDATE operators SET home_shift_id = '7000000b-0000-0000-0000-000000000011'
      WHERE id = '50000000-0000-0000-0000-000000000004';
  EXCEPTION WHEN foreign_key_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS4'; ELSE RAISE NOTICE 'FAIL HS4: a foreign-org band was accepted'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS4;

\echo 'HS5: shift_fit in --- a window fully inside the home band'
SAVEPOINT sp_HS5;
DO $$
DECLARE v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' fit=%s', v_fit->>'fit'); END IF;
  IF (v_fit->>'overtime_minutes')::int <> 0 THEN v_ok := false; v_why := v_why || format(' overtime_minutes=%s', v_fit->>'overtime_minutes'); END IF;
  IF v_fit->>'band' <> 'Shift 2' THEN v_ok := false; v_why := v_why || format(' band=%s', v_fit->>'band'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS5'; ELSE RAISE NOTICE 'FAIL HS5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS5;

\echo 'HS6: shift_fit overtime --- 60 minutes before the band starts'
SAVEPOINT sp_HS6;
DO $$
DECLARE v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  -- Shift 2 is 14:00-22:00; 13:00-15:00 is one hour before it starts.
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-05 13:00+00', '2027-04-05 15:00+00'));
  IF v_fit->>'fit' <> 'overtime' THEN v_ok := false; v_why := v_why || format(' fit=%s', v_fit->>'fit'); END IF;
  IF (v_fit->>'overtime_minutes')::int <> 60 THEN v_ok := false; v_why := v_why || format(' overtime_minutes=%s (expected 60)', v_fit->>'overtime_minutes'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS6'; ELSE RAISE NOTICE 'FAIL HS6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS6;

\echo 'HS7: shift_fit no_shift --- no home band, and a home band at a node with no pattern at all'
SAVEPOINT sp_HS7;
DO $$
DECLARE v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  -- Maria carries no home_shift_id in the seed.
  v_fit := shift_fit('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003',
                      tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'no_shift' THEN v_ok := false; v_why := v_why || format(' (no home band) fit=%s', v_fit->>'fit'); END IF;

  -- Give Maria a home band; Machining itself (her node) inherits no pattern
  -- from any ancestor (only its child CNC Line has one attached) --- still
  -- no_shift, this time because the NODE has no pattern.
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000001'
    WHERE id = '50000000-0000-0000-0000-000000000001';
  v_fit := shift_fit('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003',
                      tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'no_shift' THEN v_ok := false; v_why := v_why || format(' (node has no pattern) fit=%s', v_fit->>'fit'); END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS7'; ELSE RAISE NOTICE 'FAIL HS7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS7;

\echo 'HS8: shift_fit across a night band (Shift 3, 22:00-06:00) --- in, and overtime the morning after'
SAVEPOINT sp_HS8;
DO $$
DECLARE v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000003'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  -- Fully inside: 23:00 the 5th to 01:00 the 6th.
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-05 23:00+00', '2027-04-06 01:00+00'));
  IF v_fit->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' inside-night fit=%s', v_fit->>'fit'); END IF;

  -- 05:00-07:00 the 6th: the band ends at 06:00, so one hour (06:00-07:00) is
  -- overtime.
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-06 05:00+00', '2027-04-06 07:00+00'));
  IF v_fit->>'fit' <> 'overtime' THEN v_ok := false; v_why := v_why || format(' morning-after fit=%s', v_fit->>'fit'); END IF;
  IF (v_fit->>'overtime_minutes')::int <> 60 THEN v_ok := false; v_why := v_why || format(' morning-after overtime_minutes=%s (expected 60)', v_fit->>'overtime_minutes'); END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS8'; ELSE RAISE NOTICE 'FAIL HS8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS8;

\echo 'HS9: a cell on a DIFFERENT pattern matches the band by name, ignoring case'
SAVEPOINT sp_HS9;
DO $$
DECLARE v_tmpl uuid := gen_random_uuid(); v_fit jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002' -- 'Shift 2', 840-1320
    WHERE id = '50000000-0000-0000-0000-000000000004';

  INSERT INTO shift_templates (id, org_id, name, site_node_id)
    VALUES (v_tmpl, '10000000-0000-0000-0000-000000000001', 'S66a Temp Pattern', '30000000-0000-0000-0000-000000000001');
  -- Same NAME as Elena's home band, different case AND different hours, in a
  -- pattern that is NOT hers --- if this resolves, it can only be by name.
  INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
    VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, 'shift 2', 900, 1400);
  -- Cell 2 normally inherits Assembly's 3x8h; this override makes it run the
  -- temp pattern instead, for this case only (rolled back with everything else).
  INSERT INTO node_shift_templates (node_id, org_id, template_id)
    VALUES ('30000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', v_tmpl)
    ON CONFLICT (node_id) DO UPDATE SET template_id = EXCLUDED.template_id;

  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000008',
                      tstzrange('2027-04-05 15:30+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' fit=%s', v_fit->>'fit'); END IF;
  IF (v_fit->>'band_start_min')::int <> 900 THEN v_ok := false; v_why := v_why || format(' band_start_min=%s (expected 900, the TEMP band''s own hours)', v_fit->>'band_start_min'); END IF;
  IF (v_fit->>'band_end_min')::int <> 1400 THEN v_ok := false; v_why := v_why || format(' band_end_min=%s (expected 1400)', v_fit->>'band_end_min'); END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS9'; ELSE RAISE NOTICE 'FAIL HS9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS9: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS9;

\echo 'HS10: supervisor_shift_allows true by default (no plans_shift_id set)'
SAVEPOINT sp_HS10;
DO $$
DECLARE v_allowed boolean; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_allowed := supervisor_shift_allows('30000000-0000-0000-0000-000000000007',
                 tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  RESET ROLE;
  IF NOT v_allowed THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS10'; ELSE RAISE NOTICE 'FAIL HS10: refused with no plans_shift_id set'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS10: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS10;

\echo 'HS11: supervisor_shift_allows false for a grant that plans Shift 1 with outside_shift=false at 15:00; true again once outside_shift=true'
SAVEPOINT sp_HS11;
DO $$
DECLARE v_allowed boolean; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE profile_grants SET plans_shift_id = '71000000-0000-0000-0000-000000000001', outside_shift = false
    WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Shift 1 is 06:00-14:00; 15:00-16:00 is outside it.
  v_allowed := supervisor_shift_allows('30000000-0000-0000-0000-000000000007',
                 tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  RESET ROLE;
  IF v_allowed THEN v_ok := false; v_why := v_why || ' allowed outside the planned shift with outside_shift=false'; END IF;

  UPDATE profile_grants SET outside_shift = true
    WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_allowed := supervisor_shift_allows('30000000-0000-0000-0000-000000000007',
                 tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  RESET ROLE;
  IF NOT v_allowed THEN v_ok := false; v_why := v_why || ' still refused once outside_shift=true'; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS11'; ELSE RAISE NOTICE 'FAIL HS11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS11: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS11;

\echo 'HS12a: create_assignment''s envelope carries `shift`'
SAVEPOINT sp_HS12a;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
             NULL, '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  RESET ROLE;

  IF v_res->'shift' IS NULL THEN v_ok := false; v_why := v_why || ' no shift key'; END IF;
  IF v_res->'shift'->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' shift.fit=%s', v_res->'shift'->>'fit'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS12a'; ELSE RAISE NOTICE 'FAIL HS12a:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS12a: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS12a;

\echo 'HS12b: reassign_assignment''s envelope carries `shift` for the NEW operator'
SAVEPOINT sp_HS12b;
DO $$
DECLARE v_asg_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Placed with nobody's home band in play (no home_shift_id) so the
  -- reassignment below is the first time Elena's band is asked about.
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000003',
             NULL, '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  v_asg_id := (v_res->'assignment'->>'id')::uuid;
  v_res := reassign_assignment(v_asg_id, '50000000-0000-0000-0000-000000000004');
  RESET ROLE;

  IF v_res->'shift' IS NULL THEN v_ok := false; v_why := v_why || ' no shift key'; END IF;
  IF v_res->'shift'->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' shift.fit=%s', v_res->'shift'->>'fit'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS12b'; ELSE RAISE NOTICE 'FAIL HS12b:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS12b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS12b;

\echo 'HS12c: move_assignment''s envelope carries `shift` at the TARGET'
SAVEPOINT sp_HS12c;
DO $$
DECLARE v_asg_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
             NULL, '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  v_asg_id := (v_res->'assignment'->>'id')::uuid;
  -- Move to Cell 2 (same pattern) at 13:00-15:00 -- one hour of overtime.
  v_res := move_assignment(v_asg_id, '30000000-0000-0000-0000-000000000008',
             tstzrange('2027-04-05 13:00+00', '2027-04-05 15:00+00'));
  RESET ROLE;

  IF v_res->'shift' IS NULL THEN v_ok := false; v_why := v_why || ' no shift key'; END IF;
  IF v_res->'shift'->>'fit' <> 'overtime' THEN v_ok := false; v_why := v_why || format(' shift.fit=%s (expected overtime)', v_res->'shift'->>'fit'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS12c'; ELSE RAISE NOTICE 'FAIL HS12c:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS12c: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS12c;

\echo 'HS12d: move_run''s envelope carries `shift_overtime`'
SAVEPOINT sp_HS12d;
DO $$
DECLARE v_run_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := create_run('30000000-0000-0000-0000-000000000007', '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'), 1, NULL);
  v_run_id := (v_res->'run'->>'id')::uuid;
  PERFORM create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
             v_run_id, NULL, tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  -- Move the run one hour earlier: 14:00-15:00 is still inside Shift 2.
  v_res := move_run(v_run_id, '30000000-0000-0000-0000-000000000007',
             tstzrange('2027-04-05 14:00+00', '2027-04-05 15:00+00'));
  RESET ROLE;

  IF v_res ? 'shift_overtime' IS NOT TRUE THEN v_ok := false; v_why := v_why || ' no shift_overtime key'; END IF;
  IF jsonb_typeof(v_res->'shift_overtime') <> 'array' THEN v_ok := false; v_why := v_why || ' shift_overtime is not an array'; END IF;
  IF jsonb_array_length(v_res->'shift_overtime') <> 0 THEN v_ok := false; v_why := v_why || ' a clean in-band move reported overtime crew'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS12d'; ELSE RAISE NOTICE 'FAIL HS12d:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS12d: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS12d;

\echo 'HS13: the resize guard re-asks supervisor_shift_allows'
SAVEPOINT sp_HS13;
DO $$
DECLARE v_asg_id uuid; v_res jsonb; v_before tstzrange; v_after tstzrange; v_raised boolean := false;
        v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000001'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Placed inside Shift 1 (06:00-14:00), before Ana's grant is restricted.
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
             NULL, '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 08:00+00', '2027-04-05 09:00+00'));
  v_asg_id := (v_res->'assignment'->>'id')::uuid;
  RESET ROLE;

  UPDATE profile_grants SET plans_shift_id = '71000000-0000-0000-0000-000000000001', outside_shift = false
    WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';

  SELECT timerange INTO v_before FROM assignments WHERE id = v_asg_id;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- 15:00-16:00 is outside Shift 1.
    UPDATE assignments SET timerange = tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00')
      WHERE id = v_asg_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%outside_shift%' OR SQLERRM ILIKE '%outside it%' THEN v_raised := true;
    ELSE v_ok := false; v_why := v_why || format(' refused for the wrong reason: %s', SQLERRM);
    END IF;
  END;
  RESET ROLE;
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  IF NOT v_raised THEN v_ok := false; v_why := v_why || ' the resize onto an outside-shift window was NOT refused'; END IF;
  IF v_after IS DISTINCT FROM v_before THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;

  -- A resize that stays inside Shift 1 (09:00-10:00) succeeds.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  UPDATE assignments SET timerange = tstzrange('2027-04-05 09:00+00', '2027-04-05 10:00+00')
    WHERE id = v_asg_id;
  RESET ROLE;
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  IF v_after IS DISTINCT FROM tstzrange('2027-04-05 09:00+00', '2027-04-05 10:00+00') THEN
    v_ok := false; v_why := v_why || ' the in-shift resize did not take';
  END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS13'; ELSE RAISE NOTICE 'FAIL HS13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS13: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS13;

\echo 'HS15: create_assignment itself refuses outside_shift, and the grant of 42501 is not the answer (reviewer gap, session 178)'
SAVEPOINT sp_HS15;
DO $$
DECLARE v_res jsonb; v_count_before int; v_count_after int; v_raised boolean := false;
        v_ok boolean := true; v_why text := '';
BEGIN
  -- The S66-a review found app_outside_shift_message had no EXECUTE grant, so
  -- every writer's refusal path raised 42501 instead of outside_shift; HS13
  -- alone (the resize guard, a definer) could not see it. This case drives the
  -- refusal through create_assignment as the restricted supervisor, then lets
  -- her through with outside_shift = true and reads the overtime envelope.
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000001'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  UPDATE profile_grants SET plans_shift_id = '71000000-0000-0000-0000-000000000001', outside_shift = false
    WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO v_count_before FROM assignments WHERE operator_id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- 15:00-16:00 is outside Shift 1 (06:00-14:00).
    v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
               NULL, '60000000-0000-0000-0000-000000000001',
               tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '42501' THEN v_ok := false; v_why := v_why || format(' permission denied instead of a refusal: %s', SQLERRM);
    ELSIF SQLERRM ILIKE '%outside_shift%' OR SQLERRM ILIKE '%outside it%' THEN v_raised := true;
    ELSE v_ok := false; v_why := v_why || format(' refused for the wrong reason: %s (%s)', SQLERRM, SQLSTATE);
    END IF;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_count_after FROM assignments WHERE operator_id = '50000000-0000-0000-0000-000000000004';
  IF NOT v_raised THEN v_ok := false; v_why := v_why || ' the outside-shift create was NOT refused'; END IF;
  IF v_count_after <> v_count_before THEN v_ok := false; v_why := v_why || ' a row was written anyway'; END IF;

  -- With outside_shift back to true the same placement lands, named as overtime.
  UPDATE profile_grants SET outside_shift = true
    WHERE profile_id = 'a0000000-0000-0000-0000-000000000002'
      AND node_id = '30000000-0000-0000-0000-000000000002';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment('30000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000004',
             NULL, '60000000-0000-0000-0000-000000000001',
             tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  RESET ROLE;
  IF v_res->'shift'->>'fit' IS DISTINCT FROM 'overtime' THEN
    v_ok := false; v_why := v_why || format(' allowed placement not named overtime: %s', v_res->'shift');
  END IF;
  IF (v_res->'shift'->>'overtime_minutes')::int IS DISTINCT FROM 60 THEN
    v_ok := false; v_why := v_why || format(' overtime_minutes=%s, expected 60', v_res->'shift'->>'overtime_minutes');
  END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS15'; ELSE RAISE NOTICE 'FAIL HS15:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS15: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS15;

\echo 'HS14: board_window --- Ana and the company admin read the SAME home_shift_id for Elena'
SAVEPOINT sp_HS14;
DO $$
DECLARE v_ana jsonb; v_admin jsonb; v_elena_ana jsonb; v_elena_admin jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_ana := board_window('plant_1.assembly'::ltree, '2027-04-01', '2027-04-08');
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_admin := board_window('plant_1'::ltree, '2027-04-01', '2027-04-08');
  RESET ROLE;

  SELECT op INTO v_elena_ana FROM jsonb_array_elements(v_ana->'operators') op
    WHERE op->>'id' = '50000000-0000-0000-0000-000000000004';
  SELECT op INTO v_elena_admin FROM jsonb_array_elements(v_admin->'operators') op
    WHERE op->>'id' = '50000000-0000-0000-0000-000000000004';

  IF v_elena_ana IS NULL OR v_elena_admin IS NULL THEN
    v_ok := false; v_why := v_why || ' Elena missing from one of the two payloads';
  ELSIF v_elena_ana->>'home_shift_id' IS DISTINCT FROM v_elena_admin->>'home_shift_id' THEN
    v_ok := false; v_why := v_why || format(' Ana sees %s, admin sees %s', v_elena_ana->>'home_shift_id', v_elena_admin->>'home_shift_id');
  ELSIF v_elena_ana->>'home_shift_id' <> '71000000-0000-0000-0000-000000000002' THEN
    v_ok := false; v_why := v_why || ' neither sees the band that was set';
  END IF;

  -- `me`: Ana's own grant carries no restriction by default (HS0's state).
  IF v_ana->'me'->>'outside_shift' IS DISTINCT FROM 'true' AND v_ana->'me' IS NOT NULL THEN
    v_ok := false; v_why := v_why || format(' Ana''s me=%s', v_ana->'me');
  END IF;

  IF v_ok THEN RAISE NOTICE 'PASS HS14'; ELSE RAISE NOTICE 'FAIL HS14:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL HS14: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS14;

\echo 'HS_OWNER: owner context (no jwt sub) resolves shift_fit/supervisor_shift_allows unbounded'
SAVEPOINT sp_HS_OWNER;
DO $$
DECLARE v_fit jsonb; v_allowed boolean; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE operators SET home_shift_id = '71000000-0000-0000-0000-000000000002'
    WHERE id = '50000000-0000-0000-0000-000000000004';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_fit := shift_fit('50000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007',
                      tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  v_allowed := supervisor_shift_allows('30000000-0000-0000-0000-000000000007',
                 tstzrange('2027-04-05 15:00+00', '2027-04-05 16:00+00'));
  IF v_fit->>'fit' <> 'in' THEN v_ok := false; v_why := v_why || format(' shift_fit fit=%s in owner context', v_fit->>'fit'); END IF;
  IF NOT v_allowed THEN v_ok := false; v_why := v_why || ' supervisor_shift_allows refused in owner context'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS HS_OWNER'; ELSE RAISE NOTICE 'FAIL HS_OWNER:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL HS_OWNER: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_HS_OWNER;

ROLLBACK;

\echo '98_home_shift_test.sql complete (HS0-HS15, HS12a-d, HS_OWNER)'
