-- ============================================================================
-- 0067 --- NAMED WEEK TEMPLATES, APPLIED THROUGH COPY WEEK (R-356, S35).
--
-- The maintainer, 7 Sept, from three options side by side (a whole week with
-- its people; jobs only; a daily pattern per line): a template is a NAMED COPY
-- OF ONE WEEK'S RUNS WITH THEIR ASSIGNMENTS, stored relative to that week's
-- Monday, belonging to the plant it was saved from. Saving one is "Save this
-- week as a template"; applying one is Copy Week with the template as the
-- source instead of another week --- so every clash rule, the preview and the
-- choose-per-clash flow apply UNCHANGED, and nothing is written that Copy Week
-- would not write. A template is listed, renamed and deleted by the plant's
-- admins; a supervisor can apply one to a week they can place on and cannot
-- delete one.
--
-- ⚠️ WHY THIS IS 0067 AND NOT THE BRIEFED 0065. Lane D's migration 0066
-- (absences) re-emits `copy_week_plan` to add the `absent` clash reason. Files
-- are applied in filename order (`run-sql-test.sh`, `supabase db reset`), so a
-- template-aware `copy_week_plan` numbered 0065 would be clobbered by 0066's
-- re-emit on every fresh build, leaving an `absent`-but-template-less function
-- --- or, once this file drops the 3-arg and creates a 4-arg, TWO overloads
-- and an ambiguous PostgREST call. So the template branch must run AFTER 0066.
-- This file is based on the LIVE definition of `copy_week_plan` (post-0066,
-- `absent` included, read with `pg_get_functiondef`, CLAUDE.md section 4), and
-- carries `absent` through to a template source exactly as to a week source.
--
-- ⭐ ONE READER OF A WEEK. `save_week_template` snapshots the week through the
-- SAME two source reads `copy_week_plan`'s week branch uses --- the same WHERE
-- clauses, filters and copied fields --- so the snapshot and the plan can never
-- disagree about what a week contains. The snapshot is a SECURITY DEFINER
-- write, so it re-states the runs/assignments SELECT RLS itself
-- (`app_can_read_node`, the exact predicate `runs_select`/`assignments_select`
-- carry) rather than reading past it: a Line-1 supervisor's template holds
-- exactly the rows her invoker plan would have read, no more.
--
-- ⭐ WHO MAY SAVE/APPLY (DEFINER, ORG-GUARDED). Copy Week from another WEEK is
-- admin-only and stays so (`app_is_admin_for`). A TEMPLATE source is gated on
-- `app_can_place_in_plant` --- admin, or a supervisor whose edit grant overlaps
-- the plant --- so a line supervisor may apply one to a week she can place on
-- (R-356). The predicate guards the org boundary as a definer (DEF-0016/0017's
-- lesson: anything resolved by walking the tree is resolved by the server, not
-- the caller's view). Rename and delete are `app_is_admin_for`; a viewer places
-- nowhere and is refused everywhere it writes.
--
-- ⭐ RELATIVE TIME, AND WHY IT MATERIALISES BACK EXACTLY. A run at instant T in
-- the source week is stored as `day_offset` (0-6 from the source Monday) and
-- `start_min`/`end_min` (minutes from THAT day's midnight; an overnight item's
-- `end_min` exceeds 1440). Materialising onto the target Monday is
-- `target_mid + day_offset days + start_min min`. That is algebraically the
-- same instant a whole-week shift produces (`lower(T) + (target - source)
-- days`), because a session in UTC (the app's convention, 0055) adds interval
-- days linearly with no DST wall-clock nudge --- so a plan from a template
-- equals a plan from the week it was saved from, item for item, on the same
-- target (89: TP-EQ). Both branches add `make_interval(days => ...)` the one
-- way 0055 already does.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1. The tables.
-- ----------------------------------------------------------------------------

-- A template belongs to the plant it was saved from (D3 composite FK, and a
-- plant-root guard the writer enforces --- a table CHECK cannot call the
-- org-scoped definer `app_node_is_plant_root`). Case-insensitive unique name
-- per plant. Standard audit columns + triggers.
create table week_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id),
  plant_id    uuid not null,
  name        text not null,
  saved_from  date not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint week_templates_name_nonblank check (btrim(name) <> ''),
  foreign key (org_id, plant_id) references nodes (org_id, id)   -- D3
);
-- One name per plant, however it is cased ("Day shift" and "day shift" clash).
create unique index week_templates_plant_name_uniq
  on week_templates (org_id, plant_id, lower(name));

-- The snapshot. `item_ref` is the source row's id (a run's key so an assignment
-- item can point at its run item by `run_ref`); unique per template. Every
-- field Copy Week copies from a run and an assignment TODAY (0055's copied
-- set), stored relative to the source Monday. node/operator/product ids are a
-- point-in-time snapshot and carry NO foreign key: a later delete makes an item
-- history the same way a deleted product makes a run history (D110), and the
-- apply simply never writes it.
create table week_template_items (
  id                   uuid primary key default gen_random_uuid(),
  template_id          uuid not null references week_templates(id) on delete cascade,
  kind                 text not null check (kind in ('run','assignment')),
  item_ref             text not null,
  run_ref              text,                 -- assignment item -> its run item's item_ref
  node_id              uuid not null,
  operator_id          uuid,
  product_id           uuid,
  day_offset           int  not null check (day_offset between 0 and 6),
  start_min            int  not null check (start_min >= 0),
  end_min              int  not null check (end_min > start_min),
  planned_headcount    int,
  notes                text,
  efficiency           numeric,
  target_qty           numeric,
  target_unit          text,
  area_override        boolean not null default false,
  area_override_reason text,
  unique (template_id, item_ref)
);
create index week_template_items_template_idx on week_template_items (template_id);

create trigger week_templates_set_updated_at
  before update on week_templates
  for each row execute function set_updated_at();

create trigger week_templates_audit
  after insert or update or delete on week_templates
  for each row execute function write_audit_log();

alter table week_templates      enable row level security;
alter table week_template_items enable row level security;

-- Readable by anyone who can read the plant (`app_can_read_in_plant`, 0058 ---
-- a Line-1 grant reads its plant's templates so a supervisor can pick one to
-- apply). No insert/update/delete policy: every write goes through the DEFINER
-- RPCs below, and a direct write is refused twice over (no privilege, no
-- policy). anon reaches none of it.
create policy week_templates_select on week_templates for select
  using (org_id = app_current_org() and app_can_read_in_plant(plant_id));

create policy week_template_items_select on week_template_items for select
  using (exists (
    select 1 from week_templates t
     where t.id = template_id
       and t.org_id = app_current_org()
       and app_can_read_in_plant(t.plant_id)
  ));

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on week_templates to authenticated';
    execute 'grant select on week_template_items to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on week_templates from anon';
    execute 'revoke all on week_template_items from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §2. `app_can_place_in_plant` --- admin, or a supervisor whose edit grant
--     overlaps the plant. The read twin is `app_can_read_in_plant` (0058); this
--     is its edit-capable analog (`app_grant_paths(true)` = admin+supervisor).
--     SECURITY DEFINER and org-scoped so a caller who cannot READ the plant
--     root above her grant is still answered for the plant she places in.
-- ----------------------------------------------------------------------------
create or replace function app_can_place_in_plant(p_plant_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT app_is_admin()
      OR EXISTS (
           SELECT 1
             FROM nodes n, app_grant_paths(true) gp
            WHERE n.id = p_plant_id
              AND n.org_id = app_current_org()
              AND (n.path <@ gp OR gp <@ n.path)
         );
$function$;

revoke execute on function app_can_place_in_plant(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_can_place_in_plant(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_can_place_in_plant(uuid) from anon';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- `app_plant_root_of` --- the PLANT ROOT above any node the caller can see. The
-- board opens a supervisor on the TOP OF HER VISIBLE FOREST (a department or a
-- line), never the plant root above her grant, so the toolbar has a node inside
-- the plant, not the plant. A template belongs to the PLANT, and resolving
-- which plant a node sits in is walking UP the tree past nodes the caller
-- cannot read --- so it is a SECURITY DEFINER's job, not the caller's view
-- (DEF-0016/0017). Same walk shape as 0061's shift-pattern resolver. Org-bounded
-- for a tenant, unbounded for owner context (app_current_org() NULL: the seed).
-- ----------------------------------------------------------------------------
create or replace function app_plant_root_of(p_node_id uuid)
 returns uuid
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT anc.id
    FROM nodes target
    JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
   WHERE target.id = p_node_id
     AND (app_current_org() IS NULL OR target.org_id = app_current_org())
     AND anc.parent_id IS NULL
   LIMIT 1;
$function$;

revoke execute on function app_plant_root_of(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_plant_root_of(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_plant_root_of(uuid) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §3. `save_week_template` --- snapshot a week. SECURITY DEFINER: it writes the
--     template rows (there is no write policy) and re-states the runs/
--     assignments read RLS itself (`app_can_read_node`) so it snapshots exactly
--     what `copy_week_plan`'s INVOKER week branch would read. Gated as a
--     template apply is gated: `app_can_place_in_plant`.
-- ----------------------------------------------------------------------------
create or replace function save_week_template(
  p_plant_id     uuid,
  p_source_start date,
  p_name         text
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant      uuid;
  v_org_id     uuid;
  v_plant_path ltree;
  v_src        tstzrange;
  v_src_mid    timestamptz;
  v_template   uuid;
  v_name       text := btrim(coalesce(p_name, ''));
  v_runs       int;
  v_asg        int;
BEGIN
  -- The board hands the top of the caller's forest, which may sit BELOW the
  -- plant root; resolve up to the plant a template belongs to (DEF-0016/0017).
  IF p_plant_id IS NULL OR NOT app_node_exists_in_org(p_plant_id) THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
  END IF;
  v_plant := app_plant_root_of(p_plant_id);
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
  END IF;

  IF NOT app_can_place_in_plant(v_plant) THEN
    PERFORM api_raise('not_permitted', 'you cannot place on this plant',
      jsonb_build_object('plant_id', v_plant, 'reason', 'cannot_place'));
  END IF;

  IF v_name = '' THEN
    PERFORM api_raise('invalid_argument', 'a template needs a name',
      jsonb_build_object('field', 'p_name', 'reason', 'blank_name'));
  END IF;

  IF p_source_start IS NULL THEN
    PERFORM api_raise('invalid_argument', 'a source week must be given',
      jsonb_build_object('field', 'p_source_start', 'reason', 'null'));
  END IF;

  SELECT n.org_id, n.path INTO v_org_id, v_plant_path FROM nodes n WHERE n.id = v_plant;

  IF EXISTS (SELECT 1 FROM week_templates t
              WHERE t.org_id = v_org_id AND t.plant_id = v_plant
                AND lower(t.name) = lower(v_name)) THEN
    PERFORM api_raise('invalid_argument', 'a template with that name already exists for this plant',
      jsonb_build_object('field', 'p_name', 'name', v_name, 'reason', 'duplicate_name'));
  END IF;

  v_src_mid := p_source_start::timestamptz;
  v_src     := tstzrange(v_src_mid, (p_source_start + 7)::timestamptz, '[)');

  INSERT INTO week_templates (org_id, plant_id, name, saved_from, created_by)
  VALUES (v_org_id, v_plant, v_name, p_source_start, app_current_profile_id())
  RETURNING id INTO v_template;

  -- Runs. The SAME source as copy_week_plan's week run loop (product present,
  -- starts in the week), plus the read RLS this definer must re-state.
  INSERT INTO week_template_items
    (template_id, kind, item_ref, run_ref, node_id, operator_id, product_id,
     day_offset, start_min, end_min, planned_headcount, notes,
     efficiency, target_qty, target_unit, area_override, area_override_reason)
  SELECT v_template, 'run', x.id::text, NULL, x.node_id, NULL, x.product_id,
         off.day_offset,
         round((off.start_sec - off.day_offset * 86400) / 60.0)::int,
         round((off.end_sec   - off.day_offset * 86400) / 60.0)::int,
         x.planned_headcount, x.notes,
         NULL, NULL, NULL, false, NULL
    FROM runs x
    JOIN nodes n ON n.id = x.node_id
    CROSS JOIN LATERAL (
      SELECT extract(epoch from (lower(x.timerange) - v_src_mid)) AS start_sec,
             extract(epoch from (upper(x.timerange) - v_src_mid)) AS end_sec,
             floor(extract(epoch from (lower(x.timerange) - v_src_mid)) / 86400)::int AS day_offset
    ) off
   WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
     AND v_src @> lower(x.timerange)
     AND x.product_id IS NOT NULL
     AND app_can_read_node(x.node_id);

  -- Assignments. The SAME source as copy_week_plan's week assignment loop
  -- (a person, and either its own product or an in-week run that has one).
  INSERT INTO week_template_items
    (template_id, kind, item_ref, run_ref, node_id, operator_id, product_id,
     day_offset, start_min, end_min, planned_headcount, notes,
     efficiency, target_qty, target_unit, area_override, area_override_reason)
  SELECT v_template, 'assignment', x.id::text, x.run_id::text, x.node_id, x.operator_id,
         COALESCE(x.product_id, xr.product_id),
         off.day_offset,
         round((off.start_sec - off.day_offset * 86400) / 60.0)::int,
         round((off.end_sec   - off.day_offset * 86400) / 60.0)::int,
         NULL, NULL,
         x.efficiency, x.target_qty, x.target_unit, x.area_override, x.area_override_reason
    FROM assignments x
    JOIN nodes n ON n.id = x.node_id
    LEFT JOIN runs xr ON xr.id = x.run_id
    CROSS JOIN LATERAL (
      SELECT extract(epoch from (lower(x.timerange) - v_src_mid)) AS start_sec,
             extract(epoch from (upper(x.timerange) - v_src_mid)) AS end_sec,
             floor(extract(epoch from (lower(x.timerange) - v_src_mid)) / 86400)::int AS day_offset
    ) off
   WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
     AND v_src @> lower(x.timerange)
     AND x.operator_id IS NOT NULL
     AND ((x.run_id IS NULL AND x.product_id IS NOT NULL)
          OR (x.run_id IS NOT NULL AND xr.product_id IS NOT NULL AND v_src @> lower(xr.timerange)))
     AND app_can_read_node(x.node_id);

  SELECT count(*) FILTER (WHERE kind = 'run'),
         count(*) FILTER (WHERE kind = 'assignment')
    INTO v_runs, v_asg
    FROM week_template_items WHERE template_id = v_template;

  RETURN jsonb_build_object(
    'id', v_template, 'plant_id', v_plant, 'name', v_name,
    'saved_from', p_source_start,
    'counts', jsonb_build_object('runs', v_runs, 'assignments', v_asg));
END $function$;

revoke execute on function save_week_template(uuid, date, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function save_week_template(uuid, date, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function save_week_template(uuid, date, text) from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §4. list / rename / delete. List is a read (anyone who can read the plant);
--     rename and delete are `app_is_admin_for` --- the plant's admins.
-- ----------------------------------------------------------------------------
create or replace function list_week_templates(p_plant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
  v_out   jsonb;
BEGIN
  IF p_plant_id IS NULL OR NOT app_node_exists_in_org(p_plant_id) THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'reason', 'not_a_plant'));
  END IF;
  v_plant := app_plant_root_of(p_plant_id);   -- resolve up to the plant (DEF-0016/0017)
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'reason', 'not_a_plant'));
  END IF;
  IF NOT app_can_read_in_plant(v_plant) THEN
    PERFORM api_raise('not_permitted', 'you cannot read this plant',
      jsonb_build_object('plant_id', v_plant, 'reason', 'cannot_read'));
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'saved_from', t.saved_from,
           'runs', t.n_runs, 'assignments', t.n_asg,
           'created_at', t.created_at)
           ORDER BY lower(t.name), t.id), '[]'::jsonb)
    INTO v_out
    FROM (
      SELECT wt.id, wt.name, wt.saved_from, wt.created_at,
             count(i.*) FILTER (WHERE i.kind = 'run')        AS n_runs,
             count(i.*) FILTER (WHERE i.kind = 'assignment') AS n_asg
        FROM week_templates wt
        LEFT JOIN week_template_items i ON i.template_id = wt.id
       WHERE wt.org_id = app_current_org() AND wt.plant_id = v_plant
       GROUP BY wt.id, wt.name, wt.saved_from, wt.created_at
    ) t;

  RETURN v_out;
END $function$;

create or replace function rename_week_template(p_template_id uuid, p_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
  v_org   uuid;
  v_name  text := btrim(coalesce(p_name, ''));
BEGIN
  SELECT plant_id, org_id INTO v_plant, v_org FROM week_templates WHERE id = p_template_id;
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such template',
      jsonb_build_object('field', 'p_template_id', 'reason', 'no_such_template'));
  END IF;
  IF NOT app_is_admin_for(v_plant) THEN
    PERFORM api_raise('not_permitted', 'only this plant''s admins may rename a template',
      jsonb_build_object('plant_id', v_plant, 'reason', 'not_admin'));
  END IF;
  IF v_name = '' THEN
    PERFORM api_raise('invalid_argument', 'a template needs a name',
      jsonb_build_object('field', 'p_name', 'reason', 'blank_name'));
  END IF;
  IF EXISTS (SELECT 1 FROM week_templates t
              WHERE t.org_id = v_org AND t.plant_id = v_plant
                AND lower(t.name) = lower(v_name) AND t.id <> p_template_id) THEN
    PERFORM api_raise('invalid_argument', 'a template with that name already exists for this plant',
      jsonb_build_object('field', 'p_name', 'name', v_name, 'reason', 'duplicate_name'));
  END IF;

  UPDATE week_templates SET name = v_name WHERE id = p_template_id;
  RETURN jsonb_build_object('id', p_template_id, 'name', v_name);
END $function$;

create or replace function delete_week_template(p_template_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant uuid;
BEGIN
  SELECT plant_id INTO v_plant FROM week_templates WHERE id = p_template_id;
  IF v_plant IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such template',
      jsonb_build_object('field', 'p_template_id', 'reason', 'no_such_template'));
  END IF;
  IF NOT app_is_admin_for(v_plant) THEN
    PERFORM api_raise('not_permitted', 'only this plant''s admins may delete a template',
      jsonb_build_object('plant_id', v_plant, 'reason', 'not_admin'));
  END IF;

  DELETE FROM week_templates WHERE id = p_template_id;   -- items cascade
  RETURN jsonb_build_object('id', p_template_id, 'deleted', true);
END $function$;

revoke execute on function list_week_templates(uuid)          from public;
revoke execute on function rename_week_template(uuid, text)   from public;
revoke execute on function delete_week_template(uuid)         from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function list_week_templates(uuid)        to authenticated';
    execute 'grant execute on function rename_week_template(uuid, text) to authenticated';
    execute 'grant execute on function delete_week_template(uuid)       to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function list_week_templates(uuid)        from anon';
    execute 'revoke all on function rename_week_template(uuid, text) from anon';
    execute 'revoke all on function delete_week_template(uuid)       from anon';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- §5. `copy_week_plan` and `apply_copy_week` gain `p_template_id`. Re-emitted
--     from the LIVE (post-0066) definitions with the source of the two loops
--     made a UNION: exactly one arm has rows (the week arm requires
--     `p_template_id IS NULL`; the template arm matches on `template_id`), so
--     the clash logic below is ONE copy, shared by both sources --- a plan from
--     a template runs the same code a plan from a week does. The old 3-arg /
--     4-arg signatures are dropped so a named call is never ambiguous.
-- ----------------------------------------------------------------------------
drop function if exists apply_copy_week(uuid, date, date, jsonb);
drop function if exists copy_week_plan(uuid, date, date);

create or replace function copy_week_plan(
  p_plant_id     uuid,
  p_source_start date,
  p_target_start date,
  p_template_id  uuid default null
) returns jsonb
 language plpgsql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plant      uuid;
  v_org_id     uuid;
  v_plant_path ltree;
  v_days       int := 0;
  v_shift      interval;
  v_src        tstzrange;
  v_new        tstzrange;
  v_items      jsonb := '[]'::jsonb;
  v_clean      int := 0;
  v_clash      int := 0;
  v_hist_runs  int := 0;
  v_hist_asg   int := 0;
  r            record;
  a            record;
  v_prior      jsonb;
  v_elig       jsonb;
  v_probe      jsonb;
  v_absence    jsonb;    -- R-357
  v_is_absent  boolean;  -- R-357
  v_reason     text;
  v_policy     text;
  v_choices    jsonb;
  v_clash_obj  jsonb;
  v_uneditable boolean;
  v_fits       boolean;
  v_echo_src   date;
BEGIN
  IF p_plant_id IS NULL OR NOT app_node_exists_in_org(p_plant_id) THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
  END IF;

  -- A TEMPLATE source may be opened from any node inside a plant (a supervisor's
  -- board root sits below the plant root), so resolve up to the plant. A WEEK
  -- source stays strict: it is admin-only, and an admin's board root IS the
  -- plant root, so a non-root node is `not_a_plant` as before (CW1).
  IF p_template_id IS NOT NULL THEN
    v_plant := app_plant_root_of(p_plant_id);
    IF v_plant IS NULL THEN
      PERFORM api_raise('invalid_argument', 'that is not a plant',
        jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
    END IF;
  ELSE
    IF NOT app_node_is_plant_root(p_plant_id) THEN
      PERFORM api_raise('invalid_argument', 'that is not a plant',
        jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
    END IF;
    v_plant := p_plant_id;
  END IF;

  SELECT n.org_id, n.path INTO v_org_id, v_plant_path FROM nodes n WHERE n.id = v_plant;

  IF p_template_id IS NOT NULL THEN
    -- ⭐ TEMPLATE SOURCE (R-356): the copied set is the template's items,
    -- materialised onto p_target_start. Gated on placing, not admin.
    -- Keyed on id + plant only: a plant id is globally unique (nodes PK) and
    -- `app_plant_root_of` already org-bounds v_plant to the caller, so this
    -- does not read v_org_id --- an INVOKER cannot read the plant node above a
    -- supervisor's grant, and v_org_id is NULL for her (DEF-0016/0017).
    IF NOT EXISTS (SELECT 1 FROM week_templates t
                    WHERE t.id = p_template_id AND t.plant_id = v_plant) THEN
      PERFORM api_raise('invalid_argument', 'no such template for this plant',
        jsonb_build_object('field', 'p_template_id', 'template_id', p_template_id, 'reason', 'no_such_template'));
    END IF;
    IF NOT app_can_place_in_plant(v_plant) THEN
      PERFORM api_raise('not_permitted', 'you cannot place on this plant',
        jsonb_build_object('plant_id', v_plant, 'reason', 'cannot_place'));
    END IF;
    IF p_target_start IS NULL THEN
      PERFORM api_raise('invalid_argument', 'a target week must be given',
        jsonb_build_object('field', 'p_target_start', 'reason', 'null'));
    END IF;
    -- Nothing to echo from a template; keep the wire shape valid (a string
    -- source_start and a numeric shift_days the client parser expects).
    v_echo_src := p_target_start;
    v_days     := 0;
  ELSE
    IF NOT app_is_admin_for(v_plant) THEN
      PERFORM api_raise('not_permitted', 'you do not administer this plant',
        jsonb_build_object('plant_id', v_plant, 'reason', 'not_admin'));
    END IF;
    IF p_source_start IS NULL OR p_target_start IS NULL THEN
      PERFORM api_raise('invalid_argument', 'both weeks must be given',
        jsonb_build_object('field', 'p_source_start/p_target_start', 'reason', 'null'));
    END IF;
    v_days := p_target_start - p_source_start;
    IF v_days = 0 THEN
      PERFORM api_raise('invalid_argument', 'the source and target weeks are the same week',
        jsonb_build_object('source_start', p_source_start, 'target_start', p_target_start, 'reason', 'same_week'));
    END IF;
    IF v_days % 7 <> 0 THEN
      PERFORM api_raise('invalid_argument', 'the target week must be a whole number of weeks from the source week',
        jsonb_build_object('source_start', p_source_start, 'target_start', p_target_start,
                           'days', v_days, 'reason', 'not_whole_weeks'));
    END IF;
    v_shift    := make_interval(days => v_days);
    v_src      := tstzrange(p_source_start::timestamptz, (p_source_start + 7)::timestamptz, '[)');
    v_echo_src := p_source_start;

    SELECT count(*) INTO v_hist_runs
      FROM runs x JOIN nodes n ON n.id = x.node_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND x.product_id IS NULL;

    SELECT count(*) INTO v_hist_asg
      FROM assignments x JOIN nodes n ON n.id = x.node_id
      LEFT JOIN runs xr ON xr.id = x.run_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND (x.operator_id IS NULL
            OR (x.run_id IS NULL AND x.product_id IS NULL)
            OR (x.run_id IS NOT NULL AND xr.product_id IS NULL AND v_src @> lower(xr.timerange)));
  END IF;

  -- ---- RUNS: one clash body over a week OR a template source ---------------
  FOR r IN
    SELECT src.idtext, src.node_id, src.node_name, src.product_id, src.product_name,
           src.new_start, src.new_end, src.planned_headcount, src.notes
      FROM (
        SELECT x.id::text AS idtext, x.node_id, n.name AS node_name,
               x.product_id, pr.name AS product_name,
               lower(x.timerange) + v_shift AS new_start,
               upper(x.timerange) + v_shift AS new_end,
               x.planned_headcount, x.notes,
               lower(x.timerange) AS ord_start
          FROM runs x
          JOIN nodes n ON n.id = x.node_id
          LEFT JOIN products pr ON pr.id = x.product_id
         WHERE p_template_id IS NULL
           AND n.path <@ v_plant_path AND n.org_id = v_org_id
           AND v_src @> lower(x.timerange)
           AND x.product_id IS NOT NULL
        UNION ALL
        SELECT i.item_ref AS idtext, i.node_id, n.name AS node_name,
               i.product_id, pr.name AS product_name,
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.start_min)),
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.end_min)),
               i.planned_headcount, i.notes,
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.start_min)) AS ord_start
          FROM week_template_items i
          -- LEFT JOIN so a node the caller cannot read is not silently DROPPED
          -- from her plan (it lands with a null name and the writer refuses it
          -- at apply, rolling the whole copy back rather than a silent partial).
          LEFT JOIN nodes n ON n.id = i.node_id
          LEFT JOIN products pr ON pr.id = i.product_id
         WHERE i.template_id = p_template_id AND i.kind = 'run'
      ) src
     ORDER BY src.ord_start, src.node_name, src.idtext
  LOOP
    v_new := tstzrange(r.new_start, r.new_end, '[)');

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', x.id, 'kind', 'run', 'node_name', r.node_name,
             'product_name', COALESCE(px.name, x.product_name), 'operator_name', NULL,
             'start', lower(x.timerange), 'end', upper(x.timerange))
             ORDER BY lower(x.timerange), x.id), '[]'::jsonb)
      INTO v_prior
      FROM runs x LEFT JOIN products px ON px.id = x.product_id
     WHERE x.node_id = r.node_id AND x.timerange && v_new;

    IF jsonb_array_length(v_prior) > 0 THEN
      v_clash := v_clash + 1;
      v_clash_obj := jsonb_build_object('reason', 'run_overlap', 'policy', NULL,
                                        'prior', v_prior,
                                        'choices', '["prior","copied"]'::jsonb);
    ELSE
      v_clean := v_clean + 1;
      v_clash_obj := NULL;
    END IF;

    v_items := v_items || jsonb_build_object(
      'key', 'run:' || r.idtext,
      'kind', 'run',
      'parent_key', NULL,
      'copied', jsonb_build_object(
        'node_id', r.node_id, 'node_name', r.node_name,
        'product_id', r.product_id, 'product_name', r.product_name,
        'operator_id', NULL, 'operator_name', NULL,
        'start', lower(v_new), 'end', upper(v_new),
        'planned_headcount', r.planned_headcount, 'notes', r.notes,
        'efficiency', NULL, 'target_qty', NULL, 'target_unit', NULL),
      'status', CASE WHEN v_clash_obj IS NULL THEN 'clean' ELSE 'clash' END,
      'clash', v_clash_obj);
  END LOOP;

  -- ---- ASSIGNMENTS: one clash body over a week OR a template source --------
  FOR a IN
    SELECT src.idtext, src.node_id, src.node_name, src.operator_id, src.operator_name,
           src.run_idtext, src.product_id, src.product_name,
           src.new_start, src.new_end, src.efficiency, src.target_qty, src.target_unit,
           src.area_override, src.area_override_reason
      FROM (
        SELECT x.id::text AS idtext, x.node_id, n.name AS node_name,
               x.operator_id, COALESCE(o.display_name, x.operator_display_name) AS operator_name,
               x.run_id::text AS run_idtext,
               COALESCE(x.product_id, xr.product_id) AS product_id,
               COALESCE(pr.name, prr.name) AS product_name,
               lower(x.timerange) + v_shift AS new_start,
               upper(x.timerange) + v_shift AS new_end,
               x.efficiency, x.target_qty, x.target_unit,
               x.area_override, x.area_override_reason,
               lower(x.timerange) AS ord_start, o.display_name AS ord_op
          FROM assignments x
          JOIN nodes n ON n.id = x.node_id
          LEFT JOIN operators o ON o.id = x.operator_id
          LEFT JOIN products pr ON pr.id = x.product_id
          LEFT JOIN runs xr ON xr.id = x.run_id
          LEFT JOIN products prr ON prr.id = xr.product_id
         WHERE p_template_id IS NULL
           AND n.path <@ v_plant_path AND n.org_id = v_org_id
           AND v_src @> lower(x.timerange)
           AND x.operator_id IS NOT NULL
           AND ((x.run_id IS NULL AND x.product_id IS NOT NULL)
                OR (x.run_id IS NOT NULL AND xr.product_id IS NOT NULL AND v_src @> lower(xr.timerange)))
        UNION ALL
        SELECT i.item_ref AS idtext, i.node_id, n.name AS node_name,
               i.operator_id, o.display_name AS operator_name,
               i.run_ref AS run_idtext,
               i.product_id, pr.name AS product_name,
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.start_min)),
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.end_min)),
               i.efficiency, i.target_qty, i.target_unit,
               i.area_override, i.area_override_reason,
               (p_target_start::timestamptz + make_interval(days => i.day_offset) + make_interval(mins => i.start_min)) AS ord_start,
               o.display_name AS ord_op
          FROM week_template_items i
          LEFT JOIN nodes n ON n.id = i.node_id
          LEFT JOIN operators o ON o.id = i.operator_id
          LEFT JOIN products pr ON pr.id = i.product_id
         WHERE i.template_id = p_template_id AND i.kind = 'assignment'
      ) src
     ORDER BY src.ord_start, src.node_name, src.ord_op, src.idtext
  LOOP
    v_new := tstzrange(a.new_start, a.new_end, '[)');

    v_elig  := check_eligibility(a.node_id, a.operator_id, v_new);
    v_probe := capacity_probe(a.operator_id, v_new, a.efficiency, NULL);
    v_fits  := COALESCE((v_probe->>'fits')::boolean, true);
    -- R-357: the absence question, same shifted window, same predicate the
    -- board and the writers use.
    v_absence   := absence_overlap(a.operator_id, v_new);
    v_is_absent := (v_absence->>'absent')::boolean;

    IF NOT v_fits THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', x.id, 'kind', 'assignment', 'node_name', xn.name,
               'product_name', COALESCE(xp.name, xrp.name, x.product_name),
               'operator_name', COALESCE(xo.display_name, x.operator_display_name),
               'start', lower(x.timerange), 'end', upper(x.timerange))
               ORDER BY lower(x.timerange), x.id), '[]'::jsonb),
             COALESCE(bool_or(NOT app_can_edit_node(x.node_id)), false)
        INTO v_prior, v_uneditable
        FROM assignments x
        JOIN nodes xn ON xn.id = x.node_id
        LEFT JOIN operators xo ON xo.id = x.operator_id
        LEFT JOIN products xp ON xp.id = x.product_id
        LEFT JOIN runs xr ON xr.id = x.run_id
        LEFT JOIN products xrp ON xrp.id = xr.product_id
       WHERE x.operator_id = a.operator_id AND x.timerange && v_new;
    ELSE
      v_prior := '[]'::jsonb;
      v_uneditable := false;
    END IF;

    v_reason := NULL; v_policy := NULL;
    IF NOT (v_elig->>'eligible')::boolean THEN
      v_reason := 'not_eligible';
      v_policy := v_elig->>'policy';
    ELSIF v_is_absent THEN
      v_reason := 'absent';
      v_policy := v_elig->>'policy';
    ELSIF NOT v_fits THEN
      v_reason := 'operator_busy';
    END IF;

    IF v_reason IS NULL THEN
      v_clean := v_clean + 1;
      v_clash_obj := NULL;
    ELSE
      v_clash := v_clash + 1;
      IF v_policy = 'block' OR (NOT v_fits AND v_uneditable) THEN
        v_choices := '["prior"]'::jsonb;
      ELSE
        v_choices := '["prior","copied"]'::jsonb;
      END IF;
      v_clash_obj := jsonb_build_object('reason', v_reason, 'policy', v_policy,
                                        'prior', v_prior, 'choices', v_choices,
                                        'absence', CASE WHEN v_is_absent THEN v_absence ELSE NULL END);
    END IF;

    v_items := v_items || jsonb_build_object(
      'key', 'assignment:' || a.idtext,
      'kind', 'assignment',
      'parent_key', CASE WHEN a.run_idtext IS NOT NULL THEN 'run:' || a.run_idtext END,
      'copied', jsonb_build_object(
        'node_id', a.node_id, 'node_name', a.node_name,
        'product_id', a.product_id, 'product_name', a.product_name,
        'operator_id', a.operator_id, 'operator_name', a.operator_name,
        'start', lower(v_new), 'end', upper(v_new),
        'planned_headcount', NULL, 'notes', NULL,
        'efficiency', a.efficiency, 'target_qty', a.target_qty, 'target_unit', a.target_unit,
        'area_override', a.area_override, 'area_override_reason', a.area_override_reason),
      'status', CASE WHEN v_clash_obj IS NULL THEN 'clean' ELSE 'clash' END,
      'clash', v_clash_obj);
  END LOOP;

  RETURN jsonb_build_object(
    'plant_id', v_plant,
    'source_start', v_echo_src,
    'target_start', p_target_start,
    'shift_days', v_days,
    'counts', jsonb_build_object('clean', v_clean, 'clash', v_clash),
    'history', jsonb_build_object('runs', v_hist_runs, 'assignments', v_hist_asg),
    'items', v_items);
END $function$;

comment on function copy_week_plan(uuid, date, date, uuid) is
  'R-339/R-356: what a copy would do, item by item, from a WEEK source (admin) or a TEMPLATE source (a placer). Writes nothing.';

revoke execute on function copy_week_plan(uuid, date, date, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function copy_week_plan(uuid, date, date, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function copy_week_plan(uuid, date, date, uuid) from anon';
  end if;
end $$;


create or replace function apply_copy_week(
  p_plant_id     uuid,
  p_source_start date,
  p_target_start date,
  p_decisions    jsonb,
  p_template_id  uuid default null
) returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_plan         jsonb;
  v_item         jsonb;
  v_dec          jsonb;
  v_key          text;
  v_choice       text;
  v_decided      jsonb := '{}'::jsonb;   -- key -> choice, as given
  v_undecided    jsonb;
  v_copied       jsonb;
  v_new          tstzrange;
  v_res          jsonb;
  v_run_map      jsonb := '{}'::jsonb;   -- source run key -> new run id
  v_new_run_id   uuid;
  v_prior_id     uuid;
  v_prior_ids    uuid[];
  v_present      int;
  v_deleted      int;
  v_new_run_ids  uuid[] := '{}';
  v_new_asg_ids  uuid[] := '{}';
  v_rm_run_ids   uuid[] := '{}';
  v_rm_asg_ids   uuid[] := '{}';
  v_skipped      int := 0;
  v_elig         jsonb;
  v_probe        jsonb;
  v_override     boolean;
  v_reason       text;
  v_created_runs int;
  v_created_asg  int;
  v_removed_runs int;
  v_removed_asg  int;
  v_tmpl_name    text;
BEGIN
  -- 1. The plan, recomputed here. Its refusals are this function's refusals
  --    too, for a week source and a template source alike.
  v_plan := copy_week_plan(p_plant_id, p_source_start, p_target_start, p_template_id);

  IF p_template_id IS NOT NULL THEN
    SELECT name INTO v_tmpl_name FROM week_templates WHERE id = p_template_id;
  END IF;

  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' THEN
    PERFORM api_raise('invalid_argument', 'p_decisions must be an array of {key, choice}',
      jsonb_build_object('field', 'p_decisions', 'reason', 'not_an_array'));
  END IF;

  -- 2. Index the answers. The same key twice is a client bug.
  FOR v_dec IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
    v_key := v_dec->>'key';
    IF v_key IS NOT NULL AND v_decided ? v_key THEN
      PERFORM api_raise('invalid_argument', 'the same item was answered twice',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'reason', 'duplicate_key'));
    END IF;
    v_decided := v_decided || jsonb_build_object(COALESCE(v_key, ''), COALESCE(v_dec->>'choice', ''));
  END LOOP;

  -- 3a. Every clash item needs an answer.
  SELECT COALESCE(jsonb_agg(i->>'key'), '[]'::jsonb) INTO v_undecided
    FROM jsonb_array_elements(v_plan->'items') i
   WHERE i->>'status' = 'clash' AND NOT (v_decided ? (i->>'key'));
  IF jsonb_array_length(v_undecided) > 0 THEN
    PERFORM api_raise('invalid_argument', 'every clash needs an answer before anything is copied',
      jsonb_build_object('field', 'p_decisions', 'keys', v_undecided, 'reason', 'undecided'));
  END IF;

  -- 3b. Every answer must be one the plan offered (R-239).
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'status' = 'clash'
  LOOP
    v_key := v_item->>'key';
    v_choice := v_decided->>v_key;
    IF NOT (v_item->'clash'->'choices' ? v_choice) THEN
      PERFORM api_raise('invalid_argument', 'that answer was not offered for this item',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'choice', v_choice,
                           'choices', v_item->'clash'->'choices', 'reason', 'choice_not_offered'));
    END IF;
  END LOOP;

  -- 3c. Every answer must be about a clash item.
  FOR v_key IN SELECT k FROM jsonb_object_keys(v_decided) k LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'items') i
                    WHERE i->>'key' = v_key AND i->>'status' = 'clash') THEN
      PERFORM api_raise('invalid_argument', 'that is not a clash item in this plan',
        jsonb_build_object('field', 'p_decisions', 'key', v_key, 'reason', 'unknown_key'));
    END IF;
  END LOOP;

  -- 4. Runs answered "copied" over a clash: the prior runs go WHOLE, crew and
  --    all, through delete_run's cascade mode.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i
     WHERE i->>'kind' = 'run' AND i->>'status' = 'clash'
       AND v_decided->>(i->>'key') = 'copied'
  LOOP
    FOR v_prior_id IN
      SELECT (p->>'id')::uuid FROM jsonb_array_elements(v_item->'clash'->'prior') p
       WHERE p->>'kind' = 'run'
    LOOP
      IF EXISTS (SELECT 1 FROM runs WHERE id = v_prior_id) THEN
        v_rm_asg_ids := v_rm_asg_ids || ARRAY(SELECT id FROM assignments WHERE run_id = v_prior_id);
        v_rm_run_ids := v_rm_run_ids || v_prior_id;
        PERFORM delete_run(v_prior_id, 'cascade');
      END IF;
    END LOOP;
  END LOOP;

  -- 5. Runs: clean ones and clashes answered "copied" are created; clashes
  --    answered "prior" are skipped.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'kind' = 'run'
  LOOP
    v_key := v_item->>'key';
    IF v_item->>'status' = 'clash' AND v_decided->>v_key = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_copied := v_item->'copied';
    v_new := tstzrange((v_copied->>'start')::timestamptz, (v_copied->>'end')::timestamptz, '[)');
    v_res := create_run((v_copied->>'node_id')::uuid,
                        (v_copied->>'product_id')::uuid,
                        v_new,
                        (v_copied->>'planned_headcount')::int,
                        v_copied->>'notes');
    v_new_run_id := (v_res->'run'->>'id')::uuid;
    v_new_run_ids := v_new_run_ids || v_new_run_id;
    v_run_map := v_run_map || jsonb_build_object(v_key, v_new_run_id);
  END LOOP;

  -- 6. Assignments. An attached one whose run was answered "prior" is skipped
  --    before anything else is looked at.
  FOR v_item IN
    SELECT i FROM jsonb_array_elements(v_plan->'items') i WHERE i->>'kind' = 'assignment'
  LOOP
    v_key := v_item->>'key';
    IF v_item->>'parent_key' IS NOT NULL
       AND v_decided->>(v_item->>'parent_key') = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF v_item->>'status' = 'clash' AND v_decided->>v_key = 'prior' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_copied := v_item->'copied';
    v_new := tstzrange((v_copied->>'start')::timestamptz, (v_copied->>'end')::timestamptz, '[)');
    v_override := false;
    v_reason := NULL;

    IF v_item->>'status' = 'clash' THEN
      v_probe := capacity_probe((v_copied->>'operator_id')::uuid, v_new,
                                (v_copied->>'efficiency')::numeric, NULL);
      IF NOT COALESCE((v_probe->>'fits')::boolean, true) THEN
        v_prior_ids := ARRAY(SELECT (p->>'id')::uuid
                               FROM jsonb_array_elements(v_item->'clash'->'prior') p
                              WHERE p->>'kind' = 'assignment');
        SELECT count(*) INTO v_present FROM assignments WHERE id = ANY(v_prior_ids);
        DELETE FROM assignments WHERE id = ANY(v_prior_ids);
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        IF v_deleted <> v_present THEN
          PERFORM api_raise('not_permitted', 'a prior assignment could not be removed',
            jsonb_build_object('key', v_key, 'expected', v_present, 'removed', v_deleted));
        END IF;
        v_rm_asg_ids := v_rm_asg_ids || v_prior_ids;
      END IF;

      -- create_assignment (0030): under warn, an ineligible OR absent placement
      -- is taken only with an override and a reason. Under block the plan never
      -- offered "copied", so this line is not reached.
      v_elig := check_eligibility((v_copied->>'node_id')::uuid, (v_copied->>'operator_id')::uuid, v_new);
      IF NOT (v_elig->>'eligible')::boolean AND v_elig->>'policy' = 'warn' THEN
        v_override := true;
        v_reason := CASE
          WHEN p_template_id IS NOT NULL
            THEN format('Copied from the template %s; the copied plan was chosen over the prior one', v_tmpl_name)
          ELSE format('Copied from the week of %s; the copied plan was chosen over the prior one',
                      to_char(p_source_start, 'YYYY-MM-DD'))
        END;
      END IF;
    END IF;

    IF v_item->>'parent_key' IS NOT NULL THEN
      v_new_run_id := (v_run_map->>(v_item->>'parent_key'))::uuid;
      IF v_new_run_id IS NULL THEN
        PERFORM api_raise('invalid_argument', 'the copied run this assignment belongs to was not created',
          jsonb_build_object('key', v_key, 'parent_key', v_item->>'parent_key', 'reason', 'parent_missing'));
      END IF;
    ELSE
      v_new_run_id := NULL;
    END IF;

    v_res := create_assignment(
      (v_copied->>'node_id')::uuid,
      (v_copied->>'operator_id')::uuid,
      v_new_run_id,
      CASE WHEN v_new_run_id IS NULL THEN (v_copied->>'product_id')::uuid END,
      v_new,
      (v_copied->>'efficiency')::numeric,
      (v_copied->>'target_qty')::numeric,
      v_copied->>'target_unit',
      v_override,
      v_reason,
      COALESCE((v_copied->>'area_override')::boolean, false),
      v_copied->>'area_override_reason');
    v_new_asg_ids := v_new_asg_ids || (v_res->'assignment'->>'id')::uuid;
  END LOOP;

  -- 7. Counts read back from the tables, not tallied from intent.
  SELECT count(*) INTO v_created_runs FROM runs WHERE id = ANY(v_new_run_ids);
  SELECT count(*) INTO v_created_asg  FROM assignments WHERE id = ANY(v_new_asg_ids);
  SELECT count(DISTINCT u.id) INTO v_removed_runs
    FROM unnest(v_rm_run_ids) u(id) WHERE NOT EXISTS (SELECT 1 FROM runs x WHERE x.id = u.id);
  SELECT count(DISTINCT u.id) INTO v_removed_asg
    FROM unnest(v_rm_asg_ids) u(id) WHERE NOT EXISTS (SELECT 1 FROM assignments x WHERE x.id = u.id);

  RETURN jsonb_build_object(
    'created', jsonb_build_object('runs', v_created_runs, 'assignments', v_created_asg),
    'removed', jsonb_build_object('runs', v_removed_runs, 'assignments', v_removed_asg),
    'skipped', v_skipped);
END $function$;

comment on function apply_copy_week(uuid, date, date, jsonb, uuid) is
  'R-339/R-356: apply one decision per clash from a WEEK or TEMPLATE plan, in one transaction, through the board''s own writers.';

revoke execute on function apply_copy_week(uuid, date, date, jsonb, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function apply_copy_week(uuid, date, date, jsonb, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function apply_copy_week(uuid, date, date, jsonb, uuid) from anon';
  end if;
end $$;
