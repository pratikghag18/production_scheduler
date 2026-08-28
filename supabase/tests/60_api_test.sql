-- ============================================================================
-- 60_api_test.sql — acceptance items 1-29 (brief P1-3a §8)
-- Whole file is one transaction, rolled back at the end. Personas are
-- switched with SET LOCAL ROLE + SET LOCAL "request.jwt.claim.sub", same
-- idiom as 40_rls_test.sql. Cases that must observe a raised error use
-- either a DO $$ ... EXCEPTION WHEN ... END $$ block (which is its own
-- implicit sub-transaction) or an explicit SAVEPOINT/ROLLBACK TO SAVEPOINT
-- around a bare top-level statement.
--
-- org: 10000000-0000-0000-0000-000000000001
-- Admin sub: 00000000-0000-0000-0000-0000000000a1  (root grant)
-- Ana sub:   00000000-0000-0000-0000-0000000000a2  (Assembly, can_edit)
-- Marco sub: 00000000-0000-0000-0000-0000000000a3  (Machining, can_edit)
-- Cells 1-5 (Assembly subtree): 30000000...007,008,009, 3000000a...00a,00b
-- Cells 6-7 (Machining subtree, CNC required): 3000000a...00c,00d
-- Maria (CNC): 50000000...0001  Raj (CNC): ...0002  Aisha (CNC): ...0003
-- Elena (no CNC, Assembly): ...0004   Tom: ...0005  Ben: ...0006
-- Lily: ...0007  Sam: ...0008  Noah: ...0009
-- skill CNC: 40000000-0000-0000-0000-000000000001
-- products WX/WY/GZ/RW: 60000000...0001/0002/0003/0004
-- runs r1..r8: 80000000...0001..0008 (r1 Tue Cell1 WX; r7 Wed Cell1 unstaffed)
--
-- ASSUMPTION (brief silent, §4 board_window): `node_skill_requirements` is
-- scoped to nodes under p_root_path (not the whole org) -- see the comment
-- in migration 0009 next to that key. In every case below p_root_path is
-- 'plant_1' (the whole tree), so this reads identically to an org-wide scope
-- and the choice is not independently exercised here.
--
-- ASSUMPTION (brief silent, §5 create_assignment): eligibility_override is
-- only ever stored `true` when it actually overrode a genuine ineligibility
-- under warn policy; passing p_eligibility_override=true while the operator
-- is already eligible is a no-op flag with no effect on the stored row.
--
-- ASSUMPTION (brief silent, §5 write functions generally): p_timerange
-- arguments to create_run / create_assignment / move_run are validated as
-- invalid_argument only when NULL or empty (isempty()); unboundedness is not
-- separately rejected (unlike board_window's p_from/p_to, which the brief
-- explicitly bounds to 92 days) since no acceptance item exercises it and
-- check_eligibility's own contract explicitly *relies on* an unbounded
-- upper bound being a legal input.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ============================================================================
-- board_window: items 1-5
-- ============================================================================

\echo 'Item 1: Admin over plant_1, seed week -> 7 cells, 8 runs, 12 assignments, node_shift_map correct'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  bw jsonb;
  v_t0 timestamptz := date_trunc('week', current_date)::timestamptz;
  v_cells int;
  v_38 int;
  v_210 int;
BEGIN
  bw := board_window('plant_1', v_t0, v_t0 + interval '7 days');

  SELECT count(*) INTO v_cells FROM jsonb_array_elements(bw->'nodes') n
    WHERE n->>'level_id' = '20000000-0000-0000-0000-000000000003';
  IF v_cells <> 7 THEN RAISE EXCEPTION 'FAIL: expected 7 cells, got %', v_cells; END IF;

  IF jsonb_array_length(bw->'runs') <> 8 THEN
    RAISE EXCEPTION 'FAIL: expected 8 runs, got %', jsonb_array_length(bw->'runs');
  END IF;
  IF jsonb_array_length(bw->'assignments') <> 12 THEN
    RAISE EXCEPTION 'FAIL: expected 12 assignments, got %', jsonb_array_length(bw->'assignments');
  END IF;

  SELECT count(*) INTO v_38 FROM jsonb_array_elements(bw->'node_shift_map') m
    JOIN jsonb_array_elements(bw->'nodes') n ON (n->>'id') = (m->>'node_id')
    WHERE n->>'level_id' = '20000000-0000-0000-0000-000000000003'
      AND m->>'template_id' = '70000000-0000-0000-0000-000000000001';
  IF v_38 <> 5 THEN RAISE EXCEPTION 'FAIL: expected 5 cells on 3x8h template, got %', v_38; END IF;

  SELECT count(*) INTO v_210 FROM jsonb_array_elements(bw->'node_shift_map') m
    JOIN jsonb_array_elements(bw->'nodes') n ON (n->>'id') = (m->>'node_id')
    WHERE n->>'level_id' = '20000000-0000-0000-0000-000000000003'
      AND m->>'template_id' = '70000000-0000-0000-0000-000000000002';
  IF v_210 <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 cells on 2x10h template, got %', v_210; END IF;
END $$;

\echo 'Item 2: as Ana, only Cells 1-5 and only Assembly runs/assignments -- RLS survives the function boundary'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE
  bw jsonb;
  v_t0 timestamptz := date_trunc('week', current_date)::timestamptz;
BEGIN
  bw := board_window('plant_1', v_t0, v_t0 + interval '7 days');
  IF jsonb_array_length(bw->'nodes') <> 8 THEN
    RAISE EXCEPTION 'FAIL: Ana should see 8 nodes (Assembly+2 lines+5 cells), got %', jsonb_array_length(bw->'nodes');
  END IF;
  IF jsonb_array_length(bw->'runs') <> 5 THEN
    RAISE EXCEPTION 'FAIL: Ana should see 5 Assembly runs, got %', jsonb_array_length(bw->'runs');
  END IF;
  IF jsonb_array_length(bw->'assignments') <> 9 THEN
    RAISE EXCEPTION 'FAIL: Ana should see 9 Assembly-side assignments, got %', jsonb_array_length(bw->'assignments');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(bw->'nodes') n
             WHERE n->>'id' IN ('3000000a-0000-0000-0000-00000000000c','3000000a-0000-0000-0000-00000000000d')) THEN
    RAISE EXCEPTION 'FAIL: Ana should not see Cells 6-7';
  END IF;
END $$;
RESET ROLE;

\echo 'Item 3: every key present and array-valued even when empty (2030 window)'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE bw jsonb; k text;
BEGIN
  bw := board_window('plant_1', '2030-01-01', '2030-01-08');
  IF bw->'runs' <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL: runs not empty array: %', bw->'runs'; END IF;
  IF bw->'assignments' <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL: assignments not empty array: %', bw->'assignments'; END IF;
  FOR k IN SELECT jsonb_object_keys(bw) LOOP
    IF k <> 'org' AND jsonb_typeof(bw->k) <> 'array' THEN
      RAISE EXCEPTION 'FAIL: key % is not array-valued (%), or is null', k, jsonb_typeof(bw->k);
    END IF;
  END LOOP;
END $$;
RESET ROLE;

\echo 'Item 4: guard rails -- from>=to, >92 days, and exactly 92 days'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean;
BEGIN
  v_caught := false;
  BEGIN
    PERFORM board_window('plant_1', '2026-01-08', '2026-01-01');
  EXCEPTION WHEN SQLSTATE 'PT400' THEN v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: p_from >= p_to not rejected'; END IF;

  v_caught := false;
  BEGIN
    PERFORM board_window('plant_1', '2026-01-01', '2026-01-01'::timestamptz + interval '100 days');
  EXCEPTION WHEN SQLSTATE 'PT400' THEN v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: 100-day window not rejected'; END IF;

  -- must NOT raise:
  PERFORM board_window('plant_1', '2026-01-01', '2026-01-01'::timestamptz + interval '92 days');
END $$;
RESET ROLE;

\echo 'Item 5: shift_templates nested shifts/breaks, overnight Shift 3 end_min 1800'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE bw jsonb; v_shift3 jsonb;
BEGIN
  bw := board_window('plant_1', date_trunc('week', current_date)::timestamptz,
                      date_trunc('week', current_date)::timestamptz + interval '7 days');
  SELECT s INTO v_shift3
  FROM jsonb_array_elements(bw->'shift_templates') t, jsonb_array_elements(t->'shifts') s
  WHERE s->>'name' = 'Shift 3';
  IF v_shift3 IS NULL THEN RAISE EXCEPTION 'FAIL: Shift 3 not found in shift_templates'; END IF;
  IF (v_shift3->>'end_min')::int <> 1800 THEN
    RAISE EXCEPTION 'FAIL: Shift 3 end_min is %, expected 1800', v_shift3->>'end_min';
  END IF;
  IF jsonb_array_length(v_shift3->'breaks') <> 3 THEN
    RAISE EXCEPTION 'FAIL: Shift 3 should have 3 nested breaks, got %', jsonb_array_length(v_shift3->'breaks');
  END IF;
END $$;
RESET ROLE;

-- ============================================================================
-- capacity_probe / operator_peak_load: items 6-9
-- ============================================================================

\echo 'Item 6: probe Aisha (seeded 0.5+0.5) for another 0.5 -> fits:false, peak 1.5, both overlaps listed'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_t0 timestamptz := date_trunc('week', current_date)::timestamptz + interval '1 day';
BEGIN
  v_res := capacity_probe('50000000-0000-0000-0000-000000000003',
    tstzrange(v_t0 + interval '360 minutes', v_t0 + interval '720 minutes'), 0.5, NULL);
  IF (v_res->>'fits')::boolean <> false THEN RAISE EXCEPTION 'FAIL: expected fits=false, got %', v_res; END IF;
  IF (v_res->>'peak')::numeric <> 1.500 THEN RAISE EXCEPTION 'FAIL: expected peak=1.5, got %', v_res; END IF;
  IF jsonb_array_length(v_res->'overlapping') <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 overlapping assignments, got %', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'overlapping') o WHERE o->>'node_name' = 'Cell 4')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'overlapping') o WHERE o->>'node_name' = 'Cell 5') THEN
    RAISE EXCEPTION 'FAIL: overlapping should denormalise node_name for Cell 4 and Cell 5: %', v_res;
  END IF;
END $$;

\echo 'Item 7: probe an adjacent (non-overlapping) window -> fits:true'
DO $$
DECLARE v_res jsonb; v_t0 timestamptz := date_trunc('week', current_date)::timestamptz + interval '1 day';
BEGIN
  -- Aisha's seeded pair ends at minute 720; probe starting exactly there (half-open, no overlap).
  v_res := capacity_probe('50000000-0000-0000-0000-000000000003',
    tstzrange(v_t0 + interval '720 minutes', v_t0 + interval '780 minutes'), 1.0, NULL);
  IF (v_res->>'fits')::boolean <> true THEN RAISE EXCEPTION 'FAIL: expected fits=true, got %', v_res; END IF;
  IF (v_res->>'peak')::numeric <> 1.000 THEN RAISE EXCEPTION 'FAIL: expected peak=1.0, got %', v_res; END IF;
END $$;

\echo 'Item 8: 60/60/40 through the probe -> peak exactly 1.0, fits true; 60/60/50 -> peak exactly 1.1, fits false'
DO $$
DECLARE v_op uuid := gen_random_uuid(); v_res jsonb;
BEGIN
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Probe Test Op 8', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-05-01 08:00+00','2099-05-01 10:00+00'), 0.600);
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-05-01 10:00+00','2099-05-01 12:00+00'), 0.600);

  v_res := capacity_probe(v_op, tstzrange('2099-05-01 09:00+00','2099-05-01 11:00+00'), 0.400, NULL);
  IF (v_res->>'peak')::numeric <> 1.000 THEN RAISE EXCEPTION 'FAIL: 60/60/40 peak should be exactly 1.0, got %', v_res; END IF;
  IF (v_res->>'fits')::boolean <> true THEN RAISE EXCEPTION 'FAIL: 60/60/40 should fit, got %', v_res; END IF;

  v_res := capacity_probe(v_op, tstzrange('2099-05-01 09:00+00','2099-05-01 11:00+00'), 0.500, NULL);
  IF (v_res->>'peak')::numeric <> 1.100 THEN RAISE EXCEPTION 'FAIL: 60/60/50 peak should be exactly 1.1, got %', v_res; END IF;
  IF (v_res->>'fits')::boolean <> false THEN RAISE EXCEPTION 'FAIL: 60/60/50 should not fit, got %', v_res; END IF;
END $$;

\echo 'Item 9 / §9: mutate operator_peak_load to always return 0, prove BOTH the trigger and the probe break, then restore'
-- This runs inside the same outer transaction as the rest of this file, so
-- the CREATE OR REPLACE below (and its restore immediately after) are both
-- ordinary DDL statements in that transaction -- nothing here needs restoring
-- on disk, and if this whole file is ever rolled back early, the mutation
-- rolls back with it. The mutation is applied to the LIVE function, never to
-- migration 0009 on disk.
--
-- RESET ROLE first: `authenticated` only has USAGE on schema public (not
-- CREATE), so CREATE OR REPLACE FUNCTION must run as the connecting
-- superuser. The request.jwt.claim.sub GUC set above is a session setting
-- independent of ROLE, so app_current_org()/auth.uid() still resolve
-- correctly for the DO blocks below even without re-asserting the
-- `authenticated` role.
RESET ROLE;
CREATE OR REPLACE FUNCTION operator_peak_load(
  p_operator_id uuid, p_timerange tstzrange, p_efficiency numeric, p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS numeric LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $mut$ SELECT 0::numeric; $mut$;

DO $$
DECLARE
  v_op uuid := gen_random_uuid();
  v_caught boolean := false;
  v_res jsonb;
BEGIN
  -- (a) the trigger: the same 100%+50% overlap that 20_capacity_test.sql
  -- case 8 exercises must now be silently ACCEPTED (mutation defeats it).
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Mutation Test Op 9', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-05-02 08:00+00','2099-05-02 10:00+00'), 1.000);
  BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
            '60000000-0000-0000-0000-000000000001', tstzrange('2099-05-02 09:00+00','2099-05-02 11:00+00'), 0.500);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF v_caught THEN
    RAISE EXCEPTION 'MUTATION DID NOT PROPAGATE: trigger still rejected the 1.5-peak case with operator_peak_load neutered -- 20_capacity_test.sql case 8 would NOT have caught this, which would mean the test is vacuous';
  END IF;
  RAISE NOTICE 'confirmed: with operator_peak_load neutered to 0, the capacity trigger (case-8 scenario) silently accepts a peak-1.5 overlap -- 20_capacity_test.sql case 8 fails under this mutation, exactly as required';

  -- (b) capacity_probe (this file's own item 8 case) must also now be wrong.
  v_res := capacity_probe(v_op, tstzrange('2099-05-02 08:30+00','2099-05-02 09:30+00'), 1.0, NULL);
  IF (v_res->>'peak')::numeric = 0 AND (v_res->>'fits')::boolean = true THEN
    RAISE NOTICE 'confirmed: capacity_probe (item 8) also reports peak=0/fits=true under the mutation (correct value would be 1.5/false) -- item 8 fails under this mutation, exactly as required';
  ELSE
    RAISE EXCEPTION 'MUTATION DID NOT PROPAGATE: capacity_probe still reported a sane peak (%) -- item 8 would NOT have caught this', v_res;
  END IF;
END $$;

-- Restore the real implementation (verbatim from migration 20260821000009_api_surface.sql).
CREATE OR REPLACE FUNCTION operator_peak_load(
  p_operator_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric,
  p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $restore$
  SELECT COALESCE(max(load), 0) FROM (
    SELECT (SELECT COALESCE(sum(a.efficiency), 0)
            FROM assignments a
            WHERE a.operator_id = p_operator_id
              AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
              AND a.status <> 'cancelled'
              AND a.timerange @> p.pt) + p_efficiency AS load
    FROM (
      SELECT lower(p_timerange) AS pt
      UNION
      SELECT lower(a.timerange) FROM assignments a
      WHERE a.operator_id = p_operator_id
        AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
        AND a.status <> 'cancelled'
        AND a.timerange && p_timerange
    ) p
    WHERE p_timerange @> p.pt
  ) q;
$restore$;

DO $$
DECLARE v_peak numeric;
BEGIN
  -- Re-run item 8's 60/60/50 case to confirm the restore is exact.
  v_peak := operator_peak_load(
    (SELECT operator_id FROM assignments WHERE node_id = '30000000-0000-0000-0000-000000000007'
       AND timerange = tstzrange('2099-05-01 08:00+00','2099-05-01 10:00+00') AND efficiency = 0.600 LIMIT 1),
    tstzrange('2099-05-01 09:00+00','2099-05-01 11:00+00'), 0.500, NULL);
  IF v_peak <> 1.100 THEN RAISE EXCEPTION 'FAIL: operator_peak_load restore incorrect, got %', v_peak; END IF;
  RAISE NOTICE 'operator_peak_load restored correctly (60/60/50 peak = 1.1 again)';
END $$;
RESET ROLE;

-- ============================================================================
-- check_eligibility: items 10-11
-- ============================================================================

\echo 'Item 10: Maria/Cell6 eligible; Elena/Cell6 missing CNC (inherited from CNC Line); Elena/Cell1 eligible'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v jsonb;
BEGIN
  v := check_eligibility('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000001', tstzrange('2099-01-01','2099-01-02'));
  IF (v->>'eligible')::boolean <> true THEN RAISE EXCEPTION 'FAIL: Maria/Cell6 should be eligible: %', v; END IF;

  v := check_eligibility('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000004', tstzrange('2099-01-01','2099-01-02'));
  IF (v->>'eligible')::boolean <> false THEN RAISE EXCEPTION 'FAIL: Elena/Cell6 should be ineligible: %', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'missing_skills') s WHERE s->>'name' = 'CNC') THEN
    RAISE EXCEPTION 'FAIL: Elena/Cell6 missing_skills should contain CNC: %', v;
  END IF;

  v := check_eligibility('30000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000004', tstzrange('2099-01-01','2099-01-02'));
  IF (v->>'eligible')::boolean <> true THEN RAISE EXCEPTION 'FAIL: Elena/Cell1 should be eligible: %', v; END IF;
END $$;

\echo 'Item 11: expiry checked against the assignment window, not now()'
DO $$
DECLARE v jsonb;
BEGIN
  UPDATE operator_skills SET expires_at = '2099-06-15'
    WHERE operator_id = '50000000-0000-0000-0000-000000000001' AND skill_id = '40000000-0000-0000-0000-000000000001';

  v := check_eligibility('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000001', tstzrange('2099-06-01','2099-07-01'));
  IF (v->>'eligible')::boolean <> false THEN RAISE EXCEPTION 'FAIL: Maria should be ineligible for a window crossing her expiry: %', v; END IF;
  IF jsonb_array_length(v->'expiring_skills') <> 1 THEN RAISE EXCEPTION 'FAIL: expiring_skills should have 1 entry: %', v; END IF;

  v := check_eligibility('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000001', tstzrange('2099-05-01','2099-06-01'));
  IF (v->>'eligible')::boolean <> true THEN RAISE EXCEPTION 'FAIL: Maria should be eligible for a window ending before her expiry: %', v; END IF;

  UPDATE operator_skills SET expires_at = NULL
    WHERE operator_id = '50000000-0000-0000-0000-000000000001' AND skill_id = '40000000-0000-0000-0000-000000000001';
END $$;
RESET ROLE;

-- ============================================================================
-- create_assignment / the eligibility gate: items 12-14
-- ============================================================================

\echo 'Item 12: warn policy, no override -> not_eligible; with override -> succeeds, flag + reason stored'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb; v_res jsonb;
BEGIN
  BEGIN
    PERFORM create_assignment('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000004',
      NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-01-01','2099-01-02'), 1.0, NULL, NULL, false, NULL);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: Elena/Cell6 without override should raise not_eligible'; END IF;
  IF (v_detail::jsonb)->>'error' <> 'not_eligible' OR (v_detail::jsonb)->>'policy' <> 'warn' THEN
    RAISE EXCEPTION 'FAIL: wrong error/policy in detail: %', v_detail;
  END IF;

  v_res := create_assignment('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000004',
    NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-01-01','2099-01-02'), 1.0, NULL, NULL, true, 'supervisor override');
  IF (v_res->'assignment'->>'eligibility_override')::boolean <> true THEN
    RAISE EXCEPTION 'FAIL: eligibility_override not stored true: %', v_res;
  END IF;
  IF (v_res->'assignment'->>'override_reason') <> 'supervisor override' THEN
    RAISE EXCEPTION 'FAIL: override_reason not stored: %', v_res;
  END IF;
END $$;

\echo 'Item 13: flip to block -- the same override attempt still fails'
DO $$ BEGIN
  UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"block"')
    WHERE id = '10000000-0000-0000-0000-000000000001';
END $$;
DO $$
DECLARE v_caught boolean := false; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM create_assignment('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000004',
      NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-01-01','2099-01-02'), 1.0, NULL, NULL, true, 'try override under block');
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: block policy should refuse override'; END IF;
  IF (v_detail::jsonb)->>'policy' <> 'block' THEN RAISE EXCEPTION 'FAIL: detail policy should read block: %', v_detail; END IF;
END $$;
DO $$ BEGIN
  UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"warn"')
    WHERE id = '10000000-0000-0000-0000-000000000001';
END $$;

\echo 'Item 14: capacity-exceeding create raises PT409 with a parsed DETAIL (error=capacity_exceeded, numeric peak)'
DO $$
DECLARE v_caught boolean := false; v_detail jsonb;
BEGIN
  INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
          '50000000-0000-0000-0000-000000000005','60000000-0000-0000-0000-000000000001',
          tstzrange('2099-02-05 08:00+00','2099-02-05 10:00+00'), 1.0);
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000005',
      NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-02-05 09:00+00','2099-02-05 11:00+00'), 0.5);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: capacity-exceeding create was not rejected'; END IF;
  IF (v_detail::jsonb)->>'error' <> 'capacity_exceeded' THEN RAISE EXCEPTION 'FAIL: wrong error code: %', v_detail; END IF;
  IF ((v_detail::jsonb)->>'peak')::numeric IS NULL THEN RAISE EXCEPTION 'FAIL: peak did not parse as numeric: %', v_detail; END IF;
END $$;
RESET ROLE;

-- ============================================================================
-- move_run: items 15-18
-- ============================================================================

\echo 'Item 15: move the Tuesday Cell 1 Widget X run (r1) to Cell 2'
-- DISCREPANCY (brief §8 item 15, literal reading): "the Tuesday Cell 1
-- Widget X run" is unambiguously r1 (80000000...0001), and its own
-- unmodified timerange is Tue 06:00-14:00. Cell 2 already carries r3
-- (80000000...0003), Tuesday, the SAME product, the EXACT SAME window
-- (Tue 06:00-14:00) -- both are seeded that way. Moving r1 onto Cell 2
-- without changing its time therefore always collides with r3 under D4 (the
-- runs_no_overlap_on_node invariant, brief §3.2's run_overlap path), which
-- move_run correctly rejects. This is a genuine inconsistency in the
-- brief's seed-data expectations, not a bug in move_run -- demonstrated
-- below, then the underlying capability (run + crew move, timerange
-- preserved by delta, consistency trigger sees the new node) is
-- demonstrated on a conflict-free target window instead.
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_caught boolean := false; v_detail jsonb;
BEGIN
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008',
      (SELECT timerange FROM runs WHERE id = '80000000-0000-0000-0000-000000000001'));
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_caught OR (v_detail::jsonb)->>'error' <> 'run_overlap' THEN
    RAISE EXCEPTION 'FAIL: expected run_overlap on the literal same-window Cell1->Cell2 move, got %', v_detail;
  END IF;
  RAISE WARNING 'DISCREPANCY (brief §8 item 15, literal reading): moving r1 to Cell 2 at its own unchanged window correctly raises run_overlap against the seeded r3, which occupies Cell 2 at that exact Tuesday window. The brief''s literal expectation ("moved to Cell 2") is inconsistent with the seed data it itself specifies; see the supplementary case immediately below for a conflict-free demonstration of the same capability.';
END $$;

DO $$
DECLARE v_res jsonb; v_new_start timestamptz; v_new_end timestamptz;
BEGIN
  v_new_start := date_trunc('week', current_date)::timestamptz + interval '3 days' + interval '360 minutes'; -- Thursday
  v_new_end   := date_trunc('week', current_date)::timestamptz + interval '3 days' + interval '840 minutes';
  v_res := move_run('80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000008',
    tstzrange(v_new_start, v_new_end));
  IF (v_res->'run'->>'node_id') <> '30000000-0000-0000-0000-000000000008' THEN
    RAISE EXCEPTION 'FAIL: run node not updated: %', v_res;
  END IF;
  IF jsonb_array_length(v_res->'assignments') <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 crew assignments moved: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'assignments') a
             WHERE a->>'node_id' <> '30000000-0000-0000-0000-000000000008') THEN
    RAISE EXCEPTION 'FAIL: not every crew assignment followed to Cell 2: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'assignments') a
             WHERE (a->>'timerange')::tstzrange <> tstzrange(v_new_start, v_new_end)) THEN
    RAISE EXCEPTION 'FAIL: crew timerange not shifted to match the run''s new window: %', v_res;
  END IF;
  IF v_res->'eligibility_warnings' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL: unexpected eligibility warnings moving within Assembly-side skill-free cells: %', v_res;
  END IF;
  -- assignments_check_run_consistency never fired a mismatch: the crew rows exist at all
  -- after the move, which requires the trigger to have seen the run's new node_id.
END $$;

\echo 'Item 16: move onto a cell with an overlapping run -> run_overlap, nothing changed'
DO $$
DECLARE v_caught boolean := false; v_node_before uuid;
BEGIN
  SELECT node_id INTO v_node_before FROM runs WHERE id = '80000000-0000-0000-0000-000000000007';
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000008',
      (SELECT timerange FROM runs WHERE id = '80000000-0000-0000-0000-000000000003'));
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: overlapping target run was not rejected'; END IF;
  IF (SELECT node_id FROM runs WHERE id = '80000000-0000-0000-0000-000000000007') <> v_node_before THEN
    RAISE EXCEPTION 'FAIL: run node changed despite the rejection';
  END IF;
END $$;
RESET ROLE;

\echo 'Item 17: as Ana, moving an Assembly run to a Machining cell -> not_permitted'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2';
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000007', '3000000a-0000-0000-0000-00000000000c',
      (SELECT timerange FROM runs WHERE id = '80000000-0000-0000-0000-000000000007'));
  EXCEPTION WHEN SQLSTATE 'PT403' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: Ana should not be able to move a run onto a Machining cell'; END IF;
END $$;
RESET ROLE;

\echo 'Item 18: warn -- crew lacking target skills moves anyway with warnings+overrides; block -- aborts, nothing changes'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_res jsonb; v_new_start timestamptz; v_new_end timestamptz;
BEGIN
  v_new_start := date_trunc('week', current_date)::timestamptz + interval '3 days' + interval '900 minutes';
  v_new_end   := date_trunc('week', current_date)::timestamptz + interval '3 days' + interval '1380 minutes';
  -- r1 (now on Cell 2 after item 15) has crew Elena+Tom, neither holds CNC.
  v_res := move_run('80000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000c',
    tstzrange(v_new_start, v_new_end));
  IF jsonb_array_length(v_res->'eligibility_warnings') <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 eligibility warnings under warn policy: %', v_res;
  END IF;
  IF (SELECT count(*) FROM assignments WHERE run_id = '80000000-0000-0000-0000-000000000001' AND eligibility_override) <> 2 THEN
    RAISE EXCEPTION 'FAIL: crew not marked eligibility_override under warn: %', v_res;
  END IF;
END $$;

DO $$ BEGIN
  UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"block"')
    WHERE id = '10000000-0000-0000-0000-000000000001';
END $$;
DO $$
DECLARE v_caught boolean := false; v_node_before uuid; v_new_start timestamptz; v_new_end timestamptz;
BEGIN
  SELECT node_id INTO v_node_before FROM runs WHERE id = '80000000-0000-0000-0000-000000000001';
  v_new_start := date_trunc('week', current_date)::timestamptz + interval '4 days' + interval '360 minutes'; -- Friday
  v_new_end   := date_trunc('week', current_date)::timestamptz + interval '4 days' + interval '840 minutes';
  BEGIN
    PERFORM move_run('80000000-0000-0000-0000-000000000001', '3000000a-0000-0000-0000-00000000000d',
      tstzrange(v_new_start, v_new_end));
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: block policy should abort a move with ineligible crew'; END IF;
  IF (SELECT node_id FROM runs WHERE id = '80000000-0000-0000-0000-000000000001') <> v_node_before THEN
    RAISE EXCEPTION 'FAIL: run changed despite block-policy rejection';
  END IF;
END $$;
DO $$ BEGIN
  UPDATE orgs SET settings = jsonb_set(settings, '{eligibility_policy}', '"warn"')
    WHERE id = '10000000-0000-0000-0000-000000000001';
END $$;
RESET ROLE;

-- ============================================================================
-- apply_split_coverage: items 19-22
-- ============================================================================

\echo 'Item 19: canonical split-coverage flow -- adjust existing to 0.5, insert new at 0.5, end peak exactly 1.0'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE v_op uuid := gen_random_uuid(); v_a1 uuid; v_res jsonb; v_peak numeric;
BEGIN
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Split Test Op 19', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (id, org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-01 08:00+00','2099-03-01 12:00+00'), 1.000)
  RETURNING id INTO v_a1;

  v_res := apply_split_coverage(
    jsonb_build_array(jsonb_build_object('assignment_id', v_a1, 'efficiency', 0.5)),
    jsonb_build_object('node_id','30000000-0000-0000-0000-000000000008','operator_id',v_op,
                        'product_id','60000000-0000-0000-0000-000000000001',
                        'timerange','[2099-03-01 08:00+00,2099-03-01 12:00+00)', 'efficiency', 0.5)
  );
  IF (v_res->'assignment') IS NULL OR (v_res->'assignment') = 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL: new assignment missing from result: %', v_res;
  END IF;
  v_peak := operator_peak_load(v_op, tstzrange('2099-03-01 08:00+00','2099-03-01 12:00+00'), 0.0, NULL);
  IF v_peak <> 1.000 THEN RAISE EXCEPTION 'FAIL: end-state peak should be exactly 1.0, got %', v_peak; END IF;
END $$;

\echo 'Item 20: prove the ordering matters -- insert-then-adjust fails (savepoint, PT409, rollback)'
DO $$
DECLARE v_op uuid := gen_random_uuid(); v_a1 uuid; v_caught boolean := false;
BEGIN
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Split Test Op 20', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (id, org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 08:00+00','2099-03-02 12:00+00'), 1.000)
  RETURNING id INTO v_a1;

  -- Same end state, attempted as insert-first: the new 0.5 lands while the
  -- existing row is still at 1.0, so the trigger sees peak 1.5 and rejects.
  BEGIN
    PERFORM create_assignment('30000000-0000-0000-0000-000000000008', v_op, NULL,
      '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-02 08:00+00','2099-03-02 12:00+00'), 0.5);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: insert-before-adjust should have raised capacity_exceeded (peak 1.5) but did not';
  END IF;
  RAISE NOTICE 'item20 OK: insert-before-adjust correctly raised PT409 (peak would be 1.5) -- proves apply_split_coverage''s adjust-then-insert ordering is load-bearing';
END $$;

\echo 'Item 21: malformed p_adjustments (missing efficiency) -> invalid_argument naming the field'
DO $$
DECLARE v_op uuid := gen_random_uuid(); v_a1 uuid; v_caught boolean := false; v_detail jsonb;
BEGIN
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Split Test Op 21', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (id, org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-03 08:00+00','2099-03-03 12:00+00'), 1.000)
  RETURNING id INTO v_a1;

  BEGIN
    PERFORM apply_split_coverage(jsonb_build_array(jsonb_build_object('assignment_id', v_a1)), NULL);
  EXCEPTION WHEN SQLSTATE 'PT400' THEN
    v_caught := true;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: missing efficiency was not rejected'; END IF;
  IF (v_detail::jsonb)->>'field' <> 'efficiency' THEN RAISE EXCEPTION 'FAIL: field not named efficiency: %', v_detail; END IF;
END $$;

\echo 'Item 22: p_new_assignment = null with valid adjustments -> pure rebalance succeeds'
DO $$
DECLARE v_op uuid := gen_random_uuid(); v_a1 uuid; v_res jsonb;
BEGIN
  INSERT INTO operators (id, org_id, display_name, site_node_id) VALUES (v_op, '10000000-0000-0000-0000-000000000001', 'Split Test Op 22', '30000000-0000-0000-0000-000000000001');
  INSERT INTO assignments (id, org_id, node_id, operator_id, product_id, timerange, efficiency)
  VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000007', v_op,
          '60000000-0000-0000-0000-000000000001', tstzrange('2099-03-04 08:00+00','2099-03-04 12:00+00'), 1.000)
  RETURNING id INTO v_a1;

  v_res := apply_split_coverage(jsonb_build_array(jsonb_build_object('assignment_id', v_a1, 'efficiency', 0.7)), NULL);
  IF v_res->'assignment' <> 'null'::jsonb THEN RAISE EXCEPTION 'FAIL: assignment should be null for a pure rebalance: %', v_res; END IF;
  IF jsonb_array_length(v_res->'adjusted') <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 adjusted row: %', v_res; END IF;
END $$;
RESET ROLE;

-- ============================================================================
-- delete_run: items 23-25
-- Run r4 (Cell3, staffed by a5 Lily + a6 Sam) is reused across items 23/24
-- via SAVEPOINT/ROLLBACK TO SAVEPOINT so each case starts from the same
-- fresh seeded state.
-- ============================================================================

\echo 'Item 23: cascade removes a staffed run and its crew'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
SAVEPOINT sp_delete_run;
DO $$
DECLARE v_count int;
BEGIN
  PERFORM delete_run('80000000-0000-0000-0000-000000000004', 'cascade');
  SELECT count(*) INTO v_count FROM runs WHERE id = '80000000-0000-0000-0000-000000000004';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL: run still exists after cascade delete'; END IF;
  SELECT count(*) INTO v_count FROM assignments WHERE run_id = '80000000-0000-0000-0000-000000000004';
  IF v_count <> 0 THEN RAISE EXCEPTION 'FAIL: crew still exists after cascade delete'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_delete_run;

\echo 'Item 24: detach converts crew to direct assignments carrying the run''s product'
DO $$
DECLARE v_res jsonb; v_count int;
BEGIN
  v_res := delete_run('80000000-0000-0000-0000-000000000004', 'detach');
  IF (SELECT count(*) FROM runs WHERE id = '80000000-0000-0000-0000-000000000004') <> 0 THEN
    RAISE EXCEPTION 'FAIL: run still exists after detach delete';
  END IF;
  SELECT count(*) INTO v_count FROM assignments
    WHERE id IN ('90000000-0000-0000-0000-000000000005','90000000-0000-0000-0000-000000000006')
      AND run_id IS NULL AND product_id = '60000000-0000-0000-0000-000000000003';
  IF v_count <> 2 THEN RAISE EXCEPTION 'FAIL: both crew assignments should be direct with the run''s product, got %: %', v_count, v_res; END IF;
  IF jsonb_array_length(v_res->'detached_assignment_ids') <> 2 THEN
    RAISE EXCEPTION 'FAIL: detached_assignment_ids should list both, got %', v_res;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_delete_run;

\echo 'Item 25: p_mode = ''wat'' -> invalid_argument'
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM delete_run('80000000-0000-0000-0000-000000000004', 'wat');
  EXCEPTION WHEN SQLSTATE 'PT400' THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: bad p_mode was not rejected'; END IF;
END $$;
ROLLBACK TO SAVEPOINT sp_delete_run;
RESET ROLE;

-- ============================================================================
-- Contract-wide: items 26-28
-- ============================================================================

\echo 'Item 26: every §4/§5 function (+operator_peak_load) is SECURITY INVOKER'
-- api_raise is the brief's one explicitly-permitted exception (§8 item 26)
-- and is therefore excluded from this scan rather than asserted either way;
-- the P1-2 audit trigger (write_audit_log) is the other named exception but
-- is untouched by this migration and outside its function set, so it is not
-- scanned here either -- see the ASSUMPTION note in migration 0009's header
-- and this file's own top-of-file assumptions for the full reasoning.
DO $$
DECLARE v_bad text[];
BEGIN
  SELECT COALESCE(array_agg(p.proname ORDER BY p.proname), ARRAY[]::text[]) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    -- ⚠️ `check_eligibility` LEFT THIS LIST IN 0026 (D107), and loosening a
    -- guard is exactly the mutation shape that makes a check less demanding
    -- rather than wrong — so it is not simply removed. It became SECURITY
    -- DEFINER because as an INVOKER it answered from what the CALLER could
    -- LIST rather than from what is true: measured on a seeded database, the
    -- same cell and the same person got `eligible=false` from a company admin
    -- and `eligible=true` from a supervisor whose grant sat below the node
    -- carrying the requirement. A safety check that failed open.
    -- The property this exemption costs is asserted directly instead, in
    -- `53_read_scoping_test.sql`: R14 pins that it REFUSES (PT403) a node the
    -- caller cannot read, which is what INVOKER was buying here. The other
    -- eight stay INVOKER and stay asserted; they all WRITE, and RLS must
    -- govern those writes.
    AND p.proname IN ('board_window','capacity_probe','create_run',
                       'create_assignment','move_run','apply_split_coverage','delete_run',
                       'operator_peak_load')
    AND p.prosecdef = true;
  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: SECURITY DEFINER found on non-exempt function(s): %', v_bad;
  END IF;
END $$;

\echo 'Item 27: as anon, every §4/§5 function raises permission-denied'
SET LOCAL ROLE anon;
DO $$
DECLARE v_caught boolean;
BEGIN
  v_caught := false;
  BEGIN PERFORM board_window('plant_1','2026-01-01','2026-01-08');
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call board_window'; END IF;

  v_caught := false;
  BEGIN PERFORM capacity_probe('50000000-0000-0000-0000-000000000001', tstzrange('2026-01-01','2026-01-02'), 1.0, NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call capacity_probe'; END IF;

  v_caught := false;
  BEGIN PERFORM check_eligibility('30000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000001', tstzrange('2026-01-01','2026-01-02'));
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call check_eligibility'; END IF;

  v_caught := false;
  BEGIN PERFORM create_run('30000000-0000-0000-0000-000000000007','60000000-0000-0000-0000-000000000001', tstzrange('2026-01-01','2026-01-02'));
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call create_run'; END IF;

  v_caught := false;
  BEGIN PERFORM create_assignment('30000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000001', NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2026-01-01','2026-01-02'));
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call create_assignment'; END IF;

  v_caught := false;
  BEGIN PERFORM move_run('80000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000008', tstzrange('2026-01-01','2026-01-02'));
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call move_run'; END IF;

  v_caught := false;
  BEGIN PERFORM apply_split_coverage('[]'::jsonb, NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call apply_split_coverage'; END IF;

  v_caught := false;
  BEGIN PERFORM delete_run('80000000-0000-0000-0000-000000000001', 'cascade');
  EXCEPTION WHEN insufficient_privilege THEN v_caught := true; END;
  IF NOT v_caught THEN RAISE EXCEPTION 'FAIL: anon could call delete_run'; END IF;
END $$;
RESET ROLE;

\echo 'Item 28: every raise from §3.2/§5 produces a DETAIL parsing as JSON with an error key from the closed set (iterate, do not spot-check)'
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';
DO $$
DECLARE
  v_expected text[] := ARRAY['capacity_exceeded','not_eligible','run_overlap','run_node_mismatch','not_permitted','invalid_argument'];
  v_seen text[] := ARRAY[]::text[];
  v_detail jsonb;
  v_run_id uuid;
  v_missing text[];
BEGIN
  -- capacity_exceeded
  DECLARE v_caught boolean := false; BEGIN
    INSERT INTO assignments (org_id, node_id, operator_id, product_id, timerange, efficiency)
    VALUES ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000007',
            '50000000-0000-0000-0000-000000000006','60000000-0000-0000-0000-000000000001',
            tstzrange('2099-06-01 08:00+00','2099-06-01 10:00+00'), 1.0);
    BEGIN
      PERFORM create_assignment('30000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000006',
        NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-06-01 09:00+00','2099-06-01 11:00+00'), 0.5);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'capacity_exceeded'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'capacity_exceeded'); END IF;
  END;

  -- not_eligible
  DECLARE v_caught boolean := false; BEGIN
    BEGIN
      PERFORM create_assignment('3000000a-0000-0000-0000-00000000000c','50000000-0000-0000-0000-000000000007',
        NULL, '60000000-0000-0000-0000-000000000001', tstzrange('2099-06-02','2099-06-03'), 1.0);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'not_eligible'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'not_eligible'); END IF;
  END;

  -- run_overlap
  DECLARE v_caught boolean := false; BEGIN
    BEGIN
      PERFORM create_run('30000000-0000-0000-0000-000000000007','60000000-0000-0000-0000-000000000001',
        (SELECT timerange FROM runs WHERE id = '80000000-0000-0000-0000-000000000007'));
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'run_overlap'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'run_overlap'); END IF;
  END;

  -- run_node_mismatch (via the trigger, reached through create_assignment with a
  -- p_node_id that does not match the given run's own node_id)
  DECLARE v_caught boolean := false; BEGIN
    v_run_id := (create_run('30000000-0000-0000-0000-000000000009','60000000-0000-0000-0000-000000000001',
      tstzrange('2099-06-04 08:00+00','2099-06-04 10:00+00'))->'run'->>'id')::uuid;
    BEGIN
      PERFORM create_assignment('30000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000006',
        v_run_id, NULL, tstzrange('2099-06-04 08:00+00','2099-06-04 10:00+00'), 1.0);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'run_node_mismatch'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'run_node_mismatch'); END IF;
  END;

  -- not_permitted
  DECLARE v_caught boolean := false; BEGIN
    BEGIN
      PERFORM create_run('3000000a-0000-0000-0000-00000000000c','60000000-0000-0000-0000-000000000001',
        tstzrange('2099-06-05','2099-06-06'));
    EXCEPTION WHEN SQLSTATE 'PT403' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
  END;
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a2'; -- Ana, no rights on Cell 6
  DECLARE v_caught boolean := false; BEGIN
    BEGIN
      PERFORM create_run('3000000a-0000-0000-0000-00000000000c','60000000-0000-0000-0000-000000000001',
        tstzrange('2099-06-05','2099-06-06'));
    EXCEPTION WHEN SQLSTATE 'PT403' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'not_permitted'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'not_permitted'); END IF;
  END;
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000000a1';

  -- invalid_argument
  DECLARE v_caught boolean := false; BEGIN
    BEGIN
      PERFORM delete_run('80000000-0000-0000-0000-000000000001', 'wat');
    EXCEPTION WHEN SQLSTATE 'PT400' THEN v_caught := true; GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL; END;
    IF v_caught AND (v_detail::jsonb)->>'error' = 'invalid_argument'
       AND jsonb_typeof(v_detail::jsonb) = 'object' THEN v_seen := array_append(v_seen, 'invalid_argument'); END IF;
  END;

  SELECT array_agg(e) INTO v_missing FROM unnest(v_expected) e WHERE NOT (e = ANY(v_seen));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: did not observe a parsed, closed-set DETAIL for: %', v_missing;
  END IF;
  RAISE NOTICE 'item28 OK: observed all % error codes with valid parsed DETAIL: %', array_length(v_expected,1), v_seen;
END $$;
RESET ROLE;

\echo '60_api_test.sql: all cases passed (see NOTICE/WARNING above for item 9 and item 15 detail)'
ROLLBACK;
