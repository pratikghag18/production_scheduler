-- =============================================================================
-- 0025 — "BELONGS TO" BECOMES A SCOPE (D103), AND A COLOUR MAY BE A COLOUR
--
-- Pratik, Aug 27: *"The products/operators/shifts could belong to a particular
-- hierarchy within the plant and not necessarily to the whole plant... how do
-- we assign them to a specific hierarchy level so the lower levels inherit
-- them?"* — and, shown the two things that sentence could mean side by side, he
-- picked the larger: **belonging decides WHERE a thing is offered, not only who
-- may edit it.** Design plan §19.65 / D103.
--
-- ⭐ THIS MIGRATION IS A WIDENING AND NOTHING IS BACKFILLED. Every existing row
-- holds NULL (company-wide) or a ROOT node id, and both stay exactly as legal
-- as they were. All this file does is stop one trigger REQUIRING a root, widen
-- one CHECK, and add three fields to one read. There is no data transform, so
-- §19.44's `UPGRADE_CHECKS` pattern has nothing to assert about a transform —
-- but [[verification-standard]] rule 5b says the ARGUMENT for skipping a test
-- is not the evidence, so `upgrade_0025_scope_widening.sql` plants a pre-0025
-- row set and proves the widening admits what it should and still refuses what
-- it must.
--
-- ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT DO.
--
--   1. **No policy changes at all.** The write policies ask
--      `app_is_admin_for(site_node_id)`, and that predicate has taken ANY node
--      and covered its subtree since 0019 — only the trigger was forcing roots.
--      A migration that widens a value and leaves every policy alone is one
--      whose blast radius can be read off the diff.
--   2. **No filtering.** Deciding what is OFFERED at a node is the CLIENT's
--      job, because one `board_window` call spans many nodes and there is no
--      single node to filter by. This file only makes the scope VISIBLE in that
--      read; §3 is the whole of it.
--   3. **Nothing about the operators' AREA RULE.** Pratik has since asked for
--      an out-of-area assignment to be refused with a supervisor override, and
--      that is a change to `check_eligibility` and `assign_operator` with its
--      own cases. Widening `operators.site_node_id` here is what it builds on.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §1. THE TRIGGER STOPS REQUIRING A ROOT.
--
-- 0023 §2 wrote this to keep the four shared lists owned by a SITE, reasoning
-- that ownership is a permission question and permissions are granted per site.
-- That was right about permissions and wrong about what the column would end up
-- meaning: under D103 the column also says WHERE the thing applies, and
-- "applies to Assembly and everything under it" is a sentence the product has
-- to be able to express.
--
-- ⭐ THE ORG SCOPE AND THE "NOT FOUND" BRANCH BOTH STAY — they are the whole
-- point of the function. Exactly one branch is deleted.
--
-- ⚠️ IT REMAINS SECURITY DEFINER, and 0023's oracle note still applies: a caller
-- who may write any of these tables learns, for a uuid they cannot SELECT,
-- whether it exists in their org. Uuids are unguessable; recorded, not closed.
-- -----------------------------------------------------------------------------
create or replace function app_check_site_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_found boolean;
begin
  if new.site_node_id is null then
    return new;
  end if;

  select true into v_found
    from nodes where id = new.site_node_id and org_id = new.org_id;

  if v_found is not true then
    perform api_raise('invalid_argument', 'the node this belongs to was not found in this org',
      jsonb_build_object('field', 'site_node_id', 'reason', 'not found'));
  end if;

  return new;
end;
$$;

comment on function app_check_site_owner() is
  'Enforces that a shared-list row belongs to a node in its OWN org (0023, widened by 0025/D103). Any node at any level: the scope is inherited downward by everything at or below it, so "Assembly" means Assembly and every line and cell under it. NULL = company-wide. SECURITY DEFINER so it can tell "no such node" from "a node you cannot see" -- the permission question belongs to the policy, and app_is_admin_for(site_node_id) has covered any node and its subtree since 0019. WARNING: it is therefore an oracle over node ids -- a caller who may write any of these tables learns, for a uuid they cannot SELECT, whether it exists in their org. Uuids are unguessable, so this is recorded rather than closed.';

comment on column products.site_node_id is
  'The node this product BELONGS TO (0023, redefined by 0025/D103). NULL = company-wide. Not merely who may edit it: everything at or below this node may use the product and nothing outside it may. Resolution is target.path <@ scope.path, the same shape as resolve_shift_template.';
comment on column operators.site_node_id is
  'The node this person BELONGS TO (0023, redefined by 0025/D103). NULL = company-wide. WARNING: in 0025 this filters the roster and nothing else. Whether an assignment OUTSIDE it is refused is a separate migration; see this file header.';
comment on column skills.site_node_id is
  'The node this training BELONGS TO (0023, redefined by 0025/D103). NULL = company-wide. WARNING: training NAMES remain unique per ORG (Pratik, Aug 27) -- the scope says where it is offered, never that two sites may hold the same name.';
comment on column shift_templates.site_node_id is
  'The node this pattern BELONGS TO (0023, redefined by 0025/D103). NULL = company-wide. WARNING: distinct from ATTACHMENT -- node_shift_templates says which node RUNS a pattern and needs app_is_admin_for(node_id); this says who owns it and where it is offered.';

-- -----------------------------------------------------------------------------
-- §2. A COLOUR MAY NOW BE A COLOUR.
--
-- Pratik, Aug 27: *"The color should show a colour picker and an ability to
-- enter hex code."*
--
-- ⭐ D102's PALETTE ARGUMENT SURVIVES AND IS NOT WEAKENED. The column holds a
-- TOKEN NAME so the four board colours can be restyled in one place and so
-- nothing can store a colour the stylesheet does not define. Both still hold
-- for the four: they remain the presets, they remain what a new product is
-- given, and `var(--product-N)` is still how they render. What is added is a
-- second, explicitly-marked form for the case the palette cannot serve — more
-- than four products in one area that have to be told apart.
--
-- ⚠️ SO THE CHECK IS A UNION, NOT A REPLACEMENT, and the two shapes stay
-- disjoint. A six-digit LOWER-CASE hex only: no 3-digit form, no named colours,
-- no `rgb()`. One canonical spelling per colour is what lets the client decide
-- how to render by looking at the first character, and what stops `#FFF`,
-- `#ffffff` and `white` being three rows that mean one thing.
--
-- ⚠️ AND THE BOARD MIXES THIS COLOUR INTO `--surface` (`color-mix(... 16%)` in
-- `RunBand` and `DirectBlock`, a 3-4px left border in `AssignmentChip`), so a
-- hex is a FILL and never a text colour — there is no contrast obligation on it.
-- There is also no theme to adapt to: `tokens.css` defines no dark variant of
-- `--product-N` today. If a dark theme ever lands the four tokens follow it and
-- a stored hex does not. That is the cost of the freedom, recorded here so
-- nobody has to rediscover it.
-- -----------------------------------------------------------------------------
alter table products drop constraint products_color_token_shape;
alter table products add constraint products_color_token_shape
  check (color_token is null
      or color_token ~ '^product-[1-9][0-9]*$'
      or color_token ~ '^#[0-9a-f]{6}$');

comment on column products.color_token is
  'How this product is drawn on the board. EITHER a palette token name (product-1 .. product-4, defined in tokens.css and chosen automatically at INSERT by products_set_color_token) OR a literal lower-case six-digit hex (#1baf7a) set by hand. NOT NULL. WARNING: a token follows the stylesheet, a hex does not. The trigger only ever writes tokens, so a hex is always a deliberate human choice.';

-- -----------------------------------------------------------------------------
-- §3. THE READ CARRIES THE SCOPE.
--
-- Three fields added to `board_window`: `site_node_id` on operators, on products
-- and on skills. Extracted from the LIVE database with `pg_get_functiondef` and
-- edited by string replacement ([[verification-standard]] rule 12), because this
-- function has been re-emitted by 0014 and again by 0023 and the file that first
-- created it is two definitions out of date.
--
-- ⭐ WHY THE CLIENT FILTERS AND NOT THIS FUNCTION. One call returns a whole
-- board window — every node under `p_root_path`, which is many nodes — so there
-- is no single node to filter "which products apply here" by. The client already
-- receives every node's `path` in the same payload and can answer per cell for
-- free. Filtering here would mean either one call per cell, or one answer that
-- is wrong for all but one of them.
--
-- ⚠️ AND FILTERING WHAT IS OFFERED MUST NOT UN-SCHEDULE HISTORY. A product moved
-- under Line 1 today was legitimately run on Line 2 yesterday and that run must
-- keep rendering it. So this function keeps returning the WHOLE org's products
-- and trainings and merely says where each belongs: the list a picker OFFERS is
-- a narrower thing than the list a board must be able to DRAW, and a
-- server-side filter would collapse the two into one.
-- -----------------------------------------------------------------------------

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
               'color_token', p.color_token, 'site_node_id', p.site_node_id) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'site_node_id', s.site_node_id) ORDER BY s.name)
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
$function$;
