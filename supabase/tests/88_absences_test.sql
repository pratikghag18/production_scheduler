-- ============================================================================
-- 88_absences_test.sql --- migration 0066 (R-357).
--
-- An absence is a person, a date range and a reason, recorded by a supervisor or
-- admin OF THE PERSON'S PLACE, imported by file, and treated on the board and in
-- Copy Week as a clash of its own kind under the plant's warn-or-block policy.
--
-- Every answer and refusal is measured as `authenticated` with a real jwt sub:
-- psql connects as the superuser, who bypasses RLS and whose app_current_org()
-- is NULL, which is NOT the context these cases are about.
--
-- FIXTURE --- the SEED's org 1 (Northwind), whose shape is fixed:
--   Plant 1 (root 30..01)
--     Assembly (30..02)          <- Ana supervises (a2)
--       Line 1 (30..04)
--         Cell 1 (30..07)        <- schedulable; where runs are placed
--     Machining (30..03)         <- Marco supervises (a3)
--   People: Elena (50..04) home Assembly, owned by Plant 1
--           Maria (50..01) home Machining, owned by Plant 1
--   Product: Widget X (60..01), made at Plant 1
--   a1 company admin; a viewer (b1) added below with a viewer grant on Plant 1.
--
-- So Ana may record Elena's absence (Assembly is her place) and may NOT record
-- Maria's (Machining is not); Marco is the mirror. The scheduling cases place a
-- run at Cell 1 in a clean future week and set the plant's policy per case.
--
-- CASES
--   AB0  premises: the table exists, RLS is on, Elena/Maria's homes are as above
--   AB1  the exclusion constraint: one person cannot hold two overlapping absences
--   AB2  set_absence: Ana records Elena (her place); the row reads back
--   AB3  set_absence: Ana records Maria (another place) -> not_permitted
--   AB4  set_absence: Marco records Maria (his place) -> ok
--   AB5  remove_absence: Ana removes what she recorded; Ana cannot remove Maria's
--   AB6  a viewer may READ an absence and set_absence refuses them not_permitted
--   AB7  a direct INSERT by authenticated is refused (no write policy)
--   AB8  absence_overlap boundary: an absence ENDING on the shift's start day
--        overlaps; a shift ENDING at midnight on the absence's start day does not
--   AB9  create_assignment over an absence: block refuses `absent`, warn allows
--        with the absence in the payload
--   AB10 move_run over an absence: block refuses `absent`, warn moves with the
--        absence in `absence_warnings`
--   AB11 reassign_assignment over an absence: block refuses `absent`, warn allows
--   AB12 copy_week_plan: an absent assignment is a clash reason `absent`, offered
--        ["prior"] under block and ["prior","copied"] under warn
--   AB13 the definer predicate answers for Ana about an overlapping absence, and
--        is null-safe for an unknown person
--   AB14 grants: set/remove/import_absence and absence_overlap authenticated-only
--
-- 0069 (R-359) --- a part-day absence, judged by the HOURS, not the day:
--   AB15 absence_overlap by the hours: a part-day 09:00-13:00 absence clashes
--        with an overlapping shift and not with one outside those hours
--   AB16 the same person may hold two NON-overlapping part-day absences on one
--        calendar day
--   AB17 the same person cannot hold two OVERLAPPING part-day absences on one
--        calendar day (the part-day partial exclusion)
--   AB18 after the exclusion split, a whole-day absence still cannot overlap
--        another whole-day absence (the whole-day partial exclusion)
--   AB19 set_absence with only one of p_starts_at/p_ends_at refuses
--        invalid_argument
--   AB20 set_absence with a part-day window spanning two different days (p_from
--        <> p_to) refuses invalid_argument
--   AB21 a whole-day hit carries no starts_at/ends_at keys at all --- byte for
--        byte 0066's answer
--   AB22 a part-day row INSIDE a whole-day absence for the same person is
--        allowed, and absence_overlap still answers absent for either
--   AB23 a shift starting exactly when a part-day absence ENDS does not clash
--        (half-open, touching is not overlapping)
--   AB24 a shift ending exactly when a part-day absence STARTS does not clash
--        (half-open, touching is not overlapping)
--   AB25 the same person may hold two part-day absences that TOUCH (08:00-09:00
--        and 09:00-10:00), both accepted by absences_part_day_excl
--
-- 0070 (R-361) --- a plain resize (PATCH timerange, no RPC) asks the same two
-- questions the four scheduler writers ask:
--   AB26 a resize onto an absence under BLOCK is refused `absent`
--   AB27 the SAME resize under WARN succeeds and the row really moved (read
--        back, not just "no error")
--   AB28 a resize that does not overlap any absence succeeds under BLOCK
--   AB28b the same clean resize succeeds under WARN too
--   AB29 an efficiency-only UPDATE is untouched even when the row already
--        overlaps an absence recorded after it was placed, under BLOCK ---
--        the trigger's WHEN clause never asks
--   AB30 move_run's own internal UPDATE over an absence under WARN still
--        succeeds with the trigger installed (no double refusal) and the
--        crew row actually moved
--   AB31 reassign_assignment's own internal UPDATE over an absence under WARN
--        still succeeds with the trigger installed and the operator actually
--        changed
--   AB32 delete_owned_row('operator', ...) clearing a departed person's
--        operator_id to NULL on a history row, on a node that requires a
--        skill they never held, under BLOCK --- the trigger's WHEN clause
--        (NEW.operator_id IS NOT NULL) keeps it from refusing the deletion
--
-- 0071 (DEF-0019) --- the resize guard's own owner exemption, the same key
-- 0068 already settled on for app_resolve_node_setting/resolve_shift_template:
--   AB33 owner context (no jwt sub at all) is exempt: a resize onto an
--        absence under BLOCK succeeds, read back to confirm it really moved
--   AB34 a signed-in session with NO user_profiles row (DEF-0019's own
--        repro, not owner context) is still bound: the identical resize is
--        refused and the row does not move --- the case that would go red if
--        the exemption were ever "corrected" to app_current_org() IS NULL
-- ============================================================================

BEGIN;

-- A viewer with a read-everything grant on Plant 1, for AB6.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'vic@northwind.example') ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000b1', 'viewer', 'run') ON CONFLICT DO NOTHING;
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', 'viewer') ON CONFLICT DO NOTHING;

\echo 'AB0: premises --- absences table with RLS, Elena homed at Assembly, Maria at Machining'
SAVEPOINT sp_AB0;
DO $$
DECLARE v_rls boolean; v_eh uuid; v_mh uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE relname = 'absences';
  SELECT home_node_id INTO v_eh FROM operators WHERE id = '50000000-0000-0000-0000-000000000004';
  SELECT home_node_id INTO v_mh FROM operators WHERE id = '50000000-0000-0000-0000-000000000001';
  IF NOT v_rls THEN v_ok := false; v_why := v_why || ' RLS off'; END IF;
  IF v_eh <> '30000000-0000-0000-0000-000000000002' THEN v_ok := false; v_why := v_why || ' Elena not homed at Assembly'; END IF;
  IF v_mh <> '30000000-0000-0000-0000-000000000003' THEN v_ok := false; v_why := v_why || ' Maria not homed at Machining'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB0'; ELSE RAISE NOTICE 'FAIL AB0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL AB0: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB0;

\echo 'AB1: the exclusion constraint --- one person cannot hold two overlapping absences'
SAVEPOINT sp_AB1;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_raised boolean := false; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-02-01','2027-02-10','[]'), 'holiday');
  BEGIN
    INSERT INTO absences (org_id, operator_id, daterange, reason)
      VALUES (v_org, v_el, daterange('2027-02-05','2027-02-15','[]'), 'holiday again');
  EXCEPTION WHEN exclusion_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN v_ok := false; v_why := ' the overlapping second absence was accepted'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB1'; ELSE RAISE NOTICE 'FAIL AB1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL AB1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB1;

\echo 'AB2: set_absence --- Ana records Elena (Assembly is her place); the row reads back'
SAVEPOINT sp_AB2;
DO $$
DECLARE v_res jsonb; v_id uuid; v_reason text; v_from text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence('50000000-0000-0000-0000-000000000004', '2027-03-02', '2027-03-06', '  sick  ');
  RESET ROLE;
  v_id := (v_res->>'id')::uuid;
  v_reason := v_res->>'reason';
  v_from := v_res->>'daterange';
  IF v_id IS NULL THEN v_ok := false; v_why := v_why || ' no id'; END IF;
  IF v_reason <> 'sick' THEN v_ok := false; v_why := v_why || format(' reason=%s (not trimmed to sick)', v_reason); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB2'; ELSE RAISE NOTICE 'FAIL AB2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB2;

\echo 'AB3: set_absence --- Ana records Maria (Machining is NOT her place) -> not_permitted'
SAVEPOINT sp_AB3;
DO $$
DECLARE v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_absence('50000000-0000-0000-0000-000000000001', '2027-03-02', '2027-03-06', 'sick');
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB3: Ana recorded Maria''s absence';
  ELSIF v_code NOT ILIKE '%not_permitted%' AND v_code NOT ILIKE '%cannot record%' THEN
    RAISE NOTICE 'FAIL AB3: refused but not as not_permitted: %', v_code;
  ELSE RAISE NOTICE 'PASS AB3'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB3;

\echo 'AB4: set_absence --- Marco records Maria (Machining is his place) -> ok'
SAVEPOINT sp_AB4;
DO $$
DECLARE v_res jsonb; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a3', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence('50000000-0000-0000-0000-000000000001', '2027-03-02', '2027-03-06', 'sick');
  RESET ROLE;
  IF (v_res->>'id') IS NULL THEN RAISE NOTICE 'FAIL AB4: no row'; ELSE RAISE NOTICE 'PASS AB4'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB4;

\echo 'AB5: remove_absence --- Ana removes Elena''s; Ana cannot remove Maria''s (Marco''s place)'
SAVEPOINT sp_AB5;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_ea uuid; v_ma uuid; v_gone int; v_ok boolean := true; v_why text := '';
BEGIN
  -- Seed two absences as owner: one for Elena (Assembly), one for Maria (Machining).
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, '50000000-0000-0000-0000-000000000004', daterange('2027-04-01','2027-04-03','[]'), 'a')
    RETURNING id INTO v_ea;
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, '50000000-0000-0000-0000-000000000001', daterange('2027-04-01','2027-04-03','[]'), 'b')
    RETURNING id INTO v_ma;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  PERFORM remove_absence(v_ea);          -- Elena: allowed
  BEGIN
    PERFORM remove_absence(v_ma);        -- Maria: must refuse
    v_ok := false; v_why := v_why || ' Ana removed Maria''s absence';
  EXCEPTION WHEN OTHERS THEN NULL;       -- expected not_permitted
  END;
  RESET ROLE;
  SELECT count(*) INTO v_gone FROM absences WHERE id = v_ea;
  IF v_gone <> 0 THEN v_ok := false; v_why := v_why || ' Elena''s absence still present'; END IF;
  IF (SELECT count(*) FROM absences WHERE id = v_ma) <> 1 THEN v_ok := false; v_why := v_why || ' Maria''s absence was removed'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB5'; ELSE RAISE NOTICE 'FAIL AB5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB5;

\echo 'AB6: a viewer READS an absence and set_absence refuses them'
SAVEPOINT sp_AB6;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_seen int; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, '50000000-0000-0000-0000-000000000004', daterange('2027-05-01','2027-05-03','[]'), 'c');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM absences WHERE operator_id = '50000000-0000-0000-0000-000000000004';
  BEGIN
    PERFORM set_absence('50000000-0000-0000-0000-000000000004', '2027-06-01', '2027-06-02', 'x');
    v_ok := false; v_why := v_why || ' the viewer recorded an absence';
  EXCEPTION WHEN OTHERS THEN NULL;   -- expected not_permitted
  END;
  RESET ROLE;
  IF v_seen < 1 THEN v_ok := false; v_why := v_why || ' the viewer could not read the absence'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB6'; ELSE RAISE NOTICE 'FAIL AB6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB6;

\echo 'AB7: a direct INSERT by authenticated is refused (there is no write policy)'
SAVEPOINT sp_AB7;
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO absences (org_id, operator_id, daterange, reason)
      VALUES ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004',
              daterange('2027-07-01','2027-07-02','[]'), 'direct');
  EXCEPTION WHEN OTHERS THEN v_ok := true;   -- RLS/privilege refuses it
  END;
  RESET ROLE;
  IF v_ok THEN RAISE NOTICE 'PASS AB7'; ELSE RAISE NOTICE 'FAIL AB7: a direct insert was accepted'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB7;

\echo 'AB8: absence_overlap boundary --- absence ending on the shift start day overlaps; a shift ending at midnight on the absence start day does not'
SAVEPOINT sp_AB8;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_a jsonb; v_b jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  -- Absence Jan 1..5 (ends ON Jan 5).
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-01-01','2027-01-05','[]'), 'leave');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Shift STARTING on Jan 5 (06:00-14:00): overlaps the absence ending Jan 5.
  v_a := absence_overlap(v_el, tstzrange('2027-01-05 06:00+00','2027-01-05 14:00+00'));
  -- Shift ENDING exactly at midnight Jan 5 (Jan 4 06:00 -> Jan 5 00:00): touches
  -- only Jan 4, so a DIFFERENT absence starting Jan 5 would not clash. Use the
  -- SAME absence but a shift wholly on Jan 6 to confirm no false positive too.
  v_b := absence_overlap(v_el, tstzrange('2027-01-06 06:00+00','2027-01-06 14:00+00'));
  RESET ROLE;
  IF NOT (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' Jan-5 shift not flagged'; END IF;
  IF (v_a->>'reason') <> 'leave' THEN v_ok := false; v_why := v_why || ' reason missing'; END IF;
  IF (v_b->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' Jan-6 shift wrongly flagged'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB8'; ELSE RAISE NOTICE 'FAIL AB8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB8;

\echo 'AB8b: a shift ENDING at midnight on the absence start day does not clash'
SAVEPOINT sp_AB8b;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004'; v_a jsonb; v_ok boolean := true;
BEGIN
  -- Absence starting Jan 5.
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-01-05','2027-01-08','[]'), 'leave');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Shift Jan 4 06:00 -> Jan 5 00:00: touches only Jan 4.
  v_a := absence_overlap(v_el, tstzrange('2027-01-04 06:00+00','2027-01-05 00:00+00'));
  RESET ROLE;
  IF (v_a->>'absent')::boolean THEN RAISE NOTICE 'FAIL AB8b: midnight-ending shift wrongly flagged';
  ELSE RAISE NOTICE 'PASS AB8b'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB8b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB8b;

\echo 'AB9: create_assignment over an absence under WARN --- allowed, absence in payload'
SAVEPOINT sp_AB9;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2027-08-03 06:00+00','2027-08-03 14:00+00');
        v_run jsonb; v_run_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-08-03','2027-08-03','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_res := create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  RESET ROLE;
  IF (v_res->'assignment'->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' warn did not place'; END IF;
  IF NOT (v_res->'absence'->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' payload missing absence'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB9'; ELSE RAISE NOTICE 'FAIL AB9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB9: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB9;

\echo 'AB9b: create_assignment over an absence under BLOCK --- refuses `absent`'
SAVEPOINT sp_AB9b;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2027-08-03 06:00+00','2027-08-03 14:00+00');
        v_run jsonb; v_run_id uuid; v_code text; v_ok boolean := true;
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-08-03','2027-08-03','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  BEGIN
    PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB9b: block did not refuse';
  ELSIF v_code NOT ILIKE '%absent%' THEN RAISE NOTICE 'FAIL AB9b: refused but not absent: %', v_code;
  ELSE RAISE NOTICE 'PASS AB9b'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB9b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB9b;

\echo 'AB10: move_run onto an absence under WARN --- moves, absence in absence_warnings'
SAVEPOINT sp_AB10;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run jsonb; v_run_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-09-10','2027-09-10','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2027-09-01 06:00+00','2027-09-01 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-09-01 06:00+00','2027-09-01 14:00+00'));
  v_res := move_run(v_run_id, v_cell, tstzrange('2027-09-10 06:00+00','2027-09-10 14:00+00'));
  RESET ROLE;
  IF jsonb_array_length(coalesce(v_res->'absence_warnings','[]'::jsonb)) < 1
  THEN v_ok := false; v_why := ' missing absence_warnings'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB10'; ELSE RAISE NOTICE 'FAIL AB10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB10: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB10;

\echo 'AB10b: move_run onto an absence under BLOCK --- refuses `absent`'
SAVEPOINT sp_AB10b;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run jsonb; v_run_id uuid; v_code text; v_ok boolean := true;
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-09-10','2027-09-10','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Place clear of the absence (an override lets a block placement exist to move).
  v_run := create_run(v_cell, v_wx, tstzrange('2027-09-01 06:00+00','2027-09-01 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-09-01 06:00+00','2027-09-01 14:00+00'));
  BEGIN
    PERFORM move_run(v_run_id, v_cell, tstzrange('2027-09-10 06:00+00','2027-09-10 14:00+00'));
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB10b: block move not refused';
  ELSIF v_code NOT ILIKE '%absent%' THEN RAISE NOTICE 'FAIL AB10b: refused but not absent: %', v_code;
  ELSE RAISE NOTICE 'PASS AB10b'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB10b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB10b;

\echo 'AB11: reassign_assignment onto an absence under WARN --- allowed, absence in payload'
SAVEPOINT sp_AB11;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_tom uuid := '50000000-0000-0000-0000-000000000005';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2027-10-05 06:00+00','2027-10-05 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-10-05','2027-10-05','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_tom, v_run_id, NULL, v_win);
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  v_res := reassign_assignment(v_asg_id, v_el);
  RESET ROLE;
  IF NOT (v_res->'absence'->>'absent')::boolean THEN v_ok := false; v_why := ' payload missing absence'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB11'; ELSE RAISE NOTICE 'FAIL AB11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB11: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB11;

\echo 'AB11b: reassign_assignment onto an absence under BLOCK --- refuses `absent`'
SAVEPOINT sp_AB11b;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_tom uuid := '50000000-0000-0000-0000-000000000005';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2027-11-05 06:00+00','2027-11-05 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid; v_code text; v_ok boolean := true;
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-11-05','2027-11-05','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_tom, v_run_id, NULL, v_win);  -- Tom is not absent
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  BEGIN
    PERFORM reassign_assignment(v_asg_id, v_el);   -- Elena IS absent -> refuse
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB11b: block reassign onto the absence was accepted';
  ELSIF v_code NOT ILIKE '%absent%' THEN RAISE NOTICE 'FAIL AB11b: refused but not absent: %', v_code;
  ELSE RAISE NOTICE 'PASS AB11b'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB11b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB11b;

\echo 'AB12: copy_week_plan --- an absent assignment is a clash reason `absent`, ["prior","copied"] under warn and ["prior"] under block'
SAVEPOINT sp_AB12;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_plant uuid := '30000000-0000-0000-0000-000000000001';
        v_src date := '2027-12-06';   -- a clean Monday
        v_tgt date := '2027-12-13';
        v_run jsonb; v_run_id uuid; v_plan jsonb; v_item jsonb; v_ok boolean := true; v_why text := '';
        v_reason text; v_choices jsonb;
BEGIN
  -- A source-week run + Elena; Elena absent in the TARGET week (Dec 14).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2027-12-07 06:00+00','2027-12-07 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  PERFORM create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-12-07 06:00+00','2027-12-07 14:00+00'));
  RESET ROLE;
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-12-14','2027-12-14','[]'), 'sick');

  -- WARN plan.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan(v_plant, v_src, v_tgt);
  RESET ROLE;
  SELECT i INTO v_item FROM jsonb_array_elements(v_plan->'items') i
   WHERE i->>'kind' = 'assignment' AND i->'clash'->>'reason' = 'absent' LIMIT 1;
  IF v_item IS NULL THEN v_ok := false; v_why := v_why || ' no `absent` clash in warn plan';
  ELSE
    v_choices := v_item->'clash'->'choices';
    IF NOT (v_choices ? 'copied') THEN v_ok := false; v_why := v_why || ' warn plan did not offer copied'; END IF;
  END IF;

  -- BLOCK plan: only ["prior"].
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES (v_plant, 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan(v_plant, v_src, v_tgt);
  RESET ROLE;
  SELECT i INTO v_item FROM jsonb_array_elements(v_plan->'items') i
   WHERE i->>'kind' = 'assignment' AND i->'clash'->>'reason' = 'absent' LIMIT 1;
  IF v_item IS NULL THEN v_ok := false; v_why := v_why || ' no `absent` clash in block plan';
  ELSIF (v_item->'clash'->'choices') ? 'copied' THEN v_ok := false; v_why := v_why || ' block plan offered copied';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB12'; ELSE RAISE NOTICE 'FAIL AB12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB12: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB12;

\echo 'AB13: the definer predicate answers for Ana about an overlapping absence, and is null-safe for an unknown person'
SAVEPOINT sp_AB13;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_a jsonb; v_b jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2028-01-10','2028-01-12','[]'), 'leave');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_a := absence_overlap(v_el, tstzrange('2028-01-11 06:00+00','2028-01-11 14:00+00'));
  v_b := absence_overlap('99999999-9999-9999-9999-999999999999', tstzrange('2028-01-11 06:00+00','2028-01-11 14:00+00'));
  RESET ROLE;
  IF NOT (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' Ana got no answer'; END IF;
  IF (v_b->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' unknown person flagged absent'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB13'; ELSE RAISE NOTICE 'FAIL AB13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB13: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB13;

\echo 'AB14: grants --- set/remove/import_absences and absence_overlap are authenticated-only'
SAVEPOINT sp_AB14;
DO $$
DECLARE r record; v_ok boolean := true; v_why text := '';
BEGIN
  -- 0069: set_absence's signature grew two trailing optional instants; the old
  -- five-argument function was DROPPED in the same migration (see 0069's
  -- header), so this checks the grant on the ONE set_absence that exists now.
  FOR r IN SELECT unnest(ARRAY[
      'set_absence(uuid, date, date, text, text, timestamptz, timestamptz)',
      'remove_absence(uuid)',
      'import_absences(jsonb)',
      'absence_overlap(uuid, tstzrange)']) AS sig
  LOOP
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE')
       OR has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('public', r.sig, 'EXECUTE') THEN
      v_ok := false; v_why := v_why || ' ' || r.sig;
    END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS AB14'; ELSE RAISE NOTICE 'FAIL AB14: wrong grants on%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL AB14: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB14;

\echo 'AB15: absence_overlap by the HOURS --- part-day 09:00-13:00 clashes with an overlapping shift and not with one outside those hours'
SAVEPOINT sp_AB15;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_res jsonb; v_hit jsonb; v_miss jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence(v_el, '2027-06-10', '2027-06-10', 'dentist', NULL,
                        '2027-06-10 09:00+00'::timestamptz, '2027-06-10 13:00+00'::timestamptz);
  -- A shift 10:00-12:00 overlaps the 09:00-13:00 absence.
  v_hit := absence_overlap(v_el, tstzrange('2027-06-10 10:00+00','2027-06-10 12:00+00'));
  -- A shift 14:00-16:00, same day, does NOT overlap those hours.
  v_miss := absence_overlap(v_el, tstzrange('2027-06-10 14:00+00','2027-06-10 16:00+00'));
  RESET ROLE;
  IF (v_res->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' the part-day absence was not written'; END IF;
  IF NOT (v_hit->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' overlapping shift not flagged'; END IF;
  IF (v_hit->>'starts_at') IS NULL OR (v_hit->>'ends_at') IS NULL THEN v_ok := false; v_why := v_why || ' missing starts_at/ends_at'; END IF;
  IF (v_miss->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' non-overlapping shift wrongly flagged'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB15'; ELSE RAISE NOTICE 'FAIL AB15:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB15: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB15;

\echo 'AB16: the same person may hold two NON-overlapping part-day absences on one calendar day'
SAVEPOINT sp_AB16;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_r1 jsonb; v_r2 jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_r1 := set_absence(v_el, '2027-06-11', '2027-06-11', 'morning appointment', NULL,
                       '2027-06-11 08:00+00'::timestamptz, '2027-06-11 09:00+00'::timestamptz);
  v_r2 := set_absence(v_el, '2027-06-11', '2027-06-11', 'evening appointment', NULL,
                       '2027-06-11 17:00+00'::timestamptz, '2027-06-11 18:00+00'::timestamptz);
  RESET ROLE;
  IF (v_r1->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' first absence not written'; END IF;
  IF (v_r2->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' second absence not written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB16'; ELSE RAISE NOTICE 'FAIL AB16:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB16: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB16;

\echo 'AB17: the same person cannot hold two OVERLAPPING part-day absences on one calendar day'
SAVEPOINT sp_AB17;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_raised boolean := false; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_absence(v_el, '2027-06-12', '2027-06-12', 'first', NULL,
                       '2027-06-12 09:00+00'::timestamptz, '2027-06-12 13:00+00'::timestamptz);
  BEGIN
    PERFORM set_absence(v_el, '2027-06-12', '2027-06-12', 'second', NULL,
                         '2027-06-12 12:00+00'::timestamptz, '2027-06-12 14:00+00'::timestamptz);
  EXCEPTION WHEN OTHERS THEN v_raised := true;
  END;
  RESET ROLE;
  IF NOT v_raised THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB17'; ELSE RAISE NOTICE 'FAIL AB17: the overlapping second part-day absence was accepted'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB17: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB17;

\echo 'AB18: after the exclusion split, a whole-day absence still cannot overlap another whole-day absence'
SAVEPOINT sp_AB18;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_raised boolean := false; v_ok boolean := true;
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-06-20','2027-06-25','[]'), 'holiday');
  BEGIN
    INSERT INTO absences (org_id, operator_id, daterange, reason)
      VALUES (v_org, v_el, daterange('2027-06-23','2027-06-28','[]'), 'holiday again');
  EXCEPTION WHEN exclusion_violation THEN v_raised := true;
  END;
  IF NOT v_raised THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB18'; ELSE RAISE NOTICE 'FAIL AB18: the overlapping second whole-day absence was accepted'; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL AB18: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB18;

\echo 'AB19: set_absence with only one of p_starts_at/p_ends_at refuses invalid_argument'
SAVEPOINT sp_AB19;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_absence(v_el, '2027-06-13', '2027-06-13', 'partial', NULL,
                         '2027-06-13 09:00+00'::timestamptz, NULL);
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB19: one-sided times were accepted';
  ELSIF v_code NOT ILIKE '%invalid_argument%' AND v_code NOT ILIKE '%start and an end time%' THEN
    RAISE NOTICE 'FAIL AB19: refused but not as invalid_argument: %', v_code;
  ELSE RAISE NOTICE 'PASS AB19'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB19: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB19;

\echo 'AB20: a part-day window spanning two different days (p_from <> p_to) refuses invalid_argument'
SAVEPOINT sp_AB20;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_code text; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM set_absence(v_el, '2027-06-14', '2027-06-15', 'two days', NULL,
                         '2027-06-14 09:00+00'::timestamptz, '2027-06-15 13:00+00'::timestamptz);
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB20: a two-day part-day absence was accepted';
  ELSIF v_code NOT ILIKE '%invalid_argument%' AND v_code NOT ILIKE '%single day%' THEN
    RAISE NOTICE 'FAIL AB20: refused but not as invalid_argument: %', v_code;
  ELSE RAISE NOTICE 'PASS AB20'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB20: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB20;

\echo 'AB21: a whole-day hit carries no starts_at/ends_at keys at all --- byte for byte 0066''s answer'
SAVEPOINT sp_AB21;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_a jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-06-16','2027-06-16','[]'), 'whole day');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_a := absence_overlap(v_el, tstzrange('2027-06-16 06:00+00','2027-06-16 14:00+00'));
  RESET ROLE;
  IF NOT (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' not flagged'; END IF;
  IF v_a ? 'starts_at' OR v_a ? 'ends_at' THEN v_ok := false; v_why := v_why || ' whole-day hit carries starts_at/ends_at'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB21'; ELSE RAISE NOTICE 'FAIL AB21:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB21: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB21;

\echo 'AB22: a part-day row INSIDE a whole-day absence for the same person is allowed, and absence_overlap still answers absent for either'
SAVEPOINT sp_AB22;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_res jsonb; v_a jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-06-17','2027-06-17','[]'), 'whole day');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence(v_el, '2027-06-17', '2027-06-17', 'dentist inside', NULL,
                        '2027-06-17 09:00+00'::timestamptz, '2027-06-17 10:00+00'::timestamptz);
  v_a := absence_overlap(v_el, tstzrange('2027-06-17 09:30+00','2027-06-17 09:45+00'));
  RESET ROLE;
  IF (v_res->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' the part-day row inside the whole-day absence was refused'; END IF;
  IF NOT (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' absence_overlap did not flag it'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB22'; ELSE RAISE NOTICE 'FAIL AB22:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB22: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB22;

\echo 'AB23: a shift starting exactly when a part-day absence ENDS does not clash (half-open, touching is not overlapping)'
SAVEPOINT sp_AB23;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_res jsonb; v_a jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence(v_el, '2027-06-18', '2027-06-18', 'dentist', NULL,
                        '2027-06-18 09:00+00'::timestamptz, '2027-06-18 13:00+00'::timestamptz);
  -- A shift starting exactly at 13:00, the absence's own ends_at.
  v_a := absence_overlap(v_el, tstzrange('2027-06-18 13:00+00','2027-06-18 15:00+00'));
  RESET ROLE;
  IF (v_res->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' the part-day absence was not written'; END IF;
  IF (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' a shift starting exactly when the absence ends was wrongly flagged'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB23'; ELSE RAISE NOTICE 'FAIL AB23:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB23: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB23;

\echo 'AB24: a shift ending exactly when a part-day absence STARTS does not clash (half-open, touching is not overlapping)'
SAVEPOINT sp_AB24;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_res jsonb; v_a jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := set_absence(v_el, '2027-06-19', '2027-06-19', 'dentist', NULL,
                        '2027-06-19 09:00+00'::timestamptz, '2027-06-19 13:00+00'::timestamptz);
  -- A shift ending exactly at 09:00, the absence's own starts_at.
  v_a := absence_overlap(v_el, tstzrange('2027-06-19 07:00+00','2027-06-19 09:00+00'));
  RESET ROLE;
  IF (v_res->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' the part-day absence was not written'; END IF;
  IF (v_a->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' a shift ending exactly when the absence starts was wrongly flagged'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB24'; ELSE RAISE NOTICE 'FAIL AB24:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB24: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB24;

\echo 'AB25: the same person may hold two part-day absences that TOUCH (08:00-09:00 and 09:00-10:00)'
SAVEPOINT sp_AB25;
DO $$
DECLARE v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_r1 jsonb; v_r2 jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_r1 := set_absence(v_el, '2027-06-21', '2027-06-21', 'first', NULL,
                       '2027-06-21 08:00+00'::timestamptz, '2027-06-21 09:00+00'::timestamptz);
  v_r2 := set_absence(v_el, '2027-06-21', '2027-06-21', 'second', NULL,
                       '2027-06-21 09:00+00'::timestamptz, '2027-06-21 10:00+00'::timestamptz);
  RESET ROLE;
  IF (v_r1->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' first (touching) absence not written'; END IF;
  IF (v_r2->>'id') IS NULL THEN v_ok := false; v_why := v_why || ' second (touching) absence not written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB25'; ELSE RAISE NOTICE 'FAIL AB25:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB25: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB25;

\echo 'AB26: a plain resize (PATCH timerange, no RPC) onto an absence under BLOCK --- refuses `absent`'
SAVEPOINT sp_AB26;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_code text; v_ok boolean := true;
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-11-03','2027-11-03','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Placed clear of the absence --- create_assignment's own pre-check would
  -- otherwise refuse the SETUP, not the resize this case is about.
  v_run := create_run(v_cell, v_wx, tstzrange('2027-11-01 06:00+00','2027-11-01 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-11-01 06:00+00','2027-11-01 14:00+00'));
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  BEGIN
    -- docs/api.md §4: a plain time resize is an ordinary PostgREST table
    -- update, never an RPC. This is that write, verbatim.
    UPDATE assignments SET timerange = tstzrange('2027-11-03 06:00+00','2027-11-03 14:00+00')
      WHERE id = v_asg_id;
    v_ok := false;
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE NOTICE 'FAIL AB26: block resize onto absence was not refused';
  ELSIF v_code NOT ILIKE '%absent%' THEN RAISE NOTICE 'FAIL AB26: refused but not `absent`: %', v_code;
  ELSE RAISE NOTICE 'PASS AB26'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB26: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB26;

\echo 'AB27: the SAME resize onto an absence under WARN --- succeeds, and the row really moved'
SAVEPOINT sp_AB27;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_new tstzrange := tstzrange('2027-11-13 06:00+00','2027-11-13 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_after tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-11-13','2027-11-13','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2027-11-11 06:00+00','2027-11-11 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-11-11 06:00+00','2027-11-11 14:00+00'));
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  UPDATE assignments SET timerange = v_new WHERE id = v_asg_id;
  -- CLAUDE.md §4: a write that reports success can have changed nothing.
  -- Read the row back rather than trusting the absence of an exception.
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF v_after IS DISTINCT FROM v_new THEN v_ok := false; v_why := v_why || ' the row did not actually move'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB27'; ELSE RAISE NOTICE 'FAIL AB27:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB27: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB27;

\echo 'AB28: a resize NOT overlapping any absence succeeds under BLOCK'
SAVEPOINT sp_AB28;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_new tstzrange := tstzrange('2027-12-02 06:00+00','2027-12-02 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_after tstzrange; v_ok boolean := true;
BEGIN
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2027-12-01 06:00+00','2027-12-01 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-12-01 06:00+00','2027-12-01 14:00+00'));
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  UPDATE assignments SET timerange = v_new WHERE id = v_asg_id;
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF v_after IS DISTINCT FROM v_new THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB28'; ELSE RAISE NOTICE 'FAIL AB28: a clean resize under block was refused or did not move'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB28: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB28;

\echo 'AB28b: the same clean resize succeeds under WARN too'
SAVEPOINT sp_AB28b;
DO $$
DECLARE v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_new tstzrange := tstzrange('2027-12-16 06:00+00','2027-12-16 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_after tstzrange; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2027-12-15 06:00+00','2027-12-15 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2027-12-15 06:00+00','2027-12-15 14:00+00'));
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  UPDATE assignments SET timerange = v_new WHERE id = v_asg_id;
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF v_after IS DISTINCT FROM v_new THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB28b'; ELSE RAISE NOTICE 'FAIL AB28b: a clean resize under warn was refused or did not move'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB28b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB28b;

\echo 'AB29: an efficiency-only UPDATE is untouched, even over an absence recorded after placement, under BLOCK'
SAVEPOINT sp_AB29;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2027-12-20 06:00+00','2027-12-20 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_eff numeric; v_ok boolean := true;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  RESET ROLE;
  -- Recorded AFTER placement, and the plant switched to `block` AFTER too ---
  -- this existing row NOW overlaps an absence and a fresh placement here
  -- would be refused, but nobody asked this row to move.
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2027-12-20','2027-12-20','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  UPDATE assignments SET efficiency = 0.900 WHERE id = v_asg_id;
  SELECT efficiency INTO v_eff FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF v_eff IS DISTINCT FROM 0.900 THEN v_ok := false; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB29'; ELSE RAISE NOTICE 'FAIL AB29: an efficiency-only edit was refused or did not write'; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB29: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB29;

\echo 'AB30: move_run''s own internal UPDATE over an absence under WARN still succeeds with the resize trigger installed'
SAVEPOINT sp_AB30;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_new tstzrange := tstzrange('2028-01-10 06:00+00','2028-01-10 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid; v_res jsonb;
        v_after tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2028-01-10','2028-01-10','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, tstzrange('2028-01-01 06:00+00','2028-01-01 14:00+00'), NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, tstzrange('2028-01-01 06:00+00','2028-01-01 14:00+00'));
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  v_res := move_run(v_run_id, v_cell, v_new);
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF jsonb_array_length(coalesce(v_res->'absence_warnings','[]'::jsonb)) < 1
    THEN v_ok := false; v_why := v_why || ' missing absence_warnings'; END IF;
  IF v_after IS DISTINCT FROM v_new THEN v_ok := false; v_why := v_why || ' the crew row did not actually move'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB30'; ELSE RAISE NOTICE 'FAIL AB30:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB30: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB30;

\echo 'AB31: reassign_assignment''s own internal UPDATE over an absence under WARN still succeeds with the resize trigger installed'
SAVEPOINT sp_AB31;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_tom uuid := '50000000-0000-0000-0000-000000000005';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-02-05 06:00+00','2028-02-05 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid; v_res jsonb;
        v_after uuid; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2028-02-05','2028-02-05','[]'), 'sick');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_tom, v_run_id, NULL, v_win);
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  v_res := reassign_assignment(v_asg_id, v_el);
  SELECT operator_id INTO v_after FROM assignments WHERE id = v_asg_id;
  RESET ROLE;
  IF NOT (v_res->'absence'->>'absent')::boolean THEN v_ok := false; v_why := v_why || ' payload missing absence'; END IF;
  IF v_after IS DISTINCT FROM v_el THEN v_ok := false; v_why := v_why || ' the operator was not actually reassigned'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB31'; ELSE RAISE NOTICE 'FAIL AB31:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB31: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB31;

\echo 'AB32: delete_owned_row(operator) clearing operator_id to NULL on a history row does not trip the resize trigger under BLOCK'
SAVEPOINT sp_AB32;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        -- Cell 6 (machining.cnc_line.cell_6) is under the seed's only node
        -- carrying a skill requirement (CNC, on CNC Line, inherited downward
        -- per D11); Elena never held it (only operators 1-3 do, per
        -- seed.sql), so check_eligibility(cell, NULL, window) would answer
        -- eligible=false for her history row if this trigger asked about a
        -- cleared operator. F-120/R-002: must be the actual schedulable
        -- cell, not its parent CNC Line (the CNC Line's own id was used here
        -- before the schedulable-node guard existed to catch it).
        v_cell uuid := '3000000a-0000-0000-0000-00000000000c';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_asg_id uuid; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  -- A PAST row (delete_owned_row's history-keeping UPDATE only touches rows
  -- whose lower(timerange) <= now()) --- a direct INSERT, since create_run/
  -- create_assignment both refuse a past window outright and this trigger
  -- is BEFORE UPDATE only, never seeing an INSERT.
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange)
    VALUES (v_org, v_cell, v_el, v_wx, tstzrange('2020-01-01 06:00+00','2020-01-01 14:00+00'))
    RETURNING id INTO v_asg_id;
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_res := delete_owned_row('operator', v_el);
  RESET ROLE;
  IF NOT (v_res->>'deleted')::boolean THEN v_ok := false; v_why := v_why || ' delete_owned_row did not report deleted'; END IF;
  IF EXISTS (SELECT 1 FROM assignments WHERE id = v_asg_id AND operator_id IS NOT NULL) THEN
    v_ok := false; v_why := v_why || ' the history row''s operator_id was not cleared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assignments WHERE id = v_asg_id AND operator_display_name = 'Elena') THEN
    v_ok := false; v_why := v_why || ' the history row lost its operator_display_name';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB32'; ELSE RAISE NOTICE 'FAIL AB32:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB32: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB32;

\echo 'AB33: owner context (no jwt sub at all) is exempt from the resize guard --- a resize onto an absence under BLOCK succeeds'
SAVEPOINT sp_AB33;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-03-06 06:00+00','2028-03-06 14:00+00');
        v_new tstzrange := tstzrange('2028-03-08 06:00+00','2028-03-08 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_after tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2028-03-08','2028-03-08','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  -- Ordinary setup, as Ana, so only the RESIZE ITSELF is attempted in owner
  -- context. Placed on a CLEAN day (Mar 6) --- Elena is not absent yet, so
  -- the placement itself needs no exemption.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  RESET ROLE;

  -- Owner context: no jwt sub at all (0068/0071's own key). Stays on the
  -- superuser connection on purpose --- RLS would ALSO stop a claim-carrying
  -- but profile-less caller from ever reaching this row
  -- (assignments_update needs app_can_edit_node -> app_current_org()), so
  -- staying superuser here is what isolates the TRIGGER's own exemption from
  -- RLS's separate one. AB34 below is the caller RLS does not protect this
  -- migration from on its own.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE assignments SET timerange = v_new WHERE id = v_asg_id;
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  IF v_after IS DISTINCT FROM v_new THEN
    v_ok := false; v_why := v_why || ' owner context was refused, or the row did not move';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB33'; ELSE RAISE NOTICE 'FAIL AB33:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB33: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB33;

\echo 'AB34: an authenticated session with no profile (DEF-0019''s own shape, NOT owner context) is still refused by the resize guard'
SAVEPOINT sp_AB34;
DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_cell uuid := '30000000-0000-0000-0000-000000000007';
        v_el uuid := '50000000-0000-0000-0000-000000000004';
        v_wx uuid := '60000000-0000-0000-0000-000000000001';
        v_win tstzrange := tstzrange('2028-04-03 06:00+00','2028-04-03 14:00+00');
        v_new tstzrange := tstzrange('2028-04-05 06:00+00','2028-04-05 14:00+00');
        v_run jsonb; v_run_id uuid; v_asg jsonb; v_asg_id uuid;
        v_before tstzrange; v_after tstzrange; v_code text; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO absences (org_id, operator_id, daterange, reason)
    VALUES (v_org, v_el, daterange('2028-04-05','2028-04-05','[]'), 'sick');
  INSERT INTO node_settings (node_id, key, org_id, value)
    VALUES ('30000000-0000-0000-0000-000000000001', 'eligibility_policy', v_org, 'block');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_run := create_run(v_cell, v_wx, v_win, NULL, NULL);
  v_run_id := (v_run->'run'->>'id')::uuid;
  v_asg := create_assignment(v_cell, v_el, v_run_id, NULL, v_win);
  v_asg_id := (v_asg->'assignment'->>'id')::uuid;
  RESET ROLE;
  SELECT timerange INTO v_before FROM assignments WHERE id = v_asg_id;

  -- A real jwt sub with NO user_profiles row --- what a fresh sign-up is
  -- before anyone gives it a company (DEF-0019's own repro, 84's ST5). This
  -- carries a caller identity, so it is NOT owner context and must not be
  -- exempted. Superuser connection on purpose: RLS would ALSO refuse this
  -- caller independently (app_can_edit_node needs app_current_org(), NULL
  -- with no profile), but that is a SEPARATE gate and would hide a mistake in
  -- THIS one --- 0071's header names this the case that would go red if the
  -- exemption were ever "corrected" to app_current_org() IS NULL, since a
  -- profile-less session's app_current_org() is NULL too.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-00000000af01');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000af01', true);
  BEGIN
    UPDATE assignments SET timerange = v_new WHERE id = v_asg_id;
    v_ok := false; v_why := v_why || ' the profile-less session was not refused';
  EXCEPTION WHEN OTHERS THEN v_code := SQLERRM;
  END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT timerange INTO v_after FROM assignments WHERE id = v_asg_id;
  IF v_ok AND v_code NOT ILIKE '%cannot see%' THEN
    v_ok := false; v_why := v_why || format(' refused, but for the wrong reason: %s', v_code);
  END IF;
  IF v_after IS DISTINCT FROM v_before THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS AB34'; ELSE RAISE NOTICE 'FAIL AB34:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL AB34: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_AB34;

ROLLBACK;

\echo '88_absences_test.sql complete (AB0-AB34 with AB8b, AB9b, AB10b, AB11b, AB28b)'
