-- ============================================================================
-- 40_rls_test.sql — acceptance items 20-26 (brief P1-2 §7)
-- Whole file is one transaction, rolled back at the end. Personas are
-- switched with SET LOCAL ROLE + SET LOCAL "request.jwt.claim.sub" per the
-- brief §5, and reset with RESET ROLE before switching to the next persona
-- (the superuser connection owns every table, so RESET ROLE also restores
-- full visibility for between-persona setup/assertions).
--
-- ASSUMPTION (brief silent on mechanism): "As anon (no JWT claim)" is tested
-- by switching to the actual Postgres `anon` role (created by the harness),
-- which migration 0008 explicitly REVOKEs all table privileges from. That
-- makes a bare SELECT fail with a permission error (42501) rather than
-- return an empty result set -- a *stronger* form of "zero rows" (zero
-- visibility, not just RLS-filtered-to-empty). Case 20 treats either outcome
-- (permission error or empty result) as satisfying the acceptance item.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- org: 10000000-0000-0000-0000-000000000001
-- Admin sub: 00000000-0000-0000-0000-0000000000a1
-- Ana sub:   00000000-0000-0000-0000-0000000000a2  (Assembly, can_edit)
-- Marco sub: 00000000-0000-0000-0000-0000000000a3  (Machining, can_edit)
-- Cells 1-5 (Assembly subtree): 30000000...007,008,009, 3000000a...00a,00b
-- Cells 6-7 (Machining subtree): 3000000a...00c,00d
-- Maria (operator): 50000000-0000-0000-0000-000000000001
-- run r1 (Cell1, Tue): 80000000-0000-0000-0000-000000000001
-- run r7 (Cell1, Wed, unstaffed): 80000000-0000-0000-0000-000000000007

\echo 'Case 20: as anon (no JWT claim), zero visibility into nodes/runs/assignments'
SET LOCAL ROLE anon;
DO $$
DECLARE
  v_count int;
BEGIN
  BEGIN
    SELECT count(*) INTO v_count FROM nodes;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'FAIL: anon saw % rows from nodes', v_count;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- permission denied is an even stronger "zero rows"
  END;
  BEGIN
    SELECT count(*) INTO v_count FROM runs;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'FAIL: anon saw % rows from runs', v_count;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    SELECT count(*) INTO v_count FROM assignments;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'FAIL: anon saw % rows from assignments', v_count;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
RESET ROLE;

\echo 'Case 21: as Ana (Assembly supervisor)'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_count int;
BEGIN
  -- sees Cells 1-5, not 6-7
  SELECT count(*) INTO v_count FROM nodes
    WHERE id IN ('30000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000008',
                 '30000000-0000-0000-0000-000000000009','3000000a-0000-0000-0000-00000000000a',
                 '3000000a-0000-0000-0000-00000000000b');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'FAIL: Ana should see Cells 1-5 (5 nodes), saw %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM nodes
    WHERE id IN ('3000000a-0000-0000-0000-00000000000c','3000000a-0000-0000-0000-00000000000d');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Ana should not see Cells 6-7, saw %', v_count;
  END IF;

  -- sees Assembly runs (5: r1,r2,r3,r4,r7), not Machining runs (3: r5,r6,r8)
  SELECT count(*) INTO v_count FROM runs;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'FAIL: Ana should see 5 Assembly runs, saw %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM runs
    WHERE node_id IN ('3000000a-0000-0000-0000-00000000000c','3000000a-0000-0000-0000-00000000000d');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Ana should not see any Machining runs, saw %', v_count;
  END IF;
END $$;

\echo 'Case 21b: Ana can insert a direct assignment on Cell 1, cannot on Cell 6'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
          '50000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000001',
          tstzrange('2099-03-01 08:00+00', '2099-03-01 09:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c',
            '50000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
            tstzrange('2099-03-01 08:00+00', '2099-03-01 09:00+00'), 1.000);
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: Ana was able to insert an assignment on Cell 6';
  END IF;
END $$;
RESET ROLE;

\echo 'Case 22: as Marco (Machining supervisor) -- the mirror image'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a3';
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM nodes
    WHERE id IN ('3000000a-0000-0000-0000-00000000000c','3000000a-0000-0000-0000-00000000000d');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL: Marco should see Cells 6-7 (2 nodes), saw %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM nodes
    WHERE id IN ('30000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000008',
                 '30000000-0000-0000-0000-000000000009','3000000a-0000-0000-0000-00000000000a',
                 '3000000a-0000-0000-0000-00000000000b');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Marco should not see Cells 1-5, saw %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM runs;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'FAIL: Marco should see 3 Machining runs, saw %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM runs
    WHERE node_id IN ('30000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000008',
                      '30000000-0000-0000-0000-000000000009');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Marco should not see any Assembly runs, saw %', v_count;
  END IF;
END $$;

\echo 'Case 22b: Marco can insert a direct assignment on Cell 6, cannot on Cell 1'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c',
          '50000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001',
          tstzrange('2099-03-01 08:00+00', '2099-03-01 09:00+00'), 1.000);
  BEGIN
    -- Different operator+window from the Cell 6 insert above, so the ONLY
    -- possible rejection reason is RLS (not an incidental capacity clash).
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001',
            tstzrange('2099-03-01 08:00+00', '2099-03-01 09:00+00'), 1.000);
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: Marco was able to insert an assignment on Cell 1';
  END IF;
END $$;
RESET ROLE;

\echo 'Case 23: as Admin -- sees all 7 cells and all 8 runs'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM nodes
    WHERE id IN ('30000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000008',
                 '30000000-0000-0000-0000-000000000009','3000000a-0000-0000-0000-00000000000a',
                 '3000000a-0000-0000-0000-00000000000b','3000000a-0000-0000-0000-00000000000c',
                 '3000000a-0000-0000-0000-00000000000d');
  IF v_count <> 7 THEN
    RAISE EXCEPTION 'FAIL: Admin should see all 7 cells, saw %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM runs;
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'FAIL: Admin should see all 8 runs, saw %', v_count;
  END IF;
END $$;
RESET ROLE;

\echo 'Case 24: as Ana, moving a run Cell1->Cell6 is rejected; Cell1->Cell2 succeeds'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_caught boolean := false;
BEGIN
  -- r7 is the Wed/Cell1 run (unstaffed), chosen so the target cell has no
  -- overlapping run at that time -- isolates the RLS rejection from D4.
  BEGIN
    UPDATE runs SET node_id = '3000000a-0000-0000-0000-00000000000c' -- Cell 6, outside Ana's grant
      WHERE id = '80000000-0000-0000-0000-000000000007';
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: Ana was able to move a run from Cell 1 to Cell 6';
  END IF;

  -- Cell 1 -> Cell 2, both inside Ana's grant: must succeed.
  UPDATE runs SET node_id = '30000000-0000-0000-0000-000000000008' -- Cell 2
    WHERE id = '80000000-0000-0000-0000-000000000007';
  IF (SELECT node_id FROM runs WHERE id = '80000000-0000-0000-0000-000000000007')
     IS DISTINCT FROM '30000000-0000-0000-0000-000000000008' THEN
    RAISE EXCEPTION 'FAIL: Ana should have been able to move a run from Cell 1 to Cell 2';
  END IF;
END $$;
RESET ROLE;

\echo 'Case 25: as Ana, can read operator Maria (org-wide roster) but cannot update her'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE
  v_count int;
  v_rows int;
BEGIN
  SELECT count(*) INTO v_count FROM operators WHERE id = '50000000-0000-0000-0000-000000000001';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: Ana should be able to read operator Maria (org-wide), saw %', v_count;
  END IF;

  UPDATE operators SET display_name = 'Maria (edited by Ana)' WHERE id = '50000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL: Ana was able to update operator Maria (% rows affected)', v_rows;
  END IF;
END $$;
RESET ROLE;

\echo 'Case 26: as Ana, exactly one user_profiles row (her own); zero audit_log rows. As Admin, audit_log has rows.'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM user_profiles;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: Ana should see exactly 1 user_profiles row (her own), saw %', v_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a2') THEN
    RAISE EXCEPTION 'FAIL: the one user_profiles row Ana sees is not her own';
  END IF;

  SELECT count(*) INTO v_count FROM audit_log;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Ana should see 0 audit_log rows, saw %', v_count;
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM audit_log;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'FAIL: Admin should see audit_log rows (seed runs/assignments writes), saw 0';
  END IF;
END $$;
RESET ROLE;

\echo '40_rls_test.sql: all cases passed'
ROLLBACK;
