-- ============================================================================
-- 20260901000035_copy_plant_structure.sql — the starter library (structure-only).
--
-- The maintainer, 1 Sep: "Let's put the hierarchy in plant A as the starter
-- library with an option for the company system admin to edit it later." Asked
-- what a new plant copies, he chose STRUCTURE ONLY: a new plant starts as a copy
-- of an existing plant's node tree (its areas, lines, cells) and is empty of
-- parts and people until those are imported. The library is just an existing
-- plant; editing it is the ordinary tree editor already on that plant.
--
-- ----------------------------------------------------------------------------
-- ⭐ WHY THIS REUSES create_node RATHER THAN INSERTING NODES DIRECTLY.
--
-- create_node already does every hard part correctly: a root create COPIES the
-- source template's levels into a fresh per-site template (0020 §10, the thing
-- that makes "one site, one structure" true), a child create resolves its level
-- from its parent, paths are maintained by trigger, and every step re-checks the
-- caller's permission. Re-implementing that here would be a second copy of the
-- most intricate logic in the schema. So this function is a LOOP over
-- create_node, and because it is one function it is one transaction: a failure
-- part-way rolls the whole new plant back, so there is never a half-built plant
-- left behind. No RLS bypass is needed or wanted — create_node is SECURITY
-- INVOKER and each call is permission-checked as the caller, which is exactly why
-- the bulk-import RLS hazards the roadmap warns about do not arise on this path.
--
-- ⚠️ PARENTS BEFORE CHILDREN falls out of `order by path`: a parent's ltree path
-- is a strict prefix of each child's, and a prefix sorts before the longer
-- string, so a parent is always created (and mapped) before any child needs it.
-- ============================================================================
create or replace function copy_plant_structure(p_source_root uuid, p_new_name text)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_org      uuid := app_current_org();
  v_template uuid;
  v_src_path ltree;
  v_new_root uuid;
  v_map      jsonb := '{}'::jsonb;  -- source node id -> new node id, as text keys
  v_parent   uuid;
  v_new_id   uuid;
  v_count    int := 0;
  r          record;
begin
  -- The source must be a top-level plant the caller can read, in this org. Its
  -- TEMPLATE (reached through the root's level, since nodes carry no template
  -- column — D86) is what create_node copies for the new root.
  select hl.template_id, n.path into v_template, v_src_path
    from nodes n
    join hierarchy_levels hl on hl.id = n.level_id
   where n.id = p_source_root and n.org_id = v_org and n.parent_id is null;
  if v_template is null then
    perform api_raise('invalid_argument',
      'the source plant was not found, is not a top-level plant, or is not yours to read',
      jsonb_build_object('field', 'p_source_root', 'reason', 'not a readable root'));
  end if;

  -- The new root. create_node enforces that a root create is company-admin only
  -- (0020 §8), so this is where an unauthorised caller is refused — with
  -- create_node's own message — and where the levels are copied.
  v_new_root := (create_node(null, p_new_name, 0, v_template) ->> 'id')::uuid;
  v_map := jsonb_build_object(p_source_root::text, v_new_root::text);

  -- Every descendant of the source, parents first, recreated under the node its
  -- source-parent maps to. sort_order is carried so siblings keep their order.
  for r in
    select id, parent_id, name, sort_order
      from nodes
     where org_id = v_org and path <@ v_src_path and id <> p_source_root
     order by path
  loop
    v_parent := (v_map ->> r.parent_id::text)::uuid;
    if v_parent is null then
      -- Cannot happen under `order by path` (a parent is always mapped first),
      -- so if it does the tree is malformed and copying it would misplace nodes.
      perform api_raise('invalid_argument',
        'the source structure is malformed: a child was reached before its parent',
        jsonb_build_object('node_id', r.id, 'parent_id', r.parent_id));
    end if;
    v_new_id := (create_node(v_parent, r.name, r.sort_order) ->> 'id')::uuid;
    v_map := v_map || jsonb_build_object(r.id::text, v_new_id::text);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('id', v_new_root, 'name', p_new_name, 'nodes_copied', v_count);
end $$;

comment on function copy_plant_structure(uuid, text) is
  'Starter library (structure-only): create a new plant as a copy of an existing plant''s node tree. A loop over create_node, so it is one transaction (no half-built plant on failure), reuses create_node''s level-copy and permission checks, and creates parents before children by path order. Company-admin only, because creating a plant is (create_node''s root branch enforces it). Returns {id, name, nodes_copied}.';

-- Grants: mirror create_node (0010) — revoke from PUBLIC, grant authenticated.
REVOKE EXECUTE ON FUNCTION copy_plant_structure(uuid, text) FROM PUBLIC;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'GRANT EXECUTE ON FUNCTION copy_plant_structure(uuid, text) TO authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'REVOKE ALL ON FUNCTION copy_plant_structure(uuid, text) FROM anon';
  end if;
end $$;
