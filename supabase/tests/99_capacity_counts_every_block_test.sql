-- ============================================================================
-- 99_capacity_counts_every_block_test.sql --- migration 0085 (DEF-0053, R-465,
-- R-033, R-431).
--
-- A person busy where the caller cannot see is still busy. The server's
-- double-booking sum (operator_peak_load, behind the assignments_capacity
-- trigger and capacity_probe) used to be computed from the CALLER'S view, so a
-- line supervisor's sum left out every block on a place outside her grant.
-- 20_capacity_test.sql cannot see this (it runs as one role that reads
-- everything); every case here is measured as `authenticated` with a real jwt
-- sub, as a supervisor scoped to ONE line.
--
-- FIXTURE --- the SEED's org 1 (Northwind) and org 2 (Contoso), plus:
--   Sue (c1)   supervisor with a grant on Line 1 ONLY (30..04). She reads the
--              whole plant's PEOPLE (0058) but not Line 2's cells (Cell 4, 5).
--   Priya (c1) home Plant 1, one full block on Cell 4 (Line 2), 06-14 on 2099-03-02
--   Quinn (c3) half block on Cell 5 (Line 2), 08-12
--   Rosa  (c4) full block on Cell 3 (Line 1) 06-14 --- a READABLE block
--   Sam   (c5) homed at Plant 2 (a second root, outside Sue's plant), a block
--              on a Plant 2 cell --- a person Sue cannot read at all
--   Pia   (c2) free all day
--   The plant admin (a1) reads everything; Contoso's admin (b1) is company 2.
--
-- CASES
--   CB1   Sue's write over Priya's outside block is REFUSED (capacity_exceeded,
--         would reach 2.000); the plant admin's identical write is refused the same
--         way; both read capacity_probe as fits false with the same peak
--   CB2   half and half is legal across the boundary (R-033): 0.5 outside + 0.5 hers
--   CB3   Sue's probe row for the outside block: outside true, place, parent,
--         hours, efficiency, and JSON null for assignment_id / node_id /
--         product_name --- nothing else of that block in the text; the admin's row
--         for the same block carries them
--   CB4   an UPDATE that moves her own block into the outside block's hours is refused
--   CB5   another company learns nothing: capacity_probe answers blind, operator_peak_load
--         answers the bare request; same for a signed-in session with no profile
--   CB6   capacity_probe answers blind (fits null) for an operator the caller cannot read (Sam), and
--         holds to operators_select person by person for Sue, the admin, Contoso
--   CB7   operator_blocks_elsewhere lists exactly the outside blocks of people Sue reads
--   CB8   operator_blocks_elsewhere held to the writer: a row => her write is
--         refused; no row and no readable block => accepted (every person Sue reads)
--   CB9   operator_blocks_elsewhere is empty for the plant admin, company 2, a
--         profile-less session, and the owner
--   CB10  the seed path: an owner insert (no identity) still fires the trigger,
--         still refuses a real double-booking, and operator_peak_load still sums
--         every block
--   CB11  apply_split_coverage on a block Sue cannot edit is still refused
--   CB12  fits / peak / cap agree between Sue and the plant admin for every person
--   CB13  operator_peak_load is closed to signed-in people (EXECUTE revoked, 0085)
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'sue@northwind.example'),
  ('00000000-0000-0000-0000-0000000000c9', 'ghost@nowhere.example')   -- an identity with NO profile row
ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000c1', 'supervisor', 'direct')
ON CONFLICT DO NOTHING;
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-000000000004',
   '10000000-0000-0000-0000-000000000001', 'supervisor')          -- Line 1 only
ON CONFLICT DO NOTHING;

-- A second plant in company 1, for a person Sue cannot read at all.
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c0', '10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000000', NULL, 'Plant 2'),
  ('30000000-0000-0000-0000-0000000000c6', '10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-0000000000c0', 'Area P2');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c7', '10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-0000000000c6', 'Line P2');
INSERT INTO nodes (id, org_id, level_id, parent_id, name) VALUES
  ('30000000-0000-0000-0000-0000000000c8', '10000000-0000-0000-0000-000000000001',
   '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-0000000000c7', 'Cell P2');

INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES
  ('50000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', 'Priya Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c2', '10000000-0000-0000-0000-000000000001', 'Pia Test',   '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c3', '10000000-0000-0000-0000-000000000001', 'Quinn Test', '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c4', '10000000-0000-0000-0000-000000000001', 'Rosa Test',  '30000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-0000000000c5', '10000000-0000-0000-0000-000000000001', 'Sam Test',   '30000000-0000-0000-0000-0000000000c0');

-- Cell 2 = 30..08 (Line 1, Sue's), Cell 3 = 30..09 (Line 1), Cell 4 = 3000000a..0a and
-- Cell 5 = 3000000a..0b (Line 2, outside Sue's grant). Product WX = 60..01.
-- WHY THE CAPACITY TRIGGER IS OFF WHILE THE FIXTURE IS WRITTEN. This file runs as one
-- backend. Every fixture row written here as the owner would fire assignments_capacity as
-- the owner and leave operator_peak_load's plan warm for a role that reads everything; a
-- later call as Sue is then answered from that plan (a SQL-language function's plan is
-- kept per backend) and a blind, invoker helper would look sighted (found by the
-- SECURITY DEFINER mutation, which stayed green until this was done). Writing the
-- fixture with the trigger off keeps every measurement below cold, as a real request is.
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

\echo 'CB1: Sue (Line 1 only) is REFUSED over Priya''s Cell 4 block; the plant admin is refused the same; both probes read fits false, same peak'
SAVEPOINT sp_CB1;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_sue text; v_adm text; v_ps jsonb; v_pa jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000008', v_p, NULL, '60000000-0000-0000-0000-000000000001', v_win);
    v_sue := 'ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_sue := SQLERRM;
            WHEN OTHERS THEN v_sue := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
  END;
  v_ps := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000008', v_p, NULL, '60000000-0000-0000-0000-000000000001', v_win);
    v_adm := 'ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_adm := SQLERRM;
            WHEN OTHERS THEN v_adm := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
  END;
  v_pa := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  IF v_sue NOT LIKE 'capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || format(' Sue: %s', v_sue); END IF;
  IF v_adm NOT LIKE 'capacity exceeded:%would reach 2.000%' THEN v_ok := false; v_why := v_why || format(' admin: %s', v_adm); END IF;
  IF (v_ps->>'fits')::boolean IS DISTINCT FROM false OR (v_pa->>'fits')::boolean IS DISTINCT FROM false THEN
    v_ok := false; v_why := v_why || format(' fits: sue %s admin %s', v_ps->>'fits', v_pa->>'fits'); END IF;
  IF (v_ps->>'peak')::numeric IS DISTINCT FROM 2 OR (v_pa->>'peak')::numeric IS DISTINCT FROM 2 THEN
    v_ok := false; v_why := v_why || format(' peak: sue %s admin %s', v_ps->>'peak', v_pa->>'peak'); END IF;
  IF (SELECT count(*) FROM assignments WHERE operator_id = v_p) <> 1 THEN
    v_ok := false; v_why := v_why || ' a second block was written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB1'; ELSE RAISE NOTICE 'FAIL CB1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB1;

\echo 'CB2: half and half is still legal across the boundary --- outside 0.5, hers 0.5 (R-033)'
SAVEPOINT sp_CB2;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_res text; v_probe jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  UPDATE assignments SET efficiency = 0.5 WHERE operator_id = v_p;
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_probe := capacity_probe(v_p, v_win, 0.5, NULL);
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000008', v_p, NULL, '60000000-0000-0000-0000-000000000001', v_win, 0.5);
    v_res := 'ACCEPTED';
  EXCEPTION WHEN OTHERS THEN v_res := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  IF v_res <> 'ACCEPTED' THEN v_ok := false; v_why := v_why || ' refused: ' || v_res; END IF;
  IF (v_probe->>'fits')::boolean IS DISTINCT FROM true OR (v_probe->>'peak')::numeric IS DISTINCT FROM 1 THEN
    v_ok := false; v_why := v_why || format(' probe %s', v_probe); END IF;
  IF (SELECT count(*) FROM assignments WHERE operator_id = v_p) <> 2 THEN v_ok := false; v_why := v_why || ' not written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB2'; ELSE RAISE NOTICE 'FAIL CB2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB2;

\echo 'CB3: Sue''s probe row for the outside block is place and hours only (nulls for ids and product); the admin''s carries them'
SAVEPOINT sp_CB3;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_asg uuid; v_sue jsonb; v_adm jsonb; v_rs jsonb; v_ra jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT id INTO v_asg FROM assignments WHERE operator_id = v_p;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  v_sue := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_adm := capacity_probe(v_p, v_win, 1.0, NULL);
  RESET ROLE;
  RAISE NOTICE 'CB3 sue probe: %', v_sue;
  v_rs := v_sue->'overlapping'->0;
  v_ra := v_adm->'overlapping'->0;
  IF jsonb_array_length(v_sue->'overlapping') <> 1 THEN v_ok := false; v_why := v_why || ' sue rows <> 1'; END IF;
  IF (v_rs->>'outside')::boolean IS DISTINCT FROM true THEN v_ok := false; v_why := v_why || ' sue outside not true'; END IF;
  IF v_rs->>'node_name' IS DISTINCT FROM 'Cell 4' OR v_rs->>'parent_name' IS DISTINCT FROM 'Line 2' THEN
    v_ok := false; v_why := v_why || format(' place %s / %s', v_rs->>'node_name', v_rs->>'parent_name'); END IF;
  IF (v_rs->>'efficiency')::numeric IS DISTINCT FROM 1 OR v_rs->>'timerange' NOT LIKE '%2099-03-02 06:00:00+00%2099-03-02 14:00:00+00%' THEN
    v_ok := false; v_why := v_why || format(' hours %s eff %s', v_rs->>'timerange', v_rs->>'efficiency'); END IF;
  IF NOT (v_rs ? 'assignment_id' AND v_rs ? 'node_id' AND v_rs ? 'product_name') THEN
    v_ok := false; v_why := v_why || ' a key is missing'; END IF;
  IF jsonb_typeof(v_rs->'assignment_id') <> 'null' OR jsonb_typeof(v_rs->'node_id') <> 'null' OR jsonb_typeof(v_rs->'product_name') <> 'null' THEN
    v_ok := false; v_why := v_why || format(' not null: %s', v_rs); END IF;
  IF v_sue::text LIKE '%Widget X%' OR v_sue::text LIKE '%' || v_asg::text || '%' OR v_sue::text LIKE '%3000000a-0000-0000-0000-00000000000a%' THEN
    v_ok := false; v_why := v_why || ' the product, an id or the node id leaked into the text'; END IF;
  IF (v_ra->>'outside')::boolean IS DISTINCT FROM false OR v_ra->>'assignment_id' IS DISTINCT FROM v_asg::text
     OR v_ra->>'node_id' IS DISTINCT FROM '3000000a-0000-0000-0000-00000000000a' OR v_ra->>'product_name' IS DISTINCT FROM 'Widget X'
     OR v_ra->>'parent_name' IS DISTINCT FROM 'Line 2' OR v_ra->>'node_name' IS DISTINCT FROM 'Cell 4' THEN
    v_ok := false; v_why := v_why || format(' admin row %s', v_ra); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB3'; ELSE RAISE NOTICE 'FAIL CB3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB3;

\echo 'CB4: an UPDATE that moves her own block into the outside block''s hours is refused (the trigger fires on UPDATE OF timerange)'
SAVEPOINT sp_CB4;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_mine uuid; v_res text; v_ok boolean := true; v_why text := '';
BEGIN
  -- her own block, clear of the outside one (15:00-17:00 on Cell 2)
  ALTER TABLE assignments DISABLE TRIGGER assignments_capacity;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', v_p,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 15:00+00','2099-03-02 17:00+00'), 1.000)
  RETURNING id INTO v_mine;
  ALTER TABLE assignments ENABLE TRIGGER assignments_capacity;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE assignments SET timerange = tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00') WHERE id = v_mine;
    v_res := 'ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_res := SQLERRM;
            WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
  END;
  -- stretching it (15:00-17:00 -> 09:00-17:00) reaches the outside block too
  BEGIN
    UPDATE assignments SET timerange = tstzrange('2099-03-02 09:00+00','2099-03-02 17:00+00') WHERE id = v_mine;
    v_res := v_res || ' | stretch ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_res := v_res || ' | stretch refused';
            WHEN OTHERS THEN v_res := v_res || ' | stretch OTHER ' || SQLSTATE;
  END;
  RESET ROLE;
  IF v_res NOT LIKE 'capacity exceeded:%would reach 2.000%| stretch refused' THEN v_ok := false; v_why := v_why || ' ' || v_res; END IF;
  IF (SELECT lower(timerange) FROM assignments WHERE id = v_mine) <> '2099-03-02 15:00+00' THEN
    v_ok := false; v_why := v_why || ' the block moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB4'; ELSE RAISE NOTICE 'FAIL CB4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB4;

\echo 'CB5: another company learns nothing --- Contoso''s admin and a profile-less session get no sum of Priya''s'
SAVEPOINT sp_CB5;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_who record; v_load numeric; v_probe text; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_who IN SELECT * FROM (VALUES
      ('Contoso admin',  '00000000-0000-0000-0000-0000000000b1'),
      ('no-profile',     '00000000-0000-0000-0000-0000000000c9')) AS t(name, sub) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_who.sub, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      v_probe := capacity_probe(v_p, v_win, 1.0, NULL)::text;
      -- The invoker answer for a person she cannot read: no verdict, no cap, the bare
      -- request, no rows (review: a raise here failed the copy-week planners).
      IF v_probe::jsonb = '{"cap": null, "fits": null, "peak": 1.0, "overlapping": []}'::jsonb THEN v_probe := 'BARE'; END IF;
    EXCEPTION WHEN OTHERS THEN v_probe := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
    END;
    RESET ROLE;
    -- The contract tightened (0085 revoked EXECUTE on operator_peak_load from signed-in
    -- people, CB13), so its company term is now read as the owner's connection carrying this
    -- caller's identity: the jwt claim is what auth.uid() reads, and it is what the definer
    -- callers see too.
    v_load := operator_peak_load(v_p, v_win, 0.75, NULL);
    IF v_load IS DISTINCT FROM 0.75 THEN v_ok := false; v_why := v_why || format(' %s peak_load %s (a sum of Priya''s leaked)', v_who.name, v_load); END IF;
    IF v_probe <> 'BARE' THEN v_ok := false; v_why := v_why || format(' %s probe %s', v_who.name, left(v_probe, 80)); END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS CB5'; ELSE RAISE NOTICE 'FAIL CB5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB5;

\echo 'CB13: operator_peak_load is closed to signed-in people --- Sue, the plant admin, Contoso admin and a profile-less session are all refused (permission denied), and the trigger and probe still answer through the definers'
SAVEPOINT sp_CB13;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c1';
        v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_who record; v_res text; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_who IN SELECT * FROM (VALUES
      ('Sue',           '00000000-0000-0000-0000-0000000000c1'),
      ('plant admin',   '00000000-0000-0000-0000-0000000000a1'),
      ('Contoso admin', '00000000-0000-0000-0000-0000000000b1'),
      ('no-profile',    '00000000-0000-0000-0000-0000000000c9')) AS t(name, sub) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_who.sub, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM operator_peak_load(v_p, v_win, 1.0, NULL);
      v_res := 'ANSWERED';
    EXCEPTION WHEN insufficient_privilege THEN v_res := 'REFUSED';
              WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE;
    END;
    RESET ROLE;
    IF v_res <> 'REFUSED' THEN v_ok := false; v_why := v_why || format(' %s: %s', v_who.name, v_res); END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'operator_peak_load(uuid,tstzrange,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'operator_peak_load(uuid,tstzrange,numeric,uuid)', 'EXECUTE') THEN
    v_ok := false; v_why := v_why || ' a signed-in role holds EXECUTE';
  END IF;
  -- The definer attribute is held by the catalog: with both callers definers an invoker helper
  -- would run as the owner and read the same rows, so no answer would show its loss.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('operator_peak_load','check_operator_capacity','capacity_probe') AND NOT prosecdef) THEN
    v_ok := false; v_why := v_why || ' a capacity function lost SECURITY DEFINER';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB13'; ELSE RAISE NOTICE 'FAIL CB13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB13: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB13;

\echo 'CB6: capacity_probe gives the blind answer for an operator the caller cannot read (Sam, Plant 2), and agrees with operators_select person by person'
SAVEPOINT sp_CB6;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_who record; v_op record; v_sees boolean; v_answers boolean; v_n int := 0; v_sam text;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_sam := capacity_probe('50000000-0000-0000-0000-0000000000c5', v_win, 1.0, NULL)::text;
    -- Sam has a full block in the window; a sighted answer would say peak 2. The blind answer
    -- is the bare request with no verdict, no cap and no rows (what the invoker version said).
    IF v_sam::jsonb = '{"cap": null, "fits": null, "peak": 1.0, "overlapping": []}'::jsonb THEN v_sam := 'BARE'; END IF;
  EXCEPTION WHEN OTHERS THEN v_sam := 'OTHER ' || SQLSTATE;
  END;
  RESET ROLE;
  IF v_sam <> 'BARE' THEN v_ok := false; v_why := v_why || ' Sue was answered about Sam: ' || v_sam; END IF;
  FOR v_who IN SELECT * FROM (VALUES
      ('Sue',           '00000000-0000-0000-0000-0000000000c1'),
      ('plant admin',   '00000000-0000-0000-0000-0000000000a1'),
      ('Ana',           '00000000-0000-0000-0000-0000000000a2'),
      ('Contoso admin', '00000000-0000-0000-0000-0000000000b1'),
      ('no-profile',    '00000000-0000-0000-0000-0000000000c9')) AS t(name, sub) LOOP
    FOR v_op IN SELECT id FROM operators ORDER BY id LOOP
      v_n := v_n + 1;
      PERFORM set_config('request.jwt.claim.sub', v_who.sub, true);
      SET LOCAL ROLE authenticated;
      SELECT EXISTS (SELECT 1 FROM operators o WHERE o.id = v_op.id) INTO v_sees;
      v_answers := jsonb_typeof(capacity_probe(v_op.id, v_win, 0.1, NULL)->'fits') <> 'null';
      RESET ROLE;
      IF v_sees <> v_answers THEN
        v_ok := false; v_why := v_why || format(' %s/%s: reads=%s answered=%s', v_who.name, v_op.id, v_sees, v_answers);
      END IF;
    END LOOP;
  END LOOP;
  IF v_n < 20 THEN v_ok := false; v_why := v_why || ' too few pairs walked'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB6'; ELSE RAISE NOTICE 'FAIL CB6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB6: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB6;

\echo 'CB7: operator_blocks_elsewhere lists exactly the outside blocks of people Sue can read'
SAVEPOINT sp_CB7;
DO $$
DECLARE v_rows text[]; v_want text[]; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(array_agg(format('%s|%s|%s|%s|%s', r.operator_id, r.node_name, r.parent_name, r.timerange, r.efficiency)
                            ORDER BY r.operator_id), ARRAY[]::text[])
    INTO v_rows
    FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00') r;
  RESET ROLE;
  RAISE NOTICE 'CB7 rows: %', v_rows;
  -- Priya (c1) on Cell 4 and Quinn (c3) on Cell 5; NOT Rosa (readable Cell 3),
  -- NOT Sam (a person Sue cannot read), NOT Pia (no block).
  v_want := ARRAY[
    '50000000-0000-0000-0000-0000000000c1|Cell 4|Line 2|["2099-03-02 06:00:00+00","2099-03-02 14:00:00+00")|1.000',
    '50000000-0000-0000-0000-0000000000c3|Cell 5|Line 2|["2099-03-02 08:00:00+00","2099-03-02 12:00:00+00")|0.500'];
  IF v_rows IS DISTINCT FROM v_want THEN v_ok := false; v_why := v_why || format(' got %s', v_rows); END IF;
  -- the row has five columns and no product, run or assignment id
  IF (SELECT pg_get_function_result(oid) FROM pg_proc WHERE proname = 'operator_blocks_elsewhere')
     <> 'TABLE(operator_id uuid, node_name text, parent_name text, timerange tstzrange, efficiency numeric)' THEN
    v_ok := false; v_why := v_why || ' the row shape changed'; END IF;
  -- a window that touches nothing of theirs lists nothing
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM operator_blocks_elsewhere('2099-03-02 14:00+00', '2099-03-02 15:00+00')) THEN
    v_ok := false; v_why := v_why || ' a window after the blocks listed something'; END IF;
  RESET ROLE;
  IF v_ok THEN RAISE NOTICE 'PASS CB7'; ELSE RAISE NOTICE 'FAIL CB7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB7: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB7;

\echo 'CB8: operator_blocks_elsewhere is held to the writer --- a row means Sue''s overlapping write is refused, no row and no readable block means it is accepted, person by person'
SAVEPOINT sp_CB8;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 10:00+00','2099-03-02 12:00+00');
        v_op record; v_in boolean; v_readable int; v_res text; v_refused int := 0; v_accepted int := 0;
        v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_op IN SELECT id, display_name FROM operators WHERE org_id = '10000000-0000-0000-0000-000000000001' ORDER BY id LOOP
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
    SET LOCAL ROLE authenticated;
    -- only people Sue can read (Sam is Plant 2's: she cannot even name him)
    IF EXISTS (SELECT 1 FROM operators o WHERE o.id = v_op.id) THEN
      SELECT EXISTS (SELECT 1 FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00') r
                      WHERE r.operator_id = v_op.id) INTO v_in;
      SELECT count(*) INTO v_readable FROM assignments a WHERE a.operator_id = v_op.id AND a.timerange && v_win;
      BEGIN
        PERFORM create_assignment('30000000-0000-0000-0000-000000000008', v_op.id, NULL,
                                  '60000000-0000-0000-0000-000000000001', v_win);
        v_res := 'ACCEPTED';
      EXCEPTION WHEN SQLSTATE 'PT409' THEN v_res := 'REFUSED';
                WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
      END;
      IF v_in AND v_res <> 'REFUSED' THEN
        v_ok := false; v_why := v_why || format(' %s is listed but her write was %s', v_op.display_name, v_res);
      ELSIF v_in THEN v_refused := v_refused + 1;
      ELSIF v_readable = 0 AND v_res <> 'ACCEPTED' THEN
        v_ok := false; v_why := v_why || format(' %s has no row and no readable block but her write was %s', v_op.display_name, v_res);
      ELSIF v_readable = 0 THEN v_accepted := v_accepted + 1;
      END IF;
    END IF;
    RESET ROLE;
  END LOOP;
  IF v_refused <> 2 THEN v_ok := false; v_why := v_why || format(' %s listed people were walked (want 2)', v_refused); END IF;
  IF v_accepted < 5 THEN v_ok := false; v_why := v_why || format(' only %s clean people were walked', v_accepted); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB8'; ELSE RAISE NOTICE 'FAIL CB8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB8: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB8;

\echo 'CB9: operator_blocks_elsewhere is empty for the plant admin, for company 2, for a profile-less session and for the owner'
SAVEPOINT sp_CB9;
DO $$
DECLARE v_who record; v_n int; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_who IN SELECT * FROM (VALUES
      ('plant admin',   '00000000-0000-0000-0000-0000000000a1'),
      ('Contoso admin', '00000000-0000-0000-0000-0000000000b1'),
      ('no-profile',    '00000000-0000-0000-0000-0000000000c9')) AS t(name, sub) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_who.sub, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00');
    RESET ROLE;
    IF v_n <> 0 THEN v_ok := false; v_why := v_why || format(' %s got %s rows', v_who.name, v_n); END IF;
  END LOOP;
  -- the owner (no identity): nothing either
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT count(*) INTO v_n FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00');
  IF v_n <> 0 THEN v_ok := false; v_why := v_why || format(' owner got %s rows', v_n); END IF;
  -- The company term is the FIRST of two independent guards: app_can_read_operator also
  -- refuses another company's people, so removing the term alone changes no answer. It is
  -- held here as text, because a guard that nothing observes is a guard that gets lost.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'operator_blocks_elsewhere') NOT LIKE '%a.org_id = app_current_org()%' THEN
    v_ok := false; v_why := v_why || ' operator_blocks_elsewhere lost its own company filter (app_can_read_operator alone still hides the rows)';
  END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB9'; ELSE RAISE NOTICE 'FAIL CB9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB9: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB9;

\echo 'CB10: the seed path --- an owner insert with no identity still fires the trigger and refuses a real double-booking; the sum sees every block'
SAVEPOINT sp_CB10;
DO $$
DECLARE v_p uuid := '50000000-0000-0000-0000-0000000000c2';
        v_caught boolean := false; v_load numeric; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'premise: the owner must have no identity'; END IF;
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000a', v_p,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-04-01 08:00+00','2099-04-01 10:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008', v_p,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-04-01 09:00+00','2099-04-01 11:00+00'), 1.000);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_caught := true;
  END;
  IF NOT v_caught THEN v_ok := false; v_why := v_why || ' the owner''s double-booking was not refused'; END IF;
  v_load := operator_peak_load(v_p, tstzrange('2099-04-01 09:00+00','2099-04-01 10:00+00'), 1.0, NULL);
  IF v_load IS DISTINCT FROM 2 THEN v_ok := false; v_why := v_why || format(' owner sum %s (want 2)', v_load); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB10'; ELSE RAISE NOTICE 'FAIL CB10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB10: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB10;

\echo 'CB11: apply_split_coverage on a block Sue cannot edit is still refused (not_permitted), and nothing moves'
SAVEPOINT sp_CB11;
DO $$
DECLARE v_asg uuid; v_res text; v_eff numeric; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT id INTO v_asg FROM assignments WHERE operator_id = '50000000-0000-0000-0000-0000000000c1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apply_split_coverage(
      jsonb_build_array(jsonb_build_object('assignment_id', v_asg, 'efficiency', 0.5)),
      jsonb_build_object('node_id', '30000000-0000-0000-0000-000000000008',
                         'operator_id', '50000000-0000-0000-0000-0000000000c1',
                         'product_id', '60000000-0000-0000-0000-000000000001',
                         'timerange', '["2099-03-02 10:00+00","2099-03-02 12:00+00")',
                         'efficiency', 0.5));
    v_res := 'ACCEPTED';
  EXCEPTION WHEN SQLSTATE 'PT403' THEN v_res := 'REFUSED';
            WHEN OTHERS THEN v_res := 'OTHER ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  SELECT efficiency INTO v_eff FROM assignments WHERE id = v_asg;
  IF v_res <> 'REFUSED' THEN v_ok := false; v_why := v_why || ' ' || v_res; END IF;
  IF v_eff <> 1 THEN v_ok := false; v_why := v_why || format(' the outside block moved to %s', v_eff); END IF;
  IF (SELECT count(*) FROM assignments WHERE operator_id = '50000000-0000-0000-0000-0000000000c1') <> 1 THEN
    v_ok := false; v_why := v_why || ' a block was written'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB11'; ELSE RAISE NOTICE 'FAIL CB11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB11: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB11;

\echo 'CB12: fits / peak / cap are the same for Sue and the plant admin, for every person they both read'
SAVEPOINT sp_CB12;
DO $$
DECLARE v_win tstzrange := tstzrange('2099-03-02 07:00+00','2099-03-02 13:00+00');
        v_op record; v_s jsonb; v_a jsonb; v_n int := 0; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_op IN SELECT id, display_name FROM operators WHERE org_id = '10000000-0000-0000-0000-000000000001' AND id <> '50000000-0000-0000-0000-0000000000c5' ORDER BY id LOOP
    v_n := v_n + 1;
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
    SET LOCAL ROLE authenticated;
    v_s := capacity_probe(v_op.id, v_win, 1.0, NULL);
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
    SET LOCAL ROLE authenticated;
    v_a := capacity_probe(v_op.id, v_win, 1.0, NULL);
    RESET ROLE;
    IF (v_s->'fits') IS DISTINCT FROM (v_a->'fits') OR (v_s->'peak') IS DISTINCT FROM (v_a->'peak')
       OR (v_s->'cap') IS DISTINCT FROM (v_a->'cap')
       OR jsonb_array_length(v_s->'overlapping') <> jsonb_array_length(v_a->'overlapping') THEN
      v_ok := false; v_why := v_why || format(' %s: sue %s vs admin %s', v_op.display_name, v_s, v_a);
    END IF;
  END LOOP;
  IF v_n < 10 THEN v_ok := false; v_why := v_why || ' too few people walked'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CB12'; ELSE RAISE NOTICE 'FAIL CB12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL CB12: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CB12;

ROLLBACK;
\echo '99_capacity_counts_every_block_test.sql complete (CB1-CB13)'
