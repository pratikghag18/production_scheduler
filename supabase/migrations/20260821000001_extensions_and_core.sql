-- ============================================================================
-- Migration 0001: extensions and core
-- Implements: design-plan.md §2 (dynamic hierarchy — node-tree rules kept in
--   the application, not the schema), §3 (orgs, hierarchy_levels, nodes),
--   §17 D3 (composite tenant FKs), D6 (trigger-maintained node path).
--
-- This migration (and every migration after it) implements the FINAL shape
-- of the schema only. §3/§14/§15/§16 of the design plan are a narrative
-- record showing the schema evolving over several review sessions — they are
-- not replayed here. There is no dropped constraint, no later add-column:
-- this is a fresh database.
-- ============================================================================

create extension if not exists ltree;
create extension if not exists btree_gist; -- required by exclusion constraints in later migrations
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Shared trigger function: stamps updated_at on any row update.
-- Used by every table in this and later migrations that carries updated_at.
-- ----------------------------------------------------------------------------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- slugify(text): produces an ltree-safe label.
--   - lowercases
--   - collapses every run of characters outside [a-z0-9] into a single '_'
--   - trims leading/trailing '_'
--   - prefixes 'n_' if the result starts with a digit, or is empty
-- ltree labels accept only [A-Za-z0-9_], so this must be airtight; exercised
-- in tests/10_constraints_test.sql against "Cell 1", "CNC Line", "3 × 8h",
-- "  ", and "2nd Shift".
-- ----------------------------------------------------------------------------
create function slugify(input text) returns text
language sql immutable as $$
  select case
    when base = '' then 'n_'
    when base ~ '^[0-9]' then 'n_' || base
    else base
  end
  from (
    select trim(both '_' from regexp_replace(lower(input), '[^a-z0-9]+', '_', 'g')) as base
  ) s;
$$;

-- ----------------------------------------------------------------------------
-- orgs
-- ----------------------------------------------------------------------------
create table orgs (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  settings jsonb not null default
    '{"capacity_cap": 1.0, "eligibility_policy": "warn", "week_start": 1, "default_snap_minutes": 30}'::jsonb,
  check ((settings->>'capacity_cap')::numeric > 0),
  check (settings->>'eligibility_policy' in ('warn','block'))
);

-- ----------------------------------------------------------------------------
-- hierarchy_levels — the org's hierarchy definition, one row per level.
-- ----------------------------------------------------------------------------
create table hierarchy_levels (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id),
  position       int  not null,
  name           text not null,
  is_schedulable boolean not null default false,
  unique (org_id, position)
);

-- At most one schedulable level per org.
create unique index hierarchy_levels_one_schedulable
  on hierarchy_levels (org_id) where is_schedulable;

-- ----------------------------------------------------------------------------
-- nodes — one table for every unit at every level, self-referencing tree.
-- ----------------------------------------------------------------------------
create table nodes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id),
  level_id   uuid not null references hierarchy_levels(id),
  parent_id  uuid,
  name       text not null,
  path       ltree not null,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, parent_id, name),
  unique (org_id, id), -- D3: lets child tables use a composite tenant FK
  -- D3: a node's parent must belong to the same org — composite self-FK.
  foreign key (org_id, parent_id) references nodes (org_id, id)
);

-- NOTE (design-plan §2, deliberate): the schema does NOT enforce "a node's
-- parent must be exactly one level above it in the org's hierarchy
-- definition." That rule lives in the application so hierarchy edits stay
-- cheap. This is not an oversight — do not add it here later.

create trigger nodes_set_updated_at
  before update on nodes
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------------------
-- D6: path is mechanically derived from parent_id + name, never supplied by
-- the caller. Inserts only need to pass name and parent_id.
-- ----------------------------------------------------------------------------
create function nodes_set_path() returns trigger
language plpgsql as $$
begin
  new.path := case
    when new.parent_id is null then slugify(new.name)::ltree
    else (select path from nodes where id = new.parent_id) || slugify(new.name)::ltree
  end;
  return new;
end;
$$;

create trigger nodes_before_path
  before insert or update of name, parent_id on nodes
  for each row execute function nodes_set_path();

-- Renaming/re-parenting a node rewrites the path of every descendant.
-- pg_trigger_depth() = 1 plus the `id <> new.id` filter on the UPDATE below
-- guards against runaway recursion (the recursive UPDATE fires this same
-- AFTER trigger on each descendant it touches, but only where OLD.path <>
-- NEW.path, and it never touches the row that triggered it).
create function nodes_cascade_path() returns trigger
language plpgsql as $$
begin
  if old.path is distinct from new.path then
    update nodes
       set path = new.path || subpath(path, nlevel(old.path))
     where path <@ old.path
       and id <> new.id;
  end if;
  return new;
end;
$$;

-- NOTE / DEVIATION FROM THE BRIEF'S LITERAL TEXT: the brief specifies this as
-- `AFTER UPDATE OF path`. Postgres fires an `UPDATE OF <cols>` trigger based
-- on which columns are named in the SQL command's own SET clause, not on
-- whichever columns a BEFORE trigger ends up changing. Since D6's whole
-- point is that callers only ever set `name`/`parent_id` and NEVER `path`
-- directly, an `AFTER UPDATE OF path` trigger can structurally never fire
-- from real application code -- verified empirically: renaming a node via
-- `UPDATE nodes SET name = ...` left every descendant's path untouched
-- (acceptance case 2 failed on exactly this). Firing on the same column list
-- as the BEFORE trigger (`name, parent_id`) is the minimal correction that
-- makes the explicitly-required cascade behavior actually run; the WHEN
-- guard and the cascade function body are unchanged from the brief.
create trigger nodes_after_path
  after update of name, parent_id on nodes
  for each row
  when (old.path is distinct from new.path)
  execute function nodes_cascade_path();

create index nodes_path_idx on nodes using gist (path);
create index nodes_org_parent_idx on nodes (org_id, parent_id);
