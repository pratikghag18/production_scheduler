-- ============================================================================
-- 94_imported_absence_hours_test.sql --- migration 0073 (R-359).
--
-- `import_absences` could only ever write a WHOLE-DAY absence: 0066's INSERT
-- names an explicit column list that omits `timerange`, and 0069 gave the column
-- no default, so every imported row was NULL there. 0069's own header note A6
-- said so and deferred the fix. This is that fix's test.
--
-- The rules 0073 applies are `set_absence`'s, transcribed rather than invented,
-- so a row the import accepts is exactly a row the typed-in form would accept:
--   1. both times or neither
--   2. the end time must be after the start time
--   3. a part-day absence is a SINGLE day (from = to)
--   4. the stored window is half-open, `[)`
-- The one deliberate difference is what a violation DOES: `set_absence` raises
-- and the whole call fails; an import fails THAT ROW into `failed` and the rest
-- of the sheet still applies. Several cases below exist only to prove that
-- difference, because a migration that "reused the rules" by reusing the RAISE
-- would have broken every multi-row import in the product.
--
-- Every answer is measured as `authenticated` with a real jwt sub: psql connects
-- as the superuser, who bypasses RLS and whose app_current_org() is NULL, which
-- is not the context these cases are about.
--
-- FIXTURE --- the SEED's org 1 (Northwind), the same shape 88 uses:
--   Plant 1 (30..01) / Assembly (30..02)  <- Ana (a2) supervises
--                    / Machining (30..03) <- Marco (a3) supervises
--   Elena (50..04) home Assembly; Maria (50..01) home Machining
--
-- CASES
--   IH0  premises: import_absences exists and `absences.timerange` is a column
--   IH1  a row with starts_at/ends_at stores the half-open timerange, and the
--        daterange with it --- the whole point of the migration
--   IH2  a row with NEITHER time key is whole-day (timerange IS NULL), byte for
--        byte 0066's behaviour, which is every sheet that predates this
--   IH3  one time without the other fails THAT ROW, and the good row beside it
--        still applies (`inserted` = 1)
--   IH4  an end time not after the start fails that row
--   IH4b equal start and end fails that row (the window would be empty)
--   IH5  a part-day window spanning two days (from <> to) fails that row
--   IH6  a re-upload that DROPS the time columns clears the timerange back to
--        whole-day --- "the sheet is the truth", matching set_absence's own
--        unconditional `timerange = excluded.timerange`
--   IH7  the half-open bound is real: absence_overlap says a shift starting the
--        instant an IMPORTED part-day absence ends does not clash, and one
--        overlapping it does
--   IH8  the person gate still holds --- Ana cannot import an absence for Maria
--        (Machining is not her place), and it fails that row rather than the call
--   IH9  an unparseable starts_at fails the row rather than silently widening it
--        to a whole day
-- ============================================================================

\set ON_ERROR_STOP off
BEGIN;

\echo 'IH0: premises --- import_absences exists and absences.timerange is a column'
SAVEPOINT sp_IH0;
DO $$
DECLARE v_ok boolean := true; v_why text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'import_absences') THEN
    v_ok := false; v_why := v_why || ' import_absences is missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'import_absences') <> 1 THEN
    v_ok := false; v_why := v_why || ' more than one import_absences overload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'absences' AND column_name = 'timerange'
  ) THEN
    v_ok := false; v_why := v_why || ' absences.timerange is missing';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH0'; ELSE RAISE NOTICE 'FAIL IH0:%', v_why; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_IH0;

\echo 'IH1: a row carrying starts_at/ends_at stores the half-open timerange'
SAVEPOINT sp_IH1;
DO $$
DECLARE v_res jsonb; v_tr tstzrange; v_dr daterange; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2,
    'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-05', 'to', '2027-04-05',
    'reason', 'appointment',
    'external_id', 'IH1-A',
    'starts_at', '2027-04-05T09:00:00Z',
    'ends_at',   '2027-04-05T13:00:00Z')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 1 THEN
    v_ok := false; v_why := v_why || format(' inserted=%s failed=%s', v_res->>'inserted', v_res->'failed');
  END IF;
  SELECT timerange, daterange INTO v_tr, v_dr FROM absences WHERE external_id = 'IH1-A';
  IF v_tr IS NULL THEN
    v_ok := false; v_why := v_why || ' timerange is NULL --- the import is still whole-day-only';
  ELSE
    IF lower(v_tr) <> '2027-04-05T09:00:00Z'::timestamptz THEN
      v_ok := false; v_why := v_why || format(' lower=%s', lower(v_tr));
    END IF;
    IF upper(v_tr) <> '2027-04-05T13:00:00Z'::timestamptz THEN
      v_ok := false; v_why := v_why || format(' upper=%s', upper(v_tr));
    END IF;
    -- Half-open, like set_absence's own tstzrange(..., '[)').
    IF lower_inc(v_tr) IS NOT TRUE OR upper_inc(v_tr) IS NOT FALSE THEN
      v_ok := false; v_why := v_why || ' the window is not half-open [)';
    END IF;
  END IF;
  IF v_dr IS NULL THEN v_ok := false; v_why := v_why || ' the daterange was lost'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH1'; ELSE RAISE NOTICE 'FAIL IH1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH1;

\echo 'IH2: a row with neither time key is whole-day, exactly as before'
SAVEPOINT sp_IH2;
DO $$
DECLARE v_res jsonb; v_tr tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2,
    'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-06', 'to', '2027-04-08',
    'reason', 'sick', 'external_id', 'IH2-A')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 1 THEN
    v_ok := false; v_why := v_why || format(' inserted=%s failed=%s', v_res->>'inserted', v_res->'failed');
  END IF;
  SELECT timerange INTO v_tr FROM absences WHERE external_id = 'IH2-A';
  IF v_tr IS NOT NULL THEN
    v_ok := false; v_why := v_why || format(' timerange=%s (should be NULL)', v_tr);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH2'; ELSE RAISE NOTICE 'FAIL IH2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH2;

\echo 'IH3: one time without the other fails THAT row; the good row beside it still applies'
SAVEPOINT sp_IH3;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(
    jsonb_build_object('line', 2,
      'operator_id', '50000000-0000-0000-0000-000000000004',
      'from', '2027-04-09', 'to', '2027-04-09', 'reason', 'appointment',
      'external_id', 'IH3-BAD', 'starts_at', '2027-04-09T09:00:00Z'),
    jsonb_build_object('line', 3,
      'operator_id', '50000000-0000-0000-0000-000000000004',
      'from', '2027-04-10', 'to', '2027-04-10', 'reason', 'sick',
      'external_id', 'IH3-GOOD')));
  RESET ROLE;
  -- The whole point: one row failed, the sheet did not.
  IF (v_res->>'inserted')::int <> 1 THEN
    v_ok := false; v_why := v_why || format(' inserted=%s (the good row should still apply)', v_res->>'inserted');
  END IF;
  IF jsonb_array_length(v_res->'failed') <> 1 THEN
    v_ok := false; v_why := v_why || format(' failed=%s', v_res->'failed');
  ELSIF (v_res->'failed'->0->>'message') NOT ILIKE '%both a start and an end time%' THEN
    v_ok := false; v_why := v_why || format(' wrong message: %s', v_res->'failed'->0->>'message');
  ELSIF (v_res->'failed'->0->>'line')::int <> 2 THEN
    v_ok := false; v_why := v_why || format(' wrong line: %s', v_res->'failed'->0->>'line');
  END IF;
  IF EXISTS (SELECT 1 FROM absences WHERE external_id = 'IH3-BAD') THEN
    v_ok := false; v_why := v_why || ' the bad row was written anyway';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM absences WHERE external_id = 'IH3-GOOD') THEN
    v_ok := false; v_why := v_why || ' the good row was not written';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH3'; ELSE RAISE NOTICE 'FAIL IH3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH3;

\echo 'IH4: an end time not after the start fails that row'
SAVEPOINT sp_IH4;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-11', 'to', '2027-04-11', 'reason', 'appointment',
    'external_id', 'IH4-A',
    'starts_at', '2027-04-11T13:00:00Z', 'ends_at', '2027-04-11T09:00:00Z')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 0 THEN v_ok := false; v_why := v_why || ' it was written'; END IF;
  IF (v_res->'failed'->0->>'message') NOT ILIKE '%not after the start time%' THEN
    v_ok := false; v_why := v_why || format(' message: %s', v_res->'failed'->0->>'message');
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH4'; ELSE RAISE NOTICE 'FAIL IH4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH4;

\echo 'IH4b: equal start and end fails that row --- the window would be empty'
SAVEPOINT sp_IH4b;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-12', 'to', '2027-04-12', 'reason', 'appointment',
    'external_id', 'IH4b-A',
    'starts_at', '2027-04-12T09:00:00Z', 'ends_at', '2027-04-12T09:00:00Z')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 0 THEN v_ok := false; v_why := v_why || ' it was written'; END IF;
  IF (v_res->'failed'->0->>'message') NOT ILIKE '%not after the start time%' THEN
    v_ok := false; v_why := v_why || format(' message: %s', v_res->'failed'->0->>'message');
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH4b'; ELSE RAISE NOTICE 'FAIL IH4b:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH4b: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH4b;

\echo 'IH5: a part-day window spanning two days fails that row'
SAVEPOINT sp_IH5;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-13', 'to', '2027-04-14', 'reason', 'appointment',
    'external_id', 'IH5-A',
    'starts_at', '2027-04-13T09:00:00Z', 'ends_at', '2027-04-13T13:00:00Z')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 0 THEN v_ok := false; v_why := v_why || ' it was written'; END IF;
  IF (v_res->'failed'->0->>'message') NOT ILIKE '%single day%' THEN
    v_ok := false; v_why := v_why || format(' message: %s', v_res->'failed'->0->>'message');
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH5'; ELSE RAISE NOTICE 'FAIL IH5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH5;

\echo 'IH6: a re-upload without the time columns clears the window back to whole-day'
SAVEPOINT sp_IH6;
DO $$
DECLARE v_res jsonb; v_tr tstzrange; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- First upload: part of a day.
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-15', 'to', '2027-04-15', 'reason', 'appointment',
    'external_id', 'IH6-A',
    'starts_at', '2027-04-15T09:00:00Z', 'ends_at', '2027-04-15T13:00:00Z')));
  SELECT timerange INTO v_tr FROM absences WHERE external_id = 'IH6-A';
  IF v_tr IS NULL THEN v_ok := false; v_why := v_why || ' the first upload did not store a window'; END IF;

  -- Second upload of the SAME row, time columns removed: the sheet is the truth.
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-15', 'to', '2027-04-15', 'reason', 'appointment',
    'external_id', 'IH6-A')));
  RESET ROLE;
  IF (v_res->>'updated')::int <> 1 THEN
    v_ok := false; v_why := v_why || format(' updated=%s failed=%s', v_res->>'updated', v_res->'failed');
  END IF;
  SELECT timerange INTO v_tr FROM absences WHERE external_id = 'IH6-A';
  IF v_tr IS NOT NULL THEN
    v_ok := false; v_why := v_why || format(' timerange=%s (should have been cleared)', v_tr);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH6'; ELSE RAISE NOTICE 'FAIL IH6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH6;

\echo 'IH7: the half-open bound is real --- touching an imported window is not a clash'
SAVEPOINT sp_IH7;
DO $$
DECLARE v_res jsonb; v_touch jsonb; v_over jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-16', 'to', '2027-04-16', 'reason', 'appointment',
    'external_id', 'IH7-A',
    'starts_at', '2027-04-16T09:00:00Z', 'ends_at', '2027-04-16T13:00:00Z')));
  IF (v_res->>'inserted')::int <> 1 THEN
    v_ok := false; v_why := v_why || format(' the row did not import: %s', v_res->'failed');
  END IF;
  -- Starts the instant it ends: not a clash (DEF-0022's boundary, now reachable
  -- through an IMPORTED row rather than only a typed-in one).
  v_touch := absence_overlap('50000000-0000-0000-0000-000000000004',
    tstzrange('2027-04-16T13:00:00Z', '2027-04-16T15:00:00Z', '[)'));
  -- Genuinely overlapping: a clash. Without this the case above could pass by
  -- the reader being blind rather than by the bound being right.
  v_over := absence_overlap('50000000-0000-0000-0000-000000000004',
    tstzrange('2027-04-16T12:00:00Z', '2027-04-16T14:00:00Z', '[)'));
  RESET ROLE;
  IF (v_touch->>'absent')::boolean IS DISTINCT FROM false THEN
    v_ok := false; v_why := v_why || format(' touching answered %s', v_touch);
  END IF;
  IF (v_over->>'absent')::boolean IS DISTINCT FROM true THEN
    v_ok := false; v_why := v_why || format(' overlapping answered %s', v_over);
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH7'; ELSE RAISE NOTICE 'FAIL IH7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH7;

\echo 'IH8: the person gate still holds --- Ana cannot import a part-day row for Maria'
SAVEPOINT sp_IH8;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  -- Maria is homed at Machining, which is Marco's place, not Ana's. Adding the
  -- two time keys must not become a way around app_can_edit_node.
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000001',
    'from', '2027-04-17', 'to', '2027-04-17', 'reason', 'appointment',
    'external_id', 'IH8-A',
    'starts_at', '2027-04-17T09:00:00Z', 'ends_at', '2027-04-17T13:00:00Z')));
  RESET ROLE;
  IF (v_res->>'inserted')::int <> 0 THEN v_ok := false; v_why := v_why || ' it was written'; END IF;
  IF (v_res->'failed'->0->>'message') NOT ILIKE '%cannot record an absence%' THEN
    v_ok := false; v_why := v_why || format(' message: %s', v_res->'failed'->0->>'message');
  END IF;
  IF EXISTS (SELECT 1 FROM absences WHERE external_id = 'IH8-A') THEN
    v_ok := false; v_why := v_why || ' the row exists';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH8'; ELSE RAISE NOTICE 'FAIL IH8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH8;

\echo 'IH9: an unparseable starts_at fails the row rather than widening it to a whole day'
SAVEPOINT sp_IH9;
DO $$
DECLARE v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
  SET LOCAL ROLE authenticated;
  v_res := import_absences(jsonb_build_array(jsonb_build_object(
    'line', 2, 'operator_id', '50000000-0000-0000-0000-000000000004',
    'from', '2027-04-18', 'to', '2027-04-18', 'reason', 'appointment',
    'external_id', 'IH9-A',
    'starts_at', 'half past nine', 'ends_at', '2027-04-18T13:00:00Z')));
  RESET ROLE;
  -- The row must NOT land as a whole-day absence: that is the silent failure
  -- this whole piece exists to close.
  IF (v_res->>'inserted')::int <> 0 THEN
    v_ok := false; v_why := v_why || ' it was written --- probably as a whole day';
  END IF;
  IF EXISTS (SELECT 1 FROM absences WHERE external_id = 'IH9-A') THEN
    v_ok := false; v_why := v_why || ' the row exists';
  END IF;
  IF jsonb_array_length(v_res->'failed') <> 1 THEN
    v_ok := false; v_why := v_why || format(' failed=%s', v_res->'failed');
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS IH9'; ELSE RAISE NOTICE 'FAIL IH9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL IH9: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_IH9;

ROLLBACK;

\echo '94_imported_absence_hours_test.sql complete (IH0-IH9 with IH4b)'
