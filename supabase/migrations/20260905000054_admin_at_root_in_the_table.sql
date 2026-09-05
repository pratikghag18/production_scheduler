-- ============================================================================
-- 0054 — THE ADMIN-AT-ROOT RULE, PUT BACK TOGETHER AND PUT IN THE TABLE.
--
-- Two defects from the tester's run of 5 Sept, both against 0053, fixed in one
-- file because both are about the same function and the same table.
--
-- ⛔ DEF-0011: 0053 RE-EMITTED `set_site_member` FROM THE WRONG MIGRATION. It
-- copied 0021's body and added its block, and 0022 --- the migration between
-- them --- had already re-emitted the same function with a guard of its own:
-- a site admin may not re-role a company admin's grant (R-238). So the live
-- function refused `admin` below a root and no longer refused that. X42 in
-- `49_company_admin_rows_test.sql` was red on the commit that shipped 0053 and
-- the SQL suite was not run. `remove_site_member` was untouched and still
-- refuses, so half the rule survived by accident.
--
-- ⚠️ HOW IT WAS COPIED WRONG, so the recipe is fixed and not just the file.
-- CLAUDE.md said `grep -n "function <name>"` and take the last hit. 0022
-- declares it `CREATE OR REPLACE FUNCTION public.set_site_member` --- upper
-- case, schema-qualified --- and a case-sensitive grep for the bare name finds
-- 0021 and 0053 only. This file's body was SLICED out of 0022 by a script
-- (from `CREATE OR REPLACE FUNCTION public.set_site_member(` to
-- `END $function$;`), 0053's block was inserted after the role check, and the
-- three reasons --- `company_admin`, `admin_below_root`, `self` --- were
-- asserted on the assembled text before the file was written.
--
-- ⛔ DEF-0012: THE RULE LIVED IN ONE FUNCTION AND NOWHERE ELSE. `profile_grants`
-- has RLS (`app_is_admin() OR app_is_admin_for(node_id)`) and no constraint on
-- the role, so a site admin could POST `role: admin` on Area 1 straight to the
-- table, or PATCH a supervisor grant up to admin, and both stored. 0053's own
-- subject line said "the database says so first" and the database said
-- nothing. The same schema does this right one table over:
-- `nodes_check_level_adjacency` refuses a bad parent at the TABLE, so
-- `move_node`, `place_node` and a raw UPDATE all get the same answer. This is
-- that shape on `profile_grants`.
--
-- ⭐ THE TRIGGER REFUSES CREATING THE STATE, NOT REPAIRING IT. It fires on
-- INSERT and on UPDATE OF role, node_id, and it raises only when the row
-- BEING WRITTEN is `admin` below a root. A below-root admin that already exists
-- (0053 leaves them alone; there are none on the dev database) can still be
-- demoted to supervisor or removed --- those are the repairs an administrator
-- makes, and refusing them would freeze the inconsistency in place.
-- `77_admin_only_at_plant_root_test.sql` AR9 pins that.
--
-- ⚠️ IT BINDS EXACTLY WHO THE TABLE'S POLICIES BIND, AND NOT THE OWNER. RLS
-- on `profile_grants` does not apply to the table's owner, and neither does
-- this: the owner is the migration and fixture tool, and eleven cases in
-- `46_scoped_roles_test.sql` plus the fixtures of 47, 48, 51, 52, 53 and 56
-- build "an admin of a department" as the owner, because 0019's predicates
-- must go on being right for rows that predate this rule. Measured: with the
-- trigger binding the owner too, 527 passed, 12 failed and 205 hard errors
-- across the suite; binding what RLS binds, the suite is whole. The owner
-- check is 0017's, `pg_has_role(current_user, <relowner>, 'USAGE')`, and it is
-- why this function is SECURITY INVOKER --- inside a definer `current_user`
-- would be the definer and the check would pass for everybody. Every
-- PostgREST session is `authenticated` or `anon`, and both are bound. 77's
-- AR5 proves a COMPANY admin is bound, so the line is owner-versus-everyone
-- and not one role versus another; AR9 proves the owner is not.
--
-- ⚠️ THE NODE'S SHAPE IS READ THROUGH A DEFINER HELPER, NOT THROUGH THE
-- CALLER'S EYES. The first draft tested "no root row is visible for this
-- node" inside the invoker trigger, and 47's W28 went red: a site admin
-- inserting admin on ANOTHER plant's root was refused by this trigger with
-- PT400 before the policy could refuse it with 42501, because that root is
-- invisible to them. Both are refusals, but W28 asserts which layer speaks,
-- and it is right to --- "there is no RPC to blame, only the policy" is the
-- shape of that attack. `app_node_is_plant_root` is SECURITY DEFINER in the
-- shape of `app_node_exists_in_org` (0020), so the trigger answers about the
-- node as it is: a root passes here and the policy decides; a non-root, or a
-- node that does not exist, is refused here. Whether the caller can SEE the
-- node never decides an answer about the node's shape.
--
-- Verified by `supabase/tests/77_admin_only_at_plant_root_test.sql`, the file
-- 0053 shipped without.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_site_member(p_node_id uuid, p_profile_id uuid, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org   uuid;
  v_after text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  IF NOT app_profile_exists_in_org(p_profile_id) THEN
    PERFORM api_raise('invalid_argument', 'no such person',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not found'));
  END IF;

  -- ⭐ 0022: A COMPANY ADMIN'S ROW IS NOT A SITE ADMIN'S TO EDIT.
  IF app_profile_is_company_admin(p_profile_id) AND NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'company admins are not managed from a site',
                      jsonb_build_object('profile_id', p_profile_id,
                                         'reason', 'company_admin'));
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin', 'supervisor', 'viewer') THEN
    PERFORM api_raise('invalid_argument', 'unknown role',
                      jsonb_build_object('field', 'role', 'value', p_role));
  END IF;

  -- ⭐ 0053, carried by 0054: `admin` ONLY AT A PLANT ROOT, and it sits here on purpose --
  -- AFTER "is that a real role" so an unknown word is still reported as an
  -- unknown word, and BEFORE the self-rule so the answer does not depend on
  -- who is asking. `invalid_argument` rather than `not_permitted`: the caller
  -- is allowed to administer this place, they have asked for a combination
  -- that does not exist.
  IF p_role = 'admin'
     AND EXISTS (SELECT 1 FROM nodes n
                  WHERE n.id = p_node_id AND n.parent_id IS NOT NULL) THEN
    PERFORM api_raise('invalid_argument',
                      'an admin runs a whole plant, so admin can only be given at a plant',
                      jsonb_build_object('field', 'role', 'value', p_role,
                                         'node_id', p_node_id,
                                         'reason', 'admin_below_root'));
  END IF;

  IF p_profile_id = app_current_profile_id()
     AND p_role <> 'admin'
     AND NOT app_is_admin()
     AND EXISTS (SELECT 1 FROM profile_grants pg
                  WHERE pg.profile_id = p_profile_id
                    AND pg.node_id    = p_node_id
                    AND pg.role       = 'admin') THEN
    PERFORM api_raise('not_permitted', 'you cannot take away your own admin access here',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'self'));
  END IF;

  v_org := app_current_org();

  INSERT INTO profile_grants (profile_id, node_id, org_id, role)
       VALUES (p_profile_id, p_node_id, v_org, p_role)
  ON CONFLICT (profile_id, node_id) DO UPDATE SET role = EXCLUDED.role;

  SELECT pg.role INTO v_after
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',    p_node_id,
    'profileId', p_profile_id,
    'role',      v_after
  );
END $function$;


-- ----------------------------------------------------------------------------
-- Is this node a plant root? Answered about the node, not about the caller.
-- ----------------------------------------------------------------------------
create or replace function app_node_is_plant_root(p_node_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM nodes n WHERE n.id = p_node_id AND n.parent_id IS NULL
  );
$$;

comment on function app_node_is_plant_root(uuid) is
  'True when the node exists and has no parent --- a plant root, the only place an admin grant may sit (R-340). SECURITY DEFINER so the answer is about the node and not about what the caller can see (0054).';

revoke execute on function app_node_is_plant_root(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_node_is_plant_root(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_node_is_plant_root(uuid) from anon';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- The table's own copy of the rule.
-- ----------------------------------------------------------------------------
create or replace function profile_grants_admin_at_root() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- The owner is the migration and fixture tool, as it is for every policy on
  -- this table (0017's check, extracted rather than retyped).
  if pg_catalog.pg_has_role(
       current_user,
       (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.profile_grants'::regclass),
       'USAGE') then
    return new;
  end if;

  if new.role = 'admin' and not app_node_is_plant_root(new.node_id) then
    perform api_raise('invalid_argument',
                      'an admin runs a whole plant, so admin can only be given at a plant',
                      jsonb_build_object('field', 'role', 'value', new.role,
                                         'node_id', new.node_id,
                                         'reason', 'admin_below_root'));
  end if;
  return new;
end $$;

comment on function profile_grants_admin_at_root() is
  'Trigger: refuses writing an admin grant anywhere but a plant root (R-340, DEF-0012), for every session the table''s policies bind and not for the owner, which is the migration and fixture tool. Fires on INSERT and on UPDATE OF role, node_id, so an existing below-root admin can still be demoted or removed; it refuses creating the state, not repairing it. The node''s shape is read through app_node_is_plant_root, a definer, so what the caller can see never decides it; a node that is not a root, or does not exist, is refused.';

revoke execute on function profile_grants_admin_at_root() from public;

drop trigger if exists profile_grants_admin_at_root on profile_grants;
create trigger profile_grants_admin_at_root
  before insert or update of role, node_id on profile_grants
  for each row execute function profile_grants_admin_at_root();

comment on function set_site_member(uuid, uuid, text) is
  'Give a person a role on this node''s subtree, or change the role they already hold there (0021 §4, guarded by 0022, narrowed by 0053, re-assembled whole by 0054). One row, so adding and re-roling are one function. Refuses unless the caller administers the node; refuses a site admin editing a company admin''s row; refuses a site admin removing their OWN access here; and refuses `admin` anywhere but a plant root, which the table itself also refuses. The row is read back so the returned role is what is stored, not an echo of the argument.';
