-- ============================================================================
-- 0073 -- an imported absence can be part of a day, like a typed-in one
--
-- R-359 shipped part-day absences everywhere EXCEPT the CSV import, and said so
-- in 0069's own header (note A6): `import_absences` "names an explicit column
-- list on INSERT that does not mention `timerange`, so every imported row is
-- written NULL (whole-day) exactly as before. The CSV import stays whole-day in
-- this piece (R-359's own note); widening it needs the planner to learn a zone,
-- a separate piece of work." This is that piece of work.
--
-- ⛔ WHY IT MATTERED. Absence is BOTH typed in and imported -- the decision from
-- session 85. Typing it in learned about hours in 0069; the monthly sheet from
-- HR did not, so a morning-only appointment arriving by CSV was stored as the
-- WHOLE DAY OFF and someone had to find it and fix it by hand. The row was not
-- refused and nothing looked wrong; it was simply more absence than the truth.
--
-- ⭐ THE RULES ARE `set_absence`'S OWN, TRANSCRIBED RATHER THAN INVENTED, so a
-- row the import accepts is exactly a row the typed-in form would accept:
--   1. both times or neither (0069: `num_nonnulls(p_starts_at, p_ends_at) = 1`)
--   2. the end time must be after the start time
--   3. a part-day absence is a SINGLE day, so `from` must equal `to`
--   4. the stored window is `tstzrange(starts, ends, '[)')` -- half-open, so a
--      shift starting the instant an absence ends does not clash (DEF-0022)
-- The one difference is what a violation DOES. `set_absence` raises and the
-- whole call fails; an import must fail THAT ROW and let the rest proceed, which
-- is this function's existing contract for every other bad row.
--
-- ⚠️ EXTRACTED, NOT RETYPED (CLAUDE.md section 4). `import_absences` below is
-- 0066's definition -- `grep -in "function \(public\.\)\?import_absences("
-- supabase/migrations/*.sql` lands on 20260907000066_absences.sql:316 as the
-- last hit -- with only the changes this header describes. The signature is
-- unchanged (`import_absences(p_rows jsonb)`), so there is no second overload to
-- reach past: the two new keys ride inside the SAME jsonb rows argument, which
-- is why this needs no DROP and no grant changes. Rows that carry neither key
-- behave byte for byte as before.
-- ============================================================================

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
  -- R-359: the part-day window. Both instants or neither; NULL means whole-day,
  -- which is every row an older sheet produces.
  v_starts_at timestamptz;
  v_ends_at   timestamptz;
  v_timerange tstzrange;
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
      -- R-359. Absent keys read as NULL, which is the whole-day row; a key
      -- present but unparseable as an instant lands in this same handler and
      -- fails the row rather than silently widening it to the whole day.
      v_starts_at := (v_row->>'starts_at')::timestamptz;
      v_ends_at   := (v_row->>'ends_at')::timestamptz;
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

    -- R-359, set_absence's three part-day rules, in its order. A violation
    -- fails THIS row; the rest of the sheet still applies.
    IF num_nonnulls(v_starts_at, v_ends_at) = 1 THEN
      v_failed := v_failed || jsonb_build_object('line', v_line,
        'message', 'a part-day absence needs both a start and an end time');
      CONTINUE;
    END IF;
    IF v_starts_at IS NOT NULL AND v_ends_at IS NOT NULL THEN
      IF v_ends_at <= v_starts_at THEN
        v_failed := v_failed || jsonb_build_object('line', v_line,
          'message', 'the end time is not after the start time');
        CONTINUE;
      END IF;
      IF v_from <> v_to THEN
        v_failed := v_failed || jsonb_build_object('line', v_line,
          'message', 'a part-day absence is a single day');
        CONTINUE;
      END IF;
      v_timerange := tstzrange(v_starts_at, v_ends_at, '[)');
    ELSE
      v_timerange := NULL;
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
      -- `timerange` joins the column list and the DO UPDATE set. A re-upload
      -- that drops the time columns therefore writes NULL over a previously
      -- part-day row, which is the same "the sheet is the truth" rule the other
      -- columns already follow -- and matches set_absence, whose own DO UPDATE
      -- sets `timerange = excluded.timerange` unconditionally.
      INSERT INTO absences (org_id, operator_id, daterange, timerange, reason, source, external_id, created_by)
      VALUES (v_org, v_op, daterange(v_from, v_to, '[]'), v_timerange, v_reason, 'import', v_ext, auth.uid())
      ON CONFLICT (org_id, external_id) DO UPDATE
        SET daterange = excluded.daterange, timerange = excluded.timerange,
            reason = excluded.reason,
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
  'R-357/R-359. Applies a resolved absence import --- rows of {line, operator_id, from, to, reason, external_id} plus OPTIONAL {starts_at, ends_at} instants for a part-day row --- upserting on external_id and returning {inserted, updated, failed:[{line, message}]}, the same envelope the operator import reports. The part-day rules are set_absence''s own, transcribed: both times or neither, the end after the start, and a single day (from = to); the stored window is half-open. Each row is gated on app_can_edit_node(its person''s home); a refused, malformed or overlapping row fails THAT row and the rest proceed.';
