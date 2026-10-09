-- ============================================================================
-- DEACTIVATE A USER -- a reversible alternative to removing their access (R-XXX).
--
-- The maintainer, from the Access tab: *"there is only a remove option for a
-- user ... we could have a deactivate option ... We should make it possible."*
--
-- REMOVE takes away one grant on one node (`remove_site_member`, 0021) and is
-- node-scoped: a site admin may do it for a place they administer. DEACTIVATE
-- is a different, heavier thing -- it suspends the whole PERSON's access across
-- the org while keeping every grant intact, so it can be undone with one click.
-- Because it is org-wide, it is a COMPANY (system) admin power, never a single
-- plant's site admin: a Plant-1 admin must not be able to lock someone out of
-- Plant 2. Site admins keep node-scoped remove; company admins additionally get
-- this reversible suspend.
--
-- This follows the SAME `active boolean` pattern the rest of the schema already
-- uses for a reversible off switch: `nodes.active` (delete_node p_mode
-- 'deactivate', 0010), `operators.active`, `products.active`. A deactivated row
-- is kept, not deleted; history and grants survive; reactivation is a flip.
--
-- ENFORCEMENT is at the ONE identity chokepoint every policy derives from:
-- `app_current_profile_id()` (0018). A deactivated profile resolves to NULL
-- there, so `app_current_org()` is NULL and every RLS check and DEFINER RPC
-- denies -- the person is locked out everywhere at once, by construction, with
-- no per-policy edit to forget. The client mirrors it: SessionProvider reads
-- `active` and treats false as "no profile", so the app shows its no-access
-- state rather than a half-broken one.
-- ============================================================================

-- 1. The column. NOT NULL with default true: every existing profile stays
--    active, and this is an ADDITIVE column (never DROP NOT NULL), so no client
--    parser is silently widened (CLAUDE.md sec.4).
alter table user_profiles
  add column active boolean not null default true;

comment on column user_profiles.active is
  'False = the person is deactivated: their grants and history are kept, but they are locked out org-wide because app_current_profile_id() skips an inactive profile (migration 0076). Flip with set_profile_active; only a company admin may.';

-- ----------------------------------------------------------------------------
-- 2. The chokepoint gains one predicate. Re-emitted VERBATIM from 0018 with a
--    single added `AND active` -- the ORDER BY / LIMIT 1 determinism (D87) and
--    the DEFINER/search_path are unchanged. A user whose only profile is
--    inactive gets NULL here; a multi-org user simply acts in their next active
--    org. `create or replace` preserves existing grants (D93).
-- ----------------------------------------------------------------------------
create or replace function app_current_profile_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  SELECT id FROM user_profiles
   WHERE user_id = (SELECT auth.uid())
     AND active
   ORDER BY org_id, id
   LIMIT 1;
$$;

-- ----------------------------------------------------------------------------
-- 3. set_profile_active -- flip a person's active flag. DEFINER, because it
--    writes a row the caller's RLS would not let them touch, and it must be
--    able to READ the target regardless of the target's own (possibly
--    inactive) state.
--
--    Guards, loud pre-checks in the style of remove_site_member (0021 §5):
--      * caller is a company admin (app_is_admin()); a site admin is refused --
--        this is an org-wide switch;
--      * the target exists IN THE CALLER'S ORG (scoped to app_current_org(), so
--        a foreign id answers the same "no such profile" as a bogus one -- no
--        cross-tenant existence leak, the DEF-0021 rule);
--      * you cannot flip your OWN account (a company admin must not deactivate
--        themselves and lock the door from inside).
--
--    There is deliberately NO "last active admin" guard, and its absence is the
--    correct design, not an omission: the caller has already passed
--    `app_is_admin()`, which resolves through the now-active-gated
--    `app_current_profile_id()`, so the caller is ALWAYS an active admin. For
--    any other-than-self target the caller is therefore a second active admin,
--    and deactivating the target can never reach zero; the only path to zero is
--    deactivating yourself, which the self-guard already refuses. A "last admin"
--    check would be unreachable code, which the repo bans (gotcha 17).
-- ----------------------------------------------------------------------------
create or replace function set_profile_active(
  p_profile_id uuid,
  p_active     boolean
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
DECLARE
  v_org  uuid;
  v_was  boolean;
BEGIN
  IF p_active IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_active is required',
                      jsonb_build_object('field', 'p_active', 'reason', 'null'));
  END IF;

  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a company administrator can deactivate a user',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not_company_admin'));
  END IF;

  SELECT up.org_id, up.active
    INTO v_org, v_was
    FROM user_profiles up
   WHERE up.id = p_profile_id
     AND up.org_id = app_current_org();

  IF v_org IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such person',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'not found'));
  END IF;

  IF p_profile_id = app_current_profile_id() THEN
    PERFORM api_raise('not_permitted', 'you cannot deactivate your own account',
                      jsonb_build_object('profile_id', p_profile_id, 'reason', 'self'));
  END IF;

  UPDATE user_profiles SET active = p_active WHERE id = p_profile_id;

  RETURN jsonb_build_object(
    'profileId', p_profile_id,
    'active',    p_active,
    'changed',   (v_was IS DISTINCT FROM p_active)
  );
END $$;

comment on function set_profile_active(uuid, boolean) is
  'Deactivate (p_active false) or reactivate (true) a person org-wide, keeping their grants and history -- the reversible alternative to remove_site_member (migration 0076). Company admins only; refuses acting on your own account, on a profile outside your org (no existence leak), and on the last active admin.';

-- ----------------------------------------------------------------------------
-- 4. site_people re-emitted to carry `active` per person, so the Access panel
--    can show a deactivated member (greyed, with Reactivate) instead of hiding
--    someone who can no longer be found to restore. Re-emitted VERBATIM from
--    0064 with exactly ONE added field (`'active', up.active`) in the person
--    object -- everything else (the total/returned counts, the invitedPending
--    rule, the grants subquery bounded to the node's subtree, the LEFT JOIN on
--    auth.users, the ORDER BY, the limit) is unchanged. DEF-0011 is the reason
--    this note exists: a re-emit that drops a rule is the trap here.
-- ----------------------------------------------------------------------------
create or replace function site_people(p_node_id uuid,
                                       p_search  text    default null,
                                       p_limit   integer default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
DECLARE
  v_path   ltree;
  v_name   text;
  v_org    uuid;
  v_people jsonb;
  v_total  integer;
  v_search text;
BEGIN
  IF NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such node',
                      jsonb_build_object('node_id', p_node_id, 'reason', 'not found'));
  END IF;

  IF NOT app_is_admin_for(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this place',
                      jsonb_build_object('node_id', p_node_id));
  END IF;

  v_org := app_current_org();
  SELECT n.path, n.name INTO v_path, v_name FROM nodes n WHERE n.id = p_node_id;

  -- NULL or blank search is "no filter", the same as today. The bound is on the
  -- email, the only human-readable thing the system knows about a person.
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  -- The honest total: people matching the filter BEFORE any limit, so a client
  -- that sees returned < total knows to narrow the search rather than mistake a
  -- capped list for the whole company (0021 §3's worry, answered).
  SELECT count(*) INTO v_total
    FROM user_profiles up
    LEFT JOIN auth.users u ON u.id = up.user_id
   WHERE up.org_id = v_org
     AND (v_search IS NULL OR u.email ILIKE '%' || v_search || '%');

  SELECT coalesce(jsonb_agg(s.p ORDER BY s.ord), '[]'::jsonb)
    INTO v_people
    FROM (
      SELECT jsonb_build_object(
               'profileId',    up.id,
               'email',        u.email,
               'orgRole',      up.role,
               'companyAdmin', (up.role = 'admin'),
               'active',       up.active,
               'invitedPending', (u.last_sign_in_at IS NULL),
               'grants',       coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'nodeId',   gn.id,
                          'nodeName', gn.name,
                          'role',     pg.role)
                        ORDER BY gn.path, pg.role)
                   FROM profile_grants pg
                   JOIN nodes gn ON gn.id = pg.node_id
                  WHERE pg.profile_id = up.id
                    AND pg.org_id     = v_org
                    AND gn.org_id     = v_org
                    AND gn.path <@ v_path
               ), '[]'::jsonb)
             ) AS p,
             row_number() OVER (ORDER BY u.email COLLATE "C", up.id) AS ord
        FROM user_profiles up
        LEFT JOIN auth.users u ON u.id = up.user_id
       WHERE up.org_id = v_org
         AND (v_search IS NULL OR u.email ILIKE '%' || v_search || '%')
       ORDER BY u.email COLLATE "C", up.id
       LIMIT CASE WHEN p_limit IS NULL THEN NULL ELSE greatest(p_limit, 0) END
    ) s;

  RETURN jsonb_build_object(
    'nodeId',   p_node_id,
    'nodeName', v_name,
    'total',    v_total,
    'returned', jsonb_array_length(v_people),
    'people',   v_people
  );
END $$;

comment on function site_people(uuid, text, integer) is
  'Everyone in the company matching p_search (email ILIKE, NULL = no filter), each with the grants they hold inside this node''s subtree, an invitedPending flag, and an active flag (false = deactivated, migration 0076). Refuses unless the caller administers p_node_id. p_limit caps the rows returned; the payload carries total (matches before the limit) and returned so a cap is never silent. Both new args default to NULL, so a p_node_id-only call is the unbounded answer 0021 gave. LEFT JOIN on auth.users so a profile whose auth row is missing still appears, with a null email and invitedPending true.';

-- ----------------------------------------------------------------------------
-- 5. Grants. REVOKE FROM PUBLIC first (PostgreSQL grants EXECUTE to PUBLIC by
--    default on a new function), then grant to authenticated only, guarded so
--    the block is a no-op where those roles do not exist (bare psql bootstrap),
--    exactly as 0021 §6 and 0064 do. site_people keeps the grants 0064 set
--    (create or replace preserves them, D93); only the NEW function needs a
--    grant block.
-- ----------------------------------------------------------------------------
revoke execute on function set_profile_active(uuid, boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_profile_active(uuid, boolean) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function set_profile_active(uuid, boolean) from anon';
  end if;
end $$;
