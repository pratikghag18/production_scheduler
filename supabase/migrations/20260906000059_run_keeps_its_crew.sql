-- ============================================================================
-- 0059 --- A RUN CANNOT WALK AWAY FROM ITS CREW (DEF-0014, R-037).
--
-- THE DEFECT. `assignments_run_consistency` (0003, re-emitted 0009) sits on the
-- CREW side: it refuses a crew row whose node_id disagrees with its run's
-- node_id. Nothing sat on the RUN side. So a plain `UPDATE runs SET node_id`
-- --- a bare `PATCH /rest/v1/runs?id=eq.<run>` over one's own session ---
-- moved the run to another cell and left every crew row pointing at the old
-- one. The invariant was one-sided: the table took what `move_run` refuses.
--
-- MEASURED at tip f75a65e, as Dana (site admin of Plant A), in a rolled-back
-- transaction (DEF-0014 Reproduction):
--
--   raw UPDATE runs.node_id as Dana: rows=1
--   after: run on plant_a.area_2.line_3.cell_5 ; crew on plant_a.area_1.line_1.cell_1
--
-- One row updated, no error, and a person attached to a run that is no longer
-- where they are.
--
-- THE RULE. R-037 (from §15.2, D4): "A run moves to another cell like any
-- block ... the crew moves with it, every crew member is re-checked for
-- eligibility ...". R-345's note in the plan, in the developer's words: "the
-- table should refuse what move_run would refuse."
--
-- ----------------------------------------------------------------------------
-- WHY A DEFERRED CONSTRAINT TRIGGER, AND NOT A PLAIN BEFORE TRIGGER.
--
-- `move_run` (0050) is the legitimate mover, and it does the move in TWO steps
-- inside ONE transaction: it updates the run row FIRST (node_id -> target) and
-- THEN loops over every assignment with that run_id and moves each to the same
-- target (0050 lines 683-718; the loop is `SELECT * FROM assignments WHERE
-- run_id = p_run_id` --- ALL crew rows, no status filter, so no crew row is
-- left behind by design). A plain BEFORE/AFTER trigger on the run's UPDATE
-- would fire BETWEEN those two steps, see the crew still on the old cell, and
-- refuse move_run itself --- exactly the thing that must keep working.
--
-- So the guard is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED: it fires
-- at COMMIT, not at statement time. By commit, move_run has moved the run AND
-- all its crew, so the check finds nothing stranded and passes. A bare PATCH
-- over PostgREST is its OWN transaction --- it moves the run and nothing else,
-- so at that transaction's commit the crew is still on the old cell and the
-- whole transaction is rolled back. The run stays where it was.
--
-- This mirrors, on the run side, the shape the crew side already has: refuse
-- rather than repair, the way `assignments_check_run_consistency` refuses a
-- crew row that disagrees with its run.
--
-- ----------------------------------------------------------------------------
-- WHY SECURITY DEFINER. The function reads `assignments` to find stranded crew.
-- If it ran as the invoker, an RLS-filtered read could HIDE a stranded row from
-- the guard and let a bad move through --- the guard would fail OPEN. Like
-- `app_guard_assignment_scope` (0058), it is SECURITY DEFINER with a pinned
-- search_path so it sees every crew row and fails CLOSED. `is distinct from`
-- (not `<>`) so a NULL node compares as a mismatch rather than to NULL.
--
-- The refusal uses `api_raise` in the neighbouring guards' shape: error
-- `run_node_mismatch` (the crew-side twin's own code, PT409 via api_raise's
-- ELSE), with a detail `reason` of 'run_moved_without_crew' naming the run, the
-- node it moved to, and every stranded crew row.
--
-- No signature or grant changes: a trigger function needs no EXECUTE grant, and
-- `db:types` is unaffected (no RPC, no column, no view touched).
-- ============================================================================

create or replace function public.runs_check_crew_follows() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_stranded jsonb;
begin
  -- Every crew row of this run whose cell disagrees with the run's cell, read
  -- as the definer so RLS cannot hide a stranded row from the guard.
  select coalesce(jsonb_agg(jsonb_build_object(
           'assignment_id', a.id,
           'assignment_node_id', a.node_id,
           'operator_id', a.operator_id) order by a.id), '[]'::jsonb)
    into v_stranded
    from assignments a
   where a.run_id = new.id
     and a.node_id is distinct from new.node_id;

  if jsonb_array_length(v_stranded) > 0 then
    perform api_raise('run_node_mismatch',
      format('run %s moved to node %s but %s crew row(s) did not follow',
             new.id, new.node_id, jsonb_array_length(v_stranded)),
      jsonb_build_object('reason', 'run_moved_without_crew',
                         'run_id', new.id,
                         'node_id', new.node_id,
                         'stranded', v_stranded));
  end if;
  return null;  -- AFTER trigger: the return value is ignored.
end $$;

comment on function public.runs_check_crew_follows() is
  'DEF-0014 / R-037. The run side of the run/crew invariant: at commit, refuses a run whose node_id has changed while any crew row (assignment with run_id = the run) still points at a different cell. Deferred so move_run --- which moves the run and then every crew row in one transaction --- passes, while a bare PATCH of runs.node_id, its own transaction, is refused (reason run_moved_without_crew). SECURITY DEFINER so an RLS-hidden crew row cannot make the guard fail open.';

drop trigger if exists runs_crew_follows on runs;
create constraint trigger runs_crew_follows
  after update of node_id on runs
  deferrable initially deferred
  for each row execute function public.runs_check_crew_follows();
