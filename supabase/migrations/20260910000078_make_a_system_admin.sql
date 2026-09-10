-- ============================================================================
-- MAKE (OR UNMAKE) A SYSTEM ADMIN (R-XXX).
--
-- The maintainer: *"there cannot be just one system admin, what if that person
-- leaves or is on vacation? ... how do I make someone else a system admin?"*
--
-- Until now the org-wide `user_profiles.role = 'admin'` -- the flag that makes
-- someone a SYSTEM (company) admin, `app_is_admin()` -- could only be set for
-- the account that created the company. Invited people are created org-wide
-- 'viewer' and get their access through node grants; nothing in the app could
-- promote one to system admin. This adds that.
--
-- A system admin's authority is `user_profiles.role` alone (0022 records this:
-- their profile_grants row is redundant for authority), so a promotion is just
-- setting that column -- no companion grant to write.
--
-- WHO MAY: a system admin only (`app_is_admin()`). This is the highest
-- privilege in the org; a site admin cannot grant it (and 0020 §9 already keeps
-- `user_profiles.role` closed to a site admin's writes, so this DEFINER RPC is
-- the only door).
--
-- GUARDS, loud pre-checks like set_profile_active (0076):
--   * caller is a system admin;
--   * target exists IN THE CALLER'S ORG (scoped to app_current_org(), so a
--     foreign id answers the same "no such person" as a bogus one -- no
--     cross-tenant existence leak);
--   * you cannot change your OWN role (you must not demote yourself and lock
--     the company out from inside; promoting yourself is moot).
--
--   There is deliberately NO "last admin" guard, for the same reason 0076 gives:
--   the caller is always an active system admin, and self is refused, so
--   demoting any OTHER profile always leaves the caller -- zero system admins is
--   unreachable, and a guard for it would be dead code (gotcha 17). Promotion,
--   the direction the maintainer actually asked for, is what removes the
--   single-admin risk.
-- ============================================================================

create or replace function set_system_admin(
  p_profile_id uuid,
  p_is_admin   boolean
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
DECLARE
  v_org  uuid;
  v_was  text;
  v_next text := case when p_is_admin then 'admin' else 'viewer' end;
BEGIN
  IF p_is_admin IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_is_admin is required',
                      jsonb_build_object('field', 'p_is_admin', 'reason', 'null'));
  END IF;

  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system administrator can change who is a system admin',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not_system_admin'));
  END IF;

  SELECT up.org_id, up.role
    INTO v_org, v_was
    FROM user_profiles up
   WHERE up.id = p_profile_id
     AND up.org_id = app_current_org();

  IF v_org IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such person',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not found'));
  END IF;

  IF p_profile_id = app_current_profile_id() THEN
    PERFORM api_raise('not_permitted', 'you cannot change your own system-admin status',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'self'));
  END IF;

  -- Demotion normalises the org-wide role to 'viewer', the value the invite flow
  -- gives every non-admin: the person keeps their node grants (their access is
  -- those grants, not this flag) and simply loses org-wide authority.
  UPDATE user_profiles SET role = v_next WHERE id = p_profile_id;

  RETURN jsonb_build_object(
    'profileId', p_profile_id,
    'isAdmin',   p_is_admin,
    'changed',   (v_was IS DISTINCT FROM v_next)
  );
END $$;

comment on function set_system_admin(uuid, boolean) is
  'Promote (p_is_admin true -> user_profiles.role admin) or demote (false -> viewer) a person''s ORG-WIDE system-admin status, migration 0078. System admins only; refuses acting on your own account and on a profile outside your org (no existence leak). No last-admin guard: the caller is always an active system admin and self is refused, so zero admins is unreachable. Demotion keeps the person''s node grants.';

revoke execute on function set_system_admin(uuid, boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_system_admin(uuid, boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function set_system_admin(uuid, boolean) from anon';
  end if;
end $$;
