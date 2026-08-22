-- ============================================================================
-- 20_capacity_test.sql — acceptance items 8-15 (brief P1-2 §7)
-- Replays the six design-plan §15.1 capacity cases and proves the cap is
-- configurable (§17 D2). Each case uses a fresh throwaway operator so cases
-- cannot interfere with each other's peak-load math. Whole file is one
-- transaction, rolled back at the end.
--
-- UPDATED BY BRIEF P1-3a §3.2: check_operator_capacity() now raises through
-- api_raise('capacity_exceeded', ...), which sets SQLSTATE 'PT409' instead
-- of the P1-2 original 'check_violation'. The four `EXCEPTION WHEN
-- check_violation` handlers below are changed to `EXCEPTION WHEN SQLSTATE
-- 'PT409'` accordingly -- this is a forced consequence of amending the
-- trigger's error contract (brief P1-3a §9 requires this file to still pass,
-- both as its own baseline and as the target of the operator_peak_load
-- mutation test), not a design choice. No other line in this file changes.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- org: 10000000-0000-0000-0000-000000000001
-- node Cell 1 (schedulable): 30000000-0000-0000-0000-000000000007
-- product WX: 60000000-0000-0000-0000-000000000001

\echo 'Case 8: 100% + 50% overlapping -> rejected (peak 1.5)'
DO $$
DECLARE
  v_op uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 8');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.500);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: 100%%+50%% overlap (peak 1.5) was not rejected';
  END IF;
END $$;

\echo 'Case 9: 50% + 50% overlapping -> accepted'
DO $$
DECLARE v_op uuid := gen_random_uuid();
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 9');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 0.500);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.500);
END $$;

\echo 'Case 10: 100% + 100% overlapping -> rejected (peak 2.0, old double-booking protection intact)'
DO $$
DECLARE
  v_op uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 10');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 1.000);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: 100%%+100%% overlap (peak 2.0) was not rejected';
  END IF;
END $$;

\echo 'Case 11: adjacent ranges (half-open) -> accepted'
DO $$
DECLARE v_op uuid := gen_random_uuid();
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 11');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 1.000);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 10:00+00', '2099-02-01 12:00+00'), 1.000);
END $$;

\echo 'Case 12: 60/60/40 -> accepted at peak exactly 1.0 (instant-wise, not naive sum)'
DO $$
DECLARE v_op uuid := gen_random_uuid();
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 12');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 0.600);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 10:00+00', '2099-02-01 12:00+00'), 0.600);
  -- must NOT raise: a naive sum (0.6+0.6+0.4=1.6) would wrongly reject this.
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.400);
END $$;

\echo 'Case 13: 60/60/50 -> rejected at peak exactly 1.1, not 1.7'
DO $$
DECLARE
  v_op uuid := gen_random_uuid();
  v_caught boolean := false;
  v_msg text;
BEGIN
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 13');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 0.600);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 10:00+00', '2099-02-01 12:00+00'), 0.600);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.500);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: 60/60/50 (peak 1.1) was not rejected';
  END IF;
  IF v_msg NOT LIKE '%1.1%' OR v_msg LIKE '%1.7%' THEN
    RAISE EXCEPTION 'FAIL: error message does not prove instant-wise math: %', v_msg;
  END IF;
  RAISE NOTICE 'error text confirmed instant-wise (contains 1.1, not 1.7): %', v_msg;
END $$;

\echo 'Case 14: capacity_cap is configurable via orgs.settings'
DO $$
DECLARE
  v_op_literal uuid := gen_random_uuid();
  v_op_demo uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  UPDATE orgs SET settings = jsonb_set(settings, '{capacity_cap}', '1.2')
    WHERE id = '10000000-0000-0000-0000-000000000001';

  -- 14a (literal brief instruction): retry case 8's exact scenario (peak 1.5) at cap 1.2.
  -- NOTE: 1.5 > 1.2, so this is mathematically still over cap. This is a
  -- genuine inconsistency between the brief's chosen cap value (1.2) and
  -- case 8's stated peak (1.5) -- raising the cap to 1.2 cannot flip a 1.5
  -- peak to "accepted" under the (deliberately unmodified) §15.1 math. This
  -- is reported as a discrepancy rather than silently changed; see the
  -- verify-db.sh summary and the brief report for detail. It is surfaced as
  -- a WARNING (non-fatal) rather than aborting the whole suite.
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op_literal, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 14 literal');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op_literal,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op_literal,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.500);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF v_caught THEN
    RAISE WARNING 'DISCREPANCY (brief §7 item 14, literal reading): peak-1.5 scenario is still rejected at cap 1.2 (1.5 > 1.2, correctly so). The brief''s literal expectation ("now accepted") is mathematically inconsistent with case 8''s own peak of 1.5; see item 14b immediately below for a scenario that genuinely proves the cap is configurable.';
  ELSE
    RAISE WARNING 'UNEXPECTED: peak-1.5 scenario was accepted at cap 1.2 -- re-check the capacity trigger, this should not happen.';
  END IF;

  -- 14b (supplementary, added to actually satisfy "prove the cap is
  -- configurable"): the case-13 pattern (peak 1.1) was rejected at the
  -- default cap 1.0; the same pattern at cap 1.2 must now be accepted.
  INSERT INTO operators (id, org_id, display_name) VALUES (v_op_demo, '10000000-0000-0000-0000-000000000001', 'Cap Test Op 14 demo');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op_demo,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 08:00+00', '2099-02-01 10:00+00'), 0.600);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op_demo,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 10:00+00', '2099-02-01 12:00+00'), 0.600);
  -- must NOT raise this time (peak 1.1 <= cap 1.2), proving the cap read is live.
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op_demo,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-01 09:00+00', '2099-02-01 11:00+00'), 0.500);

  UPDATE orgs SET settings = jsonb_set(settings, '{capacity_cap}', '1.0')
    WHERE id = '10000000-0000-0000-0000-000000000001';
END $$;

\echo 'Case 15: the seed''s Aisha 50/50 pair is present'
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM assignments
    WHERE operator_id = '50000000-0000-0000-0000-000000000003'
      AND efficiency = 0.500
      AND node_id IN ('3000000a-0000-0000-0000-00000000000a', '3000000a-0000-0000-0000-00000000000b');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected Aisha''s 50/50 pair on Cells 4/5, found % matching rows', v_count;
  END IF;
END $$;

\echo '20_capacity_test.sql: all cases passed (see NOTICE/WARNING above for case 13 and 14 detail)'
ROLLBACK;
