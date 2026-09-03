-- ============================================================================
-- 20260903000037_org_date_format.sql
--
-- "A system admin picks one date-display format for the whole company, and
--  every date the app shows as text reads that way." — settled Sep 3, an
--  org-wide setting the maintainer asked for over per-site (a plant is a root
--  `nodes` row; per-site would need node-scoped settings and nearest-ancestor
--  resolution, which per-site timezone (D88) reserves for Phase 2 and this does
--  not touch).
--
-- ⭐ IT ADDS NO COLUMN, NO TABLE, NO POLICY AND NO TRIGGER. The store already
-- exists: `orgs.settings jsonb` (0001), the same bag that carries
-- `capacity_cap` and `eligibility_policy`. This migration only adds the ONE
-- write function that bag has never had. It transforms no existing data, so it
-- needs NO row in verify-db.sh's UPGRADE_CHECKS and no `upgrade_0037_*.sql` --
-- stated here so the absence is a decision on the record, exactly as 0021 did.
--
-- ----------------------------------------------------------------------------
-- WHY AN RPC AND NOT A PLAIN POSTGREST UPDATE.
--
-- `orgs_update` (0008) is `app_is_admin() and id = app_current_org()`. A
-- non-admin UPDATE is therefore filtered to ZERO ROWS by RLS and raises
-- NOTHING -- the silent zero-row write api.md §4 names as the reason a write
-- gets an RPC. A settings screen wired straight to PostgREST would show the
-- non-admin their change "saving" and then reverting on the next read, with no
-- explanation. The pre-check below turns that silence into a typed refusal.
--
-- SECURITY **INVOKER**, on purpose and for 0021 §4's reason: the 0008 policy is
-- the real gate and this function must not be able to write a row the policy
-- would refuse. The `app_is_admin()` pre-check exists to SHAPE the refusal, not
-- to authorise anything -- if the two ever disagreed, RLS wins. There is no
-- post-write outcome check, and that is deliberate the same way set_site_member
-- records: once the pre-check has established `app_is_admin()`, the UPDATE's
-- USING and WITH CHECK clauses are that identical predicate, so the write
-- cannot be the thing that quietly does nothing. The row is still read back,
-- because the honest thing to return is what is stored, not an echo.
--
-- ----------------------------------------------------------------------------
-- WHY A CLOSED ENUM AND NOT A FREE-FORM PATTERN.
--
-- The client maps a token to a formatter (`src/lib/format/dates.ts`), so the
-- set of legal values is fixed and small. Validating it here means a garbage
-- value never reaches the bag, and `coerceDateFormat` on the read side is the
-- second belt: an unknown token falls back to the default rather than showing a
-- raw date. The four tokens are the client's `DateFormat` union, verbatim.
--
-- ⚠️ `||` IS A SHALLOW MERGE, which is exactly right for this FLAT bag: it
-- replaces `date_format` and leaves capacity_cap / eligibility_policy /
-- week_start / default_snap_minutes untouched. `jsonb_set` would need the key
-- to pre-exist; `||` inserts or replaces. Case X1 pins that the siblings
-- survive.
-- ----------------------------------------------------------------------------
create or replace function set_org_date_format(p_format text) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_settings jsonb;
BEGIN
  -- Permission first: a non-admin never learns anything about the value, and
  -- the refusal is the same whether the format was legal or not.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system admin may change site settings',
                      jsonb_build_object('reason', 'not_admin'));
  END IF;

  IF p_format IS NULL OR p_format NOT IN ('d_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso') THEN
    PERFORM api_raise('invalid_argument', 'unknown date format',
                      jsonb_build_object('field', 'date_format', 'value', p_format));
  END IF;

  UPDATE orgs
     SET settings = settings || jsonb_build_object('date_format', p_format)
   WHERE id = app_current_org();

  SELECT settings INTO v_settings FROM orgs WHERE id = app_current_org();
  RETURN v_settings;
END $$;

comment on function set_org_date_format(text) is
  'Set the org-wide date-display format in orgs.settings.date_format (0037). One of d_mon_yyyy / dmy_slash / mdy_slash / iso; anything else is invalid_argument. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update (api.md §4). Merges the one key with || so the rest of the settings bag survives; returns the stored settings, not an echo.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time -- PostgreSQL grants EXECUTE on
-- a new function to PUBLIC by default (api.md §6.2, 0020 §8.0, 0021 §6). The
-- role guard exists because this file runs against the test harness (which
-- creates `authenticated`) AND a real project (which has it) AND neither during
-- a bare psql bootstrap.
-- ----------------------------------------------------------------------------
revoke execute on function set_org_date_format(text) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_org_date_format(text) to authenticated';
  end if;
end $$;
