-- ============================================================================
-- 99_capacity_probe_editable_test.sql --- migration 0086 (DEF-0065, R-431, R-468).
--
-- capacity_probe's rows now say which overlapping blocks the CALLER may change
-- (`editable`, from app_can_edit_node, the check apply_split_coverage runs). The
-- bar offers "split the time evenly" only when every overlapping block is
-- editable; a block the supervisor can READ (a viewer grant on another line) but
-- not CHANGE is refused up front. Measured as `authenticated` with a real jwt sub.
--
-- FIXTURE --- the SEED's org 1 (Northwind), plus:
--   Sue (c1)   supervisor with a SUPERVISOR grant on Line 1 and a VIEWER grant on
--              Cell 4 (Line 2) only: she reads Cell 4, edits Line 1, reads nothing
--              else on Line 2 (Cell 5 stays outside her view)
--   Priya (c1) full block on Cell 4 (readable to Sue, NOT editable), 06-14 on 2099-03-02
--   Quinn (c3) half block on Cell 5 (Line 2: an OUTSIDE row for Sue), 08-12
--   Rosa  (c4) full block on Cell 3 (Line 1: readable AND editable), 06-14
--   The plant admin (a1) reads and edits everything.
--
-- CASES
--   SE1   Sue's probe row for Priya's Cell 4 block: readable (outside false, ids
--         present) and editable FALSE
--   SE2   Sue's probe row for Rosa's Cell 3 block: editable TRUE
--   SE3   Sue's probe row for Quinn's Cell 5 block: outside true, editable FALSE
--   SE4   the plant admin's rows for the same blocks: editable TRUE on both
--   SE5   held to the writer, block by block: for every readable row Sue or the plant
--         admin is shown, apply_split_coverage on that block is refused (PT403)
--         exactly when the row says editable false
--   SE6   no identity at all (the owner): every readable row editable true
--   SE7   a probe with no overlap and one for an operator Sue cannot read are the
--         same as before (fits true / fits null, no rows)
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'sue@northwind.example')
ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000c1', 'supervisor', 'direct')
ON CONFLICT DO NOTHING;
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-000000000004',
   '10000000-0000-0000-0000-000000000001', 'supervisor'),         -- Line 1: she edits it
  ('a0000000-0000-0000-0000-0000000000c1', '3000000a-0000-0000-0000-00000000000a',
   '10000000-0000-0000-0000-000000000001', 'viewer')              -- Cell 4: she reads it only
ON CONFLICT DO NOTHING;

INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('50000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', 'Priya Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000001', 'Pia Test',   '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-000000000001', 'Quinn Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c4', '10000000-0000-0000-0000-000000000001', 'Rosa Test',  '30000000-0000-0000-0000-000000000001');

-- The capacity trigger is off while the fixture is written, as in 99_capacity_counts_
-- every_block_test.sql (every measurement below must be cold, as a real request is).
ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency) VALUES
  ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000),
  ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-0000000000c3', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 08:00+00','2099-03-02 12:00+00'), 0.500),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-0000000000c4', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000);
ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;

\echo 'SE1: Sue''s row for Priya''s Cell 4 block is readable and NOT editable'
SAVEPOINT sp_SE1;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_r jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_r := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  RAISE NOTICE 'SE1 probe: %', v_r;
  IF jsonb_array_length(v_r->'overlapping') <> 1 THEN v_ok := false; v_why := v_why || ' rows <> 1'; END IF;
  v_r := v_r->'overlapping'->0;
  IF (v_r->>'outside')::boolean IS DISTINCT FROM false THEN v_ok := false; v_why := v_why || ' not readable'; END IF;
  IF v_r->>'node_name' IS DISTINCT FROM 'Cell 4' THEN v_ok := false; v_why := v_why || ' wrong place'; END IF;
  IF v_r->>'assignment_id' IS NULL OR v_r->>'node_id' IS NULL THEN v_ok := false; v_why := v_why || ' ids missing'; END IF;
  IF (v_r->>'editable')::boolean IS DISTINCT FROM false THEN v_ok := false; v_why := v_why || format(' editable %s', v_r->>'editable'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE1'; ELSE RAISE NOTICE 'FAIL SE1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE1;

\echo 'SE2: Sue''s row for Rosa''s Cell 3 block (Line 1, her own) is editable'
SAVEPOINT sp_SE2;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c4';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_r jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_r := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  IF jsonb_array_length(v_r->'overlapping') <> 1 THEN v_ok := false; v_why := v_why || ' rows <> 1'; END IF;
  v_r := v_r->'overlapping'->0;
  IF (v_r->>'outside')::boolean IS DISTINCT FROM false THEN v_ok := false; v_why := v_why || ' not readable'; END IF;
  IF (v_r->>'editable')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || format(' editable %s', v_r->>'editable'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE2'; ELSE RAISE NOTICE 'FAIL SE2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE2;

\echo 'SE3: Sue''s row for Quinn''s Cell 5 block (outside her view) is outside true and editable false'
SAVEPOINT sp_SE3;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c3';
        v_win tstzrange := tstzrange('2099-03-02 09:00+00','2099-03-02 11:00+00');
        v_r jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_r := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  IF jsonb_array_length(v_r->'overlapping') <> 1 THEN v_ok := false; v_why := v_why || ' rows <> 1'; END IF;
  v_r := v_r->'overlapping'->0;
  IF (v_r->>'outside')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || ' not outside'; END IF;
  IF v_r->>'assignment_id' IS NOT NULL OR v_r->>'node_id' IS NOT NULL THEN v_ok := false; v_why := v_why || ' ids leaked'; END IF;
  IF NOT (v_r ? 'editable') OR (v_r->>'editable')::boolean IS DISTINCT FROM false THEN v_ok := false; v_why := v_why || format(' editable %s', v_r->'editable'); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE3'; ELSE RAISE NOTICE 'FAIL SE3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE3;

\echo 'SE4: the plant admin''s rows for Priya''s and Rosa''s blocks are both editable'
SAVEPOINT sp_SE4;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_a jsonb; v_b jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_a := capacity_probe('50000000-0000-0000-0000-0000000000c1', v_win, 1.0, NULL)->'overlapping'->0;
  v_b := capacity_probe('50000000-0000-0000-0000-0000000000c4', v_win, 1.0, NULL)->'overlapping'->0;
  RESET ROLE;
  IF (v_a->>'editable')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || format(' Priya row %s', v_a); END IF;
  IF (v_b->>'editable')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || format(' Rosa row %s', v_b); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE4'; ELSE RAISE NOTICE 'FAIL SE4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE4;

\echo 'SE5: held to the writer --- apply_split_coverage on a probed block is refused exactly when its row says editable false (Sue and the plant admin)'
SAVEPOINT sp_SE5;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 05:00+00','2099-03-02 15:00+00');
        v_who text; v_op record; v_row jsonb; v_res text; v_checked int := 0; v_nonedit int := 0;
        v_ok boolean := true; v_why text := '';
BEGIN
  FOREACH v_who IN ARRAY ARRAY['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1'] LOOP
    FOR v_op IN SELECT id, display_name FROM operators
                WHERE org_id = '10000000-0000-0000-0000-000000000001' ORDER BY id LOOP
      PERFORM set_config('request.jwt.claim.sub', v_who, true);
      SET LOCAL ROLE authenticated;
      FOR v_row IN SELECT x FROM jsonb_array_elements(capacity_probe(v_op.id, v_win, 1.0, NULL)->'overlapping') x LOOP
        IF v_row->>'assignment_id' IS NULL THEN CONTINUE; END IF;     -- an outside row: no id to try
        v_checked := v_checked + 1;
        IF (v_row->>'editable')::boolean = false THEN v_nonedit := v_nonedit + 1; END IF;
        BEGIN
          PERFORM apply_split_coverage(
            jsonb_build_array(jsonb_build_object('assignment_id', v_row->>'assignment_id',
                                                 'efficiency', (v_row->>'efficiency')::numeric)),
            NULL);
          v_res := 'ACCEPTED';
        EXCEPTION WHEN SQLSTATE 'PT403' THEN v_res := 'REFUSED';
                  WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
        END;
        IF (v_res = 'REFUSED') IS DISTINCT FROM ((v_row->>'editable')::boolean = false) THEN
          v_ok := false;
          v_why := v_why || format(' %s as %s: row %s but the writer said %s', v_op.display_name, right(v_who, 2), v_row->>'editable', v_res);
        END IF;
      END LOOP;
      RESET ROLE;
    END LOOP;
  END LOOP;
  IF v_checked < 4 THEN v_ok := false; v_why := v_why || format(' too few rows walked (%s)', v_checked); END IF;
  IF v_nonedit < 1 THEN v_ok := false; v_why := v_why || ' no non-editable row walked'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE5 (% rows, % not editable)', v_checked, v_nonedit; ELSE RAISE NOTICE 'FAIL SE5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE5;

\echo 'SE6: no identity at all (the owner, the seed): every readable row is editable'
SAVEPOINT sp_SE6;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 05:00+00','2099-03-02 15:00+00');
        v_row jsonb; v_n int := 0; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_row IN SELECT x FROM jsonb_array_elements(capacity_probe('50000000-0000-0000-0000-0000000000c1', v_win, 1.0, NULL)->'overlapping') x LOOP
    v_n := v_n + 1;
    IF (v_row->>'editable')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || format(' %s', v_row); END IF;
  END LOOP;
  IF v_n <> 1 THEN v_ok := false; v_why := v_why || format(' rows %s', v_n); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE6'; ELSE RAISE NOTICE 'FAIL SE6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE6;

\echo 'SE7: a free person still fits with no rows, and an operator Sue cannot read is still answered blind'
SAVEPOINT sp_SE7;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_free jsonb; v_blind jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_free := capacity_probe('50000000-0000-0000-0000-0000000000c2', v_win, 1.0, NULL);
  v_blind := capacity_probe(gen_random_uuid(), v_win, 1.0, NULL);
  RESET ROLE;
  IF (v_free->>'fits')::boolean IS DISTINCT FROM true OR jsonb_array_length(v_free->'overlapping') <> 0 THEN
    v_ok := false; v_why := v_why || format(' free %s', v_free); END IF;
  IF v_blind->'fits' IS DISTINCT FROM 'null'::jsonb OR jsonb_array_length(v_blind->'overlapping') <> 0 THEN
    v_ok := false; v_why := v_why || format(' blind %s', v_blind); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS SE7'; ELSE RAISE NOTICE 'FAIL SE7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL SE7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_SE7;

ROLLBACK;
\echo '99_capacity_probe_editable_test.sql complete (SE1-SE7)'
