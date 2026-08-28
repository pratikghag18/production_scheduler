-- ============================================================================
-- 30_shifts_test.sql — acceptance items 16-19 (brief P1-2 §7)
-- Whole file is one transaction, rolled back at the end.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- org: 10000000-0000-0000-0000-000000000001
-- node Cell 1: 30000000-0000-0000-0000-000000000007  (under Line 1 -> Assembly)
-- node Cell 6: 3000000a-0000-0000-0000-00000000000c  (under CNC Line -> Machining)
-- node Line 2: 30000000-0000-0000-0000-000000000005
-- template 3x8h: 70000000-0000-0000-0000-000000000001
-- template 2x10h: 70000000-0000-0000-0000-000000000002

\echo 'Case 16a: overnight shift (1320->1800) accepted'
DO $$
DECLARE v_tmpl uuid := gen_random_uuid();
BEGIN
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 16a', '30000000-0000-0000-0000-000000000001');
  INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
  VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, 'Overnight', 1320, 1800);
END $$;

\echo 'Case 16b: inverted shift (840->360) rejected'
DO $$
DECLARE
  v_tmpl uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 16b', '30000000-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
    VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, 'Inverted', 840, 360);
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: inverted shift (840->360) was not rejected';
  END IF;
END $$;

\echo 'Case 16c: 25-hour shift (0->1500) rejected'
DO $$
DECLARE
  v_tmpl uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 16c', '30000000-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
    VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, '25 Hours', 0, 1500);
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: 25-hour shift (0->1500) was not rejected';
  END IF;
END $$;

\echo 'Case 17a: overlapping shifts within one template rejected'
DO $$
DECLARE
  v_tmpl uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 17a', '30000000-0000-0000-0000-000000000001');
  INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
  VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, 'Shift A', 360, 840);
  BEGIN
    INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
    VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl, 'Shift B', 700, 1000);
  EXCEPTION WHEN exclusion_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: overlapping shifts within one template were not rejected';
  END IF;
END $$;

\echo 'Case 17b: the same times in a different template are accepted'
DO $$
DECLARE
  v_tmpl_a uuid := gen_random_uuid();
  v_tmpl_b uuid := gen_random_uuid();
BEGIN
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl_a, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 17b-A', '30000000-0000-0000-0000-000000000001');
  INSERT INTO shift_templates (id, org_id, name, site_node_id) VALUES (v_tmpl_b, '10000000-0000-0000-0000-000000000001', 'Test Tmpl 17b-B', '30000000-0000-0000-0000-000000000001');
  INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
  VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl_a, 'Shift A', 360, 840);
  -- identical times, different template -- must succeed
  INSERT INTO shifts (org_id, template_id, name, start_min, end_min)
  VALUES ('10000000-0000-0000-0000-000000000001', v_tmpl_b, 'Shift A', 360, 840);
END $$;

\echo 'Case 18a: resolve_shift_template(Cell 1) = 3x8h (inherited from Assembly, two levels up)'
DO $$
DECLARE v_resolved uuid;
BEGIN
  v_resolved := resolve_shift_template('30000000-0000-0000-0000-000000000007');
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 1) = %, expected 3x8h (70000000...0001)', v_resolved;
  END IF;
END $$;

\echo 'Case 18b: resolve_shift_template(Cell 6) = 2x10h (nearest ancestor CNC Line overrides)'
DO $$
DECLARE v_resolved uuid;
BEGIN
  v_resolved := resolve_shift_template('3000000a-0000-0000-0000-00000000000c');
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 6) = %, expected 2x10h (70000000...0002)', v_resolved;
  END IF;
END $$;

\echo 'Case 18c: re-pointing Line 2 to 2x10h flips Cells 4-5, leaves Cells 1-3 alone'
INSERT INTO node_shift_templates (node_id, org_id, template_id)
VALUES ('30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002');
DO $$
DECLARE v_resolved uuid;
BEGIN
  -- Cells 4 and 5 now resolve to 2x10h via the new Line 2 attachment.
  v_resolved := resolve_shift_template('3000000a-0000-0000-0000-00000000000a'); -- Cell 4
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 4) after Line 2 repoint = %, expected 2x10h', v_resolved;
  END IF;
  v_resolved := resolve_shift_template('3000000a-0000-0000-0000-00000000000b'); -- Cell 5
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 5) after Line 2 repoint = %, expected 2x10h', v_resolved;
  END IF;
  -- Cells 1-3 (under Line 1, untouched) still resolve to 3x8h via Assembly.
  v_resolved := resolve_shift_template('30000000-0000-0000-0000-000000000007'); -- Cell 1
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 1) after Line 2 repoint = %, expected 3x8h (unchanged)', v_resolved;
  END IF;
  v_resolved := resolve_shift_template('30000000-0000-0000-0000-000000000008'); -- Cell 2
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 2) after Line 2 repoint = %, expected 3x8h (unchanged)', v_resolved;
  END IF;
  v_resolved := resolve_shift_template('30000000-0000-0000-0000-000000000009'); -- Cell 3
  IF v_resolved IS DISTINCT FROM '70000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'FAIL: resolve_shift_template(Cell 3) after Line 2 repoint = %, expected 3x8h (unchanged)', v_resolved;
  END IF;
END $$;

\echo 'Case 19: effective skill requirements -- Cell 6 includes CNC via ancestor query (D11), Cell 1 is empty'
DO $$
DECLARE v_count int;
BEGIN
  -- effective requirements = union of node_skill_requirements along the node's ltree ancestor path (§6).
  SELECT count(*) INTO v_count
  FROM node_skill_requirements sr
  JOIN nodes anc ON anc.id = sr.node_id
  JOIN nodes target ON target.path <@ anc.path AND target.org_id = anc.org_id
  WHERE target.id = '3000000a-0000-0000-0000-00000000000c' -- Cell 6
    AND sr.skill_id = '40000000-0000-0000-0000-000000000001'; -- CNC
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: Cell 6 effective requirements do not include CNC (found % matching rows)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM node_skill_requirements sr
  JOIN nodes anc ON anc.id = sr.node_id
  JOIN nodes target ON target.path <@ anc.path AND target.org_id = anc.org_id
  WHERE target.id = '30000000-0000-0000-0000-000000000007'; -- Cell 1
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL: Cell 1 effective requirements should be empty, found % rows', v_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- §19.63 — THE CONSTRAINT NAME IS MIRRORED INTO THE CLIENT, SO IT IS PINNED.
--
-- `src/lib/api/errors.ts` reads the constraint name out of a 23P01 message to
-- tell two overlapping shifts apart from a lost race on `runs` -- both raise
-- the SAME SQLSTATE. That makes this identifier a contract, not an
-- implementation detail: rename it here without touching the client and
-- overlapping shifts silently start reporting "someone else changed this run
-- first".
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_constraint
   WHERE conname = 'shifts_no_overlap_within_template'
     AND conrelid = 'public.shifts'::regclass
     AND contype = 'x';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exclusion constraint shifts_no_overlap_within_template not found on shifts (found %)', v_count;
  END IF;

  -- And the run one still exists under its own name, because the client falls
  -- back to "lost race" for every OTHER exclusion constraint.
  SELECT count(*) INTO v_count FROM pg_constraint
   WHERE conname = 'runs_no_overlap_on_node'
     AND conrelid = 'public.runs'::regclass
     AND contype = 'x';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL: exclusion constraint runs_no_overlap_on_node not found on runs (found %)', v_count;
  END IF;
END $$;

\echo '30_shifts_test.sql: all cases passed'
ROLLBACK;
