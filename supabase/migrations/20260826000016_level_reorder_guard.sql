-- ============================================================================
-- 0016 — D92: save_hierarchy_levels must refuse an order that strands nodes.
--
-- WHY THIS IS A WHOLE MIGRATION FOR ONE GUARD. `save_hierarchy_levels` has
-- always refused to REMOVE a level that still has nodes (check 7) and to move
-- the schedulable flag off a level that still has work (check 8). It never
-- guarded REORDERING, and `nodes_before_level` cannot cover for it: that
-- trigger fires `before insert or update of parent_id, level_id ON NODES`, and
-- rewriting `hierarchy_levels.position` updates no node row. There is no
-- trigger on `hierarchy_levels` at all.
--
-- Reachable from the shipped UI: LevelEditor's up/down arrows, then Save.
-- Measured on a scratch PG16 with these migrations and seed.sql, as a real
-- `authenticated` admin: swapping Department and Line in Northwind took the
-- org from 0 adjacency violations to 12, with the RPC returning success. The
-- tree then still rendered normally, `create_node` silently created children
-- on the WRONG level (add a child to a Department, get a Work Cell), and
-- `move_node` refused with a level_mismatch the admin could not connect to the
-- reorder.
--
-- NO NEW ERROR CODE. `level_in_use` already means "a level cannot change
-- because nodes depend on it", which is exactly this. The closed set stays at
-- twelve (design plan §17 / docs/api.md).
--
-- GRANTS: this is `create or replace`, not a drop-and-recreate, so the function
-- keeps its existing grants -- the drop-takes-the-grants trap (P1-5f T30) does
-- not apply here. MEASURED on the scratch database rather than assumed:
-- `has_function_privilege('authenticated', 'save_hierarchy_levels(jsonb,uuid)',
-- 'EXECUTE')` is true before and after. Case T36 pins it.
--
-- The body below is migration 0014's, extracted programmatically and unchanged
-- except for the guard block, which is inserted immediately before the final
-- SELECT that builds the return value.
-- ============================================================================

create or replace function save_hierarchy_levels(p_levels jsonb, p_template_id uuid) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id                    uuid;
  v_template_id               uuid;
  v_count                     int;
  v_schedulable_count         int;
  v_kept_ids                  uuid[];
  v_removed_ids               uuid[];
  v_foreign_ids               uuid[];
  v_old_schedulable_level_id  uuid;
  v_new_schedulable_level_id  uuid;
  v_run_count                 int;
  v_assignment_count          int;
  v_blocking_count            int;
  v_entry                     jsonb;
  v_idx                       int;
  v_id                        uuid;
  v_name                      text;
  v_schedulable_idx           int;
  v_result                    jsonb;
begin
  -- 1. admin only.
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();

  -- T1. the template must exist IN THIS ORG. Runs before any p_levels check so
  -- a caller naming another tenant's template learns nothing about its levels.
  select id into v_template_id from hierarchy_templates
    where id = p_template_id and org_id = v_org_id;
  if v_template_id is null then
    perform api_raise('invalid_argument', 'hierarchy template not found',
      jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
  end if;

  -- 2. must be a JSON array.
  if jsonb_typeof(p_levels) is distinct from 'array' then
    perform api_raise('invalid_argument', 'p_levels must be a JSON array',
      jsonb_build_object('field', 'p_levels', 'reason', 'not an array'));
  end if;

  v_count := jsonb_array_length(p_levels);

  -- 3. empty array.
  if v_count = 0 then
    perform api_raise('invalid_argument', 'p_levels must not be empty',
      jsonb_build_object('field', 'p_levels', 'reason', 'empty array'));
  end if;

  -- 4. more than 64 entries. The cap is what guarantees the +1000 offset
  -- pass below can never collide with a final position.
  if v_count > 64 then
    perform api_raise('invalid_argument', 'p_levels must not exceed 64 entries',
      jsonb_build_object('field', 'p_levels', 'reason', 'too many entries'));
  end if;

  -- 5. exactly one schedulable.
  select count(*) into v_schedulable_count
    from jsonb_array_elements(p_levels) e
    where (e->>'is_schedulable')::boolean is true;
  if v_schedulable_count <> 1 then
    perform api_raise('invalid_argument', 'exactly one level must be schedulable',
      jsonb_build_object('field', 'is_schedulable', 'reason',
        format('found %s schedulable entries, expected 1', v_schedulable_count)));
  end if;

  -- 6. no blank names.
  if exists (
    select 1 from jsonb_array_elements(p_levels) e
    where app_trim_ws(e->>'name') = ''
  ) then
    perform api_raise('invalid_argument', 'level name must not be blank',
      jsonb_build_object('field', 'name', 'reason', 'blank name'));
  end if;

  -- D3 (design-session verification, Aug 25): every non-null id must parse as
  -- a uuid before anything below casts it -- otherwise a malformed id (e.g.
  -- "nope") raises a raw 22P02 outside the §7 closed set.
  if exists (
    select 1 from jsonb_array_elements(p_levels) e
    where (e->>'id') is not null
      and (e->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    perform api_raise('invalid_argument', 'a level id is not a valid uuid',
      jsonb_build_object('field', 'id', 'reason', 'malformed uuid'));
  end if;

  -- Levels kept vs. removed (by id; id: null means a new level).
  select coalesce(array_agg((e->>'id')::uuid), '{}')
    into v_kept_ids
    from jsonb_array_elements(p_levels) e
    where (e->>'id') is not null;

  -- T2. Every named id must already belong to THIS template. Without this the
  -- `update ... where id = v_id` pass below would quietly drag another
  -- template's level into this one's ordering -- a level would change shape
  -- without anyone asking, and the other shape would silently lose a rung.
  select coalesce(array_agg(hl.id), '{}') into v_foreign_ids
    from hierarchy_levels hl
    where hl.id = any(v_kept_ids)
      and hl.template_id is distinct from v_template_id;
  if array_length(v_foreign_ids, 1) is not null then
    perform api_raise('invalid_argument', 'a level id belongs to a different hierarchy template',
      jsonb_build_object('field', 'id', 'reason', 'wrong template',
                         'level_ids', to_jsonb(v_foreign_ids)));
  end if;

  -- SCOPED TO THE TEMPLATE, not the org: saving one shape must never delete
  -- another shape's levels. This is the single most consequential line in the
  -- 0011 -> 0013 diff.
  select coalesce(array_agg(hl.id), '{}')
    into v_removed_ids
    from hierarchy_levels hl
    where hl.template_id = v_template_id
      and not (hl.id = any(v_kept_ids));

  -- 7. a level being removed still has nodes.
  if exists (select 1 from nodes nd where nd.level_id = any(v_removed_ids)) then
    perform api_raise('level_in_use', 'a level being removed still has nodes',
      jsonb_build_object('level_ids', to_jsonb(v_removed_ids)));
  end if;

  -- 8. D72: the schedulable lock, now per template.
  select hl.id into v_old_schedulable_level_id
    from hierarchy_levels hl
    where hl.template_id = v_template_id and hl.is_schedulable;

  select (e->>'id')::uuid into v_new_schedulable_level_id
    from jsonb_array_elements(p_levels) e
    where (e->>'is_schedulable')::boolean is true;

  if v_old_schedulable_level_id is not null
     and v_old_schedulable_level_id is distinct from v_new_schedulable_level_id
  then
    select count(*) into v_run_count
      from runs run_row
      join nodes nd on nd.id = run_row.node_id
      where nd.level_id = v_old_schedulable_level_id;

    v_blocking_count := v_run_count;

    -- D72's second half: after P1-4e a direct assignment can exist with no
    -- run at all, so a zero run count does not mean the level is free.
    if v_blocking_count = 0 then
      select count(*) into v_assignment_count
        from assignments asn
        join nodes nd on nd.id = asn.node_id
        where nd.level_id = v_old_schedulable_level_id;
      v_blocking_count := v_assignment_count;
    end if;

    if v_blocking_count > 0 then
      perform api_raise('schedulable_level_locked',
        'the current schedulable level still has scheduled work',
        jsonb_build_object('blocking_rows', v_blocking_count, 'level_id', v_old_schedulable_level_id));
    end if;
  end if;

  -- ---- Write, in three passes (F1/F2). ----
  update hierarchy_levels set is_schedulable = false where template_id = v_template_id;
  update hierarchy_levels set position = position + 1000 where template_id = v_template_id;

  v_idx := 0;
  for v_entry in select * from jsonb_array_elements(p_levels)
  loop
    v_id   := (v_entry->>'id')::uuid;
    v_name := app_trim_ws(v_entry->>'name');
    if v_id is null then
      insert into hierarchy_levels (org_id, template_id, position, name, is_schedulable)
        values (v_org_id, v_template_id, v_idx, v_name, false);
    else
      update hierarchy_levels set position = v_idx, name = v_name
        where id = v_id and template_id = v_template_id;
    end if;
    v_idx := v_idx + 1;
  end loop;

  delete from hierarchy_levels where id = any(v_removed_ids);

  select (ord.i - 1) into v_schedulable_idx
    from jsonb_array_elements(p_levels) with ordinality as ord(e, i)
    where (ord.e->>'is_schedulable')::boolean is true;

  update hierarchy_levels set is_schedulable = true
    where template_id = v_template_id and position = v_schedulable_idx;


  -- --------------------------------------------------------------------------
  -- D92: a reorder must not strand existing nodes between levels.
  --
  -- Checks 7 and 8 above guard REMOVING a level that has nodes, and moving the
  -- schedulable flag off a level that has work. Nothing guarded REORDERING --
  -- and it could not be caught anywhere else, because `nodes_before_level` is
  -- declared `before insert or update of parent_id, level_id ON NODES`. The
  -- three write passes above touch only `hierarchy_levels`, so no node row is
  -- ever updated and that trigger never fires. Measured before this migration:
  -- swapping two in-use levels took the seeded org from 0 adjacency violations
  -- to 12, and this function returned success.
  --
  -- STATED AS AN OUTCOME, NOT AS A RESTRICTION ON THE MOVE. "A level with nodes
  -- may not change position" is the obvious phrasing and it is a trap: a
  -- database already scrambled by a pre-0016 save could never be repaired,
  -- because the repair is itself a move of an in-use level. Asking whether the
  -- RESULT is sound instead permits the repair, refuses the damage, and — the
  -- reason it is worth writing this way — will keep working unchanged when
  -- nodes become re-levellable, since a save that reorders levels AND fixes the
  -- nodes in one transaction simply ends in a sound state.
  --
  -- It runs AFTER the write and reads the real rows, so it cannot drift from
  -- what the write actually did. `api_raise` raises, which aborts the
  -- transaction, so nothing above persists (asserted by case T35).
  --
  -- BOTH HALVES OF THE TRIGGER'S RULE ARE MIRRORED, not just the one an obvious
  -- test hits. A parent-join alone misses a stranded ROOT entirely: a structure
  -- holding one root and no children has no parent/child pair at all, so
  -- swapping its levels scores ZERO join violations while the root sits off
  -- position 0. Measured, and it is case T34.
  -- --------------------------------------------------------------------------
  if exists (
    select 1
      from nodes n
      join hierarchy_levels nl on nl.id = n.level_id
     where nl.template_id = v_template_id
       and n.parent_id is null
       and nl.position is distinct from 0
  ) then
    perform api_raise('level_in_use',
      'this order would leave a top-level node below the first level',
      jsonb_build_object('reason', 'reorder strands a root node'));
  end if;

  if exists (
    select 1
      from nodes n
      join nodes p             on p.id = n.parent_id
      join hierarchy_levels cl on cl.id = n.level_id
      join hierarchy_levels pl on pl.id = p.level_id
     where cl.template_id = v_template_id
       and cl.position is distinct from pl.position + 1
  ) then
    perform api_raise('level_in_use',
      'this order would leave existing nodes stranded between levels',
      jsonb_build_object('reason', 'reorder strands nodes'));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
           'name', hl.name, 'is_schedulable', hl.is_schedulable) order by hl.position), '[]'::jsonb)
    into v_result
    from hierarchy_levels hl
    where hl.template_id = v_template_id;

  return v_result;
end;
$$;


-- ============================================================================
-- D93 — the grants migration 0014 never carried.
--
-- Found by case L17 while verifying THIS migration, not by anything looking for
-- it. Migration 0010 explicitly revoked EXECUTE from PUBLIC and from `anon` for
-- `save_hierarchy_levels(jsonb)`. 0014 DROPPED that function and created
-- `save_hierarchy_levels(jsonb, uuid)` alongside three new template RPCs -- and
-- its grant block covers only the `hierarchy_templates` TABLE. So all four
-- arrived with Postgres's PUBLIC default.
--
-- MEASURED on the scratch database: of thirteen public RPCs, exactly the four
-- from 0014 answer `has_function_privilege('anon', ..., 'EXECUTE')` = true.
-- Every other one is false.
--
-- Exposure is small and it fails closed -- `anon` calling one dies on
-- "permission denied for function api_raise", since anon cannot reach that
-- either, and every one of these RPCs opens with an `app_is_admin()` check that
-- an anon caller cannot pass. But it fails with a RAW Postgres error outside the
-- twelve-code closed set, and "every RPC is explicitly revoked from anon" is a
-- property this schema otherwise holds without exception. Restoring it here.
--
-- This is the project's own recorded trap arriving again: a migration that
-- DROPS AND RECREATES A FUNCTION must carry its own grant block, because the
-- drop takes the grants with it. 0016 recreates `save_hierarchy_levels` too --
-- via `create or replace`, which PRESERVES grants (measured) -- so the block
-- below would be required for that reason alone.
-- ============================================================================
REVOKE EXECUTE ON FUNCTION save_hierarchy_levels(jsonb,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_hierarchy_template(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rename_hierarchy_template(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_hierarchy_template(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION save_hierarchy_levels(jsonb,uuid) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION create_hierarchy_template(text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION rename_hierarchy_template(uuid,text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION delete_hierarchy_template(uuid) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION save_hierarchy_levels(jsonb,uuid) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION create_hierarchy_template(text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION rename_hierarchy_template(uuid,text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION delete_hierarchy_template(uuid) FROM anon';
  END IF;
END $$;
