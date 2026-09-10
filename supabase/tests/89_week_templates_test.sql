-- ============================================================================
-- 89 --- NAMED WEEK TEMPLATES, APPLIED THROUGH COPY WEEK (R-356, migration 0067).
--
-- A template is a NAMED COPY OF ONE WEEK'S RUNS WITH THEIR ASSIGNMENTS, stored
-- relative to that week's Monday, belonging to the plant it was saved from.
-- Applying one is Copy Week with the template as the source, so nothing is
-- written that Copy Week would not write, and a plan from a template equals a
-- plan from the week it was saved from, item for item, on the same target.
--
-- Roles under one Plant T: tp_admin (a SITE admin of Plant T, not a company
-- admin), tp_sup (a supervisor who can place on Plant T), tp_view (a viewer).
-- The source week starts 2099-07-06 and holds a first-shift run with two crew,
-- a standalone assignment on the Tuesday, and an OVERNIGHT run Wed 22:00 ->
-- Thu 06:00 with its crew. Target weeks are empty.
--
-- Cases: TP1 save then list; TP2 duplicate name refused; TP3 a supervisor may
-- save from and apply to a week they can place on and may NOT delete; TP4 a
-- viewer refused everywhere; TP-EQ a template plan equals a week plan item for
-- item; TP-ON the overnight item crosses the day boundary; TP-APPLY apply from
-- a template writes exactly what Copy Week from the week writes (rows compared);
-- TP-XT (DEF-0021) a fabricated template id in another company answers
-- no_such_template for rename and delete just as a bogus id does, and the
-- foreign row survives --- no cross-tenant existence leak.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE t_fix (k text primary key, v uuid);
GRANT SELECT ON t_fix TO PUBLIC;

CREATE FUNCTION pg_temp.t_item(p_plan jsonb, p_key text) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT i FROM jsonb_array_elements(p_plan->'items') i WHERE i->>'key' = p_key;
$fn$;

-- A week under Plant T, normalised to RELATIVE time (day + minutes from that
-- week's Monday), so the same schedule copied onto two different weeks compares
-- equal. Read as owner (after RESET ROLE), RLS out of the way.
CREATE FUNCTION pg_temp.t_summary(p_start date) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  WITH pw AS (SELECT path FROM nodes WHERE id = (SELECT v FROM t_fix WHERE k = 'pt')),
       w  AS (SELECT tstzrange(p_start::timestamptz, (p_start + 7)::timestamptz, '[)') AS r,
                     p_start::timestamptz AS mid)
  SELECT jsonb_build_object(
    'runs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'node', n.name, 'product', x.product_id, 'headcount', x.planned_headcount, 'notes', x.notes,
        'day', floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int,
        'start_min', round((extract(epoch from (lower(x.timerange) - w.mid))
                            - floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int * 86400) / 60)::int,
        'end_min',   round((extract(epoch from (upper(x.timerange) - w.mid))
                            - floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int * 86400) / 60)::int)
        ORDER BY n.name, lower(x.timerange))
      FROM runs x JOIN nodes n ON n.id = x.node_id, pw, w
      WHERE n.path <@ pw.path AND w.r @> lower(x.timerange)), '[]'::jsonb),
    'assignments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'node', n.name, 'operator', x.operator_id, 'product', COALESCE(x.product_id, xr.product_id),
        'attached', (x.run_id IS NOT NULL),
        'eff', x.efficiency, 'tq', x.target_qty, 'tu', x.target_unit,
        'day', floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int,
        'start_min', round((extract(epoch from (lower(x.timerange) - w.mid))
                            - floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int * 86400) / 60)::int,
        'end_min',   round((extract(epoch from (upper(x.timerange) - w.mid))
                            - floor(extract(epoch from (lower(x.timerange) - w.mid)) / 86400)::int * 86400) / 60)::int)
        ORDER BY n.name, x.operator_id, lower(x.timerange))
      FROM assignments x JOIN nodes n ON n.id = x.node_id LEFT JOIN runs xr ON xr.id = x.run_id, pw, w
      WHERE n.path <@ pw.path AND w.r @> lower(x.timerange)), '[]'::jsonb));
$fn$;

-- ---- fixture: the plant, its people, and the source week -------------------
DO $$
DECLARE v_pt uuid; v_dt uuid; v_st uuid; v_l1 uuid; v_l2 uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;
  v_pt := (create_node(NULL,  'Plant T', 0, '21000000-0000-0000-0000-000000000001')->>'id')::uuid;
  -- F-120/R-002: 'Standard Plant' is 4 levels (Site/Department/Line/Work
  -- Cell, only the last schedulable). Two ancestor levels added above Line
  -- T1/T2 so they land on the actual schedulable level -- every other name
  -- and id in this file (Line T1, Line T2, and everything that reads runs/
  -- assignments off them) is unchanged.
  v_dt := (create_node(v_pt,  'Dept T',   0)->>'id')::uuid;
  v_st := (create_node(v_dt,  'Sub T',    0)->>'id')::uuid;
  v_l1 := (create_node(v_st,  'Line T1', 0)->>'id')::uuid;
  v_l2 := (create_node(v_st,  'Line T2', 1)->>'id')::uuid;
  RESET ROLE;
  INSERT INTO t_fix (k, v) VALUES ('pt', v_pt), ('l1', v_l1), ('l2', v_l2);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE EXCEPTION 'FIXTURE FAILED (nodes): % (%)', SQLERRM, SQLSTATE;
END $$;

DO $$
DECLARE v_org uuid := '10000000-0000-0000-0000-000000000001';
        v_pt uuid; v_l1 uuid; v_l2 uuid;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  SELECT v INTO v_l1 FROM t_fix WHERE k = 'l1';
  SELECT v INTO v_l2 FROM t_fix WHERE k = 'l2';

  -- tp_admin: runs the plant, not a company admin. tp_sup: may place on it.
  -- tp_view: reads it, writes nothing.
  INSERT INTO auth.users (id) VALUES
    ('00000000-0000-0000-0000-0000000000e1'),
    ('00000000-0000-0000-0000-0000000000e2'),
    ('00000000-0000-0000-0000-0000000000e3'),
    ('00000000-0000-0000-0000-0000000000e4');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', v_org, '00000000-0000-0000-0000-0000000000e1', 'viewer'),
    ('e0000000-0000-0000-0000-000000000002', v_org, '00000000-0000-0000-0000-0000000000e2', 'supervisor'),
    ('e0000000-0000-0000-0000-000000000003', v_org, '00000000-0000-0000-0000-0000000000e3', 'viewer'),
    ('e0000000-0000-0000-0000-000000000004', v_org, '00000000-0000-0000-0000-0000000000e4', 'supervisor');
  -- e4 is granted on Line T1 ONLY, BELOW the plant root: the person the board
  -- opens on a line, not the plant. Her template must still resolve to Plant T.
  INSERT INTO profile_grants (profile_id, node_id, org_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000001', v_pt, v_org, 'admin'),
    ('e0000000-0000-0000-0000-000000000002', v_pt, v_org, 'supervisor'),
    ('e0000000-0000-0000-0000-000000000003', v_pt, v_org, 'viewer'),
    ('e0000000-0000-0000-0000-000000000004', v_l1, v_org, 'supervisor');

  INSERT INTO operators (id, org_id, display_name, employee_ref, site_node_id) VALUES
    ('e5000000-0000-0000-0000-000000000001', v_org, 'Tara', 'EMP-T01', v_pt),
    ('e5000000-0000-0000-0000-000000000002', v_org, 'Theo', 'EMP-T02', v_pt);

  INSERT INTO products (id, org_id, sku, name) VALUES
    ('e6000000-0000-0000-0000-000000000001', v_org, 'TT1', 'Widget T'),
    ('e6000000-0000-0000-0000-000000000002', v_org, 'TT2', 'Gadget T');
  INSERT INTO product_sites (org_id, product_id, node_id) VALUES
    (v_org, 'e6000000-0000-0000-0000-000000000001', v_pt),
    (v_org, 'e6000000-0000-0000-0000-000000000002', v_pt);

  -- SOURCE week starting 2099-07-06: a first-shift run + two crew, a standalone
  -- assignment on the Tuesday, and an overnight run Wed 22:00 -> Thu 06:00.
  INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount, notes) VALUES
    ('e8000000-0000-0000-0000-000000000001', v_org, v_l1, 'e6000000-0000-0000-0000-000000000001',
     tstzrange('2099-07-06 06:00+00', '2099-07-06 14:00+00', '[)'), 2, 'first shift'),
    ('e8000000-0000-0000-0000-000000000002', v_org, v_l2, 'e6000000-0000-0000-0000-000000000002',
     tstzrange('2099-07-08 22:00+00', '2099-07-09 06:00+00', '[)'), 1, 'nights');
  INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, product_id, timerange, efficiency, target_qty, target_unit) VALUES
    ('e9000000-0000-0000-0000-000000000001', v_org, v_l1, 'e5000000-0000-0000-0000-000000000001',
     'e8000000-0000-0000-0000-000000000001', NULL, tstzrange('2099-07-06 06:00+00', '2099-07-06 14:00+00', '[)'), 1.000, NULL, NULL),
    ('e9000000-0000-0000-0000-000000000002', v_org, v_l1, 'e5000000-0000-0000-0000-000000000002',
     'e8000000-0000-0000-0000-000000000001', NULL, tstzrange('2099-07-06 06:00+00', '2099-07-06 14:00+00', '[)'), 0.500, 120, 'units'),
    ('e9000000-0000-0000-0000-000000000003', v_org, v_l1, 'e5000000-0000-0000-0000-000000000002',
     NULL, 'e6000000-0000-0000-0000-000000000001', tstzrange('2099-07-07 08:00+00', '2099-07-07 12:00+00', '[)'), 0.750, 100, 'units'),
    ('e9000000-0000-0000-0000-000000000004', v_org, v_l2, 'e5000000-0000-0000-0000-000000000001',
     'e8000000-0000-0000-0000-000000000002', NULL, tstzrange('2099-07-08 22:00+00', '2099-07-09 06:00+00', '[)'), 1.000, NULL, NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FIXTURE FAILED (rows): % (%)', SQLERRM, SQLSTATE;
END $$;
RESET ROLE;

\echo 'TP0: the premises (a root of its own, a site admin who is not a company admin, the source week as described)'
SAVEPOINT sp_TP0;
DO $$
DECLARE v_root boolean; v_prof text; v_admin boolean; v_place boolean; v_src jsonb;
BEGIN
  SELECT parent_id IS NULL INTO v_root FROM nodes WHERE id = (SELECT v FROM t_fix WHERE k = 'pt');
  SELECT role INTO v_prof FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000e1';
  v_src := pg_temp.t_summary('2099-07-06');
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_admin := app_is_admin_for((SELECT v FROM t_fix WHERE k = 'pt'));
  v_place := app_can_place_in_plant((SELECT v FROM t_fix WHERE k = 'pt'));
  RESET ROLE;
  IF v_root AND v_prof = 'viewer' AND v_admin AND v_place
     AND jsonb_array_length(v_src->'runs') = 2
     AND jsonb_array_length(v_src->'assignments') = 4
  THEN RAISE NOTICE 'PASS TP0';
  ELSE RAISE NOTICE 'FAIL TP0: root=% prof=% admin=% place=% src=%', v_root, v_prof, v_admin, v_place, v_src; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP0: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP0;

\echo 'TP1: an admin saves this week as a template, and it lists with its item counts'
SAVEPOINT sp_TP1;
DO $$
DECLARE v_pt uuid; v_saved jsonb; v_list jsonb; v_row jsonb;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_saved := save_week_template(v_pt, '2099-07-06', 'Day shift');
  v_list  := list_week_templates(v_pt);
  RESET ROLE;
  SELECT i FROM jsonb_array_elements(v_list) i WHERE i->>'id' = v_saved->>'id' INTO v_row;
  IF v_saved->'counts' = '{"runs": 2, "assignments": 4}'::jsonb
     AND jsonb_array_length(v_list) = 1
     AND v_row->>'name' = 'Day shift'
     AND v_row->>'saved_from' = '2099-07-06'
     AND (v_row->>'runs')::int = 2 AND (v_row->>'assignments')::int = 4
  THEN RAISE NOTICE 'PASS TP1';
  ELSE RAISE NOTICE 'FAIL TP1: saved=% row=%', v_saved, v_row; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP1: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP1;

\echo 'TP2: a second template with the same name, however cased, is refused'
SAVEPOINT sp_TP2;
DO $$
DECLARE v_pt uuid; v_reason text;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM save_week_template(v_pt, '2099-07-06', 'Day shift');
  BEGIN
    PERFORM save_week_template(v_pt, '2099-07-06', 'DAY SHIFT');
    v_reason := 'no_raise';
  EXCEPTION WHEN OTHERS THEN
    DECLARE v_detail text; BEGIN
      GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
      v_reason := (v_detail::jsonb)->>'reason';
    EXCEPTION WHEN OTHERS THEN v_reason := 'no_detail'; END;
  END;
  RESET ROLE;
  IF v_reason = 'duplicate_name' THEN RAISE NOTICE 'PASS TP2';
  ELSE RAISE NOTICE 'FAIL TP2: reason=%', v_reason; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP2: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP2;

\echo 'TP-EQ: a plan from the template equals a plan from the week it was saved from, item for item, on the same empty target'
SAVEPOINT sp_TPEQ;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_week jsonb; v_tmpl jsonb;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid  := (save_week_template(v_pt, '2099-07-06', 'Compare')->>'id')::uuid;
  v_week := copy_week_plan(v_pt, '2099-07-06', '2099-07-13');
  v_tmpl := copy_week_plan(v_pt, NULL, '2099-07-13', v_tid);
  RESET ROLE;
  IF v_week->'items' = v_tmpl->'items'
     AND v_week->'counts' = v_tmpl->'counts'
     AND (v_tmpl->'counts'->>'clean')::int = 6
     AND (v_tmpl->'counts'->>'clash')::int = 0
  THEN RAISE NOTICE 'PASS TP-EQ';
  ELSE RAISE NOTICE 'FAIL TP-EQ: week_items=% tmpl_items=% wcounts=% tcounts=%',
    v_week->'items', v_tmpl->'items', v_week->'counts', v_tmpl->'counts'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-EQ: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPEQ;

\echo 'TP-ON: the overnight run in the template materialises across the day boundary on the target week'
SAVEPOINT sp_TPON;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_plan jsonb; v_run jsonb; v_off int; v_start int; v_end int;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid  := (save_week_template(v_pt, '2099-07-06', 'Nights')->>'id')::uuid;
  -- the stored offsets of the overnight run item
  SELECT day_offset, start_min, end_min INTO v_off, v_start, v_end
    FROM week_template_items
   WHERE template_id = v_tid AND kind = 'run' AND item_ref = 'e8000000-0000-0000-0000-000000000002';
  v_plan := copy_week_plan(v_pt, NULL, '2099-07-13', v_tid);
  RESET ROLE;
  v_run := pg_temp.t_item(v_plan, 'run:e8000000-0000-0000-0000-000000000002');
  -- Wed of source = day 2; 22:00 -> 06:00 next day, so end_min crosses 1440.
  IF v_off = 2 AND v_start = 1320 AND v_end = 1800
     AND (v_run->'copied'->>'start')::timestamptz = '2099-07-15 22:00+00'::timestamptz
     AND (v_run->'copied'->>'end')::timestamptz   = '2099-07-16 06:00+00'::timestamptz
  THEN RAISE NOTICE 'PASS TP-ON';
  ELSE RAISE NOTICE 'FAIL TP-ON: off=% start=% end=% copied=%', v_off, v_start, v_end, v_run->'copied'; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-ON: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPON;

\echo 'TP-APPLY: applying the template writes exactly what Copy Week from the week writes (rows compared, relative time)'
SAVEPOINT sp_TPAP;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_week_sum jsonb; v_tmpl_sum jsonb; v_rw jsonb; v_rt jsonb;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid := (save_week_template(v_pt, '2099-07-06', 'Apply')->>'id')::uuid;
  -- Copy the WEEK onto 2099-07-13 (offset +1w); a clean plan, no decisions.
  v_rw := apply_copy_week(v_pt, '2099-07-06', '2099-07-13', '[]'::jsonb);
  -- Apply the TEMPLATE onto 2099-07-20 (offset +2w).
  v_rt := apply_copy_week(v_pt, NULL, '2099-07-20', '[]'::jsonb, v_tid);
  RESET ROLE;
  v_week_sum := pg_temp.t_summary('2099-07-13');
  v_tmpl_sum := pg_temp.t_summary('2099-07-20');
  IF v_week_sum = v_tmpl_sum
     AND v_rw->'created' = '{"runs": 2, "assignments": 4}'::jsonb
     AND v_rt->'created' = '{"runs": 2, "assignments": 4}'::jsonb
  THEN RAISE NOTICE 'PASS TP-APPLY';
  ELSE RAISE NOTICE 'FAIL TP-APPLY: week=% tmpl=% rw=% rt=%', v_week_sum, v_tmpl_sum, v_rw, v_rt; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-APPLY: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPAP;

\echo 'TP3: a supervisor may save from and apply to a week they can place on, and may NOT delete'
SAVEPOINT sp_TP3;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_res jsonb; v_saved boolean := false; v_applied boolean := false; v_del text;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
  SET LOCAL ROLE authenticated;
  v_tid   := (save_week_template(v_pt, '2099-07-06', 'Sup template')->>'id')::uuid;
  v_saved := v_tid IS NOT NULL;
  v_res   := apply_copy_week(v_pt, NULL, '2099-07-13', '[]'::jsonb, v_tid);
  v_applied := (v_res->'created'->>'runs')::int = 2 AND (v_res->'created'->>'assignments')::int = 4;
  BEGIN
    PERFORM delete_week_template(v_tid);
    v_del := 'no_raise';
  EXCEPTION WHEN OTHERS THEN
    DECLARE v_detail text; BEGIN
      GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
      v_del := (v_detail::jsonb)->>'reason';
    EXCEPTION WHEN OTHERS THEN v_del := 'no_detail'; END;
  END;
  RESET ROLE;
  IF v_saved AND v_applied AND v_del = 'not_admin' THEN RAISE NOTICE 'PASS TP3';
  ELSE RAISE NOTICE 'FAIL TP3: saved=% applied=% del=%', v_saved, v_applied, v_del; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP3: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP3;

\echo 'TP4: a viewer is refused save, apply, rename and delete'
SAVEPOINT sp_TP4;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_save text; v_apply text; v_rename text; v_delete text;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  -- one template exists, made by the admin, for the viewer to attempt against
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid := (save_week_template(v_pt, '2099-07-06', 'Locked')->>'id')::uuid;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM save_week_template(v_pt, '2099-07-06', 'Viewer try'); v_save := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_save := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_save := 'no_detail'; END; END;
  BEGIN PERFORM apply_copy_week(v_pt, NULL, '2099-07-13', '[]'::jsonb, v_tid); v_apply := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_apply := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_apply := 'no_detail'; END; END;
  BEGIN PERFORM rename_week_template(v_tid, 'Nope'); v_rename := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_rename := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_rename := 'no_detail'; END; END;
  BEGIN PERFORM delete_week_template(v_tid); v_delete := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_delete := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_delete := 'no_detail'; END; END;
  RESET ROLE;
  IF v_save = 'cannot_place' AND v_apply = 'cannot_place'
     AND v_rename = 'not_admin' AND v_delete = 'not_admin'
  THEN RAISE NOTICE 'PASS TP4';
  ELSE RAISE NOTICE 'FAIL TP4: save=% apply=% rename=% delete=%', v_save, v_apply, v_rename, v_delete; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP4: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP4;

\echo 'TP5: EXECUTE is granted to authenticated and revoked from anon/public on the new writers'
SAVEPOINT sp_TP5;
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'save_week_template(uuid, date, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon',   'save_week_template(uuid, date, text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'list_week_templates(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'rename_week_template(uuid, text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'delete_week_template(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('public', 'delete_week_template(uuid)', 'EXECUTE')
    INTO v_ok;
  IF v_ok THEN RAISE NOTICE 'PASS TP5'; ELSE RAISE NOTICE 'FAIL TP5'; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL TP5: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP5;

\echo 'TP6: a supervisor whose board root is a LINE below the plant resolves to the plant, saves the rows she can read, and applies'
SAVEPOINT sp_TP6;
DO $$
DECLARE v_pt uuid; v_l1 uuid; v_root uuid; v_saved jsonb; v_res jsonb; v_pid uuid;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  SELECT v INTO v_l1 FROM t_fix WHERE k = 'l1';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e4', true);
  SET LOCAL ROLE authenticated;
  v_root  := app_plant_root_of(v_l1);
  -- Save from the LINE node id, not the plant: the server resolves upward.
  v_saved := save_week_template(v_l1, '2099-07-06', 'From the line');
  -- Apply it to a scratch week, also addressed by the line node id.
  v_res   := apply_copy_week(v_l1, NULL, '2099-07-13', '[]'::jsonb, (v_saved->>'id')::uuid);
  RESET ROLE;
  -- Only the Line T1 rows she can read are in the template (1 run + its two
  -- crew + a standalone = 1 run, 3 assignments); the template belongs to the
  -- PLANT, and the apply wrote exactly those.
  IF v_root = v_pt
     AND v_saved->'counts' = '{"runs": 1, "assignments": 3}'::jsonb
     AND v_res->'created' = '{"runs": 1, "assignments": 3}'::jsonb
     AND EXISTS (SELECT 1 FROM week_templates WHERE id = (v_saved->>'id')::uuid AND plant_id = v_pt)
  THEN RAISE NOTICE 'PASS TP6';
  ELSE RAISE NOTICE 'FAIL TP6: root=% saved=% res=%', v_root, v_saved, v_res; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP6: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TP6;

\echo 'TP-XT ⚠ (DEF-0021): a fabricated template id in ANOTHER company answers no_such_template for rename AND delete, exactly as a bogus id does --- not the not_admin it used to leak --- and the foreign row survives'
SAVEPOINT sp_TPXT;
DO $$
DECLARE v_org2 uuid := '10000000-0000-0000-0000-000000000002';
        v_p2   uuid := '3000000b-0000-0000-0000-000000000001';   -- org 2's plant root
        v_foreign uuid := '99999999-0000-0000-0000-000000000001';
        v_bogus   uuid := '88888888-0000-0000-0000-000000000000';
        v_rn_bogus text; v_rn_foreign text; v_del_bogus text; v_del_foreign text;
        v_survived int; v_ok boolean := true; v_why text := '';
BEGIN
  -- The other company's template, written as owner (superuser bypasses RLS).
  INSERT INTO week_templates (id, org_id, plant_id, name, saved_from, created_by)
  VALUES (v_foreign, v_org2, v_p2, 'Contoso Template', '2099-07-06', NULL);

  -- As e1 (tp_admin): a SITE admin of Plant T in org 1, not an admin of org 2's
  -- plant. Before 0068 the foreign row reached app_is_admin_for and answered
  -- not_admin, distinguishable from a bogus id's no_such_template.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM rename_week_template(v_bogus, 'x'); v_rn_bogus := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_rn_bogus := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_rn_bogus := 'no_detail'; END; END;
  BEGIN PERFORM rename_week_template(v_foreign, 'x'); v_rn_foreign := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_rn_foreign := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_rn_foreign := 'no_detail'; END; END;
  BEGIN PERFORM delete_week_template(v_bogus); v_del_bogus := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_del_bogus := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_del_bogus := 'no_detail'; END; END;
  BEGIN PERFORM delete_week_template(v_foreign); v_del_foreign := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_del_foreign := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_del_foreign := 'no_detail'; END; END;
  RESET ROLE;

  -- The foreign row must still be there (pure information leak, not a write).
  SELECT count(*) INTO v_survived FROM week_templates WHERE id = v_foreign;

  IF v_rn_bogus <> 'no_such_template'   THEN v_ok := false; v_why := v_why || format(' rename bogus=%s', COALESCE(v_rn_bogus,'null')); END IF;
  IF v_rn_foreign <> 'no_such_template' THEN v_ok := false; v_why := v_why || format(' rename foreign=%s (leak: expected no_such_template)', COALESCE(v_rn_foreign,'null')); END IF;
  IF v_del_bogus <> 'no_such_template'   THEN v_ok := false; v_why := v_why || format(' delete bogus=%s', COALESCE(v_del_bogus,'null')); END IF;
  IF v_del_foreign <> 'no_such_template' THEN v_ok := false; v_why := v_why || format(' delete foreign=%s (leak: expected no_such_template)', COALESCE(v_del_foreign,'null')); END IF;
  IF v_survived <> 1 THEN v_ok := false; v_why := v_why || format(' foreign row survived=%s (expected 1)', v_survived); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS TP-XT';
  ELSE RAISE NOTICE 'FAIL TP-XT:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-XT: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPXT;

-- ⚠ UNVERIFIED, pending the developer's `npm run db:test` (or equivalent SQL
-- run) under a reset database. Written by mirroring TP1/TP-ON/TP4/TP-XT's
-- shape exactly; not executed by the build lane that wrote them (no local
-- Postgres available to it). Added for migration 0075's
-- `list_week_template_items` (R-356 surface: a read-only "what's inside"
-- view). TP-ITEMS-1/2 read the SAVED template from TP0's fixture week
-- (2099-07-06: a first-shift run with two crew, a Tuesday standalone
-- assignment, and the Wed 22:00 -> Thu 06:00 overnight run with its one crew)
-- and check names resolve and the overnight item's day/minutes survive
-- unchanged (list_week_template_items does not re-window anything --- it
-- reads the stored day_offset/start_min/end_min back as-is, unlike
-- copy_week_plan's template arm which re-materialises them onto a target).
-- TP-ITEMS-VIS mirrors TP-XT's no-leak shape for the new reader.
--
-- ⚠ ALSO UNVERIFIED (same caveat): TP-ITEMS-1 now also asserts `node_path`
-- (migration 0077, the maintainer 10 Sept: "show contents" must name the
-- line/cell, adapting to the plant's dynamic hierarchy, not just the leaf).
-- Plant T's fixture (this file's DO block above, "fixture: the plant, its
-- people, and the source week") is Plant T -> Dept T -> Sub T -> Line T1 /
-- Line T2, four levels deep with only the last schedulable (F-120/R-002).
-- run1 sits on Line T1, three levels below the plant root, so its relative
-- path is "Dept T › Sub T › Line T1" --- the plant root itself (and Plant T's
-- own name) is excluded, exactly as 0077 documents. run2 sits on Line T2:
-- "Dept T › Sub T › Line T2". Both are BELOW the plant root, so this proves
-- the sub-hierarchy shows, not just the leaf.

\echo 'TP-ITEMS-1: tp_admin reads the saved template''s items --- names resolved, run+crew+standalone+overnight rows all present'
SAVEPOINT sp_TPI1;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_items jsonb;
        v_run1 jsonb; v_run2 jsonb; v_standalone jsonb;
        v_crew_count int;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid   := (save_week_template(v_pt, '2099-07-06', 'Items 1')->>'id')::uuid;
  v_items := list_week_template_items(v_tid);
  RESET ROLE;

  -- pg_temp.t_item matches on 'key' (copy_week_plan's shape); this RPC's rows
  -- carry 'item_ref' instead, so select directly by item_ref.
  SELECT i INTO v_run1 FROM jsonb_array_elements(v_items) i
   WHERE i->>'item_ref' = 'e8000000-0000-0000-0000-000000000001';
  SELECT i INTO v_run2 FROM jsonb_array_elements(v_items) i
   WHERE i->>'item_ref' = 'e8000000-0000-0000-0000-000000000002';
  SELECT i INTO v_standalone FROM jsonb_array_elements(v_items) i
   WHERE i->>'item_ref' = 'e9000000-0000-0000-0000-000000000003';
  SELECT count(*) INTO v_crew_count FROM jsonb_array_elements(v_items) i
   WHERE i->>'run_ref' = 'e8000000-0000-0000-0000-000000000001';

  IF jsonb_array_length(v_items) = 6  -- 2 runs + 4 assignments
     AND v_run1->>'kind' = 'run' AND v_run1->>'node_name' = 'Line T1'
     AND v_run1->>'node_path' = 'Dept T › Sub T › Line T1'  -- 0077: relative to Plant T, sub-hierarchy shown
     AND v_run1->>'product_name' = 'Widget T' AND (v_run1->>'day_offset')::int = 0
     AND (v_run1->>'start_min')::int = 360 AND (v_run1->>'end_min')::int = 840
     AND (v_run1->>'planned_headcount')::int = 2 AND v_run1->>'run_ref' IS NULL
     AND v_crew_count = 2
     AND v_run2->>'node_name' = 'Line T2' AND v_run2->>'product_name' = 'Gadget T'
     AND v_run2->>'node_path' = 'Dept T › Sub T › Line T2'  -- 0077
     AND (v_run2->>'day_offset')::int = 2
     AND (v_run2->>'start_min')::int = 1320 AND (v_run2->>'end_min')::int = 1800
     AND v_standalone->>'kind' = 'assignment' AND v_standalone->>'run_ref' IS NULL
     AND v_standalone->>'operator_name' = 'Theo' AND v_standalone->>'product_name' = 'Widget T'
     AND v_standalone->>'node_path' = 'Dept T › Sub T › Line T1'  -- 0077: standalone also on Line T1
  THEN RAISE NOTICE 'PASS TP-ITEMS-1';
  ELSE RAISE NOTICE 'FAIL TP-ITEMS-1: run1=% run2=% standalone=% crew_count=% n=%',
    v_run1, v_run2, v_standalone, v_crew_count, jsonb_array_length(v_items); END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-ITEMS-1: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPI1;

\echo 'TP-ITEMS-2: tp_view (can read Plant T, writes nothing) can also read the template''s items'
SAVEPOINT sp_TPI2;
DO $$
DECLARE v_pt uuid; v_tid uuid; v_items jsonb;
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid := (save_week_template(v_pt, '2099-07-06', 'Items 2')->>'id')::uuid;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
  SET LOCAL ROLE authenticated;
  v_items := list_week_template_items(v_tid);
  RESET ROLE;

  IF jsonb_array_length(v_items) = 6 THEN RAISE NOTICE 'PASS TP-ITEMS-2';
  ELSE RAISE NOTICE 'FAIL TP-ITEMS-2: items=%', v_items; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-ITEMS-2: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPI2;

\echo 'TP-ITEMS-VIS ⚠ (DEF-0021 shape): a caller who cannot read the plant, and a foreign-org template id, both answer no_such_template with no existence leak'
SAVEPOINT sp_TPIVIS;
DO $$
DECLARE v_org2 uuid := '10000000-0000-0000-0000-000000000002';
        v_p2   uuid := '3000000b-0000-0000-0000-000000000001';   -- org 2's plant root
        v_foreign uuid := '99999999-0000-0000-0000-000000000002';
        v_bogus   uuid := '88888888-0000-0000-0000-000000000003';
        v_pt uuid; v_tid uuid;
        v_norea text; v_bogus_r text; v_foreign_r text;
        v_ok boolean := true; v_why text := '';
BEGIN
  SELECT v INTO v_pt FROM t_fix WHERE k = 'pt';
  -- A viewer with NO grant at all on Plant T (unlike e3/tp_view, who is
  -- granted a viewer role there): a profile that exists in org 1 but cannot
  -- read this plant, so the RPC's own read gate (not just the lookup) is
  -- exercised too. Reuse the org-1 auth.users row created for a different
  -- fixture would collide, so seed one here.
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000e5');
  INSERT INTO user_profiles (id, org_id, user_id, role) VALUES
    ('e0000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-0000000000e5', 'viewer');
  -- no profile_grants row for e5 anywhere: she can read nothing.

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  v_tid := (save_week_template(v_pt, '2099-07-06', 'Items VIS')->>'id')::uuid;
  RESET ROLE;

  -- The other company's template, written as owner.
  INSERT INTO week_templates (id, org_id, plant_id, name, saved_from, created_by)
  VALUES (v_foreign, v_org2, v_p2, 'Contoso Items', '2099-07-06', NULL);

  -- e5: ungranted viewer in org 1, reading the real Plant T template --- must
  -- be refused, but as a READ gate (cannot_read), never no_such_template: the
  -- template genuinely exists in HER org.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e5', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM list_week_template_items(v_tid); v_norea := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_norea := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_norea := 'no_detail'; END; END;
  RESET ROLE;

  -- e1 (tp_admin, org 1): a bogus id and the foreign-org id must both answer
  -- no_such_template, indistinguishably (DEF-0021 shape).
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN PERFORM list_week_template_items(v_bogus); v_bogus_r := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_bogus_r := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_bogus_r := 'no_detail'; END; END;
  BEGIN PERFORM list_week_template_items(v_foreign); v_foreign_r := 'no_raise';
  EXCEPTION WHEN OTHERS THEN DECLARE d text; BEGIN GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL; v_foreign_r := (d::jsonb)->>'reason'; EXCEPTION WHEN OTHERS THEN v_foreign_r := 'no_detail'; END; END;
  RESET ROLE;

  IF v_norea <> 'cannot_read' THEN v_ok := false; v_why := v_why || format(' ungranted=%s (expected cannot_read)', COALESCE(v_norea,'null')); END IF;
  IF v_bogus_r <> 'no_such_template' THEN v_ok := false; v_why := v_why || format(' bogus=%s', COALESCE(v_bogus_r,'null')); END IF;
  IF v_foreign_r <> 'no_such_template' THEN v_ok := false; v_why := v_why || format(' foreign=%s (leak: expected no_such_template)', COALESCE(v_foreign_r,'null')); END IF;
  IF v_ok THEN RAISE NOTICE 'PASS TP-ITEMS-VIS';
  ELSE RAISE NOTICE 'FAIL TP-ITEMS-VIS:%', v_why; END IF;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; RAISE NOTICE 'FAIL TP-ITEMS-VIS: unexpected exception % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK TO SAVEPOINT sp_TPIVIS;

ROLLBACK;
