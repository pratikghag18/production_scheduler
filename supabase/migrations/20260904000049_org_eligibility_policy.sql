-- ============================================================================
-- 20260904000049_org_eligibility_policy.sql
--
-- "A way to CHOOSE warn or block for eligibility." — the queue item, measured
-- 4 Sept and found to be almost entirely built already. The ENFORCEMENT has
-- shipped on both sides for a long time: `assignments` carries
-- `eligibility_override` / `override_reason`, `CreatePopover` computes
-- `blocked` and `needsOverride` and will not let Create fire without a typed
-- reason, and the server reads `orgs.settings->>'eligibility_policy'` in
-- `create_assignment`, `move_run`, `apply_split_coverage` and their 0043/0044
-- successors. 0001 even CHECKs the value into ('warn','block').
--
-- ⭐ WHAT WAS MISSING WAS THE SWITCH. `orgs.settings` has had exactly ONE write
-- function in its life -- `set_org_date_format` (0037, widened by 0038) -- so
-- `eligibility_policy` could not be changed from the app AT ALL. Every org has
-- been sitting on 0001's default of 'warn' unless somebody opened Studio and
-- edited jsonb by hand. This migration adds the second write function that bag
-- has ever had, and nothing else.
--
-- ⭐ IT ADDS NO COLUMN, NO TABLE, NO POLICY AND NO TRIGGER, exactly as 0037 did
-- and for the same reason: the store already exists. It transforms no existing
-- data, so it needs NO row in verify-db.sh's UPGRADE_CHECKS and no
-- `upgrade_0049_*.sql` -- stated here so the absence is a decision on the
-- record, as 0037, 0038 and 0021 each did.
--
-- ----------------------------------------------------------------------------
-- WHY AN RPC AND NOT A PLAIN POSTGREST UPDATE. 0037'S ARGUMENT, VERBATIM.
--
-- `orgs_update` (0008) is `app_is_admin() and id = app_current_org()`. A
-- non-admin UPDATE is therefore filtered to ZERO ROWS by RLS and raises
-- NOTHING -- the silent zero-row write api.md §4 names as the reason a write
-- gets an RPC, and CLAUDE.md §4's "a write that reports success can have
-- changed nothing". A settings screen wired straight to PostgREST would show a
-- supervisor their choice "saving" and then reverting on the next read, with no
-- explanation offered. The pre-check below turns that silence into a typed
-- refusal. `supabase/tests/72_eligibility_policy_test.sql` case X8 drives that
-- plain UPDATE as a supervisor and pins that it raises nothing and changes
-- nothing, beside X7 which pins that this function does say no.
--
-- SECURITY **INVOKER**, on purpose and for 0021 §4's reason: the 0008 policy is
-- the real gate and this function must not be able to write a row the policy
-- would refuse. The `app_is_admin()` pre-check exists to SHAPE the refusal, not
-- to authorise anything -- if the two ever disagreed, RLS wins. There is no
-- post-write outcome check, deliberately and for 0037's reason: once the
-- pre-check has established `app_is_admin()`, the UPDATE's USING and WITH CHECK
-- clauses are that identical predicate, so the write cannot be the thing that
-- quietly does nothing. The row is still read back, because the honest thing to
-- return is what is stored, not an echo.
--
-- ----------------------------------------------------------------------------
-- ⚠️ WHY THIS FUNCTION VALIDATES A VALUE THE TABLE ALREADY CHECKS.
--
-- 0001 carries `check (settings->>'eligibility_policy' in ('warn','block'))`, so
-- a junk value cannot reach the row either way. But the CHECK's refusal arrives
-- as SQLSTATE 23514, "new row violates check constraint orgs_settings_check" --
-- true, unreadable, and carrying no `field` for the client to point at. It is
-- also a whole-row constraint, so it would say the same thing about a bad
-- `date_format` or a bad `week_start`. The explicit IN test below is what makes
-- the refusal a typed `invalid_argument`/PT400 naming `eligibility_policy`,
-- which is what `toSchedulerError` and `describeSchedulerError` turn into a
-- sentence on the Settings screen. Case X4 asserts the SQLSTATE, not just the
-- word, so a regression to "let the CHECK handle it" goes red.
--
-- ⚠️ `||` IS A SHALLOW MERGE, which is exactly right for this FLAT bag: it
-- replaces `eligibility_policy` and leaves capacity_cap / week_start /
-- default_snap_minutes / date_format untouched. `jsonb_set` would need the key
-- to pre-exist; `||` inserts or replaces. **A settings bag written whole is a
-- settings bag that loses a key** -- and the loss would surface weeks later as
-- a capacity cap that reverted to its coded default, with nothing to connect it
-- to the eligibility switch somebody flipped. Case X6 compares the ENTIRE bag
-- before and after with `- 'eligibility_policy'` on both sides, so it notices
-- any sibling that moved, including one added after this file was written.
--
-- ----------------------------------------------------------------------------
-- WHAT THE TWO VALUES MEAN, since the Settings screen has to say it in words:
--
--   warn  -- an untrained person CAN still be scheduled, but only if the
--            planner ticks the override and types a reason; the reason is
--            stored on the assignment (`override_reason`) and shows in Activity.
--   block -- the server refuses the assignment outright. There is no override
--            and no reason that gets past it; the placement simply cannot be
--            made until the training is on record.
--
-- The default is 'warn' (0001, design plan §6, R-014).
-- ----------------------------------------------------------------------------
create or replace function set_org_eligibility_policy(p_policy text) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_settings jsonb;
BEGIN
  -- Permission first: a non-admin never learns anything about the value, and
  -- the refusal is the same whether the policy was legal or not.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system admin may change site settings',
                      jsonb_build_object('reason', 'not_admin'));
  END IF;

  IF p_policy IS NULL OR p_policy NOT IN ('warn', 'block') THEN
    PERFORM api_raise('invalid_argument', 'unknown eligibility policy',
                      jsonb_build_object('field', 'eligibility_policy', 'value', p_policy));
  END IF;

  UPDATE orgs
     SET settings = settings || jsonb_build_object('eligibility_policy', p_policy)
   WHERE id = app_current_org();

  SELECT settings INTO v_settings FROM orgs WHERE id = app_current_org();
  RETURN v_settings;
END $$;

comment on function set_org_eligibility_policy(text) is
  'Set the org-wide eligibility policy in orgs.settings.eligibility_policy (0049). Either warn (an ineligible placement is allowed with a ticked override and a stored reason) or block (the server refuses it outright, with no override); anything else is invalid_argument naming the field, rather than 0001''s whole-row CHECK raising an unreadable 23514. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update (api.md §4). Merges the one key with || so the rest of the settings bag survives; returns the stored settings, not an echo.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time -- PostgreSQL grants EXECUTE on
-- a new function to PUBLIC by default (api.md §6.2, 0020 §8.0, 0021 §6). The
-- role guard exists because this file runs against the test harness (which
-- creates `authenticated`) AND a real project (which has it) AND neither during
-- a bare psql bootstrap.
-- ----------------------------------------------------------------------------
revoke execute on function set_org_eligibility_policy(text) from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_org_eligibility_policy(text) to authenticated';
  end if;
end $$;
