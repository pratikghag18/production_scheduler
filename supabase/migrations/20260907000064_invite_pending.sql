-- ============================================================================
-- 0064 --- site_people CARRIES "invited, not yet signed in".
--
-- Wave 3 lane A (P1-6c, S24). Invitations give the Access panel its first row
-- for a person who has been asked to join but has never signed in: GoTrue sets
-- `auth.users.last_sign_in_at` to NULL until the first sign-in, and clears the
-- NULL the moment they set their password and land. The panel needs to mark
-- that person "invited" so an admin knows the grant is real but the person is
-- not in yet.
--
-- ⭐ ONE FIELD, ON THE ROW site_people ALREADY BUILDS. The function already
-- LEFT JOINs `auth.users` for the email (0021 §3), so `u.last_sign_in_at` is in
-- scope with no new join; `invitedPending` is `(u.last_sign_in_at IS NULL)`,
-- carried beside `companyAdmin` in the same jsonb_build_object. A profile whose
-- auth row is missing (the LEFT JOIN's null side) reads `invitedPending = true`
-- as well, which is the safe direction: a person with no auth row has certainly
-- not signed in, and the mark is the same "not really here yet" the field means.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md §4). The body below was SLICED out of
-- 0060 --- the last re-emit of site_people --- by a script
-- (`create or replace function site_people(p_node_id uuid,` through the closing
-- `END $$;`), and the node-exists guard, the admin-for guard, the org-scoped
-- grant subquery, the `email ILIKE` filter, the `COLLATE "C"` order, the total
-- and the `LIMIT` were asserted present on the assembled text before this file
-- was written. The single addition is the `invitedPending` line; 0060 §2's
-- search/limit/total contract is unchanged, so 83's X55-X58 keep passing and
-- 48's cases are untouched.
--
-- ⚠️ A RE-EMIT WITH THE SAME SIGNATURE, so `create or replace` is enough --- no
-- `drop` first (that was 0060's need, when the signature widened from
-- `site_people(uuid)` to three args). The grants block is repeated because a
-- `create or replace` keeps the existing EXECUTE grants, but re-stating them
-- costs nothing and keeps this file legible against a bare `psql` bootstrap.
--
-- Verified by `supabase/tests/86_invite_test.sql`.
-- ============================================================================
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
  'Everyone in the company matching p_search (email ILIKE, NULL = no filter), each with the grants they hold inside this node''s subtree and an invitedPending flag --- true until their first sign-in (auth.users.last_sign_in_at IS NULL), or when their auth row is absent (0021 sec.3, bounded by 0060 sec.2, invited flag by 0064). Refuses unless the caller administers p_node_id. p_limit caps the rows returned; the payload carries total (matches before the limit) and returned so a cap is never silent. Both new args default to NULL, so a p_node_id-only call is the unbounded answer 0021 gave. LEFT JOIN on auth.users so a profile whose auth row is missing still appears, with a null email and invitedPending true.';

revoke execute on function site_people(uuid, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function site_people(uuid, text, integer) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function site_people(uuid, text, integer) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- THE invite EDGE FUNCTION'S TWO SERVICE-ROLE WRITES.
--
-- ⭐ THE GAP, MEASURED ON THE RUNNING STACK. This project has never had a
-- server-side writer, so its migrations grant DML only to `authenticated` and
-- `anon`; `service_role` was left with the bare `Dxt` (TRUNCATE/REFERENCES/
-- TRIGGER) it gets by default and NO insert/select/update/delete on any table.
-- The invite function (P1-6c) is the first thing to write AS the service role:
-- it creates the invited person's `user_profiles` row (the one write a site
-- admin's own grants cannot make --- `user_profiles_insert` is company-admin
-- only), reads it and the resulting grant back, and deletes the profile again
-- if `set_site_member` refuses. Without these grants that insert fails with
-- `42501 permission denied for table user_profiles`, which is exactly what a
-- first end-to-end call returned.
--
-- ⚠️ SCOPED TO THE TWO TABLES THE FUNCTION TOUCHES, AND NO MORE. `service_role`
-- already BYPASSes RLS, so a table grant is the whole gate for it; this hands it
-- INSERT/SELECT/DELETE on `user_profiles` (create, read-back, rollback) and
-- SELECT on `profile_grants` (read-back the grant before answering ok). It is
-- NOT `GRANT ALL ... TO service_role`, which is the platform default a stock
-- Supabase project ships and which this repo deliberately never adopted: the
-- widening stops at what the invite flow needs. UPDATE is not granted --- the
-- function never updates a profile, only inserts or deletes one.
--
-- The service key is server-only (the Edge Function's env, never a browser), so
-- this widens nothing a client can reach.
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, delete on user_profiles to service_role';
    execute 'grant select on profile_grants to service_role';
  end if;
end $$;
