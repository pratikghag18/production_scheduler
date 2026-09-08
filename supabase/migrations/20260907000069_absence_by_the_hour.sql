-- ============================================================================
-- 0069 --- AN ABSENCE MAY BE PART OF A DAY, AND A CLASH IS JUDGED BY THE HOURS
-- (R-359), EXTENDING 0066 (R-357).
--
-- The maintainer, 7 Sept: "sometimes operators could be out only for a few
-- hours, we need a way to record that as well." 0066 gave an absence a
-- `daterange`, both ends inclusive, judged by the calendar DAYS a shift
-- touches. That stays exactly what it is for a WHOLE-DAY absence. A PART-DAY
-- absence is ONE calendar day plus a start and an end clock time, and it
-- clashes with a placement only where the HOURS overlap -- a person out
-- 09:00-13:00 is a clash for the morning shift and not the night one.
--
-- ⭐ WHY AN INSTANT RANGE, AND WHY THE CLIENT CONVERTS IT. The wall clock a
-- person names ("out 9 to 1") means nothing without a zone, and R-353's rule
-- is that only the client computes wall-clock geometry, through the one
-- shared `Intl` primitive (`zonedTimeToInstant`), so there is no second
-- implementation of a DST fold to drift from the first. So `timerange` is a
-- nullable `tstzrange` -- an ABSOLUTE instant range, already converted -- and
-- the server compares two `tstzrange`s and resolves no timezone at all, the
-- same division of labour 0066 already drew between `board_window`'s zone and
-- `zonedTimeToInstant`'s conversion. `daterange` keeps holding the single day
-- a part-day absence falls on (CHECK below), so every existing read, index and
-- display of `daterange` keeps working, whole-day or part-day, and the two
-- columns can never disagree because a CHECK ties them together. A `tstzrange`
-- CANNOT be checked for containment inside a `daterange` without resolving a
-- timezone in SQL, which is exactly what storing the day separately avoids.
--
-- WHAT THIS MIGRATION HOLDS:
--   A1. `absences.timerange tstzrange`, nullable. NULL = whole-day (today's
--       behaviour, byte for byte). CHECK: non-null implies non-empty, bounded
--       at both ends, and `daterange` is exactly one day.
--   A2. The single exclusion constraint replaced by TWO partial ones: whole-day
--       rows exclude each other on `daterange`, part-day rows exclude each
--       other on `timerange`. A part-day row inside a whole-day absence is
--       therefore ALLOWED -- deliberate, and harmless: `absence_overlap`
--       returns the first overlapping row either way, so "absent" is answered
--       correctly regardless of which of the two rows it happens to read.
--   A3. `absence_overlap` -- extracted from 0066 SS2, one clause changed: a
--       part-day row is tested against the HOURS (`timerange && p_timerange`)
--       instead of the days. Additive jsonb keys `starts_at`/`ends_at` on a
--       part-day hit; `absent`/`from`/`to`/`reason` unchanged byte for byte.
--   A4. The four schedulers (create_assignment, move_run, reassign_assignment,
--       copy_week_plan) are NOT re-emitted -- read below, confirmed: every one
--       carries the whole `absence_overlap` answer forward under an `absence`/
--       `absence_warnings`/`clash` key and reads only `absent` off it to
--       decide; none destructures `from` or `to` to build a message, so the
--       additive keys ride along unread and unbroken.
--   A5. `set_absence` -- extracted from 0066 SS3, two new optional trailing
--       parameters (`p_starts_at`, `p_ends_at`, both `timestamptz default
--       null`). Both null is today's behaviour, byte for byte. The OLD
--       five-argument function is DROPPED in the same migration: Postgres
--       treats a different parameter count as a DIFFERENT overload, and
--       leaving both to exist side by side would let a caller reach the one
--       that ignores the times, or make a five-argument call ambiguous once
--       the new function's own trailing parameters also default. One
--       signature, so there is exactly one function named `set_absence` and
--       every caller goes through the one that knows about hours.
--   A6. `import_absences` is NOT re-emitted -- confirmed below: it names an
--       explicit column list on INSERT that does not mention `timerange`, so
--       every imported row is written NULL (whole-day) exactly as before. The
--       CSV import stays whole-day in this piece (R-359's own note); widening
--       it needs the planner to learn a zone, a separate piece of work.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). `absence_overlap` and
-- `set_absence` below are the LAST definitions (0066), each with the minimal
-- edit this header describes and nothing else moved. `grep -in "function
-- \(public\.\)\?absence_overlap(" supabase/migrations/*.sql` and `... set_absence(`
-- both land on 0066 as the last hit before this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A1. The column, and the CHECK tying it to `daterange`.
-- ----------------------------------------------------------------------------
alter table absences add column timerange tstzrange;

alter table absences add constraint absences_timerange_valid check (
  timerange is null
  or (
    not isempty(timerange)
    and not lower_inf(timerange)
    and not upper_inf(timerange)
    and (upper(daterange) - lower(daterange)) = 1
  )
);

comment on column absences.timerange is
  'R-359: NULL = whole-day (0066''s original shape, judged by absences.daterange). Non-null = a part-day absence, an ABSOLUTE instant range already converted from wall-clock ON THE CLIENT (zonedTimeToInstant, the person''s plant zone) -- the server resolves no timezone. absences_timerange_valid ties it to daterange: non-null is non-empty, bounded at both ends, and daterange is exactly the one day it falls on, so the two columns can never disagree.';

-- ----------------------------------------------------------------------------
-- A2. The exclusion constraint, replaced by two partial ones. 0066's single
-- `exclude using gist (operator_id with =, daterange with &&)` refused a
-- second part-day absence on a day already covered by a whole-day one, and
-- (worse) refused two NON-overlapping part-day absences on the same calendar
-- day (a morning appointment and an evening one) purely because they shared a
-- day. Splitting the exclusion by KIND fixes both: whole-day rows still
-- exclude each other on days; part-day rows exclude each other on hours; nothing
-- stops a part-day row landing inside a whole-day one, because the predicate
-- that matters (`absence_overlap`) returns "absent" from whichever row it
-- reads first -- the row picked by ORDER BY is irrelevant to the boolean.
-- ----------------------------------------------------------------------------
alter table absences drop constraint absences_operator_id_daterange_excl;

alter table absences add constraint absences_whole_day_excl
  exclude using gist (operator_id with =, daterange with &&)
  where (timerange is null);

alter table absences add constraint absences_part_day_excl
  exclude using gist (operator_id with =, timerange with &&)
  where (timerange is not null);

-- ----------------------------------------------------------------------------
-- A3. `absence_overlap` -- extracted from 0066 SS2. The WHERE gains a branch: a
-- part-day row is tested against the HOURS (`timerange && p_timerange`)
-- instead of the days; a whole-day row is tested exactly as before. ORDER BY
-- becomes the row's EFFECTIVE start so the ordering stays deterministic across
-- both kinds -- coalesce(lower(timerange)::date, lower(daterange)) is the same
-- day either way (daterange always holds a part-day row's single day too), so
-- this is really a tie-break: `lower(timerange) NULLS FIRST` puts a whole-day
-- row before a part-day row that starts the same day, which only matters for
-- WHICH row's reason is returned when both would answer "absent" the same way.
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
  v_payload jsonb;
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
     -- R-359: a whole-day row is judged by the DAYS the shift touches (0066,
     -- unchanged); a part-day row is judged by the HOURS themselves, on the
     -- absolute instant ranges -- neither side resolves a timezone.
     AND ( (a.timerange IS NULL     AND a.daterange && v_days)
        OR (a.timerange IS NOT NULL AND a.timerange && p_timerange) )
   -- Deterministic across both kinds: same effective day either way (daterange
   -- always carries a part-day row's own single day too), then whole-day
   -- before part-day on a tied day (NULLS FIRST) -- see header.
   ORDER BY coalesce(lower(a.timerange)::date, lower(a.daterange)),
            lower(a.timerange) NULLS FIRST
   LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('absent', false);
  END IF;

  -- `to` is the inclusive last day: the stored daterange is upper-exclusive.
  -- Byte for byte 0066's answer for a whole-day hit; a part-day hit gains two
  -- ADDITIVE keys (starts_at/ends_at, the instants) so a caller can say the
  -- hours. Four other functions read this payload and forward it whole, so the
  -- additive keys ride along unread and unbroken (see this file's header, A4).
  v_payload := jsonb_build_object(
    'absent', true,
    'from', lower(v_row.daterange),
    'to', upper(v_row.daterange) - 1,
    'reason', v_row.reason);
  IF v_row.timerange IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object(
      'starts_at', lower(v_row.timerange),
      'ends_at', upper(v_row.timerange));
  END IF;
  RETURN v_payload;
END;
$function$;

comment on function absence_overlap(uuid, tstzrange) is
  'R-357/R-359. Does this operator have an absence overlapping the window -- by calendar DAYS for a whole-day absence (a window ending exactly at midnight touches only the days strictly before it), by the HOURS THEMSELVES for a part-day one (timerange && p_timerange, no timezone resolved on either side). SECURITY DEFINER (like check_eligibility, the caller may not be able to read the person''s home) and org-scoped. Answers {absent, from, to, reason} for the first overlapping absence (ORDER BY the row''s effective start, whole-day before part-day on a tied day), plus {starts_at, ends_at} (instants) when that row is part-day, or {absent:false}. Mirrored on the client by absenceGaps in src/lib/absence.ts.';

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
-- A5. `set_absence` -- extracted from 0066 SS3. Two new OPTIONAL TRAILING
-- parameters carry the part-day window as instants; the existing five are
-- untouched and in the same order. Both null = today's behaviour, byte for
-- byte. Both given = a part-day absence: p_from must equal p_to (one calendar
-- day), p_ends_at must be after p_starts_at, and the row is inserted with
-- `timerange` set. Exactly one of the two given is invalid_argument. The OLD
-- five-argument function is DROPPED first (see header A5) so there is exactly
-- one `set_absence` and no caller can reach a version that ignores the times.
-- ----------------------------------------------------------------------------
drop function if exists set_absence(uuid, date, date, text, text);

create or replace function set_absence(
  p_operator_id uuid,
  p_from        date,
  p_to          date,
  p_reason      text,
  p_external_id text default null,
  p_starts_at   timestamptz default null,
  p_ends_at     timestamptz default null
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
  v_timerange tstzrange;
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

  -- R-359: the part-day window, both given or neither.
  IF num_nonnulls(p_starts_at, p_ends_at) = 1 THEN
    PERFORM api_raise('invalid_argument', 'a part-day absence needs both a start and an end time',
      jsonb_build_object('field', 'p_starts_at/p_ends_at', 'reason', 'one_without_the_other'));
  END IF;
  IF p_starts_at IS NOT NULL AND p_ends_at IS NOT NULL THEN
    IF p_ends_at <= p_starts_at THEN
      PERFORM api_raise('invalid_argument', 'the end time is not after the start time',
        jsonb_build_object('field', 'p_ends_at', 'starts_at', p_starts_at, 'ends_at', p_ends_at, 'reason', 'inverted'));
    END IF;
    IF p_from <> p_to THEN
      PERFORM api_raise('invalid_argument', 'a part-day absence is a single day',
        jsonb_build_object('field', 'p_from/p_to', 'from', p_from, 'to', p_to, 'reason', 'not_one_day'));
    END IF;
    v_timerange := tstzrange(p_starts_at, p_ends_at, '[)');
  ELSE
    v_timerange := NULL;
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
    INSERT INTO absences (org_id, operator_id, daterange, timerange, reason, source, external_id, created_by)
    VALUES (v_org, p_operator_id, daterange(p_from, p_to, '[]'), v_timerange, v_reason, 'manual', p_external_id, auth.uid())
    ON CONFLICT (org_id, external_id) DO UPDATE
      SET daterange = excluded.daterange, timerange = excluded.timerange,
          reason = excluded.reason, updated_at = now()
    RETURNING * INTO v_row;
  EXCEPTION WHEN exclusion_violation THEN
    -- One of the two partial GiST exclusions (A2): this person already has an
    -- absence overlapping those days (whole-day) or those hours (part-day).
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

comment on function set_absence(uuid, date, date, text, text, timestamptz, timestamptz) is
  'R-357/R-359. Records or (on external_id) upserts one absence for a person, whole-day or part-day. SECURITY DEFINER and gated on app_can_edit_node(the person''s home, falling back to their owning site) --- a supervisor or admin OF THE PERSON''S PLACE, refusing not_permitted otherwise. Reason is trimmed and non-empty. p_starts_at/p_ends_at both null is a whole-day absence, byte for byte 0066''s behaviour; both given makes it part-day, p_from must equal p_to and p_ends_at must be after p_starts_at, else invalid_argument; exactly one given is also invalid_argument. An overlap with an existing absence (days for whole-day, hours for part-day) is refused (absence_overlap). Reads the row back before answering. This is the ONLY set_absence: the five-argument 0066 signature was dropped in 0069 so no caller can reach a version that ignores the times.';

revoke execute on function set_absence(uuid, date, date, text, text, timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function set_absence(uuid, date, date, text, text, timestamptz, timestamptz) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function set_absence(uuid, date, date, text, text, timestamptz, timestamptz) from anon';
  end if;
end $$;

-- ============================================================================
-- A4/A6, CONFIRMED BY READING (nothing to re-emit):
--
-- create_assignment (0066): `v_absence := absence_overlap(...)`, then reads
-- only `v_absence->>'absent'` to decide block/warn, and forwards the WHOLE
-- jsonb unread as `'absence', v_absence` in its own return. No `from`/`to`.
--
-- reassign_assignment (0066): identical shape -- `(v_absence->>''absent'')`
-- decides, `'absence', v_absence` forwards the whole object.
--
-- move_run (0066): `(v_absence->>''absent'')::boolean` decides both the block
-- pre-check loop and the warn loop; the whole `v_absence` rides inside
-- `v_absent`/`v_absent_warnings` arrays as `jsonb_build_object(''operator_id'',
-- ..., ''absence'', v_absence)`. No `from`/`to` read out of it.
--
-- copy_week_plan (0066): `v_is_absent := (v_absence->>''absent'')::boolean`
-- decides the clash reason and precedence; the whole `v_absence` rides in the
-- clash object as `''absence'', CASE WHEN v_is_absent THEN v_absence ELSE
-- NULL END`. No `from`/`to` read out of it.
--
-- So every one of the four already forwards `absence_overlap`'s answer WHOLE
-- rather than destructuring it, and the two new keys ride along unread and
-- unbroken. Re-emitting any of them would be pure risk for no behaviour change
-- (CLAUDE.md section 4: extract only what must change).
--
-- import_absences (0066): `INSERT INTO absences (org_id, operator_id,
-- daterange, reason, source, external_id, created_by)` names an explicit
-- column list that does not mention `timerange`; a column omitted from an
-- INSERT's column list takes its default, and 0069 gave `timerange` no
-- default, so it is NULL -- every imported row is whole-day, exactly as R-359
-- says the CSV import stays. Not re-emitted.
-- ============================================================================
