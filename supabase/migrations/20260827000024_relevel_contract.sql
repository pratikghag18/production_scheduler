-- ============================================================================
-- 0024 — app_relevel_subtree keeps the error contract it was already supposed
--        to keep. TWO DEFECTS, ONE FUNCTION, BOTH MEASURED RATHER THAN READ.
--
-- P1-5k's SQL half shipped in 0017 and has been applied and tested since. Its
-- CLIENT half is what is being built now, and building it meant asking the one
-- question the SQL suite never asks: WHAT DOES THE USER SEE WHEN THIS IS
-- REFUSED? Both answers were wrong, and neither was visible from reading:
--
--   1. A promote or demote whose destination parent already has a child of that
--      name raised a RAW `23505` — `nodes_org_id_parent_id_name_key`, with an
--      EMPTY DETAIL. Every other node write in the schema pre-checks the
--      prospective path and raises `path_collision` (create_node, rename_node,
--      move_node, all in 0010). §19.33 §4 measured exactly this on the scratch
--      database while P1-5k was being designed and wrote down "catch and
--      re-raise `path_collision`" — and 0017 never did it. A recorded decision
--      that never reached the code (see [[decision-record-drift]]).
--
--   2. The stranded-work refusal — the most important thing this function says —
--      sent `{reason, count}` where every other `schedulable_level_locked`
--      raiser sends `{blocking_rows, level_id}`. `parseSchedulerError` accepts
--      only the latter, so the refusal decoded as `Unknown` and would have
--      rendered as "Something went wrong. Please try again."
--
-- ⭐ NEITHER IS A NEW RULE. Both are the twelve-code contract (`docs/api.md`
-- §1) being kept where it was already being broken, so there is no thirteenth
-- code and no client-visible behaviour that did not already exist on paper.
--
-- ⚠️ EXTRACTED FROM THE LIVE DATABASE with `pg_get_functiondef`, NOT from
-- 0017 — `grep -n "function app_relevel_subtree"` returns 0017 AND 0020, and
-- 0020's re-emission is the live one (it added the node-scoped admin check).
-- Extracting 0017's body would silently revert that. Rule 12, and the second
-- time this exact trap has been stepped over rather than into.
--
-- `create or replace` PRESERVES grants, but the grant block is restated below
-- anyway: D93 is the trap of creating functions and granting only a table.
--
-- NO `UPGRADE_CHECKS` ROW, deliberately. This migration transforms no data —
-- it changes only what an already-failing call SAYS. There is no before/after
-- row state for an upgrade test to compare, and 0021's header records the same
-- reasoning for the same reason.
-- ============================================================================


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
  v_prefix   ltree;
  v_new_path ltree;
  v_existing uuid;
  v_level_id uuid;
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

  -- ⭐ NEW IN 0024 — THE COLLISION THIS FUNCTION NEVER CHECKED.
  -- create_node, rename_node and move_node each pre-check the prospective path
  -- (0010's three `path_collision` raises). app_relevel_subtree did not, so a
  -- promote or demote into a parent that already has a child of that name
  -- raised a RAW 23505 with an EMPTY DETAIL — outside the twelve-code contract
  -- and undecodable by `parseSchedulerError`, which reads the machine code out
  -- of DETAIL. MEASURED on a scratch PG16 rather than read: both promote_node
  -- and demote_node reproduced it, `nodes_org_id_parent_id_name_key`.
  --
  -- The prospective path of every node in the subtree is the new parent's path
  -- followed by that node's tail BELOW the moved node's own parent — that is,
  -- from label `nlevel(v_node.path) - 1` onwards, which for the moved node
  -- itself is its own single label. A NULL new parent (a promote to root) has
  -- no prefix at all, and `NULL || tail` is NULL in ltree, so the CASE is not
  -- decoration.
  --
  -- ⚠️ NODES INSIDE THE MOVED SUBTREE ARE EXCLUDED FROM THE CANDIDATES. They
  -- are moving too, so their CURRENT paths are about to be vacated; counting
  -- them would refuse every promote of a node that has children.
  select case when p_new_parent_id is null then null
              else (select p.path from nodes p
                     where p.id = p_new_parent_id and p.org_id = v_org_id) end
    into v_prefix;

  select x.path, x.id into v_new_path, v_existing
    from nodes n
    cross join lateral (
      select case when v_prefix is null
                  then subpath(n.path, nlevel(v_node.path) - 1)
                  else v_prefix || subpath(n.path, nlevel(v_node.path) - 1) end as np
    ) t
    join nodes x on x.org_id = v_org_id and x.path = t.np and not (x.id = any(v_ids))
   where n.id = any(v_ids)
   order by x.path
   limit 1;
  if v_existing is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_new_path::text, 'existing_node_id', v_existing));
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
    -- ⭐ NEW IN 0024 — THE PAYLOAD SHAPE, WHICH WAS THE OTHER HALF OF THE SAME
    -- DEFECT. Every other `schedulable_level_locked` raiser in the schema sends
    -- `{blocking_rows, level_id}`; this one sent `{reason, count}`, and
    -- `parseSchedulerError` accepts ONLY the first shape — so the single most
    -- important refusal of promote/demote decoded as `Unknown` and rendered as
    -- "Something went wrong. Please try again."
    --
    -- `level_id` is the level the blocking rows are sitting on AFTER the move,
    -- which is by construction NOT schedulable and by construction exists (we
    -- just counted rows there). Ordered by path so the choice is deterministic
    -- when more than one level qualifies — rule 3e, never assume row order.
    -- `reason` is kept as informational context; nothing parses it.
    select hl.id into v_level_id
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
     where n.id = any(v_ids) and not hl.is_schedulable
       and (exists (select 1 from runs r3 where r3.node_id = n.id)
         or exists (select 1 from assignments a2 where a2.node_id = n.id))
     order by n.path
     limit 1;
    perform api_raise('schedulable_level_locked',
      'this move would leave scheduled work on a node that can no longer hold it',
      jsonb_build_object('blocking_rows', v_stranded, 'level_id', v_level_id,
                         'reason', 'relevel strands scheduled work'));
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
-- GRANTS. `create or replace` keeps the existing ACL, so this is a restatement
-- rather than a repair — but D93 shipped four `anon`-executable RPCs precisely
-- because a migration assumed that and did not check.
-- ----------------------------------------------------------------------------
revoke all on function app_relevel_subtree(uuid, uuid, int) from public;
grant execute on function app_relevel_subtree(uuid, uuid, int) to authenticated;

comment on function app_relevel_subtree(uuid, uuid, int) is
  'Move a node and its whole subtree one rung up (delta -1) or down (+1). '
  'Refuses, in order: no destination rung (level_mismatch), a prospective path '
  'that already exists (path_collision, 0024), a re-level that would strand '
  'nodes between levels (level_mismatch), and one that would strand scheduled '
  'work (schedulable_level_locked, payload {blocking_rows, level_id}).';


-- ============================================================================
-- THE MUTATION TABLE, AND THE FOUR THAT CATCH NOTHING — `supabase/tests/
-- mutations/0024.json`, 11 mutations, 7 caught, 4 EXECUTED AND INERT. A verdict
-- of "not caught" with no explanation is a hole, so each one says which kind it
-- is and names the case that pins the fact it depends on. If that case ever
-- goes red, the mutation is live again.
--
--   S2  the moved subtree stops being excluded from its own collision
--       candidates. INERT — a prospective path can never equal a CURRENT path
--       inside the same subtree: promote's destination is the grandparent, so
--       every new path is SHORTER than the subtree's own and shares no prefix
--       with it, and demote's destination is proven outside the subtree by
--       demote_node's cycle check before this function is entered.
--       ⭐ KEPT ANYWAY, and not as decoration: `app_relevel_subtree` is granted
--       to `authenticated` and therefore reachable directly (N16), so it must
--       be correct WITHOUT relying on which wrapper called it. Pinned by N12
--       (the cycle refusal) and N5.
--
--   S3  the collision query stops filtering by org. INERT — this function is
--       SECURITY INVOKER, so the `nodes` read is already RLS-filtered to the
--       caller's org. Contoso's tree is path-for-path identical to Northwind's,
--       which makes this the most dangerous of the four to leave unpinned:
--       N15 builds exactly that decoy and asserts the promote still succeeds,
--       so the day this function becomes SECURITY DEFINER, N15 goes red.
--
--   S6  the new parent's path lookup stops filtering by org. INERT — masked by
--       an EARLIER guard in this same function: 0020's destination admin check
--       has already refused any parent outside the caller's own org. Pinned by
--       N16, which calls this function directly with a foreign destination.
--
--   S10 the collision check looks at the moved node only, not at its subtree.
--       INERT — every path is built as parent-path + own label, so a path can
--       only exist if every PREFIX of it exists as a node. A descendant's
--       prospective path therefore cannot already exist unless the moved node's
--       own does, and that is found first. Pinned by N17, which asserts the
--       prefix invariant over the whole table rather than assuming it.
-- ============================================================================
