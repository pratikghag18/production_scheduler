-- ============================================================================
-- 0080 --- MOVE A BLOCK TO ANOTHER CELL AND/OR ANOTHER SPAN, IN ONE WRITE
-- (S41-c / R-389).
--
-- "Move Sam on Cell 1 to Cell 2 in Line 1" moves Sam's block to another cell
-- with the same hours (or "... to Cell 2 from 10 to 3" with new ones). No
-- screen can do this today: a chip drag is same-row only (D66), and the only
-- cross-cell writer is move_run, for a whole job. move_assignment is the
-- single-block sibling: the block changes cell and hours, and the server
-- asks every question a new placement is asked -- permission on both cells,
-- training, absence and the area rule under the target's policy, capacity by
-- the existing trigger -- and detaches the block from its run on the way (a
-- run lives on one cell; on the new cell the block is direct with the run's
-- product, exactly as a detach drag does).
--
-- ⭐ WHY A NEW FUNCTION, NOT reassign_assignment WITH A NEW ARGUMENT. That
-- function changes WHO is on a row and asks nothing about WHERE it sits;
-- folding a node/timerange change into it would mean every caller of "change
-- the person" also has to reason about "and maybe the cell", the same
-- one-function-two-jobs shape D64's own writers deliberately avoid elsewhere.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). The body below is
-- reassign_assignment's last definition (0066, lines 539-646 of
-- 20260907000066_absences.sql) with its signature and DECLARE block replaced
-- (a new function necessarily has a new signature -- that piece could never
-- have been reassign_assignment's own) and every remaining guard line
-- substituted by exact-anchor string replacement, produced by
-- extract-0080-move-assignment.mjs with anchor-and-guard assertions -- see
-- that script for exactly what it checked before writing this file. New code
-- is marked "S41-c".
--
-- Order of the guards, and why each is where it is (brief docs/agent-briefs/
-- s41-c-move-brief.md section 3): argument checks; the row must exist;
-- permission on BOTH the source and target node (move_run's own wording --
-- someone who may edit only one side of a move learns nothing about the
-- other); the departed-person guard (D110 -- a ghost row has nobody to place
-- anywhere); eligibility and absence against the TARGET placement; the
-- effective product the row carries forward; the UPDATE, which sets
-- run_id = NULL unconditionally (a run lives on one cell, so leaving a run's
-- cell always detaches) and product_id to whichever part was effective
-- before the move, so a run-attached block keeps its part after becoming
-- direct. assignments_scope_guard (the area rule, D113) and
-- assignments_capacity fire on this UPDATE as on any other; assignments_
-- resize_guard (0070) re-asks eligibility and absence a second time, which
-- agrees, exactly as 0070's own header explains it does for the other
-- writers it wraps; assignments_run_consistency is satisfied because run_id
-- becomes NULL in the very same statement that changes node_id/timerange.
--
-- ⚠️ ONE PIECE OF reassign_assignment IS DELIBERATELY NOT CARRIED OVER: its
-- UPDATE sat inside a BEGIN ... EXCEPTION WHEN foreign_key_violation block,
-- there only to translate an unknown p_operator_id into a named
-- invalid_argument instead of a bare 23503 (that function's own UPDATE sets
-- operator_id, so a caller's bad person id could only fail there, at the
-- foreign key). move_assignment takes no operator argument at all -- the
-- person on the row never changes -- so there is no equivalent write that
-- could raise foreign_key_violation for a reason this function would need
-- to translate, and the wrapper is dropped rather than kept as dead
-- scaffolding around a different function's guard.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.move_assignment(
  p_assignment_id uuid,
  p_node_id uuid,
  p_timerange tstzrange,
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
  v_row assignments%ROWTYPE;
  v_operator uuid;    -- S41-c: the person the row belongs to
  v_product uuid;     -- S41-c: the effective part the row carries
  v_elig jsonb;
  v_absence jsonb;   -- R-357
  v_use_override boolean;
  v_rows integer;
BEGIN
  IF p_assignment_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_assignment_id is required',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'null'));
  END IF;
  IF p_node_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_node_id is required',
      jsonb_build_object('field', 'p_node_id', 'reason', 'null'));
  END IF;
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  SELECT * INTO v_row FROM assignments WHERE id = p_assignment_id;
  IF v_row.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'assignment not found',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_row.node_id) OR NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'edit rights required on both source and target node',
      jsonb_build_object('node_id', p_node_id));
  END IF;

  -- S41-c / D110: a departed person's row (operator_id NULL) has nobody to
  -- re-check eligibility, absence or area for -- there is no placement to
  -- move; the block stays exactly where it is.
  v_operator := v_row.operator_id;
  IF v_operator IS NULL THEN
    PERFORM api_raise('invalid_argument', 'a departed person''s block cannot be moved',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'operator is null'));
  END IF;

  v_elig := check_eligibility(p_node_id, v_operator, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF coalesce(btrim(p_override_reason), '') = '' THEN
      PERFORM api_raise('invalid_argument', 'an eligibility override must say why',
        jsonb_build_object('field', 'p_override_reason', 'reason', 'required when p_eligibility_override is true'));
    END IF;
  END IF;

  -- R-357: the absence question, the row's OWN window, same resolved policy.
  -- block -> refuse with `absent`; warn -> the new person takes the cell and the
  -- absence rides back in the payload. (An override is about certification, not
  -- absence, so it does not silence this; block is the only refusal.)
  v_absence := absence_overlap(v_operator, p_timerange);
  IF (v_absence->>'absent')::boolean AND v_elig->>'policy' = 'block' THEN
    PERFORM api_raise('absent',
      'operator is absent for this window under block policy',
      jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                          'absence', v_absence, 'policy', v_elig->>'policy'));
  END IF;

  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  -- S41-c: the effective part the row carries today -- its own for a direct
  -- block, its run's for a run-attached one (the same lookup the client's
  -- ContextAssignment.productId is built from, one step earlier).
  v_product := COALESCE(v_row.product_id, (SELECT product_id FROM runs WHERE id = v_row.run_id));
  IF v_row.run_id IS NOT NULL AND v_product IS NULL THEN
    PERFORM api_raise('invalid_argument', 'the run''s product is gone',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'no product to carry'));
  END IF;

  UPDATE assignments SET
    node_id               = p_node_id,
    timerange             = p_timerange,
    run_id                = NULL,
    product_id            = v_product,
    eligibility_override  = v_use_override,
    override_reason       = CASE WHEN v_use_override THEN btrim(p_override_reason) ELSE NULL END,
    area_override         = p_area_override,
    area_override_reason  = CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END
  WHERE id = p_assignment_id
  RETURNING * INTO v_row;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    PERFORM api_raise('not_permitted', 'the assignment was not written',
      jsonb_build_object('node_id', p_node_id, 'assignment_id', p_assignment_id));
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_row), 'eligibility', v_elig,
                            'absence', v_absence);   -- R-357
END;
$function$;

revoke execute on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) from anon';
  end if;
end $$;

comment on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) is
  'S41-c (docs/agent-briefs/s41-c-move-brief.md), assembled from reassign_assignment (0057, last redefined 0066): moves a block to a NEW cell and/or NEW hours in one write, detaching it from its run on the way (run_id set to NULL; a run-attached block carries its run''s product forward as a direct product_id). Asks every question a new placement asks, against the TARGET (p_node_id, p_timerange): permission on BOTH the source and target node, check_eligibility and absence_overlap against the target, the same override pair reassign_assignment takes. assignments_scope_guard and assignments_capacity fire on this UPDATE as on any; assignments_resize_guard (0070) re-asks eligibility and absence a second time, which agrees, as 0070''s own header explains for the other writers; assignments_run_consistency is satisfied because run_id becomes NULL. A departed person''s row (operator_id NULL) cannot be moved, and a run-attached row whose run''s product has been deleted is refused rather than moved with no product at all (both D110). ROW_COUNT is compared so an RLS-filtered write cannot report success.';
