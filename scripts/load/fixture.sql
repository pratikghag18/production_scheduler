-- Volume fixture for the load-sanity measurement. Scratch database only.
--
-- SHAPE: one plant, 8 departments x 6 lines x 8 work cells = 384 schedulable
-- cells, 420 operators, and one working week of runs and assignments. Built
-- under org 1 BESIDE the seed's own Plant 1 so nothing the SQL suite asserts
-- about that plant moves.
--
-- Sized so ONE seed answers the whole curve: board_window is then measured at a
-- line (8 cells), a department (48), and the plant (384) -- which is also the
-- real spread, since a line supervisor loads a line and a plant admin loads a
-- plant.
--
-- No skills are attached to these cells, so check_eligibility passes for anyone;
-- each operator takes at most one assignment per timeslot, so the capacity guard
-- passes too. The point is to measure the READ, not to re-test the guards.
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_org   uuid := '10000000-0000-0000-0000-000000000001';
  v_site  uuid := '20000000-0000-0000-0000-000000000000';
  v_dept  uuid := '20000000-0000-0000-0000-000000000001';
  v_line  uuid := '20000000-0000-0000-0000-000000000002';
  v_cell  uuid := '20000000-0000-0000-0000-000000000003';
  v_prod  uuid := '60000000-0000-0000-0000-000000000001';
  N_DEPT  int := 8;
  N_LINE  int := 6;
  N_CELL  int := 8;
  N_OPS   int := 420;
  N_DAYS  int := 5;
  N_SHIFT int := 3;
  v_plant uuid;
  v_d uuid; v_l uuid; v_c uuid;
  d int; l int; c int; i int; day int; sh int;
  v_start timestamptz;
  v_base  timestamptz := date_trunc('day', now()) + interval '7 days';
  v_ops uuid[];
  v_slot int;
BEGIN
  -- The plant.
  v_plant := gen_random_uuid();
  INSERT INTO nodes (id, org_id, level_id, parent_id, name, path, sort_order)
  VALUES (v_plant, v_org, v_site, NULL, 'Load Plant', 'load_plant', 100);

  FOR d IN 1..N_DEPT LOOP
    v_d := gen_random_uuid();
    INSERT INTO nodes (id, org_id, level_id, parent_id, name, path, sort_order)
    VALUES (v_d, v_org, v_dept, v_plant, 'Dept '||d, ('load_plant.d'||d)::ltree, d);

    FOR l IN 1..N_LINE LOOP
      v_l := gen_random_uuid();
      INSERT INTO nodes (id, org_id, level_id, parent_id, name, path, sort_order)
      VALUES (v_l, v_org, v_line, v_d, 'Line '||d||'-'||l, ('load_plant.d'||d||'.l'||l)::ltree, l);

      FOR c IN 1..N_CELL LOOP
        v_c := gen_random_uuid();
        INSERT INTO nodes (id, org_id, level_id, parent_id, name, path, sort_order)
        VALUES (v_c, v_org, v_cell, v_l, 'Cell '||d||'-'||l||'-'||c,
                ('load_plant.d'||d||'.l'||l||'.c'||c)::ltree, c);
      END LOOP;
    END LOOP;
  END LOOP;

  -- The people, homed at the plant root so every cell can use any of them.
  FOR i IN 1..N_OPS LOOP
    INSERT INTO operators (id, org_id, home_node_id, site_node_id, display_name, employee_ref, active)
    VALUES (gen_random_uuid(), v_org, v_plant, v_plant, 'Load Op '||i, 'LOAD-'||i, true);
  END LOOP;
  SELECT array_agg(id ORDER BY employee_ref) INTO v_ops
    FROM operators WHERE org_id = v_org AND employee_ref LIKE 'LOAD-%';

  -- The product has to be offered at this plant or the scope guard refuses the run.
  INSERT INTO product_sites (org_id, product_id, node_id)
  VALUES (v_org, v_prod, v_plant)
  ON CONFLICT DO NOTHING;

  -- A working week: N_SHIFT runs per cell per day, one person on each.
  v_slot := 0;
  FOR day IN 0..(N_DAYS - 1) LOOP
    FOR sh IN 0..(N_SHIFT - 1) LOOP
      v_start := v_base + (day || ' days')::interval + (sh * 8 || ' hours')::interval;
      v_slot := v_slot + 1;
      i := 0;
      FOR v_c IN
        SELECT n.id FROM nodes n
         WHERE n.org_id = v_org AND n.level_id = v_cell AND n.path <@ 'load_plant'
         ORDER BY n.path
      LOOP
        i := i + 1;
        DECLARE v_run uuid := gen_random_uuid();
        BEGIN
          INSERT INTO runs (id, org_id, node_id, product_id, timerange, planned_headcount)
          VALUES (v_run, v_org, v_c, v_prod,
                  tstzrange(v_start, v_start + interval '8 hours', '[)'), 1);
          -- One person per run, and a different person per cell within a slot,
          -- so the capacity guard has nothing to complain about.
          -- `assignments_work_identified`: exactly ONE of run_id / product_id /
          -- product_sku. A run-attached assignment names the RUN, not the part.
          INSERT INTO assignments (id, org_id, node_id, operator_id, run_id, timerange, efficiency)
          VALUES (gen_random_uuid(), v_org, v_c,
                  v_ops[1 + ((i + v_slot) % array_length(v_ops, 1))], v_run,
                  tstzrange(v_start, v_start + interval '8 hours', '[)'), 1.0);
        END;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

SELECT 'cells'       AS what, count(*) FROM nodes WHERE path <@ 'load_plant' AND level_id = '20000000-0000-0000-0000-000000000003'
UNION ALL SELECT 'nodes total', count(*) FROM nodes WHERE path <@ 'load_plant'
UNION ALL SELECT 'operators',   count(*) FROM operators WHERE employee_ref LIKE 'LOAD-%'
UNION ALL SELECT 'runs',        count(*) FROM runs r WHERE r.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant')
UNION ALL SELECT 'assignments', count(*) FROM assignments a WHERE a.node_id IN (SELECT id FROM nodes WHERE path <@ 'load_plant');
