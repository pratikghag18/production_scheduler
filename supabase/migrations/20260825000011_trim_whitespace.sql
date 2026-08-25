-- ============================================================================
-- 20260825000011_trim_whitespace.sql
--
-- Design-session fix, Aug 25 2026 (design plan §19.13). NOT an agent build.
--
-- WHAT WAS WRONG
-- Postgres `trim(x)` with no explicit character set strips SPACES ONLY.
-- JavaScript's `String.trim()` strips all Unicode whitespace. The client's
-- `validateLevelDraft` therefore REJECTED a tab- or newline-only level name
-- that these RPCs happily ACCEPTED -- the forbidden direction of the one-way
-- invariant the hierarchy client is built on (P1-5b brief §5): *anything the
-- client rejects, the server must also reject.* The client is right on
-- product grounds, so the SERVER moves.
--
-- IT WAS NOT ONE SITE. Migration 0010 called bare `trim()` in FOUR places
-- across THREE functions, and two of them STORE the result rather than
-- validate it, so tab-padded names were being persisted:
--   save_hierarchy_levels  blank-name check   (validate)
--   save_hierarchy_levels  v_name assignment  (store)
--   create_node            v_name assignment  (validate + store)
--   rename_node            v_name assignment  (validate + store)
-- Fixing only the one the client disagreed about would have left three.
--
-- WHY AN EXPLICIT CODE-POINT LIST AND NOT `\s` OR `btrim`
-- Two wrong answers were measured and discarded before this one:
--
--   1. `btrim(x, E' \t\n\r\f\v')` -- the obvious fix -- matches JS on only
--      6 of 12 whitespace characters. It looks complete and silently leaves
--      NBSP, EM SPACE, IDEOGRAPHIC SPACE, LINE SEPARATOR and OGHAM SPACE
--      diverging.
--   2. `[\s\uFEFF]` matched JS on 12 of 12 -- but only on a database with a
--      Unicode-aware collation. `\s` is COLLATION-DEPENDENT: in the `C`
--      locale it does not match NBSP at all, so the fix would pass on one
--      machine and fail on another. This was caught by running it, not by
--      reading it.
--
-- The class below names exact code points, so it is collation-independent.
-- It is precisely ECMA-262's WhiteSpace + LineTerminator -- i.e. exactly what
-- `String.trim()` strips -- and was verified character by character against
-- Node v22 on an 18-point probe. U+200B ZWSP is deliberately EXCLUDED: JS
-- does not strip it either, and parity is the requirement, not aggressiveness.
--
-- REQUIRES A UTF-8 DATABASE. Supabase is UTF-8; `scripts/verify-db.sh` was
-- creating a SQL_ASCII scratch database and is fixed in the same change.
--
-- The three functions below are otherwise IDENTICAL to migration 0010 and were
-- reproduced mechanically from it, not retyped. Only the four `trim(...)`
-- calls changed. Read 0010 for the commentary on their logic.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_trim_ws — ONE authoritative implementation of "trim the way the client
-- does". Every name-validating or name-storing path uses this; nothing
-- open-codes a trim. NULL in yields '' out, matching the client's
-- `String(d?.name ?? "").trim()` and the old `trim(coalesce(x, ''))`.
--
-- DO NOT "simplify" this to `\s` or `trim()`. Both have been tried and both
-- are wrong; the header says why.
-- ----------------------------------------------------------------------------
create function app_trim_ws(input text) returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select regexp_replace(coalesce(input, ''), '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g');
$fn$;

comment on function app_trim_ws(text) is
  'Trim leading/trailing whitespace using the EXACT character set of JavaScript String.trim() (ECMA-262 WhiteSpace + LineTerminator, incl. U+FEFF, excl. U+200B), named by code point so it does not depend on collation. Do not replace with trim() or a \s class -- see migration 0011 header.';

-- ----------------------------------------------------------------------------
-- save_hierarchy_levels — unchanged from 0010 except the app_trim_ws call(s).
-- ----------------------------------------------------------------------------
create or replace function save_hierarchy_levels(p_levels jsonb) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id                    uuid;
  v_count                     int;
  v_schedulable_count         int;
  v_kept_ids                  uuid[];
  v_removed_ids                uuid[];
  v_old_schedulable_level_id  uuid;
  v_new_schedulable_level_id  uuid;
  v_run_count                 int;
  v_assignment_count          int;
  v_blocking_count            int;
  v_entry                     jsonb;
  v_idx                       int;
  v_id                        uuid;
  v_name                      text;
  v_schedulable_idx           int;
  v_result                    jsonb;
begin
  -- 1. admin only.
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();

  -- 2. must be a JSON array.
  if jsonb_typeof(p_levels) is distinct from 'array' then
    perform api_raise('invalid_argument', 'p_levels must be a JSON array',
      jsonb_build_object('field', 'p_levels', 'reason', 'not an array'));
  end if;

  v_count := jsonb_array_length(p_levels);

  -- 3. empty array.
  if v_count = 0 then
    perform api_raise('invalid_argument', 'p_levels must not be empty',
      jsonb_build_object('field', 'p_levels', 'reason', 'empty array'));
  end if;

  -- 4. more than 64 entries. The cap is what guarantees the +1000 offset
  -- pass below can never collide with a final position.
  if v_count > 64 then
    perform api_raise('invalid_argument', 'p_levels must not exceed 64 entries',
      jsonb_build_object('field', 'p_levels', 'reason', 'too many entries'));
  end if;

  -- 5. exactly one schedulable.
  select count(*) into v_schedulable_count
    from jsonb_array_elements(p_levels) e
    where (e->>'is_schedulable')::boolean is true;
  if v_schedulable_count <> 1 then
    perform api_raise('invalid_argument', 'exactly one level must be schedulable',
      jsonb_build_object('field', 'is_schedulable', 'reason',
        format('found %s schedulable entries, expected 1', v_schedulable_count)));
  end if;

  -- 6. no blank names.
  if exists (
    select 1 from jsonb_array_elements(p_levels) e
    where app_trim_ws(e->>'name') = ''
  ) then
    perform api_raise('invalid_argument', 'level name must not be blank',
      jsonb_build_object('field', 'name', 'reason', 'blank name'));
  end if;

  -- D3 (found in design-session verification, Aug 25; not in the brief's
  -- original 8-step list): every non-null id must parse as a uuid before
  -- anything below casts it -- otherwise a malformed id (e.g. "nope") raises
  -- a raw 22P02 outside the §7 closed set instead of a typed invalid_argument.
  if exists (
    select 1 from jsonb_array_elements(p_levels) e
    where (e->>'id') is not null
      and (e->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    perform api_raise('invalid_argument', 'a level id is not a valid uuid',
      jsonb_build_object('field', 'id', 'reason', 'malformed uuid'));
  end if;

  -- Levels kept vs. removed (by id; id: null means a new level).
  select coalesce(array_agg((e->>'id')::uuid), '{}')
    into v_kept_ids
    from jsonb_array_elements(p_levels) e
    where (e->>'id') is not null;

  select coalesce(array_agg(hl.id), '{}')
    into v_removed_ids
    from hierarchy_levels hl
    where hl.org_id = v_org_id
      and not (hl.id = any(v_kept_ids));

  -- 7. a level being removed still has nodes.
  if exists (select 1 from nodes nd where nd.level_id = any(v_removed_ids)) then
    perform api_raise('level_in_use', 'a level being removed still has nodes',
      jsonb_build_object('level_ids', to_jsonb(v_removed_ids)));
  end if;

  -- 8. D72: the schedulable lock. Only relevant if the schedulable level is
  -- actually changing.
  select hl.id into v_old_schedulable_level_id
    from hierarchy_levels hl
    where hl.org_id = v_org_id and hl.is_schedulable;

  select (e->>'id')::uuid into v_new_schedulable_level_id
    from jsonb_array_elements(p_levels) e
    where (e->>'is_schedulable')::boolean is true;

  if v_old_schedulable_level_id is not null
     and v_old_schedulable_level_id is distinct from v_new_schedulable_level_id
  then
    select count(*) into v_run_count
      from runs run_row
      join nodes nd on nd.id = run_row.node_id
      where nd.level_id = v_old_schedulable_level_id;

    v_blocking_count := v_run_count;

    -- D72's second half: after P1-4e a direct assignment can exist with no
    -- run at all, so a zero run count does not mean the level is free.
    if v_blocking_count = 0 then
      select count(*) into v_assignment_count
        from assignments asn
        join nodes nd on nd.id = asn.node_id
        where nd.level_id = v_old_schedulable_level_id;
      v_blocking_count := v_assignment_count;
    end if;

    if v_blocking_count > 0 then
      perform api_raise('schedulable_level_locked',
        'the current schedulable level still has scheduled work',
        jsonb_build_object('blocking_rows', v_blocking_count, 'level_id', v_old_schedulable_level_id));
    end if;
  end if;

  -- ---- Write, in three passes (F1/F2). ----
  update hierarchy_levels set is_schedulable = false where org_id = v_org_id;
  update hierarchy_levels set position = position + 1000 where org_id = v_org_id;

  v_idx := 0;
  for v_entry in select * from jsonb_array_elements(p_levels)
  loop
    v_id   := (v_entry->>'id')::uuid;
    v_name := app_trim_ws(v_entry->>'name');
    if v_id is null then
      insert into hierarchy_levels (org_id, position, name, is_schedulable)
        values (v_org_id, v_idx, v_name, false);
    else
      update hierarchy_levels set position = v_idx, name = v_name
        where id = v_id and org_id = v_org_id;
    end if;
    v_idx := v_idx + 1;
  end loop;

  delete from hierarchy_levels where id = any(v_removed_ids);

  select (ord.i - 1) into v_schedulable_idx
    from jsonb_array_elements(p_levels) with ordinality as ord(e, i)
    where (ord.e->>'is_schedulable')::boolean is true;

  update hierarchy_levels set is_schedulable = true
    where org_id = v_org_id and position = v_schedulable_idx;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', hl.id, 'position', hl.position, 'name', hl.name,
           'is_schedulable', hl.is_schedulable) order by hl.position), '[]'::jsonb)
    into v_result
    from hierarchy_levels hl
    where hl.org_id = v_org_id;

  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- create_node — unchanged from 0010 except the app_trim_ws call(s).
-- ----------------------------------------------------------------------------
create or replace function create_node(p_parent_id uuid, p_name text, p_sort_order int default 0)
returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id            uuid;
  v_name              text;
  v_parent_path       ltree;
  v_parent_position   int;
  v_level_id          uuid;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
  v_node              nodes%rowtype;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(p_name);
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  if p_parent_id is null then
    select id into v_level_id from hierarchy_levels where org_id = v_org_id and position = 0;
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = p_parent_id and org_id = v_org_id;
    if v_parent_path is null then
      perform api_raise('invalid_argument', 'parent node not found',
        jsonb_build_object('field', 'p_parent_id', 'reason', 'not found'));
    end if;

    select hl.position into v_parent_position
      from nodes n join hierarchy_levels hl on hl.id = n.level_id
      where n.id = p_parent_id;

    select id into v_level_id
      from hierarchy_levels where org_id = v_org_id and position = v_parent_position + 1;
    if v_level_id is null then
      perform api_raise('level_mismatch', 'no hierarchy level exists one position below the parent',
        jsonb_build_object('node_id', p_parent_id));
    end if;

    v_prospective_path := v_parent_path || slugify(v_name)::ltree;
  end if;

  select id into v_existing_node_id
    from nodes where org_id = v_org_id and path = v_prospective_path;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  -- D2 (found in design-session verification, Aug 25): an explicit NULL for
  -- p_sort_order bypasses the function signature's own `DEFAULT 0` (that
  -- default only applies when the argument is omitted entirely, not when a
  -- caller passes NULL outright), and an uncoalesced NULL insert raised a
  -- raw 23502 outside the closed error set. move_node already guards this
  -- correctly (coalesce(p_sort_order, sort_order)); create_node did not.
  insert into nodes (org_id, level_id, parent_id, name, sort_order)
    values (v_org_id, v_level_id, p_parent_id, v_name, coalesce(p_sort_order, 0))
    returning * into v_node;

  return jsonb_build_object(
    'id', v_node.id, 'name', v_node.name, 'path', v_node.path::text,
    'parent_id', v_node.parent_id, 'level_id', v_node.level_id,
    'sort_order', v_node.sort_order, 'active', v_node.active);
end;
$$;

-- ----------------------------------------------------------------------------
-- rename_node — unchanged from 0010 except the app_trim_ws call(s).
-- ----------------------------------------------------------------------------
create or replace function rename_node(p_node_id uuid, p_name text) returns jsonb
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_org_id            uuid;
  v_name              text;
  v_node              nodes%rowtype;
  v_parent_path       ltree;
  v_prospective_path  ltree;
  v_existing_node_id  uuid;
begin
  if not app_is_admin() then
    perform api_raise('not_permitted', 'admin role required', jsonb_build_object());
  end if;

  v_org_id := app_current_org();
  v_name := app_trim_ws(p_name);
  if v_name = '' then
    perform api_raise('invalid_argument', 'name must not be blank',
      jsonb_build_object('field', 'p_name', 'reason', 'blank name'));
  end if;

  select * into v_node from nodes where id = p_node_id and org_id = v_org_id;
  if v_node.id is null then
    perform api_raise('invalid_argument', 'node not found',
      jsonb_build_object('field', 'p_node_id', 'reason', 'not found'));
  end if;

  if v_node.parent_id is null then
    v_prospective_path := slugify(v_name)::ltree;
  else
    select path into v_parent_path from nodes where id = v_node.parent_id;
    v_prospective_path := v_parent_path || slugify(v_name)::ltree;
  end if;

  -- Exclude the node itself, or renaming a node to its own current name
  -- (or to a different name that happens to slugify the same) would report
  -- a collision against itself.
  select id into v_existing_node_id
    from nodes
    where org_id = v_org_id and path = v_prospective_path and id <> p_node_id;
  if v_existing_node_id is not null then
    perform api_raise('path_collision', 'a node with this path already exists',
      jsonb_build_object('path', v_prospective_path::text, 'existing_node_id', v_existing_node_id));
  end if;

  update nodes set name = v_name where id = p_node_id
    returning * into v_node;

  return jsonb_build_object('id', v_node.id, 'name', v_node.name, 'path', v_node.path::text);
end;
$$;

