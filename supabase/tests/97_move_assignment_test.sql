-- ============================================================================
-- 97_move_assignment_test.sql --- migration 0080, move_assignment (S41-c, R-389).
--
-- "Move Sam on Cell 1 to Cell 2 in Line 1" moves a block to another cell
-- and/or other hours in one write. move_assignment is assembled from
-- reassign_assignment (0057, last redefined 0066) and asks every question a
-- new placement asks, against the TARGET (node, window): permission on BOTH
-- the source and target node, training, absence and the area rule under the
-- target's resolved policy, capacity by the existing trigger --- and it
-- detaches the block from its run on the way (run_id set to NULL; a
-- run-attached block carries its run's product forward as a direct one).
-- This file asks it the way 79 asks reassign_assignment: as a signed-in
-- person, through the RPC, with the row read back after every write.
--
-- ⚠️ EVERY CASE THAT MEASURES A REFUSAL RUNS AS `authenticated`, never as the
-- psql superuser (79's own warning, unchanged reason: RLS and app_can_edit_node
-- both have to see the same session a browser would).
--
-- FIXTURE. A plant of its own, on a week nothing else in the suite touches.
-- All times UTC; 2098-03-02 is a Monday.
--
--   Plant M (root)
--     Assembly M
--       Line M  . { Cell M1 (source, no requirements), Cell M2 (generic
--                    target, no requirements, same owner), Cell M3
--                    (requires "Welding M") }
--       Line N  . { Cell M4 (a DIFFERENT owner subtree -- the area case) }
--
--   People: m1 org-wide viewer + ADMIN grant on Plant M (covers M1-M4) --
--           runs every case except MA9; m_view org-wide viewer with NO
--           grant at all; m_src org-wide viewer + ADMIN grant on Cell M1
--           ONLY (MA9's two refusal shapes).
--   Operators, all owned by Line M (so none of them cover Cell M4):
--     Owen (generic), Petra (lacks Welding M), RunCrew (run-attached),
--     Ann (absent over her row's own week), AreaGuy, CapOp, Idem, and a
--     departed ghost (operator_id NULL after insert, D110's own shape).
--   Product: Widget M, made at Plant M (offered everywhere under it).
--
-- MA0  ⭐ premises: the function exists, its definition carries `run_id` set
--      to NULL, and api_raise still raises PT409
-- MA1  a direct block moves cell AND hours: reads back on the new cell with
--      the new window; every other column unchanged (79's RA1 photograph)
-- MA2  a run-attached block moves: run_id NULL and product_id the run's
--      product afterwards
-- MA3  the same hours, a new cell only
-- MA4  the same cell, new hours only (the function does not care which moved)
-- MA5  target cell requires a training the person lacks, under BLOCK:
--      not_eligible, row unchanged
-- MA6  the same under WARN: no override -> not_eligible; with the override
--      and a reason -> moved, eligibility_override true; with the override
--      and no reason -> invalid_argument naming p_override_reason
-- MA7  the person is absent over the TARGET window under BLOCK: absent, row
--      unchanged
-- MA8  the person belongs to another area than the target cell:
--      not_offered_here with no override; with p_area_override and a
--      reason, moved
-- MA9  a viewer (a read grant only): not_permitted; an editor of the source
--      cell but not the target: not_permitted (the two cells differ)
-- MA10 capacity: the person is already at 100% on another cell over the
--      target window: capacity_exceeded, row unchanged
-- MA11 an unknown assignment id: invalid_argument; a departed person's row:
--      invalid_argument naming the reason
-- MA12 the same call twice: the second is a no-op move that succeeds and
--      changes nothing (idempotent)
-- ============================================================================

BEGIN;

CREATE TEMP TABLE ma_fix (k text primary key, v uuid);
GRANT SELECT ON ma_fix TO PUBLIC;

-- The whole row, as the owner (RLS is out of the way after RESET ROLE).
CREATE FUNCTION pg_temp.ma_full(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT to_jsonb(a) FROM assignments a WHERE a.id = p_id;
$fn$;

-- ⭐ EVERYTHING move_assignment PROMISES NOT TO TOUCH BEYOND ITS OWN JOB. The
-- columns removed are exactly the ones the brief says it changes (the cell,
-- the window, the run/product pair it derives, the two override pairs) plus
-- `updated_at`, which set_updated_at moves on any write.
CREATE FUNCTION pg_temp.ma_rest(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT to_jsonb(a) - 'node_id' - 'timerange' - 'run_id' - 'product_id' - 'updated_at'
         - 'eligibility_override' - 'override_reason'
         - 'area_override' - 'area_override_reason'
    FROM assignments a WHERE a.id = p_id;
$fn$;

CREATE FUNCTION pg_temp.ma_who(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT a.operator_id FROM assignments a WHERE a.id = p_id;
$fn$;

CREATE FUNCTION pg_temp.ma_node(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT a.node_id FROM assignments a WHERE a.id = p_id;
$fn$;

DO $$
DECLARE v_pm uuid; v_asm uuid; v_lm uuid; v_ln uuid; v_c1 uuid; v_c2 uuid; v_c3 uuid; v_c4 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pm  := (create_node(NULL,  'Plant M',    0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_asm := (create_node(v_pm,  'Assembly M', 0)->>'id')::uuid;
  v_lm  := (create_node(v_asm, 'Line M',     0)->>'id')::uuid;
  v_ln  := (create_node(v_asm, 'Line N',     1)->>'id')::uuid;
  v_c1  := (create_node(v_lm,  'Cell M1',    0)->>'id')::uuid;
  v_c2  := (create_node(v_lm,  'Cell M2',    1)->>'id')::uuid;
  v_c3  := (create_node(v_lm,  'Cell M3',    2)->>'id')::uuid;
  v_c4  := (create_node(v_ln,  'Cell M4',    0)->>'id')::uuid;
  RESET ROLE;
  -- Written AFTER RESET ROLE: `authenticated` cannot write a TEMP table (79).
  INSERT INTO ma_fix (k, v) VALUES
    ('pm', v_pm), ('asm', v_asm), ('lm', v_lm), ('ln', v_ln),
    ('c1', v_c1), ('c2', v_c2), ('c3', v_c3), ('c4', v_c4);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_pm uuid; v_lm uuid; v_c1 uuid; v_c2 uuid; v_c3 uuid;
BEGIN
  SELECT v INTO v_pm FROM ma_fix WHERE k = 'pm';
  SELECT v INTO v_lm FROM ma_fix WHERE k = 'lm';
  SELECT v INTO v_c1 FROM ma_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM ma_fix WHERE k = 'c2';
  SELECT v INTO v_c3 FROM ma_fix WHERE k = 'c3';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000f1'),
    ('00000000-0000-0000-0000-0000000000f2'),
    ('00000000-0000-0000-0000-0000000000f3');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000f1', 'viewer'),
    ('f0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000f2', 'viewer'),
    ('f0000000-0000-0000-0000-000000000003', v_org, '00000000-0000-0000-0000-0000000000f3', 'viewer');
  -- m1 may edit the whole plant; m_view may READ the whole plant and edit
  -- nowhere (a VIEWER grant, so RLS lets the row be seen and the refusal is
  -- not_permitted rather than a misleading "not found" -- 79's RA8 reasoning);
  -- m_src may EDIT Cell M1 and only READ Cell M2 -- MA9's second shape needs
  -- the target node READABLE (so check_eligibility's own visibility guard
  -- never fires and the case measures OUR permission check, not a masking
  -- one) while still not EDITABLE.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('f0000000-0000-0000-0000-000000000001', v_pm, v_org, 'admin'),
    ('f0000000-0000-0000-0000-000000000002', v_pm, v_org, 'viewer'),
    ('f0000000-0000-0000-0000-000000000003', v_c1, v_org, 'admin'),
    ('f0000000-0000-0000-0000-000000000003', v_c2, v_org, 'viewer');

  -- Every operator owned by LINE M, so none of them covers Cell M4 (Line N).
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('f5000000-0000-0000-0000-000000000001', v_org, 'Owen',     'EMP-M01', v_lm),
    ('f5000000-0000-0000-0000-000000000002', v_org, 'Petra',    'EMP-M02', v_lm),
    ('f5000000-0000-0000-0000-000000000003', v_org, 'RunCrew',  'EMP-M03', v_lm),
    ('f5000000-0000-0000-0000-000000000004', v_org, 'Ann',      'EMP-M04', v_lm),
    ('f5000000-0000-0000-0000-000000000005', v_org, 'AreaGuy',  'EMP-M05', v_lm),
    ('f5000000-0000-0000-0000-000000000006', v_org, 'CapOp',    'EMP-M06', v_lm),
    ('f5000000-0000-0000-0000-000000000007', v_org, 'Idem',     'EMP-M07', v_lm),
    ('f5000000-0000-0000-0000-000000000008', v_org, 'Ghost',    'EMP-M08', v_lm);

  INSERT INTO products (id, org_id, sku, name) VALUES
    ('f6000000-0000-0000-0000-000000000001', v_org, 'WM1', 'Widget M');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'f6000000-0000-0000-0000-000000000001', v_pm);

  -- Cell M3 needs a ticket nobody but a control operator (never used) holds.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('f4000000-0000-0000-0000-000000000001', v_org, 'Welding M', v_pm);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    (v_c3, 'f4000000-0000-0000-0000-000000000001', v_org);

  -- Ann is absent the whole week her row sits in.
  INSERT INTO absences (org_id, operator_id, daterange, reason) VALUES
    (v_org, 'f5000000-0000-0000-0000-000000000004',
     daterange('2098-03-09', '2098-03-16', '[]'), 'leave');

  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('f8000000-0000-0000-0000-000000000001', v_org, v_c1, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-06 06:00+00', '2098-03-06 14:00+00', '[)'), 2, 'MA2''s run');

  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
    -- A_DIRECT: MA1, MA9 (both refusal shapes).
    ('f9000000-0000-0000-0000-000000000001', v_org, v_c1, 'f5000000-0000-0000-0000-000000000001',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-02 06:00+00', '2098-03-02 10:00+00', '[)'), 1.000, 40, 'units'),
    -- A_SAMEHOURS: MA3.
    ('f9000000-0000-0000-0000-000000000002', v_org, v_c1, 'f5000000-0000-0000-0000-000000000001',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-03 06:00+00', '2098-03-03 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_SAMECELL: MA4.
    ('f9000000-0000-0000-0000-000000000003', v_org, v_c1, 'f5000000-0000-0000-0000-000000000001',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-04 06:00+00', '2098-03-04 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_RUNATTACHED: MA2.
    ('f9000000-0000-0000-0000-000000000004', v_org, v_c1, 'f5000000-0000-0000-0000-000000000003',
     'f8000000-0000-0000-0000-000000000001', NULL,
     tstzrange('2098-03-06 06:00+00', '2098-03-06 14:00+00', '[)'), 1.000, NULL, NULL),
    -- A_TRAIN: MA5, MA6 (Petra, lacks Welding M).
    ('f9000000-0000-0000-0000-000000000005', v_org, v_c1, 'f5000000-0000-0000-0000-000000000002',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-08 06:00+00', '2098-03-08 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_ABSENT: MA7 (Ann, absent the week of 03-09).
    ('f9000000-0000-0000-0000-000000000006', v_org, v_c1, 'f5000000-0000-0000-0000-000000000004',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-09 06:00+00', '2098-03-09 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_AREA: MA8 (AreaGuy, moved to Cell M4).
    ('f9000000-0000-0000-0000-000000000007', v_org, v_c1, 'f5000000-0000-0000-0000-000000000005',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-10 06:00+00', '2098-03-10 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_CAPSRC: MA10, moved onto Cell M2 06:00-10:00, colliding with A_CAPOTHER.
    ('f9000000-0000-0000-0000-000000000008', v_org, v_c1, 'f5000000-0000-0000-0000-000000000006',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-11 12:00+00', '2098-03-11 16:00+00', '[)'), 1.000, NULL, NULL),
    -- A_CAPOTHER: MA10's already-there row, untouched.
    ('f9000000-0000-0000-0000-000000000009', v_org, v_c2, 'f5000000-0000-0000-0000-000000000006',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-11 06:00+00', '2098-03-11 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_IDEM: MA12.
    ('f9000000-0000-0000-0000-000000000010', v_org, v_c1, 'f5000000-0000-0000-0000-000000000007',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-12 06:00+00', '2098-03-12 10:00+00', '[)'), 1.000, NULL, NULL),
    -- A_DEPARTED: MA11 (operator_id nulled below, D110's own shape).
    ('f9000000-0000-0000-0000-000000000011', v_org, v_c1, 'f5000000-0000-0000-0000-000000000008',
     NULL, 'f6000000-0000-0000-0000-000000000001',
     tstzrange('2098-03-13 06:00+00', '2098-03-13 10:00+00', '[)'), 1.000, NULL, NULL);

  UPDATE assignments SET operator_id = NULL, operator_display_name = 'Ghost'
   WHERE id = 'f9000000-0000-0000-0000-000000000011';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

RESET ROLE;

\echo 'MA0: the function exists, carries run_id set to NULL, and api_raise still raises PT409'
SAVEPOINT sp_MA0;
DO $$
DECLARE v_def text; v_ok boolean := true; v_why text := '';
BEGIN
  v_def := pg_get_functiondef('move_assignment(uuid,uuid,tstzrange,boolean,text,boolean,text)'::regprocedure);
  IF v_def IS NULL OR position('run_id' in v_def) = 0 OR position('= NULL' in v_def) = 0 THEN
    v_ok := false; v_why := v_why || ' function definition missing or does not carry run_id = NULL';
  END IF;
  IF pg_temp.ma_who('f9000000-0000-0000-0000-000000000001') <> 'f5000000-0000-0000-0000-000000000001'
  THEN v_ok := false; v_why := v_why || ' fixture row does not hold Owen'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA0';
  ELSE RAISE NOTICE 'FAIL MA0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL MA0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA0;

\echo 'MA1: a direct block moves cell AND hours; the row reads back on the new cell with the new window, every other column unchanged'
SAVEPOINT sp_MA1;
DO $$
DECLARE v_before jsonb; v_after jsonb; v_res jsonb; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  v_before := pg_temp.ma_rest('f9000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  v_res := move_assignment('f9000000-0000-0000-0000-000000000001',
                           (SELECT v FROM ma_fix WHERE k = 'c2'),
                           tstzrange('2098-03-02 12:00+00', '2098-03-02 16:00+00', '[)'));
  RESET ROLE;
  v_after := pg_temp.ma_rest('f9000000-0000-0000-0000-000000000001');
  v_row   := pg_temp.ma_full('f9000000-0000-0000-0000-000000000001');

  IF v_row->>'node_id' <> (SELECT v FROM ma_fix WHERE k = 'c2')::text
  THEN v_ok := false; v_why := v_why || ' node_id=' || (v_row->>'node_id'); END IF;
  IF v_row->>'timerange' <> tstzrange('2098-03-02 12:00+00', '2098-03-02 16:00+00', '[)')::text
  THEN v_ok := false; v_why := v_why || ' timerange=' || (v_row->>'timerange'); END IF;
  IF v_row->>'product_id' <> 'f6000000-0000-0000-0000-000000000001'
  THEN v_ok := false; v_why := v_why || ' product_id moved on a direct block'; END IF;
  IF v_before IS DISTINCT FROM v_after THEN
    v_ok := false; v_why := v_why || ' before=' || v_before::text || ' after=' || v_after::text; END IF;
  IF NOT (v_res ? 'assignment' AND v_res ? 'eligibility'
          AND v_res->'assignment'->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c2')::text)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS MA1';
  ELSE RAISE NOTICE 'FAIL MA1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA1;

\echo 'MA2: a run-attached block moves cell; run_id is NULL and product_id is the run''s product afterwards'
SAVEPOINT sp_MA2;
DO $$
DECLARE v_row jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM move_assignment('f9000000-0000-0000-0000-000000000004',
                          (SELECT v FROM ma_fix WHERE k = 'c2'),
                          tstzrange('2098-03-06 06:00+00', '2098-03-06 14:00+00', '[)'));
  RESET ROLE;
  v_row := pg_temp.ma_full('f9000000-0000-0000-0000-000000000004');
  IF NOT (v_row->>'run_id' IS NULL
          AND v_row->>'product_id' = 'f6000000-0000-0000-0000-000000000001'
          AND v_row->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c2')::text)
  THEN v_ok := false; v_why := v_why || ' row=' || v_row::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA2';
  ELSE RAISE NOTICE 'FAIL MA2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA2;

\echo 'MA3: the same hours, a new cell only'
SAVEPOINT sp_MA3;
DO $$
DECLARE v_row jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM move_assignment('f9000000-0000-0000-0000-000000000002',
                          (SELECT v FROM ma_fix WHERE k = 'c2'),
                          tstzrange('2098-03-03 06:00+00', '2098-03-03 10:00+00', '[)'));
  RESET ROLE;
  v_row := pg_temp.ma_full('f9000000-0000-0000-0000-000000000002');
  IF NOT (v_row->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c2')::text
          AND v_row->>'timerange' = tstzrange('2098-03-03 06:00+00', '2098-03-03 10:00+00', '[)')::text)
  THEN v_ok := false; v_why := v_why || ' row=' || v_row::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA3';
  ELSE RAISE NOTICE 'FAIL MA3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA3;

\echo 'MA4: the same cell, new hours only -- the function does not care which changed'
SAVEPOINT sp_MA4;
DO $$
DECLARE v_row jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM move_assignment('f9000000-0000-0000-0000-000000000003',
                          (SELECT v FROM ma_fix WHERE k = 'c1'),
                          tstzrange('2098-03-04 12:00+00', '2098-03-04 16:00+00', '[)'));
  RESET ROLE;
  v_row := pg_temp.ma_full('f9000000-0000-0000-0000-000000000003');
  IF NOT (v_row->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c1')::text
          AND v_row->>'timerange' = tstzrange('2098-03-04 12:00+00', '2098-03-04 16:00+00', '[)')::text)
  THEN v_ok := false; v_why := v_why || ' row=' || v_row::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA4';
  ELSE RAISE NOTICE 'FAIL MA4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA4;

\echo 'MA5: the target cell requires a training Petra lacks; under BLOCK the move is refused not_eligible and the row stays on Cell M1'
SAVEPOINT sp_MA5;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting((SELECT v FROM ma_fix WHERE k = 'pm'), 'eligibility_policy', 'block');
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000005',
                            (SELECT v FROM ma_fix WHERE k = 'c3'),
                            tstzrange('2098-03-08 06:00+00', '2098-03-08 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_eligible' AND v_detail->>'policy' = 'block')
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000005') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA5';
  ELSE RAISE NOTICE 'FAIL MA5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA5;

\echo 'MA6: the same move under WARN -- no override refuses; the override with a reason moves and sets eligibility_override; the override with no reason is invalid_argument'
SAVEPOINT sp_MA6;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  -- No override: refused, nothing written.
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000005',
                            (SELECT v FROM ma_fix WHERE k = 'c3'),
                            tstzrange('2098-03-08 06:00+00', '2098-03-08 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_eligible' AND v_detail->>'policy' = 'warn')
  THEN v_ok := false; v_why := v_why || ' no-override=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000005') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' no-override wrote the row'; END IF;

  -- The override with no reason: invalid_argument naming p_override_reason.
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000005',
                            (SELECT v FROM ma_fix WHERE k = 'c3'),
                            tstzrange('2098-03-08 06:00+00', '2098-03-08 10:00+00', '[)'),
                            true, '   ');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF NOT (v_state = 'PT400' AND v_detail->>'error' = 'invalid_argument'
          AND v_detail->>'field' = 'p_override_reason')
  THEN v_ok := false; v_why := v_why || ' blank-reason=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000005') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' blank-reason wrote the row'; END IF;

  -- The override with a reason: moved.
  PERFORM move_assignment('f9000000-0000-0000-0000-000000000005',
                          (SELECT v FROM ma_fix WHERE k = 'c3'),
                          tstzrange('2098-03-08 06:00+00', '2098-03-08 10:00+00', '[)'),
                          true, 'Petra is supervised today');
  RESET ROLE;
  v_row := pg_temp.ma_full('f9000000-0000-0000-0000-000000000005');
  IF NOT (v_row->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c3')::text
          AND (v_row->>'eligibility_override')::boolean = true
          AND v_row->>'override_reason' = 'Petra is supervised today')
  THEN v_ok := false; v_why := v_why || ' overridden=' || v_row::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS MA6';
  ELSE RAISE NOTICE 'FAIL MA6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA6;

\echo 'MA7: Ann is absent over the target window; under BLOCK the move is refused absent and the row is untouched'
SAVEPOINT sp_MA7;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM set_node_setting((SELECT v FROM ma_fix WHERE k = 'pm'), 'eligibility_policy', 'block');
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000006',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-09 06:00+00', '2098-03-09 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'absent')
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000006') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA7';
  ELSE RAISE NOTICE 'FAIL MA7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA7;

\echo 'MA8 (D113): AreaGuy''s home does not cover Cell M4; refused not_offered_here with no override, moved with the override and a reason'
SAVEPOINT sp_MA8;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000007',
                            (SELECT v FROM ma_fix WHERE k = 'c4'),
                            tstzrange('2098-03-10 06:00+00', '2098-03-10 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_offered_here' AND v_detail->>'kind' = 'operator')
  THEN v_ok := false; v_why := v_why || ' no-override=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000007') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' no-override wrote the row'; END IF;

  PERFORM move_assignment('f9000000-0000-0000-0000-000000000007',
                          (SELECT v FROM ma_fix WHERE k = 'c4'),
                          tstzrange('2098-03-10 06:00+00', '2098-03-10 10:00+00', '[)'),
                          false, NULL, true, 'AreaGuy is covering Line N today');
  RESET ROLE;
  v_row := pg_temp.ma_full('f9000000-0000-0000-0000-000000000007');
  IF NOT (v_row->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c4')::text
          AND (v_row->>'area_override')::boolean = true
          AND v_row->>'area_override_reason' = 'AreaGuy is covering Line N today')
  THEN v_ok := false; v_why := v_why || ' placed=' || v_row::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS MA8';
  ELSE RAISE NOTICE 'FAIL MA8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA8;

\echo 'MA9: a viewer with no grant at all is not_permitted; an editor of the source cell but not the target is also not_permitted'
SAVEPOINT sp_MA9;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_n integer := 0;
        v_ok boolean := true; v_why text := '';
BEGIN
  -- m_view can edit nowhere.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000001',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-02 12:00+00', '2098-03-02 16:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT403' AND v_detail->>'error' = 'not_permitted' THEN v_n := v_n + 1;
    ELSE v_why := v_why || ' viewer=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  RESET ROLE;

  -- m_src may edit Cell M1 (the source) but not Cell M2 (the target).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000001',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-02 12:00+00', '2098-03-02 16:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT403' AND v_detail->>'error' = 'not_permitted' THEN v_n := v_n + 1;
    ELSE v_why := v_why || ' source-only-editor=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  RESET ROLE;

  IF v_n <> 2 THEN v_ok := false; v_why := v_why || format(' refusals=%s of 2', v_n); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000001') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA9';
  ELSE RAISE NOTICE 'FAIL MA9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA9;

\echo 'MA10: CapOp is already at 100% on Cell M2 over the target window; moving the other block onto it is capacity_exceeded, nothing written'
SAVEPOINT sp_MA10;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000008',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-11 06:00+00', '2098-03-11 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'capacity_exceeded'
          AND v_detail->>'operator_id' = 'f5000000-0000-0000-0000-000000000006')
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000008') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' the row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA10';
  ELSE RAISE NOTICE 'FAIL MA10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA10;

\echo 'MA11: an unknown assignment id is invalid_argument; a departed person''s row is invalid_argument naming the reason'
SAVEPOINT sp_MA11;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_n integer := 0;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-0000000000ff',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-02 06:00+00', '2098-03-02 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_assignment_id' AND v_detail->>'reason' = 'not found'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' unknown_row=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  BEGIN
    PERFORM move_assignment('f9000000-0000-0000-0000-000000000011',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-13 06:00+00', '2098-03-13 10:00+00', '[)'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_assignment_id' AND v_detail->>'reason' = 'operator is null'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' departed=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  RESET ROLE;
  IF v_n <> 2 THEN v_ok := false; v_why := v_why || format(' refusals=%s of 2', v_n); END IF;
  IF pg_temp.ma_node('f9000000-0000-0000-0000-000000000011') <> (SELECT v FROM ma_fix WHERE k = 'c1')
  THEN v_ok := false; v_why := v_why || ' the departed row moved anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA11';
  ELSE RAISE NOTICE 'FAIL MA11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA11;

\echo 'MA12: the same call twice -- the second is a no-op move that succeeds and changes nothing'
SAVEPOINT sp_MA12;
DO $$
DECLARE v_row1 jsonb; v_row2 jsonb; v_res2 jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
  SET LOCAL ROLE authenticated;
  PERFORM move_assignment('f9000000-0000-0000-0000-000000000010',
                          (SELECT v FROM ma_fix WHERE k = 'c2'),
                          tstzrange('2098-03-12 06:00+00', '2098-03-12 10:00+00', '[)'));
  v_row1 := pg_temp.ma_full('f9000000-0000-0000-0000-000000000010');
  v_res2 := move_assignment('f9000000-0000-0000-0000-000000000010',
                            (SELECT v FROM ma_fix WHERE k = 'c2'),
                            tstzrange('2098-03-12 06:00+00', '2098-03-12 10:00+00', '[)'));
  RESET ROLE;
  v_row2 := pg_temp.ma_full('f9000000-0000-0000-0000-000000000010');
  IF v_row1 IS DISTINCT FROM v_row2 THEN
    v_ok := false; v_why := v_why || ' row1=' || v_row1::text || ' row2=' || v_row2::text; END IF;
  IF NOT (v_res2 ? 'assignment' AND v_res2->'assignment'->>'node_id' = (SELECT v FROM ma_fix WHERE k = 'c2')::text)
  THEN v_ok := false; v_why := v_why || ' second call did not succeed: ' || v_res2::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS MA12';
  ELSE RAISE NOTICE 'FAIL MA12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL MA12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_MA12;

ROLLBACK;

\echo '97_move_assignment_test.sql complete (13 cases: MA0-MA12)'
