-- ============================================================================
-- 0070 --- A RESIZE ASKS THE SAME TWO QUESTIONS THE OTHER FOUR WRITERS ASK
-- (R-361), CLOSING THE LAST GAP IN R-357/R-338.
--
-- The maintainer, 8 Sept, asked directly: "The resize should get similar
-- warnings as other 4." Four writers (`create_assignment`, `move_run`,
-- `reassign_assignment`, `copy_week_plan`/`apply_copy_week`) ask
-- `check_eligibility` and `absence_overlap` under the plant's resolved
-- `eligibility_policy` before they write. The fifth way an assignment's
-- window changes -- a plain `PATCH /assignments?id=eq...` that sets
-- `timerange` (a drag on the block's EDGE, or a nudge to a new time in the
-- same cell, docs/api.md §4) -- asks neither. `assignments_capacity`,
-- `assignments_run_consistency` and `assignments_scope_guard` all already
-- fire on that UPDATE (measured with `pg_get_functiondef`, not assumed); not
-- one of them looks at the person.
--
-- ⭐ THE FIX IS A TRIGGER, NOT A FIFTH COPY OF THE RULE. A `BEFORE UPDATE`
-- trigger that calls the SAME two functions the four call cannot drift from
-- them -- there is nowhere else for the rule to live twice. It fires exactly
-- when `timerange` or `operator_id` actually CHANGES (`IS DISTINCT FROM`, not
-- a column-list trigger event, which would fire on a same-value reassignment
-- of the column too), so an efficiency-only PATCH (`apply_split_coverage`'s
-- dial-down, `saveAssignmentFields`) pays nothing extra -- confirmed by
-- reading both bodies: neither ever assigns `timerange` or `operator_id`.
--
-- ⚠️ A TRIGGER CAN REFUSE AND CANNOT WARN. Under `block` it raises the SAME
-- codes and DETAIL shape `create_assignment`/`reassign_assignment` already
-- raise (`not_eligible`, `absent`), so the client's existing parser
-- (`src/lib/api/errors.ts`) needs no change at all. Under `warn` it stays
-- completely silent -- the client runs its own mirrors (`absenceGaps`,
-- `certificateGaps`) around the write and toasts what the crew-drag success
-- toast already says (`useDragGesture.ts`).
--
-- ⚠️⚠️ THE HARDEST PART, WORKED OUT BEFORE WRITING A LINE: THE WRITERS' OWN
-- INTERNAL UPDATES NOW FIRE THIS TRIGGER TOO. `move_run` and
-- `reassign_assignment` both `UPDATE assignments SET timerange = ...` / `SET
-- operator_id = ...` on rows they have ALREADY asked `check_eligibility`/
-- `absence_overlap` about, under the policy they already resolved -- reading
-- their bodies with `pg_get_functiondef` (0066's last definitions) settles
-- exactly what happens next:
--
--   UNDER BLOCK: neither writer's own UPDATE is even reached unless the
--   pre-check already passed. `move_run`'s crew loop (before its `UPDATE
--   runs`) raises `not_eligible`/`absent` and rolls back the WHOLE move
--   before any assignment row is touched if any crew member fails;
--   `reassign_assignment` raises before its own `UPDATE` the same way. So by
--   the time this trigger re-asks the identical question, in the SAME
--   transaction, on the SAME (node, operator, window) the answer is
--   guaranteed to still be "eligible, not absent" -- a DOUBLE CHECK THAT
--   AGREES, not a double refusal. It costs two redundant function calls and
--   nothing else.
--
--   UNDER WARN: this trigger stays silent regardless of what
--   `check_eligibility`/`absence_overlap` answer (see above), so
--   `move_run`'s own override (`eligibility_override := true` on an
--   ineligible crew member, D113-style) and `reassign_assignment`'s
--   `p_eligibility_override`/absence-without-an-override-flag both still
--   land exactly as they do today. NOTHING a warn-policy override allows
--   today is refused by this trigger.
--
-- `copy_week_plan` is STABLE and writes nothing; its writer, `apply_copy_week`,
-- creates new rows through `create_assignment` (an INSERT, which this BEFORE
-- UPDATE trigger never sees) and removes prior ones with a plain `DELETE` or
-- `delete_run`. It never UPDATEs an assignment's `timerange` or `operator_id`.
-- So there are only TWO writers whose own UPDATE reaches this trigger
-- (`move_run`, `reassign_assignment`) -- checked by grepping every function
-- body in the live database for `update assignments`, not assumed from a
-- rounder count.
--
-- ⚠️⚠️⚠️ A SECOND HAZARD, FOUND THE SAME WAY AND NOT ASKED FOR, BUT THE SAME
-- KIND OF TRAP. `delete_owned_row('operator', ...)` (migration 0029/D110)
-- also `UPDATE`s `assignments SET operator_id = NULL, operator_display_name =
-- ...` on a departed person's PAST rows, to keep their history nameable. That
-- changes `operator_id` (a uuid to NULL is DISTINCT), so it would fire this
-- trigger too -- and `check_eligibility(node, NULL, window)` is NOT the same
-- question as "is this person eligible": with no operator, `held` is empty,
-- so any node carrying a skill requirement answers `eligible=false` for
-- EVERY departed person's history row on it, and under `block` this trigger
-- would have refused the very deletion D110 exists to allow, for exactly the
-- wrong reason. The guard is in the trigger's own `WHEN` clause below --
-- `NEW.operator_id IS NOT NULL` -- there is no person left to ask about once
-- the column is being cleared, so the trigger does not fire at all in that
-- case. Pinned by AB32 in `88_absences_test.sql`.
--
-- A RUN RESIZE IS NOT IN SCOPE -- CONFIRMED, NOT ASSUMED. `runs_crew_follows`
-- and `assignments_run_consistency` both guard `node_id` alone (read with
-- `pg_get_functiondef`), so changing a run's own `timerange` never writes an
-- assignment row's `timerange` -- nobody moves in time when a run resizes on
-- its own with no crew change. Only a write to the assignment's OWN
-- `timerange` (or `operator_id`) does, which is exactly what this trigger
-- watches.
-- ============================================================================

create or replace function app_guard_assignment_resize() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_elig jsonb;
  v_absence jsonb;
begin
  -- R-331: the SAME policy resolution `check_eligibility` itself performs
  -- (`app_resolve_node_setting(p_node_id, 'eligibility_policy')`, defaulted
  -- to 'warn') -- read off ITS OWN ANSWER rather than resolved a second way,
  -- so this can never drift from what the four writers already ask
  -- (CLAUDE.md §4, "extract, never retype"). `check_eligibility` guards the
  -- org boundary itself (`app_can_read_node`), exactly as it does for them.
  v_elig := check_eligibility(new.node_id, new.operator_id, new.timerange);

  if v_elig->>'policy' = 'block' then
    if not (v_elig->>'eligible')::boolean then
      perform api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'missing_skills', v_elig->'missing_skills',
                           'expiring_skills', v_elig->'expiring_skills',
                           'policy', v_elig->>'policy'));
    end if;

    -- `absence_overlap` is org-scoped and SECURITY DEFINER the same way, and
    -- is asked only once policy is known to be `block` -- a `warn` answer is
    -- never acted on in here at all (see header: the trigger stays silent).
    v_absence := absence_overlap(new.operator_id, new.timerange);
    if (v_absence->>'absent')::boolean then
      perform api_raise('absent',
        'operator is absent for this window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'absence', v_absence, 'policy', v_elig->>'policy'));
    end if;
  end if;

  -- warn: silent by design (header, R-361 decision 3). A trigger cannot
  -- return a warning; the client owns the sentence (useDragGesture.ts).
  return new;
end $$;

drop trigger if exists assignments_resize_guard on assignments;
create trigger assignments_resize_guard
  before update on assignments
  for each row
  when (
    new.operator_id is not null
    and (
      new.timerange is distinct from old.timerange
      or new.operator_id is distinct from old.operator_id
    )
  )
  execute function app_guard_assignment_resize();

comment on function app_guard_assignment_resize() is
  'R-361. BEFORE UPDATE trigger body for assignments_resize_guard: re-asks check_eligibility and absence_overlap, under the SAME resolved policy the four scheduler writers (create_assignment/move_run/reassign_assignment/apply_copy_week) already ask, whenever a plain UPDATE moves an assignment''s timerange or changes its operator_id. Under block it refuses with the same codes and DETAIL shape the four raise (not_eligible, absent); under warn it stays silent by construction (a trigger cannot return a warning) and the client (useDragGesture.ts) mirrors the same two questions to toast what the write allowed through. The trigger''s own WHEN clause fires only when NEW.operator_id IS NOT NULL: delete_owned_row (0029/D110) clears operator_id to NULL on a departed person''s history rows, and check_eligibility(node, NULL, window) answers false for any node carrying a skill requirement -- which would otherwise refuse that deletion under block for exactly the wrong reason (AB32).';
