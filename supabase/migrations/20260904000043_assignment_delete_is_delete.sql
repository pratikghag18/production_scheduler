-- ===========================================================================
-- 0043 - AN ASSIGNMENT THAT IS DELETED IS DELETED (R-323).
--
-- THE DECISION. The maintainer, after R-322 removed the planned/active/done
-- picker: "why do we need this in runs or assignments? We removed the option to
-- assign status, what am I missing here?" - and, offered gone versus
-- kept-and-hidden, "I want it gone". So `assignments.status` goes, and the
-- Delete button on an assignment does what deleting a run's assignments has
-- always done: it removes the row.
--
-- WHAT THE COLUMN WAS ACTUALLY DOING, which is less than it looked. After R-322
-- the only value anything could write was 'cancelled', so the column held ONE
-- BIT - live or gone - spelled as a word. Two things made that indefensible
-- rather than merely redundant:
--   * The same table already deleted BOTH ways. `delete_run` hard-deletes a
--     run's assignments; the assignment's own Delete marked them cancelled. One
--     concept, two behaviours, depending on which button was pressed.
--   * Migration 0029 had already written down that the status vocabulary cannot
--     be trusted - "nothing in the product ever advances it: every run this
--     system has created is still 'planned', including the ones that finished
--     last week" - and used the clock instead. The column was being routed
--     around rather than used.
--
-- AND THE RECORD DOES NOT DEPEND ON IT. `assignments_audit` (migration 0007)
-- has written actor, action and the whole before/after row since the beginning,
-- for DELETE as well as UPDATE. "Who removed this and when" was never the
-- status column's answer.
--
-- WHAT IS ACTUALLY RISKY HERE IS THE PREDICATES, NOT THE COLUMN. Four functions
-- filtered on it, and each is re-created below FROM ITS LAST DEFINITION with
-- only the assignment-status clause removed - extracted, never retyped
-- (CLAUDE.md s4). With no cancellable row left, every one of those clauses is
-- trivially true; what must be proved is that the two guards still refuse what
-- they refused before - a double-booked operator, and an overlapping run.
-- `supabase/tests/66_no_assignment_status_test.sql` is that proof.
--
-- `runs.status` IS DELIBERATELY UNTOUCHED. Runs are already hard-deleted, so no
-- run is ever 'cancelled' and the clause on `runs_no_overlap_on_node` can never
-- fire - but removing it means dropping and re-adding that exclusion
-- constraint, which is the overlap invariant itself. That is queued as its own
-- piece of work rather than smuggled in here, and the run-side clauses below
-- are left exactly as they were.
--
-- NO CLIENT MAY BE OLDER THAN THIS MIGRATION. `board_window` returns each
-- assignment with `to_jsonb(a)`, so dropping the column removes the key from
-- the payload with no change to that function - and a client whose parser still
-- requires `status` would reject every board read. The parser is changed in the
-- same commit.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- operator_peak_load - extracted from 20260821000009_api_surface.sql, assignment-status clauses removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operator_peak_load(
  p_operator_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric,
  p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(max(load), 0) FROM (
    SELECT (SELECT COALESCE(sum(a.efficiency), 0)
            FROM assignments a
            WHERE a.operator_id = p_operator_id
              AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
              AND a.timerange @> p.pt) + p_efficiency AS load
    FROM (
      SELECT lower(p_timerange) AS pt
      UNION
      SELECT lower(a.timerange) FROM assignments a
      WHERE a.operator_id = p_operator_id
        AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
        AND a.timerange && p_timerange
    ) p
    WHERE p_timerange @> p.pt
  ) q;
$$;

-- ----------------------------------------------------------------------------
-- §3.2: amend check_operator_capacity() -- same §15.1 peak math (now via
-- operator_peak_load()), only the RAISE becomes api_raise('capacity_exceeded', ...).
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- check_operator_capacity - extracted from 20260828000029_delete_keeps_the_past.sql, assignment-status clauses removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_operator_capacity() RETURNS trigger AS $fn$
DECLARE
  cap numeric;
  peak numeric;
BEGIN
  -- D110: the operator has been deleted and this row is history now.
  IF NEW.operator_id IS NULL THEN RETURN NEW; END IF;

  -- D2: cap is configurable per org (orgs.settings->>'capacity_cap'), default 1.0.
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO cap
  FROM orgs o WHERE o.id = NEW.org_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.operator_id::text, 42));
  -- Peak calculation lives in operator_peak_load() (brief P1-3a §4) so the
  -- trigger and capacity_probe() are provably the same implementation.
  peak := operator_peak_load(NEW.operator_id, NEW.timerange, NEW.efficiency, NEW.id);
  IF peak > cap THEN
    PERFORM api_raise('capacity_exceeded',
      format('capacity exceeded: operator %s would reach %s (cap %s)', NEW.operator_id, peak, cap),
      jsonb_build_object('operator_id', NEW.operator_id, 'peak', peak, 'cap', cap, 'timerange', NEW.timerange::text));
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ⭐ A LATENT SHORT-CIRCUIT, FOUND BY GIVING IT A NULL. 0028's version reads
-- the operator's owner and does `if not found then return new; end if;` — the
-- right answer when the operator belongs to another tenant (that is the
-- composite FK's refusal to give, not this trigger's; see 10_'s case 6) but a
-- RETURN that also skips the product half below it. With operator_id NULL now
-- reachable, that would leave the product scope of a direct assignment
-- unchecked. The two halves are separated; the "not in this org" short-circuit
-- inside the operator half is kept exactly as it was, so no existing refusal
-- changes which error it raises. Case D22 pins the product half firing while
-- the operator id is NULL.

-- ---------------------------------------------------------------------------
-- capacity_probe - extracted from 20260821000009_api_surface.sql, assignment-status clauses removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION capacity_probe(
  p_operator_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric,
  p_exclude_assignment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_cap numeric;
  v_peak numeric;
  v_result jsonb;
BEGIN
  SELECT org_id INTO v_org_id FROM operators WHERE id = p_operator_id;
  SELECT COALESCE((o.settings->>'capacity_cap')::numeric, 1.0) INTO v_cap
    FROM orgs o WHERE o.id = v_org_id;

  -- Same implementation as the trigger -- see operator_peak_load() above.
  v_peak := operator_peak_load(p_operator_id, p_timerange, p_efficiency, p_exclude_assignment_id);

  SELECT jsonb_build_object(
    'fits', v_peak <= v_cap,
    'peak', v_peak,
    'cap', v_cap,
    'overlapping', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'assignment_id', a.id,
               'node_id', a.node_id,
               'node_name', n.name,
               'product_name', pr.name,
               'timerange', a.timerange::text,
               'efficiency', a.efficiency
             ) ORDER BY a.timerange)
      FROM assignments a
      JOIN nodes n ON n.id = a.node_id
      LEFT JOIN products pr
        ON pr.id = COALESCE(a.product_id, (SELECT r.product_id FROM runs r WHERE r.id = a.run_id))
      WHERE a.operator_id = p_operator_id
        AND a.timerange && p_timerange
        AND (p_exclude_assignment_id IS NULL OR a.id <> p_exclude_assignment_id)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- check_eligibility: §6 union-along-ancestors requirement, expiry checked
-- against the assignment's window (not now()).
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- move_run - extracted from 20260828000030_area_override.sql, assignment-status clauses removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange,
  p_area_override boolean DEFAULT false, p_area_override_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run runs%ROWTYPE;
  v_old_node_id uuid;
  v_old_start timestamptz;
  v_delta interval;
  v_conflicting_run_id uuid;
  v_policy text;
  v_org_id uuid;
  v_warnings jsonb := '[]'::jsonb;
  v_updated_assignments jsonb;
  rec RECORD;
  v_elig jsonb;
  v_new_range tstzrange;
  v_outside jsonb := '[]'::jsonb;  -- D113
  v_reason text;                   -- D113
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  -- D113: refused here rather than by the table CHECK, so the client gets
  -- `invalid_argument` naming the field instead of a bare 23514.
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;
  v_reason := btrim(p_area_override_reason);

  SELECT * INTO v_run FROM runs WHERE id = p_run_id;
  IF v_run.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'run not found', jsonb_build_object('field', 'p_run_id', 'reason', 'not found'));
  END IF;
  v_old_node_id := v_run.node_id;
  v_old_start := lower(v_run.timerange);
  v_org_id := v_run.org_id;

  -- 1. Edit rights on both the source and target node.
  IF NOT app_can_edit_node(v_old_node_id) OR NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'edit rights required on both source and target node',
      jsonb_build_object('node_id', p_node_id));
  END IF;

  -- 2. Target node must have no other overlapping active run.
  SELECT id INTO v_conflicting_run_id
  FROM runs
  WHERE node_id = p_node_id AND id <> p_run_id AND status <> 'cancelled' AND timerange && p_timerange
  LIMIT 1;
  IF v_conflicting_run_id IS NOT NULL THEN
    PERFORM api_raise('run_overlap', 'target node already has an overlapping active run',
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text,
                          'conflicting_run_id', v_conflicting_run_id));
  END IF;

  v_delta := lower(p_timerange) - v_old_start;

  -- ---- D113: who on this crew does not belong at the target node? ----
  -- Asked here only so the refusal can NAME ALL OF THEM AT ONCE. Without it the
  -- trigger raises about whichever row it reached first, so a run with five
  -- crew and three outside their area refuses three times, one name per
  -- attempt. Same shape as the `block`-policy pre-check below, and for the
  -- same stated reason: abort the whole move, listing every affected operator.
  --
  -- ⚠️ `app_owner_covers`, NOT `app_owner_covers_in_org`. The trigger-side twin
  -- takes the tenant as a free parameter and 0028 granted it to NOBODY on
  -- purpose; this function is SECURITY INVOKER, so calling it here is
  -- `permission denied for function app_owner_covers_in_org` -- which is what
  -- 60_api_test.sql reported on this migration's first run. The session-scoped
  -- twin gives the identical answer, and that is a proof rather than a hope:
  -- the edit-rights check above already refused any caller whose
  -- `app_current_org()` is NULL or differs from the target node's org, so by
  -- this line the two functions test the same pair against the same tenant.
  IF NOT p_area_override THEN
    FOR rec IN
      SELECT a.operator_id, o.site_node_id AS owner_node_id, o.display_name
        FROM assignments a JOIN operators o ON o.id = a.operator_id
       WHERE a.run_id = p_run_id
    LOOP
      IF NOT app_owner_covers(rec.owner_node_id, p_node_id) THEN
        v_outside := v_outside || jsonb_build_object('id', rec.operator_id,
                                                     'name', rec.display_name,
                                                     'owner_node_id', rec.owner_node_id);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_outside) > 0 THEN
      PERFORM api_raise('not_offered_here',
        'Some of this crew do not belong to that part of the structure.',
        jsonb_build_object('kind', 'operator', 'node_id', p_node_id, 'operators', v_outside));
    END IF;
  END IF;

  SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy FROM orgs o WHERE o.id = v_org_id;

  -- Under block: pre-check every crew member against the target node BEFORE
  -- writing anything, so a violation aborts the whole move with nothing
  -- changed (brief §5: "aborts the whole move ... listing every affected
  -- operator").
  IF v_policy = 'block' THEN
    FOR rec IN
      SELECT a.operator_id, a.timerange FROM assignments a
      WHERE a.run_id = p_run_id
    LOOP
      v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
      v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);
      IF NOT (v_elig->>'eligible')::boolean THEN
        v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                         'missing_skills', v_elig->'missing_skills');
      END IF;
    END LOOP;
    IF jsonb_array_length(v_warnings) > 0 THEN
      PERFORM api_raise('not_eligible', 'one or more crew members are not eligible for the target node',
        jsonb_build_object('node_id', p_node_id, 'operators', v_warnings, 'policy', v_policy));
    END IF;
    v_warnings := '[]'::jsonb;
  END IF;

  -- 3. Update the run FIRST -- order matters: assignments_check_run_consistency
  -- must see the run's new node_id when the assignment rows update next.
  UPDATE runs SET node_id = p_node_id, timerange = p_timerange WHERE id = p_run_id
    RETURNING * INTO v_run;

  -- 4/5. Every attached assignment follows: node_id -> target, timerange
  -- shifted by the run's start delta (duration preserved even if the
  -- assignment extended past the run's old bounds -- clamp nothing). Under
  -- warn, an ineligible crew member does not block the move; they are
  -- returned as a warning and marked overridden.
  FOR rec IN
    SELECT * FROM assignments WHERE run_id = p_run_id
  LOOP
    v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
    v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);

    IF NOT (v_elig->>'eligible')::boolean THEN
      v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                       'missing_skills', v_elig->'missing_skills');
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            eligibility_override = true,
            override_reason = format('run moved to %s', (SELECT name FROM nodes WHERE id = p_node_id)),
            -- D113: one reason covers the whole move, unlike create_assignment
            -- where one reason covers one person -- the supervisor is deciding
            -- about a move, not about five people individually. The trigger
            -- turns the flag off again on the rows that did not need it.
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    ELSE
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.timerange), '[]'::jsonb)
    INTO v_updated_assignments FROM assignments a WHERE a.run_id = p_run_id;

  RETURN jsonb_build_object('run', to_jsonb(v_run), 'assignments', v_updated_assignments,
                             'eligibility_warnings', v_warnings);
END;
$function$;

-- ---------------------------------------------------------------------------
-- §5. `apply_split_coverage` threads it through.
--
-- Same signature, so `CREATE OR REPLACE` and no grant dance. It writes its new
-- row by CALLING `create_assignment`, so the override has to be lifted out of
-- the `p_new_assignment` envelope and passed on — three layers, and the middle
-- one is exactly the sort of thing a change plumbs the first and third of.
-- ---------------------------------------------------------------------------
-- ⚠️ THE BODY BELOW IS `pg_get_functiondef`'s OUTPUT WITH ONE STRING
-- REPLACEMENT APPLIED, and the first attempt at this section was NOT. Writing
-- it out by hand from a grep of the parts that looked relevant silently dropped
-- its shape validation, its per-node edit-rights checks and the initialiser on
-- `v_new_json` -- the suite caught it as `null value in column "efficiency"`,
-- an error about none of those things. [[verification-standard]] rule 12 exists
-- for exactly this and I stepped over it. Extract, replace, assert the anchor
-- matched once, diff.

-- ---------------------------------------------------------------------------
-- ⚠️⚠️ THE CANCELLED ROWS GO FIRST, AND THIS IS THE DANGEROUS LINE IN THE FILE.
-- A cancelled assignment is currently INVISIBLE: the board filters it out and
-- the capacity guard skips it. Drop the column with those rows still in place
-- and the thing that made them invisible is what disappears — every one of
-- them comes back to life at once, on somebody's board, counting against an
-- operator's hours. They were deleted by a person who meant to delete them, so
-- deleting them is what honours that; leaving them would resurrect work that
-- was cancelled weeks ago.
--
-- The audit log already holds each of them, actor and whole row, from the
-- UPDATE that cancelled them and now from this DELETE as well.
-- ---------------------------------------------------------------------------
DELETE FROM assignments WHERE status = 'cancelled';

-- ---------------------------------------------------------------------------
-- The capacity trigger NAMES the column in its own definition, so it has to be
-- re-created before the column can go: `BEFORE INSERT OR UPDATE OF timerange,
-- efficiency, status, operator_id`. Postgres records that as a real dependency
-- and refuses the DROP - which is the friendly half of this migration, because
-- it is the one dependency the database checks for you. The function bodies
-- above are the unfriendly half: nothing would have stopped the DROP if I had
-- missed one, and it would have failed on somebody's board instead.
--
-- `status` simply leaves the column list. It was there because CANCELLING was
-- an UPDATE that had to re-run the capacity check; with no cancel, the three
-- columns that remain are the whole of what can change an operator's load.
-- ---------------------------------------------------------------------------
DROP TRIGGER assignments_capacity ON assignments;
CREATE TRIGGER assignments_capacity
BEFORE INSERT OR UPDATE OF timerange, efficiency, operator_id ON assignments
FOR EACH ROW EXECUTE FUNCTION check_operator_capacity();

-- ---------------------------------------------------------------------------
-- And the column itself. Last, so that every function above is already free of
-- it: a dropped column does not fail a stale plpgsql body at DROP time, it
-- fails it at CALL time, on somebody's board.
-- ---------------------------------------------------------------------------
alter table assignments drop column status;

comment on table assignments is
  'Who staffs which cell, when. R-323: no status column - a deleted assignment is DELETED, the same way delete_run has always removed a run''s assignments. The audit log (0007) holds who removed what and when.';
