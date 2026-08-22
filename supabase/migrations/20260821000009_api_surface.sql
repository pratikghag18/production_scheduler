-- ============================================================================
-- Migration 0009: database API surface (RPCs, error contract, probes)
-- Implements: agent brief docs/agent-briefs/p1-3a-db-api-surface-brief.md
--   §3 (error contract), §4 (read functions), §5 (write functions),
--   §6 (grants).
--
-- Append-only: this migration never edits 0001-0008. Two P1-2 trigger
-- functions are amended with CREATE OR REPLACE (brief §3.2) to route their
-- raises through the new api_raise() contract; their logic is otherwise
-- untouched -- in particular check_operator_capacity()'s peak query is the
-- same §15.1 math, now delegated to the shared operator_peak_load() helper
-- instead of being restructured (brief's explicit warning; also see brief
-- P1-3a §4/§9 and acceptance items 8-9).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §3: the error contract. Every raise in this migration routes through this
-- helper so the DETAIL-as-JSON shape cannot drift.
--
-- DEVIATION FROM THE BRIEF'S LITERAL CODE SAMPLE: the brief's §3 snippet
-- hardcodes `USING ERRCODE = 'PT409'`, then separately instructs "Use PT400
-- instead of PT409 for invalid_argument, and PT403 for not_permitted" -- two
-- literal instructions that cannot both be followed by one hardcoded
-- ERRCODE. Implemented as a mapping from p_error to the correct SQLSTATE so
-- every raise (in this file and in the amended P1-2 triggers) gets the right
-- code automatically, which is what "route every raise through it, so the
-- shape cannot drift" actually requires.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api_raise(p_error text, p_message text, p_detail jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  v_code := CASE p_error
    WHEN 'invalid_argument' THEN 'PT400'
    WHEN 'not_permitted'    THEN 'PT403'
    ELSE 'PT409'
  END;
  RAISE EXCEPTION '%', p_message
    USING ERRCODE = v_code,
          DETAIL  = (p_detail || jsonb_build_object('error', p_error))::text;
END $$;

-- ----------------------------------------------------------------------------
-- §4 (capacity_probe) / §15.1: the instantaneous-peak calculation, extracted
-- verbatim from migration 0004's check_operator_capacity() so the trigger
-- and capacity_probe() cannot diverge. NEW.* becomes parameters; the
-- `a.id <> NEW.id` exclusion becomes an optional p_exclude_assignment_id
-- (NULL when probing a not-yet-existing assignment, matching the trigger's
-- behaviour exactly when passed NEW.id, since NEW.id is always populated by
-- the time a BEFORE trigger runs -- INSERT defaults, including
-- gen_random_uuid(), are applied before BEFORE triggers see the row).
-- Do not restructure this query -- see the brief's explicit warning and
-- acceptance items 8/9.
-- ----------------------------------------------------------------------------
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
$$;

-- ----------------------------------------------------------------------------
-- §3.2: amend check_operator_capacity() -- same §15.1 peak math (now via
-- operator_peak_load()), only the RAISE becomes api_raise('capacity_exceeded', ...).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_operator_capacity() RETURNS trigger AS $fn$
DECLARE
  cap numeric;
  peak numeric;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

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

-- ----------------------------------------------------------------------------
-- §3.2: amend assignments_check_run_consistency() -- raise run_node_mismatch
-- with the three ids. Logic otherwise unchanged from migration 0003.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assignments_check_run_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run_node_id uuid;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT node_id INTO v_run_node_id FROM runs WHERE id = NEW.run_id;
    IF v_run_node_id IS DISTINCT FROM NEW.node_id THEN
      PERFORM api_raise('run_node_mismatch',
        format('assignment node_id %s does not match run %s node_id %s', NEW.node_id, NEW.run_id, v_run_node_id),
        jsonb_build_object('assignment_node_id', NEW.node_id, 'run_node_id', v_run_node_id, 'run_id', NEW.run_id));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- §4: read functions. All STABLE, SECURITY INVOKER, SET search_path.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- board_window: the single board-load call (design-plan §3 query shape).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION board_window(p_root_path ltree, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_window tstzrange;
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_from and p_to must not be null',
      jsonb_build_object('field', 'p_from/p_to', 'reason', 'null bound'));
  END IF;
  IF p_from >= p_to THEN
    PERFORM api_raise('invalid_argument', 'p_from must be before p_to',
      jsonb_build_object('field', 'p_from', 'reason', 'p_from >= p_to'));
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    PERFORM api_raise('invalid_argument', 'window exceeds 92 days',
      jsonb_build_object('field', 'p_to', 'reason', 'window exceeds 92 days'));
  END IF;

  v_org_id := app_current_org();
  v_window := tstzrange(p_from, p_to);

  WITH scoped_nodes AS (
    SELECT n.* FROM nodes n
    WHERE n.org_id = v_org_id AND n.path <@ p_root_path
  ),
  node_template_map AS (
    SELECT sn.id AS node_id, resolve_shift_template(sn.id) AS template_id
    FROM scoped_nodes sn
  )
  SELECT jsonb_build_object(
    'org', (SELECT jsonb_build_object('id', o.id, 'name', o.name, 'settings', o.settings)
            FROM orgs o WHERE o.id = v_org_id),

    'levels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', hl.id, 'position', hl.position, 'name', hl.name,
               'is_schedulable', hl.is_schedulable) ORDER BY hl.position)
      FROM hierarchy_levels hl WHERE hl.org_id = v_org_id
    ), '[]'::jsonb),

    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sn.id, 'parent_id', sn.parent_id, 'level_id', sn.level_id,
               'name', sn.name, 'path', sn.path::text, 'sort_order', sn.sort_order,
               'active', sn.active) ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange)
      FROM runs r
      WHERE r.node_id IN (SELECT id FROM scoped_nodes) AND r.timerange && v_window
    ), '[]'::jsonb),

    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange)
      FROM assignments a
      WHERE a.node_id IN (SELECT id FROM scoped_nodes) AND a.timerange && v_window
    ), '[]'::jsonb),

    'operators', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', op.id, 'home_node_id', op.home_node_id, 'display_name', op.display_name,
               'employee_ref', op.employee_ref, 'active', op.active,
               'skill_ids', COALESCE((
                 SELECT jsonb_agg(os.skill_id) FROM operator_skills os WHERE os.operator_id = op.id
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      FROM operators op WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
      FROM skills s WHERE s.org_id = v_org_id
    ), '[]'::jsonb),

    -- Scoped to nodes under p_root_path (not the whole org): every
    -- requirement relevant to a returned node is at or above some node
    -- already included in `nodes` (p_root_path itself is included, since
    -- ltree `<@` is reflexive), so this stays complete for any p_root_path
    -- while not leaking unrelated subtrees' skill config into a
    -- narrower-scoped board load.
    'node_skill_requirements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', nsr.node_id, 'skill_id', nsr.skill_id)
               ORDER BY nsr.node_id, nsr.skill_id)
      FROM node_skill_requirements nsr
      WHERE nsr.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb),

    'shift_templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', st.id, 'name', st.name,
               'shifts', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'start_min', s.start_min, 'end_min', s.end_min,
                          'breaks', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'id', b.id, 'name', b.name, 'start_min', b.start_min, 'end_min', b.end_min)
                                     ORDER BY b.start_min)
                            FROM shift_breaks b WHERE b.shift_id = s.id
                          ), '[]'::jsonb)
                        ) ORDER BY s.start_min)
                 FROM shifts s WHERE s.template_id = st.id
               ), '[]'::jsonb)
             ) ORDER BY st.name)
      FROM shift_templates st
      WHERE st.id IN (SELECT DISTINCT template_id FROM node_template_map WHERE template_id IS NOT NULL)
    ), '[]'::jsonb),

    'node_shift_map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ntm.node_id, 'template_id', ntm.template_id)
               ORDER BY ntm.node_id)
      FROM node_template_map ntm
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ----------------------------------------------------------------------------
-- capacity_probe: powers the split-coverage popover before commit.
-- ----------------------------------------------------------------------------
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
        AND a.status <> 'cancelled'
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
CREATE OR REPLACE FUNCTION check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange tstzrange)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_policy text;
  v_result jsonb;
BEGIN
  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;
  SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy
    FROM orgs o WHERE o.id = v_org_id;

  WITH required AS (
    SELECT DISTINCT nsr.skill_id
    FROM nodes target
    JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
    JOIN node_skill_requirements nsr ON nsr.node_id = anc.id
    WHERE target.id = p_node_id
  ),
  held AS (
    SELECT os.skill_id, os.expires_at
    FROM operator_skills os
    WHERE os.operator_id = p_operator_id
  ),
  missing AS (
    SELECT r.skill_id FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.skill_id = r.skill_id)
  ),
  expiring AS (
    -- An unbounded upper bound on the window counts as expiring for any
    -- non-null expires_at (brief §4): there is no finite date to compare
    -- against, so any real expiry falls "inside" an open-ended window.
    SELECT r.skill_id, h.expires_at
    FROM required r
    JOIN held h ON h.skill_id = r.skill_id
    WHERE h.expires_at IS NOT NULL
      AND (upper_inf(p_timerange) OR h.expires_at < upper(p_timerange)::date)
  )
  SELECT jsonb_build_object(
    'eligible', (SELECT count(*) FROM missing) = 0 AND (SELECT count(*) FROM expiring) = 0,
    'policy', v_policy,
    'missing_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name))
      FROM missing m JOIN skills s ON s.id = m.skill_id
    ), '[]'::jsonb),
    'expiring_skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'expires_at', e.expires_at))
      FROM expiring e JOIN skills s ON s.id = e.skill_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ============================================================================
-- §5: write functions. All VOLATILE, SECURITY INVOKER, SET search_path.
-- Every one checks app_can_edit_node() on every node it touches before
-- writing anything (RLS would refuse anyway; raising first turns a silent
-- zero-row result into a typed error).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- create_run
-- ----------------------------------------------------------------------------
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
  WHERE node_id = p_node_id AND status <> 'cancelled' AND timerange && p_timerange
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

-- ----------------------------------------------------------------------------
-- create_assignment: the eligibility gate.
-- ----------------------------------------------------------------------------
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
  p_override_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_elig jsonb;
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

  IF NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', p_node_id));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  v_elig := check_eligibility(p_node_id, p_operator_id, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      -- block: no override is possible, regardless of p_eligibility_override.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      -- warn, no override supplied: never silently allow it.
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    END IF;
  END IF;

  -- eligibility_override is only meaningful when it actually overrode a
  -- genuine ineligibility under warn policy (the branch above already
  -- refused to reach here otherwise).
  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  INSERT INTO assignments (
    org_id, node_id, operator_id, run_id, product_id, timerange, efficiency,
    target_qty, target_unit, eligibility_override, override_reason, created_by
  ) VALUES (
    v_org_id, p_node_id, p_operator_id, p_run_id, p_product_id, p_timerange, p_efficiency,
    p_target_qty, p_target_unit,
    v_use_override, CASE WHEN v_use_override THEN p_override_reason ELSE NULL END,
    auth.uid()
  )
  RETURNING * INTO v_assignment;

  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'eligibility', v_elig);
END;
$$;

-- ----------------------------------------------------------------------------
-- move_run: §15.2, atomically.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
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
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;

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

  SELECT COALESCE(o.settings->>'eligibility_policy', 'warn') INTO v_policy FROM orgs o WHERE o.id = v_org_id;

  -- Under block: pre-check every crew member against the target node BEFORE
  -- writing anything, so a violation aborts the whole move with nothing
  -- changed (brief §5: "aborts the whole move ... listing every affected
  -- operator").
  IF v_policy = 'block' THEN
    FOR rec IN
      SELECT a.operator_id, a.timerange FROM assignments a
      WHERE a.run_id = p_run_id AND a.status <> 'cancelled'
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
    SELECT * FROM assignments WHERE run_id = p_run_id AND status <> 'cancelled'
  LOOP
    v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
    v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);

    IF NOT (v_elig->>'eligible')::boolean THEN
      v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                       'missing_skills', v_elig->'missing_skills');
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            eligibility_override = true,
            override_reason = format('run moved to %s', (SELECT name FROM nodes WHERE id = p_node_id))
        WHERE id = rec.id;
    ELSE
      UPDATE assignments SET node_id = p_node_id, timerange = v_new_range WHERE id = rec.id;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.timerange), '[]'::jsonb)
    INTO v_updated_assignments FROM assignments a WHERE a.run_id = p_run_id;

  RETURN jsonb_build_object('run', to_jsonb(v_run), 'assignments', v_updated_assignments,
                             'eligibility_warnings', v_warnings);
END;
$$;

-- ----------------------------------------------------------------------------
-- apply_split_coverage: §15.1 split-coverage commit. Adjustments FIRST, then
-- the new assignment -- see the comment inline, and brief §5 / acceptance
-- item 20 for why this ordering is load-bearing, not stylistic.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_split_coverage(p_adjustments jsonb, p_new_assignment jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adj jsonb;
  v_assignment_id uuid;
  v_efficiency numeric;
  v_node_id uuid;
  v_adjusted jsonb := '[]'::jsonb;
  v_new_json jsonb := 'null'::jsonb;
BEGIN
  -- ---- Validate shapes first, before touching any row. ----
  IF p_adjustments IS NULL OR jsonb_typeof(p_adjustments) <> 'array' THEN
    PERFORM api_raise('invalid_argument', 'p_adjustments must be a JSON array',
      jsonb_build_object('field', 'p_adjustments', 'reason', 'missing or not an array'));
  END IF;

  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    IF (v_adj->>'assignment_id') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'adjustment missing assignment_id',
        jsonb_build_object('field', 'assignment_id', 'reason', 'missing'));
    END IF;
    IF (v_adj->>'efficiency') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'adjustment missing efficiency',
        jsonb_build_object('field', 'efficiency', 'reason', 'missing'));
    END IF;
  END LOOP;

  IF p_new_assignment IS NOT NULL THEN
    IF (p_new_assignment->>'node_id') IS NULL OR (p_new_assignment->>'operator_id') IS NULL
       OR (p_new_assignment->>'timerange') IS NULL THEN
      PERFORM api_raise('invalid_argument', 'p_new_assignment missing a required field',
        jsonb_build_object('field', 'p_new_assignment', 'reason', 'missing node_id/operator_id/timerange'));
    END IF;
  END IF;

  -- ---- Edit-rights check on every node touched, before any write. ----
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    SELECT node_id INTO v_node_id FROM assignments WHERE id = (v_adj->>'assignment_id')::uuid;
    IF v_node_id IS NULL OR NOT app_can_edit_node(v_node_id) THEN
      PERFORM api_raise('not_permitted', 'no edit rights on an adjusted assignment''s node',
        jsonb_build_object('node_id', v_node_id));
    END IF;
  END LOOP;
  IF p_new_assignment IS NOT NULL AND NOT app_can_edit_node((p_new_assignment->>'node_id')::uuid) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on the new assignment''s node',
      jsonb_build_object('node_id', (p_new_assignment->>'node_id')::uuid));
  END IF;

  -- ---- Apply the adjustments FIRST, then the new assignment. ----
  -- The capacity trigger (assignments_capacity) fires per row: on UPDATE OF
  -- efficiency for the dial-downs below, and on INSERT for the new
  -- assignment. If the new assignment were inserted BEFORE the existing
  -- rows were dialled down, its capacity check would run against the
  -- un-adjusted (higher) peak and the whole transaction would be rejected
  -- even though the end state is legal -- adjust-then-insert is the entire
  -- reason this function exists instead of the client sending three
  -- separate writes. Do NOT reorder this: acceptance item 20 rolls back an
  -- explicit insert-before-adjust attempt to prove it fails.
  FOR v_adj IN SELECT * FROM jsonb_array_elements(p_adjustments)
  LOOP
    v_assignment_id := (v_adj->>'assignment_id')::uuid;
    v_efficiency := (v_adj->>'efficiency')::numeric;
    UPDATE assignments SET efficiency = v_efficiency WHERE id = v_assignment_id;
    v_adjusted := v_adjusted || (SELECT to_jsonb(a) FROM assignments a WHERE a.id = v_assignment_id);
  END LOOP;

  IF p_new_assignment IS NOT NULL THEN
    v_new_json := create_assignment(
      (p_new_assignment->>'node_id')::uuid,
      (p_new_assignment->>'operator_id')::uuid,
      (p_new_assignment->>'run_id')::uuid,
      (p_new_assignment->>'product_id')::uuid,
      (p_new_assignment->>'timerange')::tstzrange,
      COALESCE((p_new_assignment->>'efficiency')::numeric, 1.000),
      (p_new_assignment->>'target_qty')::numeric,
      p_new_assignment->>'target_unit',
      COALESCE((p_new_assignment->>'eligibility_override')::boolean, false),
      p_new_assignment->>'override_reason'
    );
    v_new_json := v_new_json->'assignment';
  END IF;

  RETURN jsonb_build_object('adjusted', v_adjusted, 'assignment', v_new_json);
END;
$$;

-- ----------------------------------------------------------------------------
-- delete_run: two modes, per §14.1's hybrid model.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_run(p_run_id uuid, p_mode text DEFAULT 'cascade')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_node_id uuid;
  v_product_id uuid;
  v_detached_ids jsonb := '[]'::jsonb;
BEGIN
  IF p_mode NOT IN ('cascade', 'detach') THEN
    PERFORM api_raise('invalid_argument', 'p_mode must be ''cascade'' or ''detach''',
      jsonb_build_object('field', 'p_mode', 'reason', format('unrecognised mode %s', p_mode)));
  END IF;

  SELECT node_id, product_id INTO v_node_id, v_product_id FROM runs WHERE id = p_run_id;
  IF v_node_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'run not found', jsonb_build_object('field', 'p_run_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', v_node_id));
  END IF;

  IF p_mode = 'cascade' THEN
    DELETE FROM assignments WHERE run_id = p_run_id;
  ELSE -- detach: run-attached -> direct, carrying the run's product.
    SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_detached_ids
      FROM assignments WHERE run_id = p_run_id;

    UPDATE assignments SET product_id = v_product_id, run_id = NULL WHERE run_id = p_run_id;
  END IF;

  DELETE FROM runs WHERE id = p_run_id;

  RETURN jsonb_build_object('deleted_run_id', p_run_id, 'detached_assignment_ids', v_detached_ids);
END;
$$;

-- ============================================================================
-- §6: grants.
--
-- CORRECTION vs the brief's literal §6 template: PostgreSQL grants EXECUTE
-- on newly created functions to PUBLIC by default (functions are NOT like
-- tables here -- tables get no default PUBLIC privileges, functions do; see
-- PostgreSQL docs on default privileges). The brief's snippet only
-- `REVOKE ALL ... FROM anon`, which never touches that separate PUBLIC
-- grant, so anon would still execute every RPC through it and acceptance
-- item 27 ("as anon, every function raises permission-denied") would
-- silently fail. Every function below has EXECUTE revoked from PUBLIC
-- explicitly (unconditional -- PUBLIC always exists), in addition to the
-- brief's guarded anon-specific revoke.
-- ============================================================================
REVOKE EXECUTE ON FUNCTION board_window(ltree,timestamptz,timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION capacity_probe(uuid,tstzrange,numeric,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION check_eligibility(uuid,uuid,tstzrange) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_run(uuid,uuid,tstzrange,int,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION move_run(uuid,uuid,tstzrange) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_split_coverage(jsonb,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_run(uuid,text) FROM PUBLIC;
-- operator_peak_load / api_raise are internal helpers, not part of the
-- client contract (brief §6), but still need EXECUTE for `authenticated`
-- because SECURITY INVOKER means the caller's own privileges apply all the
-- way down the call chain -- see the guarded GRANT block below.
REVOKE EXECUTE ON FUNCTION operator_peak_load(uuid,tstzrange,numeric,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION api_raise(text,text,jsonb) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION board_window(ltree,timestamptz,timestamptz) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION capacity_probe(uuid,tstzrange,numeric,uuid) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION check_eligibility(uuid,uuid,tstzrange) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION create_run(uuid,uuid,tstzrange,int,text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION move_run(uuid,uuid,tstzrange) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION apply_split_coverage(jsonb,jsonb) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION delete_run(uuid,text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION operator_peak_load(uuid,tstzrange,numeric,uuid) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION api_raise(text,text,jsonb) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION board_window(ltree,timestamptz,timestamptz) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION capacity_probe(uuid,tstzrange,numeric,uuid) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION check_eligibility(uuid,uuid,tstzrange) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION create_run(uuid,uuid,tstzrange,int,text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION move_run(uuid,uuid,tstzrange) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION apply_split_coverage(jsonb,jsonb) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION delete_run(uuid,text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION operator_peak_load(uuid,tstzrange,numeric,uuid) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION api_raise(text,text,jsonb) FROM anon';
  END IF;
END $$;
