-- ============================================================================
-- 20260827000022_company_admin_rows.sql
--
-- ⭐ A COMPANY ADMIN'S ROW IS NOT A SITE ADMIN'S TO EDIT.
--
-- FOUND BY THE MAINTAINER ON THE RUNNING SCREEN, signed in as a site admin: the
-- company admin's row offered a role control and a Remove button, and the
-- server allowed both.
--
-- MEASURED FIRST, because the size of a defect decides the size of the fix:
--
--   Dana (site admin of Plant 1) removes the company admin's grant there
--     -> ALLOWED, row deleted
--   the company admin immediately afterwards
--     -> app_is_admin = true, app_is_admin_for(Plant 1) = true, 18/18 nodes
--
-- **It is not an escalation and it takes nothing away.** A company admin's
-- authority comes from `user_profiles.role`, and 0020 §9 keeps that field
-- company-admin-only, so a site admin cannot write it. The grant they can
-- delete is redundant for that person.
--
-- It is still wrong, for three reasons worth writing down:
--
--   1. It is a ROLE INVERSION -- the person with less authority editing the
--      record of the person with more. It is harmless today only because of a
--      fact in a different table, which is exactly the shape that becomes a
--      hole when the model changes.
--   2. It LIES. The button appears to remove a company admin's access and
--      removes nothing; only the row's wording moves.
--   3. If that person ever loses the org-wide flag, a grant a site admin
--      silently deleted is gone.
--
-- ⚠️ AND THE FIX HAD TO BE HERE RATHER THAN IN THE SCREEN. Hiding the button
-- alone would have broken the invariant this whole feature rests on, stated
-- in `shapePicker.ts` and again in `siteAccess.ts`: **anything the client
-- hides, the server must also refuse.** A client that hides a permitted
-- action is a feature nobody can reach; only the server can make the hiding
-- honest.
--
-- ⭐ NO NEW POLICY, DELIBERATELY. `profile_grants`' RLS is unchanged: a plain
-- PostgREST write is still governed by 0020 §9, and this migration guards the
-- two RPCs. That is a real limitation and it is named rather than hidden --
-- see §3 at the bottom.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. `app_profile_is_company_admin` — the third of 0020 §8.0's family.
--
-- A site admin cannot SELECT `user_profiles` at all (0021 kept that closed on
-- purpose), so the guard below cannot read the flag directly. Same three
-- properties that make `app_node_exists_in_org` and `app_profile_exists_in_org`
-- safe: org-scoped internally, answers only a boolean, grants nothing.
--
-- ⚠️ It answers FALSE for a profile that does not exist, which is the same
-- answer it gives for an ordinary person. That is correct here and only
-- because of ORDER: both callers have already established the profile exists
-- (`set_site_member`) or that a grant for it exists (`remove_site_member`)
-- before this runs. A caller that asked this first would be using a
-- three-valued question as a two-valued one.
-- ----------------------------------------------------------------------------
create or replace function app_profile_is_company_admin(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles up
     WHERE up.id = p_profile_id
       AND up.org_id = app_current_org()
       AND up.role = 'admin'
  );
$$;

comment on function app_profile_is_company_admin(uuid) is
  'Is this profile a COMPANY admin of the caller''s org (0022 §1)? For guards that must not let a site admin edit a company admin''s row. Org-scoped internally, grants nothing. Answers FALSE for a profile that does not exist -- call it only after existence is established.';

revoke execute on function app_profile_is_company_admin(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_profile_is_company_admin(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_profile_is_company_admin(uuid) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §2. The two write RPCs, re-created with the guard.
--
-- ⚠️ BOTH BODIES WERE EXTRACTED FROM THE LIVE DATABASE with
-- `pg_get_functiondef` and edited by string replacement with a uniqueness
-- assertion on the anchor -- never retyped (verification rule 12). Taking
-- either from 0021's file would be safe today and is exactly the habit that
-- silently reverted two later fixes when `create_node` was retyped.
--
-- WHERE THE GUARD SITS, and the order is the contract:
--
--   set_site_member ..... after the person exists, before the role is checked.
--                         "There is no such person" outranks "you may not edit
--                         that person", because the first is a typo and the
--                         second is a rule.
--   remove_site_member .. after "there is nothing here to remove", before the
--                         self-rule. Same reasoning: the absent row is the
--                         truer sentence when both hold.
--
-- Cases X40-X45 in `49_company_admin_rows_test.sql` pin both orderings.
-- ----------------------------------------------------------------------------
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


CREATE OR REPLACE FUNCTION public.remove_site_member(p_node_id uuid, p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_before text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  SELECT pg.role INTO v_before
    FROM profile_grants pg
   WHERE pg.profile_id = p_profile_id AND pg.node_id = p_node_id;

  IF v_before IS NULL THEN
    PERFORM api_raise('invalid_argument', 'that person has no access here to remove',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'not found'));
  END IF;

  -- ⭐ 0022: A COMPANY ADMIN'S ROW IS NOT A SITE ADMIN'S TO EDIT.
  IF app_profile_is_company_admin(p_profile_id) AND NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'company admins are not managed from a site',
                      jsonb_build_object('profile_id', p_profile_id,
                                         'reason', 'company_admin'));
  END IF;

  -- §4's rule, in its strongest form and narrowed the same way: only the grant
  -- that currently makes the caller an admin OF THIS NODE is protected.
  -- Dropping a viewer or supervisor row of their own is harmless and allowed.
  IF p_profile_id = app_current_profile_id()
     AND NOT app_is_admin()
     AND v_before = 'admin' THEN
    PERFORM api_raise('not_permitted', 'you cannot take away your own admin access here',
                      jsonb_build_object('node_id', p_node_id, 'profile_id', p_profile_id,
                                         'reason', 'self'));
  END IF;

  -- ⛔ AND THERE IS NO OUTCOME CHECK AFTER THIS, FOR THE REASON §4 RECORDS.
  -- Mutation Y33 deleted one and was NOT CAUGHT: by the time this line runs,
  -- the pre-check has established `app_is_admin_for(p_node_id)` AND the row
  -- was readable, and `profile_grants_delete`'s USING clause is that same
  -- predicate -- so the DELETE cannot be the thing that quietly does nothing.
  -- **What makes a refused removal loud here is the PRE-check.** That is the
  -- whole reason this function exists instead of a PostgREST `DELETE`, and
  -- case X28 is where it is measured -- it asserts the typed refusal AND that
  -- the row survived.
  DELETE FROM profile_grants
   WHERE profile_id = p_profile_id AND node_id = p_node_id;

  RETURN jsonb_build_object(
    'nodeId',      p_node_id,
    'profileId',   p_profile_id,
    'removedRole', v_before
  );
END $function$;


-- ----------------------------------------------------------------------------
-- §3. WHAT THIS DOES NOT DO.
--
-- 1. **`profile_grants`' RLS is untouched.** A caller reaching PostgREST
--    directly can still delete a company admin's grant on a node they
--    administer, because 0020 §9's policy asks only `app_is_admin_for(node_id)`.
--    The guard is on the RPCs, which is where the screen goes.
--
--    That is a deliberate choice and not an oversight: putting it in the policy
--    means `profile_grants_delete` reading `user_profiles`, and a policy that
--    delegates to another table's contents is the shape verification rule 9
--    exists to warn about -- it greps clean and inherits every hole of the
--    thing it reads. **If this needs to hold against a direct PostgREST call,
--    it is its own migration with its own cases**, and case X46 asserts the
--    gap rather than leaving it to be discovered.
--
-- 2. **It says nothing about a company admin editing a company admin.** Two
--    company admins are peers; `NOT app_is_admin()` is the whole condition.
--
-- 3. **No data changes.** No column, table, policy or trigger, and nothing is
--    transformed -- so no `UPGRADE_CHECKS` row and no `upgrade_0022_*.sql`,
--    stated here so the absence is on the record.
-- ----------------------------------------------------------------------------
