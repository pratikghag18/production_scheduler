-- ============================================================================
-- 78_copy_week_test.sql --- migration 0055, Copy Week (R-339, S35).
--
-- The maintainer, session 71: "For the copy week, if there are conflicts lets
-- present them to the user and let them decide what they want to keep, the
-- prior plan or the copied plan." Two functions: `copy_week_plan` says what a
-- copy would do, item by item, and writes nothing; `apply_copy_week` takes one
-- answer per clash and applies exactly those answers in one transaction. This
-- file asks both of them the way 57 and 73 ask the writers: as a signed-in
-- person, through the RPCs, with the rows read back after every write.
--
-- ⭐ THE CASES THIS FILE EXISTS FOR ARE CW7-CW12 AND CW19. A plan is easy to
-- get green while the apply does something else, so every "copied" answer is
-- followed by a read of the row that should be gone and the row that should
-- be there, and every "prior" answer by a read of the row that must still be
-- there. CW18 is the other one: a raise half-way through the apply must leave
-- the target week exactly as it was, because a plpgsql function is one
-- transaction and the whole point of asking first is that nothing is written
-- twice or by halves.
--
-- ⚠️ EVERY CASE THAT MEASURES A REFUSAL RUNS AS `authenticated`. Both RPCs are
-- SECURITY INVOKER; psql connects as the superuser, who bypasses RLS and whose
-- `app_current_org()` is NULL. The person copying is w1, a SITE admin of Plant
-- W whose org-wide role is 'viewer' --- so `app_is_admin()` cannot
-- short-circuit any predicate under test (46's, 47's and 57's lesson).
--
-- FIXTURE. A plant of its own, far from the seed's anchored week, so nothing
-- the seed holds can overlap a copy and no operator here is booked anywhere
-- else. All times are UTC, and 2099-06-01 is a Monday.
--
--   Plant W (root) . Assembly W . Line W . { Cell W1, Cell W2 }
--   Cell W2 requires the training "Welding W" (owned by Plant W).
--
--   People:  w1  org-wide VIEWER + admin grant on Plant W     -- copies the week
--            w2  org-wide SUPERVISOR + supervisor grant on Plant W  -- CW2
--   Operators (all owned by Plant W): Wanda, Walt, Wes, Willa, Wyatt, Wren.
--            Wes holds Welding W, EXPIRING 2099-06-06: certified through the
--            source week, not through the target one.
--   Products: Widget W, Gadget W (both made at Plant W).
--
--   SOURCE week (Mon 2099-06-01):
--     R1  Cell W1, Widget W, Tue 06:00-14:00, headcount 2, notes 'first shift'
--         A1 Wanda 1.000   A2 Walt 0.500, target 120 units
--     R2  Cell W2, Gadget W, Wed 06:00-14:00
--         A3 Wes 1.000                       -- eligible here, not a week later
--     A5  Willa, DIRECT on Cell W1, Widget W, Thu 08:00-12:00, 0.750
--     RH  Cell W2, Fri 06:00-10:00, product DELETED (D110: sku remembered)
--         AH Wyatt on RH                     -- history, counted, not copied
--
--   TARGET week (Mon 2099-06-08), the prior plan:
--     RX  Cell W1, Gadget W, Tue 10:00-18:00  -- overlaps R1 shifted  -> run_overlap
--         AX Wyatt 1.000
--     AZ  Walt, direct Cell W1, Tue 06:00-10:00, 1.000 -- Walt busy   -> operator_busy (A2)
--     AY  Willa, direct Cell W1, Thu 10:00-14:00, 0.500 -- Willa busy -> operator_busy (A5)
--
--   So the +7 plan is: R1 clash, R2 clean, A1 clean, A2 clash, A3 clash
--   (not_eligible, warn), A5 clash --- 2 clean, 4 clash --- and the -7 plan
--   (onto the empty week of 2099-05-25, where Wes's ticket still holds) is
--   6 clean, 0 clash, which is what CW6 copies.
--
-- CW0        the fixture's premises
-- CW1-CW4    the four refusals: not_a_plant, not_admin, same_week, not_whole_weeks
-- CW5        the plan, item by item, and that it writes nothing
-- CW6        a clean copy: counts and every copied row read back
-- CW7        every clash answered "prior": all three prior rows survive
-- CW8-CW10   "copied" on run_overlap, on an attached operator_busy, on a direct one
-- CW11-CW12  not_eligible under warn: "prior", then "copied" as a warned placement
-- CW13       under block only ["prior"] is offered, and "copied" is refused
-- CW14-CW17  undecided, choice_not_offered, unknown_key, duplicate_key / not_an_array
-- CW18       atomicity: a raise from the capacity trigger mid-apply writes nothing
-- CW19       an attached assignment follows its run, whatever its own answer
-- CW20       grants
-- CW21       the company admin gets the same plan
-- CW22-CW28  the reviewer's round (session 76). A person on loan from a plant
--            the caller cannot read is listed and copied (F-099); the removed
--            count is over DISTINCT ids (F-100); a source row reaching into the
--            target week is listed as prior and follows the answer (CW24 prior,
--            CW25 copied); only ["prior"] where a displaced row cannot be
--            edited; not_eligible under warn with a prior row removes it; null
--            dates are refused
--
--   Second fixture, for CW22 and CW26: Plant V (another root in org 1, made
--   through create_node by the company admin), Dept V under it, Vera owned by
--   Plant V, and w3 = org-wide viewer, admin on Plant W, viewer on Plant V.
--   w1 cannot read Vera's row at all; w3 can read it and cannot edit Dept V.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE cw_fix (k text primary key, v uuid);
GRANT SELECT ON cw_fix TO PUBLIC;

-- One item of a plan by its key.
CREATE FUNCTION pg_temp.cw_item(p_plan jsonb, p_key text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT i FROM jsonb_array_elements(p_plan->'items') i WHERE i->>'key' = p_key;
$fn$;

-- What a week holds under Plant W: run and assignment counts. Called AFTER
-- RESET ROLE, so it reads as the owner and RLS is out of the way.
CREATE FUNCTION pg_temp.cw_week(p_start date) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  WITH w AS (SELECT tstzrange(p_start::timestamptz, (p_start + 7)::timestamptz, '[)') AS r),
       pw AS (SELECT path FROM nodes WHERE id = (SELECT v FROM cw_fix WHERE k = 'pw'))
  SELECT jsonb_build_object(
    'runs', (SELECT count(*) FROM runs x JOIN nodes n ON n.id = x.node_id, w, pw
              WHERE n.path <@ pw.path AND w.r @> lower(x.timerange)),
    'assignments', (SELECT count(*) FROM assignments x JOIN nodes n ON n.id = x.node_id, w, pw
              WHERE n.path <@ pw.path AND w.r @> lower(x.timerange)));
$fn$;

DO $$
DECLARE v_pw uuid; v_dept uuid; v_line uuid; v_c1 uuid; v_c2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pw   := (create_node(NULL,   'Plant W',    0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_dept := (create_node(v_pw,   'Assembly W', 0)->>'id')::uuid;
  v_line := (create_node(v_dept, 'Line W',     0)->>'id')::uuid;
  v_c1   := (create_node(v_line, 'Cell W1',    0)->>'id')::uuid;
  v_c2   := (create_node(v_line, 'Cell W2',    1)->>'id')::uuid;
  RESET ROLE;
  -- Written AFTER RESET ROLE: `authenticated` cannot write a TEMP table (57).
  INSERT INTO cw_fix (k, v) VALUES
    ('pw', v_pw), ('dept', v_dept), ('line', v_line), ('c1', v_c1), ('c2', v_c2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_pw uuid; v_c1 uuid; v_c2 uuid;
BEGIN
  SELECT v INTO v_pw FROM cw_fix WHERE k = 'pw';
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';

  -- People. w1 is the person the feature is for: runs the plant, is not a
  -- company admin. w2 may schedule on the plant and does not run it.
  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000d1'),
    ('00000000-0000-0000-0000-0000000000d2');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000d1', 'viewer'),
    ('d0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000d2', 'supervisor');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000001', v_pw, v_org, 'admin'),
    ('d0000000-0000-0000-0000-000000000002', v_pw, v_org, 'supervisor');

  -- Operators, all owned by Plant W so the area rule (D113) never speaks here.
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('d5000000-0000-0000-0000-000000000001', v_org, 'Wanda', 'EMP-W01', v_pw),
    ('d5000000-0000-0000-0000-000000000002', v_org, 'Walt',  'EMP-W02', v_pw),
    ('d5000000-0000-0000-0000-000000000003', v_org, 'Wes',   'EMP-W03', v_pw),
    ('d5000000-0000-0000-0000-000000000005', v_org, 'Willa', 'EMP-W05', v_pw),
    ('d5000000-0000-0000-0000-000000000006', v_org, 'Wyatt', 'EMP-W06', v_pw),
    ('d5000000-0000-0000-0000-000000000007', v_org, 'Wren',  'EMP-W07', v_pw);

  -- Products made at Plant W (D115: a product_sites row, not a column).
  INSERT INTO products (id, org_id, sku, name) VALUES
    ('d6000000-0000-0000-0000-000000000001', v_org, 'WW1', 'Widget W'),
    ('d6000000-0000-0000-0000-000000000002', v_org, 'WW2', 'Gadget W');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'd6000000-0000-0000-0000-000000000001', v_pw),
    (v_org, 'd6000000-0000-0000-0000-000000000002', v_pw);

  -- The training Cell W2 needs, and Wes's ticket for it that runs out between
  -- the two weeks. check_eligibility compares expires_at with the END of the
  -- window, so Wes is eligible on Wed 3 June and expiring on Wed 10 June.
  INSERT INTO skills (id, org_id, name, site_node_id) VALUES
    ('d4000000-0000-0000-0000-000000000001', v_org, 'Welding W', v_pw);
  INSERT INTO node_skill_requirements (node_id, skill_id, org_id) VALUES
    (v_c2, 'd4000000-0000-0000-0000-000000000001', v_org);
  INSERT INTO operator_skills (operator_id, skill_id, org_id, expires_at) VALUES
    ('d5000000-0000-0000-0000-000000000003', 'd4000000-0000-0000-0000-000000000001', v_org, '2099-06-06');

  -- SOURCE week.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('d8000000-0000-0000-0000-000000000001', v_org, v_c1, 'd6000000-0000-0000-0000-000000000001',
     tstzrange('2099-06-02 06:00+00', '2099-06-02 14:00+00', '[)'), 2, 'first shift'),
    ('d8000000-0000-0000-0000-000000000002', v_org, v_c2, 'd6000000-0000-0000-0000-000000000002',
     tstzrange('2099-06-03 06:00+00', '2099-06-03 14:00+00', '[)'), 1, NULL);
  -- RH: a run whose product has been deleted (D110). The table's own rule is
  -- num_nonnulls(product_id, product_sku) = 1, so the sku carries the memory.
  INSERT INTO runs (id, org_id, node_id, product_id, product_sku, product_name, timerange, planned_headcount) VALUES
    ('d8000000-0000-0000-0000-00000000000e', v_org, v_c2, NULL, 'OLD', 'Old Part',
     tstzrange('2099-06-05 06:00+00', '2099-06-05 10:00+00', '[)'), 1);

  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
    ('d9000000-0000-0000-0000-000000000001', v_org, v_c1, 'd5000000-0000-0000-0000-000000000001',
     'd8000000-0000-0000-0000-000000000001', NULL, tstzrange('2099-06-02 06:00+00', '2099-06-02 14:00+00', '[)'), 1.000, NULL, NULL),
    ('d9000000-0000-0000-0000-000000000002', v_org, v_c1, 'd5000000-0000-0000-0000-000000000002',
     'd8000000-0000-0000-0000-000000000001', NULL, tstzrange('2099-06-02 06:00+00', '2099-06-02 14:00+00', '[)'), 0.500, 120, 'units'),
    ('d9000000-0000-0000-0000-000000000003', v_org, v_c2, 'd5000000-0000-0000-0000-000000000003',
     'd8000000-0000-0000-0000-000000000002', NULL, tstzrange('2099-06-03 06:00+00', '2099-06-03 14:00+00', '[)'), 1.000, NULL, NULL),
    ('d9000000-0000-0000-0000-000000000005', v_org, v_c1, 'd5000000-0000-0000-0000-000000000005',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-04 08:00+00', '2099-06-04 12:00+00', '[)'), 0.750, NULL, NULL),
    ('d9000000-0000-0000-0000-00000000000e', v_org, v_c2, 'd5000000-0000-0000-0000-000000000006',
     'd8000000-0000-0000-0000-00000000000e', NULL, tstzrange('2099-06-05 06:00+00', '2099-06-05 10:00+00', '[)'), 1.000, NULL, NULL);

  -- TARGET week: the prior plan.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount) VALUES
    ('d8000000-0000-0000-0000-00000000000a', v_org, v_c1, 'd6000000-0000-0000-0000-000000000002',
     tstzrange('2099-06-09 10:00+00', '2099-06-09 18:00+00', '[)'), 1);
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-00000000000a', v_org, v_c1, 'd5000000-0000-0000-0000-000000000006',
     'd8000000-0000-0000-0000-00000000000a', NULL, tstzrange('2099-06-09 10:00+00', '2099-06-09 18:00+00', '[)'), 1.000),
    ('d9000000-0000-0000-0000-00000000000b', v_org, v_c1, 'd5000000-0000-0000-0000-000000000002',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-09 06:00+00', '2099-06-09 10:00+00', '[)'), 1.000),
    ('d9000000-0000-0000-0000-00000000000c', v_org, v_c1, 'd5000000-0000-0000-0000-000000000005',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-11 10:00+00', '2099-06-11 14:00+00', '[)'), 0.500);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;

RESET ROLE;

-- ---- second fixture: another plant, a person on loan, a second site admin ----
DO $$
DECLARE v_pv uuid; v_v1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pv := (create_node(NULL, 'Plant V', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  v_v1 := (create_node(v_pv, 'Dept V', 0)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO cw_fix (k, v) VALUES ('pv', v_pv), ('v1', v_v1);
  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('d5000000-0000-0000-0000-0000000000f1', v_org, 'Vera', 'EMP-V01', v_pv);
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000d3');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000003', v_org, '00000000-0000-0000-0000-0000000000d3', 'viewer');
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('d0000000-0000-0000-0000-000000000003', (SELECT v FROM cw_fix WHERE k = 'pw'), v_org, 'admin'),
    ('d0000000-0000-0000-0000-000000000003', v_pv, v_org, 'viewer');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE EXCEPTION 'SECOND FIXTURE FAILED: % (%)', SQLERRM, SQLSTATE;
END $$;
RESET ROLE;

\echo 'CW0: the premises every case rests on (a root of its own, a site admin who is not a company admin, the two weeks as described)'
SAVEPOINT sp_CW0;
DO $$
DECLARE v_root boolean; v_w1 text; v_src jsonb; v_tgt jsonb; v_prev jsonb; v_elig_src jsonb; v_elig_tgt jsonb;
BEGIN
  SELECT parent_id IS NULL INTO v_root FROM nodes WHERE id = (SELECT v FROM cw_fix WHERE k = 'pw');
  SELECT role INTO v_w1 FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000d1';
  v_src  := pg_temp.cw_week('2099-06-01');
  v_tgt  := pg_temp.cw_week('2099-06-08');
  v_prev := pg_temp.cw_week('2099-05-25');
  -- Wes's ticket: good for the source Wednesday, expiring for the target one.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_elig_src := check_eligibility((SELECT v FROM cw_fix WHERE k = 'c2'), 'd5000000-0000-0000-0000-000000000003',
                                  tstzrange('2099-06-03 06:00+00', '2099-06-03 14:00+00', '[)'));
  v_elig_tgt := check_eligibility((SELECT v FROM cw_fix WHERE k = 'c2'), 'd5000000-0000-0000-0000-000000000003',
                                  tstzrange('2099-06-10 06:00+00', '2099-06-10 14:00+00', '[)'));
  RESET ROLE;
  IF v_root AND v_w1 = 'viewer'
     AND v_src = '{"runs": 3, "assignments": 5}'::jsonb
     AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb
     AND v_prev = '{"runs": 0, "assignments": 0}'::jsonb
     AND (v_elig_src->>'eligible') = 'true' AND (v_elig_tgt->>'eligible') = 'false'
     AND v_elig_tgt->>'policy' = 'warn'
  THEN RAISE NOTICE 'PASS CW0';
  ELSE RAISE NOTICE 'FAIL CW0: root=% w1=% src=% tgt=% prev=% elig_src=% elig_tgt=%',
    v_root, v_w1, v_src, v_tgt, v_prev, v_elig_src, v_elig_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW0: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW0;

-- ===========================================================================
-- THE REFUSALS
-- ===========================================================================

\echo 'CW1: not_a_plant --- a department, another company''s root, and this plant seen from another company all get the same answer'
SAVEPOINT sp_CW1;
DO $$
DECLARE v_raw text; v_d1 jsonb; v_s1 text; v_d2 jsonb; v_s2 text; v_d3 jsonb; v_s3 text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'dept'), '2099-06-01', '2099-06-08');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    -- Contoso's root. Org-scoped first, so the answer says nothing about it.
    PERFORM copy_week_plan('3000000b-0000-0000-0000-000000000001', '2099-06-01', '2099-06-08');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  RESET ROLE;
  -- And Contoso's admin asking about Plant W: not_a_plant, not not_admin ---
  -- the tenant check comes before anything that would confirm the node exists.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s3 = RETURNED_SQLSTATE;
    BEGIN v_d3 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d3 := NULL; END;
  END;
  RESET ROLE;
  IF v_s1 = 'PT400' AND v_d1->>'reason' = 'not_a_plant' AND v_d1->>'error' = 'invalid_argument'
     AND v_s2 = 'PT400' AND v_d2->>'reason' = 'not_a_plant'
     AND v_s3 = 'PT400' AND v_d3->>'reason' = 'not_a_plant'
  THEN RAISE NOTICE 'PASS CW1';
  ELSE RAISE NOTICE 'FAIL CW1: dept=%/% other_org_root=%/% other_org_admin=%/%', v_s1, v_d1, v_s2, v_d2, v_s3, v_d3; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW1: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW1;

\echo 'CW2: not_admin --- a supervisor ON the plant may schedule there and still may not copy its week, from either function'
SAVEPOINT sp_CW2;
DO $$
DECLARE v_raw text; v_plan jsonb; v_ps text; v_apply jsonb; v_as text; v_tgt jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_ps = RETURNED_SQLSTATE;
    BEGIN v_plan := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_plan := NULL; END;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-05-25', '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_as = RETURNED_SQLSTATE;
    BEGIN v_apply := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_apply := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-05-25');
  IF v_ps = 'PT403' AND v_plan->>'reason' = 'not_admin' AND v_plan->>'error' = 'not_permitted'
     AND v_as = 'PT403' AND v_apply->>'reason' = 'not_admin'
     AND v_tgt = '{"runs": 0, "assignments": 0}'::jsonb
  THEN RAISE NOTICE 'PASS CW2';
  ELSE RAISE NOTICE 'FAIL CW2: plan=%/% apply=%/% week_after=%', v_ps, v_plan, v_as, v_apply, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW2: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW2;

\echo 'CW3: same_week --- copying a week onto itself is refused by name'
SAVEPOINT sp_CW3;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-01');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  IF v_state = 'PT400' AND v_detail->>'reason' = 'same_week'
  THEN RAISE NOTICE 'PASS CW3';
  ELSE RAISE NOTICE 'FAIL CW3: state=% detail=%', v_state, v_detail; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW3: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW3;

\echo 'CW4: not_whole_weeks --- three days ahead and ten days ahead are both refused, naming the day count'
SAVEPOINT sp_CW4;
DO $$
DECLARE v_raw text; v_d1 jsonb; v_s1 text; v_d2 jsonb; v_s2 text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-04');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-11');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  RESET ROLE;
  IF v_s1 = 'PT400' AND v_d1->>'reason' = 'not_whole_weeks' AND (v_d1->>'days')::int = 3
     AND v_s2 = 'PT400' AND v_d2->>'reason' = 'not_whole_weeks' AND (v_d2->>'days')::int = 10
  THEN RAISE NOTICE 'PASS CW4';
  ELSE RAISE NOTICE 'FAIL CW4: three=%/% ten=%/%', v_s1, v_d1, v_s2, v_d2; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW4: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW4;

-- ===========================================================================
-- THE PLAN
-- ===========================================================================

\echo 'CW5 ⭐: the plan, item by item --- every clash names its reason, both candidates and both choices, and nothing is written'
SAVEPOINT sp_CW5;
DO $$
DECLARE v_plan jsonb; v_r1 jsonb; v_r2 jsonb; v_a1 jsonb; v_a2 jsonb; v_a3 jsonb; v_a5 jsonb;
        v_src jsonb; v_tgt jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  RESET ROLE;
  v_src := pg_temp.cw_week('2099-06-01');
  v_tgt := pg_temp.cw_week('2099-06-08');

  v_r1 := pg_temp.cw_item(v_plan, 'run:d8000000-0000-0000-0000-000000000001');
  v_r2 := pg_temp.cw_item(v_plan, 'run:d8000000-0000-0000-0000-000000000002');
  v_a1 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000001');
  v_a2 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000002');
  v_a3 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000003');
  v_a5 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000005');

  -- The envelope.
  IF NOT (v_plan->'counts' = '{"clean": 2, "clash": 4}'::jsonb) THEN v_ok := false; v_why := v_why || ' counts=' || (v_plan->'counts')::text; END IF;
  IF NOT (v_plan->'history' = '{"runs": 1, "assignments": 1}'::jsonb) THEN v_ok := false; v_why := v_why || ' history=' || (v_plan->'history')::text; END IF;
  IF NOT ((v_plan->>'shift_days')::int = 7 AND v_plan->>'source_start' = '2099-06-01' AND v_plan->>'target_start' = '2099-06-08'
          AND jsonb_array_length(v_plan->'items') = 6) THEN v_ok := false; v_why := v_why || ' envelope'; END IF;
  -- The history rows are not items.
  IF pg_temp.cw_item(v_plan, 'run:d8000000-0000-0000-0000-00000000000e') IS NOT NULL
     OR pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-00000000000e') IS NOT NULL
  THEN v_ok := false; v_why := v_why || ' history_listed'; END IF;

  -- R1: run_overlap against RX, both choices, shifted a week, values carried.
  IF NOT (v_r1->>'kind' = 'run' AND v_r1->>'status' = 'clash' AND v_r1->'parent_key' = 'null'::jsonb
          AND v_r1->'clash'->>'reason' = 'run_overlap' AND v_r1->'clash'->'policy' = 'null'::jsonb
          AND jsonb_array_length(v_r1->'clash'->'prior') = 1
          AND v_r1->'clash'->'prior'->0->>'id' = 'd8000000-0000-0000-0000-00000000000a'
          AND v_r1->'clash'->'prior'->0->>'kind' = 'run'
          AND v_r1->'clash'->'prior'->0->>'product_name' = 'Gadget W'
          AND v_r1->'clash'->'choices' = '["prior", "copied"]'::jsonb
          AND (v_r1->'copied'->>'start')::timestamptz = '2099-06-09 06:00+00'::timestamptz
          AND (v_r1->'copied'->>'end')::timestamptz   = '2099-06-09 14:00+00'::timestamptz
          AND v_r1->'copied'->>'node_name' = 'Cell W1' AND v_r1->'copied'->>'product_name' = 'Widget W'
          AND (v_r1->'copied'->>'planned_headcount')::int = 2 AND v_r1->'copied'->>'notes' = 'first shift')
  THEN v_ok := false; v_why := v_why || ' r1=' || v_r1::text; END IF;

  -- R2: clean.
  IF NOT (v_r2->>'status' = 'clean' AND v_r2->'clash' = 'null'::jsonb
          AND (v_r2->'copied'->>'start')::timestamptz = '2099-06-10 06:00+00'::timestamptz)
  THEN v_ok := false; v_why := v_why || ' r2=' || v_r2::text; END IF;

  -- A1: clean, attached to R1.
  IF NOT (v_a1->>'kind' = 'assignment' AND v_a1->>'status' = 'clean'
          AND v_a1->>'parent_key' = 'run:d8000000-0000-0000-0000-000000000001'
          AND v_a1->'copied'->>'operator_name' = 'Wanda' AND v_a1->'copied'->>'product_name' = 'Widget W')
  THEN v_ok := false; v_why := v_why || ' a1=' || v_a1::text; END IF;

  -- A2: operator_busy against AZ (Walt's direct row), attached to R1, values carried.
  IF NOT (v_a2->>'status' = 'clash' AND v_a2->'clash'->>'reason' = 'operator_busy'
          AND v_a2->>'parent_key' = 'run:d8000000-0000-0000-0000-000000000001'
          AND jsonb_array_length(v_a2->'clash'->'prior') = 1
          AND v_a2->'clash'->'prior'->0->>'id' = 'd9000000-0000-0000-0000-00000000000b'
          AND v_a2->'clash'->'prior'->0->>'kind' = 'assignment'
          AND v_a2->'clash'->'prior'->0->>'operator_name' = 'Walt'
          AND v_a2->'clash'->'choices' = '["prior", "copied"]'::jsonb
          AND (v_a2->'copied'->>'efficiency')::numeric = 0.500
          AND (v_a2->'copied'->>'target_qty')::numeric = 120 AND v_a2->'copied'->>'target_unit' = 'units')
  THEN v_ok := false; v_why := v_why || ' a2=' || v_a2::text; END IF;

  -- A3: not_eligible under the company's warn, nothing displaced, both choices.
  IF NOT (v_a3->>'status' = 'clash' AND v_a3->'clash'->>'reason' = 'not_eligible'
          AND v_a3->'clash'->>'policy' = 'warn'
          AND v_a3->'clash'->'prior' = '[]'::jsonb
          AND v_a3->'clash'->'choices' = '["prior", "copied"]'::jsonb
          AND v_a3->>'parent_key' = 'run:d8000000-0000-0000-0000-000000000002'
          AND v_a3->'copied'->>'operator_name' = 'Wes' AND v_a3->'copied'->>'node_name' = 'Cell W2')
  THEN v_ok := false; v_why := v_why || ' a3=' || v_a3::text; END IF;

  -- A5: a direct row, operator_busy against AY.
  IF NOT (v_a5->>'status' = 'clash' AND v_a5->'clash'->>'reason' = 'operator_busy'
          AND v_a5->'parent_key' = 'null'::jsonb
          AND jsonb_array_length(v_a5->'clash'->'prior') = 1
          AND v_a5->'clash'->'prior'->0->>'id' = 'd9000000-0000-0000-0000-00000000000c'
          AND v_a5->'clash'->'choices' = '["prior", "copied"]'::jsonb
          AND v_a5->'copied'->>'product_id' = 'd6000000-0000-0000-0000-000000000001'
          AND (v_a5->'copied'->>'start')::timestamptz = '2099-06-11 08:00+00'::timestamptz
          AND (v_a5->'copied'->>'efficiency')::numeric = 0.750)
  THEN v_ok := false; v_why := v_why || ' a5=' || v_a5::text; END IF;

  -- And nothing moved.
  IF NOT (v_src = '{"runs": 3, "assignments": 5}'::jsonb AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' written: src=' || v_src::text || ' tgt=' || v_tgt::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW5';
  ELSE RAISE NOTICE 'FAIL CW5:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW5: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW5;

\echo 'CW6 ⭐: a clean copy (a week back, where nothing sits and Wes''s ticket still holds) --- counts, and every copied row read back'
SAVEPOINT sp_CW6;
DO $$
DECLARE v_plan jsonb; v_res jsonb; v_src jsonb; v_tgt jsonb;
        v_r1 runs%ROWTYPE; v_r2 runs%ROWTYPE;
        v_a1 assignments%ROWTYPE; v_a2 assignments%ROWTYPE; v_a3 assignments%ROWTYPE; v_a5 assignments%ROWTYPE;
        v_c1 uuid; v_c2 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-05-25');
  v_res  := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-05-25', '[]'::jsonb);
  RESET ROLE;
  v_src := pg_temp.cw_week('2099-06-01');
  v_tgt := pg_temp.cw_week('2099-05-25');

  SELECT * INTO v_r1 FROM runs WHERE node_id = v_c1 AND lower(timerange) = '2099-05-26 06:00+00';
  SELECT * INTO v_r2 FROM runs WHERE node_id = v_c2 AND lower(timerange) = '2099-05-27 06:00+00';
  SELECT * INTO v_a1 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000001' AND lower(timerange) = '2099-05-26 06:00+00';
  SELECT * INTO v_a2 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000002' AND lower(timerange) = '2099-05-26 06:00+00';
  SELECT * INTO v_a3 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000003' AND lower(timerange) = '2099-05-27 06:00+00';
  SELECT * INTO v_a5 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000005' AND lower(timerange) = '2099-05-28 08:00+00';

  IF NOT (v_plan->'counts' = '{"clean": 6, "clash": 0}'::jsonb AND (v_plan->>'shift_days')::int = -7)
  THEN v_ok := false; v_why := v_why || ' plan=' || (v_plan->'counts')::text || '/' || (v_plan->>'shift_days'); END IF;
  IF NOT (v_res = '{"created": {"runs": 2, "assignments": 4}, "removed": {"runs": 0, "assignments": 0}, "skipped": 0}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_tgt = '{"runs": 2, "assignments": 4}'::jsonb AND v_src = '{"runs": 3, "assignments": 5}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' weeks: tgt=' || v_tgt::text || ' src=' || v_src::text; END IF;

  -- R1's copy: same cell, product, length, headcount and notes; made by w1.
  IF NOT (v_r1.id IS NOT NULL AND v_r1.product_id = 'd6000000-0000-0000-0000-000000000001'
          AND v_r1.timerange = tstzrange('2099-05-26 06:00+00', '2099-05-26 14:00+00', '[)')
          AND v_r1.planned_headcount = 2 AND v_r1.notes = 'first shift'
          AND v_r1.created_by = '00000000-0000-0000-0000-0000000000d1')
  THEN v_ok := false; v_why := v_why || ' r1_copy=' || to_jsonb(v_r1)::text; END IF;
  IF NOT (v_r2.id IS NOT NULL AND v_r2.product_id = 'd6000000-0000-0000-0000-000000000002'
          AND v_r2.timerange = tstzrange('2099-05-27 06:00+00', '2099-05-27 14:00+00', '[)')
          AND v_r2.planned_headcount = 1 AND v_r2.notes IS NULL)
  THEN v_ok := false; v_why := v_why || ' r2_copy=' || to_jsonb(v_r2)::text; END IF;

  -- The crew hangs off the NEW run ids, with their own values carried.
  IF NOT (v_a1.run_id = v_r1.id AND v_a1.node_id = v_c1 AND v_a1.product_id IS NULL AND v_a1.efficiency = 1.000
          AND v_a1.timerange = tstzrange('2099-05-26 06:00+00', '2099-05-26 14:00+00', '[)')
          AND v_a1.eligibility_override = false AND v_a1.area_override = false
          AND v_a1.created_by = '00000000-0000-0000-0000-0000000000d1')
  THEN v_ok := false; v_why := v_why || ' a1_copy=' || to_jsonb(v_a1)::text; END IF;
  IF NOT (v_a2.run_id = v_r1.id AND v_a2.efficiency = 0.500 AND v_a2.target_qty = 120 AND v_a2.target_unit = 'units')
  THEN v_ok := false; v_why := v_why || ' a2_copy=' || to_jsonb(v_a2)::text; END IF;
  IF NOT (v_a3.run_id = v_r2.id AND v_a3.node_id = v_c2 AND v_a3.eligibility_override = false)
  THEN v_ok := false; v_why := v_why || ' a3_copy=' || to_jsonb(v_a3)::text; END IF;
  -- The direct one stays direct, carrying its product.
  IF NOT (v_a5.run_id IS NULL AND v_a5.product_id = 'd6000000-0000-0000-0000-000000000001' AND v_a5.node_id = v_c1
          AND v_a5.timerange = tstzrange('2099-05-28 08:00+00', '2099-05-28 12:00+00', '[)') AND v_a5.efficiency = 0.750)
  THEN v_ok := false; v_why := v_why || ' a5_copy=' || to_jsonb(v_a5)::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW6';
  ELSE RAISE NOTICE 'FAIL CW6:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW6: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW6;

-- ===========================================================================
-- THE ANSWERS --- each clash kind with "prior" and with "copied"
-- ===========================================================================

\echo 'CW7 ⭐: every clash answered "prior" --- RX, AX, AZ and AY all survive, only the clean run is copied, the attached crew is skipped with its run'
SAVEPOINT sp_CW7;
DO $$
DECLARE v_res jsonb; v_tgt jsonb; v_survivors int; v_r2 runs%ROWTYPE; v_crew int; v_c1 uuid; v_c2 uuid; v_new_on_c1 int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  SELECT count(*) INTO v_survivors FROM (
    SELECT id FROM runs WHERE id = 'd8000000-0000-0000-0000-00000000000a'
    UNION ALL SELECT id FROM assignments WHERE id IN ('d9000000-0000-0000-0000-00000000000a',
                                                      'd9000000-0000-0000-0000-00000000000b',
                                                      'd9000000-0000-0000-0000-00000000000c')) s;
  SELECT count(*) INTO v_new_on_c1 FROM runs WHERE node_id = v_c1 AND lower(timerange) = '2099-06-09 06:00+00';
  SELECT * INTO v_r2 FROM runs WHERE node_id = v_c2 AND lower(timerange) = '2099-06-10 06:00+00';
  SELECT count(*) INTO v_crew FROM assignments WHERE run_id = v_r2.id;

  -- skipped: R1, A1 and A2 (with their run), A3, A5.
  IF NOT (v_res = '{"created": {"runs": 1, "assignments": 0}, "removed": {"runs": 0, "assignments": 0}, "skipped": 5}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_survivors = 4) THEN v_ok := false; v_why := v_why || ' survivors=' || v_survivors; END IF;
  IF NOT (v_new_on_c1 = 0) THEN v_ok := false; v_why := v_why || ' R1_was_copied'; END IF;
  IF NOT (v_r2.id IS NOT NULL AND v_crew = 0) THEN v_ok := false; v_why := v_why || ' r2_copy=' || COALESCE(v_r2.id::text, 'missing') || ' crew=' || v_crew; END IF;
  IF NOT (v_tgt = '{"runs": 2, "assignments": 3}'::jsonb) THEN v_ok := false; v_why := v_why || ' week=' || v_tgt::text; END IF;
  -- Wes, Wanda and Willa's copies were not made; Walt has only his prior row.
  IF EXISTS (SELECT 1 FROM assignments WHERE operator_id IN ('d5000000-0000-0000-0000-000000000001',
                                                             'd5000000-0000-0000-0000-000000000003')
              AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15')
     OR (SELECT count(*) FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000002'
          AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15') <> 1
     OR (SELECT count(*) FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000005'
          AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15') <> 1
  THEN v_ok := false; v_why := v_why || ' a_copy_was_made'; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW7';
  ELSE RAISE NOTICE 'FAIL CW7:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW7: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW7;

\echo 'CW8 ⭐: run_overlap answered "copied" --- RX goes WHOLE with its crew, R1''s copy lands with Wanda attached to the new id'
SAVEPOINT sp_CW8;
DO $$
DECLARE v_res jsonb; v_tgt jsonb; v_rx int; v_ax int; v_r1 runs%ROWTYPE; v_a1 assignments%ROWTYPE; v_az int; v_ay int; v_c1 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  SELECT count(*) INTO v_rx FROM runs WHERE id = 'd8000000-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_ax FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_az FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000b';
  SELECT count(*) INTO v_ay FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000c';
  SELECT * INTO v_r1 FROM runs WHERE node_id = v_c1 AND lower(timerange) = '2099-06-09 06:00+00';
  SELECT * INTO v_a1 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000001' AND lower(timerange) = '2099-06-09 06:00+00';

  -- created: R1', R2', A1'. removed: RX and AX. skipped: A2, A3, A5.
  IF NOT (v_res = '{"created": {"runs": 2, "assignments": 1}, "removed": {"runs": 1, "assignments": 1}, "skipped": 3}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_rx = 0 AND v_ax = 0) THEN v_ok := false; v_why := v_why || ' RX/AX still there'; END IF;
  IF NOT (v_az = 1 AND v_ay = 1) THEN v_ok := false; v_why := v_why || ' AZ/AY touched'; END IF;
  IF NOT (v_r1.id IS NOT NULL AND v_r1.product_id = 'd6000000-0000-0000-0000-000000000001'
          AND v_r1.timerange = tstzrange('2099-06-09 06:00+00', '2099-06-09 14:00+00', '[)')
          AND v_r1.planned_headcount = 2 AND v_r1.notes = 'first shift')
  THEN v_ok := false; v_why := v_why || ' r1_copy=' || to_jsonb(v_r1)::text; END IF;
  IF NOT (v_a1.id IS NOT NULL AND v_a1.run_id = v_r1.id AND v_a1.node_id = v_c1)
  THEN v_ok := false; v_why := v_why || ' a1_copy=' || to_jsonb(v_a1)::text; END IF;
  IF NOT (v_tgt = '{"runs": 2, "assignments": 3}'::jsonb) THEN v_ok := false; v_why := v_why || ' week=' || v_tgt::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW8';
  ELSE RAISE NOTICE 'FAIL CW8:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW8: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW8;

\echo 'CW9 ⭐: operator_busy answered "copied" on an ATTACHED row --- Walt''s prior row goes, his copy lands on the new run'
SAVEPOINT sp_CW9;
DO $$
DECLARE v_res jsonb; v_tgt jsonb; v_az int; v_ay int; v_r1 runs%ROWTYPE; v_a2 assignments%ROWTYPE; v_c1 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  SELECT count(*) INTO v_az FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000b';
  SELECT count(*) INTO v_ay FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000c';
  SELECT * INTO v_r1 FROM runs WHERE node_id = v_c1 AND lower(timerange) = '2099-06-09 06:00+00';
  SELECT * INTO v_a2 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000002' AND lower(timerange) = '2099-06-09 06:00+00';

  -- created: R1', R2', A1', A2'. removed: RX, and AX + AZ. skipped: A3, A5.
  IF NOT (v_res = '{"created": {"runs": 2, "assignments": 2}, "removed": {"runs": 1, "assignments": 2}, "skipped": 2}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_az = 0) THEN v_ok := false; v_why := v_why || ' AZ still there'; END IF;
  IF NOT (v_ay = 1) THEN v_ok := false; v_why := v_why || ' AY touched'; END IF;
  IF NOT (v_a2.id IS NOT NULL AND v_a2.run_id = v_r1.id AND v_a2.efficiency = 0.500
          AND v_a2.target_qty = 120 AND v_a2.target_unit = 'units'
          AND v_a2.timerange = tstzrange('2099-06-09 06:00+00', '2099-06-09 14:00+00', '[)'))
  THEN v_ok := false; v_why := v_why || ' a2_copy=' || to_jsonb(v_a2)::text; END IF;
  IF NOT (v_tgt = '{"runs": 2, "assignments": 3}'::jsonb) THEN v_ok := false; v_why := v_why || ' week=' || v_tgt::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW9';
  ELSE RAISE NOTICE 'FAIL CW9:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW9: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW9;

\echo 'CW10 ⭐: operator_busy answered "copied" on a DIRECT row --- Willa''s prior row goes, her copy lands direct with its product'
SAVEPOINT sp_CW10;
DO $$
DECLARE v_res jsonb; v_tgt jsonb; v_ay int; v_rx int; v_az int; v_a5 assignments%ROWTYPE; v_c1 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "copied"}]'::jsonb);
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  SELECT count(*) INTO v_ay FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000c';
  SELECT count(*) INTO v_rx FROM runs WHERE id = 'd8000000-0000-0000-0000-00000000000a';
  SELECT count(*) INTO v_az FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000b';
  SELECT * INTO v_a5 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000005' AND lower(timerange) = '2099-06-11 08:00+00';

  -- created: R2', A5'. removed: AY. skipped: R1, A1, A2, A3.
  IF NOT (v_res = '{"created": {"runs": 1, "assignments": 1}, "removed": {"runs": 0, "assignments": 1}, "skipped": 4}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_ay = 0) THEN v_ok := false; v_why := v_why || ' AY still there'; END IF;
  IF NOT (v_rx = 1 AND v_az = 1) THEN v_ok := false; v_why := v_why || ' RX/AZ touched'; END IF;
  IF NOT (v_a5.id IS NOT NULL AND v_a5.run_id IS NULL AND v_a5.product_id = 'd6000000-0000-0000-0000-000000000001'
          AND v_a5.node_id = v_c1 AND v_a5.efficiency = 0.750
          AND v_a5.timerange = tstzrange('2099-06-11 08:00+00', '2099-06-11 12:00+00', '[)'))
  THEN v_ok := false; v_why := v_why || ' a5_copy=' || to_jsonb(v_a5)::text; END IF;
  IF NOT (v_tgt = '{"runs": 2, "assignments": 3}'::jsonb) THEN v_ok := false; v_why := v_why || ' week=' || v_tgt::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW10';
  ELSE RAISE NOTICE 'FAIL CW10:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW10: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW10;

\echo 'CW11: not_eligible under warn answered "prior" --- the run is copied uncrewed, Wes is not placed, his training row is untouched'
SAVEPOINT sp_CW11;
DO $$
DECLARE v_res jsonb; v_r2 runs%ROWTYPE; v_crew int; v_wes int; v_ticket date; v_c2 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT * INTO v_r2 FROM runs WHERE node_id = v_c2 AND lower(timerange) = '2099-06-10 06:00+00';
  SELECT count(*) INTO v_crew FROM assignments WHERE run_id = v_r2.id;
  SELECT count(*) INTO v_wes FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000003'
    AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15';
  SELECT expires_at INTO v_ticket FROM operator_skills WHERE operator_id = 'd5000000-0000-0000-0000-000000000003';

  IF NOT ((v_res->'created'->>'runs')::int = 1 AND (v_res->'created'->>'assignments')::int = 0)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_r2.id IS NOT NULL AND v_r2.product_id = 'd6000000-0000-0000-0000-000000000002' AND v_crew = 0)
  THEN v_ok := false; v_why := v_why || ' r2_copy=' || COALESCE(v_r2.id::text, 'missing') || ' crew=' || v_crew; END IF;
  IF NOT (v_wes = 0 AND v_ticket = '2099-06-06') THEN v_ok := false; v_why := v_why || ' wes_rows=' || v_wes || ' ticket=' || v_ticket; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW11';
  ELSE RAISE NOTICE 'FAIL CW11:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW11: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW11;

\echo 'CW12 ⭐: not_eligible under warn answered "copied" --- placed the way the board places a warned person: override on, a reason recorded, on the NEW run'
SAVEPOINT sp_CW12;
DO $$
DECLARE v_res jsonb; v_r2 runs%ROWTYPE; v_a3 assignments%ROWTYPE; v_c2 uuid; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT * INTO v_r2 FROM runs WHERE node_id = v_c2 AND lower(timerange) = '2099-06-10 06:00+00';
  SELECT * INTO v_a3 FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000003' AND lower(timerange) = '2099-06-10 06:00+00';

  IF NOT (v_res = '{"created": {"runs": 1, "assignments": 1}, "removed": {"runs": 0, "assignments": 0}, "skipped": 4}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_a3.id IS NOT NULL AND v_a3.run_id = v_r2.id AND v_a3.node_id = v_c2
          AND v_a3.eligibility_override = true
          AND coalesce(btrim(v_a3.override_reason), '') <> ''
          AND v_a3.area_override = false)
  THEN v_ok := false; v_why := v_why || ' a3_copy=' || to_jsonb(v_a3)::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW12';
  ELSE RAISE NOTICE 'FAIL CW12:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW12: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW12;

\echo 'CW13 ⭐⭐ (R-239): under block the plan offers ONLY ["prior"] for Wes, "copied" is refused as not offered with nothing written, and "prior" goes through'
SAVEPOINT sp_CW13;
DO $$
DECLARE v_plan jsonb; v_a3 jsonb; v_a2 jsonb; v_raw text; v_detail jsonb; v_state text; v_tgt jsonb; v_res jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  -- The plant's own admin makes the plant strict (73's P13).
  PERFORM set_node_setting((SELECT v FROM cw_fix WHERE k = 'pw'), 'eligibility_policy', 'block');
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  v_a3 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000003');
  v_a2 := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000002');
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "copied"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');

  IF NOT (v_a3->>'status' = 'clash' AND v_a3->'clash'->>'reason' = 'not_eligible'
          AND v_a3->'clash'->>'policy' = 'block' AND v_a3->'clash'->'choices' = '["prior"]'::jsonb)
  THEN v_ok := false; v_why := v_why || ' a3=' || v_a3::text; END IF;
  -- The policy narrows the eligibility clash and nothing else.
  IF NOT (v_a2->'clash'->'choices' = '["prior", "copied"]'::jsonb AND v_plan->'counts' = '{"clean": 2, "clash": 4}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' a2=' || (v_a2->'clash'->'choices')::text || ' counts=' || (v_plan->'counts')::text; END IF;
  IF NOT (v_state = 'PT400' AND v_detail->>'reason' = 'choice_not_offered'
          AND v_detail->>'key' = 'assignment:d9000000-0000-0000-0000-000000000003'
          AND v_detail->'choices' = '["prior"]'::jsonb)
  THEN v_ok := false; v_why := v_why || ' refusal=' || v_state || '/' || COALESCE(v_detail::text, 'null'); END IF;
  IF NOT (v_tgt = '{"runs": 1, "assignments": 3}'::jsonb) THEN v_ok := false; v_why := v_why || ' written=' || v_tgt::text; END IF;

  -- And the answer that WAS offered is taken.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  IF NOT (v_res = '{"created": {"runs": 1, "assignments": 0}, "removed": {"runs": 0, "assignments": 0}, "skipped": 5}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' prior_result=' || v_res::text; END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW13';
  ELSE RAISE NOTICE 'FAIL CW13:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW13: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW13;

-- ===========================================================================
-- THE APPLY'S OWN REFUSALS --- each one leaves the target week untouched
-- ===========================================================================

\echo 'CW14: undecided --- one clash answered, three not: refused naming the three keys, nothing written'
SAVEPOINT sp_CW14;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_tgt jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08',
      '[{"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "copied"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  IF v_state = 'PT400' AND v_detail->>'reason' = 'undecided'
     AND jsonb_array_length(v_detail->'keys') = 3
     AND v_detail->'keys' ? 'assignment:d9000000-0000-0000-0000-000000000002'
     AND v_detail->'keys' ? 'assignment:d9000000-0000-0000-0000-000000000003'
     AND v_detail->'keys' ? 'assignment:d9000000-0000-0000-0000-000000000005'
     AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb
  THEN RAISE NOTICE 'PASS CW14';
  ELSE RAISE NOTICE 'FAIL CW14: state=% detail=% week=%', v_state, v_detail, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW14: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW14;

\echo 'CW15: choice_not_offered --- an answer the plan never offered ("keep"), and a decision with no choice at all'
SAVEPOINT sp_CW15;
DO $$
DECLARE v_raw text; v_d1 jsonb; v_s1 text; v_d2 jsonb; v_s2 text; v_tgt jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "keep"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  IF v_s1 = 'PT400' AND v_d1->>'reason' = 'choice_not_offered'
     AND v_d1->>'key' = 'run:d8000000-0000-0000-0000-000000000001' AND v_d1->>'choice' = 'keep'
     AND v_s2 = 'PT400' AND v_d2->>'reason' = 'choice_not_offered'
     AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb
  THEN RAISE NOTICE 'PASS CW15';
  ELSE RAISE NOTICE 'FAIL CW15: keep=%/% none=%/% week=%', v_s1, v_d1, v_s2, v_d2, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW15: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW15;

\echo 'CW16: unknown_key --- an answer about a CLEAN item, and about nothing at all, are both refused'
SAVEPOINT sp_CW16;
DO $$
DECLARE v_raw text; v_d1 jsonb; v_s1 text; v_d2 jsonb; v_s2 text; v_tgt jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- R2 is clean; a client deciding about it has misread the plan.
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "run:d8000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
      {"key": "run:00000000-0000-0000-0000-000000000000", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  IF v_s1 = 'PT400' AND v_d1->>'reason' = 'unknown_key' AND v_d1->>'key' = 'run:d8000000-0000-0000-0000-000000000002'
     AND v_s2 = 'PT400' AND v_d2->>'reason' = 'unknown_key' AND v_d2->>'key' = 'run:00000000-0000-0000-0000-000000000000'
     AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb
  THEN RAISE NOTICE 'PASS CW16';
  ELSE RAISE NOTICE 'FAIL CW16: clean=%/% nothing=%/% week=%', v_s1, v_d1, v_s2, v_d2, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW16: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW16;

\echo 'CW17: duplicate_key --- the same item answered twice is a client bug, not a tie to break; and p_decisions must be an array'
SAVEPOINT sp_CW17;
DO $$
DECLARE v_raw text; v_d1 jsonb; v_s1 text; v_d2 jsonb; v_s2 text; v_d3 jsonb; v_s3 text; v_tgt jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "copied"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s1 = RETURNED_SQLSTATE;
    BEGIN v_d1 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d1 := NULL; END;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s2 = RETURNED_SQLSTATE;
    BEGIN v_d2 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d2 := NULL; END;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_s3 = RETURNED_SQLSTATE;
    BEGIN v_d3 := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_d3 := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  IF v_s1 = 'PT400' AND v_d1->>'reason' = 'duplicate_key' AND v_d1->>'key' = 'run:d8000000-0000-0000-0000-000000000001'
     AND v_s2 = 'PT400' AND v_d2->>'reason' = 'not_an_array'
     AND v_s3 = 'PT400' AND v_d3->>'reason' = 'not_an_array'
     AND v_tgt = '{"runs": 1, "assignments": 3}'::jsonb
  THEN RAISE NOTICE 'PASS CW17';
  ELSE RAISE NOTICE 'FAIL CW17: dup=%/% object=%/% null=%/% week=%', v_s1, v_d1, v_s2, v_d2, v_s3, v_d3, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW17: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW17;

\echo 'CW18 ⭐⭐: atomicity --- the capacity trigger refuses the LAST write of a valid apply, and the target week is exactly as it was'
SAVEPOINT sp_CW18;
DO $$
DECLARE v_plan jsonb; v_raw text; v_detail jsonb; v_state text := 'none'; v_tgt jsonb; v_r2 int; v_wren int; v_survivors int;
        v_c1 uuid; v_c2 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  SELECT v INTO v_c2 FROM cw_fix WHERE k = 'c2';
  -- The gap 0055's header names, built on purpose: Wren holds two halves on
  -- the source Friday (legal together, peak 1.0) and 0.3 on the target Friday.
  -- Each copy probed ALONE beside the 0.3 fits (0.8), so the plan says clean
  -- twice; together they reach 1.3 and the trigger refuses the second insert.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-000000000d01', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-05 06:00+00', '2099-06-05 10:00+00', '[)'), 0.500),
    ('d9000000-0000-0000-0000-000000000d02', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-05 06:00+00', '2099-06-05 10:00+00', '[)'), 0.500),
    ('d9000000-0000-0000-0000-000000000d03', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-12 06:00+00', '2099-06-12 10:00+00', '[)'), 0.300);

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
    v_state := 'allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  -- R2's copy would have been written BEFORE the failing assignment.
  SELECT count(*) INTO v_r2 FROM runs WHERE node_id = v_c2 AND lower(timerange) = '2099-06-10 06:00+00';
  SELECT count(*) INTO v_wren FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000007'
    AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15';
  SELECT count(*) INTO v_survivors FROM (
    SELECT id FROM runs WHERE id = 'd8000000-0000-0000-0000-00000000000a'
    UNION ALL SELECT id FROM assignments WHERE id IN ('d9000000-0000-0000-0000-00000000000a',
                                                      'd9000000-0000-0000-0000-00000000000b',
                                                      'd9000000-0000-0000-0000-00000000000c',
                                                      'd9000000-0000-0000-0000-000000000d03')) s;
  IF v_plan->'counts' = '{"clean": 4, "clash": 4}'::jsonb
     AND v_state = 'PT409' AND v_detail->>'error' = 'capacity_exceeded'
     AND v_tgt = '{"runs": 1, "assignments": 4}'::jsonb
     AND v_r2 = 0 AND v_wren = 1 AND v_survivors = 5
  THEN RAISE NOTICE 'PASS CW18';
  ELSE RAISE NOTICE 'FAIL CW18: plan=% state=% detail=% week=% r2_copies=% wren_rows=% survivors=%',
    v_plan->'counts', v_state, v_detail, v_tgt, v_r2, v_wren, v_survivors; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW18: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW18;

\echo 'CW19 ⭐: an attached assignment follows its run --- R1 "prior" and Walt "copied": Walt is skipped, his prior row stays, nothing is removed'
SAVEPOINT sp_CW19;
DO $$
DECLARE v_res jsonb; v_tgt jsonb; v_az int; v_walt int; v_new_on_c1 int; v_c1 uuid;
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  v_tgt := pg_temp.cw_week('2099-06-08');
  SELECT count(*) INTO v_az FROM assignments WHERE id = 'd9000000-0000-0000-0000-00000000000b';
  SELECT count(*) INTO v_walt FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000002'
    AND lower(timerange) >= '2099-06-08' AND lower(timerange) < '2099-06-15';
  SELECT count(*) INTO v_new_on_c1 FROM runs WHERE node_id = v_c1 AND lower(timerange) = '2099-06-09 06:00+00';
  -- skipped: R1, A1, A2 (with their run), A3, A5. Removed: nothing --- the
  -- "copied" answer on A2 must not take AZ out when A2 itself is not copied.
  IF v_res = '{"created": {"runs": 1, "assignments": 0}, "removed": {"runs": 0, "assignments": 0}, "skipped": 5}'::jsonb
     AND v_az = 1 AND v_walt = 1 AND v_new_on_c1 = 0
     AND v_tgt = '{"runs": 2, "assignments": 3}'::jsonb
  THEN RAISE NOTICE 'PASS CW19';
  ELSE RAISE NOTICE 'FAIL CW19: result=% AZ=% walt_rows=% r1_copies=% week=%', v_res, v_az, v_walt, v_new_on_c1, v_tgt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW19: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW19;

\echo 'CW20: EXECUTE is granted to authenticated and revoked from anon and PUBLIC, on both functions'
SAVEPOINT sp_CW20;
DO $$
DECLARE v_pa boolean; v_pn boolean; v_pp boolean; v_aa boolean; v_an boolean; v_ap boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'copy_week_plan(uuid, date, date)', 'EXECUTE'),
         has_function_privilege('anon',          'copy_week_plan(uuid, date, date)', 'EXECUTE'),
         has_function_privilege('public',        'copy_week_plan(uuid, date, date)', 'EXECUTE'),
         has_function_privilege('authenticated', 'apply_copy_week(uuid, date, date, jsonb)', 'EXECUTE'),
         has_function_privilege('anon',          'apply_copy_week(uuid, date, date, jsonb)', 'EXECUTE'),
         has_function_privilege('public',        'apply_copy_week(uuid, date, date, jsonb)', 'EXECUTE')
    INTO v_pa, v_pn, v_pp, v_aa, v_an, v_ap;
  IF v_pa AND NOT v_pn AND NOT v_pp AND v_aa AND NOT v_an AND NOT v_ap
  THEN RAISE NOTICE 'PASS CW20';
  ELSE RAISE NOTICE 'FAIL CW20: plan auth=% anon=% public=% ; apply auth=% anon=% public=%', v_pa, v_pn, v_pp, v_aa, v_an, v_ap; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL CW20: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW20;

\echo 'CW21: the company admin sees the same plan the site admin does'
SAVEPOINT sp_CW21;
DO $$
DECLARE v_plan jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  RESET ROLE;
  IF v_plan->'counts' = '{"clean": 2, "clash": 4}'::jsonb AND jsonb_array_length(v_plan->'items') = 6
  THEN RAISE NOTICE 'PASS CW21';
  ELSE RAISE NOTICE 'FAIL CW21: counts=% items=%', v_plan->'counts', jsonb_array_length(v_plan->'items'); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW21: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW21;

\echo 'CW22 ⚠⚠: a person on loan from a plant the caller cannot read is LISTED and COPIED, not dropped (F-099)'
SAVEPOINT sp_CW22;
DO $$
DECLARE v_plan1 jsonb; v_plan3 jsonb; v_item1 jsonb; v_item3 jsonb; v_res jsonb; v_c1 uuid;
        v_org uuid := '10000000-0000-0000-0000-000000000001'; v_copy assignments%ROWTYPE; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  -- Vera, owned by Plant V, placed at Cell W1 in the source week on loan (D113).
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, area_override, area_override_reason) VALUES
    ('d9000000-0000-0000-0000-0000000000f1', v_org, v_c1, 'd5000000-0000-0000-0000-0000000000f1',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-04 13:00+00', '2099-06-04 17:00+00', '[)'), 1.000, true, 'on loan');

  -- w1 cannot read her row; w3 can. Both must get the same plan, name apart.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM operators WHERE id = 'd5000000-0000-0000-0000-0000000000f1') THEN
    v_ok := false; v_why := v_why || ' premise: w1 can read Vera'; END IF;
  v_plan1 := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  v_plan3 := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  RESET ROLE;
  v_item1 := pg_temp.cw_item(v_plan1, 'assignment:d9000000-0000-0000-0000-0000000000f1');
  v_item3 := pg_temp.cw_item(v_plan3, 'assignment:d9000000-0000-0000-0000-0000000000f1');

  IF NOT (v_item1 IS NOT NULL AND v_item1->>'status' = 'clean'
          AND v_item1->'copied'->>'operator_id' = 'd5000000-0000-0000-0000-0000000000f1'
          AND v_item1->'copied'->'operator_name' = 'null'::jsonb
          AND (v_item1->'copied'->>'area_override')::boolean = true)
  THEN v_ok := false; v_why := v_why || ' w1_item=' || COALESCE(v_item1::text, 'ABSENT'); END IF;
  IF NOT (v_item3 IS NOT NULL AND v_item3->'copied'->>'operator_name' = 'Vera')
  THEN v_ok := false; v_why := v_why || ' w3_item=' || COALESCE(v_item3::text, 'ABSENT'); END IF;
  IF NOT (v_plan1->'counts' = '{"clean": 3, "clash": 4}'::jsonb AND v_plan1->'counts' = v_plan3->'counts'
          AND v_plan1->'history' = '{"runs": 1, "assignments": 1}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' counts1=' || (v_plan1->'counts')::text || ' counts3=' || (v_plan3->'counts')::text
                                     || ' history1=' || (v_plan1->'history')::text; END IF;

  -- And w1 copies her: every clash "prior", Vera clean, the row read back with the override carried.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT * INTO v_copy FROM assignments
   WHERE operator_id = 'd5000000-0000-0000-0000-0000000000f1' AND lower(timerange) = '2099-06-11 13:00+00';
  IF NOT (v_res->'created' = '{"runs": 1, "assignments": 1}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' result=' || v_res::text; END IF;
  IF NOT (v_copy.id IS NOT NULL AND v_copy.node_id = v_c1 AND v_copy.area_override = true
          AND v_copy.area_override_reason = 'on loan' AND v_copy.product_id = 'd6000000-0000-0000-0000-000000000001')
  THEN v_ok := false; v_why := v_why || ' copy=' || COALESCE(to_jsonb(v_copy)::text, 'ABSENT'); END IF;

  IF v_ok THEN RAISE NOTICE 'PASS CW22';
  ELSE RAISE NOTICE 'FAIL CW22:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW22: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW22;

\echo 'CW23 ⚠: "removed" counts a row ONCE when it is both a deleted run''s crew and a listed prior (F-100)'
SAVEPOINT sp_CW23;
DO $$
DECLARE v_plan jsonb; v_item jsonb; v_res jsonb; v_c1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_gone int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  -- Wyatt on R1 in the source week; in the target week he is RX's crew (AX)
  -- and holds a 0.5 direct row, so his copy's prior list names AX, which
  -- "copied" on R1 also removes as RX's crew.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-0000000000e1', v_org, v_c1, 'd5000000-0000-0000-0000-000000000006',
     'd8000000-0000-0000-0000-000000000001', NULL, tstzrange('2099-06-02 06:00+00', '2099-06-02 14:00+00', '[)'), 1.000),
    ('d9000000-0000-0000-0000-0000000000e2', v_org, v_c1, 'd5000000-0000-0000-0000-000000000006',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-09 06:00+00', '2099-06-09 08:00+00', '[)'), 0.500);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  v_item := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-0000000000e1');
  IF NOT (v_item->'clash'->>'reason' = 'operator_busy' AND jsonb_array_length(v_item->'clash'->'prior') = 2)
  THEN v_ok := false; v_why := v_why || ' item=' || COALESCE(v_item::text, 'ABSENT'); END IF;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-0000000000e1", "choice": "copied"}]'::jsonb);
  RESET ROLE;
  SELECT count(*) INTO v_gone
    FROM (VALUES ('d9000000-0000-0000-0000-00000000000a'::uuid), ('d9000000-0000-0000-0000-0000000000e2'::uuid)) v(id)
   WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.id = v.id);
  IF NOT (v_gone = 2 AND (v_res->'removed'->>'assignments')::int = 2 AND (v_res->'removed'->>'runs')::int = 1)
  THEN v_ok := false; v_why := v_why || ' gone=' || v_gone || ' result=' || v_res::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW23';
  ELSE RAISE NOTICE 'FAIL CW23:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW23: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW23;

\echo 'CW24 ⚠: a source row that reaches INTO the target week is listed as prior of the copy it overlaps; "prior" keeps it and the source week whole'
SAVEPOINT sp_CW24;
DO $$
DECLARE v_plan jsonb; v_item jsonb; v_res jsonb; v_c1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_x1 int; v_src_before jsonb; v_src_after jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  -- Wren: X1 Sun 22:00 - Mon 02:00 (starts in the source week, ends in the
  -- target one) and X2 Mon 00:00 - 04:00 of the source week. X2's copy lands
  -- on target Monday 00:00 and overlaps X1's last two hours.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-0000000000e1', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-07 22:00+00', '2099-06-08 02:00+00', '[)'), 1.000),
    ('d9000000-0000-0000-0000-0000000000e2', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-01 00:00+00', '2099-06-01 04:00+00', '[)'), 1.000);
  v_src_before := pg_temp.cw_week('2099-06-01');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  v_item := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-0000000000e2');
  IF NOT (v_item->>'status' = 'clash' AND v_item->'clash'->>'reason' = 'operator_busy'
          AND v_item->'clash'->'prior'->0->>'id' = 'd9000000-0000-0000-0000-0000000000e1'
          AND v_item->'clash'->'choices' = '["prior","copied"]'::jsonb)
  THEN v_ok := false; v_why := v_why || ' item=' || COALESCE(v_item::text, 'ABSENT'); END IF;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-0000000000e2", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT count(*) INTO v_x1 FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000e1';
  v_src_after := pg_temp.cw_week('2099-06-01');
  -- X1 itself STARTS in the source week, so it is a source row too: its own
  -- copy lands a week later, clean (created 1 run, 1 assignment); X2 is
  -- skipped with the five clashes R1, A1 (follows R1), A2, A3, A5.
  IF NOT (v_x1 = 1 AND v_src_after = v_src_before AND v_res->'removed' = '{"runs": 0, "assignments": 0}'::jsonb
          AND v_res->'created' = '{"runs": 1, "assignments": 1}'::jsonb
          AND (v_res->>'skipped')::int = 6)
  THEN v_ok := false; v_why := v_why || ' x1=' || v_x1 || ' src=' || v_src_after::text || ' result=' || v_res::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW24';
  ELSE RAISE NOTICE 'FAIL CW24:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW24: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW24;

\echo 'CW25 ⚠: ...and "copied" removes that row, source week or not, and the result says so'
SAVEPOINT sp_CW25;
DO $$
DECLARE v_res jsonb; v_c1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001'; v_x1 int; v_copy int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-0000000000e1', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-07 22:00+00', '2099-06-08 02:00+00', '[)'), 1.000),
    ('d9000000-0000-0000-0000-0000000000e2', v_org, v_c1, 'd5000000-0000-0000-0000-000000000007',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-01 00:00+00', '2099-06-01 04:00+00', '[)'), 1.000);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-0000000000e2", "choice": "copied"}]'::jsonb);
  RESET ROLE;
  SELECT count(*) INTO v_x1 FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000e1';
  SELECT count(*) INTO v_copy FROM assignments
   WHERE operator_id = 'd5000000-0000-0000-0000-000000000007' AND lower(timerange) = '2099-06-08 00:00+00';
  IF NOT (v_x1 = 0 AND v_copy = 1 AND v_res->'removed' = '{"runs": 0, "assignments": 1}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' x1=' || v_x1 || ' copy=' || v_copy || ' result=' || v_res::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW25';
  ELSE RAISE NOTICE 'FAIL CW25:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW25: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW25;

\echo 'CW26 ⭐: only ["prior"] where a displaced prior row sits on a node the caller cannot edit; "copied" refused, "prior" applies (R-239)'
SAVEPOINT sp_CW26;
DO $$
DECLARE v_plan jsonb; v_item jsonb; v_res jsonb; v_c1 uuid; v_v1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_raw text; v_detail jsonb; v_state text := 'allowed'; v_vrow int; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  SELECT v INTO v_v1 FROM cw_fix WHERE k = 'v1';
  -- Vera on loan at Cell W1 in the source week; in the target week she holds a
  -- row at Dept V, which w3 can read (viewer on Plant V) and cannot edit.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, area_override, area_override_reason) VALUES
    ('d9000000-0000-0000-0000-0000000000f1', v_org, v_c1, 'd5000000-0000-0000-0000-0000000000f1',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-04 13:00+00', '2099-06-04 17:00+00', '[)'), 1.000, true, 'on loan');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES (v_org, 'd6000000-0000-0000-0000-000000000001', (SELECT v FROM cw_fix WHERE k = 'pv'));
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-0000000000f2', v_org, v_v1, 'd5000000-0000-0000-0000-0000000000f1',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-11 14:00+00', '2099-06-11 18:00+00', '[)'), 1.000);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d3', true);
  SET LOCAL ROLE authenticated;
  IF app_can_edit_node(v_v1) OR NOT EXISTS (SELECT 1 FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000f2') THEN
    v_ok := false; v_why := v_why || ' premise: w3 edits Dept V or cannot read the row'; END IF;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  v_item := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-0000000000f1');
  IF NOT (v_item->>'status' = 'clash' AND v_item->'clash'->>'reason' = 'operator_busy'
          AND v_item->'clash'->'choices' = '["prior"]'::jsonb
          AND v_item->'clash'->'prior'->0->>'id' = 'd9000000-0000-0000-0000-0000000000f2')
  THEN v_ok := false; v_why := v_why || ' item=' || COALESCE(v_item::text, 'ABSENT'); END IF;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
      {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
      {"key": "assignment:d9000000-0000-0000-0000-0000000000f1", "choice": "copied"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
  END;
  IF NOT (v_state = 'PT400' AND v_detail->>'reason' = 'choice_not_offered' AND v_detail->'choices' = '["prior"]'::jsonb)
  THEN v_ok := false; v_why := v_why || ' copied: state=' || v_state || ' detail=' || COALESCE(v_detail::text, '-'); END IF;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-0000000000f1", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT count(*) INTO v_vrow FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000f2';
  IF NOT (v_vrow = 1 AND v_res->'removed' = '{"runs": 0, "assignments": 0}'::jsonb AND (v_res->>'skipped')::int = 6)
  THEN v_ok := false; v_why := v_why || ' prior: vrow=' || v_vrow || ' result=' || v_res::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW26';
  ELSE RAISE NOTICE 'FAIL CW26:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW26: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW26;

\echo 'CW27 ⭐: not_eligible under warn WITH a prior row: "copied" removes the listed row and places the copy with the override'
SAVEPOINT sp_CW27;
DO $$
DECLARE v_plan jsonb; v_item jsonb; v_res jsonb; v_c1 uuid; v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_prior int; v_copy assignments%ROWTYPE; v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_c1 FROM cw_fix WHERE k = 'c1';
  -- Wes (ticket expired for the target week) also holds a target-week row
  -- overlapping A3's copy, so his item is not_eligible AND lists a prior row.
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency) VALUES
    ('d9000000-0000-0000-0000-0000000000e3', v_org, v_c1, 'd5000000-0000-0000-0000-000000000003',
     NULL, 'd6000000-0000-0000-0000-000000000001', tstzrange('2099-06-10 08:00+00', '2099-06-10 12:00+00', '[)'), 1.000);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  v_plan := copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08');
  v_item := pg_temp.cw_item(v_plan, 'assignment:d9000000-0000-0000-0000-000000000003');
  IF NOT (v_item->'clash'->>'reason' = 'not_eligible' AND v_item->'clash'->>'policy' = 'warn'
          AND v_item->'clash'->'prior'->0->>'id' = 'd9000000-0000-0000-0000-0000000000e3'
          AND v_item->'clash'->'choices' = '["prior","copied"]'::jsonb)
  THEN v_ok := false; v_why := v_why || ' item=' || COALESCE(v_item::text, 'ABSENT'); END IF;
  v_res := apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', '2099-06-08', '[
    {"key": "run:d8000000-0000-0000-0000-000000000001", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000002", "choice": "prior"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000003", "choice": "copied"},
    {"key": "assignment:d9000000-0000-0000-0000-000000000005", "choice": "prior"}]'::jsonb);
  RESET ROLE;
  SELECT count(*) INTO v_prior FROM assignments WHERE id = 'd9000000-0000-0000-0000-0000000000e3';
  SELECT * INTO v_copy FROM assignments WHERE operator_id = 'd5000000-0000-0000-0000-000000000003' AND lower(timerange) = '2099-06-10 06:00+00';
  IF NOT (v_prior = 0 AND v_copy.id IS NOT NULL AND v_copy.eligibility_override = true
          AND coalesce(v_copy.override_reason, '') <> ''
          AND v_res->'removed' = '{"runs": 0, "assignments": 1}'::jsonb)
  THEN v_ok := false; v_why := v_why || ' prior=' || v_prior || ' copy=' || COALESCE(to_jsonb(v_copy)::text, 'ABSENT') || ' result=' || v_res::text; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW27';
  ELSE RAISE NOTICE 'FAIL CW27:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW27: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW27;

\echo 'CW28: a null date is refused by both functions, reason null, nothing written'
SAVEPOINT sp_CW28;
DO $$
DECLARE v_raw text; v_detail jsonb; v_state text; v_n int := 0; v_tgt jsonb; v_ok boolean := true; v_why text := '';
BEGIN
  v_tgt := pg_temp.cw_week('2099-06-08');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM copy_week_plan((SELECT v FROM cw_fix WHERE k = 'pw'), NULL, '2099-06-08');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'reason' = 'null' THEN v_n := v_n + 1;
    ELSE v_why := v_why || ' plan: ' || v_state || ' ' || COALESCE(v_detail::text, '-'); END IF;
  END;
  BEGIN
    PERFORM apply_copy_week((SELECT v FROM cw_fix WHERE k = 'pw'), '2099-06-01', NULL, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_raw = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    BEGIN v_detail := v_raw::jsonb; EXCEPTION WHEN OTHERS THEN v_detail := NULL; END;
    IF v_state = 'PT400' AND v_detail->>'reason' = 'null' THEN v_n := v_n + 1;
    ELSE v_why := v_why || ' apply: ' || v_state || ' ' || COALESCE(v_detail::text, '-'); END IF;
  END;
  RESET ROLE;
  IF NOT (v_n = 2 AND pg_temp.cw_week('2099-06-08') = v_tgt) THEN v_ok := false; v_why := v_why || ' refusals=' || v_n; END IF;
  IF v_ok THEN RAISE NOTICE 'PASS CW28';
  ELSE RAISE NOTICE 'FAIL CW28:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL CW28: unexpected exception % (sqlstate %)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_CW28;

ROLLBACK;

\echo '78_copy_week_test.sql complete (29 cases: CW0-CW28)'
