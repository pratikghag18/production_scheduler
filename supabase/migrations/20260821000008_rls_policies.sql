-- ============================================================================
-- Migration 0008: RLS policies
-- Implements: design-plan.md §9 (multi-tenancy, roles), §14.3 (subtree
--   grants), §17 D8 (org-wide read on operators/products/skills; subtree
--   grant restricts node visibility and all writes), D9 (audit_log
--   admin-read-only, write only via the SECURITY DEFINER trigger).
--
-- ASSUMPTION (brief silent): every "admin only" write cell in the brief's
-- §8 policy table is read as "admin AND same org" (not "any admin,
-- anywhere") — matching the SELECT column's org-match half of each row, so
-- an admin of one org can never write another org's rows. Applied uniformly.
--
-- ASSUMPTION (brief ambiguous): app_can_edit_node() is described as
-- "[app_can_read_node] same with app_can_write() and app_grant_paths(true)".
-- A literal swap of app_is_admin() -> app_can_write() in that OR would make
-- ANY supervisor able to edit ANY node (app_can_write() is a bare role
-- check, true for every supervisor regardless of node) — which would erase
-- subtree grants entirely and fail acceptance items 21/22/24 (Ana can edit
-- Cell 1 but not Cell 6). Implemented instead as: app_is_admin() bypasses
-- the subtree check (parallel to app_can_read_node, and consistent with
-- admins holding a root can_edit grant in the seed), otherwise
-- app_can_write() gates entry to the app_grant_paths(true) subtree check.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions
-- ----------------------------------------------------------------------------

create function app_current_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT id FROM user_profiles WHERE user_id = (SELECT auth.uid()) LIMIT 1;
$$;

create function app_current_org() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT org_id FROM user_profiles WHERE user_id = (SELECT auth.uid()) LIMIT 1;
$$;

create function app_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
  );
$$;

create function app_can_write() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE user_id = (SELECT auth.uid()) AND role IN ('admin','supervisor')
  );
$$;

create function app_grant_paths(require_edit boolean) returns setof ltree
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT n.path
  FROM profile_grants pg
  JOIN nodes n ON n.id = pg.node_id
  WHERE pg.profile_id = app_current_profile_id()
    AND (NOT require_edit OR pg.can_edit);
$$;

create function app_can_read_node(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM nodes n, app_grant_paths(false) gp
    WHERE n.id = p_node AND n.path <@ gp
  );
$$;

create function app_can_edit_node(p_node uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT app_is_admin() OR (
    app_can_write() AND EXISTS (
      SELECT 1 FROM nodes n, app_grant_paths(true) gp
      WHERE n.id = p_node AND n.path <@ gp
    )
  );
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS on every table created in 0001-0007
-- ----------------------------------------------------------------------------
alter table orgs enable row level security;
alter table hierarchy_levels enable row level security;
alter table nodes enable row level security;
alter table operators enable row level security;
alter table products enable row level security;
alter table skills enable row level security;
alter table operator_skills enable row level security;
alter table node_skill_requirements enable row level security;
alter table runs enable row level security;
alter table assignments enable row level security;
alter table shift_templates enable row level security;
alter table shifts enable row level security;
alter table shift_breaks enable row level security;
alter table node_shift_templates enable row level security;
alter table user_profiles enable row level security;
alter table profile_grants enable row level security;
alter table audit_log enable row level security;
-- Never FORCE RLS here: the audit trigger (and the table owner generally)
-- must bypass RLS to write.

-- ----------------------------------------------------------------------------
-- orgs — SELECT: id = own org. Write: admin, own org only.
-- ----------------------------------------------------------------------------
create policy orgs_select on orgs for select
  using (id = app_current_org());
create policy orgs_insert on orgs for insert
  with check (app_is_admin() and id = app_current_org());
create policy orgs_update on orgs for update
  using (app_is_admin() and id = app_current_org())
  with check (app_is_admin() and id = app_current_org());
create policy orgs_delete on orgs for delete
  using (app_is_admin() and id = app_current_org());

-- ----------------------------------------------------------------------------
-- hierarchy_levels — SELECT: org match. Write: admin, own org.
-- ----------------------------------------------------------------------------
create policy hierarchy_levels_select on hierarchy_levels for select
  using (org_id = app_current_org());
create policy hierarchy_levels_insert on hierarchy_levels for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy hierarchy_levels_update on hierarchy_levels for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy hierarchy_levels_delete on hierarchy_levels for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- nodes — SELECT: org match AND app_can_read_node(id). Write: admin, own org.
-- ----------------------------------------------------------------------------
create policy nodes_select on nodes for select
  using (org_id = app_current_org() and app_can_read_node(id));
create policy nodes_insert on nodes for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy nodes_update on nodes for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy nodes_delete on nodes for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- operators, products, skills, operator_skills, node_skill_requirements
-- D8: readable org-wide; writes are admin-only. The subtree grant restricts
-- which nodes a user may see/edit (nodes/runs/assignments policies), not
-- the roster/catalog itself.
-- ----------------------------------------------------------------------------
create policy operators_select on operators for select
  using (org_id = app_current_org());
create policy operators_insert on operators for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy operators_update on operators for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy operators_delete on operators for delete
  using (app_is_admin() and org_id = app_current_org());

create policy products_select on products for select
  using (org_id = app_current_org());
create policy products_insert on products for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy products_update on products for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy products_delete on products for delete
  using (app_is_admin() and org_id = app_current_org());

create policy skills_select on skills for select
  using (org_id = app_current_org());
create policy skills_insert on skills for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy skills_update on skills for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy skills_delete on skills for delete
  using (app_is_admin() and org_id = app_current_org());

create policy operator_skills_select on operator_skills for select
  using (org_id = app_current_org());
create policy operator_skills_insert on operator_skills for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy operator_skills_update on operator_skills for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy operator_skills_delete on operator_skills for delete
  using (app_is_admin() and org_id = app_current_org());

create policy node_skill_requirements_select on node_skill_requirements for select
  using (org_id = app_current_org());
create policy node_skill_requirements_insert on node_skill_requirements for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy node_skill_requirements_update on node_skill_requirements for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy node_skill_requirements_delete on node_skill_requirements for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- runs, assignments — SELECT: app_can_read_node(node_id). Write:
-- app_can_edit_node(node_id) — USING on the old row, WITH CHECK on the new
-- one, so a cross-cell move (§15.2) requires edit rights on BOTH cells.
-- ----------------------------------------------------------------------------
create policy runs_select on runs for select
  using (app_can_read_node(node_id));
create policy runs_insert on runs for insert
  with check (app_can_edit_node(node_id));
create policy runs_update on runs for update
  using (app_can_edit_node(node_id))
  with check (app_can_edit_node(node_id));
create policy runs_delete on runs for delete
  using (app_can_edit_node(node_id));

create policy assignments_select on assignments for select
  using (app_can_read_node(node_id));
create policy assignments_insert on assignments for insert
  with check (app_can_edit_node(node_id));
create policy assignments_update on assignments for update
  using (app_can_edit_node(node_id))
  with check (app_can_edit_node(node_id));
create policy assignments_delete on assignments for delete
  using (app_can_edit_node(node_id));

-- ----------------------------------------------------------------------------
-- shift_templates, shifts, shift_breaks, node_shift_templates
-- SELECT: org match. Write: admin, own org.
-- ----------------------------------------------------------------------------
create policy shift_templates_select on shift_templates for select
  using (org_id = app_current_org());
create policy shift_templates_insert on shift_templates for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy shift_templates_update on shift_templates for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy shift_templates_delete on shift_templates for delete
  using (app_is_admin() and org_id = app_current_org());

create policy shifts_select on shifts for select
  using (org_id = app_current_org());
create policy shifts_insert on shifts for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy shifts_update on shifts for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy shifts_delete on shifts for delete
  using (app_is_admin() and org_id = app_current_org());

create policy shift_breaks_select on shift_breaks for select
  using (org_id = app_current_org());
create policy shift_breaks_insert on shift_breaks for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy shift_breaks_update on shift_breaks for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy shift_breaks_delete on shift_breaks for delete
  using (app_is_admin() and org_id = app_current_org());

create policy node_shift_templates_select on node_shift_templates for select
  using (org_id = app_current_org());
create policy node_shift_templates_insert on node_shift_templates for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy node_shift_templates_update on node_shift_templates for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy node_shift_templates_delete on node_shift_templates for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- user_profiles — SELECT: own row, or admin (own org). Write: admin, own org.
-- ----------------------------------------------------------------------------
create policy user_profiles_select on user_profiles for select
  using (
    user_id = (SELECT auth.uid())
    or (app_is_admin() and org_id = app_current_org())
  );
create policy user_profiles_insert on user_profiles for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy user_profiles_update on user_profiles for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy user_profiles_delete on user_profiles for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- profile_grants — SELECT: own profile's grants, or admin (own org). Write:
-- admin, own org.
-- ----------------------------------------------------------------------------
create policy profile_grants_select on profile_grants for select
  using (
    profile_id = app_current_profile_id()
    or (app_is_admin() and org_id = app_current_org())
  );
create policy profile_grants_insert on profile_grants for insert
  with check (app_is_admin() and org_id = app_current_org());
create policy profile_grants_update on profile_grants for update
  using (app_is_admin() and org_id = app_current_org())
  with check (app_is_admin() and org_id = app_current_org());
create policy profile_grants_delete on profile_grants for delete
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- audit_log — D9: admin-read-only. No write policy at all: rows arrive only
-- through the SECURITY DEFINER write_audit_log() trigger, which runs as the
-- table owner and bypasses RLS (never FORCE this table).
-- ----------------------------------------------------------------------------
create policy audit_log_select on audit_log for select
  using (app_is_admin() and org_id = app_current_org());

-- ----------------------------------------------------------------------------
-- Grants — guarded so this file also runs on a scratch Postgres that may
-- lack the Supabase roles.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
END $$;
