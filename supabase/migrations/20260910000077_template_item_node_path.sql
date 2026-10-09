-- ============================================================================
-- 0077 --- "SHOW CONTENTS" NAMES THE LINE/CELL, NOT JUST THE LEAF (R-356 surface).
--
-- The maintainer, 10 Sept, on 0075's new "Show contents" view: *"show contents
-- don't [show] what line or sub-hierarchy level the template is for ... All
-- nodes are important in the hierarchy ... we have dynamic hierarchy levels
-- for plants, they could be anything. It should adapt to the plant
-- hierarchy."* `list_week_template_items` returned only `n.name` (the leaf),
-- and the client rendered that as the faintest, smallest text on the row.
-- This migration is APPEND-ONLY over 0075: the whole function body is
-- re-emitted verbatim, with exactly one addition, `node_path`, alongside the
-- `node_name` it already carried.
--
-- ⭐ THE PATH IS RELATIVE TO THE PLANT, NOT THE ORG ROOT, AND ADAPTS TO ANY
-- DEPTH. A plant's hierarchy levels are dynamic per org (0067's own header:
-- "Standard Plant" is Site/Department/Line/Work Cell, four deep; another org
-- could be two, or six) --- so `node_path` cannot be a fixed number of joins.
-- It is built from the ltree `path` itself: every ancestor-or-self of the
-- item's node (`n.path <@ a.path`) whose own depth is BELOW the plant root's
-- (`nlevel(a.path) > nlevel(vp.path)`, `vp` being the plant node the template
-- belongs to), joined in path order by `string_agg(..., ORDER BY
-- nlevel(a.path))`. Excluding the plant root and everything above it is what
-- makes the label relative --- "Assembly > Line 1", not "Acme Co > Plant T >
-- Assembly > Line 1" repeating what the panel's own plant heading already
-- says. A node that no longer resolves (0067 D110: `node_id` carries no FK)
-- makes the whole subquery return NULL, same as `node_name`'s existing LEFT
-- JOIN --- there is nothing to walk ancestors from once the row itself is
-- gone, and the client already shows "(removed)" for that case.
--
-- ⭐ THE PLANT ROOT ITSELF FALLS BACK TO ITS OWN NAME. If a run is placed
-- directly ON the plant node (no sub-hierarchy under it, or a run scheduled
-- at the top level), the ancestors-strictly-below-the-plant subquery is empty
-- (`string_agg` of zero rows is NULL), so `node_path` COALESCEs to `n.name`
-- --- the same leaf the client already falls back to when `node_path` is
-- null, so this never regresses to a blank label.
--
-- Everything else --- the existence guard (org-scoped, DEF-0021 / TP-XT
-- shape), the read gate (`app_can_read_in_plant`), the LEFT JOINs on
-- product/operator, the ORDER BY, the comment, the grant block --- is 0075's
-- text, copied verbatim.
-- ============================================================================

create or replace function list_week_template_items(p_template_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
  v_out   jsonb;
BEGIN
  -- Org-scoped existence lookup (DEF-0021 / TP-XT): a foreign-org template id
  -- and a bogus one both leave v_plant NULL and both answer no_such_template,
  -- the same guard shape 0068 gave rename_week_template/delete_week_template.
  SELECT plant_id INTO v_plant FROM week_templates
   WHERE id = p_template_id AND org_id = app_current_org();
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such template',
      jsonb_build_object('field', 'p_template_id', 'reason', 'no_such_template'));
  END IF;

  IF NOT app_can_read_in_plant(v_plant) THEN
    PERFORM api_raise('not_permitted', 'you cannot read this plant',
      jsonb_build_object('plant_id', v_plant, 'reason', 'cannot_read'));
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_ref', i.item_ref,
           'kind', i.kind,
           'run_ref', i.run_ref,
           'day_offset', i.day_offset,
           'start_min', i.start_min,
           'end_min', i.end_min,
           'planned_headcount', i.planned_headcount,
           'node_id', i.node_id,
           'node_name', n.name,
           'node_path', COALESCE(
             (SELECT string_agg(a.name, ' › ' ORDER BY nlevel(a.path))
                FROM nodes a
               WHERE a.org_id = n.org_id
                 AND n.path <@ a.path
                 AND nlevel(a.path) > nlevel(vp.path)),
             n.name),
           'product_id', i.product_id,
           'product_name', pr.name,
           'operator_id', i.operator_id,
           'operator_name', o.display_name)
           ORDER BY i.day_offset, n.name, i.start_min, i.kind), '[]'::jsonb)
    INTO v_out
    FROM week_template_items i
    LEFT JOIN nodes n     ON n.id = i.node_id
    LEFT JOIN products pr ON pr.id = i.product_id
    LEFT JOIN operators o ON o.id = i.operator_id
    LEFT JOIN nodes vp    ON vp.id = v_plant
   WHERE i.template_id = p_template_id;

  RETURN v_out;
END $function$;

comment on function list_week_template_items(uuid) is
  'R-356 surface: a read-only "what''s inside" view of a week template''s snapshot --- one row per run/assignment item, with node/product/operator names LEFT JOINed (0067 D110: a snapshot carries no foreign keys, so a deleted name resolves to NULL and the client shows "(removed)"). node_path (0077, the maintainer 10 Sept) is the item''s node ancestors-and-self BELOW the template''s plant root, joined "Name › Name" in ltree depth order, adapting to any hierarchy depth; it is NULL exactly when node_name is (the node no longer resolves), and falls back to the leaf name when the item sits on the plant root itself (nothing strictly below it to join). SECURITY DEFINER; the existence lookup is org-scoped (org_id = app_current_org(), DEF-0021 / TP-XT) so a foreign-org template answers no_such_template exactly as a bogus id does. Readable by anyone who can read the plant (app_can_read_in_plant, the same gate list_week_templates and the table''s own RLS policy use) --- this is a read view, not gated on administering.';

revoke execute on function list_week_template_items(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function list_week_template_items(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function list_week_template_items(uuid) from anon';
  end if;
end $$;
