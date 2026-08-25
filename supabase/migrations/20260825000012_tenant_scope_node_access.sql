-- ============================================================================
-- 20260825000012_tenant_scope_node_access.sql
--
-- Design-session fix, Aug 25 2026 (design plan §19.15). NOT an agent build.
--
-- A REAL CROSS-TENANT READ AND WRITE LEAK, found within minutes of a second org
-- existing in the seed. Measured, not inferred:
--
--   ORG1 ADMIN      saw runs=9  assignments=13   (org 2's rows included)
--   ORG2 ADMIN      saw runs=9                   (all 8 of org 1's included)
--   ANA (org1 sup)  saw runs=6, one of them org 2's
--   ANA            app_can_read_node(org-2 cell) = TRUE
--                  app_can_edit_node(org-2 cell) = TRUE
--   ANA            UPDATE runs WHERE org_id = <org 2>  ->  1 ROW AFFECTED
--
-- WHAT WAS WRONG. `app_can_read_node` / `app_can_edit_node` are SECURITY
-- DEFINER — so RLS on `nodes` does not apply inside them — and they tested
-- only ltree containment:
--
--     SELECT app_is_admin() OR EXISTS (
--       SELECT 1 FROM nodes n, app_grant_paths(false) gp
--       WHERE n.id = p_node AND n.path <@ gp)
--
-- Two independent holes:
--   1. `app_is_admin()` short-circuits the whole expression and is not
--      org-scoped, so ANY admin passed for ANY node in ANY org.
--   2. The grant branch compared PATHS ONLY. Paths are unique per `(org_id,
--      path)`, so two tenants can and do hold the same path — and a grant on
--      `plant_1.assembly` then matched the other tenant's subtree.
--
-- WHY IT REACHED PRODUCTION CODE UNNOTICED. `nodes_select` carries its own
-- `org_id = app_current_org()` predicate, so nodes never leaked and the
-- hierarchy looked correct. All eight `runs` and `assignments` policies
-- delegate ENTIRELY to these two functions and add no org predicate of their
-- own — so the leak was invisible in exactly the tables that carry the
-- schedule. And until Aug 25 the seed had ONE org, which means no test in the
-- repo could have caught it: with a single tenant, a query that forgets to
-- scope by org returns the same rows as one that remembers.
--
-- THE FIX, and where it deliberately is NOT applied. Both functions now resolve
-- the node WITH its org and require it to match the caller's. That single
-- change covers all nine delegating policies at once, which is why the policies
-- themselves are left alone: `app_can_*_node` is the ONE authoritative
-- implementation of "may this caller touch this node", and duplicating the
-- org test into nine policies would create nine places to maintain and — per
-- [[brief-writing-rules]] rule 9 — a redundant clause that no mutation can
-- catch. `nodes_select`'s existing org predicate is pre-existing and harmless;
-- it is not a pattern to propagate.
--
-- BEHAVIOUR CHANGE worth stating: previously `app_is_admin()` made these
-- functions return TRUE for a node id that does not exist at all. They now
-- return FALSE for an unknown node, which is the honest answer and what
-- case C7 asserts.
--
-- ----------------------------------------------------------------------------
-- A SECOND, INDEPENDENT LEAK — and this one WRITES.
--
-- `nodes_cascade_path()` rewrites every descendant when a node is renamed or
-- re-parented:
--
--     update nodes set path = new.path || subpath(path, nlevel(old.path))
--      where path <@ old.path and id <> new.id;
--
-- `path <@ old.path` has no org filter, and `<@` includes equality — so
-- renaming org 1's `Line 1` matched ORG 2's node at the identical path
-- `plant_1.assembly.line_1` and every org-2 descendant of it.
--
-- SEVERITY, stated accurately. Through the normal app path this is NOT
-- reachable today: `nodes_cascade_path()` is SECURITY INVOKER, so RLS applies
-- to its internal UPDATE, and `nodes_update`'s own `org_id = app_current_org()`
-- predicate blocks the cross-tenant rows. It was measured: an org-1 admin
-- renaming through `rename_node()` leaves org 2 untouched with or without this
-- fix. Unlike the read leak above, this half is LATENT, not active.
--
-- It is exposed on every path where RLS does not apply -- the table owner, a
-- service role, a SECURITY DEFINER function, a migration, a bulk import. That
-- is how it surfaced here at all: `10_constraints_test.sql` renames as the
-- owner and got `ERROR: invalid positions` from `subpath()`, because for org
-- 2's own `line_1` the offset equals the path length and the result is empty.
-- **That error is luck, not protection.** Had org 2 held a DEEPER node under
-- the same path, `subpath()` would have succeeded and org 2's node would have
-- been silently re-pathed under org 1's new name -- cross-tenant corruption
-- with no error and no audit trail. P1-5e's CSV upsert is exactly this shape,
-- which is why this is fixed now rather than when it starts biting.
--
-- `nodes_set_path()` is NOT affected: it resolves the parent by `id`, which is
-- the primary key and therefore globally unambiguous.
-- ============================================================================

create or replace function app_can_read_node(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1
    FROM nodes n
    WHERE n.id = p_node
      AND n.org_id = app_current_org()
      AND (
        app_is_admin()
        OR EXISTS (SELECT 1 FROM app_grant_paths(false) gp WHERE n.path <@ gp)
      )
  );
$$;

comment on function app_can_read_node(uuid) is
  'May the caller READ this node? Tenant-scoped: the node must belong to app_current_org(). Do not reduce this to a path test -- paths are unique per (org_id, path), so two tenants can hold the same path. See migration 0012.';

create or replace function app_can_edit_node(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1
    FROM nodes n
    WHERE n.id = p_node
      AND n.org_id = app_current_org()
      AND (
        app_is_admin()
        OR (
          app_can_write()
          AND EXISTS (SELECT 1 FROM app_grant_paths(true) gp WHERE n.path <@ gp)
        )
      )
  );
$$;

comment on function app_can_edit_node(uuid) is
  'May the caller EDIT this node? Tenant-scoped, same rule as app_can_read_node plus app_can_write(). See migration 0012.';

-- ----------------------------------------------------------------------------
-- nodes_cascade_path — same body as migration 0001 plus the tenant scope.
-- ----------------------------------------------------------------------------
create or replace function nodes_cascade_path() returns trigger
language plpgsql as $$
begin
  if old.path is distinct from new.path then
    update nodes
       set path = new.path || subpath(path, nlevel(old.path))
     -- `and org_id = new.org_id` is the fix. Without it this rewrites any
     -- OTHER tenant's subtree sitting at the same path (see the header).
     where path <@ old.path
       and org_id = new.org_id
       and id <> new.id;
  end if;
  return new;
end;
$$;

comment on function nodes_cascade_path() is
  'Rewrites descendant paths after a rename/re-parent. The org_id predicate is load-bearing: paths are unique per (org_id, path), so without it this reaches into another tenant''s identical subtree. See migration 0012.';
