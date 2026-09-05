-- ===========================================================================
-- 0047 - A PERSON HAS A NAME.
--
-- THE DECISION. The maintainer, one line, on the day after 0046 shipped:
-- *"add display_name to user_profiles too."*
--
-- WHAT 0046 LEFT OPEN, AND IT SAID SO IN ITS OWN HEADER. `user_profiles` was
-- `id, org_id, user_id, role, default_create_mode, created_at, updated_at` --
-- no name, anywhere in this schema, for the people who use the product. The
-- only identity that EXISTED was `auth.users.email`, so the Activity screen's
-- Who column reads `marco@example.test`, which is unambiguous and is not what
-- anybody calls a colleague. 0046 anticipated this file explicitly: *"a
-- `display_name text` column added to `user_profiles` later becomes one more
-- SELECT expression here and one more optional field on `ActorIdentity`."*
-- That is exactly what this is, and nothing more.
--
-- ⚠️⚠️ NOTHING WRITES THIS COLUMN, AND THAT IS DELIBERATE, NOT UNFINISHED.
-- `user_profiles_update` (0008) is `app_is_admin() AND org_id =
-- app_current_org()`, so under the policy as it stands a COMPANY ADMIN could
-- set anybody's name and NOBODY -- not even an admin -- could set their own by
-- any other route, because the policy names no `user_id = auth.uid()` arm.
-- Widening a write policy so a person can name themselves is a decision about
-- who owns an identity in this product; it is the maintainer's, it was not
-- asked for in the sentence above, and this file does not take it. The column
-- lands, the read carries it, and every row is NULL until somebody decides how
-- it is filled.
--
-- ⭐ IT IS ALREADY READABLE BY THE RIGHT PEOPLE AND BY NOBODY ELSE, with no
-- policy work at all. RLS is row-level: `user_profiles_select` is
-- `user_id = auth.uid() OR (app_is_admin() AND org_id = app_current_org())`,
-- so a person can read their own name and a company admin can read their own
-- company's. A new column on an existing table inherits that; adding one is not
-- a disclosure decision the way `audit_actor_identities()` was, which is why
-- the interesting half of this file is s2 and not s1.
--
-- ⚠️ NULLABLE, AND EXPECTED TO BE NULL ON ALMOST EVERY ROW FOR A LONG TIME.
-- There is nothing to backfill FROM: the local part of an email address is a
-- guess at a name, not a name, and a screen that showed `marco` where a person
-- expected `Marco Rossi` would be the app inventing an identity for somebody.
-- So no default, no backfill, and therefore no row in verify-db.sh's
-- UPGRADE_CHECKS and no `upgrade_0047_*.sql` -- those exist for migrations that
-- TRANSFORM existing data, and this one changes not a single row. Said out loud
-- so the absence is a decision on the record, exactly as 0021, 0037 and 0046
-- did.
--
-- ⚠️ NO CHECK CONSTRAINT ON THE TEXT, and that is also a decision. The
-- tempting one is `display_name IS NULL OR btrim(display_name) <> ''`, and the
-- reason not to is that it pre-decides an editor nobody has designed: the
-- obvious way a form clears a name is to send the empty string, and a
-- constraint would turn "clear my name" into a 400 rather than a clear. The
-- blank IS handled -- `parseActorIdentity` normalises a blank to NULL, so the
-- screen falls through to the address rather than rendering an empty Who cell
-- -- which is the same place the guard already normalises a blank address.
--
-- ---------------------------------------------------------------------------
-- ⛔⛔ THE FUNCTION IS REWRITTEN AND THE REWRITE IS THE ONLY RISK IN THIS FILE.
-- `audit_actor_identities()` hands out email addresses; its body was EXTRACTED
-- with `pg_get_functiondef` from the live database (CLAUDE.md s4, "extract,
-- never retype") and the ONLY differences are the fourth column in the
-- signature and the fourth expression in the SELECT. In particular, unchanged
-- and character for character:
--
--   * the `IF NOT app_is_admin() THEN ... api_raise('not_permitted', ...)`
--     gate, still FIRST and still RAISING, so a refusal cannot be mistaken for
--     an empty company;
--   * `WHERE up.org_id = app_current_org()` -- the ONLY tenant boundary on
--     `auth.users`, which carries no org column of its own;
--   * `LEFT JOIN auth.users`, the pinned `search_path`, `STABLE`,
--     `SECURITY DEFINER`, and the fact that the function takes NO ARGUMENTS.
--
-- `69_actor_identities_test.sql` re-runs E1-E8 against the rewritten function
-- -- both positive org cases, both typed refusals, both leak checks -- and adds
-- E11, which asks the boundary question again about the new column, because a
-- name crossing a tenant line is a leak like any other and a friendlier-reading
-- one than an address.
--
-- ⚠️ WHY THE NAME TRAVELS WITH THE ROLE AND THE ADDRESS RATHER THAN IN A
-- SECOND CALL. The same reason 0046 gave for the role: one read cannot
-- disagree with itself about who is in the company, and the client's map
-- already holds an OBJECT per account precisely so this column could be added
-- without any caller changing shape.
--
-- ⚠️ AND `display_name` IS SELECTED BEFORE `email` IN NEITHER SENSE THAT
-- MATTERS -- the column ORDER here is cosmetic; the PRECEDENCE (name beats
-- address beats role) lives in `describeActor`, in one place, where the screen
-- can be argued with.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- s1. The column.
--
-- Plain `text`, nullable, no default. `ADD COLUMN` with no default is a
-- catalogue-only change in PostgreSQL 11+ -- no table rewrite, no lock held
-- while rows are touched, because there are no rows to touch.
-- ---------------------------------------------------------------------------
alter table user_profiles
  add column if not exists display_name text;

comment on column user_profiles.display_name is
  'R-330: what this person is called, for the screens that name them -- the '
  'first and only place in this schema a USER''s name is stored (operators have '
  'their own, unrelated, `operators.display_name`). NULLABLE and NULL on every '
  'row until something writes it: there is nothing to backfill from, and the '
  'local part of an email address is a guess at a name rather than a name. '
  'Read by `audit_actor_identities()` (0047) for the Activity screen''s Who '
  'column, and readable under `user_profiles_select` by the person themselves '
  'and by their company admin. ⚠️ NOTHING WRITES IT YET: `user_profiles_update` '
  'is `app_is_admin() AND org_id = app_current_org()`, which lets an admin name '
  'anyone and lets nobody name themselves -- an asymmetry left for the '
  'maintainer to decide rather than resolved by widening a policy here.';

-- ---------------------------------------------------------------------------
-- s2. The read, extended by exactly one column.
--
-- ⛔ EXTRACTED FROM THE LIVE DATABASE, NOT RETYPED. Everything below except
-- `up.display_name` in the signature and in the SELECT is 0046's body as
-- `pg_get_functiondef` returned it, comments included. The gate and the org
-- filter are a security boundary; the way they survive a change like this is by
-- not being written a second time from memory.
--
-- ⚠️ `create or replace function` CANNOT CHANGE A RETURNS TABLE. PostgreSQL
-- refuses with "cannot change return type of existing function", so the drop is
-- not tidiness -- it is the only way to add the column. `drop ... if exists`
-- keeps this file re-runnable, and the GRANTs in s3 are re-issued below because
-- a dropped function takes its privileges with it (which is also why the REVOKE
-- FROM PUBLIC has to happen again, not merely once in 0046).
-- ---------------------------------------------------------------------------
drop function if exists audit_actor_identities();

create or replace function audit_actor_identities()
returns table (user_id uuid, role text, email text, display_name text)
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
    SELECT up.user_id, up.role, u.email::text, up.display_name
      FROM user_profiles up
      -- LEFT, not INNER: a person with no address is still a person. See the
      -- header.
      LEFT JOIN auth.users u ON u.id = up.user_id
      -- The right conjunct. The ONLY tenant boundary on `auth.users`, which
      -- carries no org of its own.
     WHERE up.org_id = app_current_org();
END $fn$;

comment on function audit_actor_identities() is
  'R-329/R-330: for the caller''s own org, each profile''s auth.uid(), org-wide '
  'role, email and display_name -- the read that lets the Activity screen name '
  'the person behind an audit_log.actor_id. Gated on exactly audit_log_select''s '
  'own predicate: app_is_admin() (raises not_permitted otherwise, so a refusal '
  'is never mistaken for an empty company) AND org_id = app_current_org(). '
  'Takes no arguments, so there is nothing a caller can widen. SECURITY DEFINER '
  'only because auth.users is not readable under any policy. BOTH identity '
  'columns are NULL-able and the join is LEFT: a person with no address and no '
  'name is still listed with their role, because a missing row in the client''s '
  'map cannot be told from an actor who is not in this company. The client '
  'prefers the name, falls back to the address, then to role-and-tail '
  '(describeActor).';

-- ---------------------------------------------------------------------------
-- s3. Grants, re-issued because s2 DROPPED the function and privileges do not
-- survive a drop.
--
-- ⛔ REVOKE FROM PUBLIC FIRST, every time -- PostgreSQL grants EXECUTE on a NEW
-- function to PUBLIC by default (api.md s6.2, 0020 s8.0, 0021 s6, 0046 s2), and
-- a re-created function is a new one as far as that default is concerned. On a
-- SECURITY DEFINER function that reads auth.users that default is the whole
-- vulnerability, and 69's E8 is what notices if this block is ever forgotten.
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
