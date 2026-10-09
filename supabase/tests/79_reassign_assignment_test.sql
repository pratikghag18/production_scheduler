-- ============================================================================
-- 79_reassign_assignment_test.sql --- migration 0057, reassignment (R-343, S37).
--
-- The maintainer, session 76: "once you assign someone say Operator 1, there is
-- no way to modify that assignment to operator 2 unless you delete existing
-- assignment, this is not practical." One writer, `reassign_assignment`, takes
-- the row and the new person and asks every question `create_assignment` asks.
-- This file asks it the way 57, 73 and 78 ask the writers: as a signed-in
-- person, through the RPC, with the row read back after every write.
--
-- ⭐ THE CASE THIS FILE EXISTS FOR IS RA1, AND IT IS THE BORING ONE. A writer
-- that changes the person is easy to get green while it also quietly moves the
-- window, drops the run, or clears the target --- so RA1 photographs EVERY
-- OTHER COLUMN before the write and compares the photograph afterwards, and
-- RA10 does it again for the two shapes a row can have (attached to a run,
-- carrying a product directly). Every refusal case reads the row back too: a
-- refusal that has already written half of itself is the failure worth
-- catching, not the refusal.
--
-- ⚠️ EVERY CASE THAT MEASURES A REFUSAL RUNS AS `authenticated`. The RPC is
-- SECURITY INVOKER; psql connects as the superuser, who bypasses RLS and whose
-- `app_current_org()` is NULL. The person reassigning is r1, a SITE admin of
-- Plant R whose org-wide role is 'viewer' --- so `app_is_admin()` cannot
-- short-circuit any predicate under test (46's, 47's, 57's and 78's lesson).
--
-- FIXTURE. A plant of its own, on a week nothing else in the suite touches, so
-- no operator here is booked anywhere else. All times UTC; 2099-07-06 is a
-- Monday.
--
--   Plant R (root) . Assembly R . { Line R . { Cell R1, Cell R2 }, Line S }
--   Cell R2 requires the training "Welding R" (owned by Plant R).
--
--   People:  r1  org-wide VIEWER + ADMIN grant on Plant R    -- reassigns
--            r2  org-wide VIEWER + VIEWER grant on Plant R   -- may READ the
--                rows and may not edit them (RA8: not_permitted, not "not
--                found" --- the two refusals are different sentences and a
--                case that cannot tell them apart proves nothing)
--   Operators: Rita, Ray, Rex, Rosa, Ruby owned by PLANT R (so they cover
--            every cell under it); Sam owned by LINE S, which covers neither
--            Cell R1 nor Cell R2 --- he is the person "from another area".
--            Rex alone holds Welding R.
--   Product: Widget R, made at Plant R.
--
--   Rows:
--     RR1  run, Cell R1, Widget R, Tue 2099-07-07 06:00-14:00, headcount 2
--       AR1  Rita, ATTACHED to RR1, same window, 1.000, target 120 units
--     AD1  Ray,  DIRECT on Cell R1, Widget R, Wed 2099-07-08 06:00-10:00,
--          0.750, target 50 kg
--     AR2  Rex,  DIRECT on Cell R2, Widget R, Thu 2099-07-09 06:00-14:00,
--          1.000                       -- the only person certified for R2
--     ABUSY Rosa, DIRECT on Cell R1, Tue 2099-07-07 06:00-14:00, 1.000
--          -- full at exactly AR1's window, so AR1 -> Rosa is over cap
--
-- RA0   the premises every case rests on
-- RA1 ⭐ a plain reassign changes operator_id AND NOTHING ELSE
-- RA2   not certified under warn, no override: not_eligible, nothing written
-- RA3   with the override and a reason: taken, and the columns say so; a blank
--       reason is refused; reassigning back to a certified person clears it
-- RA4   under block the same call is refused EVEN WITH the override
-- RA5   a person already booked at that time: capacity_exceeded (the trigger
--       fires on UPDATE OF operator_id --- if it ever stops, this case goes red)
-- RA6   a person from another area: not_offered_here, nothing written
-- RA7   with the area override and a reason: taken, and the reason is stored;
--       a blank reason is refused
-- RA8   a person with no edit rights on the cell: not_permitted
-- RA9   an unknown assignment id, a null id, a null person, an unknown person
-- RA10  a run-attached row keeps run_id; a direct row keeps product_id
-- RA11  grants: authenticated yes, anon and public no
-- RA12  D110: a row whose person was deleted (operator_id null, the name
--       remembered) can be re-staffed, and the memory is cleared
-- RA13  an area override sent for a person who does not need one is
--       normalised off by the scope guard (0030), so the flag always means
--       "this really did override something"
-- ============================================================================

BEGIN;

CREATE TEMP TABLE ra_fix (k text primary key, v uuid);
GRANT SELECT ON ra_fix TO PUBLIC;

-- The whole row, as the owner (called after RESET ROLE, so RLS is out of the
-- way and a refusal cannot hide behind an unreadable row).
CREATE FUNCTION pg_temp.ra_full(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT to_jsonb(a) FROM assignments a WHERE a.id = p_id;
$fn$;

-- ⭐ EVERYTHING THE WRITER PROMISES NOT TO TOUCH. The columns removed are
-- exactly the ones it is allowed to change (the person, D110's remembered name
-- that goes when a person is identified by id again, and the two override
-- pairs) plus `updated_at`, which the set_updated_at trigger moves on any
-- write. What is left is the photograph RA1 and RA10 compare.
CREATE FUNCTION pg_temp.ra_rest(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT to_jsonb(a) - 'operator_id' - 'operator_display_name' - 'updated_at'
         - 'eligibility_override' - 'override_reason'
         - 'area_override' - 'area_override_reason'
    FROM assignments a WHERE a.id = p_id;
$fn$;

-- Who is on a row, as the owner.
CREATE FUNCTION pg_temp.ra_who(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT a.operator_id FROM assignments a WHERE a.id = p_id;
$fn$;

DO $$
DECLARE v_pr uuid; v_dept uuid; v_line uuid; v_lines uuid; v_c1 uuid; v_c2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pr    := (create_node(NULL,   'Plant R',    0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept  := (create_node(v_pr,   'Assembly R', 0)->>'id')::uuid;
  v_line  := (create_node(v_dept, 'Line R',     0)->>'id')::uuid;
  v_lines := (create_node(v_dept, 'Line S',     1)->>'id')::uuid;
  v_c1    := (create_node(v_line, 'Cell R1',    0)->>'id')::uuid;
  v_c2    := (create_node(v_line, 'Cell R2',    1)->>'id')::uuid;
  RESET ROLE;
  -- Written AFTER RESET ROLE: `authenticated` cannot write a TEMP table (57).
  INSERT INTO ra_fix (k, v) VALUES
    ('pr', v_pr), ('dept', v_dept), ('line', v_line), ('lines', v_lines),
    ('c1', v_c1), ('c2', v_c2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_pr uuid; v_lines uuid; v_c1 uuid; v_c2 uuid;
BEGIN
  SELECT v INTO v_pr    FROM ra_fix WHERE k = 'pr';
  SELECT v INTO v_lines FROM ra_fix WHERE k = 'lines';
  SELECT v INTO v_c1    FROM ra_fix WHERE k = 'c1';
  SELECT v INTO v_c2    FROM ra_fix WHERE k = 'c2';

  -- r1 runs the plant and is not a company admin; r2 can look and not touch.
  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000e1'),
    ('00000000-0000-0000-0000-0000000000e2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000e1', 'viewer'),
    ('e0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000e2', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', v_pr, v_org, 'admin'),
    ('e0000000-0000-0000-0000-000000000002', v_pr, v_org, 'viewer');

  -- Five people owned by the ROOT, so the area rule never speaks about them,
  -- and one owned by Line S, so it speaks about him at every cell under Line R.
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('e5000000-0000-0000-0000-000000000001', v_org, 'Rita', 'EMP-R01', v_pr),
    ('e5000000-0000-0000-0000-000000000002', v_org, 'Ray',  'EMP-R02', v_pr),
    ('e5000000-0000-0000-0000-000000000003', v_org, 'Rex',  'EMP-R03', v_pr),
    ('e5000000-0000-0000-0000-000000000004', v_org, 'Rosa', 'EMP-R04', v_pr),
    ('e5000000-0000-0000-0000-000000000005', v_org, 'Ruby', 'EMP-R05', v_pr),
    ('e5000000-0000-0000-0000-000000000006', v_org, 'Sam',  'EMP-R06', v_lines);

  INSERT INTO products (id, org_id, sku, name) VALUES
    ('e6000000-0000-0000-0000-000000000001', v_org, 'WR1', 'Widget R');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'e6000000-0000-0000-0000-000000000001', v_pr);

  -- The training Cell R2 needs. Rex holds it and nobody else does; no expiry,
  -- so the answer does not drift with the window (78 covers the expiry shape).
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('e4000000-0000-0000-0000-000000000001', v_org, 'Welding R', v_pr);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    (v_c2, 'e4000000-0000-0000-0000-000000000001', v_org);
  INSERT INTO operator_skills (operator_id, skill_id, org_id) VALUES
    ('e5000000-0000-0000-0000-000000000003', 'e4000000-0000-0000-0000-000000000001', v_org);

  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('e8000000-0000-0000-0000-000000000001', v_org, v_c1, 'e6000000-0000-0000-0000-000000000001',
     tstzrange('2099-07-07 06:00+00', '2099-07-07 14:00+00', '[)'), 2, 'first shift');

  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
    -- AR1: attached to the run.
    ('e9000000-0000-0000-0000-000000000001', v_org, v_c1, 'e5000000-0000-0000-0000-000000000001',
     'e8000000-0000-0000-0000-000000000001', NULL,
     tstzrange('2099-07-07 06:00+00', '2099-07-07 14:00+00', '[)'), 1.000, 120, 'units'),
    -- AD1: direct, carries its own product.
    ('e9000000-0000-0000-0000-000000000002', v_org, v_c1, 'e5000000-0000-0000-0000-000000000002',
     NULL, 'e6000000-0000-0000-0000-000000000001',
     tstzrange('2099-07-08 06:00+00', '2099-07-08 10:00+00', '[)'), 0.750, 50, 'kg'),
    -- AR2: on the cell that needs the ticket.
    ('e9000000-0000-0000-0000-000000000003', v_org, v_c2, 'e5000000-0000-0000-0000-000000000003',
     NULL, 'e6000000-0000-0000-0000-000000000001',
     tstzrange('2099-07-09 06:00+00', '2099-07-09 14:00+00', '[)'), 1.000, NULL, NULL),
    -- ABUSY: Rosa, full at exactly AR1's window.
    ('e9000000-0000-0000-0000-000000000004', v_org, v_c1, 'e5000000-0000-0000-0000-000000000004',
     NULL, 'e6000000-0000-0000-0000-000000000001',
     tstzrange('2099-07-07 06:00+00', '2099-07-07 14:00+00', '[)'), 1.000, NULL, NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

RESET ROLE;

\echo 'RA0: the premises every case rests on (a root of its own, a site admin who is not a company admin, Rex certified for Cell R2 and Rita not, Sam owned outside Line R)'
SAVEPOINT sp_RA0;
DO $$
DECLARE v_root boolean; v_r1 text; v_r2 text; v_rex jsonb; v_rita jsonb;
        v_sam_out boolean; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT parent_id IS NULL INTO v_root FROM nodes WHERE id = (SELECT v FROM ra_fix WHERE k = 'pr');
  SELECT role INTO v_r1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000e1';
  SELECT role INTO v_r2 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000e2';
  -- Sam's owner does not cover Cell R1: the premise RA6/RA7 rest on, asked of
  -- the SAME function the trigger asks (0028/0030), never re-implemented here.
  SELECT NOT app_owner_covers_in_org('10000000-0000-0000-0000-000000000001',
                                     (SELECT v FROM ra_fix WHERE k = 'lines'),
                                     (SELECT v FROM ra_fix WHERE k = 'c1'))
    INTO v_sam_out;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_rex  := check_eligibility((SELECT v FROM ra_fix WHERE k = 'c2'), 'e5000000-0000-0000-0000-000000000003',
                              tstzrange('2099-07-09 06:00+00', '2099-07-09 14:00+00', '[)'));
  v_rita := check_eligibility((SELECT v FROM ra_fix WHERE k = 'c2'), 'e5000000-0000-0000-0000-000000000001',
                              tstzrange('2099-07-09 06:00+00', '2099-07-09 14:00+00', '[)'));
  RESET ROLE;
  IF NOT (v_root AND v_r1 = 'viewer' AND v_r2 = 'viewer') THEN
    v_ok := false; v_why := v_why || format(' root=%s r1=%s r2=%s', v_root, v_r1, v_r2); END IF;
  IF NOT ((v_rex->>'eligible') = 'true' AND (v_rita->>'eligible') = 'false'
          AND v_rita->>'policy' = 'warn') THEN
    v_ok := false; v_why := v_why || ' rex=' || v_rex::text || ' rita=' || v_rita::text; END IF;
  IF NOT v_sam_out THEN v_ok := false; v_why := v_why || ' sam covers Cell R1'; END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000001') <> 'e5000000-0000-0000-0000-000000000001'
     OR pg_temp.ra_who('e9000000-0000-0000-0000-000000000003') <> 'e5000000-0000-0000-0000-000000000003'
  THEN v_ok := false; v_why := v_why || ' the fixture rows do not hold the people described'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA0';
  ELSE RAISE NOTICE 'FAIL RA0:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA0;

\echo 'RA1 (R-343): a plain reassign puts Ray where Rita was and changes NOTHING ELSE on the row'
SAVEPOINT sp_RA1;
DO $$
DECLARE v_before jsonb; v_after jsonb; v_res jsonb; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  v_before := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000001');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_res := reassign_assignment('e9000000-0000-0000-0000-000000000001',
                               'e5000000-0000-0000-0000-000000000002');
  RESET ROLE;
  v_after := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000001');
  v_row   := pg_temp.ra_full('e9000000-0000-0000-0000-000000000001');

  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000001') <> 'e5000000-0000-0000-0000-000000000002'
  THEN v_ok := false; v_why := v_why || ' person=' || COALESCE(pg_temp.ra_who('e9000000-0000-0000-0000-000000000001')::text, 'null'); END IF;
  IF v_before IS DISTINCT FROM v_after THEN
    v_ok := false; v_why := v_why || ' before=' || v_before::text || ' after=' || v_after::text; END IF;
  -- Nothing was overridden, so nothing claims to have been.
  IF NOT ((v_row->>'eligibility_override')::boolean = false AND v_row->>'override_reason' IS NULL
          AND (v_row->>'area_override')::boolean = false AND v_row->>'area_override_reason' IS NULL)
  THEN v_ok := false; v_why := v_why || ' flags=' || v_row::text; END IF;
  -- The envelope is create_assignment''s: {assignment, eligibility}.
  IF NOT (v_res ? 'assignment' AND v_res ? 'eligibility'
          AND v_res->'assignment'->>'operator_id' = 'e5000000-0000-0000-0000-000000000002'
          AND (v_res->'eligibility'->>'eligible')::boolean = true)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS RA1';
  ELSE RAISE NOTICE 'FAIL RA1:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA1;

\echo 'RA2: a person with no ticket for that cell, under warn, with no override: not_eligible, and Rex is still on the row'
SAVEPOINT sp_RA2;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000003',
                                'e5000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_eligible'
          AND v_detail->>'policy' = 'warn'
          AND v_detail->>'operator_id' = 'e5000000-0000-0000-0000-000000000001'
          AND v_detail->'missing_skills'->0->>'name' = 'Welding R')
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000003') <> 'e5000000-0000-0000-0000-000000000003'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA2';
  ELSE RAISE NOTICE 'FAIL RA2:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA2;

\echo 'RA3: the same call with the override and a reason is taken and the columns say so; a blank reason is refused; and moving back to a certified person clears the override'
SAVEPOINT sp_RA3;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  -- An override with nothing to say is not an override.
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000003',
                                'e5000000-0000-0000-0000-000000000001', true, '   ');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT400' AND v_detail->>'error' = 'invalid_argument'
          AND v_detail->>'field' = 'p_override_reason')
  THEN v_ok := false; v_why := v_why || ' blank=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000003') <> 'e5000000-0000-0000-0000-000000000003'
  THEN v_ok := false; v_why := v_why || ' the blank-reason call wrote the row'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000003',
                              'e5000000-0000-0000-0000-000000000001', true,
                              'Rita is supervised by Rex today');
  RESET ROLE;
  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000003');
  IF NOT (v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000001'
          AND (v_row->>'eligibility_override')::boolean = true
          AND v_row->>'override_reason' = 'Rita is supervised by Rex today'
          AND (v_row->>'area_override')::boolean = false)
  THEN v_ok := false; v_why := v_why || ' overridden=' || v_row::text; END IF;

  -- ⭐ AND IT COMES BACK OFF. The flag describes the placement that is on the
  -- row NOW, not the history of the row: put a certified person back and the
  -- board must stop badging it.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000003',
                              'e5000000-0000-0000-0000-000000000003');
  RESET ROLE;
  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000003');
  IF NOT (v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000003'
          AND (v_row->>'eligibility_override')::boolean = false
          AND v_row->>'override_reason' IS NULL)
  THEN v_ok := false; v_why := v_why || ' cleared=' || v_row::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS RA3';
  ELSE RAISE NOTICE 'FAIL RA3:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA3;

\echo 'RA4 (R-331): with the plant set to block, the override is worth nothing --- the same call is refused and the row is untouched'
SAVEPOINT sp_RA4;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  -- The plant''s own admin makes it strict (73''s P13, 78''s CW13).
  PERFORM set_node_setting((SELECT v FROM ra_fix WHERE k = 'pr'), 'eligibility_policy', 'block');
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000003',
                                'e5000000-0000-0000-0000-000000000001', true,
                                'I am certifying this anyway');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_eligible'
          AND v_detail->>'policy' = 'block')
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000003') <> 'e5000000-0000-0000-0000-000000000003'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA4';
  ELSE RAISE NOTICE 'FAIL RA4:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA4;

\echo 'RA5: a person already booked at that hour is refused by the capacity trigger, which proves it fires on UPDATE OF operator_id'
SAVEPOINT sp_RA5;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- AR1 is Rita 1.000 on Tue 06:00-14:00; Rosa already holds 1.000 across
    -- exactly that window, so she would reach 2.0 against a cap of 1.0.
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000001',
                                'e5000000-0000-0000-0000-000000000004');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'capacity_exceeded'
          AND v_detail->>'operator_id' = 'e5000000-0000-0000-0000-000000000004'
          AND (v_detail->>'peak')::numeric = 2.000 AND (v_detail->>'cap')::numeric = 1.0)
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000001') <> 'e5000000-0000-0000-0000-000000000001'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA5';
  ELSE RAISE NOTICE 'FAIL RA5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA5;

\echo 'RA6 (D113): a person owned by another area is refused not_offered_here, and nothing is written'
SAVEPOINT sp_RA6;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                                'e5000000-0000-0000-0000-000000000006');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT409' AND v_detail->>'error' = 'not_offered_here'
          AND v_detail->>'kind' = 'operator'
          AND v_detail->>'id' = 'e5000000-0000-0000-0000-000000000006'
          AND v_detail->>'node_id' = (SELECT v FROM ra_fix WHERE k = 'c1')::text
          AND v_detail->>'owner_node_id' = (SELECT v FROM ra_fix WHERE k = 'lines')::text)
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000002') <> 'e5000000-0000-0000-0000-000000000002'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA6';
  ELSE RAISE NOTICE 'FAIL RA6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA6;

\echo 'RA7 (D113): with the area override and a reason he is placed, the reason is stored, and a blank reason is refused before anything is asked'
SAVEPOINT sp_RA7;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                                'e5000000-0000-0000-0000-000000000006',
                                false, NULL, true, '  ');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT (v_state = 'PT400' AND v_detail->>'error' = 'invalid_argument'
          AND v_detail->>'field' = 'p_area_override_reason')
  THEN v_ok := false; v_why := v_why || ' blank=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000002') <> 'e5000000-0000-0000-0000-000000000002'
  THEN v_ok := false; v_why := v_why || ' the blank-reason call wrote the row'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                              'e5000000-0000-0000-0000-000000000006',
                              false, NULL, true, 'Sam is covering Line R this week');
  RESET ROLE;
  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000002');
  IF NOT (v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000006'
          AND (v_row->>'area_override')::boolean = true
          AND v_row->>'area_override_reason' = 'Sam is covering Line R this week'
          AND (v_row->>'eligibility_override')::boolean = false)
  THEN v_ok := false; v_why := v_why || ' placed=' || v_row::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS RA7';
  ELSE RAISE NOTICE 'FAIL RA7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA7;

\echo 'RA8: a viewer on the plant CAN see the row and still cannot change who is on it --- not_permitted, not "not found"'
SAVEPOINT sp_RA8;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_seen boolean;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  -- The premise: r2 really can read it, so "not found" would be the wrong word.
  SELECT EXISTS (SELECT 1 FROM assignments WHERE id = 'e9000000-0000-0000-0000-000000000001')
    INTO v_seen;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000001',
                                'e5000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF NOT v_seen THEN v_ok := false; v_why := v_why || ' premise: r2 cannot even read the row'; END IF;
  IF NOT (v_state = 'PT403' AND v_detail->>'error' = 'not_permitted'
          AND v_detail->>'node_id' = (SELECT v FROM ra_fix WHERE k = 'c1')::text)
  THEN v_ok := false; v_why := v_why || ' refusal=' || COALESCE(v_state, 'none') || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000001') <> 'e5000000-0000-0000-0000-000000000001'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA8';
  ELSE RAISE NOTICE 'FAIL RA8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA8;

\echo 'RA9: an unknown row, a null row, a null person and an unknown person are each refused by name, and none of them writes'
SAVEPOINT sp_RA9;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_n integer := 0;
        v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-0000000000ff',
                                'e5000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_assignment_id' AND v_detail->>'reason' = 'not found'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' unknown_row=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  BEGIN
    PERFORM reassign_assignment(NULL::uuid, 'e5000000-0000-0000-0000-000000000002');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_assignment_id' AND v_detail->>'reason' = 'null'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' null_row=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  BEGIN
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000001', NULL::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_operator_id' AND v_detail->>'reason' = 'null'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' null_person=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  BEGIN
    -- ⚠️ THE FOREIGN KEY IS WHAT KNOWS THIS, not an RLS-filtered EXISTS over
    -- `operators` --- see the migration header. It must still come back as a
    -- named invalid_argument rather than a bare 23503.
    PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000001',
                                'e5000000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'field' = 'p_operator_id' AND v_detail->>'reason' = 'not found'
    THEN v_n := v_n + 1; ELSE v_why := v_why || ' unknown_person=' || COALESCE(v_detail::text, v_state); END IF;
  END;
  RESET ROLE;
  IF v_n <> 4 THEN v_ok := false; v_why := v_why || format(' refusals=%s of 4', v_n); END IF;
  IF pg_temp.ra_who('e9000000-0000-0000-0000-000000000001') <> 'e5000000-0000-0000-0000-000000000001'
  THEN v_ok := false; v_why := v_why || ' the row was written anyway'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA9';
  ELSE RAISE NOTICE 'FAIL RA9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA9;

\echo 'RA10: the run-attached row keeps its run and no product; the direct row keeps its product and no run'
SAVEPOINT sp_RA10;
DO $$
DECLARE v_attached_before jsonb; v_attached_after jsonb;
        v_direct_before jsonb; v_direct_after jsonb; v_row jsonb;
        v_ok boolean := true; v_why text := '';
BEGIN
  v_attached_before := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000001');
  v_direct_before   := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000002');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000001',
                              'e5000000-0000-0000-0000-000000000005');   -- Ruby
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                              'e5000000-0000-0000-0000-000000000001');   -- Rita
  RESET ROLE;
  v_attached_after := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000001');
  v_direct_after   := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000002');

  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000001');
  IF NOT (v_row->>'run_id' = 'e8000000-0000-0000-0000-000000000001'
          AND v_row->>'product_id' IS NULL
          AND v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000005'
          AND (v_row->>'target_qty')::numeric = 120 AND v_row->>'target_unit' = 'units')
  THEN v_ok := false; v_why := v_why || ' attached=' || v_row::text; END IF;

  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000002');
  IF NOT (v_row->>'product_id' = 'e6000000-0000-0000-0000-000000000001'
          AND v_row->>'run_id' IS NULL
          AND v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000001'
          AND (v_row->>'efficiency')::numeric = 0.750)
  THEN v_ok := false; v_why := v_why || ' direct=' || v_row::text; END IF;

  IF v_attached_before IS DISTINCT FROM v_attached_after
     OR v_direct_before IS DISTINCT FROM v_direct_after
  THEN v_ok := false; v_why := v_why || ' something else moved: attached '
       || v_attached_before::text || ' -> ' || v_attached_after::text
       || ' ; direct ' || v_direct_before::text || ' -> ' || v_direct_after::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS RA10';
  ELSE RAISE NOTICE 'FAIL RA10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA10;

\echo 'RA11: EXECUTE is granted to authenticated and revoked from anon and PUBLIC'
SAVEPOINT sp_RA11;
DO $$
DECLARE v_a boolean; v_n boolean; v_p boolean;
        v_sig text := 'reassign_assignment(uuid, uuid, boolean, text, boolean, text)';
BEGIN
  SELECT has_function_privilege('authenticated', v_sig, 'EXECUTE'),
         has_function_privilege('anon',          v_sig, 'EXECUTE'),
         has_function_privilege('public',        v_sig, 'EXECUTE')
    INTO v_a, v_n, v_p;
  IF v_a AND NOT v_n AND NOT v_p THEN RAISE NOTICE 'PASS RA11';
  ELSE RAISE NOTICE 'FAIL RA11: authenticated=% anon=% public=%', v_a, v_n, v_p; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL RA11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA11;

\echo 'RA12 (D110): a row whose person was deleted can be re-staffed, and the remembered name is cleared'
SAVEPOINT sp_RA12;
DO $$
DECLARE v_before jsonb; v_row jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  -- The exact shape delete_operator (0029) leaves: no person, the name kept.
  UPDATE assignments SET operator_id = NULL, operator_display_name = 'Ray'
   WHERE id = 'e9000000-0000-0000-0000-000000000002';
  v_before := pg_temp.ra_rest('e9000000-0000-0000-0000-000000000002');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                              'e5000000-0000-0000-0000-000000000005', false, NULL, false, NULL);
  RESET ROLE;
  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000002');
  IF NOT (v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000005'
          AND v_row->'operator_display_name' = 'null'::jsonb)
  THEN v_ok := false; v_why := v_why || ' row=' || v_row::text; END IF;
  IF pg_temp.ra_rest('e9000000-0000-0000-0000-000000000002') <> v_before
  THEN v_ok := false; v_why := v_why || ' other columns moved'; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA12';
  ELSE RAISE NOTICE 'FAIL RA12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA12;

\echo 'RA13 (D113): an area override sent for a person who does not need one is normalised off'
SAVEPOINT sp_RA13;
DO $$
DECLARE v_row jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  -- Ruby is owned by Plant R, which covers Cell R1: no override is needed.
  PERFORM reassign_assignment('e9000000-0000-0000-0000-000000000002',
                              'e5000000-0000-0000-0000-000000000005',
                              false, NULL, true, 'sent by a screen that did not know better');
  RESET ROLE;
  v_row := pg_temp.ra_full('e9000000-0000-0000-0000-000000000002');
  IF NOT (v_row->>'operator_id' = 'e5000000-0000-0000-0000-000000000005'
          AND (v_row->>'area_override')::boolean = false
          AND v_row->'area_override_reason' = 'null'::jsonb)
  THEN v_ok := false; v_why := v_why || ' row=' || v_row::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS RA13';
  ELSE RAISE NOTICE 'FAIL RA13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL RA13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_RA13;

ROLLBACK;

\echo '79_reassign_assignment_test.sql complete (14 cases: RA0-RA13)'
