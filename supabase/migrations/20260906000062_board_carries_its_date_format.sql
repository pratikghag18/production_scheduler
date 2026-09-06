-- ============================================================================
-- 20260906000062_board_carries_its_date_format.sql -- DEF-0017 (R-333).
--
-- A line supervisor's board showed the COMPANY date format while the server
-- said her line used the PLANT's. `useDateFormat(enabled, root)` answered the
-- ROOT node's OWN node_settings row, else the company value -- and a board
-- rooted at a LINE has no row of its own, while the plant's row sits above her
-- grant where `node_settings_select` (SECURITY INVOKER) will not hand it to
-- her. So the client could never reach the plant's choice, though the server
-- already knew it: `app_resolve_node_setting` (0050, SECURITY DEFINER) walks
-- the ancestry, and `board_window` already carries the resolved
-- `eligibility_policy` per node in `node_policies` (R-331).
--
-- THE FIX MIRRORS node_policies. `board_window` gains ONE top-level key,
-- `date_format`, resolved for the board's own root through the same SECURITY
-- DEFINER resolver, and `BoardPage` reads it off the payload instead of the
-- root's own override. One resolved answer, computed where the authority is.
--
-- RE-EMITTED WHOLE FROM 0058 BY EXTRACTION (0058's own discipline). The only
-- edit is the `date_format` key, inserted beside `can_place`; every other key
-- is 0058's text byte-for-byte. A parallel lane's 0061 re-emits
-- resolve_shift_template only and does not touch board_window, so this is the
-- last board_window definition.
--
-- GRANTS: CREATE OR REPLACE preserves the EXECUTE grants set in 0009 (to
-- `authenticated`, revoked from `anon`/PUBLIC), exactly as 0058 relied on.
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

    -- R-346, the viewer clause (session 79): may this person PLACE people
    -- somewhere on this board? An edit grant (supervisor or admin) covering
    -- the board's place or inside it, or the company admin. The screen hides
    -- the Operators panel and every "other people" control when this is
    -- false --- "for a viewer, the left panel serves no purpose". Decided here,
    -- with app_grant_paths(true), the same set the write policies bind.
    'can_place', (app_is_admin()
                  OR EXISTS (SELECT 1 FROM app_grant_paths(true) gp
                              WHERE p_root_path <@ gp OR gp <@ p_root_path)),

    -- THE KEY THIS MIGRATION EXISTS FOR (DEF-0017, R-333). The date format
    -- RESOLVED for the board's own root, so a supervisor whose board is rooted
    -- at a LINE inside a plant that set its own format sees the PLANT's choice,
    -- not the company default. `useDateFormat(enabled, root)` read the ROOT's
    -- OWN node_settings row (none, for a line) and fell through to the company
    -- value; the plant's row sits above her grant and `node_settings_select`
    -- would not hand it to her. `app_resolve_node_setting` is SECURITY DEFINER
    -- and walks the ancestry where the authority is, exactly as `node_policies`
    -- above does for the eligibility policy.
    --
    -- COALESCE TO 'd_mon_yyyy' IS THE KEY'S OWN DEFAULT kept at the call
    -- site, the same way `node_policies` COALESCEs to 'warn'. The resolver
    -- returns NULL when nobody has an answer, and the seed's company bag carries
    -- no `date_format` key at all -- so a board with no override anywhere would
    -- otherwise send a JSON null, which the client parses into the CLOSED
    -- DateFormat enum and would reject as a shape mismatch, blanking the whole
    -- board. 'd_mon_yyyy' is the client's DEFAULT_DATE_FORMAT (src/lib/format/
    -- dates.ts), so the two agree on the pre-setting shape.
    'date_format', COALESCE(
      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),
                               'date_format'), 'd_mon_yyyy'),

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
               -- R-346. The home's PATH, so the screen can tell "homed above
               -- this cell" (available by default) from "homed in another area
               -- of this plant" (behind the click) WITHOUT being able to read
               -- the nodes above its own grant. `nodes` is RLS-scoped and
               -- `nodes_select` is `path <@ grant`, DESCENDANTS ONLY, so a line
               -- supervisor cannot resolve the home of anyone owned by the
               -- plant or by the area above them -- joining `nodes` here would
               -- have dropped exactly the people the maintainer was missing.
               -- The path therefore comes from a SECURITY DEFINER helper, for
               -- the same reason `app_resolve_node_setting` is one (0051).
               'site_path', oh.site_path::text,
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
      -- R-345/R-346. THE PLANT'S PEOPLE, not the company's. The join is an
      -- INNER one against a SECURITY DEFINER helper restricted to the board's
      -- own plant, so a person homed in another plant is not in the payload at
      -- all -- they can no longer be placed here (R-345), so offering them was
      -- only ever a dead end. `operators` itself stays RLS-filtered (this
      -- function is SECURITY INVOKER), so the helper widens the SHAPE of the
      -- list and `operators_select` still decides who is in it.
      FROM operators op
      JOIN app_operator_homes(p_root_path) oh ON oh.operator_id = op.id
      WHERE op.org_id = v_org_id
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
$function$;

comment on function board_window(ltree, timestamptz, timestamptz) is
  'Unchanged from 0058 apart from ONE new top-level key, date_format (DEF-0017, R-333): the calendar-date display format RESOLVED for the board''s own root through app_resolve_node_setting (SECURITY DEFINER, 0050), COALESCEd to d_mon_yyyy (the key''s own default) so the payload always carries a valid closed-enum token. It is the date-format twin of node_policies eligibility_policy (R-331): a line supervisor cannot read the override on her plant root, so a browser-side walk would fall through to the company default and show the wrong format on a plant that chose otherwise. Everything else is 0058''s text: the operators array is the people whose HOME IS IN THE BOARD''S PLANT (R-346), each carrying site_path, the home node''s ltree path as text, from app_operator_homes (SECURITY DEFINER because nodes_select is descendants-only). A person from another plant is not sent at all, because R-345 means they can no longer be placed here.';
