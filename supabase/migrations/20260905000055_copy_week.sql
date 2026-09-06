-- ============================================================================
-- 0055 --- COPY A WEEK FORWARD, AND SETTLE EVERY CLASH BY ASKING (R-339, S35).
--
-- The maintainer, session 71: *"For the copy week, if there are conflicts lets
-- present them to the user and let them decide what they want to keep, the
-- prior plan or the copied plan."* Repeating a week meant typing it again; this
-- is the server half of the copy. Two functions: one that says what a copy
-- WOULD do, item by item, with every clash and both candidates; and one that
-- takes an answer per clash and applies exactly those answers in one
-- transaction. Nothing is written by the first; nothing is written by the
-- second until every clash has an answer the first one offered.
--
-- ⭐⭐ WHAT COUNTS AS A CLASH IS READ OFF THE WRITERS, NOT INVENTED HERE. The
-- plan marks an item `clash` exactly when `create_run` / `create_assignment`
-- would refuse the shifted row today, and for no other reason. The three
-- predicates, quoted from the last definitions of the functions that carry
-- them (CLAUDE.md section 4, "extract, never retype"):
--
--   run_overlap    create_run (0044):
--                    SELECT id INTO v_conflicting_run_id FROM runs
--                    WHERE node_id = p_node_id AND timerange && p_timerange
--                  (the table twin is `runs_no_overlap_on_node`, 0044 s3).
--   operator_busy  `create_assignment` (0030) carries NO double-booking clause
--                  of its own; the refusal it relies on is the table trigger
--                  `check_operator_capacity` (0043), whose predicate is
--                    peak := operator_peak_load(NEW.operator_id, NEW.timerange,
--                                               NEW.efficiency, NEW.id);
--                    IF peak > cap THEN api_raise('capacity_exceeded', ...)
--                  This file asks `capacity_probe` (0043), which is "the same
--                  implementation as the trigger -- see operator_peak_load()",
--                  and reads its `fits` (= peak <= cap). The rows listed as the
--                  prior plan use `capacity_probe`'s own `overlapping`
--                  predicate: `a.operator_id = p_operator_id AND a.timerange
--                  && p_timerange`. Anywhere, not only under this plant.
--   not_eligible   `create_assignment` (0030):
--                    v_elig := check_eligibility(p_node_id, p_operator_id, p_timerange);
--                    IF NOT (v_elig->>'eligible')::boolean THEN
--                      IF v_elig->>'policy' = 'block' THEN api_raise('not_eligible', ...)
--                      ELSIF NOT p_eligibility_override THEN api_raise('not_eligible', ...)
--                  so the plant's effective policy is whatever `check_eligibility`
--                  (0050) resolves for that node, and this file asks it the same
--                  question with the same three arguments.
--
-- A retired shift pattern is not a clash: runs and assignments carry their own
-- times and reference no shift. Absence data does not exist in the app. A
-- copied run landing on a day with no shift defined simply lands (S35's first
-- open call, settled here: nothing the writers refuse is about shifts).
--
-- ⭐ `choices` IS WHAT THE WRITERS WOULD TAKE (R-239). Both answers are offered
-- everywhere except where the server would refuse the copied row outright:
-- `not_eligible` under `block` (no override exists), and `operator_busy` where
-- one of the rows that would have to go sits on a node the caller may not edit
-- (the RLS-filtered DELETE would remove nothing and the trigger would then
-- refuse the copy). There the item is still LISTED, with `["prior"]`, so the
-- person sees why the prior plan stays. The client renders `choices` and
-- nothing more.
--
-- ⚠️ `prior` LISTS EXACTLY THE ROWS THAT "COPIED" WOULD REMOVE. For
-- `run_overlap` that is every run on the node overlapping the shifted window,
-- removed WHOLE with its crew through `delete_run(id, 'cascade')` (S35's second
-- open call: the lean was whole, and it is whole here, because half a run is
-- not a plan anyone asked for). For `operator_busy` it is the operator's
-- overlapping assignments. For `not_eligible` on its own it is empty: the
-- clash is between the person and the work, and nothing is displaced.
-- When a person is both not certified and over capacity, the item says
-- `not_eligible` (the reason the client must show a warning for) and its
-- `prior` list still names the rows that go; `apply_copy_week` handles both
-- halves on "copied".
--
-- ⚠️ AN ATTACHED ASSIGNMENT FOLLOWS ITS RUN. An assignment attached to a copied
-- run is its own item with its own status, and its `parent_key` names the run.
-- If the run is answered `prior`, the assignment is skipped whatever its own
-- answer --- there is no new run to attach it to, and it must not remove
-- anything either. Pinned by CW18 in 78_copy_week_test.sql.
--
-- ⚠️ EVERY WRITE GOES THROUGH THE EXISTING WRITERS. `create_run`, `create_assignment`,
-- `delete_run`, and the plain RLS-governed DELETE on `assignments` that the
-- board's own delete uses (src/lib/api/mutations.ts `deleteAssignment`:
-- "NO RPC, DELIBERATELY. `assignments_delete` (0008) already grants exactly
-- the right people the right rows"). So every guard those carry --- edit
-- rights, area scope (0034), capacity (0043), eligibility --- applies here
-- too, and a plpgsql function is one transaction: any raise anywhere leaves
-- nothing written. That RLS-filtered DELETE is the one write here that can
-- succeed having done nothing, so its ROW_COUNT is compared with what was
-- there and a shortfall is a refusal (CLAUDE.md section 4).
--
-- ⚠️ THE APPLY RECOMPUTES THE PLAN. No token, no client-supplied plan: the
-- decisions are matched against `copy_week_plan` run again in the same
-- transaction, and the copied rows are written from THAT plan's `copied`
-- values, so the source table is not read a second time. One shape makes
-- that matter, and CW24 pins it: a source row whose timerange reaches INTO
-- the target week (a Sunday night row crossing midnight, on a one-week copy)
-- can be listed under `prior` for a copied row it overlaps --- the person
-- would be double-booked, and the writers' rule shows both rows. It is
-- listed like any other prior row: "prior" keeps it and writes nothing for
-- the copied one; "copied" removes it, source week or not. Being a source
-- row it is also an item of its own, and its own copy is still written from
-- what the person was shown, after the original is gone.
--
-- ⚠️ A PERSON ON LOAN FROM A PLANT THE CALLER CANNOT SEE IS STILL COPIED.
-- `operators_select` (0028) is `app_can_read_owned(site_node_id)`, so an
-- operator owned by another plant and placed here with an area override
-- (D113) has an assignment row the caller can read and an operator row they
-- cannot. The assignment loop therefore LEFT JOINs operators: the item is
-- listed with `operator_name` null (the screen says "a person on loan from
-- another plant"), counted, and copied with its area override and reason
-- carried, because `create_assignment` takes that placement from a caller
-- who cannot read the operator row. For the same person `capacity_probe`
-- cannot read the cap either and answers `fits: null`; that null is read as
-- "fits" on purpose --- the writer's own trigger decides for an operator
-- whose capacity the caller cannot read, and any raise there rolls the
-- whole apply back. An INNER join here dropped such a person from the plan
-- silently, uncounted anywhere; CW22 pins that w1, who cannot read Vera,
-- and w3, who can, get the same counts and the same copy.
--
-- ⚠️ WHAT IS NOT COPIED, AND IS COUNTED RATHER THAN HIDDEN. A run whose product
-- has been deleted, or an assignment whose person or product has been deleted,
-- is history (D110): `runs_product_identified` / `assignments_operator_identified`
-- keep only the remembered name, and no writer can take a row with no product
-- or no person. They are left where they are and counted under `history`, so
-- the screen can say "n rows are history and stay" instead of nothing. An
-- assignment attached to a run that STARTS outside the source week is not a
-- source row at all and is not counted.
--
-- ⚠️ THE WEEK IS SEVEN DAYS FROM MIDNIGHT IN THE SESSION'S TIME ZONE. There is
-- no per-org or per-plant time zone (0037: "per-site timezone (D88) reserves
-- for Phase 2"); seed.sql anchors its week in UTC (D10) and every PostgREST
-- session runs in UTC. `date::timestamptz` is that convention, stated once
-- here rather than hard-coded, so a future time zone setting has one line to
-- change. The shift is a whole number of days, so a DST change inside the
-- copied span does not move a row's wall-clock time in UTC.
--
-- ⚠️ ONE KNOWN GAP, LEFT TO THE TRIGGER ON PURPOSE. Each copied assignment is
-- probed against the PRIOR plan, not against its copied siblings. Two source
-- assignments for the same person that were legal together in the source week
-- stay legal together after the shift, so the only case the plan cannot see
-- is a prior row that fits beside each of them alone and not beside both
-- (0.5 + 0.5 + a prior 0.3). There `create_assignment`'s trigger raises
-- `capacity_exceeded` on the second write and the whole apply rolls back with
-- nothing written --- CW17 pins that it is nothing, not half. Listing the
-- combination as a clash would need a second copy of the peak calculation,
-- which 0004 says not to restructure and 0043 keeps in one place.
--
-- Measured before writing: `grep -in "function \(public\.\)\?<name>("` for
-- create_run, create_assignment, move_run, delete_run, check_eligibility,
-- capacity_probe, operator_peak_load, app_is_admin_for, app_can_edit_node,
-- app_node_is_plant_root, app_node_exists_in_org --- last hit each --- and
-- every `alter table runs` / `alter table assignments` after 0003 (0029 drops
-- NOT NULL on runs.product_id and assignments.operator_id; 0043 and 0044 drop
-- the two status columns; 0030 adds area_override). No column list is
-- repeated here: the copies are written through the RPCs' parameters.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- copy_week_plan: what a copy would do, item by item. Writes nothing.
-- ----------------------------------------------------------------------------
create or replace function copy_week_plan(
  p_plant_id     uuid,
  p_source_start date,
  p_target_start date
) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id     uuid;
  v_plant_path ltree;
  v_days       int;
  v_shift      interval;
  v_src        tstzrange;
  v_new        tstzrange;
  v_items      jsonb := '[]'::jsonb;
  v_clean      int := 0;
  v_clash      int := 0;
  v_hist_runs  int := 0;
  v_hist_asg   int := 0;
  r            record;
  a            record;
  v_prior      jsonb;
  v_elig       jsonb;
  v_probe      jsonb;
  v_reason     text;
  v_policy     text;
  v_choices    jsonb;
  v_clash_obj  jsonb;
  v_uneditable boolean;
  v_fits       boolean;
BEGIN
  -- 1. The place: a plant root in the caller's org. `app_node_exists_in_org`
  --    (0020) is org-scoped and `app_node_is_plant_root` (0054) answers about
  --    the node, so a root in another company and a department in this one
  --    get the same answer: not a plant, and nothing about the other tenant.
  IF p_plant_id IS NULL
     OR NOT app_node_exists_in_org(p_plant_id)
     OR NOT app_node_is_plant_root(p_plant_id) THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
  END IF;

  -- 2. Who: the person who runs the plant, the same predicate set_site_member
  --    (0054) asks before it lets anyone change who runs it.
  IF NOT app_is_admin_for(p_plant_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this plant',
      jsonb_build_object('plant_id', p_plant_id, 'reason', 'not_admin'));
  END IF;

  -- 3. When: two dates a whole, non-zero number of weeks apart, either way.
  IF p_source_start IS NULL OR p_target_start IS NULL THEN
    PERFORM api_raise('invalid_argument', 'both weeks must be given',
      jsonb_build_object('field', 'p_source_start/p_target_start', 'reason', 'null'));
  END IF;
  v_days := p_target_start - p_source_start;
  IF v_days = 0 THEN
    PERFORM api_raise('invalid_argument', 'the source and target weeks are the same week',
      jsonb_build_object('source_start', p_source_start, 'target_start', p_target_start, 'reason', 'same_week'));
  END IF;
  IF v_days % 7 <> 0 THEN
    PERFORM api_raise('invalid_argument', 'the target week must be a whole number of weeks from the source week',
      jsonb_build_object('source_start', p_source_start, 'target_start', p_target_start,
                         'days', v_days, 'reason', 'not_whole_weeks'));
  END IF;
  v_shift := make_interval(days => v_days);
  v_src   := tstzrange(p_source_start::timestamptz, (p_source_start + 7)::timestamptz, '[)');

  SELECT n.org_id, n.path INTO v_org_id, v_plant_path FROM nodes n WHERE n.id = p_plant_id;

  -- 4. History that cannot be copied (see the header): counted, not hidden.
  SELECT count(*) INTO v_hist_runs
    FROM runs x JOIN nodes n ON n.id = x.node_id
   WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
     AND v_src @> lower(x.timerange)
     AND x.product_id IS NULL;

  SELECT count(*) INTO v_hist_asg
    FROM assignments x JOIN nodes n ON n.id = x.node_id
    LEFT JOIN runs xr ON xr.id = x.run_id
   WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
     AND v_src @> lower(x.timerange)
     AND (x.operator_id IS NULL
          OR (x.run_id IS NULL AND x.product_id IS NULL)
          OR (x.run_id IS NOT NULL AND xr.product_id IS NULL AND v_src @> lower(xr.timerange)));

  -- 5. Runs: every run under the plant that STARTS inside the source week.
  FOR r IN
    SELECT x.id, x.node_id, n.name AS node_name, x.product_id, pr.name AS product_name,
           x.timerange, x.planned_headcount, x.notes
      FROM runs x
      JOIN nodes n ON n.id = x.node_id
      LEFT JOIN products pr ON pr.id = x.product_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND x.product_id IS NOT NULL
     ORDER BY lower(x.timerange), n.name, x.id
  LOOP
    v_new := tstzrange(lower(r.timerange) + v_shift, upper(r.timerange) + v_shift, '[)');

    -- create_run (0044): WHERE node_id = p_node_id AND timerange && p_timerange
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', x.id, 'kind', 'run', 'node_name', r.node_name,
             'product_name', COALESCE(px.name, x.product_name), 'operator_name', NULL,
             'start', lower(x.timerange), 'end', upper(x.timerange))
             ORDER BY lower(x.timerange), x.id), '[]'::jsonb)
      INTO v_prior
      FROM runs x LEFT JOIN products px ON px.id = x.product_id
     WHERE x.node_id = r.node_id AND x.timerange && v_new;

    IF jsonb_array_length(v_prior) > 0 THEN
      v_clash := v_clash + 1;
      v_clash_obj := jsonb_build_object('reason', 'run_overlap', 'policy', NULL,
                                        'prior', v_prior,
                                        'choices', '["prior","copied"]'::jsonb);
    ELSE
      v_clean := v_clean + 1;
      v_clash_obj := NULL;
    END IF;

    v_items := v_items || jsonb_build_object(
      'key', 'run:' || r.id::text,
      'kind', 'run',
      'parent_key', NULL,
      'copied', jsonb_build_object(
        'node_id', r.node_id, 'node_name', r.node_name,
        'product_id', r.product_id, 'product_name', r.product_name,
        'operator_id', NULL, 'operator_name', NULL,
        'start', lower(v_new), 'end', upper(v_new),
        'planned_headcount', r.planned_headcount, 'notes', r.notes,
        'efficiency', NULL, 'target_qty', NULL, 'target_unit', NULL),
      'status', CASE WHEN v_clash_obj IS NULL THEN 'clean' ELSE 'clash' END,
      'clash', v_clash_obj);
  END LOOP;

  -- 6. Assignments: direct ones (model A) that start inside the source week,
  --    and run-attached ones (model B) whose run is one of the runs above.
  FOR a IN
    -- LEFT JOIN operators: a person on loan from a plant the caller cannot
    -- read (see the header) has no readable operator row and is still a
    -- source row. operator_display_name is D110's memory of a DELETED
    -- person (NULL while they exist), so for a live person the caller
    -- cannot read the name is null, not a guess.
    SELECT x.id, x.node_id, n.name AS node_name,
           x.operator_id, COALESCE(o.display_name, x.operator_display_name) AS operator_name,
           x.run_id, x.product_id,
           COALESCE(pr.name, prr.name) AS product_name,
           COALESCE(x.product_id, xr.product_id) AS product_id_shown,
           x.timerange, x.efficiency, x.target_qty, x.target_unit,
           x.area_override, x.area_override_reason
      FROM assignments x
      JOIN nodes n ON n.id = x.node_id
      LEFT JOIN operators o ON o.id = x.operator_id
      LEFT JOIN products pr ON pr.id = x.product_id
      LEFT JOIN runs xr ON xr.id = x.run_id
      LEFT JOIN products prr ON prr.id = xr.product_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND x.operator_id IS NOT NULL
       AND ((x.run_id IS NULL AND x.product_id IS NOT NULL)
            OR (x.run_id IS NOT NULL AND xr.product_id IS NOT NULL AND v_src @> lower(xr.timerange)))
     ORDER BY lower(x.timerange), n.name, o.display_name, x.id
  LOOP
    v_new := tstzrange(lower(a.timerange) + v_shift, upper(a.timerange) + v_shift, '[)');

    -- The same two questions create_assignment asks, with the same arguments.
    v_elig  := check_eligibility(a.node_id, a.operator_id, v_new);
    v_probe := capacity_probe(a.operator_id, v_new, a.efficiency, NULL);
    -- `fits` is NULL for an operator whose row the caller cannot read (the
    -- probe finds no cap). Read as "fits" on purpose: the writer's own
    -- trigger decides for an operator whose capacity the caller cannot
    -- read, and any raise there rolls the whole apply back. Left as NULL,
    -- `NOT v_fits` was NULL and the busy branch was skipped silently.
    v_fits  := COALESCE((v_probe->>'fits')::boolean, true);

    -- capacity_probe (0043): a.operator_id = p_operator_id AND a.timerange && p_timerange
    -- These are the rows "copied" would remove; listed only when it would.
    IF NOT v_fits THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', x.id, 'kind', 'assignment', 'node_name', xn.name,
               'product_name', COALESCE(xp.name, xrp.name, x.product_name),
               'operator_name', COALESCE(xo.display_name, x.operator_display_name),
               'start', lower(x.timerange), 'end', upper(x.timerange))
               ORDER BY lower(x.timerange), x.id), '[]'::jsonb),
             COALESCE(bool_or(NOT app_can_edit_node(x.node_id)), false)
        INTO v_prior, v_uneditable
        FROM assignments x
        JOIN nodes xn ON xn.id = x.node_id
        LEFT JOIN operators xo ON xo.id = x.operator_id
        LEFT JOIN products xp ON xp.id = x.product_id
        LEFT JOIN runs xr ON xr.id = x.run_id
        LEFT JOIN products xrp ON xrp.id = xr.product_id
       WHERE x.operator_id = a.operator_id AND x.timerange && v_new;
    ELSE
      v_prior := '[]'::jsonb;
      v_uneditable := false;
    END IF;

    v_reason := NULL; v_policy := NULL;
    IF NOT (v_elig->>'eligible')::boolean THEN
      v_reason := 'not_eligible';
      v_policy := v_elig->>'policy';
    ELSIF NOT v_fits THEN
      v_reason := 'operator_busy';
    END IF;

    IF v_reason IS NULL THEN
      v_clean := v_clean + 1;
      v_clash_obj := NULL;
    ELSE
      v_clash := v_clash + 1;
      -- R-239: "copied" is offered only where the writers would take it.
      IF v_policy = 'block' OR (NOT v_fits AND v_uneditable) THEN
        v_choices := '["prior"]'::jsonb;
      ELSE
        v_choices := '["prior","copied"]'::jsonb;
      END IF;
      v_clash_obj := jsonb_build_object('reason', v_reason, 'policy', v_policy,
                                        'prior', v_prior, 'choices', v_choices);
    END IF;

    v_items := v_items || jsonb_build_object(
      'key', 'assignment:' || a.id::text,
      'kind', 'assignment',
      'parent_key', CASE WHEN a.run_id IS NOT NULL THEN 'run:' || a.run_id::text END,
      'copied', jsonb_build_object(
        'node_id', a.node_id, 'node_name', a.node_name,
        'product_id', a.product_id_shown, 'product_name', a.product_name,
        'operator_id', a.operator_id, 'operator_name', a.operator_name,
        'start', lower(v_new), 'end', upper(v_new),
        'planned_headcount', NULL, 'notes', NULL,
        'efficiency', a.efficiency, 'target_qty', a.target_qty, 'target_unit', a.target_unit,
        -- Carried so apply_copy_week can hand create_assignment the same
        -- D113 door the source row went through; the screen may ignore them.
        'area_override', a.area_override, 'area_override_reason', a.area_override_reason),
      'status', CASE WHEN v_clash_obj IS NULL THEN 'clean' ELSE 'clash' END,
      'clash', v_clash_obj);
  END LOOP;

  RETURN jsonb_build_object(
    'plant_id', p_plant_id,
    'source_start', p_source_start,
    'target_start', p_target_start,
    'shift_days', v_days,
    'counts', jsonb_build_object('clean', v_clean, 'clash', v_clash),
    'history', jsonb_build_object('runs', v_hist_runs, 'assignments', v_hist_asg),
    'items', v_items);
END $$;

comment on function copy_week_plan(uuid, date, date) is
  'R-339 / S35. What copying the week starting p_source_start onto the week starting p_target_start would do at this plant, item by item, writing nothing. Each run and assignment that starts inside the source week is shifted by the whole number of weeks between the two dates and marked clean or clash; a clash carries the reason a writer would refuse it today (run_overlap from create_run, operator_busy from the capacity trigger via capacity_probe, not_eligible from check_eligibility with the plant''s effective policy), the prior rows that taking the copied one would remove, and the choices the writers would accept (R-239: ["prior"] only under block, or where a displaced row is on a node the caller may not edit). An assignment attached to a copied run names it in parent_key and is skipped if that run is answered prior. Refuses: not_a_plant, not_admin, same_week, not_whole_weeks. Rows that remember a deleted product or person (D110) are not copied and are counted under history.';

revoke execute on function copy_week_plan(uuid, date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function copy_week_plan(uuid, date, date) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function copy_week_plan(uuid, date, date) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- apply_copy_week: the answers, applied in one transaction through the
-- existing writers. p_decisions is [ { "key": text, "choice": "prior"|"copied" } ].
-- ----------------------------------------------------------------------------
create or replace function apply_copy_week(
  p_plant_id     uuid,
  p_source_start date,
  p_target_start date,
  p_decisions    jsonb
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_plan         jsonb;
  v_item         jsonb;
  v_dec          jsonb;
  v_key          text;
  v_choice       text;
  v_decided      jsonb := '{}'::jsonb;   -- key -> choice, as given
  v_undecided    jsonb;
  v_copied       jsonb;
  v_new          tstzrange;
  v_res          jsonb;
  v_run_map      jsonb := '{}'::jsonb;   -- source run key -> new run id
  v_new_run_id   uuid;
  v_prior_id     uuid;
  v_prior_ids    uuid[];
  v_present      int;
  v_deleted      int;
  v_new_run_ids  uuid[] := '{}';
  v_new_asg_ids  uuid[] := '{}';
  v_rm_run_ids   uuid[] := '{}';
  v_rm_asg_ids   uuid[] := '{}';
  v_skipped      int := 0;
  v_elig         jsonb;
  v_probe        jsonb;
  v_override     boolean;
  v_reason       text;
  v_created_runs int;
  v_created_asg  int;
  v_removed_runs int;
  v_removed_asg  int;
BEGIN
  -- 1. The plan, recomputed here. Its refusals (not_a_plant, not_admin,
  --    same_week, not_whole_weeks) are this function's refusals too.
  v_plan := copy_week_plan(p_plant_id, p_source_start, p_target_start);

  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' THEN
    PERFORM api_raise('invalid_argument', 'p_decisions must be an array of {key, choice}',
      jsonb_build_object('field', 'p_decisions', 'reason', 'not_an_array'));
  END IF;

  -- 2. Index the answers. The same key twice is a client bug, not a tie to
  --    break silently.
  FOR v_dec IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
    v_key := v_dec->>'key';
    IF v_key IS NOT NULL AND v_decided ? v_key THEN
      PERFORM api_raise('invalid_argument', 'the same item was answered twice',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'reason', 'duplicate_key'));
    END IF;
    v_decided := v_decided || jsonb_build_object(COALESCE(v_key, ''), COALESCE(v_dec->>'choice', ''));
  END LOOP;

  -- 3a. Every clash item needs an answer.
  SELECT COALESCE(jsonb_agg(i->>'key'), '[]'::jsonb) INTO v_undecided
    FROM jsonb_array_elements(v_plan->'items') i
   WHERE i->>'status' = 'clash' AND NOT (v_decided ? (i->>'key'));
  IF jsonb_array_length(v_undecided) > 0 THEN
    PERFORM api_raise('invalid_argument', 'every clash needs an answer before anything is copied',
      jsonb_build_object('field', 'p_decisions', 'keys', v_undecided, 'reason', 'undecided'));
  END IF;

  -- 3b. Every answer must be one the plan offered (R-239).
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'status' = 'clash'
  LOOP
    v_key := v_item->>'key';
    v_choice := v_decided->>v_key;
    IF NOT (v_item->'clash'->'choices' ? v_choice) THEN
      PERFORM api_raise('invalid_argument', 'that answer was not offered for this item',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'choice', v_choice,
                           'choices', v_item->'clash'->'choices', 'reason', 'choice_not_offered'));
    END IF;
  END LOOP;

  -- 3c. Every answer must be about a clash item.
  FOR v_key IN SELECT k FROM jsonb_object_keys(v_decided) k LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'items') i
                    WHERE i->>'key' = v_key AND i->>'status' = 'clash') THEN
      PERFORM api_raise('invalid_argument', 'that is not a clash item in this plan',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'reason', 'unknown_key'));
    END IF;
  END LOOP;

  -- 4. Runs answered "copied" over a clash: the prior runs go WHOLE, crew and
  --    all, through delete_run's cascade mode. A prior run that two copied
  --    runs both overlap is deleted once; the second look finds it gone.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i
     WHERE i->>'kind' = 'run' AND i->>'status' = 'clash'
       AND v_decided->>(i->>'key') = 'copied'
  LOOP
    FOR v_prior_id IN
      SELECT (p->>'id')::uuid FROM jsonb_array_elements(v_item->'clash'->'prior') p
       WHERE p->>'kind' = 'run'
    LOOP
      IF EXISTS (SELECT 1 FROM runs WHERE id = v_prior_id) THEN
        v_rm_asg_ids := v_rm_asg_ids || ARRAY(SELECT id FROM assignments WHERE run_id = v_prior_id);
        v_rm_run_ids := v_rm_run_ids || v_prior_id;
        PERFORM delete_run(v_prior_id, 'cascade');
      END IF;
    END LOOP;
  END LOOP;

  -- 5. Runs: clean ones and clashes answered "copied" are created through
  --    create_run; clashes answered "prior" are skipped.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'kind' = 'run'
  LOOP
    v_key := v_item->>'key';
    IF v_item->>'status' = 'clash' AND v_decided->>v_key = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_copied := v_item->'copied';
    v_new := tstzrange((v_copied->>'start')::timestamptz, (v_copied->>'end')::timestamptz, '[)');
    v_res := create_run((v_copied->>'node_id')::uuid,
                        (v_copied->>'product_id')::uuid,
                        v_new,
                        (v_copied->>'planned_headcount')::int,
                        v_copied->>'notes');
    v_new_run_id := (v_res->'run'->>'id')::uuid;
    v_new_run_ids := v_new_run_ids || v_new_run_id;
    v_run_map := v_run_map || jsonb_build_object(v_key, v_new_run_id);
  END LOOP;

  -- 6. Assignments. An attached one whose run was answered "prior" is skipped
  --    before anything else is looked at, so it removes nothing either.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'kind' = 'assignment'
  LOOP
    v_key := v_item->>'key';
    IF v_item->>'parent_key' IS NOT NULL
       AND v_decided->>(v_item->>'parent_key') = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF v_item->>'status' = 'clash' AND v_decided->>v_key = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_copied := v_item->'copied';
    v_new := tstzrange((v_copied->>'start')::timestamptz, (v_copied->>'end')::timestamptz, '[)');
    v_override := false;
    v_reason := NULL;

    IF v_item->>'status' = 'clash' THEN
      -- The rows the plan listed are the rows the person agreed to displace.
      -- Only when the copy still does not fit beside them: a prior list on a
      -- not_eligible item that fits is informational and stays.
      v_probe := capacity_probe((v_copied->>'operator_id')::uuid, v_new,
                                (v_copied->>'efficiency')::numeric, NULL);
      -- NULL `fits` (an operator the caller cannot read) is "fits" here as
      -- in the plan: the writer's trigger decides, and a raise rolls back.
      IF NOT COALESCE((v_probe->>'fits')::boolean, true) THEN
        v_prior_ids := ARRAY(SELECT (p->>'id')::uuid
                               FROM jsonb_array_elements(v_item->'clash'->'prior') p
                              WHERE p->>'kind' = 'assignment');
        -- The board's own delete path: a plain DELETE under assignments_delete
        -- (0008). It can succeed having removed nothing, so read first, then
        -- compare (CLAUDE.md section 4).
        SELECT count(*) INTO v_present FROM assignments WHERE id = ANY(v_prior_ids);
        DELETE FROM assignments WHERE id = ANY(v_prior_ids);
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        -- Unreachable by construction: every listed id was checked with
        -- app_can_edit_node in the plan, the same predicate assignments_delete
        -- (0008) filters by, and a row failing it made choices ["prior"], so
        -- 3b refused "copied" before this line. Kept as the belt (CW25).
        IF v_deleted <> v_present THEN
          PERFORM api_raise('not_permitted', 'a prior assignment could not be removed',
            jsonb_build_object('key', v_key, 'expected', v_present, 'removed', v_deleted));
        END IF;
        v_rm_asg_ids := v_rm_asg_ids || v_prior_ids;
      END IF;

      -- create_assignment (0030): under warn, an ineligible placement is
      -- taken only with p_eligibility_override and a reason -- the way the
      -- board creates a warned placement (CreatePopover.tsx). Under block the
      -- plan never offered "copied", so this line is not reached.
      v_elig := check_eligibility((v_copied->>'node_id')::uuid, (v_copied->>'operator_id')::uuid, v_new);
      IF NOT (v_elig->>'eligible')::boolean AND v_elig->>'policy' = 'warn' THEN
        v_override := true;
        v_reason := format('Copied from the week of %s; the copied plan was chosen over the prior one',
                           to_char(p_source_start, 'YYYY-MM-DD'));
      END IF;
    END IF;

    IF v_item->>'parent_key' IS NOT NULL THEN
      v_new_run_id := (v_run_map->>(v_item->>'parent_key'))::uuid;
      -- Unreachable by construction: a crew row is only listed under a run
      -- that is itself an item (same product and start-week tests), a run
      -- answered "prior" skipped its crew at the top of this loop, and every
      -- other run was created in step 5 and put in v_run_map.
      IF v_new_run_id IS NULL THEN
        PERFORM api_raise('invalid_argument', 'the copied run this assignment belongs to was not created',
          jsonb_build_object('key', v_key, 'parent_key', v_item->>'parent_key', 'reason', 'parent_missing'));
      END IF;
    ELSE
      v_new_run_id := NULL;
    END IF;

    v_res := create_assignment(
      (v_copied->>'node_id')::uuid,
      (v_copied->>'operator_id')::uuid,
      v_new_run_id,
      CASE WHEN v_new_run_id IS NULL THEN (v_copied->>'product_id')::uuid END,
      v_new,
      (v_copied->>'efficiency')::numeric,
      (v_copied->>'target_qty')::numeric,
      v_copied->>'target_unit',
      v_override,
      v_reason,
      COALESCE((v_copied->>'area_override')::boolean, false),
      v_copied->>'area_override_reason');
    v_new_asg_ids := v_new_asg_ids || (v_res->'assignment'->>'id')::uuid;
  END LOOP;

  -- 7. Counts read back from the tables, not tallied from intent. The
  --    removed arrays can name one row twice --- a crew row of a deleted run
  --    that is also a listed prior of an operator_busy item --- so the ids
  --    are counted DISTINCT (CW23).
  SELECT count(*) INTO v_created_runs FROM runs WHERE id = ANY(v_new_run_ids);
  SELECT count(*) INTO v_created_asg  FROM assignments WHERE id = ANY(v_new_asg_ids);
  SELECT count(DISTINCT u.id) INTO v_removed_runs
    FROM unnest(v_rm_run_ids) u(id) WHERE NOT EXISTS (SELECT 1 FROM runs x WHERE x.id = u.id);
  SELECT count(DISTINCT u.id) INTO v_removed_asg
    FROM unnest(v_rm_asg_ids) u(id) WHERE NOT EXISTS (SELECT 1 FROM assignments x WHERE x.id = u.id);

  RETURN jsonb_build_object(
    'created', jsonb_build_object('runs', v_created_runs, 'assignments', v_created_asg),
    'removed', jsonb_build_object('runs', v_removed_runs, 'assignments', v_removed_asg),
    'skipped', v_skipped);
END $$;

comment on function apply_copy_week(uuid, date, date, jsonb) is
  'R-339 / S35. Applies copy_week_plan with one answer per clash item, p_decisions = [{key, choice}], in one transaction. Recomputes the plan here (no token, no client plan); refuses undecided (a clash with no answer, detail keys), choice_not_offered (an answer the plan did not offer, R-239), unknown_key (an answer for something that is not a clash item), duplicate_key. Then: clean items are copied; "copied" on run_overlap removes the prior runs whole with their crew through delete_run and creates the run; "copied" on operator_busy removes the operator''s listed overlapping assignments (the board''s plain RLS DELETE, ROW_COUNT compared) and creates the copy; "copied" on not_eligible under warn creates through create_assignment with the eligibility override and a reason; "prior" writes nothing. An assignment attached to a run answered prior is skipped whatever its own answer. Every write goes through create_run / create_assignment / delete_run so every guard they carry applies, and any raise leaves nothing written. Returns created / removed / skipped, counted from the tables.';

revoke execute on function apply_copy_week(uuid, date, date, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function apply_copy_week(uuid, date, date, jsonb) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function apply_copy_week(uuid, date, date, jsonb) from anon';
  end if;
end $$;
