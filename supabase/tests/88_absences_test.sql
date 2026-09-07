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
  FOR r IN SELECT unnest(ARRAY[
      'set_absence(uuid, date, date, text, text)',
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

ROLLBACK;

\echo '88_absences_test.sql complete (AB0-AB14 with AB8b, AB9b, AB10b, AB11b)'
