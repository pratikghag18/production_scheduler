-- ============================================================================
-- Migration 0081: the FOURTH key -- a plant's COMMAND BAR mode (D129, R-403).
--
-- The maintainer, session 164, 14 Sept: "Is there a way we can enable and
-- disable the chatbot from the settings? I'm thinking if I want to limit the
-- feature during the initial getting used to period." Shown the three values
-- (off, typed, voice): "Yes, go."
--
-- Exactly 0063's shape, one key later: a company-wide value in orgs.settings,
-- a per-place override in node_settings, resolved by the same
-- app_resolve_node_setting (SECURITY DEFINER) walk the other three keys use,
-- so a line supervisor whose board is rooted below a plant that switched the
-- bar off still gets 'off' even though the plant's row sits above her grant
-- (DEF-0016/DEF-0017's lesson, CLAUDE.md §4). The default, when nothing is
-- set anywhere, is 'voice' -- the board's behaviour before this migration --
-- so board_window's COALESCE keeps every existing board answering exactly as
-- it did yesterday until somebody touches the switch.
--
-- ⭐ THIS PAYS 0052's PRICED FIVE EDITS IN FOUR PLACES, PLUS A SIXTH: a
-- company-scope writer (set_org_command_bar, beside set_org_eligibility_policy)
-- because unlike timezone/date_format this key is a THIRD kind -- not a
-- display convention (date_format, timezone) and not a server-enforced
-- eligibility rule (eligibility_policy), but a CLIENT FEATURE GATE the board
-- reads and hides behind. Nothing on the server refuses a write because of it;
-- board_window is the only reader.
--   1. node_settings_key_check      -- DROP/re-add (append-only: no ALTER CHECK).
--   2. node_settings_value_check    -- DROP/re-add, one WHEN.
--   3. set_node_setting key list    -- re-emitted from 0063 (extract, not retype).
--   4. set_node_setting value CASE  -- one WHEN, same re-emission.
--   5. clear_node_setting key list  -- it NAMES the keys, so it is re-emitted too.
--   +  set_org_command_bar          -- the company-scope writer, set_org_eligibility_policy's
--                                       shape with the key and the value list swapped.
--   +  board_window                 -- the resolved key the client reads, one line
--                                       beside date_format, re-emitted from 0063.
--
-- ⭐ RE-EMITTED, NEVER RETYPED (CLAUDE.md §4, DEF-0011). board_window,
-- set_node_setting and clear_node_setting below are 0063's own bytes plus the
-- named insertions, assembled and guard-asserted by
-- scripts/migrations/assemble-0081.mjs -- run it to see the assertions and the
-- diff for yourself; it refuses to write this file if any assertion fails.
--
-- ⛔ THE VALUE CHECK IS TIGHT, UNLIKE timezone's. Three literal tokens
-- ('off', 'typed', 'voice'), not an open vocabulary a CHECK cannot validate --
-- so, unlike timezone, the table CHECK here is a real backstop and not merely
-- a loose one, exactly like eligibility_policy and date_format.
--
-- ⭐ NO BACKFILL, NO UPGRADE CHECK, for 0063's exact reason: adds no column,
-- table, policy or trigger; widens two CHECKs rather than narrowing them, so
-- every existing node_settings row (an eligibility_policy, date_format or
-- timezone row) satisfies the widened expressions unchanged. No row in
-- verify-db.sh's UPGRADE_CHECKS and no upgrade_0081_*.sql.
--
-- Proved by supabase/tests/98_command_bar_setting_test.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE KEY CONSTRAINT. Dropped and re-added, not altered -- append-only.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_key_check;
alter table node_settings add constraint node_settings_key_check
  check (key in ('eligibility_policy', 'date_format', 'timezone', 'command_bar'));

-- ----------------------------------------------------------------------------
-- 2. THE VALUE CONSTRAINT. One more WHEN, still `else false` so an unknown
-- key can never store an unvalidated value. Unlike timezone's loose branch,
-- command_bar's three tokens are a closed, literal vocabulary a CHECK CAN
-- validate in full -- this is a real backstop, the same as eligibility_policy
-- and date_format's branches.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_value_check;
alter table node_settings add constraint node_settings_value_check
  check (case key
           when 'eligibility_policy' then value in ('warn', 'block')
           when 'date_format' then value in (
                'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
                'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash')
           when 'timezone' then value is not null and char_length(value) between 1 and 64
           when 'command_bar' then value in ('off', 'typed', 'voice')
           else false
         end);

comment on table node_settings is
  'R-331/R-333/R-353/R-403: a setting given an answer at ONE place in the structure, overriding the company''s. The row IS the override -- no row means this place inherits, which is why the value column is NOT NULL and clearing is a DELETE rather than a magic value (F-088). Resolved by app_resolve_node_setting: nearest ancestor-or-self with an answer, else orgs.settings, else the reader''s coded default. Four keys since 0081: eligibility_policy (read by the server, which enforces it), date_format (how a date reads, read only by the client), timezone (the IANA zone the board''s axis renders in, read only by the client; the value CHECK is loose because pg_timezone_names cannot be a CHECK subquery -- the writers validate it) and command_bar (off/typed/voice, read only by the client to decide whether the board offers the launcher and whether it offers the microphone; 0081, D129). A fifth key is five edits in four places, plus a company writer if it is not itself company-scoped already.';

comment on column node_settings.key is
  'Which setting: eligibility_policy, date_format, timezone or command_bar. Constrained to the keys this schema knows how to validate (node_settings_key_check).';

-- ----------------------------------------------------------------------------
-- 3. THE WRITERS. Re-emitted from 0063 by scripts/migrations/assemble-0081.mjs
-- (see its assertion output), with the key lists widened and one WHEN added to
-- set_node_setting's value CASE. Everything else -- SECURITY INVOKER, the
-- app_is_admin_for pre-check, the read-back after the DELETE -- is 0063's own
-- text, unchanged, and its reasoning stands in 0050/0063.
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

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone', 'command_bar') THEN
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
                               WHEN 'timezone' THEN
                                    EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_value)
                               WHEN 'command_bar' THEN p_value IN ('off', 'typed', 'voice')
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

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone', 'command_bar') THEN
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
  'R-331/R-333/R-353/R-403: give ONE place its own answer for ONE setting, overriding whatever it inherits. Keys: eligibility_policy, date_format (0052), timezone (0063), command_bar (0081). Admin-gated by app_is_admin_for -- the plant''s own admin, not only the company''s -- and refuses with not_permitted rather than being the silent zero-row write a plain UPSERT would be. Validates the key and the value itself, per key, so the refusal is invalid_argument/PT400 naming the key. Clearing is clear_node_setting, a different verb.';

comment on function clear_node_setting(uuid, text) is
  'R-331/R-333/R-353/R-403: return ONE place to inheriting for ONE setting, by deleting its override row. Keys: eligibility_policy, date_format (0052), timezone (0063), command_bar (0081). A separate verb from set_node_setting on purpose (F-088). Reads the row back after the DELETE because an RLS-filtered DELETE removes zero rows and raises nothing. The primary key is (node_id, key), so clearing one key at a place leaves the others alone.';

-- ----------------------------------------------------------------------------
-- 4. THE COMPANY-SCOPE WRITER. set_org_command_bar, beside
-- set_org_eligibility_policy (0049) and set_org_timezone (0063): the same
-- shape, the same grants, the same SECURITY INVOKER + app_is_admin gate, the
-- same `||` shallow merge and read-back. Three literal tokens, so (unlike the
-- timezone writer) there is no external vocabulary to check against -- the IN
-- list is the whole validation, same as set_org_eligibility_policy's.
-- ----------------------------------------------------------------------------
create or replace function set_org_command_bar(p_value text) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_settings jsonb;
BEGIN
  -- Permission first: a non-admin never learns anything about the value, and
  -- the refusal is the same whether the value was legal or not.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system admin may change site settings',
                      jsonb_build_object('reason', 'not_admin'));
  END IF;

  IF p_value IS NULL OR p_value NOT IN ('off', 'typed', 'voice') THEN
    PERFORM api_raise('invalid_argument', 'unknown command bar mode',
                      jsonb_build_object('field', 'command_bar', 'value', p_value));
  END IF;

  UPDATE orgs
     SET settings = settings || jsonb_build_object('command_bar', p_value)
   WHERE id = app_current_org();

  SELECT settings INTO v_settings FROM orgs WHERE id = app_current_org();
  RETURN v_settings;
END $$;

comment on function set_org_command_bar(text) is
  'R-403: set the org-wide (company fallback) command bar mode in orgs.settings.command_bar, beside set_org_eligibility_policy (0049) and set_org_timezone (0063). One of off/typed/voice; anything else is invalid_argument naming the field. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update. Merges the one key with || so the rest of the settings bag survives; returns the stored settings.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time (api.md §6.2). set_node_setting
-- and clear_node_setting keep the grants 0050 already gave them -- CREATE OR
-- REPLACE does not touch privileges. Only the new function needs one.
-- ----------------------------------------------------------------------------
revoke execute on function set_org_command_bar(text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_org_command_bar(text) to authenticated';
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 5. THE BOARD CARRIES ITS COMMAND BAR MODE. board_window re-emitted WHOLE
-- from 0063 by scripts/migrations/assemble-0081.mjs, the ONLY edit being one
-- new top-level key, `command_bar`, resolved for the board's own root through
-- app_resolve_node_setting (SECURITY DEFINER, 0050) and COALESCEd to 'voice'
-- -- the twin of date_format and timezone. A line supervisor cannot read the
-- override on her plant root, so a browser-side walk would fall through to the
-- company default; the resolver is DEFINER so the walk happens where the
-- authority is (DEF-0016/DEF-0017).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.board_window(p_root_path ltree, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_window tstzrange;
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_from and p_to must not be null',
      jsonb_build_object('field', 'p_from/p_to', 'reason', 'null bound'));
  END IF;
  IF p_from >= p_to THEN
    PERFORM api_raise('invalid_argument', 'p_from must be before p_to',
      jsonb_build_object('field', 'p_from', 'reason', 'p_from >= p_to'));
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    PERFORM api_raise('invalid_argument', 'window exceeds 92 days',
      jsonb_build_object('field', 'p_to', 'reason', 'window exceeds 92 days'));
  END IF;

  v_org_id := app_current_org();
  v_window := tstzrange(p_from, p_to);

  WITH scoped_nodes AS (
    SELECT n.* FROM nodes n
    WHERE n.org_id = v_org_id AND n.path <@ p_root_path
  ),
  -- DEF-0005: the ANSWER, computed where the authority is. See the header.
  offered_here AS (
    SELECT op.product_id, op.node_id FROM app_offered_product_nodes(p_root_path) op
  ),
  scoped_templates AS (
    SELECT DISTINCT hl.template_id
    FROM scoped_nodes sn JOIN hierarchy_levels hl ON hl.id = sn.level_id
  ),
  node_template_map AS (
    SELECT sn.id AS node_id, resolve_shift_template(sn.id) AS template_id
    FROM scoped_nodes sn
  )
  SELECT jsonb_build_object(
    'org', (SELECT jsonb_build_object('id', o.id, 'name', o.name, 'settings', o.settings)
            FROM orgs o WHERE o.id = v_org_id),

    -- R-346, the viewer clause (session 79): may this person PLACE people
    -- somewhere on this board? An edit grant (supervisor or admin) covering
    -- the board's place or inside it, or the company admin. The screen hides
    -- the Operators panel and every "other people" control when this is
    -- false --- "for a viewer, the left panel serves no purpose". Decided here,
    -- with app_grant_paths(true), the same set the write policies bind.
    'can_place', (app_is_admin()
                  OR EXISTS (SELECT 1 FROM app_grant_paths(true) gp
                              WHERE p_root_path <@ gp OR gp <@ p_root_path)),

    -- THE KEY THIS MIGRATION EXISTS FOR (DEF-0017, R-333). The date format
    -- RESOLVED for the board's own root, so a supervisor whose board is rooted
    -- at a LINE inside a plant that set its own format sees the PLANT's choice,
    -- not the company default. `useDateFormat(enabled, root)` read the ROOT's
    -- OWN node_settings row (none, for a line) and fell through to the company
    -- value; the plant's row sits above her grant and `node_settings_select`
    -- would not hand it to her. `app_resolve_node_setting` is SECURITY DEFINER
    -- and walks the ancestry where the authority is, exactly as `node_policies`
    -- above does for the eligibility policy.
    --
    -- COALESCE TO 'd_mon_yyyy' IS THE KEY'S OWN DEFAULT kept at the call
    -- site, the same way `node_policies` COALESCEs to 'warn'. The resolver
    -- returns NULL when nobody has an answer, and the seed's company bag carries
    -- no `date_format` key at all -- so a board with no override anywhere would
    -- otherwise send a JSON null, which the client parses into the CLOSED
    -- DateFormat enum and would reject as a shape mismatch, blanking the whole
    -- board. 'd_mon_yyyy' is the client's DEFAULT_DATE_FORMAT (src/lib/format/
    -- dates.ts), so the two agree on the pre-setting shape.
    'date_format', COALESCE(
      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),
                               'date_format'), 'd_mon_yyyy'),

    -- THE KEY THIS MIGRATION EXISTS FOR (R-403, D129). The command bar mode
    -- RESOLVED for the board's own root, the same COALESCE-at-the-call-site
    -- twin as date_format and timezone above: 'voice' is the key's own
    -- default, and the behaviour every board had before this setting
    -- existed, so a board with no override anywhere is unchanged.
    'command_bar', COALESCE(
      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),
                               'command_bar'), 'voice'),

    -- THE KEY THIS MIGRATION EXISTS FOR (D88a, R-353). The plant's IANA time
    -- zone, RESOLVED for the board's own root through the same SECURITY DEFINER
    -- resolver as date_format above, so a supervisor whose board is rooted at a
    -- LINE inside a plant that set its own zone sees the PLANT's zone, not the
    -- company default -- the client never walks the ancestry for it (DEF-0016/
    -- DEF-0017 were both that walk failing on an ancestor the caller cannot
    -- read). COALESCE TO 'UTC' is the key's own default kept at the call site:
    -- orgs.settings carries no timezone in the seed, so the resolver returns
    -- NULL there and the client parses the token defaulting to 'UTC' too, so
    -- nothing shipped changes for a single-zone customer until somebody sets it.
    'timezone', COALESCE(
      app_resolve_node_setting((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path),
                               'timezone'), 'UTC'),

    'levels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', hl.id, 'template_id', hl.template_id, 'position', hl.position,
               'name', hl.name, 'is_schedulable', hl.is_schedulable)
             ORDER BY hl.template_id, hl.position)
      FROM hierarchy_levels hl
      WHERE hl.org_id = v_org_id
        AND hl.template_id IN (SELECT template_id FROM scoped_templates)
    ), '[]'::jsonb),

    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sn.id, 'parent_id', sn.parent_id, 'level_id', sn.level_id,
               'name', sn.name, 'path', sn.path::text, 'sort_order', sn.sort_order,
               'active', sn.active) ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    -- ⭐⭐ THE KEY THIS MIGRATION EXISTS FOR (R-331). One resolved answer per
    -- node in the window, so the popover can ask the CELL what the rule is
    -- instead of asking the company. Built off `scoped_nodes`, so it covers
    -- exactly the nodes `nodes` above sends and no others -- a node in one
    -- list and not the other is a cell the client cannot decide about.
    --
    -- ⛔ `app_resolve_node_setting` AND NOT THE RAW `node_settings` ROWS. This
    -- function is SECURITY INVOKER; `node_settings_select` is gated on
    -- `app_can_read_node`. A supervisor granted a LINE never receives the row
    -- sitting on the PLANT ROOT, so a browser handed those rows and told to
    -- walk the ancestry would miss the override and fall through to the
    -- company's default -- a `block` plant reading as `warn` for exactly the
    -- people who schedule against it all day. The resolver is SECURITY DEFINER
    -- for that reason (0050 §3), so the walk happens where the authority is.
    --
    -- ⚠️ THE COALESCE TO 'warn' IS THE KEY'S OWN DEFAULT, kept at the call site
    -- exactly as `check_eligibility` keeps it (0050 §5) -- the resolver returns
    -- NULL when nobody has an answer, and inventing one inside it would answer
    -- 'warn' for keys that have nothing to do with eligibility. This value and
    -- `check_eligibility`'s `policy` are therefore the SAME expression, which
    -- is what 74's N7 measures node by node.
    'node_policies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'node_id', sn.id,
               'eligibility_policy',
               COALESCE(app_resolve_node_setting(sn.id, 'eligibility_policy'), 'warn'))
             ORDER BY sn.path)
      FROM scoped_nodes sn
    ), '[]'::jsonb),

    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange)
      FROM runs r
      WHERE r.node_id IN (SELECT id FROM scoped_nodes) AND r.timerange && v_window
    ), '[]'::jsonb),

    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange)
      FROM assignments a
      WHERE a.node_id IN (SELECT id FROM scoped_nodes) AND a.timerange && v_window
    ), '[]'::jsonb),

    'operators', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', op.id, 'home_node_id', op.home_node_id, 'display_name', op.display_name,
               'employee_ref', op.employee_ref, 'active', op.active,
               'site_node_id', op.site_node_id,
               -- R-346. The home's PATH, so the screen can tell "homed above
               -- this cell" (available by default) from "homed in another area
               -- of this plant" (behind the click) WITHOUT being able to read
               -- the nodes above its own grant. `nodes` is RLS-scoped and
               -- `nodes_select` is `path <@ grant`, DESCENDANTS ONLY, so a line
               -- supervisor cannot resolve the home of anyone owned by the
               -- plant or by the area above them -- joining `nodes` here would
               -- have dropped exactly the people the maintainer was missing.
               -- The path therefore comes from a SECURITY DEFINER helper, for
               -- the same reason `app_resolve_node_setting` is one (0051).
               'site_path', oh.site_path::text,
               'skill_ids', COALESCE((
                 SELECT jsonb_agg(os.skill_id) FROM operator_skills os WHERE os.operator_id = op.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (F-087). `skill_ids` above
               -- answers "was this person ever trained"; this answers "and is
               -- that certificate still good", which is the question
               -- `check_eligibility` actually decides on. Only the DATED rows
               -- are listed -- an undated certificate never expires, and its
               -- absence here says so once rather than twice.
               'skill_expiries', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('skill_id', os.skill_id,
                                                     'expires_at', os.expires_at)
                          ORDER BY os.skill_id)
                 FROM operator_skills os
                 WHERE os.operator_id = op.id AND os.expires_at IS NOT NULL
               ), '[]'::jsonb)
             ) ORDER BY op.display_name)
      -- R-345/R-346. THE PLANT'S PEOPLE, not the company's. The join is an
      -- INNER one against a SECURITY DEFINER helper restricted to the board's
      -- own plant, so a person homed in another plant is not in the payload at
      -- all -- they can no longer be placed here (R-345), so offering them was
      -- only ever a dead end. `operators` itself stays RLS-filtered (this
      -- function is SECURITY INVOKER), so the helper widens the SHAPE of the
      -- list and `operators_select` still decides who is in it.
      FROM operators op
      JOIN app_operator_homes(p_root_path) oh ON oh.operator_id = op.id
      WHERE op.org_id = v_org_id
    ), '[]'::jsonb),

    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'active', p.active,
               'color_token', p.color_token,
               'site_node_ids', COALESCE((
                 SELECT jsonb_agg(ps.node_id) FROM product_sites ps WHERE ps.product_id = p.id
               ), '[]'::jsonb),
               -- THE KEY THIS MIGRATION EXISTS FOR (DEF-0005). Which nodes IN
               -- THIS WINDOW is this part offered at, asked of the same test the
               -- write guard runs. `site_node_ids` above is the raw place list
               -- and stays exactly as it was -- the admin screens and the
               -- deleted-product path in history.ts read it -- but it is
               -- RLS-filtered, so a supervisor granted a LINE sees `[]` for a
               -- part made at the PLANT and cannot tell that from a part that
               -- is made nowhere.
               'offered_node_ids', COALESCE((
                 SELECT jsonb_agg(oh.node_id) FROM offered_here oh WHERE oh.product_id = p.id
               ), '[]'::jsonb)) ORDER BY p.sku)
      FROM products p WHERE p.org_id = v_org_id
    ), '[]'::jsonb),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'site_node_id', s.site_node_id) ORDER BY s.name)
      FROM skills s WHERE s.org_id = v_org_id
    ), '[]'::jsonb),

    'node_skill_requirements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', nsr.node_id, 'skill_id', nsr.skill_id)
               ORDER BY nsr.node_id, nsr.skill_id)
      FROM node_skill_requirements nsr
      WHERE nsr.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb),

    'shift_templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', st.id, 'name', st.name,
               'shifts', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'start_min', s.start_min, 'end_min', s.end_min,
                          'breaks', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                     'id', b.id, 'name', b.name, 'start_min', b.start_min, 'end_min', b.end_min)
                                     ORDER BY b.start_min)
                            FROM shift_breaks b WHERE b.shift_id = s.id
                          ), '[]'::jsonb)
                        ) ORDER BY s.start_min)
                 FROM shifts s WHERE s.template_id = st.id
               ), '[]'::jsonb)
             ) ORDER BY st.name)
      FROM shift_templates st
      WHERE st.id IN (SELECT DISTINCT template_id FROM node_template_map WHERE template_id IS NOT NULL)
    ), '[]'::jsonb),

    'node_shift_map', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ntm.node_id, 'template_id', ntm.template_id)
               ORDER BY ntm.node_id)
      FROM node_template_map ntm WHERE ntm.template_id IS NOT NULL
    ), '[]'::jsonb),

    'cycle_times', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('node_id', ct.node_id, 'product_id', ct.product_id,
                                          'seconds_per_unit', ct.seconds_per_unit)
               ORDER BY ct.node_id, ct.product_id)
      FROM node_product_cycle_times ct
      WHERE ct.node_id IN (SELECT id FROM scoped_nodes)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

comment on function board_window(ltree, timestamptz, timestamptz) is
  'Unchanged from 0063 apart from ONE new top-level key, command_bar (D129, R-403): the mode (off/typed/voice) RESOLVED for the board''s own root through app_resolve_node_setting (SECURITY DEFINER, 0050), COALESCEd to voice (the key''s own default -- the board''s behaviour before this setting existed) so the payload always carries a token. It is the twin of the date_format and timezone keys: a line supervisor cannot read the override on her plant root, so a browser-side walk would fall through to the company default and show or hide the launcher wrongly. Everything else is 0063''s text.';
