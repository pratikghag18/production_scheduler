-- ===========================================================================
-- 0042 - THE BOARD ASKS THE SERVER WHICH PARTS IT MAY OFFER (DEF-0005).
--
-- THE DEFECT. A supervisor granted ONE LINE opened her own board and was
-- offered ONE part out of the four on her own legend, while the server accepted
-- all four. Nothing on the screen said why; the picker simply did not list them.
--
-- THE CAUSE IS AN AMBIGUOUS EMPTY LIST, and it is a client-side consequence of
-- a server-side truth. `board_window` is SECURITY INVOKER, so its
-- `product_sites` sub-select runs under `product_sites_select` (0034 s8):
-- `app_can_read_node(node_id)`. Reading is DOWNWARD from a grant, so a
-- supervisor granted a line cannot read the plant, and a plant-wide part's only
-- place row is dropped before it reaches the client. The client then answers
-- "offered nowhere" -- which is the right answer for the list it was handed.
-- TWO DIFFERENT STATES ARRIVE AS THE SAME EMPTY ARRAY: "assigned to no plant"
-- (the honest zero the board's history code leans on) and "every place is above
-- your grant". No amount of care on the client can tell them apart, because the
-- information was removed before it got there.
--
-- SO THE FIX IS NOT TO SHOW MORE, IT IS TO ASK BETTER. CLAUDE.md s4: whatever a
-- client hides or offers must be decided by the same test the server runs. The
-- board now receives, per product, the nodes IN ITS OWN WINDOW where that
-- product is offered -- the answer, not the raw material for one.
-- `app_product_offered_at` has been SECURITY DEFINER since 0034 for exactly
-- this reason: what a constraint may ASK does not depend on what the reader may
-- LIST.
--
-- WHY NOT WIDEN `product_sites_select` INSTEAD, which was the other option on
-- the table. Letting a reader SEE a place row for a node they cannot read
-- changes a read policy -- it would hand a line supervisor the id and existence
-- of a plant they have no grant on, for every part, and would need its own
-- cross-tenant case to show it leaks nothing further. Answering the question
-- server-side changes no policy at all and discloses strictly less: only node
-- ids the caller can already read, from their own window, in their own org.
--
-- THE HELPER IS SECURITY DEFINER AND THEREFORE FILTERS ITS OWN OUTPUT. It
-- bypasses RLS on `product_sites` on purpose -- that is the whole point -- so
-- it must not also bypass it on `nodes`. Every row it returns is a node the
-- caller passes `app_can_read_node` on, inside `p_root_path`, inside
-- `app_current_org()`. A caller who asks about a root above their grant gets
-- nothing back for the part of it they cannot read, which is what
-- `board_window`'s own `scoped_nodes` (SECURITY INVOKER, RLS-filtered) already
-- does one line above.
--
-- APPEND-ONLY, and `board_window` is re-created here in full, EXTRACTED from
-- its LAST definition (0040) rather than retyped -- CLAUDE.md s4. Two changes:
-- one CTE, and one key beside `site_node_ids`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- s1. The answer, computed where the authority is.
-- ---------------------------------------------------------------------------
create or replace function app_offered_product_nodes(p_root_path ltree)
returns table (product_id uuid, node_id uuid)
language sql stable security definer set search_path = public, pg_temp as $fn$
  SELECT DISTINCT ps.product_id, n.id
    FROM product_sites ps
    JOIN nodes o ON o.id = ps.node_id AND o.org_id = app_current_org()
    JOIN nodes n ON n.org_id = app_current_org()
                AND n.path <@ p_root_path
                AND o.path @> n.path
   WHERE ps.org_id = app_current_org()
     AND app_can_read_node(n.id);
$fn$;

comment on function app_offered_product_nodes(ltree) is
  'DEF-0005: for a board window, which (product, node) pairs are OFFERED - the set form of app_product_offered_at, answered under SECURITY DEFINER so an RLS-filtered place list cannot make a part the server accepts look like a part made nowhere. Self-scoped to app_current_org(), and every node returned is one the caller passes app_can_read_node on, so it discloses no node the caller could not already read.';

revoke execute on function app_offered_product_nodes(ltree) from public;

do $grants$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_offered_product_nodes(ltree) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_offered_product_nodes(ltree) from anon';
  end if;
end $grants$;

-- ---------------------------------------------------------------------------
-- s2. board_window carries the answer. Extracted from 0040, two changes.
-- ---------------------------------------------------------------------------
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
$function$;
comment on function public.board_window(ltree, timestamptz, timestamptz) is
  'The board read. Unchanged from 0040 apart from one added key: products[].offered_node_ids, the nodes in THIS window where each part is offered, answered through app_offered_product_nodes (SECURITY DEFINER) so that an RLS-filtered site_node_ids can no longer make a part the server accepts look like a part made nowhere (DEF-0005). site_node_ids keeps its old meaning: the raw, reader-scoped place list. Still SECURITY INVOKER, so every other key stays RLS-scoped to the caller.';
