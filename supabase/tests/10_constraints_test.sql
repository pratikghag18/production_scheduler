-- ============================================================================
-- 10_constraints_test.sql — acceptance items 1-7 (brief P1-2 §7)
-- Whole file runs as one transaction, rolled back at the end, so seed data
-- is untouched for later test files regardless of what this file mutates
-- (renames, re-parents, throwaway rows) or provokes (rejected inserts).
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- Seed reference constants (see supabase/seed.sql)
-- org:            10000000-0000-0000-0000-000000000001
-- node Plant 1:   30000000-0000-0000-0000-000000000001
-- node Assembly:  30000000-0000-0000-0000-000000000002
-- node Line 1:    30000000-0000-0000-0000-000000000004
-- node Line 2:    30000000-0000-0000-0000-000000000005
-- node Cell 1:    30000000-0000-0000-0000-000000000007
-- node Cell 2:    30000000-0000-0000-0000-000000000008
-- node Cell 3:    30000000-0000-0000-0000-000000000009
-- node Cell 6:    3000000a-0000-0000-0000-00000000000c
-- product WX:     60000000-0000-0000-0000-000000000001
-- operator Maria: 50000000-0000-0000-0000-000000000001
-- run r1 (Cell1): 80000000-0000-0000-0000-000000000001

\echo 'Case 1: slugify() produces valid ltree labels'
DO $$
BEGIN
  IF slugify('Cell 1') <> 'cell_1' THEN
    RAISE EXCEPTION 'FAIL: slugify(Cell 1) = %, expected cell_1', slugify('Cell 1');
  END IF;
  IF slugify('CNC Line') <> 'cnc_line' THEN
    RAISE EXCEPTION 'FAIL: slugify(CNC Line) = %, expected cnc_line', slugify('CNC Line');
  END IF;
  IF slugify('3 × 8h') <> 'n_3_8h' THEN
    RAISE EXCEPTION 'FAIL: slugify(3 x 8h) = %, expected n_3_8h', slugify('3 × 8h');
  END IF;
  IF slugify('  ') <> 'n_' THEN
    RAISE EXCEPTION 'FAIL: slugify(two spaces) = %, expected n_', slugify('  ');
  END IF;
  IF slugify('2nd Shift') <> 'n_2nd_shift' THEN
    RAISE EXCEPTION 'FAIL: slugify(2nd Shift) = %, expected n_2nd_shift', slugify('2nd Shift');
  END IF;
  -- every result must actually be a legal ltree label
  PERFORM slugify('Cell 1')::ltree, slugify('3 × 8h')::ltree, slugify('  ')::ltree, slugify('2nd Shift')::ltree;
END $$;

\echo 'Case 2a: path trigger produces expected paths on insert'
DO $$
BEGIN
  IF (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001')::text <> 'plant_1' THEN
    RAISE EXCEPTION 'FAIL: Plant 1 path wrong: %', (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001');
  END IF;
  IF (SELECT path FROM nodes WHERE id = '3000000a-0000-0000-0000-00000000000c')::text <> 'plant_1.machining.cnc_line.cell_6' THEN
    RAISE EXCEPTION 'FAIL: Cell 6 path wrong: %', (SELECT path FROM nodes WHERE id = '3000000a-0000-0000-0000-00000000000c');
  END IF;
END $$;

\echo 'Case 2b: renaming Line 1 -> Line One rewrites all three of its cells paths'
UPDATE nodes SET name = 'Line One' WHERE id = '30000000-0000-0000-0000-000000000004';
DO $$
DECLARE v_bad int;
BEGIN
  IF (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004')::text <> 'plant_1.assembly.line_one' THEN
    RAISE EXCEPTION 'FAIL: Line One path wrong: %', (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000004');
  END IF;
  SELECT count(*) INTO v_bad FROM nodes
    WHERE id IN ('30000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000008','30000000-0000-0000-0000-000000000009')
      AND path::text <> 'plant_1.assembly.line_one.' || regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL: % of Line One''s cells did not get their path rewritten', v_bad;
  END IF;
END $$;

\echo 'Case 2c: re-parenting Cell 3 to Line 2 updates its path'
UPDATE nodes SET parent_id = '30000000-0000-0000-0000-000000000005' WHERE id = '30000000-0000-0000-0000-000000000009';
DO $$
BEGIN
  IF (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000009')::text <> 'plant_1.assembly.line_2.cell_3' THEN
    RAISE EXCEPTION 'FAIL: re-parented Cell 3 path wrong: %', (SELECT path FROM nodes WHERE id = '30000000-0000-0000-0000-000000000009');
  END IF;
END $$;

\echo 'Case 3: a second schedulable level in the same TEMPLATE is rejected'
-- D86 moved this constraint from (org_id) to (template_id). The org-level
-- version of this case is now WRONG, not merely differently phrased: an org
-- with two site shapes must be able to schedule at Work Cell in one and at
-- Line in the other. Case 3b is the half that proves the constraint actually
-- moved rather than being dropped -- without it, deleting the partial index
-- entirely would still leave Case 3... failing, which is why 3 alone is not
-- enough and 3b alone is not enough either.
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO hierarchy_levels (org_id, template_id, position, name, is_schedulable)
    VALUES ('10000000-0000-0000-0000-000000000001',
            '21000000-0000-0000-0000-000000000001', 9, 'Extra Schedulable', true);
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: a second schedulable level in the same template was not rejected';
  END IF;
END $$;

\echo 'Case 3b: a second schedulable level in a DIFFERENT template is ACCEPTED'
DO $$
DECLARE v_tpl uuid;
BEGIN
  INSERT INTO hierarchy_templates (org_id, name)
  VALUES ('10000000-0000-0000-0000-000000000001', 'Case 3b Shape')
  RETURNING id INTO v_tpl;

  -- Same org, already holding a schedulable level in 'Standard Plant'.
  INSERT INTO hierarchy_levels (org_id, template_id, position, name, is_schedulable)
  VALUES ('10000000-0000-0000-0000-000000000001', v_tpl, 0, 'Site', false),
         ('10000000-0000-0000-0000-000000000001', v_tpl, 1, 'Line', true);

  IF (SELECT count(*) FROM hierarchy_levels
      WHERE org_id = '10000000-0000-0000-0000-000000000001' AND is_schedulable) <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 schedulable levels in this org, one per template';
  END IF;

  -- Positions repeat across templates too -- that is the point.
  IF (SELECT count(*) FROM hierarchy_levels
      WHERE org_id = '10000000-0000-0000-0000-000000000001' AND position = 0) <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected position 0 to exist twice in this org';
  END IF;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'FAIL: a second shape in the same org was rejected (D86 regression)';
END $$;

\echo 'Case 4a: assignment with both run_id and product_id is rejected'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, run_id, product_id, timerange)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-01-01T00:00:00+00', '2099-01-01T01:00:00+00'));
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: assignment with both run_id and product_id was not rejected';
  END IF;
END $$;

\echo 'Case 4b: assignment with neither run_id nor product_id is rejected'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, run_id, product_id, timerange)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000001', NULL, NULL,
            tstzrange('2099-01-01T00:00:00+00', '2099-01-01T01:00:00+00'));
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: assignment with neither run_id nor product_id was not rejected';
  END IF;
END $$;

\echo 'Case 5: assignment node_id differing from its run''s node_id is rejected'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    -- run 80000000...001 lives on Cell 1 (...007); point the assignment at Cell 2 instead.
    INSERT INTO assignments (org_id, node_id, operator_id, run_id, product_id, timerange)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008',
            '50000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', NULL,
            tstzrange('2099-01-01T00:00:00+00', '2099-01-01T01:00:00+00'));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%does not match run%' THEN
      v_caught := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: assignment.node_id mismatched with its run.node_id was not rejected';
  END IF;
END $$;

\echo 'Case 6: cross-tenant stitching rejected by the composite FK'
DO $$
DECLARE
  v_org_b uuid := gen_random_uuid();
  v_tpl_b uuid := gen_random_uuid();
  v_level_b uuid := gen_random_uuid();
  v_node_b uuid := gen_random_uuid();
  v_operator_b uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO orgs (id, name) VALUES (v_org_b, 'Throwaway Org B');
  INSERT INTO hierarchy_templates (id, org_id, name) VALUES (v_tpl_b, v_org_b, 'B Shape');
  INSERT INTO hierarchy_levels (id, org_id, template_id, position, name, is_schedulable)
    VALUES (v_level_b, v_org_b, v_tpl_b, 0, 'Cell', true);
  INSERT INTO nodes (id, org_id, level_id, parent_id, name)
    VALUES (v_node_b, v_org_b, v_level_b, NULL, 'B Cell 1');
  INSERT INTO operators (id, org_id, display_name)
    VALUES (v_operator_b, v_org_b, 'Org B Operator');

  BEGIN
    -- org A's node, org A's org_id, but an operator that only exists under org B.
    INSERT INTO assignments (org_id, node_id, operator_id, run_id, product_id, timerange)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007',
            v_operator_b, NULL, '60000000-0000-0000-0000-000000000001',
            tstzrange('2099-01-01T00:00:00+00', '2099-01-01T01:00:00+00'));
  EXCEPTION WHEN foreign_key_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: cross-tenant assignment (org A row referencing org B operator) was not rejected';
  END IF;
END $$;

\echo 'Case 7a: overlapping runs on the same cell are rejected'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    -- run r1 on Cell 1 is Tue 06:00-14:00 (seed_t(1,360)-seed_t(1,840)); overlap it.
    INSERT INTO runs (org_id, node_id, product_id, timerange)
    SELECT org_id, node_id, product_id, timerange
    FROM runs WHERE id = '80000000-0000-0000-0000-000000000001';
  EXCEPTION WHEN exclusion_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: overlapping run on the same cell was not rejected';
  END IF;
END $$;

\echo 'Case 7b: the same window on a different cell is accepted'
DO $$
DECLARE v_new_id uuid;
BEGIN
  INSERT INTO runs (org_id, node_id, product_id, timerange)
  SELECT org_id, '3000000a-0000-0000-0000-00000000000b', product_id, timerange
  FROM runs WHERE id = '80000000-0000-0000-0000-000000000001'
  RETURNING id INTO v_new_id;
  IF v_new_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: same window on a different cell should have been accepted';
  END IF;
END $$;

\echo 'Case 7c: an overlapping run with status=cancelled is accepted'
DO $$
DECLARE v_new_id uuid;
BEGIN
  INSERT INTO runs (org_id, node_id, product_id, timerange, status)
  SELECT org_id, node_id, product_id, timerange, 'cancelled'
  FROM runs WHERE id = '80000000-0000-0000-0000-000000000001'
  RETURNING id INTO v_new_id;
  IF v_new_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: overlapping cancelled run should have been accepted';
  END IF;
END $$;

\echo '10_constraints_test.sql: all cases passed'
ROLLBACK;
