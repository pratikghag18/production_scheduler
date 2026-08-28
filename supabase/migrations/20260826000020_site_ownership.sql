-- ============================================================================
-- 0020 — "each site is its own instance." the maintainer's frame, made real.
--
-- HIS WORDS:
--   "the system-admin or company-admin has access to all sites across the
--    company and they basically can change whatever they want at any site, but
--    the site-admin who are locked to the site can do whatever changes are
--    needed for that particular site… It is like each site could have their own
--    instance for the app so they're part of the larger system but only get to
--    access their own site."
--
-- THE TEST THAT FRAME GIVES US, and it decides every line below:
-- **can a site admin do this without touching another site?** If yes, it is
-- theirs. That is not a judgement about how much power to hand out; it is a
-- question about REACH, and it has an answer for each object in the schema.
--
-- 0019 built the substrate — a role belongs to a (person, place) pair — and
-- deliberately left every door bolted. This migration opens them.
--
-- ============================================================================
-- PART 1 (§1–§7): A SITE OWNS ITS STRUCTURE.
--
-- ⚠️ THE THING THAT BLOCKED "site admins may edit level names", AND IT IS NOT
-- OBVIOUS. A site's level vocabulary does not live on the site. It lives in a
-- `hierarchy_templates` row, and **nothing has ever tied a template to a
-- site**: `hierarchy_templates` has no node column and `nodes` has no template
-- column (D86 chose that deliberately — a node's template is derived through
-- its level). So two roots can quietly share one template, and a site admin
-- renaming "Line" to "Cell Group" would reshape the other plant.
--
-- MEASURED before writing this: every template in the database today is used by
-- exactly ONE root. Nobody is sharing. But "happens to be 1:1" is not an
-- invariant, and the model needs one — so this migration makes it one.
--
-- WHAT IT COSTS, stated plainly: one structure shared across several sites
-- stops being expressible. That is the right trade for the frame above. If
-- "roll this shape out to five plants" is wanted later, it becomes a
-- company-admin action that COPIES the shape into each site — which is safer
-- than sharing anyway, because the five plants can then diverge.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. The owning site.
--
-- NULLABLE, and that is not laziness — it is forced by the creation order. A
-- new site cannot be built in one statement: the template must exist before its
-- levels, the levels before the root node, and the root node before anything
-- can point at it. So a template is born unowned and is claimed a moment later.
-- An unowned template is company-admin-only, which is the safe default for the
-- window in which it exists.
--
-- The composite `(org_id, site_node_id)` foreign key is the D3 idiom used by
-- every other child table here: it makes a cross-tenant reference structurally
-- impossible rather than merely policy-forbidden.
-- ----------------------------------------------------------------------------
alter table hierarchy_templates add column site_node_id uuid;

alter table hierarchy_templates
  add constraint hierarchy_templates_org_id_site_node_id_fkey
  foreign key (org_id, site_node_id) references nodes (org_id, id);

-- One site, one structure. Without this a second template could claim a site
-- that already has one and the "which structure is this site's" question would
-- have two answers -- the same unordered-single-row hazard as D87, one table
-- over. NULLs are distinct in a unique index, so any number of templates may
-- sit unowned.
create unique index hierarchy_templates_site_node_id_key
  on hierarchy_templates (site_node_id) where site_node_id is not null;

comment on column hierarchy_templates.site_node_id is
  'The ROOT node whose site this structure belongs to (0020). NULL = unowned, company-admin-only, which is what a template is between being created and its root being built. A site admin may edit the structure of the site they administer and no other.';


-- ----------------------------------------------------------------------------
-- §2. Backfill: claim each template for the root that already uses it.
--
-- A template's roots are reachable only through its levels, which is exactly
-- the indirection that made this possible to overlook for so long:
--
--     hierarchy_templates <- hierarchy_levels <- nodes (parent_id is null)
--
-- `having count(*) = 1` is the honest half. If a template were already shared
-- by two roots this backfill MUST NOT pick one arbitrarily and silently make
-- the other site's admin a tenant of the first -- it leaves it unowned, where
-- only a company admin can act, and the ambiguity stays visible. Measured on
-- this database: every template has exactly one root, so nothing is skipped
-- here; the guard is for the databases this code has not met yet.
-- ----------------------------------------------------------------------------
update hierarchy_templates t
   set site_node_id = c.root_id
  from (
    -- NOT min(n.org_id): PostgreSQL has no min/max aggregate for uuid (42883,
    -- gotcha 16, and I wrote it here anyway). `array_agg(... order by ...)` is
    -- the idiom this project already uses in `create_node`.
    select l.template_id,
           (array_agg(n.org_id order by n.org_id))[1] as org_id,
           (array_agg(n.id order by n.id))[1] as root_id
      from hierarchy_levels l
      join nodes n on n.level_id = l.id and n.parent_id is null
     group by l.template_id
    having count(*) = 1
  ) c
 where c.template_id = t.id
   and c.org_id = t.org_id;   -- belt and braces; the FK enforces it too


-- ----------------------------------------------------------------------------
-- §3. A site is a ROOT. Enforced, not assumed.
--
-- Nothing in §1 stops a template claiming a Work Cell as its "site", and a
-- claim like that would quietly widen a site admin's reach: `app_is_admin_for`
-- would answer for the cell, and the cell's admin would own the whole
-- structure the plant above it uses. A CHECK constraint cannot look at another
-- table, so this is a trigger.
--
-- It fires on INSERT and on UPDATE OF site_node_id -- note the column list.
-- `hierarchy_templates` is also updated to rename it, and re-reading `nodes` on
-- every rename would be work for nothing.
-- ----------------------------------------------------------------------------
create or replace function hierarchy_templates_check_site() returns trigger
language plpgsql as $$
declare v_parent_id uuid; v_found boolean;
begin
  if new.site_node_id is null then
    return new;
  end if;

  select true, parent_id into v_found, v_parent_id
    from nodes where id = new.site_node_id and org_id = new.org_id;

  if v_found is not true then
    perform api_raise('invalid_argument', 'the owning site node was not found in this org',
      jsonb_build_object('field', 'site_node_id', 'reason', 'not found'));
  end if;

  if v_parent_id is not null then
    perform api_raise('invalid_argument',
      'a structure can only be owned by a top-level site, not by a node inside one',
      jsonb_build_object('field', 'site_node_id', 'reason', 'not a root node'));
  end if;

  return new;
end;
$$;

create trigger hierarchy_templates_check_site
  before insert or update of site_node_id, org_id on hierarchy_templates
  for each row execute function hierarchy_templates_check_site();


-- ----------------------------------------------------------------------------
-- §4. "Am I an admin over this STRUCTURE?"
--
-- Reads as one sentence: a company admin, or the admin of the site that owns
-- it. An UNOWNED structure has no site to be an admin of, so only the company
-- admin branch can answer -- which is what makes NULL the safe default in §1
-- rather than a hole.
--
-- Tenant-scoped internally, 0012's shape, so a caller that forgets its own org
-- term still cannot reach across a tenant.
--
-- ⚠️ NOT SAFE INSIDE `hierarchy_templates`' OWN `INSERT ... WITH CHECK`: it
-- reads that table, and the row being inserted is not yet visible to a fresh
-- read inside the same command. That is D85, and §5 uses the row's own
-- `site_node_id` column there instead. It IS safe in `hierarchy_levels`'
-- policies, which ask about a DIFFERENT table's row.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_for_template(p_template_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM hierarchy_templates t
    WHERE t.id = p_template_id
      AND t.org_id = app_current_org()
      AND (app_is_admin()
           OR (t.site_node_id IS NOT NULL AND app_is_admin_for(t.site_node_id)))
  );
$$;

comment on function app_is_admin_for_template(uuid) is
  'May the caller administer this structure -- company admin of its org, or the site admin of the site that owns it (0020)? Tenant-scoped internally. Do NOT call from hierarchy_templates'' own INSERT WITH CHECK: it reads that table (D85).';


-- ----------------------------------------------------------------------------
-- §5. The structure policies.
--
-- `hierarchy_templates` INSERT asks the row's own `site_node_id` column, never
-- the table -- D85 again, and the same shape 0019 used for `nodes`. In practice
-- that column is NULL on insert (see §1's creation order), so an insert is
-- company-admin-only: **creating a structure from nothing is not a site
-- admin's job; editing their own is.**
--
-- UPDATE names the predicate twice, so a site admin can neither push their
-- structure onto another site (WITH CHECK on the new row) nor claim one that
-- belongs elsewhere (USING on the old row). Same property 0019's S11 pins for
-- nodes, one table over.
--
-- SELECT is deliberately NOT narrowed: every structure in the org stays
-- readable. A site admin picking a shape to copy from needs to see the
-- shapes, and a structure's name and level list are not secrets -- the nodes
-- inside a site are, and those are governed by `nodes_select`.
-- ----------------------------------------------------------------------------
drop policy hierarchy_templates_insert on hierarchy_templates;
drop policy hierarchy_templates_update on hierarchy_templates;
drop policy hierarchy_templates_delete on hierarchy_templates;

create policy hierarchy_templates_insert on hierarchy_templates for insert
  with check (
    org_id = app_current_org()
    and (app_is_admin()
         or (site_node_id is not null and app_is_admin_for(site_node_id)))
  );

create policy hierarchy_templates_update on hierarchy_templates for update
  using (
    org_id = app_current_org()
    and (app_is_admin()
         or (site_node_id is not null and app_is_admin_for(site_node_id)))
  )
  with check (
    org_id = app_current_org()
    and (app_is_admin()
         or (site_node_id is not null and app_is_admin_for(site_node_id)))
  );

create policy hierarchy_templates_delete on hierarchy_templates for delete
  using (
    org_id = app_current_org()
    and (app_is_admin()
         or (site_node_id is not null and app_is_admin_for(site_node_id)))
  );

-- `hierarchy_levels` rows carry `template_id`, which points at a row in a
-- DIFFERENT table, so the id-taking predicate is safe here on all four.
drop policy hierarchy_levels_insert on hierarchy_levels;
drop policy hierarchy_levels_update on hierarchy_levels;
drop policy hierarchy_levels_delete on hierarchy_levels;

create policy hierarchy_levels_insert on hierarchy_levels for insert
  with check (org_id = app_current_org() and app_is_admin_for_template(template_id));

create policy hierarchy_levels_update on hierarchy_levels for update
  using (org_id = app_current_org() and app_is_admin_for_template(template_id))
  with check (org_id = app_current_org() and app_is_admin_for_template(template_id));

create policy hierarchy_levels_delete on hierarchy_levels for delete
  using (org_id = app_current_org() and app_is_admin_for_template(template_id));


-- ----------------------------------------------------------------------------
-- §6. Grants for the new function.
--
-- The REVOKE is the load-bearing half, not the GRANT -- `authenticated` is a
-- member of PUBLIC and PostgreSQL grants EXECUTE to PUBLIC by default, so a
-- bare grant is decoration. 0019's mutation X15 proved that by deleting one and
-- being caught by nothing until the revoke was added.
-- ----------------------------------------------------------------------------
revoke execute on function app_is_admin_for_template(uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_is_admin_for_template(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_is_admin_for_template(uuid) from anon';
  end if;
end $$;


-- ============================================================================
-- §7. The structure RPCs follow the structure.
--
-- ⚠️ EVERY BODY BELOW WAS EXTRACTED FROM THE LIVE DATABASE with
-- `pg_get_functiondef`, NOT copied from the migration that first wrote it.
-- That is decision-record-drift rule 3, and this project has been bitten by it
-- twice: 0011 re-created `create_node` after 0010, and 0014 re-created
-- `nodes_check_level_adjacency` after 0010 -- and extracting from the older
-- file silently reverted the newer fix both times. The ONLY safe source for
-- "what does this function do today" is the database.
--
-- The single edit in each is the permission guard. Everything else is byte-for-
-- byte what was already running.
--
-- `create_hierarchy_template` is deliberately NOT here: it stays company-admin.
-- Creating a structure from nothing is not a site's business -- a new site is
-- created BY a company admin, and §8 gives it its own structure at that moment.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_hierarchy_levels(p_levels jsonb, p_template_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_org_id := app_current_org();

  -- T1. the template must exist IN THIS ORG. Runs before any p_levels check so
  -- a caller naming another tenant's template learns nothing about its levels.
  select id into v_template_id from hierarchy_templates
    where id = p_template_id and org_id = v_org_id;
  if v_template_id is null then
    perform api_raise('invalid_argument', 'hierarchy template not found',
      jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
  end if;

  -- 0020: PERMISSION IS CHECKED HERE, NOT AT THE TOP, AND THE ORDER IS THE
  -- CONTRACT. The existence lookup above is org-scoped, so a caller naming
  -- another tenant's structure still learns only "not found" -- moving the
  -- permission check ahead of it would turn every typo'd id in the caller's own
  -- org into `not_permitted` and every cross-tenant probe into the same, which
  -- is less informative for real users and no safer. Three existing cases
  -- (T9, T10a, T18) pin that ordering; they failed when this guard sat at the
  -- top, which is how the change was noticed.
  if not app_is_admin_for_template(p_template_id) then
    perform api_raise('not_permitted',
      'admin rights are required on the site that owns this structure',
      jsonb_build_object('template_id', p_template_id));
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
$function$;

CREATE OR REPLACE FUNCTION public.rename_hierarchy_template(p_template_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id uuid;
  v_name   text;
  v_found  uuid;
begin
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

  -- 0020: PERMISSION IS CHECKED HERE, NOT AT THE TOP, AND THE ORDER IS THE
  -- CONTRACT. The existence lookup above is org-scoped, so a caller naming
  -- another tenant's structure still learns only "not found" -- moving the
  -- permission check ahead of it would turn every typo'd id in the caller's own
  -- org into `not_permitted` and every cross-tenant probe into the same, which
  -- is less informative for real users and no safer. Three existing cases
  -- (T9, T10a, T18) pin that ordering; they failed when this guard sat at the
  -- top, which is how the change was noticed.
  if not app_is_admin_for_template(p_template_id) then
    perform api_raise('not_permitted',
      'admin rights are required on the site that owns this structure',
      jsonb_build_object('template_id', p_template_id));
  end if;

  if exists (select 1 from hierarchy_templates
             where org_id = v_org_id and name = v_name and id <> p_template_id) then
    perform api_raise('invalid_argument', 'a hierarchy template with that name already exists',
      jsonb_build_object('field', 'p_name', 'reason', 'duplicate name'));
  end if;

  update hierarchy_templates set name = v_name where id = p_template_id;

  return jsonb_build_object('id', p_template_id, 'name', v_name);
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_hierarchy_template(p_template_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id    uuid;
  v_found     uuid;
  v_level_ids uuid[];
begin
  v_org_id := app_current_org();

  select id into v_found from hierarchy_templates
    where id = p_template_id and org_id = v_org_id;
  if v_found is null then
    perform api_raise('invalid_argument', 'hierarchy template not found',
      jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
  end if;

  -- 0020: PERMISSION IS CHECKED HERE, NOT AT THE TOP, AND THE ORDER IS THE
  -- CONTRACT. The existence lookup above is org-scoped, so a caller naming
  -- another tenant's structure still learns only "not found" -- moving the
  -- permission check ahead of it would turn every typo'd id in the caller's own
  -- org into `not_permitted` and every cross-tenant probe into the same, which
  -- is less informative for real users and no safer. Three existing cases
  -- (T9, T10a, T18) pin that ordering; they failed when this guard sat at the
  -- top, which is how the change was noticed.
  if not app_is_admin_for_template(p_template_id) then
    perform api_raise('not_permitted',
      'admin rights are required on the site that owns this structure',
      jsonb_build_object('template_id', p_template_id));
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
$function$;


-- ============================================================================
-- PART 2 (§8–§12): THE DOORS. 0019 built the substrate and left every RPC and
-- every non-node policy opening with `app_is_admin()`; a site admin was
-- admitted by the model and stopped by the doors. This part opens them, one
-- object at a time, against the single test the maintainer's frame gives:
--
--     CAN A SITE ADMIN DO THIS WITHOUT TOUCHING ANOTHER SITE?
--
-- Where the answer is yes it becomes theirs. Where an action creates,
-- destroys, or re-parents A SITE ITSELF, it stays a company action -- not
-- because it is dangerous, but because by definition it does not fit inside
-- one site.
--
-- WHERE TO FIND EACH SECTION, since two of them live inside a function body
-- rather than under a heading of their own:
--   §8.0  the SECURITY DEFINER existence lookup (below)
--   §8    the node RPCs (below)
--   §8.5  the rename a site admin could not do (below)
--   §9    profile_grants (below)
--   §10   the root branch of `create_node` COPIES the structure -- INSIDE
--         create_node, marked "0020 §10", because the copy has to happen
--         between resolving the source and inserting the node
--   §11   the change this migration deliberately does NOT make (below)
--   §12   node_skill_requirements / node_shift_templates (below)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §8.0. One SECURITY DEFINER lookup, and why "not found" was becoming a lie.
--
-- Every node RPC opens with an org-scoped read of `nodes`, and that read runs
-- as the CALLER. For a company admin `nodes_select` shows the whole org, so an
-- empty result really did mean "no such node". For a SITE admin it does not:
-- everything outside their grant is invisible, so a perfectly real node in
-- their own company reads back as `invalid_argument / not found`.
--
-- That is the same class of defect as §19.44's `level_mismatch`-for-
-- `not_permitted` -- an error code from the closed set of twelve, describing
-- the wrong thing, because a lookup could not see what it was asking about.
--
-- This answers the question with RLS out of the way, and it is scoped to
-- `app_current_org()`, so THE TENANT BOUNDARY KEEPS ITS SILENCE: another
-- company's node is still "not found", exactly as T9/T10a/T18 require. Only
-- the intra-company case gets the sharper answer.
-- ----------------------------------------------------------------------------
create or replace function app_node_exists_in_org(p_node_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes n WHERE n.id = p_node_id AND n.org_id = app_current_org()
  );
$$;

comment on function app_node_exists_in_org(uuid) is
  'Does this node exist in the caller''s org, regardless of whether the caller can SEE it (0020 §8.0)? Used only to tell "no such node" from "not yours" -- it grants nothing and is org-scoped, so it says nothing about another tenant.';

-- ⛔ THERE WAS A SECOND HELPER HERE AND THE MUTATION RUN DELETED IT.
-- `app_node_parent_in_org` existed so that `promote_node` could read a node's
-- GRANDPARENT with RLS out of the way, on the reasoning that a site admin whose
-- grant sits ON the parent cannot see the grandparent, so an RLS-scoped read
-- would return NULL -- indistinguishable from "the parent is a root", silently
-- turning a promote into a site create.
--
-- **THE REASONING WAS WRONG, AND ONLY RUNNING IT SHOWED THAT.** The grandparent
-- is not a ROW being read, it is the `parent_id` COLUMN of the parent's row --
-- and the parent is visible, because the caller had to be able to see the node
-- underneath it to name it at all. RLS filters rows; it does not blank out
-- columns. The mutation that reverted the helper to a plain read was caught by
-- nothing, and MEASURED side by side the two produce the identical refusal:
--
--   as shipped (helper)  -> not_permitted
--   plain RLS-scoped read -> not_permitted
--
-- So the helper is gone rather than kept with an unfalsifiable justification
-- (gotcha 17: when a mutation cannot be caught by any test, consider deleting
-- the thing that needed guarding). `app_node_exists_in_org` stays: its
-- mutation IS caught, because it answers about a row nobody has read.
revoke execute on function app_node_exists_in_org(uuid) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_node_exists_in_org(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_node_exists_in_org(uuid) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §8. The node RPCs.
--
-- ⚠️ EVERY BODY BELOW WAS EXTRACTED FROM THE LIVE DATABASE with
-- `pg_get_functiondef` and edited by string replacement with a uniqueness
-- assertion on each anchor -- never retyped, and never taken from the
-- migration that first wrote the function. `create_node` alone has been
-- re-created by 0010, 0011 and 0015, and `nodes_check_level_adjacency` by
-- 0010, 0014 and 0017; taking either from its original file silently reverts
-- two later fixes. (decision-record-drift rule 3, verification rule 12.)
--
-- THE SHAPE OF EVERY EDIT IS THE SAME, and the ORDER inside it is the
-- contract: existence first, then permission, then the semantic checks. Three
-- existing cases (T9, T10a, T18) were written to pin that ordering when §7
-- got it wrong, and the same reasoning applies here.
--
-- WHO MAY DO WHAT, in one table:
--
--   create_node, no parent ....... company admin      (it creates a SITE)
--   create_node, with a parent ... admin for the parent
--   rename_node .................. admin for the node
--   delete_node, a root .......... company admin      (it destroys a SITE)
--   delete_node, otherwise ....... admin for the node
--   move_node, source is a root .. company admin
--   move_node, no destination .... company admin      (it creates a SITE)
--   move_node, otherwise ......... admin for the node AND for the destination
--   place_node ................... whatever move_node says (no guard of its own)
--   promote/demote ............... whatever app_relevel_subtree says
--   app_relevel_subtree .......... admin for the node AND for the destination;
--                                  company admin when the destination is NULL
--
-- BOTH ENDS OF EVERY MOVE ARE CHECKED, and that is not belt-and-braces. A
-- grant sits on a node and covers its subtree, so being admin for a node says
-- nothing about being admin for that node's grandparent, which is ABOVE the
-- grant. Checking only the source would let a site admin walk a node out of
-- their own site.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_node(p_parent_id uuid, p_name text, p_sort_order integer DEFAULT 0, p_template_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id               uuid;
  v_name                 text;
  v_parent_path          ltree;
  v_parent_position      int;
  v_parent_template_id   uuid;
  v_level_id             uuid;
  v_prospective_path     ltree;
  v_existing_node_id     uuid;
  v_node                 nodes%rowtype;
  v_resolved_template_id uuid;
  v_template_count       int;
  v_copied_template_id   uuid;
  v_copy_name            text;
  v_copy_suffix          int;
begin
  -- 0020 §8. CREATING A SITE IS A COMPANY ACTION; creating anything INSIDE a
  -- site is that site's. There is no node to scope a root create against --
  -- that is the whole point of it -- so the root branch keeps the org-wide
  -- check, and the child branch's check sits below, immediately after the
  -- parent has been found (T9/T10a/T18's ordering).
  if p_parent_id is null and not app_is_admin() then
    perform api_raise('not_permitted', 'company-admin rights are required to create a site',
      jsonb_build_object('reason', 'root create is company-admin only'));
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(p_name);
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  if p_parent_id is null then
    -- Root branch (D87 §5.3): resolve WHICH TEMPLATE this root belongs to
    -- before touching hierarchy_levels at all.
    if p_template_id is null then
      -- Two queries, not one: `min`/`max` have no aggregate defined for
      -- `uuid` (measured -- `min(uuid)` raises `42883, function min(uuid)
      -- does not exist`), so the count and the single surviving row's id
      -- cannot be fetched in the same `select ... into` the way an integer
      -- or text key could be.
      -- Count and pick in ONE statement, deliberately (design session, Aug 25).
      -- Two separate queries meant two org scopes to keep in sync, and deleting
      -- the scope from the PICK alone was caught by NOTHING in either suite: it
      -- makes `select ... into` arbitrary across every org's templates, which is
      -- the same unordered-single-row hazard D87 is about, one line over.
      -- NOT min(id): PostgreSQL has no min/max aggregate for uuid (42883). uuid
      -- HAS a btree ordering, so `order by` inside array_agg works and is also
      -- deterministic where a bare `select id into` was not.
      select count(*), (array_agg(id order by id))[1]
        into v_template_count, v_resolved_template_id
        from hierarchy_templates where org_id = v_org_id;
      if v_template_count <> 1 then
        perform api_raise('invalid_argument',
          'p_template_id is required: pass the id of the hierarchy template this root belongs to',
          jsonb_build_object('field', 'p_template_id',
            'reason', case when v_template_count = 0 then 'no templates' else 'ambiguous' end,
            'template_count', v_template_count));
      end if;
    else
      -- The `and org_id = v_org_id` is load-bearing and is NOT made
      -- redundant by RLS -- see brief §8.1's T22, which runs as the table
      -- owner (RLS bypassed) for exactly this reason.
      select id into v_resolved_template_id from hierarchy_templates
        where id = p_template_id and org_id = v_org_id;
      if v_resolved_template_id is null then
        perform api_raise('invalid_argument', 'hierarchy template not found',
          jsonb_build_object('field', 'p_template_id', 'reason', 'not found'));
      end if;
    end if;

    -- ------------------------------------------------------------------
    -- 0020 §10. A NEW SITE GETS ITS OWN COPY OF THE STRUCTURE.
    --
    -- The maintainer, asked and answered: a new site is set up by choosing an
    -- existing shape, and it gets a COPY of it, not a reference to it.
    -- p_template_id therefore stops meaning "the structure this root uses"
    -- and starts meaning "the structure to copy from".
    --
    -- THIS IS NOT COSMETIC, IT IS WHAT MAKES §1 TRUE. `nodes` has no
    -- template column (D86) -- a node's structure is reached through its
    -- level -- so nothing stops two roots being built on one template's
    -- position-0 level, and the unique index in §1 cannot see it happen
    -- because such a create never touches `hierarchy_templates` at all.
    -- Before this section, "one site, one structure" was enforced against
    -- the only path that could not violate it. Copying closes that.
    --
    -- The source's emptiness is checked BEFORE anything is created, so a
    -- refused create leaves no orphan structure behind. (The transaction
    -- would roll it back anyway; leaving the check where a reader can see
    -- the ordering costs nothing.)
    -- ------------------------------------------------------------------
    if not exists (select 1 from hierarchy_levels
                    where template_id = v_resolved_template_id and position = 0) then
      perform api_raise('level_mismatch', 'this hierarchy template has no levels yet',
        jsonb_build_object('template_id', v_resolved_template_id));
    end if;

    -- The copy is named for the site. `unique (org_id, name)` means a
    -- collision is possible -- two sites may not share a name either, but a
    -- structure may already carry the name from an earlier, deleted site --
    -- so the suffix loop is a real path, not defensive padding. It is
    -- bounded: 64 attempts, then the insert is allowed to raise the
    -- constraint rather than spin.
    v_copy_name := v_name;
    v_copy_suffix := 1;
    while v_copy_suffix < 64
      and exists (select 1 from hierarchy_templates
                   where org_id = v_org_id and name = v_copy_name) loop
      v_copy_suffix := v_copy_suffix + 1;
      v_copy_name := v_name || ' (' || v_copy_suffix || ')';
    end loop;

    insert into hierarchy_templates (org_id, name)
      values (v_org_id, v_copy_name)
      returning id into v_copied_template_id;

    -- position, name AND is_schedulable, all of them. A copy that lost the
    -- schedulable flag would produce a site on which nothing can be booked,
    -- and `save_hierarchy_levels` check 5 would then refuse every later
    -- edit of it ("exactly one level must be schedulable"), which is a
    -- dead-end nobody could get out of from the UI.
    insert into hierarchy_levels (org_id, template_id, position, name, is_schedulable)
      select v_org_id, v_copied_template_id, hl.position, hl.name, hl.is_schedulable
        from hierarchy_levels hl
       where hl.template_id = v_resolved_template_id;

    select id into v_level_id from hierarchy_levels
      where template_id = v_copied_template_id and position = 0;
    if v_level_id is null then
      -- Ordinary, not exotic: create_hierarchy_template deliberately creates
      -- an EMPTY template (0014's own comment). Without this guard the
      -- insert below reaches nodes_check_level_adjacency with a NULL
      -- level_id and is refused with "node ... has no parent but its level
      -- is not position 0" -- a true statement about a level that does not
      -- exist, and a baffling thing for an admin to read.
      perform api_raise('level_mismatch', 'this hierarchy template has no levels yet',
        jsonb_build_object('template_id', v_resolved_template_id));
    end if;
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = p_parent_id and org_id = v_org_id;
    if v_parent_path is null then
      -- 0020 §8. THE READ ABOVE IS RLS-SCOPED, so a node the caller cannot
      -- reach is invisible here and "not found" would be a lie about a node
      -- that exists. app_node_exists_in_org is SECURITY DEFINER and org-scoped,
      -- so it separates the two -- and it stays silent across tenants, which is
      -- the property T9/T10a/T18 were protecting.
      if app_node_exists_in_org(p_parent_id) then
        perform api_raise('not_permitted', 'admin rights are required on the parent node',
          jsonb_build_object('node_id', p_parent_id));
      end if;
      perform api_raise('invalid_argument', 'parent node not found',
        jsonb_build_object('field', 'p_parent_id', 'reason', 'not found'));
    end if;

    if not app_is_admin_for(p_parent_id) then
      perform api_raise('not_permitted', 'admin rights are required on the parent node',
        jsonb_build_object('node_id', p_parent_id));
    end if;

    -- Child branch (D87 §5.3): the parent's TEMPLATE is fixed by the parent,
    -- so its position and its template_id are read together, in the same
    -- single query 0011 already ran here.
    select hl.position, hl.template_id into v_parent_position, v_parent_template_id
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
      where n.id = p_parent_id;

    if p_template_id is not null and p_template_id is distinct from v_parent_template_id then
      -- A child's shape is fixed by its parent, so p_template_id is not a
      -- choice here; accepting a contradicting one silently would let a
      -- caller believe it had chosen.
      perform api_raise('invalid_argument', 'p_template_id does not match the parent''s hierarchy template',
        jsonb_build_object('field', 'p_template_id', 'reason', 'not the parent''s template',
          'parent_template_id', v_parent_template_id));
    end if;

    select id into v_level_id
      from hierarchy_levels where template_id = v_parent_template_id and position = v_parent_position + 1;
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

  -- 0020 §10. THE CLAIM, AND IT CANNOT HAPPEN EARLIER. §1's composite FK
  -- points at a `nodes` row, and §3's trigger insists that row be a root, so
  -- the structure cannot name its site until the site exists. That ordering
  -- is exactly why `site_node_id` is nullable.
  if v_copied_template_id is not null then
    update hierarchy_templates set site_node_id = v_node.id
      where id = v_copied_template_id;
  end if;

  return jsonb_build_object(
    'id', v_node.id, 'name', v_node.name, 'path', v_node.path::text,
    'parent_id', v_node.parent_id, 'level_id', v_node.level_id,
    'sort_order', v_node.sort_order, 'active', v_node.active,
    -- New in 0020, and additive: the structure this site now owns. A root
    -- create returns the id of the COPY, never of the shape it was copied
    -- from, so a caller cannot accidentally go on to edit the source.
    'template_id', v_copied_template_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.rename_node(p_node_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id            uuid;
  v_name              text;
  v_node              nodes%rowtype;
  v_parent_path       ltree;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
begin
  v_org_id := app_current_org();
  v_name := app_trim_ws(p_name);
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  -- 0020 §8. A rename neither creates, destroys nor re-parents anything: it
  -- changes one site's own wording, which is squarely inside the frame ("can a
  -- site admin do this without touching another site?"). A site admin renaming
  -- their OWN site is therefore allowed -- app_is_admin_for(root) is true only
  -- for an admin grant on that very root.
  if not app_is_admin_for(p_node_id) then
    perform api_raise('not_permitted', 'admin rights are required on this node',
      jsonb_build_object('node_id', p_node_id));
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
$function$;
CREATE OR REPLACE FUNCTION public.move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id            uuid;
  v_node              nodes%rowtype;
  v_own_position      int;
  v_parent_path       ltree;
  v_parent_position   int;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
begin
  v_org_id := app_current_org();

  -- 1. unknown node.
  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  -- 0020 §8. A MOVE HAS TWO ENDS AND BOTH ARE CHECKED. This is the source end.
  -- Moving a SITE (a node with no parent) is a company action whichever way it
  -- goes -- it either dissolves a site into another or relocates a whole plant
  -- -- so a root source is company-admin only.
  if v_node.parent_id is null then
    if not app_is_admin() then
      perform api_raise('not_permitted', 'company-admin rights are required to move a site',
        jsonb_build_object('reason', 'the node being moved is a site'));
    end if;
  elsif not app_is_admin_for(p_node_id) then
    perform api_raise('not_permitted', 'admin rights are required on the node being moved',
      jsonb_build_object('node_id', p_node_id));
  end if;

  select position into v_own_position from hierarchy_levels where id = v_node.level_id;

  if p_new_parent_id is null then
    -- 2. NULL parent allowed only if the node is already at level position 0.
    -- 0020 §8: and only a company admin may do it -- detaching a node to stand
    -- on its own is CREATING A SITE by another name, and create_node's root
    -- branch is company-admin for exactly the same reason.
    if not app_is_admin() then
      perform api_raise('not_permitted', 'company-admin rights are required to detach a node into a site',
        jsonb_build_object('reason', 'a parentless node is a site'));
    end if;
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
      if app_node_exists_in_org(p_new_parent_id) then
        perform api_raise('not_permitted', 'admin rights are required on the destination',
          jsonb_build_object('node_id', p_new_parent_id));
      end if;
      perform api_raise('invalid_argument', 'new parent node not found',
        jsonb_build_object('field', 'p_new_parent_id', 'reason', 'not found'));
    end if;

    -- 4b. 0020 §8/§11. THE DESTINATION END, AND ITS POSITION IN THIS LIST IS
    -- THE FIX §19.44 ASKED FOR. Step 6 below reads the destination's level
    -- through hierarchy_levels as the caller; for a destination outside a site
    -- admin's reach that read comes back empty and step 6 reports
    -- `level_mismatch` -- a permission refusal wearing a modelling error's
    -- error code, out of a closed set of twelve the client switches on.
    -- Answering the permission question FIRST is what stops that.
    if not app_is_admin_for(p_new_parent_id) then
      perform api_raise('not_permitted', 'admin rights are required on the destination',
        jsonb_build_object('node_id', p_new_parent_id));
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
$function$;

CREATE OR REPLACE FUNCTION public.delete_node(p_node_id uuid, p_mode text DEFAULT 'deactivate'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id             uuid;
  v_node               nodes%rowtype;
  v_children_count     int;
  v_runs_count         int;
  v_assignments_count  int;
  v_deactivated_count  int;
begin
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
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  -- 0020 §8. DESTROYING A SITE IS A COMPANY ACTION -- and note that this covers
  -- `deactivate` as well as `delete`, because deactivating a root deactivates
  -- the whole site (the update below is `path <@ v_node.path`).
  if v_node.parent_id is null then
    if not app_is_admin() then
      perform api_raise('not_permitted', 'company-admin rights are required to remove a site',
        jsonb_build_object('reason', 'the node is a site'));
    end if;
  elsif not app_is_admin_for(p_node_id) then
    perform api_raise('not_permitted', 'admin rights are required on this node',
      jsonb_build_object('node_id', p_node_id));
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
$function$;

CREATE OR REPLACE FUNCTION public.place_node(p_node_id uuid, p_new_parent_id uuid, p_index integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id uuid;
  v_ids    uuid[];
  v_target int;
  v_result jsonb;
begin
  -- 0020 §8. NO PERMISSION CHECK OF ITS OWN, DELIBERATELY. Every path through
  -- this function begins with the move_node call below, which now checks both
  -- ends of the move (and refuses a null destination to anyone but a company
  -- admin). A second copy here could not be mutation-tested -- no case could
  -- distinguish deleting it from leaving it -- and gotcha 17 says the honest
  -- response to an unfalsifiable guard is to remove it, not to keep it for
  -- comfort. The renumber below only ever rewrites the sort_order of the
  -- destination's own children, which move_node has already authorised.
  v_org_id := app_current_org();

  perform move_node(p_node_id, p_new_parent_id);

  -- Siblings in their CURRENT display order, the moved node excluded. This
  -- ORDER BY is compareSiblings (sort_order, name, id) — after the renumber
  -- below every sort_order is distinct, so the name/id tiebreaks can never
  -- fire again and the stored order becomes authoritative.
  select coalesce(array_agg(n.id order by n.sort_order, n.name, n.id), '{}')
    into v_ids
    from nodes n
   where n.org_id = v_org_id
     and n.parent_id is not distinct from p_new_parent_id
     and n.id <> p_node_id;

  -- Clamped to [0, n], and a NULL index means "first". A drop can only produce
  -- an index in range; refusing an out-of-range one would hand the caller a
  -- refusal with nothing useful to do about it, and "before everything" /
  -- "after everything" are unambiguous.
  v_target := least(greatest(coalesce(p_index, 0), 0), coalesce(array_length(v_ids, 1), 0));
  v_ids := (v_ids)[1:v_target] || p_node_id || (v_ids)[v_target + 1:];

  -- Dense renumber 0..n-1. NO GAP SCHEME: gaps let a later insert avoid
  -- touching siblings, but every sibling starts at 0 so the first placement
  -- must renumber regardless, and a gap scheme re-collapses and needs a
  -- rebalancer nobody will maintain. This only ever rewrites one parent's
  -- children. The SOURCE parent is deliberately left alone — removing an
  -- element does not change the relative order of the rest, so there is
  -- nothing to assert there.
  update nodes n set sort_order = t.ord - 1
    from unnest(v_ids) with ordinality as t(id, ord)
   where n.id = t.id and n.sort_order is distinct from t.ord - 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'name', n.name, 'parent_id', n.parent_id,
           'sort_order', n.sort_order, 'path', n.path::text) order by n.sort_order), '[]'::jsonb)
    into v_result
    from nodes n
   where n.org_id = v_org_id and n.parent_id is not distinct from p_new_parent_id;

  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION public.promote_node(p_node_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_org_id uuid; v_parent_id uuid; v_grandparent_id uuid; v_found boolean;
begin
  -- 0020 §8. NO PERMISSION CHECK OF ITS OWN. Both ends of this move are
  -- app_relevel_subtree's arguments (this node, and the derived grandparent),
  -- and that function -- which `authenticated` can also call directly, so it
  -- needs the guard regardless (case M30) -- checks both. A second copy here
  -- would be unfalsifiable. The two refusals below are statements about the
  -- ARGUMENTS, true whoever is asking, and reporting them first is the same
  -- existence-before-permission ordering T9/T10a/T18 pin.
  v_org_id := app_current_org();

  select true, parent_id into v_found, v_parent_id
    from nodes where id = p_node_id and org_id = v_org_id;
  if v_found is not true then
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;
  if v_parent_id is null then
    perform api_raise('level_mismatch', 'a top-level node cannot be promoted',
      jsonb_build_object('reason', 'already at the first level'));
  end if;

  -- DERIVED, not given: the grandparent, or NULL when the parent is a root and
  -- this node becomes one.
  -- An ordinary RLS-scoped read, and §8.0 records the helper this used to call
  -- and why it was deleted: the grandparent is a COLUMN of the parent's row,
  -- not a row of its own, and the parent is necessarily visible to anyone who
  -- could name its child.
  select parent_id into v_grandparent_id
    from nodes where id = v_parent_id and org_id = v_org_id;

  return app_relevel_subtree(p_node_id, v_grandparent_id, -1);
end;
$function$;

CREATE OR REPLACE FUNCTION public.demote_node(p_node_id uuid, p_new_parent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id uuid; v_node nodes%rowtype; v_target nodes%rowtype;
  v_own_pos int; v_target_pos int; v_own_tpl uuid; v_target_tpl uuid;
begin
  -- 0020 §8. NO PERMISSION CHECK OF ITS OWN -- app_relevel_subtree checks both
  -- ends. See promote_node for the full reasoning; the two refusals below are
  -- statements about the arguments, not about who is asking.
  v_org_id := app_current_org();

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;
  select * into v_target from nodes where id = p_new_parent_id and org_id = v_org_id;
  if v_target.id is null then
    if app_node_exists_in_org(p_new_parent_id) then
      perform api_raise('not_permitted', 'admin rights are required on the destination',
        jsonb_build_object('node_id', p_new_parent_id));
    end if;
    perform api_raise('invalid_argument', 'new parent node not found',
      jsonb_build_object('field', 'p_new_parent_id', 'reason', 'not found'));
  end if;

  -- The target must not be inside the subtree being moved. Checked BEFORE the
  -- level comparison: a node inside its own subtree is at the wrong level too,
  -- and "you cannot put this under its own child" is the truer explanation.
  if v_target.path <@ v_node.path then
    perform api_raise('node_cycle', 'cannot demote a node beneath its own descendant',
      jsonb_build_object('node_id', p_node_id));
  end if;

  select position, template_id into v_own_pos, v_own_tpl
    from hierarchy_levels where id = v_node.level_id;
  select position, template_id into v_target_pos, v_target_tpl
    from hierarchy_levels where id = v_target.level_id;

  -- A demote makes the node a child of something at ITS OWN rung, in its own
  -- structure. Anything else is a different operation (that is move_node).
  if v_own_tpl is distinct from v_target_tpl or v_own_pos is distinct from v_target_pos then
    perform api_raise('level_mismatch',
      'a node can only be demoted under another node at its own level in the same structure',
      jsonb_build_object('reason', 'target is not at the node''s own level'));
  end if;

  return app_relevel_subtree(p_node_id, p_new_parent_id, 1);
end;
$function$;

CREATE OR REPLACE FUNCTION public.app_relevel_subtree(p_node_id uuid, p_new_parent_id uuid, p_delta integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org_id   uuid;
  v_node     nodes%rowtype;
  v_ids      uuid[];
  v_missing  int;
  v_stranded int;
  v_result   jsonb;
  r          record;
begin
  v_org_id := app_current_org();

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    if app_node_exists_in_org(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on this node',
        jsonb_build_object('node_id', p_node_id));
    end if;
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  -- 0020 §8. THE SINGLE PERMISSION CHECK FOR BOTH RE-LEVEL RPCS. promote_node
  -- and demote_node delegate here and carry no guard of their own, so this one
  -- is load-bearing three ways: for a direct call (M30 proves `authenticated`
  -- can make one), for promote, and for demote.
  --
  -- BOTH ENDS, and the null case is a SITE. A promote whose derived grandparent
  -- is NULL turns the node into a top-level site, which create_node's root
  -- branch and move_node's detach branch both reserve for a company admin.
  if p_new_parent_id is null then
    if not app_is_admin() then
      perform api_raise('not_permitted', 'company-admin rights are required to promote a node into a site',
        jsonb_build_object('reason', 'a parentless node is a site'));
    end if;
  else
    if not app_is_admin_for(p_node_id) then
      perform api_raise('not_permitted', 'admin rights are required on the node being moved',
        jsonb_build_object('node_id', p_node_id));
    end if;
    -- The destination is NOT implied by the source. A grant sits on a node and
    -- covers its subtree, so an admin grant on the node says nothing about the
    -- node's own grandparent, which is ABOVE the grant. Checking only the
    -- source would let a site admin promote a node clean out of their site.
    if not app_is_admin_for(p_new_parent_id) then
      perform api_raise('not_permitted', 'admin rights are required on the destination',
        jsonb_build_object('node_id', p_new_parent_id));
    end if;
  end if;

  -- CAPTURED BEFORE ANY WRITE. The re-parent rewrites every descendant's path,
  -- so a `path <@` predicate evaluated afterwards reads a different tree than
  -- the caller named.
  select coalesce(array_agg(n.id), '{}') into v_ids
    from nodes n where n.org_id = v_org_id and n.path <@ v_node.path;

  -- Every distinct level in the subtree must have a rung to land on, checked UP
  -- FRONT. Measured before this guard existed: a demote off the bottom of a
  -- template did NOT fail — the level update matched zero rows, the parent
  -- change stood, and the tree was left with an adjacency violation.
  select count(*) into v_missing
    from (select distinct n.level_id from nodes n where n.id = any(v_ids)) s
    join hierarchy_levels cur on cur.id = s.level_id
    left join hierarchy_levels dst
      on dst.template_id = cur.template_id and dst.position = cur.position + p_delta
   where dst.id is null;
  if v_missing > 0 then
    perform api_raise('level_mismatch',
      case when p_delta < 0 then 'there is no level above this one'
           else 'there is no level below this one for part of this subtree' end,
      jsonb_build_object('reason', 'no destination level', 'delta', p_delta));
  end if;

  -- TOP-DOWN, WITH THE TRIGGER ARMED THROUGHOUT (see the file header). The
  -- moved node first, its new parent and new level in ONE statement so the
  -- trigger sees both together; then descendants shallowest-first, so a node is
  -- only ever moved after its parent already sits at its final level.
  update nodes n set parent_id = p_new_parent_id,
         level_id = (select dst.id from hierarchy_levels cur, hierarchy_levels dst
                      where cur.id = n.level_id and dst.template_id = cur.template_id
                        and dst.position = cur.position + p_delta)
   where n.id = p_node_id;

  for r in
    select n.id from nodes n
     where n.id = any(v_ids) and n.id <> p_node_id
     order by nlevel(n.path)
  loop
    update nodes n set level_id = (select dst.id from hierarchy_levels cur, hierarchy_levels dst
                                    where cur.id = n.level_id and dst.template_id = cur.template_id
                                      and dst.position = cur.position + p_delta)
     where n.id = r.id;
  end loop;

  -- A SECOND OPINION, not the only guard — the trigger already refused anything
  -- unsound. Kept because it reads REAL ROWS and cannot drift from what the
  -- writes did, and because it covers the one case the trigger cannot see: a
  -- node left with no parent on a non-zero level. SCOPED TO THE MOVED SUBTREE:
  -- an org-wide check would refuse every re-level for as long as one
  -- pre-existing violation existed anywhere, with no repair path.
  if exists (
    select 1 from nodes n
      join hierarchy_levels nl on nl.id = n.level_id
      left join nodes p on p.id = n.parent_id
      left join hierarchy_levels pl on pl.id = p.level_id
     where n.id = any(v_ids)
       and ((n.parent_id is null and nl.position is distinct from 0)
         or (n.parent_id is not null and nl.position is distinct from pl.position + 1))
  ) then
    perform api_raise('level_mismatch', 'this move would leave nodes stranded between levels',
      jsonb_build_object('reason', 'relevel strands nodes'));
  end if;

  -- THE HARD PART: work scheduled on a node that has just left the schedulable
  -- rung. Runs first, assignments only when the run count is zero — after
  -- P1-4e a direct assignment can exist with no run at all (D72).
  select count(*) into v_stranded
    from runs r2 join nodes n on n.id = r2.node_id
    join hierarchy_levels hl on hl.id = n.level_id
   where n.id = any(v_ids) and not hl.is_schedulable;
  if v_stranded = 0 then
    select count(*) into v_stranded
      from assignments a join nodes n on n.id = a.node_id
      join hierarchy_levels hl on hl.id = n.level_id
     where n.id = any(v_ids) and not hl.is_schedulable;
  end if;
  if v_stranded > 0 then
    perform api_raise('schedulable_level_locked',
      'this move would leave scheduled work on a node that can no longer hold it',
      jsonb_build_object('reason', 'relevel strands scheduled work', 'count', v_stranded));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'name', n.name, 'level_id', n.level_id,
           'parent_id', n.parent_id, 'path', n.path::text) order by n.path), '[]'::jsonb)
    into v_result
    from nodes n where n.id = any(v_ids);
  return v_result;
end;
$function$;


-- ----------------------------------------------------------------------------
-- §8.5. A SITE ADMIN COULD NOT RENAME THEIR OWN SITE. Found by running §8, not
-- by reading it, and it is the first thing one of them would try.
--
-- MEASURED, before any of this was written:
--
--   site admin (admin grant on plant_1) renames Line 1  -> OK
--   site admin renames PLANT 1 ITSELF                   -> "new row violates
--                                                          row-level security
--                                                          policy for nodes"
--   department admin renames their own department       -> same refusal
--
-- WHY, and it is D85's family rather than a permission bug. A grant is stored
-- as a node id but USED as a PATH: `app_grant_paths_for` joins the grant to
-- `nodes` and reads `n.path`. Renaming the grant node moves the whole scope --
-- the new row's path `plant_one` is not `<@` the grant path `plant_1`, which
-- the same statement has not yet published. The scope and the row move
-- together and the policy can only see one of them.
--
-- ⭐ AND THE POLICY THAT REFUSES IT IS NOT THE ONE ANYBODY WOULD LOOK AT.
-- MEASURED by bisection, because reading it produced the wrong answer twice:
-- with `nodes_update` opened to `with check (true)` the rename STILL failed,
-- and it only succeeded once `nodes_select` was opened as well.
--
--   real UPDATE policy, cascade trigger disabled ....... FAILED
--   UPDATE policy `with check (true)` .................. FAILED
--   UPDATE policy `with check (true)` + open SELECT .... OK
--   real UPDATE policy + open SELECT ................... OK
--
-- **AN UPDATE'S NEW ROW IS CHECKED AGAINST THE *SELECT* POLICY AS WELL AS THE
-- UPDATE POLICY'S WITH CHECK.** A row you may edit but could not then see is
-- refused, with `nodes_update`'s error message, naming a policy that is not the
-- one saying no. Both policies therefore need the term, and a fix applied to
-- the obvious one alone looks correct and changes nothing.
--
-- ⛔ THE OBVIOUS FIX IS A HOLE. Adding a plain "or I hold a grant on this very
-- node" term to the WITH CHECK also lets a mid-tree admin RE-PARENT their own
-- grant node -- Line 1 out of Plant 1 and into Plant 2 -- by a direct table
-- update, because the term stops asking where the node ended up. Measured: the
-- level rungs line up for that pair, so nothing else refuses it.
--
-- ✅ `parent_id is null` IS WHAT MAKES IT SAFE, and it is not a heuristic. A
-- parentless row is a SITE, and the term therefore only ever applies to a node
-- that is not being put anywhere. Detaching a node to reach the term is
-- refused independently by `nodes_check_level_adjacency` (a parentless node
-- must sit on a position-0 level) -- MEASURED, and case W23 is the standing
-- version of that measurement, because a guard that holds only because
-- something else refuses first is exactly the shadowing this project keeps
-- getting caught by (gotcha 18).
--
-- 📌 WHAT THIS DELIBERATELY DOES NOT FIX: a mid-tree admin still cannot rename
-- the node their own grant sits on -- a department admin renaming their
-- department. A site admin is unaffected, because their grant is on the site
-- root. Closing it properly means grants stopping being resolved through a
-- mutable path, which is a schema change and its own migration; widening the
-- term here would reopen the re-parent hole above. Written down as a task
-- rather than left as a surprise. Case W24 pins the current behaviour so
-- nobody "fixes" it by accident.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin_on_grant_node(p_node_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM profile_grants pg
     WHERE pg.profile_id = app_current_profile_id()
       AND pg.node_id = p_node_id
       AND pg.role = 'admin'
  );
$$;

comment on function app_is_admin_on_grant_node(uuid) is
  'Does the caller hold an admin grant ON THIS EXACT NODE (0020 §8.5)? Answered from the grant''s node_id, never from a path, so it survives the node being renamed. Only ever combined with `parent_id is null` -- see §8.5 for why that condition is load-bearing.';

revoke execute on function app_is_admin_on_grant_node(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_is_admin_on_grant_node(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_is_admin_on_grant_node(uuid) from anon';
  end if;
end $$;

-- The SELECT policy first, because it is the one actually refusing the rename.
-- For a plain read this term adds nothing -- an admin grant on a root already
-- covers that root by path -- so it is load-bearing for exactly one moment: the
-- statement in which the node's own path is changing underneath its grant. A
-- mutation that deletes it is caught by the rename case and by nothing else,
-- which is worth knowing rather than surprising.
drop policy nodes_select on nodes;
create policy nodes_select on nodes for select
  using (
    org_id = app_current_org()
    and (app_is_admin()
         or exists (select 1 from app_grant_paths(false) gp where nodes.path <@ gp)
         or (parent_id is null and app_is_admin_on_grant_node(id)))
  );

-- USING is untouched: the OLD row still has to be inside the caller's scope,
-- and for the grant node it always is. Only the NEW row needed the extra way
-- of being recognised.
drop policy nodes_update on nodes;
create policy nodes_update on nodes for update
  using (
    org_id = app_current_org()
    and (app_is_admin() or app_is_admin_on_path(path))
  )
  with check (
    org_id = app_current_org()
    and (app_is_admin()
         or app_is_admin_on_path(path)
         or (parent_id is null and app_is_admin_on_grant_node(id)))
  );

-- ⚠️ AND THE ROW ITSELF WAS ONLY HALF THE PROBLEM. Renaming a site rewrites
-- every descendant's path, and that rewrite is done by this AFTER trigger --
-- as the caller, under the same policy, with every new path (`plant_one.…`)
-- outside a grant that still reads `plant_1`. The root row would pass and the
-- cascade would fail.
--
-- SECURITY DEFINER is right here in a way it was NOT right for
-- `nodes_check_level_adjacency` (see §11). This function decides nothing: it
-- maintains a DERIVED column for rows whose triggering update was already
-- authorised, it carries its own tenant scope (`org_id = new.org_id`, D83's
-- fix), and it reads no session state at all -- so there is no `current_user`
-- for the security context to change the meaning of. `set search_path` is
-- added with it, which a SECURITY DEFINER function must always have and this
-- one previously did not need.
--
-- It cannot recurse: it writes `path` only, and both path triggers fire on
-- `update of name, parent_id`.
create or replace function nodes_cascade_path() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.path is distinct from new.path then
    update nodes
       set path = new.path || subpath(path, nlevel(old.path))
     -- `and org_id = new.org_id` is the fix. Without it this rewrites any
     -- OTHER tenant's subtree sitting at the same path (D83).
     where path <@ old.path
       and org_id = new.org_id
       and id <> new.id;
  end if;
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- §9. Who may hand out access.
--
-- The maintainer, correcting me, and the correction is the whole section:
--
--   "Site admins can't create people" was the wrong conclusion from a right
--   worry. There are THREE separate things and only one of them is an
--   escalation: a login (auth -- no invite flow exists for anyone yet), a
--   COMPANY MEMBERSHIP row (`user_profiles`, which carries the company-admin
--   flag), and ACCESS TO A PLACE (`profile_grants`). The rule is "a site admin
--   cannot write the company-admin field", not "a site admin cannot add
--   people".
--
-- So `profile_grants` becomes node-scoped and `user_profiles` does not move.
--
-- ⭐ THE ESCALATION THIS HAS TO REFUSE, stated before the code: a site admin
-- writing themselves a `role = 'admin'` row on the ROOT would own every site
-- in the company, and the entire (role, scope) model would be decorative.
-- `app_is_admin_for(node_id)` refuses it because the root is not inside their
-- grant -- their grant is on the root of THEIR site, and a grant covers a
-- subtree downward, never upward. Case A-series in 47 is that test, written
-- the way D98's was.
--
-- `app_is_admin_for` takes an id and reads `nodes`, which is D85's trap -- but
-- D85 only bites a policy that asks about ITS OWN row's id. `node_id` here
-- names a row in a DIFFERENT table, committed before this statement began, so
-- the read is safe. (Same reasoning as §12; §5 had to avoid it precisely
-- because `hierarchy_templates`' insert policy would have been asking about
-- itself.)
--
-- SELECT gains the same term. A site admin who cannot see who has access to
-- their own site cannot manage it -- and the row they would be reading is one
-- they are allowed to write.
-- ----------------------------------------------------------------------------
drop policy profile_grants_select on profile_grants;
drop policy profile_grants_insert on profile_grants;
drop policy profile_grants_update on profile_grants;
drop policy profile_grants_delete on profile_grants;

create policy profile_grants_select on profile_grants for select
  using (
    profile_id = app_current_profile_id()
    or (org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id)))
  );

create policy profile_grants_insert on profile_grants for insert
  with check (
    org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id))
  );

-- USING reads the OLD row, WITH CHECK the NEW one, and both are named on
-- purpose: without the USING term a site admin could pick up a grant on a node
-- they cannot reach and re-point it at one they can; without the WITH CHECK
-- term they could push one of their own grants out onto somebody else's site.
-- This is 0019's S11 property, one table over.
create policy profile_grants_update on profile_grants for update
  using (org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id)))
  with check (org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id)));

create policy profile_grants_delete on profile_grants for delete
  using (org_id = app_current_org() and (app_is_admin() or app_is_admin_for(node_id)));

-- ⚠️ `user_profiles` IS DELIBERATELY UNTOUCHED, and this comment is the record
-- of that being a decision rather than an omission. It is where
-- `user_profiles.role` -- the company-wide admin flag -- lives, and it is the
-- one field whose writer can hand out reach across every site. Creating and
-- removing company membership stays a company action for the same reason.
--
-- THE COST, NAMED SO IT IS A TASK AND NOT A SURPRISE: `user_profiles_select`
-- is still `own row, or company admin`, so a site admin can WRITE a grant for
-- a person they cannot READ. Everything in this section works -- the foreign
-- key resolves with RLS out of the way -- but a UI cannot offer a person
-- picker yet. That is `add_site_member`, the next RPC after this migration,
-- and it is where the reciprocal read is designed rather than bolted on here.


-- ----------------------------------------------------------------------------
-- §11. THE ONE PLANNED CHANGE THIS MIGRATION DOES NOT MAKE, AND WHY.
--
-- §19.44 ended with an instruction to itself: make `nodes_check_level_adjacency`
-- SECURITY DEFINER, so that a site admin reaching a destination they cannot see
-- stops getting `level_mismatch` for what is really a permission refusal.
--
-- ⛔ THAT INSTRUCTION WAS WRITTEN BEFORE D97 AND IS NOW UNSAFE. MEASURED on a
-- scratch PG16 carrying this exact migration:
--
--   trigger as it ships (SECURITY INVOKER):
--       set local role authenticated; set local app.hierarchy_migration='on';
--       update nodes ...                          -> REFUSED   (D97 holding)
--   same trigger, altered to SECURITY DEFINER:
--       identical statements                      -> ACCEPTED  (D97 BROKEN)
--
-- D97 gated the level-adjacency escape hatch on
-- `pg_has_role(current_user, <owner of public.nodes>, 'USAGE')`. Inside a
-- SECURITY DEFINER function `current_user` IS the owner, so that test becomes
-- true for every caller and the hatch swings open for anyone signed in. The
-- change the maintainer asked for in D97 would have been undone by a line written to
-- fix something else. `session_user` is not a repair either: under PostgREST it
-- is `authenticator`, and in this project's own harness it is the superuser, so
-- the test would disagree with production in the direction that hides the hole.
--
-- ✅ THE DEFECT IS FIXED ANYWAY, WITHOUT TOUCHING THE TRIGGER. The wrong code
-- was only ever produced by a lookup that could not see its subject, and §8 now
-- answers the permission question BEFORE any such lookup runs: `move_node`
-- step 4b, and `app_node_exists_in_org` at every node RPC's existence check.
-- Every route a client actually has is an RPC, and every one of them now says
-- `not_permitted`. What remains is a direct `UPDATE nodes SET parent_id = ...`
-- aimed at an invisible parent, which `nodes_update`'s WITH CHECK refuses in
-- the next breath regardless.
--
-- 📌 THE CONSEQUENCE, RECORDED RATHER THAN QUIETLY DROPPED: 0019's case S18
-- STAYS STRUCTURAL. §19.44 expected this migration to un-shadow the tenant
-- guard on `nodes_insert` so S18 could become behavioural. It does not, because
-- the trigger keeps refusing a cross-tenant destination before the policy is
-- consulted, and asserting the policy TEXT remains the weakest thing that still
-- catches someone deleting it. Do not "upgrade" S18 without re-reading this.
--
-- (decision-record-drift rule 6: a conclusion can outlive its premise. The
-- premise here was "nothing depends on current_user inside this trigger", and
-- D97 falsified it two migrations ago.)
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- §12. What hangs off a node belongs to the node.
--
-- Skill requirements and shift-template attachments are pure per-node
-- configuration: a site admin setting the skills a cell needs, or which shift
-- pattern a line runs, touches nothing outside their site. Straight yes on the
-- frame test.
--
-- `app_is_admin_for(node_id)` is safe in a WITH CHECK here for the same reason
-- as §9: `node_id` names an existing row in `nodes`, a DIFFERENT table, so the
-- function is not asked to see the row currently being inserted. That is the
-- whole of D85's rule.
--
-- SELECT stays org-wide on both, unchanged: `nodes_select` is what decides
-- which nodes are visible, and a requirement row for an invisible node is a
-- pair of ids that resolves to nothing.
-- ----------------------------------------------------------------------------
drop policy node_skill_requirements_insert on node_skill_requirements;
drop policy node_skill_requirements_update on node_skill_requirements;
drop policy node_skill_requirements_delete on node_skill_requirements;

create policy node_skill_requirements_insert on node_skill_requirements for insert
  with check (org_id = app_current_org() and app_is_admin_for(node_id));

create policy node_skill_requirements_update on node_skill_requirements for update
  using (org_id = app_current_org() and app_is_admin_for(node_id))
  with check (org_id = app_current_org() and app_is_admin_for(node_id));

create policy node_skill_requirements_delete on node_skill_requirements for delete
  using (org_id = app_current_org() and app_is_admin_for(node_id));

drop policy node_shift_templates_insert on node_shift_templates;
drop policy node_shift_templates_update on node_shift_templates;
drop policy node_shift_templates_delete on node_shift_templates;

create policy node_shift_templates_insert on node_shift_templates for insert
  with check (org_id = app_current_org() and app_is_admin_for(node_id));

create policy node_shift_templates_update on node_shift_templates for update
  using (org_id = app_current_org() and app_is_admin_for(node_id))
  with check (org_id = app_current_org() and app_is_admin_for(node_id));

create policy node_shift_templates_delete on node_shift_templates for delete
  using (org_id = app_current_org() and app_is_admin_for(node_id));
