-- ============================================================================
-- Migration 0051: the BOARD asks the plant, not the company.
--
-- 0050 made `eligibility_policy` answerable per node and taught every SERVER
-- reader to resolve it: `check_eligibility`, `move_run`, `create_assignment`
-- and `apply_split_coverage` all go through `app_resolve_node_setting` now. THE
-- BOARD WAS NOT TOLD. `board_window` sent `org.settings` and nothing else,
-- `boardIndex.ts` read `eligibility_policy` out of that one bag, and
-- `CreatePopover` applied the company's answer to every cell on the screen.
--
-- So on a plant somebody had deliberately set to `block`, the popover still
-- offered an OVERRIDE TICK and a reason box; the planner filled them in, pressed
-- Create, and the server refused the write. A dead end, not a warning -- the
-- same shape as F-087, which 0048 fixed for lapsed certificates the same day,
-- and the same lesson: A SCREEN THAT OFFERS WHAT THE SERVER WILL REFUSE IS
-- WORSE THAN ONE THAT REFUSES WHAT THE SERVER ALLOWS.
--
-- Implements: R-331 (the client half). Refs: 0050 (the resolver and the table),
-- 0048 (the last key added to this function), F-087, D64 (the override tick).
-- Proved by: supabase/tests/74_board_plant_policy_test.sql.
--
-- ----------------------------------------------------------------------------
-- ⛔ WHY THE ROWS ARE NOT SENT AND RESOLVED IN THE BROWSER.
--
-- The cheap version of this change is to add `node_settings` to the payload and
-- let `boardIndex.ts` walk the ltree ancestry it already walks for shift
-- templates and skill requirements. IT FAILS OPEN, and measurably so.
--
-- `board_window` is SECURITY INVOKER and `node_settings_select` is
-- `org_id = app_current_org() AND app_can_read_node(node_id)`. A supervisor
-- granted `plant_1.assembly` CANNOT READ `plant_1`, so they never receive the
-- override row that lives on the plant root. Their browser would find no answer
-- in the ancestry it can see, fall through to `orgs.settings`, and draw an
-- override tick on a plant that is set to refuse -- the safety rule failing open
-- for precisely the people who use it all day. That is 0023's defect in a new
-- place, and it is why `app_resolve_node_setting` was written SECURITY DEFINER
-- in the first place (0050 §3 spells it out at length).
--
-- ⭐ SO THE VALUE IS RESOLVED HERE, ON THE SERVER, ONE PER NODE. 74's N5b
-- measures the ground this stands on -- the supervisor can read ZERO
-- `node_settings` rows and cannot see the plant root -- and N5 measures that her
-- board carries `block` on every cell anyway.
--
-- ⚠️ COST, MEASURED RATHER THAN ASSUMED: `app_resolve_node_setting` is one
-- indexed ltree ancestor join per node, ~0.09 ms/node (53 nodes in 4.7 ms on
-- this machine). A board window is tens of nodes, not thousands, and the same
-- payload already runs `resolve_shift_template` once per node beside it.
--
-- ----------------------------------------------------------------------------
-- ⚠️ THIS IS `CREATE OR REPLACE` OVER A LARGE FUNCTION THAT WAS ALREADY
-- RE-CREATED ONCE TODAY. 0048 added `skill_expiries` to `operators`; 0042 added
-- `offered_node_ids` to `products`. THE BODY BELOW WAS EXTRACTED WITH
-- `pg_get_functiondef` FROM THE LIVE DATABASE AND ONE KEY WAS INSERTED --
-- nothing else in it was typed. 74's N8 lists every top-level key and both of
-- those nested ones and goes red if any of them is dropped.
--
-- No signature change, so every existing GRANT survives and the generated
-- TypeScript for the RPC is unchanged apart from the payload's shape.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.board_window(p_root_path ltree, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- DEF-0005: the ANSWER, computed where the authority is. See the header.
  offered_here AS (
    SELECT op.product_id, op.node_id FROM app_offered_product_nodes(p_root_path) op
  ),
  scoped_templates AS (
    SELECT DISTINCT hl.template_id
    FROM scoped_nodes sn JOIN hierarchy_levels hl ON hl.id = sn.level_id
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
               'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
               'name', hl.name, 'is_schedulable', hl.is_schedulable)
             ORDER BY hl.template_id, hl.position)
      FROM hierarchy_levels hl
      WHERE hl.org_id = v_org_id
        AND hl.template_id IN (SELECT template_id FROM scoped_templates)
    ), '[]'::jsonb),

    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sn.id, 'parent_id', sn.parent_id, 'level_id', sn.level_id,
               'name', sn.name, 'path', sn.path::text, 'sort_order', sn.sort_order,
               'active', sn.active) ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    -- ⭐⭐ THE KEY THIS MIGRATION EXISTS FOR (R-331). One resolved answer per
    -- node in the window, so the popover can ask the CELL what the rule is
    -- instead of asking the company. Built off `scoped_nodes`, so it covers
    -- exactly the nodes `nodes` above sends and no others -- a node in one
    -- list and not the other is a cell the client cannot decide about.
    --
    -- ⛔ `app_resolve_node_setting` AND NOT THE RAW `node_settings` ROWS. This
    -- function is SECURITY INVOKER; `node_settings_select` is gated on
    -- `app_can_read_node`. A supervisor granted a LINE never receives the row
    -- sitting on the PLANT ROOT, so a browser handed those rows and told to
    -- walk the ancestry would miss the override and fall through to the
    -- company's default -- a `block` plant reading as `warn` for exactly the
    -- people who schedule against it all day. The resolver is SECURITY DEFINER
    -- for that reason (0050 §3), so the walk happens where the authority is.
    --
    -- ⚠️ THE COALESCE TO 'warn' IS THE KEY'S OWN DEFAULT, kept at the call site
    -- exactly as `check_eligibility` keeps it (0050 §5) -- the resolver returns
    -- NULL when nobody has an answer, and inventing one inside it would answer
    -- 'warn' for keys that have nothing to do with eligibility. This value and
    -- `check_eligibility`'s `policy` are therefore the SAME expression, which
    -- is what 74's N7 measures node by node.
    'node_policies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'node_id', sn.id,
               'eligibility_policy',
               COALESCE(app_resolve_node_setting(sn.id, 'eligibility_policy'), 'warn'))
             ORDER BY sn.path)
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
               'site_node_id', op.site_node_id,
               'skill_ids', COALESCE((
                 SELECT jsonb_agg(os.skill_id) FROM operator_skills os WHERE os.operator_id = op.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (F-087). `skill_ids` above
               -- answers "was this person ever trained"; this answers "and is
               -- that certificate still good", which is the question
               -- `check_eligibility` actually decides on. Only the DATED rows
               -- are listed -- an undated certificate never expires, and its
               -- absence here says so once rather than twice.
               'skill_expiries', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('skill_id', os.skill_id,
                                                     'expires_at', os.expires_at)
                          ORDER BY os.skill_id)
                 FROM operator_skills os
                 WHERE os.operator_id = op.id AND os.expires_at IS NOT NULL
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      FROM operators op WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active,
               'color_token', p.color_token,
               'site_node_ids', COALESCE((
                 SELECT jsonb_agg(ps.node_id) FROM product_sites ps WHERE ps.product_id = p.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (DEF-0005). Which nodes IN
               -- THIS WINDOW is this part offered at, asked of the same test the
               -- write guard runs. `site_node_ids` above is the raw place list
               -- and stays exactly as it was -- the admin screens and the
               -- deleted-product path in history.ts read it -- but it is
               -- RLS-filtered, so a supervisor granted a LINE sees `[]` for a
               -- part made at the PLANT and cannot tell that from a part that
               -- is made nowhere.
               'offered_node_ids', COALESCE((
                 SELECT jsonb_agg(oh.node_id) FROM offered_here oh WHERE oh.product_id = p.id
               ), '[]'::jsonb)) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'site_node_id', s.site_node_id) ORDER BY s.name)
      FROM skills s WHERE s.org_id = v_org_id
    ), '[]'::jsonb),

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
      FROM node_template_map ntm WHERE ntm.template_id IS NOT NULL
    ), '[]'::jsonb),

    'cycle_times', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ct.node_id, 'product_id', ct.product_id,
                                          'seconds_per_unit', ct.seconds_per_unit)
               ORDER BY ct.node_id, ct.product_id)
      FROM node_product_cycle_times ct
      WHERE ct.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$

;

comment on function board_window(ltree, timestamptz, timestamptz) is
  'Unchanged from 0048 apart from ONE added key: `node_policies`, one row per node in the window carrying `COALESCE(app_resolve_node_setting(node, ''eligibility_policy''), ''warn'')` -- the same expression check_eligibility resolves its own `policy` from, so the board reaches the server''s answer instead of applying orgs.settings to every plant. R-331. Resolved HERE and not in the browser because node_settings is RLS-scoped and a supervisor granted a line cannot read the plant root''s override; app_resolve_node_setting is SECURITY DEFINER for that reason.';
