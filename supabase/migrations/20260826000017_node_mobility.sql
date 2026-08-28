-- ============================================================================
-- 0017 — node mobility: place_node (D94), promote_node / demote_node (P1-5k),
--        and the escape hatch finally locked (D97).
--
-- THREE RPCs IN ONE MIGRATION, DELIBERATELY (D96). Every migration costs a CLI
-- run, a `database.types.ts` regeneration and a commit, and a migration plus
-- its regenerated types is ONE change. These three touch different columns
-- (`sort_order` vs `parent_id`/`level_id`) and different functions, so there is
-- no interference — and batching them collapses two round trips into one.
--
-- ⭐ AND THE ESCAPE HATCH IS NOT USED BY ANY OF THEM.
-- P1-5k was designed (§19.33) around `app.hierarchy_migration`, the bypass 0010
-- reserved for exactly this kind of bulk re-level. It turned out not to be
-- needed. `nodes_before_level` fires per row and compares that row to its
-- PARENT only — it never looks down at children — so if each node is moved
-- AFTER its parent already sits at its final level, every intermediate state is
-- legal. Measured with the trigger fully armed and the hatch never set: a
-- three-generation promote across 14 nodes, 0 adjacency violations. The
-- invariant is now enforced CONTINUOUSLY instead of suspended and re-checked,
-- which is strictly safer, and it is why locking the hatch below costs nothing.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- place_node — D94. Put a node at a position among its parent's children.
--
-- Reordering siblings is what the maintainer reached for in his first minute with the
-- tree drag, and P1-5g had excluded it (§19.34). `move_node` has been able to
-- reorder since 0010 (`sort_order = coalesce(p_sort_order, sort_order)`), but a
-- single call cannot express "between these two": seed.sql sets no sort_order
-- at all, so every sibling sits at 0 and there is no integer between 0 and 0.
-- Measured. Placing at a position therefore requires renumbering, atomically.
--
-- EVERY STRUCTURAL GUARD IS DELEGATED TO move_node, not restated. It already
-- carries admin, org scope, unknown node, NULL-parent-only-at-position-0,
-- self-parent, descendant-cycle, level adjacency and path collision. Calling it
-- when the parent is unchanged is a measured no-op. Brief-writing rule 4's
-- strongest form: make the two things the SAME CALL.
-- ----------------------------------------------------------------------------
create function place_node(p_node_id uuid, p_new_parent_id uuid, p_index int)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_ids    uuid[];
  v_target int;
  v_result jsonb;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;
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
$$;


-- ----------------------------------------------------------------------------
-- app_relevel_subtree — the engine behind promote_node / demote_node (P1-5k).
--
-- A node's level was IMMUTABLE before this: nothing in sixteen migrations ever
-- updated `nodes.level_id`, and with one level per rung a node's level is fully
-- determined by its parent's. So a subtree built at the wrong rung could only
-- be deleted and rebuilt, losing everything scheduled on it.
--
-- promote/demote are thin wrappers so the ordering, the up-front rung check and
-- the two post-write checks exist exactly once. Promote DERIVES its new parent
-- (the grandparent, or NULL when the node becomes a root); demote is GIVEN one.
-- ----------------------------------------------------------------------------
create function app_relevel_subtree(p_node_id uuid, p_new_parent_id uuid, p_delta int)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id   uuid;
  v_node     nodes%rowtype;
  v_ids      uuid[];
  v_missing  int;
  v_stranded int;
  v_result   jsonb;
  r          record;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;
  v_org_id := app_current_org();

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
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
$$;


create function promote_node(p_node_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $$
declare v_org_id uuid; v_parent_id uuid; v_grandparent_id uuid; v_found boolean;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;
  v_org_id := app_current_org();

  select true, parent_id into v_found, v_parent_id
    from nodes where id = p_node_id and org_id = v_org_id;
  if v_found is not true then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;
  if v_parent_id is null then
    perform api_raise('level_mismatch', 'a top-level node cannot be promoted',
      jsonb_build_object('reason', 'already at the first level'));
  end if;

  -- DERIVED, not given: the grandparent, or NULL when the parent is a root and
  -- this node becomes one.
  select parent_id into v_grandparent_id
    from nodes where id = v_parent_id and org_id = v_org_id;

  return app_relevel_subtree(p_node_id, v_grandparent_id, -1);
end;
$$;


create function demote_node(p_node_id uuid, p_new_parent_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_org_id uuid; v_node nodes%rowtype; v_target nodes%rowtype;
  v_own_pos int; v_target_pos int; v_own_tpl uuid; v_target_tpl uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;
  v_org_id := app_current_org();

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;
  select * into v_target from nodes where id = p_new_parent_id and org_id = v_org_id;
  if v_target.id is null then
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
$$;


-- ----------------------------------------------------------------------------
-- D97 — the escape hatch, locked. Extracted PROGRAMMATICALLY from migration
-- 0010 (its only definition, confirmed by grep) with only the guard replaced;
-- rule 12, do not hand-retype a function to change part of it.
-- ----------------------------------------------------------------------------
-- ⚠️ EXTRACTED FROM 0014, NOT 0010. `grep -n "function nodes_check_level_adjacency"`
-- returns 0010 AND 0014 — and 0014's `create or replace` is the LIVE one, because
-- D86 added the TEMPLATE half of the rule there. Extracting 0010's body silently
-- reverts D86, and the whole suite caught it: case T7 in
-- 90_hierarchy_template_test.sql went from PASS to `caught=f`. That case exists
-- for exactly this and it is the only one that covers the template half.
-- Decision-record-drift rule 3, hit for the second time in this project.
create or replace function nodes_check_level_adjacency() returns trigger
language plpgsql as $$
declare
  v_own_position    int;
  v_own_template    uuid;
  v_parent_position int;
  v_parent_template uuid;
begin
  -- D97 — THE HATCH IS NOW OWNER-ONLY.
  -- `app.hierarchy_migration` is a plain GUC, and MEASURED: a bare
  -- `authenticated` session can `set local` it itself. Nothing could reach the
  -- damage through PostgREST (a client can only call the functions we wrote,
  -- and none of them set it), so this was never exploitable -- but "the level
  -- invariant can be switched off by anyone signed in" is not a property to
  -- leave standing, and the maintainer asked for it closed.
  --
  -- Locking it costs nothing precisely BECAUSE nothing uses it any more:
  -- app_relevel_subtree (this same migration) does its bulk re-level top-down
  -- with the trigger armed throughout. The hatch is back to being what 0010
  -- reserved it for -- a migration tool, which runs as the table's owner.
  --
  -- `pg_has_role(current_user, <owner>, 'USAGE')` rather than a hardcoded role
  -- name, so this keeps working on Supabase (owner `postgres`) and in the
  -- scratch harness (owner `ubuntu`) without knowing either. Measured: true for
  -- the owner, false for `authenticated` and `anon`.
  --
  -- It RAISES rather than ignoring the flag, so a caller cannot believe they
  -- bypassed the check and then hit a confusing adjacency error later.
  if coalesce(current_setting('app.hierarchy_migration', true), '') = 'on' then
    if pg_catalog.pg_has_role(
         current_user,
         (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.nodes'::regclass),
         'USAGE') then
      return new;
    end if;
    perform api_raise('not_permitted',
      'the hierarchy migration bypass is reserved for the database owner',
      jsonb_build_object('reason', 'hierarchy_migration bypass not permitted for this role'));
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


-- ============================================================================
-- GRANTS — this migration CREATES four functions, so it carries its own block.
-- D93 is exactly the trap of creating functions and granting only a table:
-- 0014 did that and left all four of its RPCs `anon`-executable.
--
-- `app_relevel_subtree` is granted to `authenticated` because promote_node and
-- demote_node are SECURITY INVOKER and the CALLING role needs EXECUTE on it.
-- That makes it reachable directly, like every other `app_`-prefixed helper in
-- this schema (`app_is_admin`, `app_can_read_node`, `app_grant_paths`) -- and
-- it is safe for the same reason those are: every guard lives INSIDE it. A
-- direct caller still faces the admin check, the org scope, the up-front rung
-- check, the armed adjacency trigger, `nodes_before_cycle`, and both post-write
-- checks. The most a direct call can do is a promote or demote to some other
-- legal parent, which is a sound operation, not an escape.
-- ============================================================================
REVOKE EXECUTE ON FUNCTION place_node(uuid,uuid,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_relevel_subtree(uuid,uuid,int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION promote_node(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION demote_node(uuid,uuid) FROM PUBLIC;

DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION place_node(uuid,uuid,int) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_relevel_subtree(uuid,uuid,int) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION promote_node(uuid) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION demote_node(uuid,uuid) TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION place_node(uuid,uuid,int) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION app_relevel_subtree(uuid,uuid,int) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION promote_node(uuid) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION demote_node(uuid,uuid) FROM anon';
  END IF;
END $grants$;
