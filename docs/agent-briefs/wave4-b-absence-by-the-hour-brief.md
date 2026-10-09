# Lane brief: R-359 and R-360 — an absence can be a few hours, and a person's absences are on their record

You are a build lane. You own exactly these files and no others:

- `supabase/migrations/20260907000069_absence_by_the_hour.sql` (new — this exact name)
- `supabase/tests/88_absences_test.sql` (add cases only; never reword an existing one)
- `src/lib/absence.ts`
- `src/lib/api/absences.ts`
- `src/features/board/lib/leave.ts`
- `src/features/admin/components/AbsencesPanel.tsx` and `AbsencesPanel.module.css`
- `src/features/admin/components/OperatorAbsences.tsx` and `OperatorAbsences.module.css` (new)
- `src/features/admin/components/OperatorsPanel.tsx` (**one insertion only**, see part D)
- `src/test/absence.test.ts`, `src/test/absencesPanel.test.tsx`, `src/test/absenceOnBoard.test.tsx`
- `src/test/operatorAbsences.test.tsx` (new)
- `src/test/scaleAudit.ts` and `src/test/scaleAudit.test.ts` (the `REM_SURFACES` list, **both copies**)

Another lane is changing the board toolbar, the Copy Week dialog, the Save-template dialog and the
Templates panel. Do not touch any of those. Ignore `tsc` errors in files you do not own. Do NOT run
the full `npm run test`. Do NOT run `npm run db:reset` — the maintainer is using the app. Do not
commit; do not edit `docs/plan.yaml` or `docs/defects/*.md`.

**Read first, in this order and in full:** `CLAUDE.md` §4 (every line — the migration rules, the
"extract, never retype" rule, the definer rule, the two-copies rule), then `docs/plan.yaml`'s
**R-357**, **R-359** and **R-360** rows (grep `^- id: R-357` etc.), then
`supabase/migrations/20260907000066_absences.sql` **whole** — its header is the reasoning you are
extending, and 0069's header must say why it is being extended — then `src/lib/absence.ts` whole,
then `src/features/board/lib/time.ts`'s `zonedTimeToInstant`.

---

## Part 1 — the decisions already made. Do not re-litigate any of these.

1. **A whole-day absence is untouched.** Same `daterange`, both ends inclusive, judged by the
   calendar DAYS a shift touches. Every boundary case already pinned in `absence.test.ts` and
   `88_absences_test.sql` must stay green with the same names and the same numbers.
2. **A part-day absence is ONE calendar day plus a start and an end clock time.** Not a time window
   repeated across a range. One row, one day.
3. **It is stored as an absolute instant range — a nullable `tstzrange` column — and the wall-clock
   to instant conversion happens ON THE CLIENT**, through `zonedTimeToInstant` in the person's plant
   zone. This is not a preference: R-353's rule is that only the client computes wall-clock
   geometry, through one shared `Intl` primitive, so there is no second implementation to drift from
   the first. The server compares two `tstzrange`s and resolves no timezone at all.
4. **The zone is the PERSON'S plant's zone, not the reader's plant filter.** Resolve it from the
   person's own home/site node's plant root. If you cannot get the person's zone without walking the
   tree in the browser, **stop and say so** — a client-side ancestry walk is exactly DEF-0016 and
   DEF-0017 and you must not add a third one. (`usePlantOverrides(enabled, nodeId)` in
   `src/features/admin/hooks/useOrgSettings.ts` returns a plant's `timezone`, and
   `useCompanyTimezone` is the fallback. Read both before you design this.)
5. **A part-day absence clashes only where the HOURS overlap.** Out 09:00-13:00 clashes with the
   morning shift and not with the night one.
6. **The CSV import stays whole-day** in this lane. Do not touch `absenceImport.ts`,
   `AbsencesImport.tsx` or `absenceImport.test.ts`. If you can add one sentence of copy to the
   import wizard from inside a file you own, do; if you cannot, say so and it will be queued.

---

## Part A — migration 0069

One migration, append-only, and every function you re-emit **extracted from its last definition**
(slice the body out of the file with a script, apply the minimal edit, and assert on the assembled
text that every clause you expect is present exactly once before writing it; 0053 retyped and
silently dropped a rule — DEF-0011). `grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql`
and take the **LAST** hit; the `-i` and the optional `public.` are not decoration.

**A1. The column.**

    alter table absences add column timerange tstzrange;

NULL = a whole-day absence, exactly what exists today. Non-null = a part-day absence, and then
`daterange` still holds the single day it falls on, so every existing read, index and display keeps
working and the two can never disagree. Add a CHECK that a non-null `timerange` is non-empty and
bounded at both ends, and that the row's `daterange` is exactly one day long whenever `timerange` is
not null. (Containment of a `tstzrange` inside a `daterange` cannot be checked without a timezone,
which is precisely why the times are stored as instants and the day is stored separately — say that
in the header.)

**A2. The exclusion constraint.** Today: `exclude using gist (operator_id with =, daterange with &&)`
— one person cannot hold two absences overlapping in days. That would refuse a second part-day on
the same day (a morning appointment and an evening one), which is wrong. Replace it with **two
partial exclusions**:

- whole-day rows cannot overlap each other, `where (timerange is null)`;
- part-day rows cannot overlap each other in time, on `timerange`, `where (timerange is not null)`.

A part-day row inside a whole-day absence is then allowed. That is deliberate and harmless — the
predicate returns the first overlapping row either way — and the header must say so in those terms.
Dropping and re-adding a constraint in a NEW migration file is fine; the append-only rule is about
never editing an old file. If either partial exclusion will not build (a GiST opclass problem, say),
**stop and report it** rather than inventing a third shape.

**A3. `absence_overlap(uuid, tstzrange)` — extracted from 0066 §2, one clause changed.** The
`WHERE` becomes:

    AND ( (a.timerange IS NULL     AND a.daterange && v_days)
       OR (a.timerange IS NOT NULL AND a.timerange && p_timerange) )

`ORDER BY` must still be deterministic across both kinds — order by the row's effective start
(`coalesce(lower(a.timerange)::date, lower(a.daterange))`, then `lower(a.timerange)` nulls first) —
and a comment must say why. The returned jsonb keeps `absent`, `from`, `to`, `reason` **byte for
byte for a whole-day hit** and gains two keys for a part-day hit: the ISO instants of
`lower(timerange)` and `upper(timerange)`. Choose the key names, state them in the report, and use
matching names on the client. Additive keys only — four other functions read this payload and you
are not re-emitting any of them.

**A4. Confirm you do not need to touch the four schedulers.** `create_assignment`, `move_run`,
`reassign_assignment` and `copy_week_plan` call `absence_overlap` and read `absent` and `reason` out
of its answer. Grep each one's last definition and **prove** that to yourself before deciding. If
any of them reads `from` or `to` to build a message, say so and stop — re-emitting four schedulers
is a different-sized job and is not in this lane.

**A5. `set_absence`** — extracted from 0066 §3, with two new optional parameters carrying the
part-day window as instants (`p_starts_at timestamptz default null, p_ends_at timestamptz default
null`). **Append them; do not reorder the existing five.** Both null = today's behaviour, byte for
byte. Both given = the row is a part-day absence and `p_from` must equal `p_to`; one given without
the other is `invalid_argument`; `p_ends_at <= p_starts_at` is `invalid_argument`. **Check the
grants**: a changed signature is a new function as far as `grant execute` is concerned, so restate
`revoke ... from public`, the grant to `authenticated` and the revoke from `anon` for the new
signature — 0066's grant block at the bottom of the file is the pattern. Decide and state whether
the old five-argument function should be dropped or left in place; whichever you choose, no caller
may be left able to reach a version that ignores the times. Read the row back before answering, as
it already does.

Update every `COMMENT ON FUNCTION` you re-emit so the last definition's comment describes what the
function actually now does. The migration header explains, in the repo's register (read 0066's
header for the voice), why the times are instants rather than a `time` column and why the client
does the conversion.

**A6. `import_absences` is NOT re-emitted.** It writes whole-day rows and stays exactly as it is.
Confirm by reading it that a new nullable column defaulting to NULL cannot change its behaviour, and
say so.

---

## Part B — the client mirror, `src/lib/absence.ts`

`AbsenceRow` gains two optional fields for the part-day window (the same concept as the server's two
new keys — instants, or ISO strings you parse once; one shape, stated in the report).
`AbsenceWindow` is unchanged. `absenceGaps` gains exactly one branch:

- a row with no part-day window: today's day-touching arithmetic, unchanged, character for character
  where you can manage it;
- a row with one: a hit iff `[start, end)` overlaps the placement window's `[start, end)`, with the
  open-ended (`end === null`) case handled — an open-ended window overlaps any part-day window that
  ends at or after its start.

`AbsenceHit` gains the same two optional fields so the pop-ups can say the hours. The module stays
**dependency-free** — it runs under `node --experimental-strip-types` — so do not import
`zonedTimeToInstant` or anything else into it.

Its header comment is load-bearing documentation; extend it, do not replace it. State the new rule
in the same voice, and say which boundary cases are pinned on **both** sides by the same names.

`src/features/board/lib/leave.ts` turns a hit into a sentence. A part-day hit reads as the day plus
the hours, in the plant's zone and the plant's date format, using `formatClock` from
`src/features/board/lib/time.ts`. A whole-day hit's sentence does not change.

---

## Part C — `src/lib/api/absences.ts` and the Absences panel

`ABSENCE_COLUMNS` is **the one column list** — add `timerange` to it, and nothing else builds a
second copy (CLAUDE.md §4: a column list that appears twice is a bug with a delay on it). Grep the
repo for a second copy of that list before you add the column, and say what you found.
`AbsenceRecord` gains the two optional fields; the runtime guard returns `null` on a shape mismatch
rather than trusting the generated types, as the file already does. `setAbsence`'s input type gains
the two optional instants.

`AbsencesPanel.tsx`'s "Record an absence" form gains a checkbox — "Part of a day" — that swaps the
two date inputs for one date input plus a start and an end `type="time"` input. Whole-day is the
default and the untouched path. The table gains the hours on a part-day row (an empty cell or a dash
on a whole-day row — follow the panel's own convention, look at what it already does). The zone the
times are read in must be named on screen where it is not obvious: 09:00 means nothing without it.

The panel decides no permission and pre-guesses no refusal — `set_absence` is the authority and a
refusal is shown in words. That rule is in the file's own header; keep it true.

---

## Part D — the person's own absences, in the Operators tab (R-360)

**New component `OperatorAbsences.tsx`**, taking the selected person's id, display name and home
node as props. It reads `fetchAbsences` through its own `useQuery` on the existing `absenceKeys` key
(so it shares the cache with the Absences tab and one invalidation refreshes both), filters to that
person, and renders:

- that person's absences, soonest first, whole-day and part-day, each with its reason;
- past ones behind a "show past" toggle, hidden by default, with the count named;
- a small form to record one and a Remove on each row, calling the same `setAbsence` /
  `removeAbsence` this lane already owns, under the same refusal-in-words rule as Part C;
- an honest empty state naming the person.

**`OperatorsPanel.tsx` gets ONE insertion and nothing else**: render `<OperatorAbsences …/>` inside
`<section className={styles.detail}>`, after the "Where {name} can work" block (find it by that
string; it is around line 989 and the section closes around line 1227). Do not restructure that
file, do not move its state, do not touch its other 1200 lines. If the person's plant zone cannot be
reached from there without a new query, add the query **inside your new component**, not in
`OperatorsPanel`.

`OperatorAbsences.module.css` is layout only, `rem` units, one module for the component
(`docs/conventions.md`). **Adding a stylesheet to the admin components directory means adding it to
`REM_SURFACES` in BOTH `src/test/scaleAudit.ts` AND its copy in `src/test/scaleAudit.test.ts`** —
CLAUDE.md §4 names this exact two-place edit, and `scaleAudit.test.ts`'s R10 case counts the list, so
its count sentence needs updating too.

---

## Proving it

Copy each runner's own summary line into your report; never a number you reasoned to.

1. **The SQL suite — you are the only lane using the scratch database.**
   `bash scripts/run-sql-test.sh --rebuild`, then every file in order:
   `for f in supabase/tests/[0-9]*_test.sql; do bash scripts/run-sql-test.sh $(basename $f) || echo "RED: $f"; done`.
   Session 87 measured **758 passed, 0 failed**. Your total must be 758 plus your new cases, and
   zero failed. If a pre-existing case goes red, **read that case before touching your fix** and say
   in writing whether the case was wrong or the contract changed.
2. **New cases in `88_absences_test.sql`**, as `PASS <id>` / `FAIL <id>: <why>` notices in the
   file's own style, at minimum: a part-day absence 09:00-13:00 clashes with a shift overlapping
   those hours and does NOT clash with one that does not; the same person can hold two non-touching
   part-day absences on one day and cannot hold two overlapping ones; a whole-day absence still
   cannot overlap another whole-day absence; `set_absence` with only one of the two times refuses
   `invalid_argument`; a part-day row whose from and to are different days refuses; every existing
   case in the file still passes by name.
3. **Deliberate breakage, and this is not optional.** Strip the part-day branch out of
   `absence_overlap`'s WHERE (leaving the whole-day term), rebuild the scratch database, and confirm
   a named new case goes red. Then restore it. Report which case caught it. A green case that
   catches nothing is worth nothing.
4. `npx vitest run src/test/absence.test.ts src/test/absencesPanel.test.tsx src/test/absenceOnBoard.test.tsx src/test/operatorAbsences.test.tsx src/test/operatorsPanel.test.tsx src/test/scaleAudit.test.ts`
   — green, with new cases for both sides of the hours boundary in `absenceGaps`, **named the same
   as the SQL cases that pin the same boundary**, and for the panel and the new component.
5. `npm run db:types`, then `npx tsc --noEmit`. **`tsc` is inconclusive until `db:types` has run**
   after a migration touches a column — say "inconclusive", never "clean", if you skipped it. A
   CRLF-only diff on the generated types file is the known false positive; say which you saw.
6. `npx eslint` over the files you own.
7. **Apply 0069 to the running local stack without a reset**: `npx supabase migration up` from
   PowerShell; if the CLI is not on PATH, apply the file with
   `docker exec -i supabase_db_production_scheduler psql -U postgres -d postgres < <file>` and say
   plainly that the migration table was not updated.
8. **Drive it in a browser as a real person.** `npm run dev` is expected on http://localhost:5173;
   start it in the background if it is not, and say so. Record a part-day absence for a demo
   operator in the Absences tab, see it on that person's record in the Operators tab, then place
   them on the board over those hours and over different hours and read what the board says both
   times. Then run
   `npx playwright test e2e/absences.spec.ts e2e/absenceOnBoard.spec.ts e2e/roleWalk.spec.ts --project=chromium`
   — `roleWalk` walks the least-privileged demo people through the board and the rail, and CLAUDE.md
   §4 says to walk the changed screens as them before saying done. Paste the summary lines.

## Report

Plain prose, no bullet lists. Include: the exact SQL text of the new column, both new exclusion
constraints and the new `WHERE` clause; the two new payload key names and the matching client field
names; which case went red when you broke `absence_overlap`; the SQL suite's totals copied from the
runner's tally lines; every vitest and playwright summary line; what you saw in the browser in your
own words; and everything you noticed and did not fix.
