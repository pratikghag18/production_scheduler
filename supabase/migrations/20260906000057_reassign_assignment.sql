-- ============================================================================
-- 0057 --- CHANGE WHO IS ON AN ASSIGNMENT, WITHOUT DELETING IT (R-343, S37).
--
-- The maintainer, session 76: *"once you assign someone say Operator 1, there
-- is no way to modify that assignment to operator 2 unless you delete existing
-- assignment, this is not practical."*
--
-- ⭐⭐ WHY THIS IS A WRITER AND NOT A `PATCH`. The person column is the one
-- field on an assignment that every scheduling rule is about, and the client
-- already had a door onto the table: `updateAssignmentFields`
-- (src/lib/api/mutations.ts) is a plain PostgREST UPDATE. Adding
-- `operator_id` to that patch would have shipped the feature in one line ---
-- and skipped `check_eligibility` entirely, because **the eligibility check
-- lives in `create_assignment`, not in a trigger**. Two of the four rules a
-- new placement passes are table triggers and would have fired anyway; the
-- third is RLS; the fourth is not enforced anywhere but in the RPC:
--
--   edit rights on the cell   RLS  `assignments_update` -> app_can_edit_node
--   area scope (D113)         TRIGGER `assignments_scope_guard`
--   capacity (D2)             TRIGGER `assignments_capacity`
--   eligibility (0009/0050)   ⚠️ NOWHERE BUT `create_assignment`
--
-- So a PATCH would have let anyone move an uncertified person onto a cell that
-- requires the training, under a plant deliberately set to `block`, silently.
-- This function asks the same four questions `create_assignment` asks, in the
-- same order, with the same codes and the same detail payloads --- extracted
-- from the LAST definition of `create_assignment` (0030 s3), not retyped from
-- memory (CLAUDE.md section 4).
--
-- ----------------------------------------------------------------------------
-- ⭐ THE TWO TRIGGERS DO FIRE ON THIS UPDATE, AND THAT WAS CHECKED, NOT HOPED.
-- Their `CREATE TRIGGER` lines, read from the last file that emitted each:
--
--   0043: CREATE TRIGGER assignments_capacity
--         BEFORE INSERT OR UPDATE OF timerange, efficiency, operator_id
--   0028: create trigger assignments_scope_guard
--         before insert or update of node_id, operator_id, product_id
--
-- `operator_id` is in both column lists, so both fire on the statement below
-- and neither rule has to be restated here. If either had been INSERT-only,
-- this file would have had to mirror its check and would have said so; it did
-- not, and the SQL file measures both of them through this function anyway
-- (RA5 capacity, RA6/RA7 area) so a future edit to either trigger's column
-- list fails a case rather than opening a hole quietly.
--
-- `assignments_run_consistency` (0003) is `before insert or update of run_id,
-- node_id` and does NOT fire --- correctly: neither column moves here.
-- `assignments_audit` (0007) is `after insert or update or delete` and records
-- the whole before/after row, so who changed the person and when is kept.
--
-- ----------------------------------------------------------------------------
-- ⚠️ "THE OPERATOR MUST EXIST IN THIS ORG" IS ASKED OF THE FOREIGN KEY, NOT OF
-- A `SELECT ... FROM operators`. This function is SECURITY INVOKER, so an
-- `EXISTS` over that table is RLS-filtered and would answer "no such person"
-- for somebody the caller merely cannot LIST --- 78_copy_week_test.sql's CW22
-- pins exactly that shape (w1 cannot read Vera's row and must still be able to
-- copy her assignment; F-099). The table already carries
-- `foreign key (org_id, operator_id) references operators (org_id, id)`, which
-- is enforced by the system and sees every row, so an unknown id and an id
-- from another company are both refused there. The UPDATE is wrapped so that
-- refusal comes back as `invalid_argument` naming `p_operator_id` instead of a
-- bare 23503 the client cannot read --- the same courtesy 0030 does for the
-- area-override reason. `app_guard_assignment_scope` (0030) makes the same
-- deferral in words: *"a row that is not in this org at all is the foreign
-- key's business, not this trigger's."*
--
-- ----------------------------------------------------------------------------
-- ⚠️ NOTHING ELSE ON THE ROW MOVES. `run_id`, `product_id`, `node_id`,
-- `timerange`, `efficiency`, `target_qty` and `target_unit` are not in the SET
-- list, so a run-attached row stays attached to its run and a direct row keeps
-- its product. The two override columns DO move, because they describe the
-- placement being made now: a row overridden for the person who has just left
-- it is not overridden any more. RA9 reads every other column back before and
-- after and compares them.
--
-- ⚠️ AND THE ROW COUNT IS COMPARED. `assignments_update` is an RLS policy;
-- an UPDATE it filters out removes zero rows and raises nothing (CLAUDE.md
-- section 4). `app_can_edit_node` above already refuses that caller with
-- `not_permitted`, so a zero here means the two disagree --- which is worth an
-- error rather than a cheerful `null` assignment in the result.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reassign_assignment(
  p_assignment_id uuid,
  p_operator_id uuid,
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
  v_elig jsonb;
  v_use_override boolean;
  v_rows integer;
BEGIN
  IF p_assignment_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_assignment_id is required',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'null'));
  END IF;
  -- Reassigning to nobody is not a reassignment; a NULL operator is what D110
  -- leaves behind when a person is deleted, and Delete is the door to that.
  IF p_operator_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_operator_id is required',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'null'));
  END IF;
  -- D113, quoted from create_assignment (0030): refused HERE rather than by
  -- the table's CHECK, so the client gets `invalid_argument` naming the field
  -- instead of a bare 23514 it cannot read.
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  -- The row must exist AND be readable. RLS makes those one question here, and
  -- that is the right answer: a row the caller cannot see is not a row they may
  -- be told about.
  SELECT * INTO v_row FROM assignments WHERE id = p_assignment_id;
  IF v_row.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'assignment not found',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_row.node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node',
      jsonb_build_object('node_id', v_row.node_id));
  END IF;

  -- The same three arguments create_assignment asks with: the cell being
  -- staffed, the person, and the window the row already holds.
  v_elig := check_eligibility(v_row.node_id, p_operator_id, v_row.timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      -- block: no override is possible, regardless of p_eligibility_override.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', v_row.node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      -- warn, no override supplied: never silently allow it.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', v_row.node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF coalesce(btrim(p_override_reason), '') = '' THEN
      -- ⭐ THE HALF create_assignment LEAVES TO THE SCREEN, ASKED HERE. 0030
      -- takes the tick without a reason; D64's rule that an override carries a
      -- reason lives in CreatePopover, which is a courtesy and not a guard. A
      -- reassignment is the gesture a supervisor makes in a hurry, so the
      -- reason is required by the writer, in the same shape the area override
      -- already uses one line up.
      PERFORM api_raise('invalid_argument', 'an eligibility override must say why',
        jsonb_build_object('field', 'p_override_reason', 'reason', 'required when p_eligibility_override is true'));
    END IF;
  END IF;

  -- eligibility_override is only meaningful when it actually overrode a genuine
  -- ineligibility under warn policy (the branch above already refused to reach
  -- here otherwise). Quoted from create_assignment; the same normalisation, so
  -- the flag on a row means the same thing whichever writer set it.
  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  BEGIN
    UPDATE assignments SET
      operator_id          = p_operator_id,
      -- D110 (0029): a row whose person was deleted keeps only the remembered
      -- name, and assignments_operator_identified allows exactly one of the
      -- two. Re-staffing such a row identifies the person by id again, so the
      -- memory goes; without this line the writer failed with 23514 on every
      -- ghost row (the reviewer's first finding, session 77; RA12 pins it).
      operator_display_name = NULL,
      eligibility_override = v_use_override,
      override_reason      = CASE WHEN v_use_override THEN btrim(p_override_reason) ELSE NULL END,
      -- Sent as asked; app_guard_assignment_scope normalises it off if the row
      -- did not need it, which is why nothing here computes an area twin of
      -- v_use_override.
      area_override        = p_area_override,
      area_override_reason = CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END
    WHERE id = p_assignment_id
    RETURNING * INTO v_row;
    -- ⚠️ READ INSIDE THE BLOCK. `RETURNING ... INTO` leaves v_row holding the
    -- row SELECTed earlier when the UPDATE matched nothing, so v_row is not the
    -- witness; ROW_COUNT is, and it belongs to the statement immediately above
    -- it rather than to whatever a block boundary might count as.
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- See the header: the composite FK (org_id, operator_id) is what knows
    -- whether this person exists in this company, because it is not RLS-filtered
    -- and an `EXISTS` over `operators` from a SECURITY INVOKER function is.
    PERFORM api_raise('invalid_argument', 'operator not found',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'not found'));
  END;

  IF v_rows = 0 THEN
    -- An RLS-filtered UPDATE removes nothing and raises nothing (CLAUDE.md
    -- section 4). app_can_edit_node said yes above, so reaching this line means
    -- the policy and the helper disagree --- report it, never return success.
    PERFORM api_raise('not_permitted', 'the assignment was not written',
      jsonb_build_object('node_id', v_row.node_id, 'assignment_id', p_assignment_id));
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_row), 'eligibility', v_elig);
END;
$function$;

comment on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) is
  'R-343 / S37. Changes WHO is on an existing assignment and nothing else --- the cell, the window, the run or product, the efficiency and the target all stay. Asks every question create_assignment (0030) asks, with the same codes and details: the row must exist and be readable; app_can_edit_node on its node or not_permitted; check_eligibility on (node, new person, the row''s own window) with the plant''s policy (block refuses outright, warn refuses unless p_eligibility_override is set WITH a reason); the area rule and the capacity rule are the table triggers assignments_scope_guard and assignments_capacity, both of which list operator_id and therefore fire on this UPDATE. An unknown operator, or one from another company, is the composite foreign key''s refusal, translated to invalid_argument rather than a bare 23503, because an EXISTS over operators from a SECURITY INVOKER function answers what the CALLER can list rather than what is true (CW22 / F-099). ROW_COUNT is compared so an RLS-filtered write cannot report success. Returns {assignment, eligibility}, the same envelope create_assignment returns.';

revoke execute on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) from anon';
  end if;
end $$;
