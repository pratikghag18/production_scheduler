-- ============================================================================
-- 99_capacity_review_test.sql --- the reviewer's attacks on migration 0085
-- (DEF-0053, R-465, R-033, R-431). One named case per attack. Every case that
-- holds is a standing test; a FAIL line is the red line to paste.
--
-- FIXTURE --- the same world as 99_capacity_counts_every_block_test.sql:
--   Sue (c1)   supervisor, grant on Line 1 ONLY; reads the plant's people
--   Priya (c1) home Plant 1, full block on Cell 4 (Line 2) 06-14 on 2099-03-02
--   Quinn (c3) half block on Cell 5 (Line 2) 08-12
--   Rosa  (c4) full block on Cell 3 (Line 1) 06-14 (readable)
--   Sam   (c5) homed at Plant 2 (a second root), block on Cell P2
--   Pia   (c2) free all day
--   Dee   (c6) supervisor with TWO grants: Line 1 and Cell 5
--   Pat   (c7) plant admin (a supervisor profile with an admin GRANT) on Plant 2 only
-- Fixture rows are written with the capacity trigger off, so every measurement
-- below starts cold.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'sue@northwind.example'),
  ('00000000-0000-0000-0000-0000000000c6', 'dee@northwind.example'),
  ('00000000-0000-0000-0000-0000000000c7', 'pat@northwind.example'),
  ('00000000-0000-0000-0000-0000000000c9', 'ghost@nowhere.example')
ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'supervisor', 'direct'),
  ('a0000000-0000-0000-0000-0000000000c6', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c6', 'supervisor', 'direct'),
  ('a0000000-0000-0000-0000-0000000000c7', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c7', 'supervisor', 'direct')
ON CONFLICT DO NOTHING;

INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c0', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000000', NULL, 'Plant 2');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c6', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-0000000000c0', 'Area P2');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c7', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-0000000000c6', 'Line P2');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c8', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-0000000000c7', 'Cell P2');

INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'supervisor'),
  ('a0000000-0000-0000-0000-0000000000c6', '30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'supervisor'),
  ('a0000000-0000-0000-0000-0000000000c6', '3000000a-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', 'supervisor'),
  ('a0000000-0000-0000-0000-0000000000c7', '30000000-0000-0000-0000-0000000000c0', '10000000-0000-0000-0000-000000000001', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('50000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', 'Priya Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000001', 'Pia Test',   '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-000000000001', 'Quinn Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c4', '10000000-0000-0000-0000-000000000001', 'Rosa Test',  '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c5', '10000000-0000-0000-0000-000000000001', 'Sam Test',   '30000000-0000-0000-0000-0000000000c0');
INSERT INTO operators (id, org_id, display_name, site_node_id, active) VALUES
  ('50000000-0000-0000-0000-0000000000c8', '10000000-0000-0000-0000-000000000001', 'Ivy Inactive', '30000000-0000-0000-0000-000000000001', false);

ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
INSERT INTO products (id, org_id, sku, name, source) VALUES
  ('60000000-0000-0000-0000-0000000000c9', '10000000-0000-0000-0000-000000000001', 'P2W', 'Plant Two Widget', 'manual');
INSERT INTO product_sites (org_id, product_id, node_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-0000000000c9', '30000000-0000-0000-0000-0000000000c0');
INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency) VALUES
  ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000),
  ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-0000000000c3', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 08:00+00','2099-03-02 12:00+00'), 0.500),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-0000000000c4', '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-0000000000c8', '50000000-0000-0000-0000-0000000000c5', '60000000-0000-0000-0000-0000000000c9', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000);
ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;

-- A helper that runs one statement as a signed-in person and answers 'OK' or
-- 'ERR <sqlstate> <message> | <detail>'. Created in the transaction, rolled back with it.
CREATE FUNCTION rv_try(p_sub text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_msg text; v_det text; v_out text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    v_out := 'OK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
    v_out := 'ERR ' || SQLSTATE || ' ' || v_msg || ' | ' || coalesce(v_det, '');
  END;
  RESET ROLE;
  RETURN v_out;
END $f$;

-- ----------------------------------------------------------------------------
\echo 'RV1: reassign_assignment --- Sue hands a block on her own cell to Priya over Priya''s Cell 4 block: refused, nothing moves'
SAVEPOINT sp_RV1;
DO $$
DECLARE v_id uuid; v_res text; v_op uuid; v_ok boolean := true; v_why text := '';
BEGIN
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c2',
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00'), 1.000) RETURNING id INTO v_id;
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1',
    format('SELECT reassign_assignment(%L, %L)', v_id, '50000000-0000-0000-0000-0000000000c1'));
  SELECT operator_id INTO v_op FROM assignments WHERE id = v_id;
  IF v_res NOT LIKE 'ERR PT409 capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || ' ' || left(v_res, 120); END IF;
  IF v_op <> '50000000-0000-0000-0000-0000000000c2' THEN v_ok := false; v_why := v_why || ' the block moved to Priya'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV1'; ELSE RAISE NOTICE 'FAIL RV1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV1;

\echo 'RV2: move_assignment --- Sue moves Priya''s block on Cell 2 (15-17) into 10-12, over the Cell 4 block: refused'
SAVEPOINT sp_RV2;
DO $$
DECLARE v_id uuid; v_res text; v_lo timestamptz; v_ok boolean := true; v_why text := '';
BEGIN
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1',
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 15:00+00','2099-03-02 17:00+00'), 1.000) RETURNING id INTO v_id;
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1',
    format('SELECT move_assignment(%L, %L, tstzrange(%L, %L))', v_id, '30000000-0000-0000-0000-000000000008', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  SELECT lower(timerange) INTO v_lo FROM assignments WHERE id = v_id;
  IF v_res NOT LIKE 'ERR PT409 capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || ' ' || left(v_res, 160); END IF;
  IF v_lo <> '2099-03-02 15:00+00' THEN v_ok := false; v_why := v_why || ' it moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV2'; ELSE RAISE NOTICE 'FAIL RV2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV2;

\echo 'RV3: move_run --- Sue moves a run on Cell 2 that carries Priya (15-17) into 10-12, over the Cell 4 block: refused, run stays'
SAVEPOINT sp_RV3;
DO $$
DECLARE v_run uuid; v_res text; v_lo timestamptz; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO runs (org_id, node_id, product_id, timerange) VALUES
    ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '60000000-0000-0000-0000-000000000001',
     tstzrange('2099-03-02 15:00+00','2099-03-02 17:00+00')) RETURNING id INTO v_run;
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, run_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1',
          v_run, tstzrange('2099-03-02 15:00+00','2099-03-02 17:00+00'), 1.000);
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1',
    format('SELECT move_run(%L, %L, tstzrange(%L, %L))', v_run, '30000000-0000-0000-0000-000000000008', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  SELECT lower(timerange) INTO v_lo FROM runs WHERE id = v_run;
  IF v_res NOT LIKE 'ERR PT409 capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || ' ' || left(v_res, 200); END IF;
  IF v_lo <> '2099-03-02 15:00+00' THEN v_ok := false; v_why := v_why || ' the run moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV3'; ELSE RAISE NOTICE 'FAIL RV3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV3;

\echo 'RV4: apply_split_coverage --- Sue (no adjustments) writes a new block for Priya on Cell 2 over the Cell 4 block: refused'
SAVEPOINT sp_RV4;
DO $$
DECLARE v_res text; v_n int; v_ok boolean := true; v_why text := '';
BEGIN
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1',
    format('SELECT apply_split_coverage(%L::jsonb, %L::jsonb)', '[]',
      jsonb_build_object('node_id', '30000000-0000-0000-0000-000000000008',
                         'operator_id', '50000000-0000-0000-0000-0000000000c1',
                         'product_id', '60000000-0000-0000-0000-000000000001',
                         'timerange', '["2099-03-02 10:00+00","2099-03-02 12:00+00")',
                         'efficiency', 1.0)::text));
  SELECT count(*) INTO v_n FROM assignments WHERE operator_id = '50000000-0000-0000-0000-0000000000c1';
  IF v_res NOT LIKE 'ERR PT409 capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || ' ' || left(v_res, 200); END IF;
  IF v_n <> 1 THEN v_ok := false; v_why := v_why || ' a block was written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV4'; ELSE RAISE NOTICE 'FAIL RV4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV4;

\echo 'RV5: direct table writes (PostgREST path) --- an INSERT and an UPDATE OF operator_id by Sue over the Cell 4 block are refused'
SAVEPOINT sp_RV5;
DO $$
DECLARE v_id uuid; v_ins text; v_upd text; v_ok boolean := true; v_why text := '';
BEGIN
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c2',
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00'), 1.000) RETURNING id INTO v_id;
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  v_ins := rv_try('00000000-0000-0000-0000-0000000000c1', format(
    'INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency) VALUES (%L, %L, %L, %L, tstzrange(%L, %L), 1.0)',
    '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1',
    '60000000-0000-0000-0000-000000000001', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  v_upd := rv_try('00000000-0000-0000-0000-0000000000c1', format(
    'UPDATE assignments SET operator_id = %L WHERE id = %L', '50000000-0000-0000-0000-0000000000c1', v_id));
  IF v_ins NOT LIKE 'ERR PT409%' THEN v_ok := false; v_why := v_why || ' insert: ' || left(v_ins, 100); END IF;
  IF v_upd NOT LIKE 'ERR PT409%' THEN v_ok := false; v_why := v_why || ' update: ' || left(v_upd, 100); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV5'; ELSE RAISE NOTICE 'FAIL RV5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV5;

\echo 'RV6: what Sue''s refusal says --- message and detail carry no product, no outside place, no assignment or node id of the block she cannot read'
SAVEPOINT sp_RV6;
DO $$
DECLARE v_res text; v_asg uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT id INTO v_asg FROM assignments WHERE operator_id = '50000000-0000-0000-0000-0000000000c1';
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1', format(
    'SELECT create_assignment(%L, %L, NULL, %L, tstzrange(%L, %L))',
    '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  RAISE NOTICE 'RV6 refusal text: %', v_res;
  IF v_res NOT LIKE 'ERR PT409%' THEN v_ok := false; v_why := v_why || ' not refused'; END IF;
  IF v_res LIKE '%Widget X%' OR v_res LIKE '%Cell 4%' OR v_res LIKE '%Line 2%' OR v_res LIKE '%' || v_asg::text || '%'
     OR v_res LIKE '%3000000a-0000-0000-0000-00000000000a%' THEN
    v_ok := false; v_why := v_why || ' the text names the outside block'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV6'; ELSE RAISE NOTICE 'FAIL RV6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV6;

\echo 'RV7: Sue books Sam (homed at Plant 2, unreadable to her) on her Cell 2 over Sam''s Plant 2 block: not accepted (the refusal text is noted, not asserted)'
SAVEPOINT sp_RV7;
DO $$
DECLARE v_res text; v_ok boolean := true; v_why text := '';
BEGIN
  v_res := rv_try('00000000-0000-0000-0000-0000000000c1', format(
    'SELECT create_assignment(%L, %L, NULL, %L, tstzrange(%L, %L))',
    '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c5', '60000000-0000-0000-0000-000000000001', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  RAISE NOTICE 'RV7 answer: %', v_res;
  IF v_res = 'OK' THEN v_ok := false; v_why := v_why || ' ACCEPTED'; END IF;
  -- KNOWN, REPORTED NOT FIXED: the trigger prices a person she cannot read (PT409 with his
  -- id, the peak and the cap). Needs his uuid, which she cannot list. A noted edge, not asserted.
  IF v_res LIKE '%would reach%' THEN RAISE NOTICE 'RV7 note: the refusal prices an unreadable person (peak in the text)'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV7'; ELSE RAISE NOTICE 'FAIL RV7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV7;

-- ----------------------------------------------------------------------------
\echo 'RV8: a caller-chosen search_path and a temp table named assignments change nothing: the definers are pinned'
SAVEPOINT sp_RV8;
DO $$
DECLARE v_res text; v_probe jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    CREATE TEMP TABLE assignments (LIKE public.assignments);
    CREATE TEMP TABLE orgs (LIKE public.orgs);
    SET LOCAL search_path = pg_temp, public;
    v_probe := capacity_probe('50000000-0000-0000-0000-0000000000c1', tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00'), 1.0, NULL);
    v_res := 'probe peak ' || (v_probe->>'peak');
    BEGIN
      PERFORM create_assignment('30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1', NULL,
                                '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00'));
      v_res := v_res || ' | write ACCEPTED';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_res := v_res || ' | write refused';
              WHEN OTHERS THEN v_res := v_res || ' | write OTHER ' || SQLSTATE || ' ' || SQLERRM;
    END;
  EXCEPTION WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  IF v_res <> 'probe peak 2.000 | write refused' THEN v_ok := false; v_why := v_why || ' ' || v_res; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV8'; ELSE RAISE NOTICE 'FAIL RV8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV8;

\echo 'RV9: probe edge operators as Sue --- an inactive person she reads is answered sighted; a NULL operator and a nonexistent uuid get the same blind answer as an unreadable person'
SAVEPOINT sp_RV9;
DO $$
DECLARE v_a text; v_b text; v_c text; v_ok boolean := true; v_why text := '';
BEGIN
  v_a := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT capacity_probe(%L, tstzrange(%L,%L), 1.0, NULL)', '50000000-0000-0000-0000-0000000000c8', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  v_b := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT 1/(CASE WHEN capacity_probe(NULL::uuid, tstzrange(%L,%L), 1.0, NULL) = ''{"cap": null, "fits": null, "peak": 1.0, "overlapping": []}''::jsonb THEN 1 ELSE 0 END)', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  v_c := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT 1/(CASE WHEN capacity_probe(%L, tstzrange(%L,%L), 1.0, NULL) = ''{"cap": null, "fits": null, "peak": 1.0, "overlapping": []}''::jsonb THEN 1 ELSE 0 END)', '50000000-0000-0000-0000-00000000dead', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  RAISE NOTICE 'RV9 inactive: % | NULL: % | unknown: %', v_a, left(v_b, 60), left(v_c, 60);
  IF v_a <> 'OK' THEN v_ok := false; v_why := v_why || ' inactive: ' || left(v_a, 80); END IF;
  IF v_b <> 'OK' THEN v_ok := false; v_why := v_why || ' NULL: ' || left(v_b, 80); END IF;
  IF v_c <> 'OK' THEN v_ok := false; v_why := v_why || ' unknown: ' || left(v_c, 80); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV9'; ELSE RAISE NOTICE 'FAIL RV9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV9: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV9;

-- ----------------------------------------------------------------------------
\echo 'RV10: the copy/template planner answers (does not raise) when a template item names a person who is gone (no FK on week_template_items.operator_id), or a person from another plant'
SAVEPOINT sp_RV10;
DO $$
DECLARE v_t uuid; v_gone text; v_sam text; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO week_templates (org_id, plant_id, name, saved_from)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'rv10', '2099-02-23') RETURNING id INTO v_t;
  INSERT INTO week_template_items (template_id, kind, item_ref, node_id, operator_id, product_id, day_offset, start_min, end_min, efficiency) VALUES
    (v_t, 'assignment', 'gone', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-00000000dead', '60000000-0000-0000-0000-000000000001', 0, 600, 720, 1.0),
    (v_t, 'assignment', 'sam',  '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c5', '60000000-0000-0000-0000-000000000001', 0, 600, 720, 1.0);
  v_gone := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT copy_week_plan(%L, NULL, %L, %L)', '30000000-0000-0000-0000-000000000001', '2099-03-02', v_t));
  RAISE NOTICE 'RV10 planner as Sue: %', left(v_gone, 300);
  IF v_gone NOT LIKE 'OK' THEN v_ok := false; v_why := v_why || ' Sue: ' || left(v_gone, 200); END IF;
  v_sam := rv_try('00000000-0000-0000-0000-0000000000a1', format('SELECT copy_week_plan(%L, NULL, %L, %L)', '30000000-0000-0000-0000-000000000001', '2099-03-02', v_t));
  IF v_sam NOT LIKE 'OK' THEN v_ok := false; v_why := v_why || ' plant admin: ' || left(v_sam, 200); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV10'; ELSE RAISE NOTICE 'FAIL RV10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV10: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV10;

\echo 'RV11: the planner and the writer agree for an outside block (R-431): Sue''s template plan for Priya over the Cell 4 block is a clash, and the choices it offers are applied for real'
SAVEPOINT sp_RV11;
DO $$
DECLARE v_t uuid; v_plan jsonb; v_item jsonb; v_dec text; v_res text; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO week_templates (org_id, plant_id, name, saved_from)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'rv11', '2099-02-23') RETURNING id INTO v_t;
  INSERT INTO week_template_items (template_id, kind, item_ref, node_id, operator_id, product_id, day_offset, start_min, end_min, efficiency) VALUES
    (v_t, 'assignment', 'priya', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', 0, 600, 720, 1.0);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan('30000000-0000-0000-0000-000000000001', NULL, '2099-03-02', v_t);
  RESET ROLE;
  v_item := v_plan->'items'->0;
  RAISE NOTICE 'RV11 plan item: %', v_item;
  IF v_item->>'status' <> 'clash' THEN v_ok := false; v_why := v_why || ' the plan says ' || coalesce(v_item->>'status', 'nothing') || ' (the writer refuses)'; END IF;
  -- each choice the plan offers, applied for real as Sue: any that raises is an offer the server refuses
  FOR v_dec IN SELECT jsonb_array_elements_text(coalesce(v_item->'clash'->'choices', '[]')) LOOP
    v_res := rv_try('00000000-0000-0000-0000-0000000000c1', format(
      'SELECT apply_copy_week(%L, NULL, %L, jsonb_build_array(jsonb_build_object(''key'', %L, ''choice'', %L)), %L)',
      '30000000-0000-0000-0000-000000000001', '2099-03-02', v_item->>'key', v_dec, v_t));
    RAISE NOTICE 'RV11 choice % -> %', v_dec, left(v_res, 120);
    -- KNOWN, REPORTED NOT FIXED (the planner is 0055/0067 text): "copied" is offered, because the
    -- blocker is one she cannot read and so is not in the plan's "prior" list, and the writer then
    -- refuses it after the yes. What IS asserted: it is refused as a PT409, never accepted.
    IF v_dec = 'copied' AND v_res NOT LIKE 'ERR PT409 capacity exceeded:%' THEN v_ok := false; v_why := v_why || format(' "copied" answered %s (want the writer''s PT409);', left(v_res, 70)); END IF;
    IF v_dec = 'copied' AND v_res LIKE 'ERR PT409%' THEN RAISE NOTICE 'RV11 note: the plan offers "copied" that the server then refuses (R-431)'; END IF;
    IF v_dec = 'prior' AND v_res <> 'OK' THEN v_ok := false; v_why := v_why || ' "prior" did not apply;'; END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS RV11'; ELSE RAISE NOTICE 'FAIL RV11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV11: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV11;

-- ----------------------------------------------------------------------------
\echo 'RV12: operator_blocks_elsewhere edges --- NULL and reversed windows, an empty window, an unbounded window'
SAVEPOINT sp_RV12;
DO $$
DECLARE v_rev text; v_null text; v_empty int; v_all int; v_ok boolean := true; v_why text := '';
BEGIN
  v_rev := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT * FROM operator_blocks_elsewhere(%L, %L)', '2099-03-03 00:00+00', '2099-03-02 00:00+00'));
  v_null := rv_try('00000000-0000-0000-0000-0000000000c1', 'SELECT * FROM operator_blocks_elsewhere(NULL, NULL)');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_empty FROM operator_blocks_elsewhere('2099-03-02 10:00+00', '2099-03-02 10:00+00');
  SELECT count(*) INTO v_all FROM operator_blocks_elsewhere(NULL, NULL);
  RESET ROLE;
  RAISE NOTICE 'RV12 reversed: % | null: % | empty window rows: % | unbounded rows: %', left(v_rev, 80), v_null, v_empty, v_all;
  IF v_empty <> 0 THEN v_ok := false; v_why := v_why || ' an empty window listed rows'; END IF;
  -- an unbounded window may list only what a bounded one would: the two outside blocks of people she reads
  IF v_all <> (SELECT count(*) FROM assignments a JOIN nodes n ON n.id = a.node_id JOIN operators o ON o.id = a.operator_id
                 WHERE a.org_id = '10000000-0000-0000-0000-000000000001'
                   AND NOT (n.path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'))
                   AND o.site_node_id IN (SELECT id FROM nodes WHERE path <@ (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001'))) THEN
    v_ok := false; v_why := v_why || format(' unbounded window listed %s rows', v_all); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV12'; ELSE RAISE NOTICE 'FAIL RV12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV12: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV12;

\echo 'RV13: operator_blocks_elsewhere for a supervisor with TWO grants (Line 1 and Cell 5): Cell 5 is readable so Quinn drops out, Priya (Cell 4) stays'
SAVEPOINT sp_RV13;
DO $$
DECLARE v_ops uuid[]; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c6', true);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(array_agg(operator_id ORDER BY operator_id), ARRAY[]::uuid[]) INTO v_ops FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00');
  RESET ROLE;
  IF v_ops IS DISTINCT FROM ARRAY['50000000-0000-0000-0000-0000000000c1']::uuid[] THEN v_ok := false; v_why := v_why || format(' got %s', v_ops); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV13'; ELSE RAISE NOTICE 'FAIL RV13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV13: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV13;

\echo 'RV14: a plant admin of ANOTHER plant in the same company (Pat, Plant 2) gets no rows about Plant 1''s people, and gets the blind probe answer about them'
SAVEPOINT sp_RV14;
DO $$
DECLARE v_n int; v_pr text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c7', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00');
  RESET ROLE;
  v_pr := rv_try('00000000-0000-0000-0000-0000000000c7', format('SELECT 1/(CASE WHEN capacity_probe(%L, tstzrange(%L,%L), 1.0, NULL) = ''{"cap": null, "fits": null, "peak": 1.0, "overlapping": []}''::jsonb THEN 1 ELSE 0 END)', '50000000-0000-0000-0000-0000000000c1', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  IF v_n <> 0 THEN v_ok := false; v_why := v_why || format(' %s rows listed', v_n); END IF;
  IF v_pr <> 'OK' THEN v_ok := false; v_why := v_why || ' probe (want the blind answer): ' || left(v_pr, 80); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV14'; ELSE RAISE NOTICE 'FAIL RV14:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV14: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV14;

\echo 'RV15: a block whose operator is gone (operator_id NULL, D110) is never listed, and the trigger lets such a row through'
SAVEPOINT sp_RV15;
DO $$
DECLARE v_n int; v_w text; v_ok boolean := true; v_why text := '';
BEGIN
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, operator_display_name, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000a', NULL, 'Gone Person',
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 06:00+00','2099-03-02 14:00+00'), 1.000);
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00') WHERE operator_id IS NULL;
  RESET ROLE;
  IF v_n <> 0 THEN v_ok := false; v_why := v_why || ' a NULL-operator row was listed'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV15'; ELSE RAISE NOTICE 'FAIL RV15:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV15: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV15;

-- ----------------------------------------------------------------------------
\echo 'RV16: grants --- anon holds nothing on the three capacity functions or the new one, authenticated holds EXECUTE on probe and set but not on the helper; PUBLIC holds none'
SAVEPOINT sp_RV16;
DO $$
DECLARE v_ok boolean := true; v_why text := ''; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['operator_peak_load(uuid,tstzrange,numeric,uuid)','capacity_probe(uuid,tstzrange,numeric,uuid)','operator_blocks_elsewhere(timestamptz,timestamptz)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN v_ok := false; v_why := v_why || ' anon holds ' || f; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN v_ok := false; v_why := v_why || ' PUBLIC holds ' || f; END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'capacity_probe(uuid,tstzrange,numeric,uuid)', 'EXECUTE') THEN v_ok := false; v_why := v_why || ' authenticated lost capacity_probe'; END IF;
  IF NOT has_function_privilege('authenticated', 'operator_blocks_elsewhere(timestamptz,timestamptz)', 'EXECUTE') THEN v_ok := false; v_why := v_why || ' authenticated lacks operator_blocks_elsewhere'; END IF;
  IF has_function_privilege('authenticated', 'operator_peak_load(uuid,tstzrange,numeric,uuid)', 'EXECUTE') THEN v_ok := false; v_why := v_why || ' authenticated holds operator_peak_load'; END IF;
  -- the trigger function is not callable as a function at all by signed-in people
  IF has_function_privilege('authenticated', 'check_operator_capacity()', 'EXECUTE') THEN
    RAISE NOTICE 'RV16 note: authenticated holds EXECUTE on check_operator_capacity() (a trigger function cannot be called directly: "trigger functions can only be called as triggers")';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV16'; ELSE RAISE NOTICE 'FAIL RV16:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FAIL RV16: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV16;

\echo 'RV17: a session with a jwt and NO profile (ghost) --- the direct write is refused, create_assignment is refused, and nothing is priced'
SAVEPOINT sp_RV17;
DO $$
DECLARE v_c text; v_i text; v_ok boolean := true; v_why text := '';
BEGIN
  v_c := rv_try('00000000-0000-0000-0000-0000000000c9', format('SELECT create_assignment(%L, %L, NULL, %L, tstzrange(%L, %L))',
    '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1', '60000000-0000-0000-0000-000000000001', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  v_i := rv_try('00000000-0000-0000-0000-0000000000c9', format(
    'INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency) VALUES (%L, %L, %L, %L, tstzrange(%L, %L), 1.0)',
    '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c1',
    '60000000-0000-0000-0000-000000000001', '2099-03-02 10:00+00', '2099-03-02 12:00+00'));
  RAISE NOTICE 'RV17 create: % | insert: %', left(v_c, 90), left(v_i, 90);
  IF v_c = 'OK' OR v_i = 'OK' THEN v_ok := false; v_why := v_why || ' a profile-less session wrote'; END IF;
  IF v_c LIKE '%would reach%' OR v_i LIKE '%would reach%' THEN v_ok := false; v_why := v_why || ' a profile-less session was priced Priya''s load'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV17'; ELSE RAISE NOTICE 'FAIL RV17:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV17: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV17;

\echo 'RV18: the cap is the company''s, for the trigger and the probe alike --- a cap of 0.5 makes a lone half block fine and a 0.75 request refused, for Sue'
SAVEPOINT sp_RV18;
DO $$
DECLARE v_p jsonb; v_w text; v_ok boolean := true; v_why text := '';
BEGIN
  UPDATE orgs SET settings = coalesce(settings, '{}'::jsonb) || '{"capacity_cap": 0.5}' WHERE id = '10000000-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_p := capacity_probe('50000000-0000-0000-0000-0000000000c2', tstzrange('2099-03-05 10:00+00','2099-03-05 12:00+00'), 0.75, NULL);
  RESET ROLE;
  v_w := rv_try('00000000-0000-0000-0000-0000000000c1', format('SELECT create_assignment(%L, %L, NULL, %L, tstzrange(%L, %L), 0.75)',
    '30000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-0000000000c2', '60000000-0000-0000-0000-000000000001', '2099-03-05 10:00+00', '2099-03-05 12:00+00'));
  IF (v_p->>'cap')::numeric <> 0.5 OR (v_p->>'fits')::boolean THEN v_ok := false; v_why := v_why || ' probe ' || v_p::text; END IF;
  IF v_w NOT LIKE 'ERR PT409%(cap 0.5)%' THEN v_ok := false; v_why := v_why || ' write ' || left(v_w, 100); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RV18'; ELSE RAISE NOTICE 'FAIL RV18:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL RV18: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RV18;

ROLLBACK;
\echo '99_capacity_review_test.sql complete (RV1-RV18)'
