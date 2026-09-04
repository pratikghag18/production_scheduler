-- ===========================================================================
-- 0044 - NO RUN CARRIES A STATUS EITHER (R-324).
--
-- THE DECISION. The maintainer, once the assignments half had landed and this
-- half had been explained and queued: "Let's go ahead and remove it from runs
-- as well." `runs.status` was write-once 'planned' - nothing in the product has
-- ever advanced a run, which migration 0029 recorded as fact and worked around
-- by using the clock instead - and runs have always been HARD deleted, so
-- 'cancelled' was a state no run could reach.
--
-- WHY THIS WAS A SEPARATE PIECE OF WORK FROM 0043, and the only genuinely
-- delicate part of either: `runs_no_overlap_on_node` is the rule that stops two
-- runs sharing a cell and a window, and it is NOT a function that can be
-- rewritten in place. It is a constraint on the table, and its definition
-- carries `where (status <> 'cancelled')`. Removing the column means DROPPING
-- the constraint and adding it back without the exception. Between those two
-- statements there is no rule at all, and a replacement written even slightly
-- wrong is SILENTLY weaker rather than loudly broken - the table would simply
-- start accepting overlaps and nothing would say so. That is why the new
-- constraint is asserted from OUTSIDE afterwards, by
-- `supabase/tests/67_no_run_status_test.sql`, rather than trusted because the
-- statement below looks right.
--
-- ⚠️ THE DELETE OF CANCELLED RUNS IS A PRECONDITION, NOT HOUSEKEEPING. An
-- unconditional exclusion constraint CANNOT BE CREATED over rows that already
-- violate it, and a cancelled run overlapping a live one on the same cell is
-- exactly what the old exception permitted. So any such run - and its
-- assignments first, since `assignments.run_id` has no cascade - is deleted
-- before the constraint is rebuilt. On this database that is a no-op (37 runs,
-- every one 'planned'); on any database where it is not, it is the difference
-- between a migration that applies and one that fails halfway.
--
-- AFTERWARDS THE RULE IS SIMPLER THAN IT WAS: two runs may not overlap on a
-- cell. No exception, no state to remember, and nothing a client can do to opt
-- a row out of it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- s1. Nothing may be left that the new constraint would reject.
-- ---------------------------------------------------------------------------
DELETE FROM assignments WHERE run_id IN (SELECT id FROM runs WHERE status <> 'planned');
DELETE FROM runs WHERE status <> 'planned';

-- ---------------------------------------------------------------------------
-- s2. The two functions that asked about a run's status. Extracted from their
--     last definitions; only the clause naming the column is gone.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- create_run - extracted from 20260821000009_api_surface.sql, the runs-status clause removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_run(
  p_node_id uuid,
  p_product_id uuid,
  p_timerange tstzrange,
  p_planned_headcount int DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_conflicting_run_id uuid;
  v_run runs%ROWTYPE;
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;

  IF NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', p_node_id));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  SELECT id INTO v_conflicting_run_id
  FROM runs
  WHERE node_id = p_node_id AND timerange && p_timerange
  LIMIT 1;

  IF v_conflicting_run_id IS NOT NULL THEN
    PERFORM api_raise('run_overlap', 'an active run already overlaps this node/window',
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text,
                          'conflicting_run_id', v_conflicting_run_id));
  END IF;

  INSERT INTO runs (org_id, node_id, product_id, timerange, planned_headcount, notes, created_by)
  VALUES (v_org_id, p_node_id, p_product_id, p_timerange, p_planned_headcount, p_notes, auth.uid())
  RETURNING * INTO v_run;

  RETURN jsonb_build_object('run', to_jsonb(v_run));
END;
$$;

-- ---------------------------------------------------------------------------
-- move_run - extracted from 20260904000043_assignment_delete_is_delete.sql, the runs-status clause removed.
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
  WHERE node_id = p_node_id AND id <> p_run_id AND timerange && p_timerange
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
-- s3. The overlap rule, without its exception.
--
-- Same name, same columns, same operators - the ONLY difference is that the
-- `WHERE status <> 'cancelled'` predicate is gone, so it now applies to every
-- row rather than to the ones that had not opted out. Dropped and re-added in
-- one transaction, so there is no window in which a concurrent write could slip
-- through: a migration runs in a transaction, and the exclusion index is
-- rebuilt before anything else can commit.
-- ---------------------------------------------------------------------------
ALTER TABLE runs DROP CONSTRAINT runs_no_overlap_on_node;
ALTER TABLE runs ADD CONSTRAINT runs_no_overlap_on_node
  EXCLUDE USING gist (node_id WITH =, timerange WITH &&);

-- ---------------------------------------------------------------------------
-- s4. And the column. Last, after every function and the constraint are free of
--     it - a stale plpgsql body does not fail at DROP time, it fails on
--     somebody's board.
-- ---------------------------------------------------------------------------
ALTER TABLE runs DROP COLUMN status;

comment on constraint runs_no_overlap_on_node on runs is
  'R-324: two runs may not overlap on a cell. Full stop - the `where (status <> ''cancelled'')` exception went with the status column, because no run could ever reach that state (runs are hard-deleted) and nothing in the product ever advanced one.';

comment on table runs is
  'Work planned on a cell. R-324: no status column - a run is planned, or it is deleted. 0029 established that nothing ever advanced the old one, and delete_run has always removed the row outright.';
