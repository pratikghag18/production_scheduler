-- ============================================================================
-- 0013 — restore `INSERT ... RETURNING` on `nodes`, broken by 0012.
--
-- Design plan §19.17 / D85. `create_node` has been dead since migration 0012
-- landed, for every caller including org admins:
--
--     ERROR:  new row violates row-level security policy for table "nodes"
--     CONTEXT: insert into nodes (...) values (...) returning *
--
-- WHY. 0012 correctly made `app_can_read_node` org-scoped, and in doing so
-- turned it from an expression that could short-circuit on `app_is_admin()`
-- into one that ALWAYS reads the `nodes` table:
--
--     SELECT EXISTS (SELECT 1 FROM nodes n WHERE n.id = p_node AND n.org_id = ...)
--
-- `nodes_select` calls it as `app_can_read_node(id)` — the id of the row the
-- policy is being applied to. For an `INSERT ... RETURNING`, PostgreSQL
-- applies the SELECT policy to the NEW row, and the function is a separate
-- query running under the command's own snapshot, which by definition does
-- not contain the row currently being inserted. The lookup finds nothing, the
-- policy evaluates FALSE, and the INSERT is rejected.
--
-- Before 0012 the same policy passed for admins because `app_is_admin()`
-- short-circuited the OR before any table access happened. The org-scoping
-- fix removed the short-circuit; nothing about the tenancy reasoning in 0012
-- was wrong, and none of it is reverted here.
--
-- WHY NOTHING CAUGHT IT. Two reasons, both worth writing down:
--
--   1. `supabase/tests/70_hierarchy_test.sql` reports failures with
--      `RAISE NOTICE 'FAIL ...'`. A NOTICE is not an error, so psql exits 0
--      and `scripts/verify-db.sh` recorded the whole file as PASS while eight
--      of its cases (N1, N11c, N13, D1, D2, U1, U4, W4) printed FAIL. The
--      harness was measuring "did psql exit non-zero", not "did the cases
--      pass". Fixed in the same change as this migration.
--   2. Every OTHER policy that delegates to `app_can_read_node` passes a
--      FOREIGN key — `runs.node_id`, `assignments.node_id` — which names an
--      already-committed row. Only `nodes_select` asks the function about the
--      row being written, so only `nodes` is affected. That is why the whole
--      `runs`/`assignments` API surface kept working.
--
-- THE FIX. Put the admin short-circuit back where it can be evaluated without
-- touching the table — in the policy, in front of the function call.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- `app_is_admin() or` looks redundant: `app_can_read_node` ORs the same test
-- internally. IT IS NOT. It is the term that lets this policy return TRUE for
-- an org admin without a self-lookup, which is the entire fix — deleting it as
-- a duplicate re-breaks `create_node`, silently, in exactly the way that took
-- an evening to find. `supabase/tests/70_hierarchy_test.sql` case N1 is the
-- committed guard; do not remove it either.
--
-- Tenancy is unchanged and is NOT weakened: `org_id = app_current_org()` is
-- still the first conjunct and still gates the admin branch, which is
-- precisely the hole D83 closed. An admin of org 1 evaluating this policy
-- against an org-2 row fails on the first term and never reaches the second.
-- ----------------------------------------------------------------------------
drop policy nodes_select on nodes;

create policy nodes_select on nodes for select
  using (
    org_id = app_current_org()
    and (app_is_admin() or app_can_read_node(id))
  );
