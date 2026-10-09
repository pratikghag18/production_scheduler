-- ============================================================================
-- 0079 --- A BLOCK THAT JOINS A RUN LIES INSIDE IT, OR THE SERVER REFUSES
-- (F-131 / R-383).
--
-- The command bar (S40) is the first screen that can ask the server to make a
-- NEW block inside a job (create_assignment with p_run_id). The server's run
-- branch already checks training, absence and the person's area for that row,
-- but nothing on the server checked that the block's hours lie INSIDE the job
-- it joins. The bar only offers "join" when containment holds
-- (assignmentFitsRun), so today reaching the gap needs a refetch race or a
-- shift chip moving the span after the join question was answered -- a
-- narrow gap, but the rule belongs on the server: a block that joins a job
-- lies inside that job's hours, or the server refuses with a named reason.
--
-- ⭐ THE FIX IS IN THE FUNCTION, NOT A TRIGGER. Considered and rejected: a
-- containment trigger on assignments. A run can legitimately be shrunk with
-- its crew left outside it (the run-resize path asks "N crew assignments
-- fall outside the new run window. Continue?" and proceeds), so "inside its
-- run" is NOT an invariant of the table today and a trigger would refuse
-- states the product allows. (apply_copy_week, read in its last definition
-- in 0067: it re-creates a run's crew through create_assignment with the SAME
-- shift delta applied to both the run and its assignments, so a copy that fit
-- its source run still fits its copied run -- this migration does not change
-- that path's behaviour.) The rule is about the moment of JOINING, and the
-- one server path that joins a new block is create_assignment's run branch.
-- Put it there.
--
-- Order of the guards: after app_can_edit_node (someone with no edit rights
-- learns nothing about runs) and BEFORE check_eligibility. The run is read
-- once into a runs%ROWTYPE variable.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). create_assignment is
-- byte-for-byte 0066's last definition (lines 439-536 of
-- 20260907000066_absences.sql) plus exactly one DECLARE line and one guard
-- block, produced by extract-0079.mjs with anchor assertions -- see that
-- script for the guard strings it checked before writing this file. New code
-- is marked "-- F-131". api_raise already raises SQLSTATE PT409 for any code
-- other than invalid_argument/not_permitted (confirmed in 0009's own
-- definition), and the new detail is merged into the envelope the same way
-- every other code's is.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_assignment(
  p_node_id uuid,
  p_operator_id uuid,
  p_run_id uuid,
  p_product_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric DEFAULT 1.000,
  p_target_qty numeric DEFAULT NULL,
  p_target_unit text DEFAULT NULL,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_elig jsonb;
  v_absence jsonb;   -- R-357
  v_run runs%ROWTYPE;   -- F-131
  v_assignment assignments%ROWTYPE;
  v_use_override boolean;
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF num_nonnulls(p_run_id, p_product_id) <> 1 THEN
    PERFORM api_raise('invalid_argument', 'exactly one of p_run_id / p_product_id must be set',
      jsonb_build_object('field', 'p_run_id/p_product_id', 'reason', 'must set exactly one'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  IF NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', p_node_id));
  END IF;

  -- F-131 / R-383 (session 144): a block that joins a run lies inside it. The
  -- client decides "join" by the same containment (assignmentFitsRun); the
  -- server holds the same test so a refetch race or a shift chip moved after
  -- the question cannot land a block outside the job it names.
  IF p_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM runs WHERE id = p_run_id;
    IF NOT FOUND THEN
      PERFORM api_raise('invalid_argument', 'no such run',
        jsonb_build_object('field', 'p_run_id', 'reason', 'no such run'));
    END IF;
    IF NOT (v_run.timerange @> p_timerange) THEN
      PERFORM api_raise('outside_run',
        'a block that joins a run must lie inside the run''s window',
        jsonb_build_object('run_id', p_run_id, 'node_id', p_node_id,
                            'run_timerange', v_run.timerange::text,
                            'timerange', p_timerange::text));
    END IF;
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  v_elig := check_eligibility(p_node_id, p_operator_id, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    END IF;
  END IF;

  -- R-357: the absence question, beside eligibility and under the SAME resolved
  -- policy. block -> refuse with `absent`; warn -> the absence rides back in the
  -- payload as a warning and the placement is taken (the screen showed it first).
  v_absence := absence_overlap(p_operator_id, p_timerange);
  IF (v_absence->>'absent')::boolean AND v_elig->>'policy' = 'block' THEN
    PERFORM api_raise('absent',
      'operator is absent for this window under block policy',
      jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                          'absence', v_absence, 'policy', v_elig->>'policy'));
  END IF;

  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  INSERT INTO assignments (
    org_id, node_id, operator_id, run_id, product_id, timerange, efficiency,
    target_qty, target_unit, eligibility_override, override_reason,
    area_override, area_override_reason, created_by
  ) VALUES (
    v_org_id, p_node_id, p_operator_id, p_run_id, p_product_id, p_timerange, p_efficiency,
    p_target_qty, p_target_unit,
    v_use_override, CASE WHEN v_use_override THEN p_override_reason ELSE NULL END,
    p_area_override, CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END,
    auth.uid()
  )
  RETURNING * INTO v_assignment;

  -- R-357: `absence` joins the envelope so a warn placement carries its warning.
  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'eligibility', v_elig,
                            'absence', v_absence);
END;
$function$;

comment on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) is
  'Unchanged from 0066 apart from F-131: after the app_can_edit_node gate and before check_eligibility, a run-attached join reads the run once and refuses outside_run unless its timerange lies inside the run''s (@> is inclusive of equality). A direct (product-attached) block is untouched. Everything else is exactly 0066''s create_assignment.';
