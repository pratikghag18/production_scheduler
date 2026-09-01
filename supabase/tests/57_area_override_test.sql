-- ============================================================================
-- 57_area_override_test.sql — migration 0030, D113.
--
-- THE MAINTAINER, 28 August, asked who should hold the key to the area rule:
--   "Anyone who can schedule there. A supervisor with edit rights on the cell
--    may place someone outside their area, recording a reason. The area rule
--    becomes a strong warning rather than a wall, and the audit log carries
--    who waved it through."
--
-- Four claims, separated on purpose:
--
--   D113a  THE DOOR OPENS, AND ONLY WITH A REASON. A2-A5.
--   D113b  ⭐⭐ IT OPENS FROM EVERY WRITER, because it is a COLUMN and not an
--          RPC argument. A7-A11 walk all four doors: the RPC, a raw table
--          INSERT that touches no function at all, `move_run`, and
--          `apply_split_coverage`. **A8 and A11 are the cases that would have
--          been missed** — they use no RPC, and an override plumbed through
--          `create_assignment` alone would leave them refusing.
--   D113c  ⭐⭐ THE PRODUCT HALF IS STILL ABSOLUTE. A6. Migration 0029's proof
--          that `delete_owned_row` needs no escalation depends on a product
--          never sitting outside its owner; if A6 ever goes green in the other
--          direction, that proof is false and the delete is unsound.
--   D113d  RLS IS THE PERMISSION GATE, NOT THE TRIGGER. A12-A14.
--
-- ⚠️ A4 IS THE ONE NOBODY WOULD THINK TO WRITE. The guard NORMALISES the flag
-- off when the row did not need it, so "overridden" cannot come to mean "the
-- client sent a flag". Without it the board badges ordinary assignments as
-- overridden and the audit trail fills with reasons for things nobody
-- overrode — and every other case in this file still passes.
--
-- FIXTURE, and the reasons:
--   * a whole second PLANT, so "outside your area" is unambiguous;
--   * an operator owned by LINE 1, because the interesting move is between two
--     cells the SAME admin can edit — Cell 1 (inside Line 1) to Cell 4 (under
--     Line 2). A fixture where the target is unreachable tests the permission
--     check and never reaches this rule at all ([[verification-standard]] 3c);
--   * a SUPERVISOR, not an admin, as the person who overrides — D113 says
--     "anyone who can schedule there", and an admin would satisfy every
--     predicate in sight and prove nothing about which one is load-bearing;
--   * a VIEWER with no edit rights, for A12.
--
-- People. NONE is an org-wide 'admin', which is the property that matters —
-- `app_is_admin()` short-circuits every predicate under test:
--   f1  org-wide 'viewer'     + admin grant on Plant 1      — builds the fixture
--   f2  org-wide 'supervisor' + supervisor grant on Plant 1 — the person D113 is about
--   f3  org-wide 'viewer'     + viewer grant on Plant 1     — may see, may not schedule
-- ⚠️ f2's ORG-WIDE role has to be 'supervisor' too: `app_can_edit_node` reaches
-- the grant only through `app_can_write()`, which reads the org-wide role. The
-- first run of this file gave f2 an org-wide 'viewer' and every case answered
-- PT403 "no edit rights on node" without ever reaching the rule under test.
--
-- Seed nodes: plant_1 …0001, line_1 …0004, cell_1 …0007, cell_2 …0008,
-- cell_4 `3000000a-…000a` (under Line 2 — NOT under Line 1).
-- ============================================================================

BEGIN;

CREATE TEMP TABLE f_fix (k text primary key, v uuid);

DO $$
DECLARE v_pe uuid; v_dept uuid; v_cell uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pe   := (create_node(NULL, 'Plant E (area tests)', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_pe,   'Fabrication E', 0)->>'id')::uuid;
  v_cell := (create_node(v_dept, 'Weld Cell E',   0)->>'id')::uuid;
  RESET ROLE;
  -- ⚠️ Written AFTER RESET ROLE: `authenticated` cannot write a TEMP table and
  -- the refusal reads exactly like RLS (instrument failure 34).
  INSERT INTO f_fix (k, v) VALUES ('pe', v_pe), ('pe_cell', v_cell);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001'; v_pe uuid;
BEGIN
  SELECT v INTO v_pe FROM f_fix WHERE k = 'pe';

  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-00000000ff01'),
    ('00000000-0000-0000-0000-00000000ff02'),
    ('00000000-0000-0000-0000-00000000ff03');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e3000000-0000-0000-0000-0000000000f1', v_org, '00000000-0000-0000-0000-00000000ff01', 'viewer'),
    -- ⚠️ 'supervisor', NOT 'viewer', and the suite taught me this: `app_can_edit_node`
    -- reaches the grant only through `app_can_write()`, which reads the ORG-WIDE
    -- role. A supervisor GRANT sitting on an org-wide 'viewer' can see the cell
    -- and cannot schedule on it, so every case here answered PT403 "no edit
    -- rights on node" and never reached the rule under test. It is still not
    -- 'admin', which is the property that matters: `app_is_admin()` would
    -- short-circuit every predicate in sight.
    ('e3000000-0000-0000-0000-0000000000f2', v_org, '00000000-0000-0000-0000-00000000ff02', 'supervisor'),
    ('e3000000-0000-0000-0000-0000000000f3', v_org, '00000000-0000-0000-0000-00000000ff03', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e3000000-0000-0000-0000-0000000000f1','30000000-0000-0000-0000-000000000001', v_org, 'admin'),
    ('e3000000-0000-0000-0000-0000000000f2','30000000-0000-0000-0000-000000000001', v_org, 'supervisor'),
    ('e3000000-0000-0000-0000-0000000000f3','30000000-0000-0000-0000-000000000001', v_org, 'viewer');

  -- Three people, three scopes: one in another PLANT, one on LINE 1 only, one
  -- plant-wide. The middle one is what makes a same-admin cross-line move
  -- possible at all.
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('f5000000-0000-0000-0000-0000000000f1', v_org, 'Foreign Fred', 'EMP-F01', v_pe),
    ('f5000000-0000-0000-0000-0000000000f2', v_org, 'Line-1 Lena',  'EMP-F02', '30000000-0000-0000-0000-000000000004'),
    ('f5000000-0000-0000-0000-0000000000f3', v_org, 'Plantwide Pia','EMP-F03', '30000000-0000-0000-0000-000000000001');

  -- A product made only in Plant E, for the half that has no door (A6). D115
  -- (0034): a product's places are product_sites rows, not a column; one place,
  -- Plant E, so the offering guard covers Plant E and nothing under Plant 1.
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('f6000000-0000-0000-0000-0000000000f1', v_org, 'FP1', 'Foreign Part');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'f6000000-0000-0000-0000-0000000000f1', v_pe);

  -- A run on Cell 1 crewed by Lena, so a move to Cell 4 crosses out of her line.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
    ('f8000000-0000-0000-0000-0000000000f1', v_org, '30000000-0000-0000-0000-000000000007',
     '60000000-0000-0000-0000-000000000001', tstzrange('2099-07-01 06:00+00','2099-07-01 14:00+00'), 1);
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('f9000000-0000-0000-0000-0000000000f1', v_org, '30000000-0000-0000-0000-000000000007',
     'f5000000-0000-0000-0000-0000000000f2', 'f8000000-0000-0000-0000-0000000000f1', NULL,
     tstzrange('2099-07-01 06:00+00','2099-07-01 14:00+00'), 1.000);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

-- A fixture that half-builds measures a world missing the thing the cases are about.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM operators WHERE id::text LIKE 'f5000000%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FIXTURE FAILED: % operators, expected 3', v_n; END IF;
  -- The premise of every cross-line case: Lena does NOT cover Cell 4, and she
  -- DOES cover Cell 1. If either stops being true the file measures nothing.
  IF app_owner_covers_in_org('10000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000004', '3000000a-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'FIXTURE FAILED: Line 1 unexpectedly covers Cell 4';
  END IF;
  IF NOT app_owner_covers_in_org('10000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000007') THEN
    RAISE EXCEPTION 'FIXTURE FAILED: Line 1 does not cover Cell 1';
  END IF;
END $$;

-- ===========================================================================
-- THE COLUMNS, AND THE RULE THAT KEEPS THEM HONEST
-- ===========================================================================

\echo 'A1: the flag and the reason are two halves of one fact — neither half alone is admissible'
SAVEPOINT sp_A1;
DO $$
DECLARE v_flag_only text := 'no error'; v_reason_only text := 'no error'; v_both text := 'refused';
BEGIN
  BEGIN
    UPDATE assignments SET area_override = true WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
    EXCEPTION WHEN check_violation THEN v_flag_only := 'refused';
  END;
  BEGIN
    UPDATE assignments SET area_override_reason = 'because' WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
    EXCEPTION WHEN check_violation THEN v_reason_only := 'refused';
  END;
  BEGIN
    UPDATE assignments SET area_override = true, area_override_reason = 'because'
      WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
    v_both := 'allowed';
    EXCEPTION WHEN check_violation THEN v_both := 'refused';
  END;
  IF v_flag_only = 'refused' AND v_reason_only = 'refused' AND v_both = 'allowed' THEN RAISE NOTICE 'PASS A1';
  ELSE RAISE NOTICE 'FAIL A1: flag_only=% reason_only=% both=% (want refused/refused/allowed)',
    v_flag_only, v_reason_only, v_both; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_A1;

-- ===========================================================================
-- THE DOOR
-- ===========================================================================

\echo 'A2: the rule is still a rule — without the override, a person from another plant is refused'
SAVEPOINT sp_A2;
DO $$
DECLARE v_state text := 'none'; v_kind text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000007',
      'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
      tstzrange('2099-07-02 06:00+00','2099-07-02 14:00+00'));
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
  END;
  RESET ROLE;
  IF v_state = 'PT409' AND v_kind = 'operator' THEN RAISE NOTICE 'PASS A2';
  ELSE RAISE NOTICE 'FAIL A2: state=% kind=% (want PT409/operator)', v_state, v_kind; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A2: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A2;

\echo 'A3 ⭐: a SUPERVISOR — not an admin — places them anyway, with a reason, and the row records both'
SAVEPOINT sp_A3;
DO $$
DECLARE v_state text := 'none'; v_res jsonb; v_flag boolean; v_reason text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_res := create_assignment('30000000-0000-0000-0000-000000000007',
      'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
      tstzrange('2099-07-02 06:00+00','2099-07-02 14:00+00'),
      1.000, NULL, NULL, false, NULL,
      true, 'covering for Dana, cleared with the plant manager');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  v_flag   := (v_res->'assignment'->>'area_override')::boolean;
  v_reason := v_res->'assignment'->>'area_override_reason';
  IF v_state = 'allowed' AND v_flag AND v_reason = 'covering for Dana, cleared with the plant manager'
  THEN RAISE NOTICE 'PASS A3';
  ELSE RAISE NOTICE 'FAIL A3: state=% flag=% reason=%', v_state, v_flag, v_reason; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A3: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A3;

\echo 'A4 ⭐⭐: the flag is NORMALISED OFF when the row never needed it — "overridden" must not come to mean "a flag was sent"'
SAVEPOINT sp_A4;
DO $$
DECLARE v_res jsonb; v_flag boolean; v_reason text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  -- Pia belongs to the whole plant, so Cell 1 is squarely inside her area and
  -- nothing is being overridden. A client that sends the flag anyway must not
  -- get a row that claims somebody waved a rule through.
  v_res := create_assignment('30000000-0000-0000-0000-000000000007',
    'f5000000-0000-0000-0000-0000000000f3', NULL, '60000000-0000-0000-0000-000000000001',
    tstzrange('2099-07-03 06:00+00','2099-07-03 14:00+00'),
    1.000, NULL, NULL, false, NULL,
    true, 'sent by a client that always sends it');
  RESET ROLE;
  v_flag   := (v_res->'assignment'->>'area_override')::boolean;
  v_reason := v_res->'assignment'->>'area_override_reason';
  IF v_flag IS FALSE AND v_reason IS NULL THEN RAISE NOTICE 'PASS A4';
  ELSE RAISE NOTICE 'FAIL A4: flag=% reason=% (want false/NULL)', v_flag, v_reason; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A4: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A4;

\echo 'A5: an override with no reason is invalid_argument naming the field, not a bare CHECK violation'
SAVEPOINT sp_A5;
DO $$
DECLARE v_null text := 'none'; v_blank text := 'none'; v_field text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000007',
      'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
      tstzrange('2099-07-04 06:00+00','2099-07-04 14:00+00'),
      1.000, NULL, NULL, false, NULL, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_null := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_field := v_detail::jsonb->>'field';
  END;
  BEGIN
    -- ⚠️ Whitespace is not a reason. A client that sends "   " has collected
    -- nothing, and a CHECK on `is not null` alone would happily store it.
    PERFORM create_assignment('30000000-0000-0000-0000-000000000007',
      'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
      tstzrange('2099-07-04 06:00+00','2099-07-04 14:00+00'),
      1.000, NULL, NULL, false, NULL, true, '   ');
  EXCEPTION WHEN OTHERS THEN v_blank := SQLSTATE; END;
  RESET ROLE;
  IF v_null = 'PT400' AND v_field = 'p_area_override_reason' AND v_blank = 'PT400'
  THEN RAISE NOTICE 'PASS A5';
  ELSE RAISE NOTICE 'FAIL A5: null=% field=% blank=% (want PT400/p_area_override_reason/PT400)', v_null, v_field, v_blank; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A5: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A5;

\echo 'A6 ⭐⭐: the PRODUCT half has no door, and migration 0029s proof depends on that'
SAVEPOINT sp_A6;
DO $$
DECLARE v_state text := 'none'; v_kind text; v_detail text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- Pia belongs here, so the operator half is satisfied and cannot mask the
    -- answer; the PRODUCT belongs to Plant E. The override is set and must not
    -- help. If this ever passes, `delete_owned_row` is unsound — see 0029.
    PERFORM create_assignment('30000000-0000-0000-0000-000000000007',
      'f5000000-0000-0000-0000-0000000000f3', NULL, 'f6000000-0000-0000-0000-0000000000f1',
      tstzrange('2099-07-05 06:00+00','2099-07-05 14:00+00'),
      1.000, NULL, NULL, false, NULL, true, 'trying to use the wrong door');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_kind := v_detail::jsonb->>'kind';
  END;
  RESET ROLE;
  IF v_state = 'PT409' AND v_kind = 'product' THEN RAISE NOTICE 'PASS A6';
  ELSE RAISE NOTICE 'FAIL A6: state=% kind=% (want PT409/product — an overridable product scope breaks 0029)', v_state, v_kind; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A6: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A6;

-- ===========================================================================
-- EVERY DOOR — the point of making it a column
-- ===========================================================================

\echo 'A7 ⭐⭐: a RAW TABLE INSERT, through no function at all, gets the same door'
SAVEPOINT sp_A7;
DO $$
DECLARE v_without text := 'none'; v_with text := 'none'; v_flag boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
              'f5000000-0000-0000-0000-0000000000f1','60000000-0000-0000-0000-000000000001',
              tstzrange('2099-07-06 06:00+00','2099-07-06 14:00+00'), 1.000);
    v_without := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_without := SQLSTATE; END;
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency,
                             area_override, area_override_reason)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
              'f5000000-0000-0000-0000-0000000000f1','60000000-0000-0000-0000-000000000001',
              tstzrange('2099-07-06 06:00+00','2099-07-06 14:00+00'), 1.000,
              true, 'short-handed on nights');
    v_with := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_with := SQLSTATE; END;
  RESET ROLE;
  SELECT area_override INTO v_flag FROM assignments
   WHERE operator_id = 'f5000000-0000-0000-0000-0000000000f1'
     AND timerange = tstzrange('2099-07-06 06:00+00','2099-07-06 14:00+00');
  -- This is the whole argument for a COLUMN over an RPC parameter: this path
  -- passes through no function anybody could have remembered to plumb.
  IF v_without = 'PT409' AND v_with = 'allowed' AND v_flag THEN RAISE NOTICE 'PASS A7';
  ELSE RAISE NOTICE 'FAIL A7: without=% with=% flag=% (want PT409/allowed/true)', v_without, v_with, v_flag; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A7: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A7;

\echo 'A8 ⭐⭐: a plain PATCH of node_id — the door nobody plumbed, and the one an RPC argument could never reach'
SAVEPOINT sp_A8;
DO $$
DECLARE v_without text := 'none'; v_with text := 'none'; v_node uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  -- Lena is a Line 1 person on a Line 1 cell. Cell 4 is under Line 2 — the same
  -- supervisor may schedule at both, so this is the rule talking and not the
  -- permission check.
  BEGIN
    UPDATE assignments SET node_id = '3000000a-0000-0000-0000-00000000000a',
                           run_id = NULL, product_id = '60000000-0000-0000-0000-000000000001'
      WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
    v_without := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_without := SQLSTATE; END;
  BEGIN
    UPDATE assignments SET node_id = '3000000a-0000-0000-0000-00000000000a',
                           run_id = NULL, product_id = '60000000-0000-0000-0000-000000000001',
                           area_override = true, area_override_reason = 'Line 2 is short today'
      WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
    v_with := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_with := SQLSTATE; END;
  RESET ROLE;
  SELECT node_id INTO v_node FROM assignments WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
  -- ⚠️ THE ROW IS READ BACK, AND THAT IS NOT BELT AND BRACES. An UPDATE the
  -- policy refuses removes zero rows and raises nothing at all (§19.63), so
  -- "no exception" and "it worked" are the same observation here. The first
  -- draft of this case asserted only the absence of an error and reported
  -- `without=allowed` for an update that had done precisely nothing.
  IF v_without = 'PT409' AND v_with = 'allowed'
     AND v_node = '3000000a-0000-0000-0000-00000000000a' THEN RAISE NOTICE 'PASS A8';
  ELSE RAISE NOTICE 'FAIL A8: without=% with=% node_after=% (want PT409/allowed/Cell 4)', v_without, v_with, v_node; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A8: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A8;

\echo 'A9 ⭐: move_run refuses NAMING EVERY affected person, not one per attempt'
SAVEPOINT sp_A9;
DO $$
DECLARE v_state text := 'none'; v_detail text; v_ops jsonb; v_name text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_run('f8000000-0000-0000-0000-0000000000f1', '3000000a-0000-0000-0000-00000000000a',
      tstzrange('2099-07-01 06:00+00','2099-07-01 14:00+00'));
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    v_ops := v_detail::jsonb->'operators';
    v_name := v_ops->0->>'name';
  END;
  RESET ROLE;
  -- The NAME is the point: the trigger alone would raise about an id, one row
  -- at a time, and a five-person crew would take five attempts to discover.
  IF v_state = 'PT409' AND jsonb_array_length(v_ops) = 1 AND v_name = 'Line-1 Lena'
  THEN RAISE NOTICE 'PASS A9';
  ELSE RAISE NOTICE 'FAIL A9: state=% operators=% ', v_state, v_ops; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A9: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A9;

\echo 'A10 ⭐: move_run with the override moves the crew, and marks only the rows that needed it'
SAVEPOINT sp_A10;
DO $$
DECLARE v_state text := 'none'; v_flag boolean; v_reason text; v_node uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM move_run('f8000000-0000-0000-0000-0000000000f1', '3000000a-0000-0000-0000-00000000000a',
      tstzrange('2099-07-01 06:00+00','2099-07-01 14:00+00'),
      true, 'Line 2 is short today');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  SELECT node_id, area_override, area_override_reason INTO v_node, v_flag, v_reason
    FROM assignments WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
  IF v_state = 'allowed' AND v_node = '3000000a-0000-0000-0000-00000000000a'
     AND v_flag AND v_reason = 'Line 2 is short today'
  THEN RAISE NOTICE 'PASS A10';
  ELSE RAISE NOTICE 'FAIL A10: state=% node=% flag=% reason=%', v_state, v_node, v_flag, v_reason; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A10: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A10;

\echo 'A11 ⭐: apply_split_coverage threads it — the middle layer a plumbing change forgets'
SAVEPOINT sp_A11;
DO $$
DECLARE v_without text := 'none'; v_with text := 'none'; v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apply_split_coverage('[]'::jsonb, jsonb_build_object(
      'node_id','30000000-0000-0000-0000-000000000007',
      'operator_id','f5000000-0000-0000-0000-0000000000f1',
      'product_id','60000000-0000-0000-0000-000000000001',
      'timerange','[2099-07-08 06:00+00,2099-07-08 14:00+00)',
      'efficiency', 1.000));
    v_without := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_without := SQLSTATE; END;
  BEGIN
    v_res := apply_split_coverage('[]'::jsonb, jsonb_build_object(
      'node_id','30000000-0000-0000-0000-000000000007',
      'operator_id','f5000000-0000-0000-0000-0000000000f1',
      'product_id','60000000-0000-0000-0000-000000000001',
      'timerange','[2099-07-08 06:00+00,2099-07-08 14:00+00)',
      'efficiency', 1.000,
      'area_override', true, 'area_override_reason', 'splitting cover across plants'));
    v_with := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_with := SQLSTATE; END;
  RESET ROLE;
  IF v_without = 'PT409' AND v_with = 'allowed'
     AND (v_res->'assignment'->>'area_override')::boolean
     AND v_res->'assignment'->>'area_override_reason' = 'splitting cover across plants'
  THEN RAISE NOTICE 'PASS A11';
  ELSE RAISE NOTICE 'FAIL A11: without=% with=% row=%', v_without, v_with, v_res->'assignment'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A11: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A11;

-- ===========================================================================
-- WHO HOLDS THE KEY — RLS is the gate, not the trigger
-- ===========================================================================

\echo 'A12 ⭐⭐: a VIEWER cannot buy their way in with the flag — the permission gate is RLS and it still runs'
SAVEPOINT sp_A12;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff03', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- Migration 0030 deliberately puts NO permission check in the trigger, on
    -- the argument that RLS always runs anyway. This is that argument being
    -- measured rather than asserted.
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency,
                             area_override, area_override_reason)
      VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
              'f5000000-0000-0000-0000-0000000000f1','60000000-0000-0000-0000-000000000001',
              tstzrange('2099-07-09 06:00+00','2099-07-09 14:00+00'), 1.000,
              true, 'I would like to schedule this please');
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE; END;
  RESET ROLE;
  IF v_state = '42501' THEN RAISE NOTICE 'PASS A12';
  ELSE RAISE NOTICE 'FAIL A12: state=% (want 42501 — a viewer must not be able to schedule at all)', v_state; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A12: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A12;

\echo 'A13: the two re-created functions kept their grants — DROP FUNCTION takes them, and the regrant is easy to forget'
SAVEPOINT sp_A13;
DO $$
DECLARE v_ca_auth boolean; v_mr_auth boolean; v_ca_pub boolean; v_mr_pub boolean;
BEGIN
  SELECT has_function_privilege('authenticated',
    'create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)','EXECUTE')
    INTO v_ca_auth;
  SELECT has_function_privilege('authenticated','move_run(uuid,uuid,tstzrange,boolean,text)','EXECUTE')
    INTO v_mr_auth;
  -- and PUBLIC must NOT have it: functions grant EXECUTE to PUBLIC by default,
  -- so the REVOKE is the load-bearing half of the pair (gotcha 2).
  SELECT has_function_privilege('anon',
    'create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text)','EXECUTE')
    INTO v_ca_pub;
  SELECT has_function_privilege('anon','move_run(uuid,uuid,tstzrange,boolean,text)','EXECUTE')
    INTO v_mr_pub;
  IF v_ca_auth AND v_mr_auth AND NOT v_ca_pub AND NOT v_mr_pub THEN RAISE NOTICE 'PASS A13';
  ELSE RAISE NOTICE 'FAIL A13: authenticated ca=% mr=% ; anon ca=% mr=% (want true/true/false/false)',
    v_ca_auth, v_mr_auth, v_ca_pub, v_mr_pub; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_A13;

\echo 'A14 ⭐: the OLD signatures are GONE, so nothing can resolve to a version without the door'
SAVEPOINT sp_A14;
DO $$
DECLARE v_ca int; v_mr int;
BEGIN
  SELECT count(*) INTO v_ca FROM pg_proc WHERE proname = 'create_assignment';
  SELECT count(*) INTO v_mr FROM pg_proc WHERE proname = 'move_run';
  -- Two overloads differing only in trailing defaults is one call site away
  -- from silently picking the one with no override in it.
  IF v_ca = 1 AND v_mr = 1 THEN RAISE NOTICE 'PASS A14';
  ELSE RAISE NOTICE 'FAIL A14: create_assignment overloads=% move_run overloads=% (want 1/1)', v_ca, v_mr; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_A14;

\echo 'A15: an area override is NOT a certification override — the two flags stay independent'
SAVEPOINT sp_A15;
DO $$
DECLARE v_res jsonb; v_area boolean; v_elig boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  v_res := create_assignment('30000000-0000-0000-0000-000000000007',
    'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
    tstzrange('2099-07-10 06:00+00','2099-07-10 14:00+00'),
    1.000, NULL, NULL, false, NULL, true, 'covering a gap');
  RESET ROLE;
  v_area := (v_res->'assignment'->>'area_override')::boolean;
  v_elig := (v_res->'assignment'->>'eligibility_override')::boolean;
  -- A supervisor waving through "not from this plant" must not silently also
  -- record "no Welding ticket" — the weaker permission granting the stronger.
  IF v_area AND v_elig IS FALSE THEN RAISE NOTICE 'PASS A15';
  ELSE RAISE NOTICE 'FAIL A15: area=% eligibility=% (want true/false)', v_area, v_elig; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A15: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A15;

\echo 'A16: the override is in the audit log — "the audit log carries who waved it through"'
SAVEPOINT sp_A16;
DO $$
DECLARE v_n int; v_after jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  PERFORM create_assignment('30000000-0000-0000-0000-000000000007',
    'f5000000-0000-0000-0000-0000000000f1', NULL, '60000000-0000-0000-0000-000000000001',
    tstzrange('2099-07-11 06:00+00','2099-07-11 14:00+00'),
    1.000, NULL, NULL, false, NULL, true, 'audited on purpose');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE table_name = 'assignments' AND action = 'insert'
     AND (after->>'area_override')::boolean
     AND after->>'area_override_reason' = 'audited on purpose';
  SELECT after INTO v_after FROM audit_log
   WHERE table_name = 'assignments' AND action = 'insert'
     AND after->>'area_override_reason' = 'audited on purpose' LIMIT 1;
  IF v_n = 1 AND v_after->>'created_by' = '00000000-0000-0000-0000-00000000ff02'
  THEN RAISE NOTICE 'PASS A16';
  ELSE RAISE NOTICE 'FAIL A16: rows=% created_by=%', v_n, v_after->>'created_by'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A16: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A16;

\echo 'A17 ⚠️: a KNOWN LIMITATION, pinned rather than left to be discovered — the flag persists across a later move'
SAVEPOINT sp_A17;
DO $$
DECLARE v_reason text; v_node uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ff02', true);
  SET LOCAL ROLE authenticated;
  -- Override Lena onto Cell 4 with one reason...
  UPDATE assignments SET node_id = '3000000a-0000-0000-0000-00000000000a',
                         run_id = NULL, product_id = '60000000-0000-0000-0000-000000000001',
                         area_override = true, area_override_reason = 'Line 2 is short today'
    WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
  -- ...then move the SAME row on to Cell 5 without saying anything new. The
  -- flag rides along, so the second move carries the first move's reason.
  UPDATE assignments SET node_id = '3000000a-0000-0000-0000-00000000000b'
    WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
  RESET ROLE;
  SELECT node_id, area_override_reason INTO v_node, v_reason
    FROM assignments WHERE id = 'f9000000-0000-0000-0000-0000000000f1';
  -- Accepted, and here is why: every RPC path overwrites the reason from its
  -- own argument, so only a raw PATCH of node_id can carry a stale one, and
  -- requiring a fresh reason per move would mean the client resending it on
  -- every drag. Recorded so the behaviour is a decision rather than a
  -- discovery. If this case ever needs to change, it is a product question.
  IF v_node = '3000000a-0000-0000-0000-00000000000b' AND v_reason = 'Line 2 is short today'
  THEN RAISE NOTICE 'PASS A17';
  ELSE RAISE NOTICE 'FAIL A17: node=% reason=%', v_node, v_reason; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL A17: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_A17;

ROLLBACK;
