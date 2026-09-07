-- ============================================================================
-- Migration 0063: the THIRD key -- a plant's TIME ZONE (D88a/D88b, R-353/R-354).
--
-- D88 (design-plan 19.21), decided with the maintainer Aug 25 and scheduled for
-- Phase 2: the board's axis is the PLANT's local time. A 06:00 shift must read
-- 06:00 to the people working it, and a shift keeps its posted wall-clock start
-- across a DST change (so the changeover day is 7 or 9 hours). The client half
-- of that lands in src/features/board (time.ts + geometry.ts). This migration is
-- the server half: WHERE the zone lives and HOW the board resolves it.
--
-- WHERE IT LIVES: not a column on `nodes`. "Site" is not a fixed level any more
-- (D86), so the zone hangs off a NODE and resolves nearest-ancestor with a
-- company fallback -- the exact mechanic date_format uses (0050/0052). It is the
-- THIRD key of node_settings, `timezone`, an IANA name. Company fallback is
-- `orgs.settings.timezone`, default 'UTC' (COALESCEd at board_window's call
-- site), so nothing shipped changes for a single-zone customer until somebody
-- sets it.
--
-- ⭐ 0052 PRICED A NEW KEY AT FIVE EDITS IN FOUR PLACES. This one pays exactly
-- that, plus a company writer (set_org_timezone, beside set_org_date_format) and
-- one board_window key (beside date_format):
--   1. node_settings_key_check     -- DROP/re-add (append-only: no ALTER CHECK).
--   2. node_settings_value_check   -- DROP/re-add, one WHEN.
--   3. set_node_setting key list.
--   4. set_node_setting value CASE -- one WHEN.
--   5. clear_node_setting key list.
--   +  set_org_timezone            -- the company-scope writer.
--   +  board_window                -- the resolved key the client reads.
--
-- ⛔ THE VALUE IS VALIDATED AGAINST pg_timezone_names, WHICH A CHECK CONSTRAINT
-- CANNOT DO. A CHECK may hold no subquery, and pg_timezone_names is a volatile
-- system view besides, so the two CHECKs guard the timezone key only LOOSELY
-- (non-empty, bounded length). The AUTHORITATIVE refusal -- a typed
-- invalid_argument/PT400 naming the key -- is raised by set_node_setting and
-- set_org_timezone via `EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ?)`
-- BEFORE the row is written, exactly as date_format's value list is checked in
-- the writer ahead of the table CHECK. The CHECK is the backstop, not the gate.
--
-- ⚠️ NO SERVER-SIDE READER MOVES, like 0052 and unlike 0050. The zone decides
-- how an instant is DRAWN on the client's axis; nothing on the server reads it
-- to decide whether a write is allowed. So there is no reader to forget and no
-- check_eligibility/move_run to move onto the resolver in the same breath.
--
-- ⭐ NO BACKFILL, NO UPGRADE CHECK. Adds no column/table/policy/trigger,
-- transforms no data, and widens two CHECKs rather than narrowing them -- every
-- existing node_settings row is an eligibility_policy or date_format row and
-- satisfies the widened expressions. No row in verify-db.sh's UPGRADE_CHECKS and
-- no upgrade_0063_*.sql, stated so the absence is on the record (0038/0052).
--
-- Proved by supabase/tests/87_plant_timezone_test.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE KEY CONSTRAINT. Dropped and re-added, not altered (0052's discipline).
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_key_check;
alter table node_settings add constraint node_settings_key_check
  check (key in ('eligibility_policy', 'date_format', 'timezone'));

-- ----------------------------------------------------------------------------
-- 2. THE VALUE CONSTRAINT. Still a CASE with `else false`, so an unknown key
-- can never store an unvalidated value. The `timezone` branch is LOOSE on
-- purpose (see the header): the real IANA check is in the writers, and a CHECK
-- cannot query pg_timezone_names. A non-empty, bounded string is the backstop.
-- ----------------------------------------------------------------------------
alter table node_settings drop constraint if exists node_settings_value_check;
alter table node_settings add constraint node_settings_value_check
  check (case key
           when 'eligibility_policy' then value in ('warn', 'block')
           when 'date_format' then value in (
                'd_mon_yyyy', 'dmy_slash', 'mdy_slash', 'iso',
                'dmy_dash_mon', 'd_month_yyyy', 'month_d_yyyy', 'ymd_slash')
           when 'timezone' then value is not null and char_length(value) between 1 and 64
           else false
         end);

comment on table node_settings is
  'R-331/R-333/R-353: a setting given an answer at ONE place in the structure, overriding the company''s. The row IS the override -- no row means this place inherits, which is why the value column is NOT NULL and clearing is a DELETE rather than a magic value (F-088). Resolved by app_resolve_node_setting: nearest ancestor-or-self with an answer, else orgs.settings, else the reader''s coded default. Three keys since 0063: eligibility_policy (read by the server, which enforces it), date_format (how a date reads, read only by the client) and timezone (the IANA zone the board''s axis renders in, read only by the client; the value CHECK is loose because pg_timezone_names cannot be a CHECK subquery -- the writers validate it). A fourth key is five edits: both CHECK constraints here, both key lists in the writers, and set_node_setting''s value CASE.';

comment on column node_settings.key is
  'Which setting: eligibility_policy, date_format or timezone. Constrained to the keys this schema knows how to validate (node_settings_key_check).';

-- ----------------------------------------------------------------------------
-- 3. THE WRITERS. 0052's bodies verbatim (extracted, not retyped -- CLAUDE.md
-- §4), with the key lists widened and one WHEN added to set_node_setting's value
-- CASE. Everything else -- SECURITY INVOKER, the app_is_admin_for pre-check, the
-- read-back after the DELETE -- is unchanged and its reasoning stands in 0050.
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

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone') THEN
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

  IF p_key IS NULL OR p_key NOT IN ('eligibility_policy', 'date_format', 'timezone') THEN
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
  'R-331/R-333/R-353: give ONE place its own answer for ONE setting, overriding whatever it inherits. Keys: eligibility_policy, date_format (0052), timezone (0063). Admin-gated by app_is_admin_for -- the plant''s own admin, not only the company''s -- and refuses with not_permitted rather than being the silent zero-row write a plain UPSERT would be. Validates the key and the value itself, per key, so the refusal is invalid_argument/PT400 naming the key; the timezone value is checked against pg_timezone_names in the writer because a CHECK constraint cannot. Clearing is clear_node_setting, a different verb.';

comment on function clear_node_setting(uuid, text) is
  'R-331/R-333/R-353: return ONE place to inheriting for ONE setting, by deleting its override row. Keys: eligibility_policy, date_format (0052), timezone (0063). A separate verb from set_node_setting on purpose (F-088). Reads the row back after the DELETE because an RLS-filtered DELETE removes zero rows and raises nothing. The primary key is (node_id, key), so clearing one key at a place leaves the others alone.';

-- ----------------------------------------------------------------------------
-- 4. THE COMPANY-SCOPE WRITER. set_org_timezone, beside set_org_date_format
-- (0037/0038): same shape, same grants, same SECURITY INVOKER + app_is_admin
-- gate, the same `||` shallow merge and read-back. The IANA name is validated
-- against pg_timezone_names, so a bad zone is invalid_argument naming the field
-- rather than a silent store.
-- ----------------------------------------------------------------------------
create or replace function set_org_timezone(p_tz text) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
DECLARE
  v_settings jsonb;
BEGIN
  -- Permission first: a non-admin never learns anything about the value, and
  -- the refusal is the same whether the zone was legal or not.
  IF NOT app_is_admin() THEN
    PERFORM api_raise('not_permitted', 'only a system admin may change site settings',
                      jsonb_build_object('reason', 'not_admin'));
  END IF;

  IF p_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    PERFORM api_raise('invalid_argument', 'unknown time zone',
                      jsonb_build_object('field', 'timezone', 'value', p_tz));
  END IF;

  UPDATE orgs
     SET settings = settings || jsonb_build_object('timezone', p_tz)
   WHERE id = app_current_org();

  SELECT settings INTO v_settings FROM orgs WHERE id = app_current_org();
  RETURN v_settings;
END $$;

comment on function set_org_timezone(text) is
  'R-353: set the org-wide (company fallback) IANA time zone in orgs.settings.timezone, beside set_org_date_format (0037/0038). Validated against pg_timezone_names; anything else is invalid_argument naming the field. Refuses a non-admin with not_permitted -- a plain UPDATE would be a silent zero-row no-op under orgs_update. Merges the one key with || so the rest of the settings bag survives; returns the stored settings.';

-- ----------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC first, every time (api.md §6.2). Guarded by role
-- existence so this still runs on a scratch Postgres without the Supabase roles.
-- ----------------------------------------------------------------------------
revoke execute on function set_node_setting(uuid, text, text) from public;
revoke execute on function clear_node_setting(uuid, text) from public;
revoke execute on function set_org_timezone(text) from public;

do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_node_setting(uuid, text, text) to authenticated';
    execute 'grant execute on function clear_node_setting(uuid, text) to authenticated';
    execute 'grant execute on function set_org_timezone(text) to authenticated';
  end if;
end $do$;

-- ----------------------------------------------------------------------------
-- 5. THE BOARD CARRIES ITS ZONE. board_window re-emitted WHOLE from 0062 by
-- extraction (0062's own discipline), the ONLY edit being one new top-level key,
-- `timezone`, resolved for the board's own root through app_resolve_node_setting
-- (SECURITY DEFINER, 0050) and COALESCEd to 'UTC' -- the twin of the date_format
-- key 0062 added. A line supervisor cannot read the override on her plant root,
-- so a browser-side walk would fall through to the company default; the resolver
-- is DEFINER so the walk happens where the authority is (DEF-0016/DEF-0017).
-- Lane A's 0064 does not touch board_window, so this stays the last definition.
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
  'Unchanged from 0062 apart from ONE new top-level key, timezone (D88a, R-353): the IANA time zone RESOLVED for the board''s own root through app_resolve_node_setting (SECURITY DEFINER, 0050), COALESCEd to UTC (the key''s own default) so the payload always carries a token. It is the twin of the date_format key 0062 added and of node_policies'' eligibility_policy (R-331): a line supervisor cannot read the override on her plant root, so a browser-side walk would fall through to the company default and draw the board in the wrong zone. Everything else is 0062''s text.';
