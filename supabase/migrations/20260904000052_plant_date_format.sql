-- ============================================================================
-- Migration 0052: the SECOND key -- the date format is a plant's answer too.
--
-- The maintainer, session 62: "There is a filter at the top for selecting
-- plants. Once we select the plant at the top we should be able to assign the
-- settings to that particular plant, and it should be all types of settings on
-- the settings tab, not just this one."
--
-- Implements: R-333. Refs: 0050 (the generic storage, resolver and writers this
-- extends), 0037/0038 (the org-wide date_format and its token set), F-088 (the
-- CHECK that cannot reject a null), R-331.
--
-- ----------------------------------------------------------------------------
-- ⛔ THIS OVERRULES A REASON 0050 PUT ON THE RECORD, AND THE REASON IS LEFT
-- STANDING THERE RATHER THAN EDITED OUT. 0050's header argued date_format was
-- "a READER'S DISPLAY CONVENTION, not a plant's rule ... a plant does not have
-- an opinion about it". The maintainer has decided it does. A migration is a
-- record of what was believed when it ran, so 0050 keeps its sentence and this
-- file carries the correction.
--
-- ----------------------------------------------------------------------------
-- ⭐ 0050 CLAIMED A SECOND KEY WAS "ONE BRANCH IN EACH OF THREE PLACES". IT IS
-- FIVE EDITS IN FOUR PLACES, AND THE MISSING ONE IS THE ONE THAT BITES.
--
--   1. `node_settings_key_check`   -- the KEY constraint. 0050's own header did
--      not count it, and it is the guard that refuses the row outright: without
--      this edit every other change below is dead code, because the INSERT
--      never gets past the table. Measured, not reasoned: the first red run of
--      `73_plant_settings_test.sql` P19 reported the RPC refusing
--      `date_format` as an "unknown setting" and P22 (the control) still green.
--   2. `node_settings_value_check` -- one WHEN, as promised.
--   3. `set_node_setting`'s key list.
--   4. `set_node_setting`'s value CASE -- one WHEN.
--   5. `clear_node_setting`'s key list.
--
-- A THIRD key costs exactly the same five, and the two CHECK constraints must
-- each be DROPPED and RE-ADDED because migrations here are append-only: there
-- is no ALTER CONSTRAINT for a CHECK's expression. That is the honest number to
-- quote next time.
--
-- ----------------------------------------------------------------------------
-- ⚠️ NO SERVER-SIDE READER CHANGES, AND THAT IS THE DIFFERENCE FROM 0050.
-- `eligibility_policy` decides whether a WRITE IS ALLOWED, so 0050 had to move
-- `check_eligibility`, `move_run` and `apply_split_coverage` onto the resolver
-- in the same breath -- one reader left behind is a plant whose safety rule is
-- enforced on some paths and not others. `date_format` decides how a string is
-- RENDERED. Nothing on the server reads it (`grep -rn "date_format"
-- supabase/migrations` finds only 0001's bag, 0037/0038's writer and this
-- file), so there is no such hazard here and no reader to forget.
--
-- ⚠️ AND A SCREEN THAT SPANS PLANTS HAS NO PLANT TO ASK. Activity lists changes
-- from every plant at once, so a per-plant date format has no single answer
-- there; such a screen reads the COMPANY value (`orgs.settings`), which is why
-- 0037/0038's writer and the org bag are untouched by this migration rather
-- than migrated away. Only a screen showing ONE plant resolves that plant's.
--
-- ----------------------------------------------------------------------------
-- ⭐ NO BACKFILL, NO UPGRADE CHECK. This adds no column, table, policy or
-- trigger, transforms no data, and widens two CHECKs rather than narrowing
-- them -- every row already in `node_settings` is an `eligibility_policy` row
-- and satisfies both new expressions. So it needs no row in `verify-db.sh`'s
-- UPGRADE_CHECKS and no `upgrade_0052_*.sql`, stated here so the absence is a
-- decision on the record (0038's and 0037's convention).
--
-- Proved by `supabase/tests/73_plant_settings_test.sql` P18-P22.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE KEY CONSTRAINT. Dropped and re-added, not altered: PostgreSQL has no
-- way to change a CHECK's expression in place, and these migrations are
-- append-only. `if exists` so this file can be applied to a database that
-- somehow reached it without 0050's constraint (the harness builds forward, but
-- a hand-applied file should not die on a name).
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_key_check;
alter table node_settings add constraint node_settings_key_check
  check (key in ('eligibility_policy', 'date_format'));

-- ----------------------------------------------------------------------------
-- 2. THE VALUE CONSTRAINT. Still a CASE with `else false`, so an unknown key
-- can never slip through with an unvalidated value -- widening the key list
-- above without widening this one would have stored anything.
--
-- ⛔ THE `else false` IS WHY THE TWO KEYS CANNOT LEAK INTO EACH OTHER. A shared
-- `value in (...)` over the union of both token sets would accept a date format
-- of 'warn' and an eligibility policy of 'iso'; the CASE asks the question per
-- key. `73_plant_settings_test.sql` P19 picks 'warn' as its junk date format
-- for exactly that reason.
--
-- The eight tokens are `set_org_date_format`'s own list (0037, widened by
-- 0038), extracted rather than retyped -- a ninth preset added there and not
-- here would be a format the company can choose and a plant cannot.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_value_check;
alter table node_settings add constraint node_settings_value_check
  check (case key
           when 'eligibility_policy' then value in ('warn', 'block')
           when 'date_format' then value in (
                'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
                'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash')
           else false
         end);

comment on table node_settings is
  'R-331/R-333: a setting given an answer at ONE place in the structure, overriding the company''s. The row IS the override -- no row means this place inherits, which is why the value column is NOT NULL and clearing is a DELETE rather than a magic value (F-088: a jsonb bag cannot tell "absent" from "set to null", and its CHECK cannot refuse the second). Resolved by app_resolve_node_setting: nearest ancestor-or-self with an answer, else orgs.settings, else the reader''s coded default. Two keys since 0052: eligibility_policy (what happens when somebody is not certified -- read by the server, which enforces it) and date_format (how a date reads on a screen showing this plant -- read only by the client; a screen that spans plants uses the company value instead). A third key is five edits: both CHECK constraints here, both key lists in the writers, and set_node_setting''s value CASE.';

comment on column node_settings.key is
  'Which setting: eligibility_policy or date_format. Constrained to the keys this schema knows how to validate (node_settings_key_check) -- an unvalidated key would be a value nobody checks.';

comment on column node_settings.value is
  'The override, as text, NOT NULL. Validated PER KEY by node_settings_value_check, whose CASE ends in `else false` so the two keys cannot accept each other''s values -- a shared IN list would store a date_format of "warn".';

-- ----------------------------------------------------------------------------
-- 3. THE WRITERS. 0050's bodies verbatim, extracted from the file rather than
-- retyped (CLAUDE.md §4), with the key lists widened and one WHEN added to
-- set_node_setting's value CASE. Everything else -- SECURITY INVOKER, the
-- app_is_admin_for pre-check that SHAPES the refusal without authorising
-- anything, the read-back after the DELETE that tells an RLS refusal from an
-- honest no-op -- is unchanged and its reasoning still stands in 0050.
-- ----------------------------------------------------------------------------
create or replace function set_node_setting(p_node_id uuid, p_key text, p_value text)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id uuid;
  v_stored text;
BEGIN
  -- The node first: "there is no such place" is not a permission answer, and
  -- app_node_exists_in_org is org-scoped so this leaks nothing outward.
  IF p_node_id IS NULL OR NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such place in this company',
                      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  END IF;

  -- Permission next, and before the value is looked at: someone who may not
  -- change this plant learns nothing about which values are legal.
  IF NOT (app_is_admin() OR app_is_admin_for(p_node_id)) THEN
    PERFORM api_raise('not_permitted', 'only an admin of this place may change its settings',
                      jsonb_build_object('reason', 'not_admin', 'node_id', p_node_id));
  END IF;

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format') THEN
    PERFORM api_raise('invalid_argument', 'unknown setting',
                      jsonb_build_object('field', 'key', 'value', p_key));
  END IF;

  -- `field` is the KEY, so the client can point at the control the person
  -- actually touched -- the same thing 0049 does with 'eligibility_policy'.
  IF p_value IS NULL OR NOT (CASE p_key
                               WHEN 'eligibility_policy' THEN p_value IN ('warn', 'block')
                               WHEN 'date_format' THEN p_value IN (
                                    'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
                                    'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash')
                               ELSE false
                             END) THEN
    PERFORM api_raise('invalid_argument', 'unknown value for this setting',
                      jsonb_build_object('field', p_key, 'value', p_value));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  INSERT INTO node_settings (node_id, key, org_id, value)
  VALUES (p_node_id, p_key, v_org_id, p_value)
  ON CONFLICT (node_id, key) DO UPDATE SET value = excluded.value;

  SELECT ns.value INTO v_stored
    FROM node_settings ns WHERE ns.node_id = p_node_id AND ns.key = p_key;

  RETURN jsonb_build_object(
    'node_id',     p_node_id,
    'key',         p_key,
    'value',       v_stored,
    'is_override', v_stored IS NOT NULL,
    'effective',   app_resolve_node_setting(p_node_id, p_key),
    'org_value',   (SELECT o.settings->>p_key FROM orgs o WHERE o.id = v_org_id)
  );
END $$;

create or replace function clear_node_setting(p_node_id uuid, p_key text)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id uuid;
  v_left text;
BEGIN
  IF p_node_id IS NULL OR NOT app_node_exists_in_org(p_node_id) THEN
    PERFORM api_raise('invalid_argument', 'no such place in this company',
                      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  END IF;

  IF NOT (app_is_admin() OR app_is_admin_for(p_node_id)) THEN
    PERFORM api_raise('not_permitted', 'only an admin of this place may change its settings',
                      jsonb_build_object('reason', 'not_admin', 'node_id', p_node_id));
  END IF;

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format') THEN
    PERFORM api_raise('invalid_argument', 'unknown setting',
                      jsonb_build_object('field', 'key', 'value', p_key));
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  DELETE FROM node_settings WHERE node_id = p_node_id AND key = p_key;

  -- ⛔ ROW_COUNT WOULD BE A LIE HERE. Zero rows deleted is BOTH "RLS filtered
  -- me out" and "there was nothing to clear", and only one of those is fine.
  -- The end state tells them apart: if a row survived, the delete was refused
  -- and the caller must hear about it rather than watch the screen revert.
  SELECT ns.value INTO v_left
    FROM node_settings ns WHERE ns.node_id = p_node_id AND ns.key = p_key;
  IF v_left IS NOT NULL THEN
    PERFORM api_raise('not_permitted', 'the override could not be removed',
                      jsonb_build_object('reason', 'write_filtered', 'node_id', p_node_id));
  END IF;

  RETURN jsonb_build_object(
    'node_id',     p_node_id,
    'key',         p_key,
    'value',       NULL,
    'is_override', false,
    'effective',   app_resolve_node_setting(p_node_id, p_key),
    'org_value',   (SELECT o.settings->>p_key FROM orgs o WHERE o.id = v_org_id)
  );
END $$;

comment on function set_node_setting(uuid, text, text) is
  'R-331/R-333: give ONE place its own answer for ONE setting, overriding whatever it inherits. Keys: eligibility_policy, date_format (0052). Admin-gated by app_is_admin_for -- the plant''s own admin, not only the company''s -- and refuses with not_permitted rather than being the silent zero-row write a plain UPSERT would be under node_settings'' policies. Validates the key and the value itself, per key, so the refusal is invalid_argument/PT400 naming the key rather than the table CHECK''s unreadable 23514, and so a legal value for one key cannot be stored under the other. Returns the stored row beside the resolved effective value and the company''s. Clearing is clear_node_setting, deliberately a different verb.';

comment on function clear_node_setting(uuid, text) is
  'R-331/R-333: return ONE place to inheriting for ONE setting, by deleting its override row. Keys: eligibility_policy, date_format (0052). A separate verb from set_node_setting on purpose -- "set to null" would put back the ambiguity between absent and deliberately set that the node_settings table exists to remove (F-088). Reads the row back after the DELETE because an RLS-filtered DELETE removes zero rows and raises nothing, and zero rows is also the honest outcome of clearing a place that had no override; the surviving row, not ROW_COUNT, is what tells a refusal from a no-op. The primary key is (node_id, key), so clearing one key at a place leaves the other alone.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time -- `create or replace function`
-- keeps an existing ACL, but a file that assumes so is one rename away from
-- shipping a function PUBLIC may execute (api.md §6.2, 0021 §6, 0038's own
-- footer). Guarded by role existence so this still runs on a scratch Postgres
-- without the Supabase roles.
-- ----------------------------------------------------------------------------
revoke execute on function set_node_setting(uuid, text, text) from public;
revoke execute on function clear_node_setting(uuid, text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_node_setting(uuid, text, text) to authenticated';
    execute 'grant execute on function clear_node_setting(uuid, text) to authenticated';
  end if;
end $do$;
