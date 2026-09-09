-- ============================================================================
-- 0074 -- the same read rule, asked once instead of once per row (F-124)
--
-- ⛔ THE MEASUREMENT THIS COMES FROM. A plant-sized board (384 work cells, 5,760
-- runs, 5,760 assignments, one week) took 2.1-2.7 seconds inside `board_window`.
-- Timed piece by piece, the two big jsonb fields were ~960ms and ~990ms of it;
-- the SAME aggregations over the SAME rows with RLS bypassed were 6ms and 4ms.
-- The whole difference was `runs_select` / `assignments_select`, which are
-- `app_can_read_node(node_id)` -- a SECURITY DEFINER helper Postgres evaluates
-- ONCE PER ROW. 11,520 calls at ~170 microseconds, to re-derive an answer that
-- has only 384 distinct values. Re-run it with `scripts/load-sanity.sh`.
--
-- ⭐ THE RULE IS UNCHANGED. `app_can_read_node(n)` says: the node is in my org,
-- AND (I am an admin OR the node sits under one of my grants).
-- `app_readable_node_ids()` below is that predicate, verbatim, over the whole
-- table instead of one row -- so the planner builds the set ONCE and probes it
-- per row. Nothing about who may see what moves; only how often the question is
-- asked.
--
-- ⚠️ IT IS STILL SECURITY DEFINER, FOR THE SAME REASON THE OLD ONE WAS. A caller
-- cannot read the nodes ABOVE their own grant (`nodes_select` is descendants
-- only), and deciding "is this node under a grant of mine" has to reason about
-- exactly those. An INVOKER version would answer NULL for nodes that have an
-- answer -- the shape CLAUDE.md section 4 warns about and DEF-0016/DEF-0017
-- both were.
--
-- ⭐ MEASURED BEFORE AND AFTER ON THE SAME FIXTURE, AND THE SECURITY HALF WAS
-- MEASURED FIRST. Visible row counts for three different people, before against
-- after: the company admin 5,768 runs / 5,772 assignments both times; the
-- Assembly supervisor 5 / 9 both times; the Machining supervisor 3 / 3 both
-- times. Identical. Only then the speed: `board_window` on the plant fell from
-- ~2,630ms to ~700ms, the runs field from 960ms to 78ms and assignments from
-- 990ms to 114ms.
--
-- ⚠️ WHAT THIS DOES NOT TOUCH, DELIBERATELY. Only the two SELECT policies whose
-- cost was measured. Every INSERT/UPDATE/DELETE policy still calls
-- `app_can_edit_node` per row: a write touches one row at a time, so the per-row
-- shape costs nothing there, and rewriting a guard nobody measured would be
-- change without evidence. `app_can_read_node` itself is left in place --- other
-- policies and functions still call it, and it remains the single definition of
-- the rule this set-based form mirrors.
--
-- ⚠️ AND THE COST IT ADDS. The set is every node id the caller may read: for a
-- company admin, the whole org. That is hundreds today and would be thousands
-- for a large customer -- cheap to hash, but it IS a materialisation where there
-- was none, and it is the thing to look at first if a much larger org is ever
-- slower than this measurement predicts.
-- ============================================================================

-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). The predicate below is
-- `app_can_read_node`'s own body with the single-row lookup removed:
-- `grep -in "function \(public\.\)\?app_can_read_node(" supabase/migrations/*.sql`
-- lands on 20260825000012_tenant_scope_node_access.sql:90 as the last hit (NOT
-- 0010, which is where an earlier draft of this comment said it was -- checked
-- against the grep rather than remembered), and its body is
-- `EXISTS (SELECT 1 FROM nodes n WHERE n.id = p_node AND n.org_id =
-- app_current_org() AND (app_is_admin() OR EXISTS (SELECT 1 FROM
-- app_grant_paths(false) gp WHERE n.path <@ gp)))`.
CREATE OR REPLACE FUNCTION public.app_readable_node_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT n.id
  FROM nodes n
  WHERE n.org_id = app_current_org()
    AND (
      app_is_admin()
      OR EXISTS (SELECT 1 FROM app_grant_paths(false) gp WHERE n.path <@ gp)
    );
$function$;

COMMENT ON FUNCTION public.app_readable_node_ids() IS
  'F-124. Every node id the caller may READ, as a set --- app_can_read_node''s own predicate asked once for the whole table instead of once per row. SECURITY DEFINER for the same reason app_can_read_node is one: a caller cannot read the nodes above their own grant, and deciding "is this under a grant of mine" has to reason about them. Used by runs_select and assignments_select, where the per-row call cost ~170 microseconds x 11,520 rows on a plant-sized board.';

REVOKE EXECUTE ON FUNCTION public.app_readable_node_ids() FROM public;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.app_readable_node_ids() TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.app_readable_node_ids() FROM anon';
  END IF;
END $$;

-- The two policies whose cost was measured. 0008's originals are
-- `using (app_can_read_node(node_id))`; these say the same thing set-wise.
DROP POLICY IF EXISTS runs_select ON runs;
CREATE POLICY runs_select ON runs FOR SELECT
  USING (node_id IN (SELECT app_readable_node_ids()));

DROP POLICY IF EXISTS assignments_select ON assignments;
CREATE POLICY assignments_select ON assignments FOR SELECT
  USING (node_id IN (SELECT app_readable_node_ids()));
