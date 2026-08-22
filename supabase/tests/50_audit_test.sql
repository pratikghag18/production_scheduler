-- ============================================================================
-- 50_audit_test.sql — acceptance items 27-29 (brief P1-2 §7)
-- Whole file is one transaction, rolled back at the end.
--
-- NOTE on "differing on timerange only" (item 27): assignments/runs both
-- carry an unconditional set_updated_at BEFORE trigger (migration 0003), so
-- `updated_at` legitimately changes on every UPDATE in addition to whatever
-- business column changed. This test treats updated_at as expected
-- incidental bookkeeping and asserts the *business* columns differ on
-- timerange only -- see migration 0007's write_audit_log() comment for why
-- the no-op-skip check (item 28) also excludes updated_at from its compare.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- org: 10000000-0000-0000-0000-000000000001
-- assignment a1 (Elena, run r1 on Cell1): 90000000-0000-0000-0000-000000000001
-- run r7 (Cell1, Wed, unstaffed): 80000000-0000-0000-0000-000000000007

\echo 'Case 27: updating an assignment timerange writes one audit row (before/after differ on timerange only)'
DO $$
DECLARE
  v_before_count int;
  v_after_count int;
  v_before jsonb;
  v_after jsonb;
BEGIN
  SELECT count(*) INTO v_before_count FROM audit_log
    WHERE table_name = 'assignments' AND row_id = '90000000-0000-0000-0000-000000000001';

  UPDATE assignments
    SET timerange = tstzrange(lower(timerange), upper(timerange) + interval '5 minutes')
    WHERE id = '90000000-0000-0000-0000-000000000001';

  SELECT count(*) INTO v_after_count FROM audit_log
    WHERE table_name = 'assignments' AND row_id = '90000000-0000-0000-0000-000000000001';
  IF v_after_count <> v_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one new audit row, went from % to %', v_before_count, v_after_count;
  END IF;

  SELECT before, after INTO v_before, v_after FROM audit_log
    WHERE table_name = 'assignments' AND row_id = '90000000-0000-0000-0000-000000000001'
      AND action = 'update'
    ORDER BY at DESC LIMIT 1;

  IF v_before->>'timerange' = v_after->>'timerange' THEN
    RAISE EXCEPTION 'FAIL: audit row does not show a timerange change';
  END IF;
  IF (v_before - 'timerange' - 'updated_at') IS DISTINCT FROM (v_after - 'timerange' - 'updated_at') THEN
    RAISE EXCEPTION 'FAIL: audit row before/after differ on a column other than timerange: before=%, after=%', v_before, v_after;
  END IF;
END $$;

\echo 'Case 28: a no-op update writes no audit row'
DO $$
DECLARE
  v_before_count int;
  v_after_count int;
BEGIN
  SELECT count(*) INTO v_before_count FROM audit_log
    WHERE table_name = 'assignments' AND row_id = '90000000-0000-0000-0000-000000000001';

  UPDATE assignments SET timerange = timerange WHERE id = '90000000-0000-0000-0000-000000000001';

  SELECT count(*) INTO v_after_count FROM audit_log
    WHERE table_name = 'assignments' AND row_id = '90000000-0000-0000-0000-000000000001';
  IF v_after_count <> v_before_count THEN
    RAISE EXCEPTION 'FAIL: no-op update wrote % new audit row(s)', v_after_count - v_before_count;
  END IF;
END $$;

\echo 'Case 29: deleting a run writes action=delete with before populated'
DO $$
DECLARE
  v_action text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  DELETE FROM runs WHERE id = '80000000-0000-0000-0000-000000000007';

  SELECT action, before, after INTO v_action, v_before, v_after FROM audit_log
    WHERE table_name = 'runs' AND row_id = '80000000-0000-0000-0000-000000000007'
    ORDER BY at DESC LIMIT 1;

  IF v_action IS DISTINCT FROM 'delete' THEN
    RAISE EXCEPTION 'FAIL: expected action=delete, got %', v_action;
  END IF;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'FAIL: delete audit row has no before payload';
  END IF;
  IF v_after IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: delete audit row unexpectedly has an after payload';
  END IF;
END $$;

\echo '50_audit_test.sql: all cases passed'
ROLLBACK;
