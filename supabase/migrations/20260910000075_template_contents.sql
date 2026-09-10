-- ============================================================================
-- 0075 --- A READ-ONLY "WHAT'S INSIDE" VIEW FOR WEEK TEMPLATES (R-356 surface).
--
-- The maintainer, 10 Sept: each week template in the Templates tab should be
-- expandable to show what it holds --- the runs and the people, per day.
-- READ ONLY; rename/delete already exist and stay exactly as 0067/0068 left
-- them. This is one new RPC, `list_week_template_items`, modelled EXACTLY on
-- `list_week_templates` (0067, read again here): same existence-then-read
-- guard shape, same grant block, same "resolve up to the plant" story does
-- NOT apply here because a template already belongs to a plant (its
-- `plant_id` column) --- there is no node argument to walk up from.
--
-- ⭐ NO CROSS-TENANT EXISTENCE LEAK (DEF-0021 / TP-XT, 0068). The existence
-- lookup is org-scoped in the query itself (`AND org_id = app_current_org()`),
-- the same one edit 0068 made to rename/delete, so a foreign-org template id
-- and a bogus one are indistinguishable: both fall through to
-- `no_such_template` before any permission check runs.
--
-- ⭐ NAMES ARE A LEFT JOIN, NOT A REQUIREMENT. `week_template_items` carries no
-- foreign keys on `node_id`/`operator_id`/`product_id` (0067 D110: a deleted
-- product or operator makes the snapshot item history, same as a deleted
-- product makes a run history). A name that no longer resolves comes back
-- NULL and the client shows "(removed)"; the row itself is never dropped.
-- `node_id` in particular is NOT NULL on the table but a node can still have
-- been deleted since the snapshot was taken (nodes are not append-only the way
-- products/operators effectively are here), so `node_name` is LEFT JOINed too,
-- exactly as `copy_week_plan`'s template arm already treats it (0067 S5).
--
-- ⭐ READ GATE. `app_can_read_in_plant` (0058) --- the same read gate
-- `list_week_templates` uses, and the same one `week_template_items_select`'s
-- RLS policy states for a direct read. This RPC does not need SECURITY
-- DEFINER for the policy's sake (RLS already allows exactly this reader) but
-- IS one anyway, to match `list_week_templates` exactly and because the
-- existence check ahead of the read gate must not leak (see above) --- an
-- INVOKER's own read would already hide a foreign-org row via RLS, but the
-- explicit org_id filter here is what keeps the ERROR PATH (not_permitted vs.
-- no_such_template) from leaking too, and that requires control over the
-- lookup itself, not just the data.
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
   WHERE i.template_id = p_template_id;

  RETURN v_out;
END $function$;

comment on function list_week_template_items(uuid) is
  'R-356 surface: a read-only "what''s inside" view of a week template''s snapshot --- one row per run/assignment item, with node/product/operator names LEFT JOINed (0067 D110: a snapshot carries no foreign keys, so a deleted name resolves to NULL and the client shows "(removed)"). SECURITY DEFINER; the existence lookup is org-scoped (org_id = app_current_org(), DEF-0021 / TP-XT) so a foreign-org template answers no_such_template exactly as a bogus id does. Readable by anyone who can read the plant (app_can_read_in_plant, the same gate list_week_templates and the table''s own RLS policy use) --- this is a read view, not gated on administering.';

revoke execute on function list_week_template_items(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function list_week_template_items(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function list_week_template_items(uuid) from anon';
  end if;
end $$;
