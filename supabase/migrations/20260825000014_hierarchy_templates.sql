-- ============================================================================
-- 0014 — hierarchy TEMPLATES: a shape per site, not one shape per org.
--
-- Design plan §19.18 / D86. Requirement, stated from the start and NOT an
-- open question: "hierarchy levels can be whatever the site wants." Until
-- this migration the schema forbade it.
--
--   hierarchy_levels was `unique (org_id, position)` — ONE ordered vocabulary
--   per org — and nodes_check_level_adjacency required every node's level
--   position to be exactly its parent's + 1. So an org could not run
--   Site > Department > Line > Cell at one plant and Site > Line > Cell at
--   another: the second plant's Lines would have to sit at position 1 and
--   position 2 at the same time.
--
-- The fix mirrors the shift_templates / node_shift_templates idiom already in
-- this schema: a named, org-scoped TEMPLATE owns the ordered level list, and
-- a tree belongs to whichever template its levels belong to.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
--
-- `nodes` gets no template column. A node's template is its level's template,
-- and the adjacency trigger below requires a node's level and its parent's
-- level to share one — so a tree cannot straddle two templates and there is
-- no second copy of that fact to keep in sync. Two identical plants SHARE a
-- template rather than duplicating its levels; that is the point of naming it.
--
-- ALSO CLOSED HERE (D3 gap, found while writing this migration)
--
-- `nodes.level_id` was a PLAIN `references hierarchy_levels(id)` — the only
-- child FK in the schema that was not tenant-composite. A node in org A could
-- structurally reference a level in org B. hierarchy_levels had no
-- `unique (org_id, id)` for a composite FK to point at, which is presumably
-- why it was left plain. It has one now, so the FK is added. Same class of
-- hole as D83, one table over.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. hierarchy_templates — a named hierarchy shape within one org.
--    Column-for-column the shift_templates idiom (migration 0005), including
--    the `unique (org_id, id)` composite-FK anchor and no timestamps.
-- ----------------------------------------------------------------------------
create table hierarchy_templates (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name   text not null,
  unique (org_id, name),
  unique (org_id, id)
);

alter table hierarchy_templates enable row level security;

-- Policies mirror hierarchy_levels exactly: SELECT on org match, writes admin
-- + own org. The RPCs below are SECURITY INVOKER, so these are the real gate.
create policy hierarchy_templates_select on hierarchy_templates for select
  using (org_id = app_current_org());
create policy hierarchy_templates_insert on hierarchy_templates for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy hierarchy_templates_update on hierarchy_templates for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy hierarchy_templates_delete on hierarchy_templates for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- GRANTS. Migration 0008's grant block is `GRANT ... ON ALL TABLES IN SCHEMA
-- public`, which is a ONE-SHOT grant over the tables that existed when it ran
-- -- not a standing rule. A table created in a later migration therefore
-- arrives with RLS policies that read beautifully and NO table privilege at
-- all behind them, and every caller gets
--
--     ERROR:  permission denied for table hierarchy_templates  (42501)
--
-- long before any policy is consulted. Measured, not assumed: 16 cases in
-- 70_hierarchy_test.sql failed exactly this way before these three lines were
-- added. EVERY future migration that creates a table needs its own grant.
-- Guarded the same way 0008 guards its block, so this file still runs on a
-- scratch Postgres without the Supabase roles.
-- ----------------------------------------------------------------------------
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON hierarchy_templates TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON hierarchy_templates FROM anon';
  END IF;
END $do$;

-- ----------------------------------------------------------------------------
-- 2. hierarchy_levels.template_id, backfilled before it is made NOT NULL.
--
--    Every org that already has levels gets one template named 'Default'
--    holding all of them, so existing data keeps working unchanged and an org
--    that never adds a second template behaves exactly as it did before.
-- ----------------------------------------------------------------------------
alter table hierarchy_levels add column template_id uuid;

insert into hierarchy_templates (org_id, name)
  select o.id, 'Default'
    from orgs o
   where exists (select 1 from hierarchy_levels hl where hl.org_id = o.id);

update hierarchy_levels hl
   set template_id = ht.id
  from hierarchy_templates ht
 where ht.org_id = hl.org_id
   and ht.name = 'Default';

alter table hierarchy_levels alter column template_id set not null;

-- Composite, so a level cannot point at another tenant's template.
alter table hierarchy_levels
  add constraint hierarchy_levels_org_template_fkey
  foreign key (org_id, template_id) references hierarchy_templates (org_id, id);

-- The constraint this migration exists to move: position is unique WITHIN A
-- TEMPLATE, not within an org.
alter table hierarchy_levels drop constraint hierarchy_levels_org_id_position_key;
alter table hierarchy_levels
  add constraint hierarchy_levels_template_id_position_key unique (template_id, position);

-- Likewise the schedulable level: one per SHAPE. Two sites with different
-- shapes schedule at different depths, which is the whole requirement.
drop index hierarchy_levels_one_schedulable;
create unique index hierarchy_levels_one_schedulable
  on hierarchy_levels (template_id) where is_schedulable;

-- D3 gap, described in the header.
alter table hierarchy_levels add constraint hierarchy_levels_org_id_id_key unique (org_id, id);
alter table nodes
  add constraint nodes_org_level_fkey
  foreign key (org_id, level_id) references hierarchy_levels (org_id, id);

-- ----------------------------------------------------------------------------
-- 3. Adjacency, now template-aware.
--
--    CHECK ORDER IS THE CONTRACT (same rule as move_node / canDropOn): the
--    position check runs FIRST, the template check second. A Line at position
--    2 of shape A dropped under a Department at position 1 of shape B passes
--    the arithmetic and is caught by the template check; the same Line dropped
--    under a Zone at position 2 of shape B fails the arithmetic first. The
--    client mirror must report these in the same order or the preview will
--    disagree with the server.
--
--    Both raise `level_mismatch`. No new error code: the closed set in
--    src/lib/api/errors.ts stays at twelve, and `level_mismatch` already means
--    exactly "this node cannot sit under that parent given the level
--    definition". The DETAIL json distinguishes them for anyone debugging.
--
--    The app.hierarchy_migration escape hatch (D69) is preserved verbatim.
-- ----------------------------------------------------------------------------
create or replace function nodes_check_level_adjacency() returns trigger
language plpgsql as $$
declare
  v_own_position    int;
  v_own_template    uuid;
  v_parent_position int;
  v_parent_template uuid;
begin
  if coalesce(current_setting('app.hierarchy_migration', true), '') = 'on' then
    return new;
  end if;

  select position, template_id into v_own_position, v_own_template
    from hierarchy_levels where id = new.level_id;

  if new.parent_id is null then
    if v_own_position is distinct from 0 then
      perform api_raise('level_mismatch',
        format('node %s has no parent but its level is not position 0', new.id),
        jsonb_build_object('node_id', new.id));
    end if;
  else
    select hl.position, hl.template_id into v_parent_position, v_parent_template
      from nodes pn join hierarchy_levels hl on hl.id = pn.level_id
      where pn.id = new.parent_id;

    if v_parent_position is null or v_own_position is distinct from v_parent_position + 1 then
      perform api_raise('level_mismatch',
        format('node %s level position is not exactly one below its parent''s', new.id),
        jsonb_build_object('node_id', new.id));
    end if;

    if v_own_template is distinct from v_parent_template then
      perform api_raise('level_mismatch',
        format('node %s uses a different hierarchy template from its parent', new.id),
        jsonb_build_object('node_id', new.id,
                           'template_id', v_own_template,
                           'parent_template_id', v_parent_template));
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Template CRUD.
--
--    No new error codes. An unknown/foreign template id is `invalid_argument`
--    with field + reason, exactly as rename_node reports an unknown node; a
--    template whose levels still carry nodes is `level_in_use`, which is the
--    same fact save_hierarchy_levels already reports with the same
--    `level_ids` detail key.
-- ----------------------------------------------------------------------------
create function create_hierarchy_template(p_name text) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_name   text;
  v_id     uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(coalesce(p_name, ''));
  if v_name = '' then
    perform api_raise('invalid_argument', 'template name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  if exists (select 1 from hierarchy_templates where org_id = v_org_id and name = v_name) then
    perform api_raise('invalid_argument', 'a hierarchy template with that name already exists',
      jsonb_build_object('field', 'p_name', 'reason', 'duplicate name'));
  end if;

  insert into hierarchy_templates (org_id, name) values (v_org_id, v_name)
    returning id into v_id;

  -- A template with no levels cannot hold a node (a root needs a level at
  -- position 0), so it is inert until save_hierarchy_levels populates it.
  -- Deliberately NOT seeded with a starter level: inventing one would decide
  -- the site's shape on the admin's behalf, which is the thing this whole
  -- migration exists to stop doing.
  return jsonb_build_object('id', v_id, 'name', v_name, 'levels', '[]'::jsonb);
end;
$$;

create function rename_hierarchy_template(p_template_id uuid, p_name text) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_name   text;
  v_found  uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(coalesce(p_name, ''));
  if v_name = '' then
    perform api_raise('invalid_argument', 'template name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  select id into v_found from hierarchy_templates
    where id = p_template_id and org_id = v_org_id;
  if v_found is null then
    perform api_raise('invalid_argument', 'hierarchy template not found',
      jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
  end if;

  if exists (select 1 from hierarchy_templates
             where org_id = v_org_id and name = v_name and id <> p_template_id) then
    perform api_raise('invalid_argument', 'a hierarchy template with that name already exists',
      jsonb_build_object('field', 'p_name', 'reason', 'duplicate name'));
  end if;

  update hierarchy_templates set name = v_name where id = p_template_id;

  return jsonb_build_object('id', p_template_id, 'name', v_name);
end;
$$;

create function delete_hierarchy_template(p_template_id uuid) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id    uuid;
  v_found     uuid;
  v_level_ids uuid[];
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();

  select id into v_found from hierarchy_templates
    where id = p_template_id and org_id = v_org_id;
  if v_found is null then
    perform api_raise('invalid_argument', 'hierarchy template not found',
      jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
  end if;

  select coalesce(array_agg(hl.id), '{}') into v_level_ids
    from hierarchy_levels hl where hl.template_id = p_template_id;

  if exists (select 1 from nodes nd where nd.level_id = any(v_level_ids)) then
    perform api_raise('level_in_use', 'this hierarchy template still has nodes',
      jsonb_build_object('level_ids', to_jsonb(v_level_ids)));
  end if;

  delete from hierarchy_levels where template_id = p_template_id;
  delete from hierarchy_templates where id = p_template_id;

  return jsonb_build_object('id', p_template_id, 'deleted', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. save_hierarchy_levels — now edits ONE template's list.
--
--    The 1-argument version is DROPPED, not overloaded. Leaving it in place
--    would keep an org-wide writer exposed through PostgREST beside the
--    template-scoped one, and any client that had not been updated would go
--    on silently rewriting every template's positions. There is also no
--    `default null` on p_template_id for the same reason: "the org's only
--    template" is a guess, and guessing which shape the admin meant is
--    precisely the failure this migration removes.
--
--    Everything else is 0011's body with `org_id = v_org_id` replaced by
--    `template_id = v_template_id` at each of the seven places it scoped a
--    hierarchy_levels statement, plus two new checks (T1, T2). The org check
--    does not disappear — it moves to the TEMPLATE, which is the only row a
--    caller names, and the composite FK carries it down to the levels.
-- ----------------------------------------------------------------------------
drop function save_hierarchy_levels(jsonb);

create function save_hierarchy_levels(p_levels jsonb, p_template_id uuid) returns jsonb
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
           'name', hl.name, 'is_schedulable', hl.is_schedulable) order by hl.position), '[]'::jsonb)
    into v_result
    from hierarchy_levels hl
    where hl.template_id = v_template_id;

  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. board_window — return the levels of the TEMPLATES ACTUALLY IN THE WINDOW,
--    not every level in the org.
--
--    Before this migration `where hl.org_id = v_org_id` was harmless because
--    an org had one vocabulary. With several, it would ship every shape's
--    levels to the client and `order by hl.position` would interleave them
--    into one nonsense list -- two rows both claiming position 1.
--
--    board_window is already scoped to a single subtree by p_root_path, and a
--    tree cannot straddle templates (§3 above), so this resolves to exactly
--    one template today. It is written as a set anyway: an IN over the scoped
--    nodes' own levels stays correct without this comment having to remain
--    true, and `order by template_id, position` keeps the array deterministic
--    if it ever does return two.
--
--    `template_id` is added to each emitted level so the client can group and
--    label them. Everything else about the payload is untouched.
--    THIS FUNCTION BODY IS NOT HAND-COPIED. It was extracted from migration
--    0009 programmatically and had exactly the two hunks above applied by
--    string replacement; the diff was inspected and every other byte -- the
--    operators / products / skills / node_skill_requirements / shift_templates
--    / node_shift_map subqueries, the STABLE marker, the three argument
--    checks and their exact messages -- is identical to 0009. A hand-retyped
--    reproduction of a 129-line function is how subqueries go missing.
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
