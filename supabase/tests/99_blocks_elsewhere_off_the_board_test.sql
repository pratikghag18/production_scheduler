-- ============================================================================
-- 99_blocks_elsewhere_off_the_board_test.sql --- migration 0087 (DEF-0069, R-465).
--
-- The operator rail said "free" for a person booked on a place the caller can READ
-- but that is off the board's root: operator_blocks_elsewhere (0085) returned only
-- blocks on places the caller CANNOT read, and the board's own window holds only the
-- rows under its root. 0087 gives the function a third parameter, the board's root
-- (an ltree, the type board_window takes): with a root it returns every block of a
-- readable person that is NOT at or below that root, whether or not the caller can
-- read the place; with NULL it is 0085's answer exactly.
--
-- FIXTURE --- the same as 99_capacity_counts_every_block_test.sql (read its header):
--   Sue (c1)   supervisor with a grant on Line 1 ONLY; reads the plant's PEOPLE.
--   Priya (c1) full block on Cell 4 (Line 2), 06-14 on 2099-03-02
--   Quinn (c3) half block on Cell 5 (Line 2), 08-12
--   Rosa  (c4) full block on Cell 3 (Line 1), 06-14 --- under Sue's board root
--   Sam   (c5) homed at Plant 2: a person Sue cannot read at all
--
-- CASES
--   BO1  Sue with a VIEWER grant on Cell 4 and the Line 1 root: Priya's Cell 4 block and
--        Quinn's Cell 5 block are returned (off the board, Cell 4 readable); Rosa's
--        Cell 3 block (under the root) is not; Sam (unreadable person) is not
--   BO2  Sue WITHOUT the grant and the Line 1 root: the same two rows (the old behaviour)
--   BO3  the plant root: a block under the plant is never returned, for Sue or for the
--        plant admin; no row of Priya, Quinn or Rosa
--   BO4  another company (Contoso's admin) and a profile-less session get nothing with a root
--   BO5  a NULL root is 0085's answer exactly: the two-argument call, the explicit NULL
--        and CB7's expected rows agree, with and without the viewer grant; the function
--        exists once with the same five columns; its text carries the company filter
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'sue@northwind.example'),
  ('00000000-0000-0000-0000-0000000000c9', 'ghost@nowhere.example')
ON CONFLICT DO NOTHING;
INSERT INTO user_profiles (id, org_id, user_id, role, default_create_mode) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000c1', 'supervisor', 'direct')
ON CONFLICT DO NOTHING;
INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-000000000004',
   '10000000-0000-0000-0000-000000000001', 'supervisor')
ON CONFLICT DO NOTHING;

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

-- The fixture is written with the capacity trigger off, as 99_capacity_counts_every_block_test.sql does (read its note).
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

-- The rows one caller gets for one root, one string per row, in the function's own order.
CREATE FUNCTION pg_temp.bo_rows(p_sub text, p_root ltree, p_null_root boolean DEFAULT false) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE v text[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_sub, true);
  SET LOCAL ROLE authenticated;
  IF p_null_root THEN
    SELECT coalesce(array_agg(format('%s|%s|%s|%s|%s', r.operator_id, r.node_name, r.parent_name, r.timerange, r.efficiency)
                              ORDER BY r.operator_id), ARRAY[]::text[])
      INTO v FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00') r;
  ELSE
    SELECT coalesce(array_agg(format('%s|%s|%s|%s|%s', r.operator_id, r.node_name, r.parent_name, r.timerange, r.efficiency)
                              ORDER BY r.operator_id), ARRAY[]::text[])
      INTO v FROM operator_blocks_elsewhere('2099-03-02 00:00+00', '2099-03-03 00:00+00', p_root) r;
  END IF;
  RESET ROLE;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.bo_rows(text, ltree, boolean) TO PUBLIC;

\echo 'BO1: Sue with a viewer grant on Cell 4 and the Line 1 root: Priya (Cell 4, readable) and Quinn (Cell 5) are returned, Rosa (under the root) and Sam (unreadable) are not'
SAVEPOINT sp_BO1;
DO $$
DECLARE v_rows text[]; v_want text[]; v_ok boolean := true; v_why text := '';
BEGIN
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('a0000000-0000-0000-0000-0000000000c1', '3000000a-0000-0000-0000-00000000000a',
     '10000000-0000-0000-0000-000000000001', 'viewer');
  -- Cell 4 really is readable for her now (otherwise this case proves nothing).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  SET LOCAL ROLE authenticated;
  IF NOT ('3000000a-0000-0000-0000-00000000000a'::uuid IN (SELECT app_readable_node_ids())) THEN
    v_ok := false; v_why := v_why || ' Cell 4 is not readable for Sue with the grant'; END IF;
  RESET ROLE;
  v_rows := pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'));
  RAISE NOTICE 'BO1 rows: %', v_rows;
  v_want := ARRAY[
    '50000000-0000-0000-0000-0000000000c1|Cell 4|Line 2|["2099-03-02 06:00:00+00","2099-03-02 14:00:00+00")|1.000',
    '50000000-0000-0000-0000-0000000000c3|Cell 5|Line 2|["2099-03-02 08:00:00+00","2099-03-02 12:00:00+00")|0.500'];
  IF v_rows IS DISTINCT FROM v_want THEN v_ok := false; v_why := v_why || format(' got %s', v_rows); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS BO1'; ELSE RAISE NOTICE 'FAIL BO1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL BO1: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_BO1;

\echo 'BO2: Sue WITHOUT the grant and the Line 1 root: the same two rows (the old behaviour)'
SAVEPOINT sp_BO2;
DO $$
DECLARE v_rows text[]; v_want text[]; v_ok boolean := true; v_why text := '';
BEGIN
  v_rows := pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'));
  v_want := ARRAY[
    '50000000-0000-0000-0000-0000000000c1|Cell 4|Line 2|["2099-03-02 06:00:00+00","2099-03-02 14:00:00+00")|1.000',
    '50000000-0000-0000-0000-0000000000c3|Cell 5|Line 2|["2099-03-02 08:00:00+00","2099-03-02 12:00:00+00")|0.500'];
  IF v_rows IS DISTINCT FROM v_want THEN v_ok := false; v_why := v_why || format(' got %s', v_rows); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS BO2'; ELSE RAISE NOTICE 'FAIL BO2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL BO2: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_BO2;

\echo 'BO3: the plant root: a block under the plant is never returned, for Sue or for the plant admin'
SAVEPOINT sp_BO3;
DO $$
DECLARE v_root ltree := (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001');
        v_who record; v_rows text[]; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_who IN SELECT * FROM (VALUES
      ('Sue',         '00000000-0000-0000-0000-0000000000c1'),
      ('plant admin', '00000000-0000-0000-0000-0000000000a1')) AS t(name, sub) LOOP
    v_rows := pg_temp.bo_rows(v_who.sub, v_root);
    RAISE NOTICE 'BO3 % rows: %', v_who.name, v_rows;
    -- Priya, Quinn and Rosa are all under Plant 1; none of them may come back.
    IF EXISTS (SELECT 1 FROM unnest(v_rows) r
                WHERE r LIKE '%0000000000c1|%' OR r LIKE '%0000000000c3|%' OR r LIKE '%0000000000c4|%') THEN
      v_ok := false; v_why := v_why || format(' %s got a block under the plant: %s', v_who.name, v_rows); END IF;
  END LOOP;
  -- Sue cannot read Sam at all, so nothing for her; the plant admin reads the company's people and
  -- Sam's Plant 2 block is off Plant 1: that is the one row she may get.
  IF pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', v_root) <> ARRAY[]::text[] THEN
    v_ok := false; v_why := v_why || ' Sue got a row with the plant root'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS BO3'; ELSE RAISE NOTICE 'FAIL BO3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL BO3: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_BO3;

\echo 'BO4: another company and a profile-less session get nothing with a root'
SAVEPOINT sp_BO4;
DO $$
DECLARE v_who record; v_rows text[]; v_ok boolean := true; v_why text := '';
BEGIN
  FOR v_who IN SELECT * FROM (VALUES
      ('Contoso admin', '00000000-0000-0000-0000-0000000000b1'),
      ('no-profile',    '00000000-0000-0000-0000-0000000000c9')) AS t(name, sub) LOOP
    v_rows := pg_temp.bo_rows(v_who.sub, (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004'));
    IF v_rows <> ARRAY[]::text[] THEN v_ok := false; v_why := v_why || format(' %s got %s', v_who.name, v_rows); END IF;
  END LOOP;
  IF v_ok THEN RAISE NOTICE 'PASS BO4'; ELSE RAISE NOTICE 'FAIL BO4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL BO4: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_BO4;

\echo 'BO5: a NULL root is 0085''s answer exactly (with and without the grant); one function, five columns, the company filter'
SAVEPOINT sp_BO5;
DO $$
DECLARE v_two text[]; v_null text[]; v_want text[]; v_ok boolean := true; v_why text := '';
BEGIN
  v_want := ARRAY[
    '50000000-0000-0000-0000-0000000000c1|Cell 4|Line 2|["2099-03-02 06:00:00+00","2099-03-02 14:00:00+00")|1.000',
    '50000000-0000-0000-0000-0000000000c3|Cell 5|Line 2|["2099-03-02 08:00:00+00","2099-03-02 12:00:00+00")|0.500'];
  v_two  := pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', NULL, true);
  v_null := pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', NULL, false);
  IF v_two IS DISTINCT FROM v_want THEN v_ok := false; v_why := v_why || format(' two-argument call got %s', v_two); END IF;
  IF v_null IS DISTINCT FROM v_want THEN v_ok := false; v_why := v_why || format(' explicit NULL got %s', v_null); END IF;
  -- with the viewer grant on Cell 4 the old rule (places she cannot read) drops Priya's row
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('a0000000-0000-0000-0000-0000000000c1', '3000000a-0000-0000-0000-00000000000a',
     '10000000-0000-0000-0000-000000000001', 'viewer');
  v_two := pg_temp.bo_rows('00000000-0000-0000-0000-0000000000c1', NULL, true);
  IF v_two IS DISTINCT FROM ARRAY[v_want[2]] THEN v_ok := false; v_why := v_why || format(' with the grant, a NULL root got %s', v_two); END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'operator_blocks_elsewhere') <> 1 THEN
    v_ok := false; v_why := v_why || ' the function is not defined exactly once'; END IF;
  IF (SELECT pg_get_function_result(oid) FROM pg_proc WHERE proname = 'operator_blocks_elsewhere')
     <> 'TABLE(operator_id uuid, node_name text, parent_name text, timerange tstzrange, efficiency numeric)' THEN
    v_ok := false; v_why := v_why || ' the row shape changed'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'operator_blocks_elsewhere') NOT LIKE '%a.org_id = app_current_org()%' THEN
    v_ok := false; v_why := v_why || ' operator_blocks_elsewhere lost its company filter'; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'operator_blocks_elsewhere') THEN
    v_ok := false; v_why := v_why || ' not SECURITY DEFINER'; END IF;
  IF has_function_privilege('anon', 'operator_blocks_elsewhere(timestamptz, timestamptz, ltree)', 'EXECUTE') THEN
    v_ok := false; v_why := v_why || ' anon may execute it'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS BO5'; ELSE RAISE NOTICE 'FAIL BO5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN RESET ROLE; RAISE NOTICE 'FAIL BO5: unexpected % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_BO5;

ROLLBACK;
\echo '99_blocks_elsewhere_off_the_board_test.sql complete (BO1-BO5)'
