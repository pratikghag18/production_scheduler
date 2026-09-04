-- ============================================================================
-- 67_no_run_status_test.sql — migration 0044, "no run carries a status, and the
-- overlap rule stops making an exception for one." (R-324)
--
-- ⭐ THIS FILE EXISTS FOR ONE STATEMENT: the DROP and re-ADD of
-- `runs_no_overlap_on_node`. Everything else in 0043 and 0044 was a function
-- body, which can be read and re-read; this is the rule that stops two jobs
-- landing on the same cell, and for the length of one transaction it does not
-- exist. A replacement written slightly wrong does not raise anything — the
-- table simply starts accepting overlaps, quietly, until somebody notices two
-- jobs booked on one cell and cannot explain how.
--
-- So the constraint is asserted from OUTSIDE, by trying the things it must
-- refuse. X2 is the ordinary overlap. X3 is the case that USED to be allowed —
-- the old rule exempted a cancelled run, so this exact insert was accepted
-- before 0044 and must be refused after it. X4 and X5 are the boundaries either
-- side, because a rule that refuses everything would pass X2 and X3 and be
-- worse than the one it replaced.
--
-- ⚠️ NOT A SINGLE ONE OF THESE READS `status`, deliberately: the column is
-- gone, so the only way to ask whether the rule is right is to ask the rule.
--
-- Fixture is the seed's runs. Everything is inside one BEGIN/ROLLBACK, each
-- case savepointed.
-- ============================================================================

BEGIN;

\echo 'X1: the column is gone and the constraint no longer carries a WHERE clause'
SAVEPOINT sp_X1;
DO $$
DECLARE v_col int; v_def text;
BEGIN
  SELECT count(*) INTO v_col FROM information_schema.columns
   WHERE table_name = 'runs' AND column_name = 'status';
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'runs_no_overlap_on_node' AND conrelid = 'runs'::regclass;
  -- Still an EXCLUDE on the same two columns, and no longer partial. Reading
  -- the definition back is the cheap half of this file; X2-X5 are the real half.
  IF v_col = 0 AND v_def LIKE 'EXCLUDE USING gist%node_id%timerange%'
     AND v_def NOT LIKE '%WHERE%'
  THEN RAISE NOTICE 'PASS X1';
  ELSE RAISE NOTICE 'FAIL X1: status_columns=% (want 0) def=%', v_col, coalesce(v_def, 'MISSING'); END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X1;

\echo 'X2 ⭐ THE RULE STILL BITES: an overlapping run on the same cell is refused'
SAVEPOINT sp_X2;
DO $$
DECLARE v_run runs; v_err text := 'no error'; v_n int;
BEGIN
  SELECT * INTO v_run FROM runs LIMIT 1;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES (v_run.org_id, v_run.node_id, v_run.product_id, v_run.timerange, 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM runs WHERE node_id = v_run.node_id AND timerange = v_run.timerange;
  IF v_err = '23P01' AND v_n = 1
  THEN RAISE NOTICE 'PASS X2';
  ELSE RAISE NOTICE 'FAIL X2: sqlstate=% (want 23P01) rows=% (want 1)', v_err, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X2;

\echo 'X3 ⭐⭐ THE CASE THAT USED TO BE ALLOWED IS NOW REFUSED — this is the whole change'
SAVEPOINT sp_X3;
DO $$
DECLARE v_run runs; v_err text := 'no error'; v_n int;
BEGIN
  -- `10_constraints_test.sql` case 7c asserted the opposite of this and was
  -- right to: the old constraint exempted a run whose status was 'cancelled',
  -- so an overlapping one was accepted. There is no way to write that row now —
  -- no column to set — and the overlap is refused on its own terms. The case is
  -- inverted there rather than deleted, because the contract changing IS the
  -- deliverable.
  SELECT * INTO v_run FROM runs LIMIT 1;
  BEGIN
    INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
    VALUES (v_run.org_id, v_run.node_id, v_run.product_id,
            tstzrange(lower(v_run.timerange) + interval '1 hour',
                      upper(v_run.timerange) + interval '1 hour'), 1);
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE; END;
  SELECT count(*) INTO v_n FROM runs WHERE node_id = v_run.node_id;
  IF v_err = '23P01'
  THEN RAISE NOTICE 'PASS X3';
  ELSE RAISE NOTICE 'FAIL X3: sqlstate=% (want 23P01) runs_on_that_cell=%', v_err, v_n; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X3;

\echo 'X4 ⚠ and it is not simply refusing everything: the SAME window on ANOTHER cell is accepted'
SAVEPOINT sp_X4;
DO $$
DECLARE v_run runs; v_other uuid; v_id uuid;
BEGIN
  SELECT * INTO v_run FROM runs LIMIT 1;
  SELECT n.id INTO v_other FROM nodes n
   WHERE n.org_id = v_run.org_id AND n.id <> v_run.node_id
     AND n.path <@ 'plant_1'::ltree
     AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id)
   LIMIT 1;
  INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
  VALUES (v_run.org_id, v_other, v_run.product_id, v_run.timerange, 1)
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL
  THEN RAISE NOTICE 'PASS X4';
  ELSE RAISE NOTICE 'FAIL X4: same window on another cell was refused'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X4;

\echo 'X5 ⚠ nor is it refusing anything that merely touches: an ADJACENT window on the same cell is accepted'
SAVEPOINT sp_X5;
DO $$
DECLARE v_run runs; v_base timestamptz; v_a uuid; v_b uuid;
BEGIN
  -- Ranges are half-open, so a run starting exactly where another ends does not
  -- overlap. A constraint rebuilt with the wrong operator would refuse this
  -- while still passing X2 and X3, which is why the boundary gets its own case.
  --
  -- ⚠️ THIS CASE BUILDS ITS OWN PAIR, and the first version did not — it hung a
  -- run off the end of a SEEDED one and was refused, because the seed puts
  -- consecutive shifts on the same cell: 06:00-14:00 is followed by 14:00-22:00,
  -- so "just after this run ends" was already occupied. The constraint was
  -- right and the case was wrong. Two runs of its own, in a window nothing else
  -- touches, is the only way to ask the question cleanly.
  SELECT * INTO v_run FROM runs LIMIT 1;
  v_base := lower(v_run.timerange) + interval '30 days';
  INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
  VALUES (v_run.org_id, v_run.node_id, v_run.product_id,
          tstzrange(v_base, v_base + interval '2 hours'), 1)
  RETURNING id INTO v_a;
  INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount)
  VALUES (v_run.org_id, v_run.node_id, v_run.product_id,
          tstzrange(v_base + interval '2 hours', v_base + interval '4 hours'), 1)
  RETURNING id INTO v_b;
  IF v_a IS NOT NULL AND v_b IS NOT NULL
  THEN RAISE NOTICE 'PASS X5';
  ELSE RAISE NOTICE 'FAIL X5: an adjacent window was refused'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL X5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X5;

\echo 'X6: create_run and move_run still work with no status to write or read'
SAVEPOINT sp_X6;
DO $$
DECLARE v_run runs; v_node uuid; v_res jsonb; v_moved jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO v_run FROM runs LIMIT 1;
  SELECT n.id INTO v_node FROM nodes n
   WHERE n.org_id = v_run.org_id AND n.path <@ 'plant_1'::ltree AND n.id <> v_run.node_id
     AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.node_id = n.id)
   LIMIT 1;
  v_res := create_run(v_node, v_run.product_id,
                      tstzrange(lower(v_run.timerange) + interval '3 days',
                                upper(v_run.timerange) + interval '3 days'), 1);
  v_moved := move_run((v_res->'run'->>'id')::uuid, v_node,
                      tstzrange(lower(v_run.timerange) + interval '4 days',
                                upper(v_run.timerange) + interval '4 days'));
  RESET ROLE;
  -- Both return the run, and neither payload carries a status key any more.
  IF v_res->'run' ? 'id' AND NOT (v_res->'run' ? 'status')
     AND v_moved->'run' ? 'id' AND NOT (v_moved->'run' ? 'status')
  THEN RAISE NOTICE 'PASS X6';
  ELSE RAISE NOTICE 'FAIL X6: create=% move=%', v_res->'run', v_moved->'run'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'FAIL X6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_X6;

ROLLBACK;
