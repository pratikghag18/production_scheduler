-- ============================================================================
-- Migration 0010: hierarchy admin surface
-- Implements: agent brief docs/agent-briefs/p1-5a-hierarchy-db-brief.md
--   §5 (structural invariants D67-D69), §6 (five RPCs D70-D73),
--   §7 (error contract D74), §8 (grants). design-plan.md §19 is this
--   migration's decision record.
--
-- Append-only: this migration never edits 0001-0009. Where it needs to
-- change behaviour defined earlier, it does so with a new index/trigger,
-- never by altering an existing statement.
--
-- ASSUMPTION (brief silent): §6.2-6.5 do not list an app_is_admin() /
-- not_permitted pre-check for create_node / rename_node / move_node /
-- delete_node, unlike §6.1's explicit step 1 for save_hierarchy_levels. But
-- the nodes table's own RLS write policies (migration 0008:
-- nodes_insert/update/delete) are ALL "app_is_admin() and org match" --
-- there is no supervisor-write path on nodes at all -- and design-plan
-- calls this whole surface "the admin tree editor" / "Org admin (hierarchy
-- ...)" (§9, §19). Without an explicit pre-check, a non-admin caller's
-- UPDATE/INSERT would either be silently zero-row (RETURNING would populate
-- an all-NULL record, not raise) or surface a raw RLS-violation error
-- outside the api_raise contract -- exactly the failure mode §7's own text
-- says the contract exists to prevent ("every RPC pre-checks and raises a
-- named code rather than letting a raw constraint violation surface"), and
-- the same pattern every §5 write function in migration 0009 already
-- follows for app_can_edit_node(). All four node RPCs below therefore open
-- with the same admin check as save_hierarchy_levels, raising not_permitted.
-- See the agent report for this decision recorded as a brief gap, not
-- silently assumed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §5.1 / D67: (org_id, path) unique index. Closes F3/F4/F4a as a database
-- invariant. Verified against the seeded database in the brief's own
-- writeup and re-verified here (this migration creates cleanly on the
-- existing seed).
-- ----------------------------------------------------------------------------
create unique index nodes_org_path_unique on nodes (org_id, path);

-- ----------------------------------------------------------------------------
-- §5.2 / D68: cycle rejection. Named nodes_before_cycle so it sorts before
-- nodes_before_path alphabetically -- Postgres fires same-timing triggers in
-- trigger-NAME order, and this must see a coherent OLD.path (migration 0001
-- has not yet overwritten it). Covers both INSERT (NEW.parent_id = NEW.id;
-- NEW.id is already populated by the time a BEFORE trigger sees the row,
-- since gen_random_uuid() is an INSERT default) and UPDATE (new parent's
-- path contained by OLD.path).
-- ----------------------------------------------------------------------------
create function nodes_check_cycle() returns trigger
language plpgsql as $$
declare
  v_parent_path ltree;
begin
  if new.parent_id = new.id then
    perform api_raise('node_cycle', format('node %s cannot be its own parent', new.id),
      jsonb_build_object('node_id', new.id));
  end if;

  if tg_op = 'UPDATE' and new.parent_id is not null then
    select path into v_parent_path from nodes where id = new.parent_id;
    if v_parent_path is not null and v_parent_path <@ old.path then
      perform api_raise('node_cycle', format('node %s cannot move beneath its own descendant', new.id),
        jsonb_build_object('node_id', new.id));
    end if;
  end if;

  return new;
end;
$$;

create trigger nodes_before_cycle
  before insert or update of parent_id on nodes
  for each row execute function nodes_check_cycle();

-- ----------------------------------------------------------------------------
-- §5.3 / D69: level adjacency, with the documented escape hatch. Amends (does
-- not ignore) migration 0001's "do not add this here later" note next to the
-- nodes table -- that note protects the Phase-3 mid-level-insertion tool, and
-- current_setting('app.hierarchy_migration', true) = 'on' is exactly the
-- hatch that lets that future tool run while the invariant stays on by
-- default for everything else, including this migration's own RPCs. Named
-- nodes_before_level so it sorts between nodes_before_cycle and
-- nodes_before_path.
--
-- Alias note (brief §14.1's trap, applied defensively): no PL/pgSQL variable
-- here shares a name with a table alias used below.
-- ----------------------------------------------------------------------------
create function nodes_check_level_adjacency() returns trigger
language plpgsql as $$
declare
  v_own_position    int;
  v_parent_position int;
begin
  if coalesce(current_setting('app.hierarchy_migration', true), '') = 'on' then
    return new;
  end if;

  select position into v_own_position from hierarchy_levels where id = new.level_id;

  if new.parent_id is null then
    if v_own_position is distinct from 0 then
      perform api_raise('level_mismatch',
        format('node %s has no parent but its level is not position 0', new.id),
        jsonb_build_object('node_id', new.id));
    end if;
  else
    select hl.position into v_parent_position
      from nodes pn join hierarchy_levels hl on hl.id = pn.level_id
      where pn.id = new.parent_id;
    if v_parent_position is null or v_own_position is distinct from v_parent_position + 1 then
      perform api_raise('level_mismatch',
        format('node %s level position is not exactly one below its parent''s', new.id),
        jsonb_build_object('node_id', new.id));
    end if;
  end if;

  return new;
end;
$$;

create trigger nodes_before_level
  before insert or update of parent_id, level_id on nodes
  for each row execute function nodes_check_level_adjacency();

-- ============================================================================
-- §6: the five RPCs. All LANGUAGE plpgsql, SECURITY INVOKER,
-- SET search_path = public, pg_temp, every raise through api_raise.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §6.1 / D70: save_hierarchy_levels. Array index IS the position -- a
-- payload cannot express a gap, so there is no separate contiguity check.
-- Writes in three passes (F1/F2: neither the (org_id,position) unique
-- constraint nor the one-schedulable partial index can be deferred).
-- ----------------------------------------------------------------------------
create function save_hierarchy_levels(p_levels jsonb) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id                    uuid;
  v_count                     int;
  v_schedulable_count         int;
  v_kept_ids                  uuid[];
  v_removed_ids                uuid[];
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
    where trim(coalesce(e->>'name', '')) = ''
  ) then
    perform api_raise('invalid_argument', 'level name must not be blank',
      jsonb_build_object('field', 'name', 'reason', 'blank name'));
  end if;

  -- D3 (found in design-session verification, Aug 25; not in the brief's
  -- original 8-step list): every non-null id must parse as a uuid before
  -- anything below casts it -- otherwise a malformed id (e.g. "nope") raises
  -- a raw 22P02 outside the §7 closed set instead of a typed invalid_argument.
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

  select coalesce(array_agg(hl.id), '{}')
    into v_removed_ids
    from hierarchy_levels hl
    where hl.org_id = v_org_id
      and not (hl.id = any(v_kept_ids));

  -- 7. a level being removed still has nodes.
  if exists (select 1 from nodes nd where nd.level_id = any(v_removed_ids)) then
    perform api_raise('level_in_use', 'a level being removed still has nodes',
      jsonb_build_object('level_ids', to_jsonb(v_removed_ids)));
  end if;

  -- 8. D72: the schedulable lock. Only relevant if the schedulable level is
  -- actually changing.
  select hl.id into v_old_schedulable_level_id
    from hierarchy_levels hl
    where hl.org_id = v_org_id and hl.is_schedulable;

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
  update hierarchy_levels set is_schedulable = false where org_id = v_org_id;
  update hierarchy_levels set position = position + 1000 where org_id = v_org_id;

  v_idx := 0;
  for v_entry in select * from jsonb_array_elements(p_levels)
  loop
    v_id   := (v_entry->>'id')::uuid;
    v_name := trim(v_entry->>'name');
    if v_id is null then
      insert into hierarchy_levels (org_id, position, name, is_schedulable)
        values (v_org_id, v_idx, v_name, false);
    else
      update hierarchy_levels set position = v_idx, name = v_name
        where id = v_id and org_id = v_org_id;
    end if;
    v_idx := v_idx + 1;
  end loop;

  delete from hierarchy_levels where id = any(v_removed_ids);

  select (ord.i - 1) into v_schedulable_idx
    from jsonb_array_elements(p_levels) with ordinality as ord(e, i)
    where (ord.e->>'is_schedulable')::boolean is true;

  update hierarchy_levels set is_schedulable = true
    where org_id = v_org_id and position = v_schedulable_idx;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', hl.id, 'position', hl.position, 'name', hl.name,
           'is_schedulable', hl.is_schedulable) order by hl.position), '[]'::jsonb)
    into v_result
    from hierarchy_levels hl
    where hl.org_id = v_org_id;

  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- §6.2: create_node.
-- ----------------------------------------------------------------------------
create function create_node(p_parent_id uuid, p_name text, p_sort_order int default 0)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id            uuid;
  v_name              text;
  v_parent_path       ltree;
  v_parent_position   int;
  v_level_id          uuid;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
  v_node              nodes%rowtype;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  if p_parent_id is null then
    select id into v_level_id from hierarchy_levels where org_id = v_org_id and position = 0;
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = p_parent_id and org_id = v_org_id;
    if v_parent_path is null then
      perform api_raise('invalid_argument', 'parent node not found',
        jsonb_build_object('field', 'p_parent_id', 'reason', 'not found'));
    end if;

    select hl.position into v_parent_position
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
      where n.id = p_parent_id;

    select id into v_level_id
      from hierarchy_levels where org_id = v_org_id and position = v_parent_position + 1;
    if v_level_id is null then
      perform api_raise('level_mismatch', 'no hierarchy level exists one position below the parent',
        jsonb_build_object('node_id', p_parent_id));
    end if;

    v_prospective_path := v_parent_path || slugify(v_name)::ltree;
  end if;

  select id into v_existing_node_id
    from nodes where org_id = v_org_id and path = v_prospective_path;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  -- D2 (found in design-session verification, Aug 25): an explicit NULL for
  -- p_sort_order bypasses the function signature's own `DEFAULT 0` (that
  -- default only applies when the argument is omitted entirely, not when a
  -- caller passes NULL outright), and an uncoalesced NULL insert raised a
  -- raw 23502 outside the closed error set. move_node already guards this
  -- correctly (coalesce(p_sort_order, sort_order)); create_node did not.
  insert into nodes (org_id, level_id, parent_id, name, sort_order)
    values (v_org_id, v_level_id, p_parent_id, v_name, coalesce(p_sort_order, 0))
    returning * into v_node;

  return jsonb_build_object(
    'id', v_node.id, 'name', v_node.name, 'path', v_node.path::text,
    'parent_id', v_node.parent_id, 'level_id', v_node.level_id,
    'sort_order', v_node.sort_order, 'active', v_node.active);
end;
$$;

-- ----------------------------------------------------------------------------
-- §6.3: rename_node. Descendant paths cascade via the existing
-- nodes_after_path trigger (migration 0001) -- not reimplemented here.
-- ----------------------------------------------------------------------------
create function rename_node(p_node_id uuid, p_name text) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id            uuid;
  v_name              text;
  v_node              nodes%rowtype;
  v_parent_path       ltree;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  if v_node.parent_id is null then
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = v_node.parent_id;
    v_prospective_path := v_parent_path || slugify(v_name)::ltree;
  end if;

  -- Exclude the node itself, or renaming a node to its own current name
  -- (or to a different name that happens to slugify the same) would report
  -- a collision against itself.
  select id into v_existing_node_id
    from nodes
    where org_id = v_org_id and path = v_prospective_path and id <> p_node_id;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  update nodes set name = v_name where id = p_node_id
    returning * into v_node;

  return jsonb_build_object('id', v_node.id, 'name', v_node.name, 'path', v_node.path::text);
end;
$$;

-- ----------------------------------------------------------------------------
-- §6.4 / D71: move_node. Never changes level_id. Order 5 (cycle) before 6
-- (level) is load-bearing: every move beneath one's own descendant also
-- skips a level, so checking level adjacency first would misreport a
-- genuine cycle as level_mismatch. The check 6 DETAIL deliberately omits
-- node_id -- that absence is what N17 uses to prove the RPC's own
-- pre-check fired, not the nodes_before_level trigger (whose DETAIL always
-- carries node_id, per D69/§5.3).
-- ----------------------------------------------------------------------------
create function move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order int default null)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id            uuid;
  v_node              nodes%rowtype;
  v_own_position      int;
  v_parent_path       ltree;
  v_parent_position   int;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();

  -- 1. unknown node.
  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  select position into v_own_position from hierarchy_levels where id = v_node.level_id;

  if p_new_parent_id is null then
    -- 2. NULL parent allowed only if the node is already at level position 0.
    if v_own_position is distinct from 0 then
      perform api_raise('level_mismatch', 'only a position-0 node may have no parent',
        jsonb_build_object('reason', 'node level position is not 0'));
    end if;
    v_prospective_path := slugify(v_node.name)::ltree;
  else
    -- 3. self-parent.
    if p_new_parent_id = p_node_id then
      perform api_raise('node_cycle', 'a node cannot be its own parent',
        jsonb_build_object('node_id', p_node_id));
    end if;

    -- 4. unknown parent.
    select path into v_parent_path from nodes where id = p_new_parent_id and org_id = v_org_id;
    if v_parent_path is null then
      perform api_raise('invalid_argument', 'new parent node not found',
        jsonb_build_object('field', 'p_new_parent_id', 'reason', 'not found'));
    end if;

    -- 5. cycle: new parent is a descendant of the node. MUST run before 6.
    if v_parent_path <@ v_node.path then
      perform api_raise('node_cycle', 'cannot move a node beneath its own descendant',
        jsonb_build_object('node_id', p_node_id));
    end if;

    -- 6. level adjacency against the node's EXISTING level (never changes it).
    select hl.position into v_parent_position
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
      where n.id = p_new_parent_id;
    if v_own_position is distinct from v_parent_position + 1 then
      perform api_raise('level_mismatch',
        'the new parent is not exactly one level above the node''s existing level',
        jsonb_build_object('reason', 'level position mismatch'));
    end if;

    v_prospective_path := v_parent_path || slugify(v_node.name)::ltree;
  end if;

  -- 7. path collision.
  select id into v_existing_node_id
    from nodes
    where org_id = v_org_id and path = v_prospective_path and id <> p_node_id;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  update nodes set parent_id = p_new_parent_id, sort_order = coalesce(p_sort_order, sort_order)
    where id = p_node_id
    returning * into v_node;

  return jsonb_build_object(
    'id', v_node.id, 'name', v_node.name, 'path', v_node.path::text,
    'parent_id', v_node.parent_id, 'sort_order', v_node.sort_order);
end;
$$;

-- ----------------------------------------------------------------------------
-- §6.5 / D73: delete_node.
-- ----------------------------------------------------------------------------
create function delete_node(p_node_id uuid, p_mode text default 'deactivate')
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id             uuid;
  v_node               nodes%rowtype;
  v_children_count     int;
  v_runs_count         int;
  v_assignments_count  int;
  v_deactivated_count  int;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  -- D1 (found in design-session verification, Aug 25): p_mode NOT IN (...)
  -- evaluates to NULL, not true, when p_mode IS NULL -- the guard silently
  -- did not fire, and p_mode = 'deactivate' is also NULL, so control fell
  -- through to the destructive 'delete' branch by default. A malformed
  -- argument must never perform the more dangerous of two documented modes.
  -- This is a bug in the brief's own §6.5 text, not a deviation from it.
  if p_mode is null or p_mode not in ('deactivate', 'delete') then
    perform api_raise('invalid_argument', 'p_mode must be ''deactivate'' or ''delete''',
      jsonb_build_object('field', 'p_mode', 'reason', format('unrecognised mode %s', coalesce(p_mode, '<null>'))));
  end if;

  v_org_id := app_current_org();

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  if p_mode = 'deactivate' then
    -- The whole subtree, not just the node -- <@ is reflexive so the node
    -- itself is included.
    update nodes set active = false where org_id = v_org_id and path <@ v_node.path;
    get diagnostics v_deactivated_count = row_count;
    return jsonb_build_object('mode', 'deactivate', 'deactivated', v_deactivated_count);
  end if;

  select count(*) into v_children_count from nodes where parent_id = p_node_id;
  select count(*) into v_runs_count from runs where node_id = p_node_id;
  select count(*) into v_assignments_count from assignments where node_id = p_node_id;

  if v_children_count > 0 or v_runs_count > 0 or v_assignments_count > 0 then
    perform api_raise('node_in_use', 'node cannot be deleted while it has children, runs or assignments',
      jsonb_build_object('children', v_children_count, 'runs', v_runs_count, 'assignments', v_assignments_count));
  end if;

  delete from profile_grants where node_id = p_node_id;
  delete from node_shift_templates where node_id = p_node_id;
  delete from node_skill_requirements where node_id = p_node_id;
  delete from nodes where id = p_node_id;

  return jsonb_build_object('mode', 'delete', 'deleted', 1);
end;
$$;

-- ============================================================================
-- §8: grants. Same correction as migration 0009 -- Postgres grants EXECUTE
-- on new functions to PUBLIC by default, so a bare `REVOKE ... FROM anon`
-- is not enough; every function below has EXECUTE revoked from PUBLIC
-- explicitly, then re-granted to authenticated only (guarded, so this file
-- also runs on a scratch Postgres lacking the Supabase roles).
-- ============================================================================
REVOKE EXECUTE ON FUNCTION save_hierarchy_levels(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_node(uuid,text,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rename_node(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION move_node(uuid,uuid,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_node(uuid,text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION save_hierarchy_levels(jsonb) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION create_node(uuid,text,int) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION rename_node(uuid,text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION move_node(uuid,uuid,int) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION delete_node(uuid,text) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION save_hierarchy_levels(jsonb) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION create_node(uuid,text,int) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION rename_node(uuid,text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION move_node(uuid,uuid,int) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION delete_node(uuid,text) FROM anon';
  END IF;
END $$;
