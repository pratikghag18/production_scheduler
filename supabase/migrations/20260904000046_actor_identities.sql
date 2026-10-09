-- ===========================================================================
-- 0046 - THE ACTIVITY SCREEN CAN NAME A PERSON.
--
-- THE DECISION. The maintainer, on the new /admin audit log: *"the who needs
-- to show a user, it is currently not that helpful."*
--
-- WHAT IT SHOWS TODAY, AND WHY. `audit_log.actor_id` is `auth.uid()`. The only
-- thing the client can join it against is `user_profiles`, whose columns are
-- `id, org_id, user_id, role, default_create_mode, created_at, updated_at` --
-- NO NAME AND NO ADDRESS. So `describeActor` renders `You`, `System`, or
-- `Supervisor - 0000b2`: a role and six characters of a uuid. That is the
-- honest maximum of what the database could tell it.
--
-- ⭐ THE ONLY IDENTITY THIS SYSTEM STORES IS AN EMAIL, and it lives in
-- `auth.users`, which PostgREST does not expose (and should not - it is
-- GoTrue's table, carrying password hashes and recovery tokens). One existing
-- function reaches it: `site_people` (0021), which is keyed by a NODE and
-- returns a PROFILE id rather than a user id, so it cannot answer "who is
-- auth.uid() X" even indirectly. Hence a second, narrower door.
--
-- ⛔⛔ THE GATE IS THE WHOLE FILE, AND IT IS COPIED FROM THE POLICY ON THE
-- TABLE THIS SERVES. `audit_log_select` (0008) is
--
--     app_is_admin() and org_id = app_current_org()
--
-- and this function is those same two predicates and nothing else:
--
--   * `app_is_admin()` -- `user_profiles.role = 'admin'` for the CALLER'S OWN
--     profile (0018), the ORG-WIDE role. A SITE admin carries org-wide
--     `viewer` plus an admin GRANT, so this is FALSE for them. They read zero
--     audit rows; they must read zero addresses. Checked FIRST and by raising,
--     so a refusal cannot be mistaken for an empty company.
--   * `org_id = app_current_org()` -- the tenant boundary. `auth.users` has no
--     org column of its own, so this join is the ONLY thing standing between
--     one company's admin and another company's address book. It is computed
--     from the caller's own profile, never passed in.
--
-- ⭐ AND THE FUNCTION TAKES NO ARGUMENTS AT ALL. That is deliberate and it is
-- half the safety argument: there is no parameter to poison, no node id to
-- widen, no org to name. Everything about WHO is asking is read from the
-- caller's session, so the only way to see another org's people is to be
-- another org's admin.
--
-- ⚠️ WHY SECURITY DEFINER AT ALL, given the gate duplicates a policy. Because
-- `auth.users` is not readable by `authenticated` under any policy - there is
-- nothing to duplicate on that side. The definer's rights are used for exactly
-- one thing, the email lookup, and the row set is decided entirely by the two
-- predicates above. `site_people` reaches auth.users the same way, under the
-- same discipline: pinned `search_path`, revoked from PUBLIC and from `anon`.
--
-- ⚠️ NO NEW TABLE, NO NEW COLUMN, NO NEW POLICY, NO TRIGGER, NO DATA CHANGE.
-- It transforms nothing, so it needs no row in verify-db.sh's UPGRADE_CHECKS
-- and no `upgrade_0046_*.sql` -- stated here so the absence is a decision on
-- the record, exactly as 0021 and 0037 did.
--
-- ---------------------------------------------------------------------------
-- WHY EMAIL, AND HOW A REAL NAME SLOTS IN LATER WITHOUT A CLIENT REWRITE.
--
-- Email is not the identity anybody would choose; it is the only one that
-- EXISTS. There is nowhere in this schema to store a person's name -- that is a
-- schema question, raised with the maintainer separately and deliberately not
-- invented here.
--
-- ⭐ SO THE SHAPE IS BUILT FOR THE ANSWER THAT IS COMING. The client contract is
-- `user_id -> an identity OBJECT`, not `user_id -> a string`: a
-- `display_name text` column added to `user_profiles` later becomes one more
-- SELECT expression here and one more optional field on `ActorIdentity`, with
-- no change to `fetchActorIdentities()`'s signature, no change to the Map it
-- returns, and no change to any caller that already reads `.email`. Had this
-- returned a bare `Map<string, string>` of addresses, every caller would have
-- had to be rewritten the day a name arrived.
--
-- ⚠️ THE ROLE TRAVELS WITH IT for the same reason. The screen already falls
-- back to the role when it cannot name somebody, and it must keep being able to
-- when `email` is NULL (below). Returning identity and role from one call also
-- means the two can never disagree about who is in the org, which two separate
-- reads a page apart could.
--
-- ⚠️ `email` IS NULLABLE, AND THAT IS THE INTERESTING HALF. `auth.users.email`
-- has no NOT NULL constraint -- a phone-only signup has no address -- and a
-- person whose address is unknown must still be LISTED, carrying their role.
-- Filtering them out, which is the obvious tidying-up, would be worse than
-- saying nothing: a missing key in the client's map is indistinguishable from
-- an actor who is not in this company at all, so the row would fall quietly
-- back to "Supervisor - 0000b2" for somebody the server could perfectly well
-- place. `69_actor_identities_test.sql` E6 pins it, measured red against that
-- exact filter.
--
-- The join is LEFT for the same instinct, but be honest about it: it is
-- DEFENSIVE, not load-bearing. `user_profiles.user_id` is NOT NULL with an FK
-- to `auth.users` ON DELETE CASCADE, so a profile with no auth row cannot exist
-- on this schema and an INNER join would behave identically today. It is LEFT
-- because `site_people` is, and because the day that FK is loosened this should
-- keep listing the person rather than silently shrinking the company.
--
-- ⚠️ NOT RETYPED. `app_is_admin()` and `app_current_org()` are called, not
-- reimplemented, and the email lookup is `site_people`'s own
-- `LEFT JOIN auth.users u ON u.id = up.user_id`, extracted with
-- `pg_get_functiondef` from the live database (CLAUDE.md s4).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- s1. Who is in my company, and what is each of them called.
--
-- ⛔ THE ORDER OF THE TWO CHECKS MATTERS. The permission test comes first and
-- RAISES; the org filter is then a WHERE on rows the caller is already entitled
-- to. Written the other way round -- gate folded into the WHERE -- a non-admin
-- would get an empty table, and an empty table is exactly what a broken
-- function returns, so no test could tell the gate from the bug. A typed
-- refusal is an observation; silence is not.
--
-- It raises rather than returning empty even though `fetchAuditPage` beside it
-- returns empty to the same caller: that read is a POLICY doing its ordinary
-- work on a table, this is a FUNCTION handing out addresses, and the louder
-- failure is the right one for the disclosure.
-- ---------------------------------------------------------------------------
create or replace function audit_actor_identities()
returns table (user_id uuid, role text, email text)
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
BEGIN
  -- The left conjunct of `audit_log_select`, asked verbatim. A site admin
  -- (org-wide `viewer` + an admin GRANT) fails this, which is the point.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted',
      'only a company admin may see who made a change',
      jsonb_build_object('reason', 'not_company_admin'));
  END IF;

  RETURN QUERY
    SELECT up.user_id, up.role, u.email::text
      FROM user_profiles up
      -- LEFT, not INNER: a person with no address is still a person. See the
      -- header.
      LEFT JOIN auth.users u ON u.id = up.user_id
      -- The right conjunct. The ONLY tenant boundary on `auth.users`, which
      -- carries no org of its own.
     WHERE up.org_id = app_current_org();
END $fn$;

comment on function audit_actor_identities() is
  'R-329: for the caller''s own org, each profile''s auth.uid(), org-wide role '
  'and email -- the read that lets the Activity screen name the person behind '
  'an audit_log.actor_id. Gated on exactly audit_log_select''s own predicate: '
  'app_is_admin() (raises not_permitted otherwise, so a refusal is never '
  'mistaken for an empty company) AND org_id = app_current_org(). Takes no '
  'arguments, so there is nothing a caller can widen. SECURITY DEFINER only '
  'because auth.users is not readable under any policy; email is NULL-able and '
  'the join is LEFT, so a person without an address is still listed with their '
  'role. A display_name column added later is one more SELECT expression here '
  'and one more optional field on the client''s ActorIdentity.';

-- ---------------------------------------------------------------------------
-- s2. Grants. REVOKE FROM PUBLIC FIRST, every time -- PostgreSQL grants EXECUTE
-- on a new function to PUBLIC by default (api.md s6.2, 0020 s8.0, 0021 s6), and
-- on a SECURITY DEFINER function that reads auth.users that default is the
-- whole vulnerability. `anon` is revoked explicitly as well: a signed-out
-- visitor has no profile, so `app_is_admin()` would refuse them anyway, but the
-- grant should not depend on a second function being correct.
--
-- The role guard exists because this file runs against the test harness (which
-- creates `authenticated`) AND a real project (which has it) AND neither during
-- a bare psql bootstrap.
-- ---------------------------------------------------------------------------
revoke execute on function audit_actor_identities() from public;

do $grants$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function audit_actor_identities() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function audit_actor_identities() from anon';
  end if;
end $grants$;
