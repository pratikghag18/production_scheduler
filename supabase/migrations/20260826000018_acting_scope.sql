-- ============================================================================
-- 0018 — D98: close the cross-company escalation. Nothing else.
--
-- MEASURED BEFORE THIS MIGRATION, on a scratch database, as a real
-- `authenticated` caller. A user given a VIEWER profile in Northwind and an
-- ADMIN profile in Contoso reported:
--
--     app_says_admin | acting_in               | actual_role_there
--     ---------------+-------------------------+-------------------
--     t              | Northwind Manufacturing | viewer
--
-- and `create_node(...)` then SUCCEEDED, writing a root node into the org
-- where that person is a viewer.
--
-- WHY. Nearly every write policy in this schema is
-- `app_is_admin() and org_id = app_current_org()`. The two terms ask different
-- questions of different rows:
--
--   app_is_admin()   "is this user an admin ANYWHERE"  -- no org predicate
--   app_current_org() "which org am I in"              -- LIMIT 1, no ORDER BY
--
-- so they can be satisfied by two DIFFERENT profiles. `app_current_profile_id`
-- has the same `LIMIT 1` with no ordering, and nothing guarantees it and
-- `app_current_org()` even pick the same row as each other within one request.
--
-- NOT EXPLOITABLE TODAY: it needs a person with two profiles, and nothing in
-- the product creates one -- the seed never reuses a user_id across orgs and no
-- test constructs it. That is exactly why it survived. It is the same shape as
-- D83, which was invisible for weeks because the seed had one org.
--
-- IT MATTERS NOW because the role model Pratik asked for -- system admin, site
-- admin, supervisor, and one person holding more than one -- makes "a person
-- with more than one profile" the NORMAL case. This closes first, alone, so it
-- is testable on its own and lands before anything switches multi-role on.
--
-- SCOPE: four function bodies. No table changes, no policy changes, no RPC
-- signature changes -- so `database.types.ts` is untouched.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ONE acting profile, chosen deterministically.
--
-- `ORDER BY org_id, id` is not a preference, it is the fix for half the bug:
-- `LIMIT 1` with no ordering returns an arbitrary row tracking physical heap
-- order, which is D87's exact shape in the function every tenant check in the
-- product depends on. Which org a multi-profile user acts in is still a
-- default rather than a choice -- letting them CHOOSE is the next migration --
-- but it is now a stable, reproducible default instead of a coin flip.
-- ----------------------------------------------------------------------------
create or replace function app_current_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT id FROM user_profiles
   WHERE user_id = (SELECT auth.uid())
   ORDER BY org_id, id
   LIMIT 1;
$$;

-- ----------------------------------------------------------------------------
-- DERIVED from that one profile, never resolved independently.
--
-- This is the other half. Two functions that each ran their own `LIMIT 1`
-- could disagree about who you are within a single statement -- a policy could
-- reason about the org from one profile and the grants from another. Deriving
-- makes that impossible by construction rather than by both happening to sort
-- the same way.
-- ----------------------------------------------------------------------------
create or replace function app_current_org() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT org_id FROM user_profiles WHERE id = app_current_profile_id();
$$;

-- ----------------------------------------------------------------------------
-- "Are you an admin HERE", not "are you an admin anywhere".
--
-- ⚠️ THE TRAP IN THIS ONE LINE (D85, migration 0013). `app_is_admin()` is the
-- term in `nodes_select` that can answer WITHOUT reading `nodes`, which is what
-- lets `INSERT ... RETURNING` see its own row -- when that stopped being true,
-- `create_node` died for every caller including admins. This version still
-- never reads `nodes`; it reads `user_profiles`. The property that matters is
-- preserved, and case N1 in 70_hierarchy_test.sql plus M-cases in
-- 75_node_mobility_test.sql are the committed guards. Any future scoping of
-- admin-ness that introduces a `nodes` lookup here re-breaks D85.
-- ----------------------------------------------------------------------------
create or replace function app_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
     WHERE id = app_current_profile_id() AND role = 'admin'
  );
$$;

-- ----------------------------------------------------------------------------
-- Same correction, same reason. `app_can_write()` has exactly one caller
-- (`app_can_edit_node`), and "can write anywhere" was the same class of bug.
-- ----------------------------------------------------------------------------
create or replace function app_can_write() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
     WHERE id = app_current_profile_id() AND role IN ('admin','supervisor')
  );
$$;

-- GRANTS: all four are `create or replace`, which PRESERVES existing grants
-- (measured, D93). No grant block is needed here and adding one would be the
-- opposite error -- re-granting something 0008 deliberately scoped.
