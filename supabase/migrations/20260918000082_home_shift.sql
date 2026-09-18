-- ============================================================================
-- 0082 --- A PERSON BELONGS TO A SHIFT: THE MODEL AND THE SERVER (R-441,
-- R-442, R-443; docs/design-plan.md §19.108 D137, corrected the same hour).
--
-- THE DECISION (D137, corrected). A person's home band is an ID, not a name:
-- "The person points at the band by id; the Operators tab's options are the
-- pattern's own bands, so the names go hand in hand; a rename or a change of
-- hours carries everyone along... Only on a cell whose pattern is not the
-- home's is the band matched by name, ignoring case." R-443's last sentence.
--
-- THE SHAPE, R-441/R-442. Two nullable columns (a nullable column is a CLIENT
-- CHANGE, CLAUDE.md §4 --- every parser touching these two is in this lane's
-- file list for that reason): `operators.home_shift_id` (the band a person
-- normally works) and `profile_grants.plans_shift_id` / `.outside_shift` (the
-- band a SUPERVISOR plans for, or the whole day). A verdict function,
-- `shift_fit`, sits beside `check_eligibility`: in-band, overtime (never
-- refused --- "can extend", R-441), or no_shift. `supervisor_shift_allows` is
-- the one case that IS refused: a supervisor bound to a shift may not plan
-- outside it. The five writers and the resize guard forward both, exactly as
-- they already forward `check_eligibility`/`absence_overlap`.
--
-- EXTRACTED, NEVER RETYPED (CLAUDE.md §4, DEF-0011) --- and TWO OF THE BRIEF'S
-- OWN CITATIONS NAMED THE WRONG MIGRATION, caught by grepping every definition
-- of each function rather than trusting the brief's line numbers:
--
--   * `apply_copy_week`: the brief pointed at 0066:974. `apply_copy_week` was
--     re-created ONE MIGRATION LATER, in 0067 (`week_templates.sql:840`,
--     signature gains `p_template_id`) --- 0066 is the second-to-last
--     definition, not the last. Not re-emitted here at all: its every new
--     assignment is created THROUGH `create_assignment` (an INSERT, read with
--     `pg_get_functiondef` and confirmed --- no direct `INSERT INTO
--     assignments`), so `shift_fit`/`supervisor_shift_allows` already run for
--     every row it creates without a line changing here, and its own return
--     shape (`created`/`removed`/`skipped` counts) carries no per-row
--     `absence` key today either, so there is no envelope slot to add `shift`
--     to. Re-emitting it to do nothing would be the retype-without-a-reason
--     CLAUDE.md warns against.
--   * `board_window`: the brief pointed at 0058. Migration 0081 (command bar,
--     17 Sept) re-created it AFTER 0058, adding the `command_bar` key with no
--     other change --- confirmed with
--     `grep -in "function \(public\.\)\?board_window(" supabase/migrations/*.sql`
--     and taking the last hit. Extracted from 0081 here, not 0058.
--
-- Every other citation in the brief checked out against the same grep: the
-- five writers' true last bodies are `create_assignment` (0079:43-157),
-- `reassign_assignment` (0066:539-646), `move_assignment` (0080:61-199, its
-- only definition), `move_run` (0066:649-807), and the resize guard
-- `app_guard_assignment_resize` (0070:94-133, its only definition).
--
-- ONE NEW CHOICE THE BRIEF LEFT OPEN, DECIDED AND RECORDED HERE (§4): the
-- board payload's per-caller planning restriction is emitted as ONE resolved
-- `me` object (`{plans_shift_id, outside_shift}`), not a list of covering
-- grants. Every other per-node or per-root answer this board already sends
-- (`node_policies`, `date_format`, `timezone`, `command_bar`) is a single
-- resolved value, nearest-covering-wins, computed once on the server so the
-- client never re-derives the covering rule (DEF-0016/DEF-0017's lesson, and
-- CLAUDE.md §7's "the server's rule, transcribed" standard) --- `me` is the
-- shift twin of those, resolved the identical nearest-ancestor way
-- `supervisor_shift_allows` resolves it, so the rail's own gate can never
-- disagree with the server's.
--
-- TWO SMALL PRIVATE HELPERS, NEW, NOT EXTRACTED FROM ANYTHING (there is
-- nothing to extract from): `app_shift_overtime_minutes` is the one piece of
-- arithmetic `shift_fit` and `supervisor_shift_allows` both need (minutes of
-- a timerange outside a daily band's window, a night band's `end_min > 1440`
-- handled by walking the calendar days the timerange touches and building
-- that day's band instance by plain interval arithmetic rather than modular
-- minute-of-day comparison); `app_planning_grant_for` is the ONE covering-grant
-- lookup `supervisor_shift_allows` and the refusal message both need. Writing
-- either twice in this same migration would be exactly the "column list that
-- appears twice" defect class CLAUDE.md §4 names, one migration early rather
-- than one lane later.
--
-- THE ZONE (CLAUDE.md §7, "the plant's zone is the one clock"): `shift_fit`
-- and `supervisor_shift_allows` take the zone the way `board_window` resolves
-- it for the axis --- `app_resolve_node_setting(p_node_id, 'timezone')`
-- COALESCEd to 'UTC' at the call site, the key's own default. This is NOT
-- `absence_overlap`'s approach (0069's header: "the server resolves no
-- timezone at all" --- absence rows are already-converted instants compared
-- as instants). A shift band is a WALL-CLOCK window that repeats every
-- calendar day in the plant's zone, so answering "how many minutes of this
-- instant range fall outside 06:00-14:00" genuinely requires resolving a zone
-- on the server; there is no client-side conversion that could do it instead
-- without the client walking the same ancestry `resolve_shift_template` does.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. THE COLUMNS (R-443: the band itself, never its words).
-- ----------------------------------------------------------------------------

alter table operators add column if not exists home_shift_id uuid;
-- Composite FK only (D3's own pattern --- see 0005's shifts.template_id: no
-- bare `references shifts(id)` beside it). `ON DELETE SET NULL (home_shift_id)`
-- names the column explicitly (PG15+): the referencing tuple also carries
-- `org_id`, which is NOT NULL, and an un-scoped `ON DELETE SET NULL` would try
-- to null every column in the FK, including it.
-- Every DDL in this section is guarded to be safely re-runnable (`IF NOT
-- EXISTS`, or an existence check in a DO block for the one clause that has no
-- such shorthand -- ADD CONSTRAINT). This is not this schema's usual
-- apply-once style; it is here because the local `supabase migration up`
-- applies a file statement-by-statement rather than as one transaction, so a
-- syntax error caught partway through a first attempt (found and fixed
-- during this lane's own build: a mismatched dollar-quote tag on
-- app_planning_grant_for below) leaves the EARLIER statements already
-- committed. The guards make a retry idempotent without hand-editing the
-- database out of band.
do $do$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'operators_org_id_home_shift_id_fkey'
  ) then
    alter table operators add constraint operators_org_id_home_shift_id_fkey
      foreign key (org_id, home_shift_id) references shifts (org_id, id)
      on delete set null (home_shift_id);
  end if;
end $do$;
create index if not exists operators_org_home_shift_idx on operators (org_id, home_shift_id);

comment on column operators.home_shift_id is
  'R-441/R-443: the BAND this person normally works -- a row id in shifts, never its name (a band may be renamed; the id is what survives that, D137''s correction). NULL = no home shift recorded, which shift_fit answers no_shift for. The composite FK (org_id, home_shift_id) forces the band to be THIS company''s -- a band from another org is a constraint error, never a silent NULL (D3). ON DELETE SET NULL (home_shift_id): retiring the band this person points at leaves them visibly WITHOUT a shift rather than moving them onto a different one -- the "retired anyway" case R-443 names.';

alter table profile_grants add column if not exists plans_shift_id uuid;
do $do$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'profile_grants_org_id_plans_shift_id_fkey'
  ) then
    alter table profile_grants add constraint profile_grants_org_id_plans_shift_id_fkey
      foreign key (org_id, plans_shift_id) references shifts (org_id, id)
      on delete set null (plans_shift_id);
  end if;
end $do$;
alter table profile_grants add column if not exists outside_shift boolean not null default true;

comment on column profile_grants.plans_shift_id is
  'R-442: the band this grant plans for -- NULL means the whole day (the default, and every existing grant''s answer, so this column changes nothing for anyone until set). Same composite-FK shape as operators.home_shift_id, same reason, same ON DELETE behaviour: a retired band un-plans the grant rather than leaving it pointed at a phantom row.';
comment on column profile_grants.outside_shift is
  'R-442: may this grant place people OUTSIDE the band named by plans_shift_id? Defaults to true, which combined with plans_shift_id defaulting to NULL means today''s behaviour for every grant everywhere is unchanged until an admin narrows one on purpose. Read only when plans_shift_id is not null -- supervisor_shift_allows ignores it otherwise.';


-- ----------------------------------------------------------------------------
-- 2. `app_shift_overtime_minutes` --- THE ARITHMETIC, ONCE.
--
-- Minutes of `p_timerange` (an absolute instant range) that fall OUTSIDE the
-- daily band [p_start_min, p_end_min) in the zone `p_tz`, where `p_end_min`
-- may exceed 1440 for a night band (0005's own shape: "end_min may exceed
-- 1440 -- that is what a night shift IS").
--
-- METHOD: walk every LOCAL calendar day the timerange could touch (from the
-- day before its local start, to catch a night band begun the day before
-- still running into the window's start, through its local end day), build
-- THAT day's band instance by plain interval arithmetic (local midnight of
-- the day, plus start_min minutes, converted to an instant via `AT TIME ZONE`
-- -- the duration then carries the wrap for free, so a 1320-1800 band is
-- 22:00 that day to 06:00 the NEXT, with no modular minute-of-day comparison
-- needed), and sum how much of `p_timerange` each day's instance covers.
-- Whatever is left over is outside every band instance -- overtime.
-- ----------------------------------------------------------------------------
create or replace function app_shift_overtime_minutes(
  p_start_min integer, p_end_min integer, p_timerange tstzrange, p_tz text
) returns integer
language plpgsql
stable
set search_path = public, pg_temp
as $function$
DECLARE
  v_tz         text := COALESCE(p_tz, 'UTC');
  v_total      numeric;
  v_in_band    numeric := 0;
  v_day        date;
  v_day_from   date;
  v_day_to     date;
  v_band_start timestamptz;
  v_band_end   timestamptz;
BEGIN
  -- Defensive, like absence_overlap's own early return: an unusable window
  -- answers "no overtime" rather than looping forever or dividing by nothing.
  IF p_timerange IS NULL OR isempty(p_timerange)
     OR lower_inf(p_timerange) OR upper_inf(p_timerange) THEN
    RETURN 0;
  END IF;

  v_total := EXTRACT(EPOCH FROM (upper(p_timerange) - lower(p_timerange)))::numeric / 60;

  v_day_from := ((lower(p_timerange) AT TIME ZONE v_tz)::date) - 1;
  v_day_to   := (upper(p_timerange) AT TIME ZONE v_tz)::date;

  FOR v_day IN SELECT generate_series(v_day_from, v_day_to, interval '1 day')::date LOOP
    -- Local midnight of v_day, plus start_min minutes, read back AS an instant
    -- in v_tz: a `timestamp AT TIME ZONE zone` on a timestamp WITHOUT a zone
    -- interprets it as wall-clock time IN that zone and returns the instant.
    v_band_start := (v_day::timestamp + make_interval(mins => p_start_min)) AT TIME ZONE v_tz;
    v_band_end   := v_band_start + make_interval(mins => (p_end_min - p_start_min));
    IF p_timerange && tstzrange(v_band_start, v_band_end, '[)') THEN
      v_in_band := v_in_band + EXTRACT(EPOCH FROM (
        LEAST(upper(p_timerange), v_band_end) - GREATEST(lower(p_timerange), v_band_start)
      ))::numeric / 60;
    END IF;
  END LOOP;

  RETURN GREATEST(round(v_total - v_in_band), 0)::integer;
END;
$function$;

comment on function app_shift_overtime_minutes(integer, integer, tstzrange, text) is
  'R-441: minutes of p_timerange OUTSIDE the daily band [p_start_min, p_end_min) in zone p_tz, p_end_min possibly > 1440 for a night band. Private arithmetic shared by shift_fit and supervisor_shift_allows (CLAUDE.md §4 -- written once so it cannot be written twice and drift). Not security definer: touches no table, reads no session state beyond its own arguments.';

revoke all on function app_shift_overtime_minutes(integer, integer, tstzrange, text) from public;


-- ----------------------------------------------------------------------------
-- 3. `app_planning_grant_for` --- THE ONE COVERING-GRANT LOOKUP.
--
-- The nearest-ancestor-or-self grant the ACTING profile holds that covers
-- p_node_id, carrying its shift-planning columns -- the same `target.path <@
-- anc.path ... ORDER BY nlevel(anc.path) DESC LIMIT 1` shape every other
-- per-node resolver in this schema uses (resolve_shift_template,
-- app_resolve_node_setting), applied to profile_grants instead of
-- node_shift_templates/node_settings. `profile_grants_select`'s own policy
-- (0020: `profile_id = app_current_profile_id() OR ...`) already lets a
-- profile read its own grants, so this can be a plain SQL function reading
-- through RLS as the caller -- it is never asked about anyone else's grants.
-- ----------------------------------------------------------------------------
create or replace function app_planning_grant_for(p_node_id uuid)
returns table(plans_shift_id uuid, outside_shift boolean)
language sql
stable
set search_path = public, pg_temp
as $function$
  SELECT pg.plans_shift_id, pg.outside_shift
    FROM nodes target
    JOIN nodes anc ON target.path <@ anc.path AND anc.org_id = target.org_id
    JOIN profile_grants pg ON pg.node_id = anc.id
                          AND pg.profile_id = app_current_profile_id()
   WHERE target.id = p_node_id
   ORDER BY nlevel(anc.path) DESC
   LIMIT 1;
$function$;

comment on function app_planning_grant_for(uuid) is
  'R-442: the nearest-ancestor-or-self grant the ACTING profile (app_current_profile_id()) holds covering p_node_id, carrying its plans_shift_id/outside_shift -- nearest wins, the same resolution shape resolve_shift_template and app_resolve_node_setting use. No rows when the profile holds no covering grant at all (owner context, a company admin with no node grant, or a node the profile cannot reach). Reads profile_grants under RLS as the caller (profile_grants_select already permits profile_id = app_current_profile_id()), so this is deliberately NOT security definer.';

revoke all on function app_planning_grant_for(uuid) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_planning_grant_for(uuid) to authenticated';
  end if;
end $do$;


-- ----------------------------------------------------------------------------
-- 4. `shift_fit` --- THE VERDICT.
--
-- Guarded to the caller's company the way resolve_shift_template is: the
-- operator lookup carries resolve_shift_template's own exemption clause,
-- `(auth.uid() IS NULL OR <row>.org_id = app_current_org())`, copied verbatim
-- (extract, never retype); the node side of the boundary comes for free by
-- CALLING resolve_shift_template rather than re-walking nodes, which carries
-- the identical clause internally.
-- ----------------------------------------------------------------------------
create or replace function shift_fit(p_operator_id uuid, p_node_id uuid, p_timerange tstzrange)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_home_shift_id uuid;
  v_template_id   uuid;
  v_shift         shifts%ROWTYPE;
  v_tz            text;
  v_overtime      integer;
  v_none          CONSTANT jsonb := jsonb_build_object(
                     'fit', 'no_shift', 'band', NULL,
                     'band_start_min', NULL, 'band_end_min', NULL,
                     'overtime_minutes', 0);
BEGIN
  -- resolve_shift_template's own guard, copied: exempt only when there is no
  -- caller identity at all (owner context); every tenant caller is bounded to
  -- its own company.
  SELECT o.home_shift_id INTO v_home_shift_id
    FROM operators o
   WHERE o.id = p_operator_id
     AND (auth.uid() IS NULL OR o.org_id = app_current_org());

  IF v_home_shift_id IS NULL THEN
    RETURN v_none;
  END IF;

  -- The node's own boundary lives inside resolve_shift_template already.
  v_template_id := resolve_shift_template(p_node_id);
  IF v_template_id IS NULL THEN
    RETURN v_none;
  END IF;

  -- D137/R-443: by id first (the home pattern holds this exact band) --
  SELECT * INTO v_shift FROM shifts WHERE id = v_home_shift_id AND template_id = v_template_id;
  IF NOT FOUND THEN
    -- -- else by NAME, case-insensitive, against a DIFFERENT pattern's bands
    -- (a cell whose pattern is not the person's home pattern). "Only on a cell
    -- whose pattern is not the home's is the band matched by name" (R-443).
    SELECT s.* INTO v_shift
      FROM shifts s
      JOIN shifts home ON lower(home.name) = lower(s.name)
     WHERE home.id = v_home_shift_id AND s.template_id = v_template_id;
  END IF;

  IF NOT FOUND THEN
    RETURN v_none;
  END IF;

  v_tz := COALESCE(app_resolve_node_setting(p_node_id, 'timezone'), 'UTC');
  v_overtime := app_shift_overtime_minutes(v_shift.start_min, v_shift.end_min, p_timerange, v_tz);

  RETURN jsonb_build_object(
    'fit', CASE WHEN v_overtime > 0 THEN 'overtime' ELSE 'in' END,
    'band', v_shift.name,
    'band_start_min', v_shift.start_min,
    'band_end_min', v_shift.end_min,
    'overtime_minutes', v_overtime
  );
END;
$function$;

comment on function shift_fit(uuid, uuid, tstzrange) is
  'R-441/R-443: does p_operator_id''s HOME band fit p_timerange at p_node_id? Resolves the person''s band by id against the node''s own pattern (resolve_shift_template); failing that, by NAME (lower(), case-insensitive) against a different pattern''s bands -- the D137 correction''s rule, so a rename or an hours change carries everyone along and only a foreign pattern falls back to matching words. {"fit":"no_shift"} when the person has no home band, the node has no pattern, or neither resolution finds a matching band. Otherwise {"fit":"in"|"overtime","band":name,"band_start_min","band_end_min","overtime_minutes":n} -- minutes of p_timerange outside the band''s daily window in the plant''s zone (app_resolve_node_setting(node,''timezone''), COALESCEd to UTC, the same key board_window resolves for the axis), a night band''s end_min > 1440 handled by app_shift_overtime_minutes. Overtime is NEVER refused (R-441: "can extend") -- only supervisor_shift_allows refuses. Org-bounded the way resolve_shift_template is: (auth.uid() IS NULL OR operators.org_id = app_current_org()) on the operator lookup, copied verbatim from resolve_shift_template (0068), plus resolve_shift_template''s own identical guard on the node side.';

revoke execute on function shift_fit(uuid, uuid, tstzrange) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function shift_fit(uuid, uuid, tstzrange) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function shift_fit(uuid, uuid, tstzrange) from anon';
  end if;
end $do$;


-- ----------------------------------------------------------------------------
-- 5. `supervisor_shift_allows` --- THE ONE REFUSAL.
-- ----------------------------------------------------------------------------
create or replace function supervisor_shift_allows(p_node_id uuid, p_timerange tstzrange)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_grant    record;
  v_shift    shifts%ROWTYPE;
  v_tz       text;
  v_overtime integer;
BEGIN
  -- Owner exemption exactly as the other definers: no caller identity at all.
  IF auth.uid() IS NULL THEN
    RETURN true;
  END IF;

  SELECT * INTO v_grant FROM app_planning_grant_for(p_node_id);

  -- No covering grant, or the covering grant plans no shift, or it explicitly
  -- allows placing outside it: unrestricted.
  IF NOT FOUND OR v_grant.plans_shift_id IS NULL OR v_grant.outside_shift THEN
    RETURN true;
  END IF;

  SELECT * INTO v_shift FROM shifts WHERE id = v_grant.plans_shift_id;
  IF NOT FOUND THEN
    -- The planned band was retired since the grant was set; ON DELETE SET
    -- NULL should have already cleared plans_shift_id, but a defensive read
    -- here means a dangling id (however it arose) fails OPEN, never closed.
    RETURN true;
  END IF;

  v_tz := COALESCE(app_resolve_node_setting(p_node_id, 'timezone'), 'UTC');
  v_overtime := app_shift_overtime_minutes(v_shift.start_min, v_shift.end_min, p_timerange, v_tz);

  -- "Lies inside the planned band" is exactly zero overtime minutes against
  -- that band -- the same arithmetic shift_fit uses, asked of the PLANNED
  -- band instead of the home one.
  RETURN v_overtime = 0;
END;
$function$;

comment on function supervisor_shift_allows(uuid, tstzrange) is
  'R-442: may the ACTING profile place someone at p_node_id during p_timerange? True when no covering grant (app_planning_grant_for, nearest-ancestor-wins) plans a shift, or the covering grant''s outside_shift is true, or p_timerange lies wholly inside the planned band (app_shift_overtime_minutes = 0 against it); false otherwise. Owner exemption exactly as the other definers (auth.uid() IS NULL). Unlike shift_fit''s overtime, a false answer here IS refused by every writer (api_raise(''outside_shift'', ...)) -- this is a PERMISSION, not an eligibility warning.';

revoke execute on function supervisor_shift_allows(uuid, tstzrange) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function supervisor_shift_allows(uuid, tstzrange) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function supervisor_shift_allows(uuid, tstzrange) from anon';
  end if;
end $do$;


-- ----------------------------------------------------------------------------
-- 6. `app_outside_shift_message` --- the refusal, in plant words.
--
-- "You plan Shift 2; 06:00-08:00 is outside it." Uses the SAME
-- `app_planning_grant_for` lookup `supervisor_shift_allows` uses (never a
-- second copy), so the two can never name a different band than the one that
-- just refused. Local times are rendered in the same zone shift_fit resolves.
-- ----------------------------------------------------------------------------
create or replace function app_outside_shift_message(p_node_id uuid, p_timerange tstzrange)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_grant record;
  v_shift shifts%ROWTYPE;
  v_tz    text;
BEGIN
  SELECT * INTO v_grant FROM app_planning_grant_for(p_node_id);
  IF NOT FOUND OR v_grant.plans_shift_id IS NULL THEN
    RETURN 'That window is outside the shift you plan.';
  END IF;

  SELECT * INTO v_shift FROM shifts WHERE id = v_grant.plans_shift_id;
  IF NOT FOUND THEN
    RETURN 'That window is outside the shift you plan.';
  END IF;

  v_tz := COALESCE(app_resolve_node_setting(p_node_id, 'timezone'), 'UTC');
  RETURN format('You plan %s; %s-%s is outside it.',
    v_shift.name,
    to_char(lower(p_timerange) AT TIME ZONE v_tz, 'HH24:MI'),
    to_char(upper(p_timerange) AT TIME ZONE v_tz, 'HH24:MI'));
END;
$function$;

comment on function app_outside_shift_message(uuid, tstzrange) is
  'R-442: the plant-words sentence for an outside_shift refusal, built from the SAME app_planning_grant_for lookup supervisor_shift_allows uses so the message can never name a different band than the one that refused. Read-only about the CALLER''s own planning grant (app_current_profile_id(), inside app_planning_grant_for), so exposing it directly carries no more than shift_fit/supervisor_shift_allows already do.
REVIEWER CORRECTION (S66-a review): this function is SECURITY DEFINER but was left with no grant to authenticated -- only to its owner. The four RPC writers that call it (create_assignment, reassign_assignment, move_assignment, move_run) are themselves SECURITY INVOKER (prosecdef=false, confirmed against pg_proc), so a call made from inside them runs under the REAL calling role, not an elevated one, and needs its own EXECUTE grant. Reproduced: create_assignment''s outside_shift refusal path raised "permission denied for function app_outside_shift_message" (SQLSTATE 42501) instead of api_raise(''outside_shift'', ...) for every one of the four writers -- the R-442 refusal was broken everywhere except the resize guard trigger (app_guard_assignment_resize IS security definer, so its own call happened to work, which is why HS13 alone stayed green). Granted to authenticated below, the same pattern shift_fit/supervisor_shift_allows/app_planning_grant_for already use.';

revoke all on function app_outside_shift_message(uuid, tstzrange) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function app_outside_shift_message(uuid, tstzrange) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_outside_shift_message(uuid, tstzrange) from anon';
  end if;
end $do$;


-- ----------------------------------------------------------------------------
-- 7. THE WRITERS FORWARD IT. Each function below is re-emitted WHOLE from its
-- LAST definition (named above), with exactly the edits this comment block
-- says and nothing else -- CLAUDE.md §4 / DEF-0011.
-- ----------------------------------------------------------------------------

-- ---- 7a. create_assignment --- extracted from 0079 (43-157). Two edits: a
-- supervisor_shift_allows gate beside the edit-rights check, and `shift` (a
-- shift_fit call on the placed operator/node/window) joins the envelope
-- beside `absence`. -----------------------------------------------------------
CREATE OR REPLACE FUNCTION create_assignment(
  p_node_id uuid,
  p_operator_id uuid,
  p_run_id uuid,
  p_product_id uuid,
  p_timerange tstzrange,
  p_efficiency numeric DEFAULT 1.000,
  p_target_qty numeric DEFAULT NULL,
  p_target_unit text DEFAULT NULL,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org_id uuid;
  v_elig jsonb;
  v_absence jsonb;   -- R-357
  v_shift jsonb;     -- R-441
  v_run runs%ROWTYPE;   -- F-131
  v_assignment assignments%ROWTYPE;
  v_use_override boolean;
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF num_nonnulls(p_run_id, p_product_id) <> 1 THEN
    PERFORM api_raise('invalid_argument', 'exactly one of p_run_id / p_product_id must be set',
      jsonb_build_object('field', 'p_run_id/p_product_id', 'reason', 'must set exactly one'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  IF NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node', jsonb_build_object('node_id', p_node_id));
  END IF;

  -- R-442: a shift-bound supervisor may not plan outside their own band.
  -- Overtime for the PLACED person is a different question (R-441, below) and
  -- is never refused.
  IF NOT supervisor_shift_allows(p_node_id, p_timerange) THEN
    PERFORM api_raise('outside_shift', app_outside_shift_message(p_node_id, p_timerange),
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text));
  END IF;

  -- F-131 / R-383 (session 144): a block that joins a run lies inside it. The
  -- client decides "join" by the same containment (assignmentFitsRun); the
  -- server holds the same test so a refetch race or a shift chip moved after
  -- the question cannot land a block outside the job it names.
  IF p_run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM runs WHERE id = p_run_id;
    IF NOT FOUND THEN
      PERFORM api_raise('invalid_argument', 'no such run',
        jsonb_build_object('field', 'p_run_id', 'reason', 'no such run'));
    END IF;
    IF NOT (v_run.timerange @> p_timerange) THEN
      PERFORM api_raise('outside_run',
        'a block that joins a run must lie inside the run''s window',
        jsonb_build_object('run_id', p_run_id, 'node_id', p_node_id,
                            'run_timerange', v_run.timerange::text,
                            'timerange', p_timerange::text));
    END IF;
  END IF;

  SELECT org_id INTO v_org_id FROM nodes WHERE id = p_node_id;

  v_elig := check_eligibility(p_node_id, p_operator_id, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    END IF;
  END IF;

  -- R-357: the absence question, beside eligibility and under the SAME resolved
  -- policy. block -> refuse with `absent`; warn -> the absence rides back in the
  -- payload as a warning and the placement is taken (the screen showed it first).
  v_absence := absence_overlap(p_operator_id, p_timerange);
  IF (v_absence->>'absent')::boolean AND v_elig->>'policy' = 'block' THEN
    PERFORM api_raise('absent',
      'operator is absent for this window under block policy',
      jsonb_build_object('operator_id', p_operator_id, 'node_id', p_node_id,
                          'absence', v_absence, 'policy', v_elig->>'policy'));
  END IF;

  -- R-441: the placed person's own band, never refused, always named.
  v_shift := shift_fit(p_operator_id, p_node_id, p_timerange);

  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  INSERT INTO assignments (
    org_id, node_id, operator_id, run_id, product_id, timerange, efficiency,
    target_qty, target_unit, eligibility_override, override_reason,
    area_override, area_override_reason, created_by
  ) VALUES (
    v_org_id, p_node_id, p_operator_id, p_run_id, p_product_id, p_timerange, p_efficiency,
    p_target_qty, p_target_unit,
    v_use_override, CASE WHEN v_use_override THEN p_override_reason ELSE NULL END,
    p_area_override, CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END,
    auth.uid()
  )
  RETURNING * INTO v_assignment;

  -- R-357/R-441: `absence` and `shift` both join the envelope so a placement
  -- carries its warnings.
  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'eligibility', v_elig,
                            'absence', v_absence, 'shift', v_shift);
END;
$function$;

comment on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) is
  'R-357/R-441/R-442, extracted from 0079 (its last body): eligibility, absence and now shift are all asked beside the write. supervisor_shift_allows gates the CALLER''s own planning restriction (outside_shift refuses, api_raise(''outside_shift'', ...), in plant words via app_outside_shift_message); shift_fit reports the PLACED person''s own band fit -- in/overtime/no_shift -- in the envelope''s `shift` key and is NEVER refused (R-441: overtime "can extend"). Everything else is 0079''s text verbatim.';

revoke execute on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) from public;
do $do$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) from anon';
  end if;
end $do$;


-- ---- 7b. reassign_assignment --- extracted from 0066 (539-646). Same two
-- edits: supervisor_shift_allows beside the edit-rights check (the row's OWN
-- node/window -- reassigning does not move either), shift_fit on the NEW
-- operator joins the envelope. -----------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_assignment(
  p_assignment_id uuid,
  p_operator_id uuid,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row assignments%ROWTYPE;
  v_elig jsonb;
  v_absence jsonb;   -- R-357
  v_shift jsonb;     -- R-441
  v_use_override boolean;
  v_rows integer;
BEGIN
  IF p_assignment_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_assignment_id is required',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'null'));
  END IF;
  IF p_operator_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_operator_id is required',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'null'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  SELECT * INTO v_row FROM assignments WHERE id = p_assignment_id;
  IF v_row.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'assignment not found',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_row.node_id) THEN
    PERFORM api_raise('not_permitted', 'no edit rights on node',
      jsonb_build_object('node_id', v_row.node_id));
  END IF;

  -- R-442: the row's own node/window -- reassigning changes who, not where or
  -- when, so the caller's own planning restriction is asked against the SAME
  -- window it already covers.
  IF NOT supervisor_shift_allows(v_row.node_id, v_row.timerange) THEN
    PERFORM api_raise('outside_shift', app_outside_shift_message(v_row.node_id, v_row.timerange),
      jsonb_build_object('node_id', v_row.node_id, 'timerange', v_row.timerange::text));
  END IF;

  v_elig := check_eligibility(v_row.node_id, p_operator_id, v_row.timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', v_row.node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', p_operator_id, 'node_id', v_row.node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF coalesce(btrim(p_override_reason), '') = '' THEN
      PERFORM api_raise('invalid_argument', 'an eligibility override must say why',
        jsonb_build_object('field', 'p_override_reason', 'reason', 'required when p_eligibility_override is true'));
    END IF;
  END IF;

  -- R-357: the absence question, the row's OWN window, same resolved policy.
  -- block -> refuse with `absent`; warn -> the new person takes the cell and the
  -- absence rides back in the payload. (An override is about certification, not
  -- absence, so it does not silence this; block is the only refusal.)
  v_absence := absence_overlap(p_operator_id, v_row.timerange);
  IF (v_absence->>'absent')::boolean AND v_elig->>'policy' = 'block' THEN
    PERFORM api_raise('absent',
      'operator is absent for this window under block policy',
      jsonb_build_object('operator_id', p_operator_id, 'node_id', v_row.node_id,
                          'absence', v_absence, 'policy', v_elig->>'policy'));
  END IF;

  -- R-441: the NEW operator's own band on this row's window.
  v_shift := shift_fit(p_operator_id, v_row.node_id, v_row.timerange);

  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  BEGIN
    UPDATE assignments SET
      operator_id          = p_operator_id,
      operator_display_name = NULL,
      eligibility_override = v_use_override,
      override_reason      = CASE WHEN v_use_override THEN btrim(p_override_reason) ELSE NULL END,
      area_override        = p_area_override,
      area_override_reason = CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END
    WHERE id = p_assignment_id
    RETURNING * INTO v_row;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    PERFORM api_raise('invalid_argument', 'operator not found',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'not found'));
  END;

  IF v_rows = 0 THEN
    PERFORM api_raise('not_permitted', 'the assignment was not written',
      jsonb_build_object('node_id', v_row.node_id, 'assignment_id', p_assignment_id));
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_row), 'eligibility', v_elig,
                            'absence', v_absence, 'shift', v_shift);   -- R-357/R-441
END;
$function$;

comment on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) is
  'R-343/S37, R-357, and now R-441/R-442, extracted from 0066 (its last body). supervisor_shift_allows gates the caller''s own planning restriction against the row''s own (unchanged) node/window before the write; shift_fit reports the NEW operator''s own band fit in the envelope''s `shift` key. Everything else is 0066''s text.';


-- ---- 7c. move_assignment --- extracted from 0080 (61-199, its only
-- definition). Same two edits, against the TARGET node/window. --------------
CREATE OR REPLACE FUNCTION public.move_assignment(
  p_assignment_id uuid,
  p_node_id uuid,
  p_timerange tstzrange,
  p_eligibility_override boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_area_override boolean DEFAULT false,
  p_area_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row assignments%ROWTYPE;
  v_operator uuid;    -- S41-c: the person the row belongs to
  v_product uuid;     -- S41-c: the effective part the row carries
  v_elig jsonb;
  v_absence jsonb;   -- R-357
  v_shift jsonb;     -- R-441
  v_use_override boolean;
  v_rows integer;
BEGIN
  IF p_assignment_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_assignment_id is required',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'null'));
  END IF;
  IF p_node_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_node_id is required',
      jsonb_build_object('field', 'p_node_id', 'reason', 'null'));
  END IF;
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;

  SELECT * INTO v_row FROM assignments WHERE id = p_assignment_id;
  IF v_row.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'assignment not found',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_row.node_id) OR NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'edit rights required on both source and target node',
      jsonb_build_object('node_id', p_node_id));
  END IF;

  -- R-442: against the TARGET node/window -- this is where and when the
  -- caller is placing the block after the move.
  IF NOT supervisor_shift_allows(p_node_id, p_timerange) THEN
    PERFORM api_raise('outside_shift', app_outside_shift_message(p_node_id, p_timerange),
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text));
  END IF;

  -- S41-c / D110: a departed person's row (operator_id NULL) has nobody to
  -- re-check eligibility, absence or area for -- there is no placement to
  -- move; the block stays exactly where it is.
  v_operator := v_row.operator_id;
  IF v_operator IS NULL THEN
    PERFORM api_raise('invalid_argument', 'a departed person''s block cannot be moved',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'operator is null'));
  END IF;

  v_elig := check_eligibility(p_node_id, v_operator, p_timerange);

  IF NOT (v_elig->>'eligible')::boolean THEN
    IF v_elig->>'policy' = 'block' THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF NOT p_eligibility_override THEN
      PERFORM api_raise('not_eligible',
        'operator is not eligible for this node/window; override required under warn policy',
        jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                            'missing_skills', v_elig->'missing_skills',
                            'expiring_skills', v_elig->'expiring_skills',
                            'policy', v_elig->>'policy'));
    ELSIF coalesce(btrim(p_override_reason), '') = '' THEN
      PERFORM api_raise('invalid_argument', 'an eligibility override must say why',
        jsonb_build_object('field', 'p_override_reason', 'reason', 'required when p_eligibility_override is true'));
    END IF;
  END IF;

  -- R-357: the absence question, the row's OWN window, same resolved policy.
  -- block -> refuse with `absent`; warn -> the new person takes the cell and the
  -- absence rides back in the payload. (An override is about certification, not
  -- absence, so it does not silence this; block is the only refusal.)
  v_absence := absence_overlap(v_operator, p_timerange);
  IF (v_absence->>'absent')::boolean AND v_elig->>'policy' = 'block' THEN
    PERFORM api_raise('absent',
      'operator is absent for this window under block policy',
      jsonb_build_object('operator_id', v_operator, 'node_id', p_node_id,
                          'absence', v_absence, 'policy', v_elig->>'policy'));
  END IF;

  -- R-441: the moved person's own band at the TARGET node/window.
  v_shift := shift_fit(v_operator, p_node_id, p_timerange);

  v_use_override := NOT (v_elig->>'eligible')::boolean AND p_eligibility_override;

  -- S41-c: the effective part the row carries today -- its own for a direct
  -- block, its run's for a run-attached one (the same lookup the client's
  -- ContextAssignment.productId is built from, one step earlier).
  v_product := COALESCE(v_row.product_id, (SELECT product_id FROM runs WHERE id = v_row.run_id));
  IF v_row.run_id IS NOT NULL AND v_product IS NULL THEN
    PERFORM api_raise('invalid_argument', 'the run''s product is gone',
      jsonb_build_object('field', 'p_assignment_id', 'reason', 'no product to carry'));
  END IF;

  UPDATE assignments SET
    node_id               = p_node_id,
    timerange             = p_timerange,
    run_id                = NULL,
    product_id            = v_product,
    eligibility_override  = v_use_override,
    override_reason       = CASE WHEN v_use_override THEN btrim(p_override_reason) ELSE NULL END,
    area_override         = p_area_override,
    area_override_reason  = CASE WHEN p_area_override THEN btrim(p_area_override_reason) ELSE NULL END
  WHERE id = p_assignment_id
  RETURNING * INTO v_row;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    PERFORM api_raise('not_permitted', 'the assignment was not written',
      jsonb_build_object('node_id', p_node_id, 'assignment_id', p_assignment_id));
  END IF;

  RETURN jsonb_build_object('assignment', to_jsonb(v_row), 'eligibility', v_elig,
                            'absence', v_absence, 'shift', v_shift);   -- R-357/R-441
END;
$function$;

revoke execute on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) from anon';
  end if;
end $$;

comment on function move_assignment(uuid, uuid, tstzrange, boolean, text, boolean, text) is
  'S41-c, R-357, and now R-441/R-442, extracted from 0080 (its only definition). supervisor_shift_allows gates the caller''s own planning restriction against the TARGET node/window; shift_fit reports the moved operator''s own band fit at the target in the envelope''s `shift` key. Everything else is 0080''s text.';


-- ---- 7d. move_run --- extracted from 0066 (649-807). Two edits: a single
-- supervisor_shift_allows gate against the run's TARGET node/window (once,
-- not per crew member -- this is the CALLER's own restriction, independent of
-- who is on the crew), and a per-crew shift_fit in the write loop, collected
-- into a NEW `shift_overtime` array (this writer's envelope has no singular
-- `shift` slot -- it already reports crew-wide facts as arrays, absence_warnings
-- beside it -- so shift_overtime is that same shape, listing only those whose
-- fit is not "in"). ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange, p_area_override boolean DEFAULT false, p_area_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run runs%ROWTYPE;
  v_old_node_id uuid;
  v_old_start timestamptz;
  v_delta interval;
  v_conflicting_run_id uuid;
  v_policy text;
  v_org_id uuid;
  v_warnings jsonb := '[]'::jsonb;
  v_absent jsonb := '[]'::jsonb;            -- R-357: absent crew, this move
  v_absent_warnings jsonb := '[]'::jsonb;   -- R-357: absent crew under warn
  v_absence jsonb;                          -- R-357
  v_shift jsonb;                            -- R-441
  v_shift_overtime jsonb := '[]'::jsonb;    -- R-441: crew landing outside their band
  v_updated_assignments jsonb;
  rec RECORD;
  v_elig jsonb;
  v_new_range tstzrange;
  v_outside jsonb := '[]'::jsonb;  -- D113
  v_reason text;                   -- D113
BEGIN
  IF p_timerange IS NULL OR isempty(p_timerange) THEN
    PERFORM api_raise('invalid_argument', 'p_timerange must be a non-empty range',
      jsonb_build_object('field', 'p_timerange', 'reason', 'null or empty'));
  END IF;
  IF p_area_override AND coalesce(btrim(p_area_override_reason), '') = '' THEN
    PERFORM api_raise('invalid_argument', 'an area override must say why',
      jsonb_build_object('field', 'p_area_override_reason', 'reason', 'required when p_area_override is true'));
  END IF;
  v_reason := btrim(p_area_override_reason);

  SELECT * INTO v_run FROM runs WHERE id = p_run_id;
  IF v_run.id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'run not found', jsonb_build_object('field', 'p_run_id', 'reason', 'not found'));
  END IF;
  v_old_node_id := v_run.node_id;
  v_old_start := lower(v_run.timerange);
  v_org_id := v_run.org_id;

  IF NOT app_can_edit_node(v_old_node_id) OR NOT app_can_edit_node(p_node_id) THEN
    PERFORM api_raise('not_permitted', 'edit rights required on both source and target node',
      jsonb_build_object('node_id', p_node_id));
  END IF;

  -- R-442: the caller's own planning restriction, asked ONCE against the
  -- run's target node/window -- independent of which operators are on the
  -- crew, the same as every other permission gate in this function.
  IF NOT supervisor_shift_allows(p_node_id, p_timerange) THEN
    PERFORM api_raise('outside_shift', app_outside_shift_message(p_node_id, p_timerange),
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text));
  END IF;

  SELECT id INTO v_conflicting_run_id
  FROM runs
  WHERE node_id = p_node_id AND id <> p_run_id AND timerange && p_timerange
  LIMIT 1;
  IF v_conflicting_run_id IS NOT NULL THEN
    PERFORM api_raise('run_overlap', 'target node already has an overlapping active run',
      jsonb_build_object('node_id', p_node_id, 'timerange', p_timerange::text,
                          'conflicting_run_id', v_conflicting_run_id));
  END IF;

  v_delta := lower(p_timerange) - v_old_start;

  -- ---- D113: who on this crew does not belong at the target node? ----
  IF NOT p_area_override THEN
    FOR rec IN
      SELECT a.operator_id, o.site_node_id AS owner_node_id, o.display_name
        FROM assignments a JOIN operators o ON o.id = a.operator_id
       WHERE a.run_id = p_run_id
    LOOP
      IF NOT app_owner_covers(rec.owner_node_id, p_node_id) THEN
        v_outside := v_outside || jsonb_build_object('id', rec.operator_id,
                                                     'name', rec.display_name,
                                                     'owner_node_id', rec.owner_node_id);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_outside) > 0 THEN
      PERFORM api_raise('not_offered_here',
        'Some of this crew do not belong to that part of the structure.',
        jsonb_build_object('kind', 'operator', 'node_id', p_node_id, 'operators', v_outside));
    END IF;
  END IF;

  v_policy := COALESCE(app_resolve_node_setting(p_node_id, 'eligibility_policy'), 'warn');

  -- Under block: pre-check every crew member against the target node BEFORE
  -- writing anything, so a violation aborts the whole move with nothing changed.
  IF v_policy = 'block' THEN
    FOR rec IN
      SELECT a.operator_id, a.timerange FROM assignments a
      WHERE a.run_id = p_run_id
    LOOP
      v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
      v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);
      IF NOT (v_elig->>'eligible')::boolean THEN
        v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                         'missing_skills', v_elig->'missing_skills');
      END IF;
      -- R-357: the same pre-check for absence, so the refusal names ALL of them.
      v_absence := absence_overlap(rec.operator_id, v_new_range);
      IF (v_absence->>'absent')::boolean THEN
        v_absent := v_absent || jsonb_build_object('operator_id', rec.operator_id, 'absence', v_absence);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_warnings) > 0 THEN
      PERFORM api_raise('not_eligible', 'one or more crew members are not eligible for the target node',
        jsonb_build_object('node_id', p_node_id, 'operators', v_warnings, 'policy', v_policy));
    END IF;
    -- R-357: absent crew abort the whole move under block, listing every one.
    IF jsonb_array_length(v_absent) > 0 THEN
      PERFORM api_raise('absent', 'one or more crew members are absent for the target window',
        jsonb_build_object('node_id', p_node_id, 'operators', v_absent, 'policy', v_policy));
    END IF;
    v_warnings := '[]'::jsonb;
    v_absent := '[]'::jsonb;
  END IF;

  UPDATE runs SET node_id = p_node_id, timerange = p_timerange WHERE id = p_run_id
    RETURNING * INTO v_run;

  FOR rec IN
    SELECT * FROM assignments WHERE run_id = p_run_id
  LOOP
    v_new_range := tstzrange(lower(rec.timerange) + v_delta, upper(rec.timerange) + v_delta);
    v_elig := check_eligibility(p_node_id, rec.operator_id, v_new_range);

    -- R-357: under warn, an absent crew member does not block the move; they are
    -- returned as an absence warning (nothing on the row records absence).
    v_absence := absence_overlap(rec.operator_id, v_new_range);
    IF (v_absence->>'absent')::boolean THEN
      v_absent_warnings := v_absent_warnings || jsonb_build_object('operator_id', rec.operator_id, 'absence', v_absence);
    END IF;

    -- R-441: this crew member's own band on the shifted window, never
    -- refused -- collected only when it is not a clean "in".
    v_shift := shift_fit(rec.operator_id, p_node_id, v_new_range);
    IF v_shift->>'fit' <> 'in' THEN
      v_shift_overtime := v_shift_overtime || jsonb_build_object('operator_id', rec.operator_id, 'shift', v_shift);
    END IF;

    IF NOT (v_elig->>'eligible')::boolean THEN
      v_warnings := v_warnings || jsonb_build_object('operator_id', rec.operator_id,
                                                       'missing_skills', v_elig->'missing_skills');
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            eligibility_override = true,
            override_reason = format('run moved to %s', (SELECT name FROM nodes WHERE id = p_node_id)),
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    ELSE
      UPDATE assignments
        SET node_id = p_node_id, timerange = v_new_range,
            area_override = p_area_override,
            area_override_reason = CASE WHEN p_area_override THEN v_reason ELSE NULL END
        WHERE id = rec.id;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.timerange), '[]'::jsonb)
    INTO v_updated_assignments FROM assignments a WHERE a.run_id = p_run_id;

  RETURN jsonb_build_object('run', to_jsonb(v_run), 'assignments', v_updated_assignments,
                             'eligibility_warnings', v_warnings,
                             'absence_warnings', v_absent_warnings,
                             'shift_overtime', v_shift_overtime);
END;
$function$;

comment on function move_run(uuid, uuid, tstzrange, boolean, text) is
  'D113, R-357, and now R-441/R-442, extracted from 0066 (its last body). supervisor_shift_allows gates the caller''s own planning restriction ONCE against the run''s target node/window, independent of the crew. Every crew member''s own band is asked with shift_fit on their shifted window (never refused) and collected into `shift_overtime`, an array of {operator_id, shift} for whoever does not cleanly fit -- the crew-wide equivalent of `absence_warnings` beside it, since this writer''s envelope reports crew-wide facts as arrays rather than one row''s own `shift` key.';


-- ---- 7e. app_guard_assignment_resize (the resize guard trigger body) ---
-- REVIEWER CORRECTION (S66-a review): this lane's own header claimed
-- extraction from "0070 (94-133, its only definition)". That premise is
-- false -- `grep -in "function \(public\.\)\?app_guard_assignment_resize("
-- supabase/migrations/*.sql` lists 0070 AND 0071
-- (20260908000071_resize_guard_owner_exemption.sql, DEF-0019), which
-- re-created this same function ONE MIGRATION LATER to add the owner-context
-- exemption (`auth.uid() IS NULL`) that `check_eligibility` itself has never
-- carried. Re-emitting from 0070 silently dropped that guard -- exactly
-- DEF-0011's shape, one migration later. Reproduced: 88_absences_test.sql's
-- AB33 ("owner context is exempt from the resize guard") failed with "you
-- cannot see that place" (PT403) against the unpatched body, and the full
-- suite from 50_audit_test.sql onward turned red the same way (any
-- owner-context UPDATE touching timerange/operator_id). Extracted from 0071
-- (its true last definition) instead, with the lane's own two edits kept:
-- an UNCONDITIONAL supervisor_shift_allows check (not policy-gated -- R-442
-- is a permission, not an eligibility/absence warning that only bites under
-- block), placed AFTER the owner-context early return (supervisor_shift_allows
-- already self-exempts auth.uid() IS NULL, so this ordering changes nothing
-- for a real caller and simply lets 0071's early return keep owner context
-- out of every one of this trigger's questions, exactly as it did before this
-- migration). A trigger cannot return an envelope, so this is enforcement
-- only, matching the header's own "asks the same questions" shape for the
-- OTHER refusal a plain PATCH must also ask. --------------------------------
create or replace function app_guard_assignment_resize() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_elig jsonb;
  v_absence jsonb;
begin
  -- DEF-0019 (0071), preserved: no jwt sub at all means no caller identity,
  -- which is owner context and nothing else. Such a caller already bypasses
  -- RLS on this table outright, so this trigger is the only place that would
  -- otherwise refuse them, over questions (check_eligibility's own
  -- app_can_read_node gate has no owner exemption of its own; nor did
  -- supervisor_shift_allows's caller ever mean an ownerless session) that
  -- were never about them.
  if auth.uid() is null then
    return new;
  end if;

  -- R-442: unconditional, unlike the block/warn split below -- a shift-bound
  -- supervisor may not resize a block outside their own planning window
  -- regardless of the plant's eligibility policy.
  if not supervisor_shift_allows(new.node_id, new.timerange) then
    perform api_raise('outside_shift', app_outside_shift_message(new.node_id, new.timerange),
      jsonb_build_object('node_id', new.node_id, 'timerange', new.timerange::text));
  end if;

  -- R-331: the SAME policy resolution `check_eligibility` itself performs
  -- (`app_resolve_node_setting(p_node_id, 'eligibility_policy')`, defaulted
  -- to 'warn') -- read off ITS OWN ANSWER rather than resolved a second way,
  -- so this can never drift from what the four writers already ask
  -- (CLAUDE.md §4, "extract, never retype"). `check_eligibility` guards the
  -- org boundary itself (`app_can_read_node`), exactly as it does for them.
  v_elig := check_eligibility(new.node_id, new.operator_id, new.timerange);

  if v_elig->>'policy' = 'block' then
    if not (v_elig->>'eligible')::boolean then
      perform api_raise('not_eligible',
        'operator is not eligible for this node/window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'missing_skills', v_elig->'missing_skills',
                           'expiring_skills', v_elig->'expiring_skills',
                           'policy', v_elig->>'policy'));
    end if;

    -- `absence_overlap` is org-scoped and SECURITY DEFINER the same way, and
    -- is asked only once policy is known to be `block` -- a `warn` answer is
    -- never acted on in here at all (see header: the trigger stays silent).
    v_absence := absence_overlap(new.operator_id, new.timerange);
    if (v_absence->>'absent')::boolean then
      perform api_raise('absent',
        'operator is absent for this window under block policy',
        jsonb_build_object('operator_id', new.operator_id, 'node_id', new.node_id,
                           'absence', v_absence, 'policy', v_elig->>'policy'));
    end if;
  end if;

  -- warn: silent by design (header, R-361 decision 3). A trigger cannot
  -- return a warning; the client owns the sentence (useDragGesture.ts).
  -- R-441's overtime is the same kind of silence, for the same reason, and is
  -- never refused regardless of policy (unlike R-442 above).
  return new;
end $$;

-- Same trigger, same name, same timing, same WHEN clause as 0070 -- only the
-- function body backing it changed, so DROP+CREATE here is re-pointing it at
-- the new body rather than a behavioural change to when it fires.
drop trigger if exists assignments_resize_guard on assignments;
create trigger assignments_resize_guard
  before update on assignments
  for each row
  when (
    new.operator_id is not null
    and (
      new.timerange is distinct from old.timerange
      or new.operator_id is distinct from old.operator_id
    )
  )
  execute function app_guard_assignment_resize();

comment on function app_guard_assignment_resize() is
  'R-361, DEF-0019, and now R-442, extracted from 0071 (its true last definition -- a reviewer correction: this migration first re-emitted from 0070, dropping 0071''s owner-context exemption, DEF-0011''s exact shape; caught by 88_absences_test.sql AB33). BEFORE UPDATE trigger body for assignments_resize_guard: exempt when auth.uid() IS NULL (owner context, 0071); otherwise re-asks supervisor_shift_allows UNCONDITIONALLY (a permission, refused regardless of eligibility_policy) plus check_eligibility and absence_overlap under the SAME resolved policy the four scheduler writers already ask. Under block, eligibility/absence refuse with the same codes and DETAIL shape the four raise (not_eligible, absent); under warn they stay silent by construction (a trigger cannot return a warning), and R-441''s overtime is silent unconditionally, for the same structural reason, never refused either way. The trigger''s own WHEN clause fires only when NEW.operator_id IS NOT NULL (AB32, unchanged).';


-- ----------------------------------------------------------------------------
-- 8. THE BOARD PAYLOAD --- board_window re-emitted WHOLE from 0081 (its last
-- definition; the brief's own citation, 0058, is superseded by 0081's
-- command_bar addition -- see this migration's header). Two edits: each
-- operator gains `home_shift_id`; one new top-level `me` key carries the
-- caller's own effective planning restriction for the board's root (§4's
-- design note above explains the single-object choice over a grant list).
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

    -- THE KEY THIS MIGRATION EXISTS FOR (R-442). The caller's OWN effective
    -- planning restriction for this board's root -- nearest-ancestor-or-self
    -- covering grant, the identical resolution supervisor_shift_allows uses,
    -- so the rail/pop-ups/bar (S66-c/d) read the SAME answer the server would
    -- enforce rather than re-deriving the covering rule (DEF-0016/DEF-0017,
    -- CLAUDE.md §7). NULL when the caller holds no covering grant at all
    -- (owner context, or a company admin with no node grant) -- read as
    -- "unrestricted", the same default app_planning_grant_for's NOT FOUND
    -- means inside supervisor_shift_allows.
    'me', (SELECT jsonb_build_object('plans_shift_id', g.plans_shift_id, 'outside_shift', g.outside_shift)
             FROM app_planning_grant_for((SELECT sn.id FROM scoped_nodes sn WHERE sn.path = p_root_path)) g),

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
               -- R-441. THE KEY THIS MIGRATION EXISTS FOR. The person's home
               -- band by id (D137's correction) -- the rail, the pop-ups and
               -- the bar read this straight off the payload rather than
               -- resolving it (DEF-0016's lesson applies here exactly as it
               -- does to `site_path` beside it: a walk on the client would
               -- need the same ancestry board_window already scoped).
               'home_shift_id', op.home_shift_id,
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
  'Extracted from 0081 (its last definition -- the brief cited 0058, superseded; see this migration''s header). Two additions since 0081: each operator carries home_shift_id (R-441), and a new top-level `me` object carries the caller''s own effective planning restriction for the board''s root (R-442) -- {plans_shift_id, outside_shift}, resolved the identical nearest-ancestor-or-self way supervisor_shift_allows resolves it (app_planning_grant_for), NULL when the caller holds no covering grant. Everything else is 0081''s text.';
