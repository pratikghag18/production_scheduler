-- Where does a plant-sized board_window spend its time? Each piece timed on its
-- own, as the same authenticated admin, against the same 384-cell fixture.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  v_from timestamptz := date_trunc('week', now());
  v_to   timestamptz := v_from + interval '7 days';
  v_win  tstzrange   := tstzrange(date_trunc('week', now()),
                                  date_trunc('week', now()) + interval '7 days');
  t0 timestamptz; ms numeric; v_j jsonb; v_n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  RAISE NOTICE '%', rpad('piece', 44) || rpad('ms', 10) || 'note';
  RAISE NOTICE '%', repeat('-', 78);

  -- 1. The whole thing, for reference.
  t0 := clock_timestamp();
  v_j := board_window('load_plant'::ltree, v_from, v_to);
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('board_window, whole', 44) || rpad(round(ms,1)::text, 10) || 'the number to explain';

  -- 2. The subtree itself.
  t0 := clock_timestamp();
  SELECT count(*) INTO v_n FROM nodes n WHERE n.org_id = app_current_org() AND n.path <@ 'load_plant';
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('scoped_nodes (441 rows, through RLS)', 44) || rpad(round(ms,1)::text, 10) || v_n::text || ' nodes';

  -- 3. node_policies: app_resolve_node_setting once PER NODE, each an ancestor walk.
  t0 := clock_timestamp();
  PERFORM COALESCE(app_resolve_node_setting(n.id, 'eligibility_policy'), 'warn')
    FROM nodes n WHERE n.org_id = app_current_org() AND n.path <@ 'load_plant';
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('node_policies (per-node resolver)', 44) || rpad(round(ms,1)::text, 10) || '441 definer calls';

  -- 4. runs + assignments, windowed.
  t0 := clock_timestamp();
  PERFORM jsonb_agg(to_jsonb(r) ORDER BY r.timerange) FROM runs r
   WHERE r.node_id IN (SELECT id FROM nodes WHERE org_id = app_current_org() AND path <@ 'load_plant')
     AND r.timerange && v_win;
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('runs, aggregated', 44) || rpad(round(ms,1)::text, 10) || '5760 rows';

  t0 := clock_timestamp();
  PERFORM jsonb_agg(to_jsonb(a) ORDER BY a.timerange) FROM assignments a
   WHERE a.node_id IN (SELECT id FROM nodes WHERE org_id = app_current_org() AND path <@ 'load_plant')
     AND a.timerange && v_win;
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('assignments, aggregated', 44) || rpad(round(ms,1)::text, 10) || '5760 rows';

  -- 5. The operators block: a per-operator home-path helper plus two subselects.
  t0 := clock_timestamp();
  PERFORM count(*) FROM app_operator_homes('load_plant'::ltree);
  ms := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
  RAISE NOTICE '%', rpad('app_operator_homes', 44) || rpad(round(ms,1)::text, 10) || 'home paths';

  RESET ROLE;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE 'breakdown stopped: % (%)', SQLERRM, SQLSTATE;
END $$;
ROLLBACK;
