-- Measure board_window as a REAL signed-in admin (so RLS is in the number),
-- at three scopes off one fixture: a line, a department, the whole plant.
\set ON_ERROR_STOP on
\timing off

-- a1 is org 1's company admin. Give them an admin grant on the load plant so
-- RLS admits the subtree; without this the read is empty and the timing is a lie.
INSERT INTO profile_grants (profile_id, node_id, org_id, role)
SELECT (SELECT id FROM user_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1'),
       n.id, n.org_id, 'admin'
FROM nodes n WHERE n.path = 'load_plant'
ON CONFLICT DO NOTHING;

ANALYZE nodes; ANALYZE runs; ANALYZE assignments; ANALYZE operators; ANALYZE profile_grants;

BEGIN;
DO $$
DECLARE
  v_from timestamptz := date_trunc('week', now()); -- the week the fixture seeds
  v_to   timestamptz := v_from + interval '7 days';
  -- ⚠️ THE REAL PATHS, READ OUT OF THE TABLE. A trigger derives `path` from the
  -- NAME ("Dept 1" -> `dept_1`), so the labels this fixture's INSERTs supplied
  -- were rewritten. The first run of this measurement used the supplied labels
  -- and quietly measured a subtree that DOES NOT EXIST: 0 nodes, 0 runs, and a
  -- flat ~90ms that looked like a fine answer for a line.
  v_paths text[] := ARRAY['load_plant.dept_1.line_1_1', 'load_plant.dept_1', 'load_plant', 'plant_1'];
  v_label text[] := ARRAY['a LINE (8 cells)', 'a DEPARTMENT (48 cells)', 'the PLANT (384 cells)', 'the SEED plant (4 cells)'];
  p text; i int; r int;
  -- ⛔ WITHOUT THESE THE MEASUREMENT IS A LIE. board_window is STABLE, not
  -- definer, so it runs as the caller: with no jwt sub, app_current_org() is
  -- NULL, every scoped_nodes row is filtered out, and the function returns an
  -- empty payload in ~1.4ms regardless of how much data is behind it. Measured
  -- exactly that on the first attempt -- four scopes, all "0 nodes, 0.3 KB",
  -- indistinguishable from each other. RLS has to be IN the number.
  t0 timestamptz; best numeric; cur numeric; total numeric;
  v_json jsonb; v_bytes int; v_nodes int; v_runs int; v_asg int; v_ops int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  SET LOCAL ROLE authenticated;

  RAISE NOTICE '%', rpad('scope', 26) || rpad('best ms', 10) || rpad('mean ms', 10)
    || rpad('nodes', 8) || rpad('runs', 8) || rpad('asg', 8) || rpad('ops', 7) || 'payload KB';
  RAISE NOTICE '%', repeat('-', 92);

  FOR i IN 1..array_length(v_paths, 1) LOOP
    p := v_paths[i];
    best := NULL; total := 0;
    -- Five runs: the first pays for cold caches and plan choice; report the
    -- BEST as the floor and the mean as what a person would feel.
    FOR r IN 1..5 LOOP
      t0 := clock_timestamp();
      v_json := board_window(p::ltree, v_from, v_to);
      cur := EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000;
      total := total + cur;
      IF best IS NULL OR cur < best THEN best := cur; END IF;
    END LOOP;
    v_bytes := octet_length(v_json::text);
    v_nodes := jsonb_array_length(v_json->'nodes');
    v_runs  := jsonb_array_length(v_json->'runs');
    v_asg   := jsonb_array_length(v_json->'assignments');
    v_ops   := jsonb_array_length(v_json->'operators');
    RAISE NOTICE '%', rpad(v_label[i], 26)
      || rpad(round(best, 1)::text, 10)
      || rpad(round(total / 5, 1)::text, 10)
      || rpad(v_nodes::text, 8) || rpad(v_runs::text, 8)
      || rpad(v_asg::text, 8) || rpad(v_ops::text, 7)
      || round(v_bytes / 1024.0, 1)::text;
  END LOOP;
  RESET ROLE;
END $$;
ROLLBACK;
