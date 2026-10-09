-- ============================================================================
-- 0066 --- AN ABSENCE IS A PERSON, A DATE RANGE AND A REASON, AND THE BOARD
-- TREATS AN OVERLAP AS A CLASH OF ITS OWN KIND (R-357).
--
-- The maintainer, 7 Sept, from three options side by side (entered in the app;
-- CSV import; both): BOTH. An absence is recorded on an Absences tab by a
-- supervisor or admin of the PERSON'S place, and imported by file in the same
-- shape as operators and trainings. On the board and in Copy Week an assignment
-- overlapping an absence is a clash decided by the same server function that
-- decides eligibility, refused or warned under the plant's warn-or-block policy,
-- and shown before the save by the same predicate the server runs.
--
-- WHAT THIS MIGRATION HOLDS:
--   1. the `absences` table + RLS (readable by whoever can read the person;
--      written only through the RPCs below --- no write policy at all),
--   2. `absence_overlap(operator, timerange)` --- the SECURITY DEFINER predicate
--      the writers consult beside `check_eligibility` (like it, the caller may
--      not be able to READ the person's home; unlike it, it answers about the
--      calendar DAYS the shift touches),
--   3. the writers `set_absence`, `remove_absence`, `import_absences`, each
--      gated on `app_can_edit_node(operator's home)` --- a supervisor or admin OF
--      THE PERSON'S PLACE --- reading the row back before answering,
--   4. the four schedulers that already consult `check_eligibility` re-emitted
--      to consult `absence_overlap` too: `create_assignment`, `move_run`,
--      `reassign_assignment`, `copy_week_plan`, with a new error code `absent`
--      and a Copy Week clash reason `absent`, both under the SAME resolved
--      `eligibility_policy` (warn -> a warning in the payload, block -> a refusal).
--
-- ⚠️ THE BOUNDARY THE PREDICATE AND ITS CLIENT TWIN (`src/lib/absence.ts`) MUST
-- AGREE ON. A shift is a `[)` tstzrange; the days it TOUCHES are the calendar
-- days d whose `[d, d+1)` overlaps it. A shift ending EXACTLY at midnight touches
-- only the days strictly before that midnight, so a shift `[Mon 06:00, Tue 00:00)`
-- touches Monday alone. An absence stored as `daterange(from, to, '[]')` includes
-- both ends. So an absence ENDING on the day a shift STARTS overlaps (both name
-- that day); a shift ENDING at midnight on the day an absence STARTS does not.
-- `absence.test.ts` and 88_absences_test.sql pin both sides by the same names.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). The four re-emitted functions
-- are the LAST definition of each --- create_assignment 0030, move_run 0050,
-- reassign_assignment 0057, copy_week_plan 0055 --- with exactly one predicate
-- call and one branch added to each and nothing else moved. Their comments say
-- where the new lines are.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §1. The table. `daterange` NOT NULL with a GiST exclusion so one person
--     cannot hold two overlapping absences. `reason` is free text, trimmed and
--     non-empty (a closed list is wrong: "jury service" is as real as "sick").
--     `external_id` carries the SAME `(org_id, external_id)` uniqueness the
--     operators table uses so a re-import is an upsert. D3 composite FK on the
--     person, and the standard audit columns + triggers.
-- ----------------------------------------------------------------------------
create table absences (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id),
  operator_id  uuid not null,
  daterange    daterange not null,
  reason       text not null,
  source       text not null default 'manual',
  external_id  text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint absences_reason_nonblank check (btrim(reason) <> ''),
  unique (org_id, external_id),                                    -- re-import is an upsert
  foreign key (org_id, operator_id) references operators (org_id, id), -- D3
  exclude using gist (operator_id with =, daterange with &&)       -- no two overlap
);
create index absences_org_operator_idx on absences (org_id, operator_id);

create trigger absences_set_updated_at
  before update on absences
  for each row execute function set_updated_at();

create trigger absences_audit
  after insert or update or delete on absences
  for each row execute function write_audit_log();

alter table absences enable row level security;

-- ⭐ READABLE BY ANYONE WHO CAN READ THE PERSON, NEVER A SECOND COPY OF THAT
-- RULE. `app_can_read_operator` (0058) is the SECURITY DEFINER twin of
-- `operators_select` --- it follows the person via `app_can_read_in_plant` on
-- their home --- and `operator_skills` already reads whom through it. The
-- absence hangs off the person exactly as a training record does, so it asks
-- the same function. There is NO insert/update/delete policy: a direct write is
-- refused (RLS default-deny), and every write goes through the RPCs below.
create policy absences_select on absences for select
  using (org_id = app_current_org() and app_can_read_operator(operator_id));

-- GRANTS. 0008's `GRANT ... ON ALL TABLES` was a one-shot over the tables that
-- existed then; a table added later grants itself (node_settings 0050 did the
-- same). Only SELECT is granted --- writes go through the SECURITY DEFINER RPCs
-- below, and there is no write policy, so a direct INSERT/UPDATE/DELETE is
-- refused twice over (no privilege, no policy). anon reaches none of it.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on absences to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on absences from anon';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- §2. `absence_overlap` --- the predicate the schedulers consult.
--
-- SECURITY DEFINER, like `check_eligibility` (0050): a line supervisor asking
-- about a person homed at the plant cannot READ that person's row, but the
-- server can still answer whether they are absent. Org-scoped so it never
-- reaches across tenants. Answers `{ absent, from, to, reason }` for the FIRST
-- absence overlapping the DAYS the range touches, in the server's date terms.
-- ----------------------------------------------------------------------------
create or replace function absence_overlap(p_operator_id uuid, p_timerange tstzrange)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_days daterange;
  v_lo   date;
  v_row  absences%ROWTYPE;
BEGIN
  IF p_operator_id IS NULL OR p_timerange IS NULL OR isempty(p_timerange) THEN
    RETURN jsonb_build_object('absent', false);
  END IF;

  -- The calendar days the shift TOUCHES, as an upper-exclusive daterange.
  -- lower(p_timerange) is included, so its day is the first touched day.
  v_lo := lower(p_timerange)::date;
  IF upper_inf(p_timerange) THEN
    -- an open-ended window touches every day from the start on.
    v_days := daterange(v_lo, NULL, '[)');
  ELSIF upper(p_timerange) = date_trunc('day', upper(p_timerange)) THEN
    -- ends EXACTLY at midnight: the last touched day is the day BEFORE it, so
    -- the upper-exclusive day bound is that midnight's own date.
    v_days := daterange(v_lo, upper(p_timerange)::date, '[)');
  ELSE
    -- ends mid-day: that day is touched, so the exclusive bound is the next day.
    v_days := daterange(v_lo, upper(p_timerange)::date + 1, '[)');
  END IF;

  SELECT * INTO v_row
    FROM absences a
   WHERE a.operator_id = p_operator_id
     AND a.org_id = app_current_org()
     AND a.daterange && v_days
   ORDER BY lower(a.daterange)
   LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('absent', false);
  END IF;

  -- `to` is the inclusive last day: the stored daterange is upper-exclusive.
  RETURN jsonb_build_object(
    'absent', true,
    'from', lower(v_row.daterange),
    'to', upper(v_row.daterange) - 1,
    'reason', v_row.reason);
END;
$function$;

comment on function absence_overlap(uuid, tstzrange) is
  'R-357. Does this operator have an absence overlapping the calendar DAYS this window touches? SECURITY DEFINER (like check_eligibility, the caller may not be able to read the person''s home) and org-scoped. A window ending exactly at midnight touches only the days strictly before it; an absence is stored day-inclusive. Answers {absent, from, to, reason} for the first overlapping absence, or {absent:false}. Mirrored on the client by absenceGaps in src/lib/absence.ts.';

revoke execute on function absence_overlap(uuid, tstzrange) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function absence_overlap(uuid, tstzrange) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function absence_overlap(uuid, tstzrange) from anon';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- §3. The writers. All three SECURITY DEFINER so the gate can be checked
--     against a person the caller may not READ: they resolve the person's home
--     from `operators` (org-scoped) and refuse `not_permitted` unless
--     `app_can_edit_node(home)` --- a supervisor or admin OF THE PERSON'S PLACE.
--     Every one reads the row back before answering (a write that reports
--     success can have changed nothing). The gate is on `home_node_id`, the
--     person's rostered place; a person with no home falls back to their owning
--     `site_node_id` so they are never editable by nobody.
-- ----------------------------------------------------------------------------
create or replace function set_absence(
  p_operator_id uuid,
  p_from        date,
  p_to          date,
  p_reason      text,
  p_external_id text default null
) returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_org    uuid;
  v_home   uuid;
  v_reason text;
  v_row    absences%ROWTYPE;
BEGIN
  IF p_operator_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_operator_id is required',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'null'));
  END IF;
  IF p_from IS NULL OR p_to IS NULL THEN
    PERFORM api_raise('invalid_argument', 'both a start and an end date are required',
      jsonb_build_object('field', 'p_from/p_to', 'reason', 'null'));
  END IF;
  IF p_to < p_from THEN
    PERFORM api_raise('invalid_argument', 'the end date is before the start date',
      jsonb_build_object('field', 'p_to', 'from', p_from, 'to', p_to, 'reason', 'inverted'));
  END IF;
  v_reason := btrim(coalesce(p_reason, ''));
  IF v_reason = '' THEN
    PERFORM api_raise('invalid_argument', 'a reason is required',
      jsonb_build_object('field', 'p_reason', 'reason', 'blank'));
  END IF;

  -- The person and the place we gate on. DEFINER, so this sees the row even for
  -- a supervisor who cannot list it; org-scoped so it never sees another tenant.
  SELECT org_id, coalesce(home_node_id, site_node_id)
    INTO v_org, v_home
    FROM operators
   WHERE id = p_operator_id AND org_id = app_current_org();
  IF v_org IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such person',
      jsonb_build_object('field', 'p_operator_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_home) THEN
    PERFORM api_raise('not_permitted', 'you cannot record an absence for someone at that place',
      jsonb_build_object('operator_id', p_operator_id, 'node_id', v_home));
  END IF;

  BEGIN
    INSERT INTO absences (org_id, operator_id, daterange, reason, source, external_id, created_by)
    VALUES (v_org, p_operator_id, daterange(p_from, p_to, '[]'), v_reason, 'manual', p_external_id, auth.uid())
    ON CONFLICT (org_id, external_id) DO UPDATE
      SET daterange = excluded.daterange, reason = excluded.reason, updated_at = now()
    RETURNING * INTO v_row;
  EXCEPTION WHEN exclusion_violation THEN
    -- The GiST exclusion: this person already has an absence on those days.
    PERFORM api_raise('absence_overlap', 'this person already has an absence over some of those days',
      jsonb_build_object('operator_id', p_operator_id, 'from', p_from, 'to', p_to, 'reason', 'overlaps'));
  END;

  -- Read the row back before answering (CLAUDE.md section 4).
  SELECT * INTO v_row FROM absences WHERE id = v_row.id;
  IF v_row.id IS NULL THEN
    PERFORM api_raise('not_permitted', 'the absence was not written',
      jsonb_build_object('operator_id', p_operator_id));
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$;

comment on function set_absence(uuid, date, date, text, text) is
  'R-357. Records or (on external_id) upserts one absence for a person. SECURITY DEFINER and gated on app_can_edit_node(the person''s home, falling back to their owning site) --- a supervisor or admin OF THE PERSON''S PLACE, refusing not_permitted otherwise. Reason is trimmed and non-empty; an overlap with an existing absence for the same person is refused (absence_overlap). Reads the row back before answering.';

create or replace function remove_absence(p_id uuid) returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_home uuid;
  v_op   uuid;
  v_rows integer;
BEGIN
  IF p_id IS NULL THEN
    PERFORM api_raise('invalid_argument', 'p_id is required',
      jsonb_build_object('field', 'p_id', 'reason', 'null'));
  END IF;

  SELECT o.coalesced_home, a.operator_id
    INTO v_home, v_op
    FROM absences a
    JOIN LATERAL (SELECT coalesce(op.home_node_id, op.site_node_id) AS coalesced_home
                    FROM operators op WHERE op.id = a.operator_id) o ON true
   WHERE a.id = p_id AND a.org_id = app_current_org();
  IF v_op IS NULL THEN
    PERFORM api_raise('invalid_argument', 'no such absence',
      jsonb_build_object('field', 'p_id', 'reason', 'not found'));
  END IF;

  IF NOT app_can_edit_node(v_home) THEN
    PERFORM api_raise('not_permitted', 'you cannot remove an absence for someone at that place',
      jsonb_build_object('absence_id', p_id, 'node_id', v_home));
  END IF;

  DELETE FROM absences WHERE id = p_id AND org_id = app_current_org();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    PERFORM api_raise('not_permitted', 'the absence was not removed',
      jsonb_build_object('absence_id', p_id));
  END IF;

  RETURN jsonb_build_object('removed', p_id);
END;
$function$;

comment on function remove_absence(uuid) is
  'R-357. Removes one absence, gated on app_can_edit_node(the person''s home) exactly as set_absence gates. ROW_COUNT compared so a filtered delete cannot report success.';

-- import_absences: the file lane. Takes rows the client planner already resolved
-- to an operator_id, and reports per-row outcomes in the SAME envelope the
-- operator import reports --- {inserted, updated, failed:[{line, message}]} ---
-- so the wizard shows which rows landed. Each row is gated on its own person's
-- place; a refused row FAILS that row without aborting the rest. Upserts on
-- external_id so a re-import updates in place.
create or replace function import_absences(p_rows jsonb) returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_row      jsonb;
  v_line     int;
  v_op       uuid;
  v_from     date;
  v_to       date;
  v_reason   text;
  v_ext      text;
  v_org      uuid;
  v_home     uuid;
  v_existing uuid;
  v_inserted int := 0;
  v_updated  int := 0;
  v_failed   jsonb := '[]'::jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    PERFORM api_raise('invalid_argument', 'p_rows must be an array of rows',
      jsonb_build_object('field', 'p_rows', 'reason', 'not_an_array'));
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_line   := coalesce((v_row->>'line')::int, 0);
    v_ext    := nullif(btrim(coalesce(v_row->>'external_id', '')), '');
    v_reason := btrim(coalesce(v_row->>'reason', ''));

    BEGIN
      v_op   := (v_row->>'operator_id')::uuid;
      v_from := (v_row->>'from')::date;
      v_to   := (v_row->>'to')::date;
    EXCEPTION WHEN others THEN
      v_failed := v_failed || jsonb_build_object('line', v_line, 'message', 'the row could not be read');
      CONTINUE;
    END;

    IF v_op IS NULL OR v_from IS NULL OR v_to IS NULL OR v_reason = '' THEN
      v_failed := v_failed || jsonb_build_object('line', v_line, 'message', 'a person, both dates and a reason are required');
      CONTINUE;
    END IF;
    IF v_to < v_from THEN
      v_failed := v_failed || jsonb_build_object('line', v_line, 'message', 'the end date is before the start date');
      CONTINUE;
    END IF;

    SELECT org_id, coalesce(home_node_id, site_node_id)
      INTO v_org, v_home
      FROM operators
     WHERE id = v_op AND org_id = app_current_org();
    IF v_org IS NULL THEN
      v_failed := v_failed || jsonb_build_object('line', v_line, 'message', 'no such person');
      CONTINUE;
    END IF;
    IF NOT app_can_edit_node(v_home) THEN
      v_failed := v_failed || jsonb_build_object('line', v_line, 'message', 'you cannot record an absence for someone at that place');
      CONTINUE;
    END IF;

    -- insert vs update is decided by whether this external_id is already here.
    v_existing := NULL;
    IF v_ext IS NOT NULL THEN
      SELECT id INTO v_existing FROM absences WHERE org_id = v_org AND external_id = v_ext;
    END IF;

    BEGIN
      INSERT INTO absences (org_id, operator_id, daterange, reason, source, external_id, created_by)
      VALUES (v_org, v_op, daterange(v_from, v_to, '[]'), v_reason, 'import', v_ext, auth.uid())
      ON CONFLICT (org_id, external_id) DO UPDATE
        SET daterange = excluded.daterange, reason = excluded.reason,
            operator_id = excluded.operator_id, source = 'import', updated_at = now();
    EXCEPTION WHEN exclusion_violation THEN
      v_failed := v_failed || jsonb_build_object('line', v_line,
        'message', 'this person already has an absence over some of those days');
      CONTINUE;
    END;

    IF v_existing IS NULL THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'failed', v_failed);
END;
$function$;

comment on function import_absences(jsonb) is
  'R-357. Applies a resolved absence import --- rows of {line, operator_id, from, to, reason, external_id} --- upserting on external_id and returning {inserted, updated, failed:[{line, message}]}, the same envelope the operator import reports. Each row is gated on app_can_edit_node(its person''s home); a refused, malformed or overlapping row fails THAT row and the rest proceed.';

revoke execute on function set_absence(uuid, date, date, text, text) from public;
revoke execute on function remove_absence(uuid) from public;
revoke execute on function import_absences(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_absence(uuid, date, date, text, text) to authenticated';
    execute 'grant execute on function remove_absence(uuid) to authenticated';
    execute 'grant execute on function import_absences(jsonb) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function set_absence(uuid, date, date, text, text) from anon';
    execute 'revoke all on function remove_absence(uuid) from anon';
    execute 'revoke all on function import_absences(jsonb) from anon';
  end if;
end $$;

-- ============================================================================
-- §4. THE SCHEDULERS CONSULT ABSENCE BESIDE ELIGIBILITY.
--
-- Each of the four is the LAST definition of the function (create_assignment
-- 0030, move_run 0050, reassign_assignment 0057, copy_week_plan 0055), re-emitted
-- with exactly one `absence_overlap` call and one branch added and NOTHING else
-- moved. The new lines are marked `-- R-357`. The rule everywhere: the resolved
-- eligibility_policy for the node decides --- `block` refuses with the new error
-- code `absent` (Copy Week clash reason `absent`), `warn` lets the placement
-- through with the absence carried as a warning in the returned payload. An
-- operator with no absence gets `{absent:false}` and byte-for-byte the old answer.
-- ============================================================================

-- ---- create_assignment (0030 §3) + one absence branch ----------------------
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

  -- R-357: `absence` joins the envelope so a warn placement carries its warning.
  RETURN jsonb_build_object('assignment', to_jsonb(v_assignment), 'eligibility', v_elig,
                            'absence', v_absence);
END;
$function$;

comment on function create_assignment(uuid,uuid,uuid,uuid,tstzrange,numeric,numeric,text,boolean,text,boolean,text) is
  'Unchanged from 0030 apart from R-357: after the eligibility gate it consults absence_overlap under the SAME resolved policy --- block refuses with `absent`, warn lets it through with the absence carried in the returned `absence` key. An operator with no absence is byte-for-byte 0030''s answer.';

-- ---- reassign_assignment (0057) + one absence branch -----------------------
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
                            'absence', v_absence);   -- R-357
END;
$function$;

comment on function reassign_assignment(uuid, uuid, boolean, text, boolean, text) is
  'R-343 / S37, and R-357: after the eligibility gate it consults absence_overlap on the row''s own window under the SAME resolved policy --- block refuses with `absent`, warn re-staffs the cell with the absence carried in the returned `absence` key. Everything else is exactly 0057.';

-- ---- move_run (0050) + absence in the block pre-check and the warn loop -----
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
                             'absence_warnings', v_absent_warnings);
END;
$function$;

comment on function move_run(uuid, uuid, tstzrange, boolean, text) is
  'Unchanged from 0050/D113 apart from R-357: every crew member is also checked against absence_overlap on their shifted window. Under block an absent crew member aborts the whole move with `absent`, listing every one (the same shape the eligibility pre-check uses); under warn the move proceeds and absent crew come back in `absence_warnings`.';

-- ---- copy_week_plan (0055) + `absent` clash reason -------------------------
-- The plan half of Copy Week gains one clash reason. For each assignment the copy
-- would shift, it now asks absence_overlap on the shifted window as well as
-- check_eligibility and capacity_probe. Precedence, one reason per item: an
-- ineligible person is `not_eligible` (as before); else an absent person is the
-- new `absent`; else a double-booked person is `operator_busy` (as before).
-- `absent` displaces nothing, so its `prior` is whatever the capacity probe
-- already listed. Under `block` the choices are `["prior"]` (the writers will not
-- take an absent copy); under `warn`, `["prior","copied"]` (create_assignment
-- takes it with the absence as a warning). apply_copy_week is UNCHANGED: it
-- re-runs this plan and writes `copied` rows through create_assignment, which now
-- allows an absent-warn placement and refuses an absent-block one on its own.
create or replace function copy_week_plan(
  p_plant_id     uuid,
  p_source_start date,
  p_target_start date
) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
DECLARE
  v_org_id     uuid;
  v_plant_path ltree;
  v_days       int;
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
BEGIN
  IF p_plant_id IS NULL
     OR NOT app_node_exists_in_org(p_plant_id)
     OR NOT app_node_is_plant_root(p_plant_id) THEN
    PERFORM api_raise('invalid_argument', 'that is not a plant',
      jsonb_build_object('field', 'p_plant_id', 'plant_id', p_plant_id, 'reason', 'not_a_plant'));
  END IF;

  IF NOT app_is_admin_for(p_plant_id) THEN
    PERFORM api_raise('not_permitted', 'you do not administer this plant',
      jsonb_build_object('plant_id', p_plant_id, 'reason', 'not_admin'));
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
  v_shift := make_interval(days => v_days);
  v_src   := tstzrange(p_source_start::timestamptz, (p_source_start + 7)::timestamptz, '[)');

  SELECT n.org_id, n.path INTO v_org_id, v_plant_path FROM nodes n WHERE n.id = p_plant_id;

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

  FOR r IN
    SELECT x.id, x.node_id, n.name AS node_name, x.product_id, pr.name AS product_name,
           x.timerange, x.planned_headcount, x.notes
      FROM runs x
      JOIN nodes n ON n.id = x.node_id
      LEFT JOIN products pr ON pr.id = x.product_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND x.product_id IS NOT NULL
     ORDER BY lower(x.timerange), n.name, x.id
  LOOP
    v_new := tstzrange(lower(r.timerange) + v_shift, upper(r.timerange) + v_shift, '[)');

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
      'key', 'run:' || r.id::text,
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

  FOR a IN
    SELECT x.id, x.node_id, n.name AS node_name,
           x.operator_id, COALESCE(o.display_name, x.operator_display_name) AS operator_name,
           x.run_id, x.product_id,
           COALESCE(pr.name, prr.name) AS product_name,
           COALESCE(x.product_id, xr.product_id) AS product_id_shown,
           x.timerange, x.efficiency, x.target_qty, x.target_unit,
           x.area_override, x.area_override_reason
      FROM assignments x
      JOIN nodes n ON n.id = x.node_id
      LEFT JOIN operators o ON o.id = x.operator_id
      LEFT JOIN products pr ON pr.id = x.product_id
      LEFT JOIN runs xr ON xr.id = x.run_id
      LEFT JOIN products prr ON prr.id = xr.product_id
     WHERE n.path <@ v_plant_path AND n.org_id = v_org_id
       AND v_src @> lower(x.timerange)
       AND x.operator_id IS NOT NULL
       AND ((x.run_id IS NULL AND x.product_id IS NOT NULL)
            OR (x.run_id IS NOT NULL AND xr.product_id IS NOT NULL AND v_src @> lower(xr.timerange)))
     ORDER BY lower(x.timerange), n.name, o.display_name, x.id
  LOOP
    v_new := tstzrange(lower(a.timerange) + v_shift, upper(a.timerange) + v_shift, '[)');

    v_elig  := check_eligibility(a.node_id, a.operator_id, v_new);
    v_probe := capacity_probe(a.operator_id, v_new, a.efficiency, NULL);
    v_fits  := COALESCE((v_probe->>'fits')::boolean, true);
    -- R-357: the absence question, same shifted window, same predicate the board
    -- and the writers use.
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
      -- R-357: absence sits between ineligible and busy in precedence; it takes
      -- the plant's resolved policy from the eligibility answer.
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
      -- R-239 / R-357: "copied" is offered only where the writers would take it.
      -- block (ineligible OR absent) refuses the copy; a busy row on a node the
      -- caller cannot edit does too.
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
      'key', 'assignment:' || a.id::text,
      'kind', 'assignment',
      'parent_key', CASE WHEN a.run_id IS NOT NULL THEN 'run:' || a.run_id::text END,
      'copied', jsonb_build_object(
        'node_id', a.node_id, 'node_name', a.node_name,
        'product_id', a.product_id_shown, 'product_name', a.product_name,
        'operator_id', a.operator_id, 'operator_name', a.operator_name,
        'start', lower(v_new), 'end', upper(v_new),
        'planned_headcount', NULL, 'notes', NULL,
        'efficiency', a.efficiency, 'target_qty', a.target_qty, 'target_unit', a.target_unit,
        'area_override', a.area_override, 'area_override_reason', a.area_override_reason),
      'status', CASE WHEN v_clash_obj IS NULL THEN 'clean' ELSE 'clash' END,
      'clash', v_clash_obj);
  END LOOP;

  RETURN jsonb_build_object(
    'plant_id', p_plant_id,
    'source_start', p_source_start,
    'target_start', p_target_start,
    'shift_days', v_days,
    'counts', jsonb_build_object('clean', v_clean, 'clash', v_clash),
    'history', jsonb_build_object('runs', v_hist_runs, 'assignments', v_hist_asg),
    'items', v_items);
END $$;

comment on function copy_week_plan(uuid, date, date) is
  'R-339 / S35, and R-357: each shifted assignment is also checked against absence_overlap. A person absent for the shifted window is a clash of reason `absent` (precedence: not_eligible, then absent, then operator_busy), offered ["prior","copied"] under warn and ["prior"] under block, exactly as the not_eligible clash is. Everything else is 0055.';
