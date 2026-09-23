# S71-e — the demo's seeded blocks fall inside each person's own shift (R-452)

Serves requirement **R-452** (the maintainer, 23 Sept, asked "why is each and every assignment
tagged as OT?" and agreed the seed should place each person's blocks inside their own band) and
keeps **R-441** (every operator has a home shift, picked by hash), **R-450** (every seeded hour is a
Chicago wall-clock hour) and the one-clock standard **R-426**.

## 0. Why every block shows OT today

`supabase/dev_demo.sql` §6 (~465-505) seeds, for every plant, every day of the week and cells 1-4,
one run and one assignment from **06:00 to 14:00 Chicago** (Shift 1's hours). R-441's hash
(~419-445) homes each person on Shift 1, 2 or 3 of the plant's pattern (360-840, 840-1320,
1320-1800 minutes; ~407-409). Plant A's six people all hashed onto Shift 2 or 3. The board's OT tag
(`AssignmentChip.tsx`/`DirectBlock.tsx` → `overtimeMinutes(range, homeBand, dayAxis)`) is minutes
outside the person's home band, so every seeded block is all overtime. The board is right; the
demo contradicts itself.

## 1. The change

In §6, replace the fixed 6h/14h offsets with the seeded person's own band: look up
`shifts.start_min`/`end_min` through `operators.home_shift_id` for the operator the loop assigns
(`o.display_name = 'Operator ' || v_letter || v_i`, ~502), and write
`v_from := (v_day + d days + start_min minutes) AT TIME ZONE v_zone`,
`v_to := (v_day + d days + end_min minutes) AT TIME ZONE v_zone`. Shift 3 is 1320-1800, i.e.
22:00 to 06:00 the next day — that is fine, it is one tstzrange. Both the run's and the
assignment's `timerange` use the same pair (they do today). The run is on the cell; keep it.

Constraints:
- §6 runs AFTER R-441's UPDATE (it does — §6 is below the DO block at ~419-445; verify the order
  in the file and say so in the report). If an operator has no home shift the seed must RAISE, not
  fall back silently — the existing ~716 check already asserts none is shiftless; add a `RAISE
  EXCEPTION` inside the loop if `start_min IS NULL` so a reorder fails loudly.
- Keep every existing comment that still holds; rewrite the "06:00 to 14:00" one (~491) to say
  the person's own band. Add a short comment naming R-452 and the OT reason above.
- `supabase/tests/dev_demo_test.sql` **D13** (~311-328) asserts every seeded block starts at
  06:00 Chicago. Change it to assert: for every seeded assignment, `lower(timerange) AT TIME ZONE
  'America/Chicago'` reads the minute-of-day of the operator's home shift `start_min`, and
  `upper - lower` equals `end_min - start_min` minutes. Keep the zone half of D13 as it is. Then
  add **D14**: no seeded assignment has a single minute outside its operator's home band on the
  band's own day (i.e. the OT count is zero), computed in SQL from the same rows. Keep the file's
  PASS/FAIL NOTICE style.
- `docs/schema.md` ~36 and the comment at the top of `supabase/seed.sql`, if either says "06:00
  to 14:00", say the person's band instead.

## 2. Proving it

Never `npm run db:reset` on the local database — the maintainer's app is on it. Prove on the
scratch demo database the way session 187 did for R-450: read the memory rule in
`CLAUDE.md` §4 and the R-450 row's `verified_by` (`grep -n "id: R-450" -A 20 docs/plan.yaml`) —
the scratch run is `node scripts/tester-run.mjs --sql` or the `--demo` form named there; if you
cannot find how the scratch database is built, look in `scripts/tester-run.mjs` for how
`dev_demo_test.sql` is applied (it builds a throwaway database on the running Postgres container
`supabase_db_production_scheduler` with a different name). Run the SQL suite there and quote the
D13/D14 lines and the total.

Then grep for anything that assumed 06:00-14:00 seeded blocks: `grep -rn "06:00\|14:00" e2e
src/test | grep -iv "absence\|shift"` and read each hit that refers to seeded assignments (not the
walk's own typed hours). The typed walk clears its day first, so it should not care; say what you
found. `e2e/linePeople.spec.ts` was changed on 22 Sept to wait for shift chips — read it and say
whether it still holds. Do not run e2e against the local stack unless the maintainer's app being
open does not matter for that spec (read-only specs are fine).

## 3. Files you own / must not touch

Own: `supabase/dev_demo.sql` (§6 and its comments only), `supabase/tests/dev_demo_test.sql`,
`docs/schema.md` (one line), `supabase/seed.sql` (comment only).

Do NOT touch: `supabase/migrations/*` (append-only, and nothing here needs one), anything under
`src/` or `scripts/` (three other lanes), `docs/plan.yaml`. Do not run the full `npm run test`. Do
not commit.

## 4. Report shape

Under 30 lines: the new §6 lines verbatim; the D13/D14 output on the scratch database and the
suite total; the grep hits and your reading of each; anything left.
