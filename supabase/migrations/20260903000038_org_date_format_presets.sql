-- ============================================================================
-- 20260903000038_org_date_format_presets.sql
--
-- Widens the accepted date-format token set from four to eight. 0037 shipped
-- d_mon_yyyy / dmy_slash / mdy_slash / iso; the maintainer asked for a handful
-- more presets (dmy_dash_mon, d_month_yyyy, month_d_yyyy, ymd_slash), which the
-- client already maps in `src/lib/format/dates.ts`.
--
-- ⭐ THE ONLY CHANGE IS THE `IN (...)` LIST. `create or replace function` keeps
-- the same signature, so the RPC's generated type is unchanged. Everything else
-- is 0037 verbatim: security invoker, the app_is_admin pre-check, the `||`
-- shallow merge, the read-back, and the revoke/grant block. It adds no column,
-- table, policy or trigger and transforms no data, so it needs NO row in
-- verify-db.sh's UPGRADE_CHECKS and no `upgrade_0038_*.sql` -- stated here so the
-- absence is a decision on the record, as 0037 and 0021 did.
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

  IF p_format IS NULL OR p_format NOT IN (
       'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
       'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash'
     ) THEN
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
  'Set the org-wide date-display format in orgs.settings.date_format (0037, token set widened in 0038). One of d_mon_yyyy / dmy_slash / mdy_slash / iso / dmy_dash_mon / d_month_yyyy / month_d_yyyy / ymd_slash; anything else is invalid_argument. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update (api.md §4). Merges the one key with || so the rest of the settings bag survives; returns the stored settings, not an echo.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time -- PostgreSQL grants EXECUTE on
-- a new (or replaced) function to PUBLIC by default (api.md §6.2, 0021 §6). The
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
