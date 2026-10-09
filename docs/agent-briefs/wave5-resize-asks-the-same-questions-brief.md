# Lane brief: R-361 — a resize asks the same two questions the other four writers ask

You are a build lane closing the last gap in R-357 and R-338. The maintainer decided it on 8 Sept,
asked directly: *"The resize should get similar warnings as other 4."* The requirement is already
written into `docs/plan.yaml` as **R-361** — read that row first (grep `^- id: R-361`), then this.

You own exactly these files and no others:

- `supabase/migrations/20260908000070_a_resize_asks_the_same_questions.sql` (new — this exact name)
- `supabase/tests/88_absences_test.sql` (add cases only; never reword or renumber an existing one)
- `src/features/board/hooks/useDragGesture.ts`
- `src/lib/api/mutations.ts`
- `src/test/dragGesture.test.ts` (add cases only)
- `src/test/defects/` — **nothing here.** Listed so there is no doubt.

Do not touch the four scheduler RPCs, `src/lib/absence.ts`, or `src/features/board/lib/leave.ts` —
they are correct and you are reusing them. Do not commit. Do not edit `docs/plan.yaml` or
`docs/defects/*.md`. **Never run `npm run db:reset`** — the maintainer is using the app. You are the
only lane running, so the SQL scratch database and the browser are yours.

**Read first, in full:** `CLAUDE.md` §4 — every line, and especially *"a screen that shows what the
server will refuse is worse than one that refuses what the server allows"*, *"a write that reports
success can have changed nothing"*, and *"extract, never retype"*. Then `docs/plan.yaml`'s **R-361**,
**R-357** and **R-338**. Then `docs/api.md` §4 and its own warning that the authority for what a
plain PATCH may set is `AssignmentFieldEdit`, not the prose. Then migration `0066`'s §4, where the
four writers consult `absence_overlap` — that is the shape you are matching.

## What is true today, measured rather than remembered

Five things change an assignment's window. Four are RPCs that ask `check_eligibility` and
`absence_overlap` under the plant's resolved `eligibility_policy`. The fifth is
`updateAssignmentFields` — a plain `PATCH /assignments?id=eq...` that sets `timerange` — and it asks
neither. It is what a drag on the block's **edge** does, and what a nudge to a new time in the same
cell does.

It is not unguarded: `assignments_capacity`, `assignments_run_consistency`, `assignments_scope_guard`
and the audit trigger all fire on that UPDATE. Not one of them looks at the person.

**A run resize is NOT in scope, and this was checked, not assumed.** `runs_crew_follows` and
`assignments_run_consistency` both guard `node_id` alone, so changing a run's `timerange` does not
move its crew in time. Confirm that yourself with `pg_get_functiondef` before you write anything —
if you find otherwise, stop and report it, because it changes the size of this job.

## The decisions already made — do not re-litigate them

1. **The check goes in a `BEFORE UPDATE` trigger on `assignments`, not in a fifth copy of the rule.**
   It fires when `timerange` IS DISTINCT FROM the old one, or when `operator_id` changes. That
   catches the client's PATCH, a raw PostgREST call, and anything added later, and it cannot drift
   from the four because it calls the same two functions they call.
2. **Under `block` it refuses**, with the same error codes and the same DETAIL shape the four raise
   (`absent`, `not_eligible`). A client that already knows how to read those refusals keeps working.
3. **Under `warn` the trigger stays completely silent** and the CLIENT owns the sentence. A trigger
   cannot return a warning, and one that refused under `warn` would be worse than the gap it closes.
4. **The warn sentence is the one that already exists.** The client runs its own mirrors
   (`absenceGaps`, `certificateGaps`) around the resize and toasts the same wording the crew-drag
   toast uses, hours included for a part-day absence (R-359) and in the board's own zone. Do not
   invent new copy; find the existing sentence and reuse it.
5. **The resize still goes through under `warn`** — exactly as a warn-policy drag does today, with
   the override recorded in the toast. Same behaviour as the other four.

## What to build

**A. Migration 0070.** One migration, append-only. A new trigger function plus the trigger. It must
resolve the policy the same way the four do — read how `create_assignment` (last definition) gets
`v_elig->>'policy'` and use that, do not invent a second way to resolve a policy. `SECURITY DEFINER`
for the same reason the four are: the caller may not be able to read the person's home. Guard the
org boundary itself.

Two traps to avoid, both of which this project has already paid for:

- **Do not make an UPDATE that does not move the window pay for two function calls.** Gate on
  `NEW.timerange IS DISTINCT FROM OLD.timerange OR NEW.operator_id IS DISTINCT FROM OLD.operator_id`
  so an efficiency edit is byte-for-byte as fast as it is today.
- **The four writers themselves UPDATE assignments.** `move_run`, `reassign_assignment` and
  `copy_week_plan` all write rows this trigger will now fire on, and they have ALREADY asked the two
  questions under the correct policy. Work out exactly what happens when they do — a double refusal
  under `block`, or a double check that agrees — and say in your report which it is and why that is
  correct. **If a warn-policy override that the four deliberately allow would now be refused by your
  trigger, you have broken the app**; find that case before you write, and pin it.

**B. `mutations.ts` and `useDragGesture.ts`.** The resize path (`saveAssignmentFields` is NOT it —
find the path that sets `timerange`, around lines 838 and 1542) runs the client mirrors against the
window it is about to write, and on a hit under `warn` toasts the existing sentence naming the
person and the leave or the certificate. Under `block` the server refuses and the existing
`failWith` path shows it. Keep the mirrors and the server predicate agreeing — that is the standing
rule and it is what makes this safe.

## Proving it

Copy each runner's own summary line; never a number you reasoned to.

1. **Break it first.** Before the trigger exists, write the SQL case that resizes an assignment onto
   a day the person is on leave under `block` and assert it is refused. Watch it fail. Report what
   the database did before the fix, verbatim. That is the evidence the lane was needed.
2. **New cases in `88_absences_test.sql`**, next free ids, in the file's exact style: a resize onto
   an absence under `block` is refused with `absent`; the same resize under `warn` SUCCEEDS and the
   row really moved (read it back — a write that reports success can have changed nothing); a resize
   that does not overlap any absence succeeds under both policies; an efficiency-only UPDATE is
   untouched; and a `move_run` / `reassign_assignment` warn-policy override still succeeds.
3. **Mutation.** Strip your trigger's absence branch, rebuild the scratch database, and confirm a
   named case goes red. Restore it, confirm `git diff --exit-code` on the migration is clean, and
   report which case caught it.
4. **The whole SQL suite.** `bash scripts/run-sql-test.sh --rebuild`, then every file in order. The
   measured baseline on this tree is **763 passed, 0 failed** across the 51 numbered suites. Yours
   must be 763 plus your new cases, zero failed. If a pre-existing case goes red, read it before
   touching your fix and say whether the case was wrong or the contract changed.
5. `npm run db:types`, then `npx tsc --noEmit`. `tsc` is **inconclusive** until `db:types` has run
   after a migration — say "inconclusive", never "clean", if you skipped it.
6. `npx vitest run src/test/dragGesture.test.ts src/test/absence.test.ts src/test/absenceOnBoard.test.tsx`
   then the whole `npm run test`. Baseline is 2497 in 111 files.
7. **`npm run format:check` — this is not optional and it is new.** CI dies on it two steps before
   the tests, and a pre-commit hook now refuses unformatted staged files. Run it, and run
   `npx prettier --write` over anything you touched.
8. **Apply 0070 to the running stack** with `npx supabase migration up` (the migration table is
   current again after a reset, so this should now work — say so if it does not) and **drive it in a
   browser**: `npm run dev` on http://localhost:5173. Record an absence for a demo operator, then
   drag one of their assignments by its edge onto it, under `warn` and under `block`, and read what
   the screen says both times. Then
   `npx playwright test e2e/absenceOnBoard.spec.ts e2e/roleWalk.spec.ts --project=chromium`.

## Report

Plain prose, no bullet lists. Lead with what the database did before your trigger existed and what
it does now, both verbatim. Then: the exact trigger predicate; what happens when the four writers'
own UPDATEs hit your trigger and why that is correct; which case went red under mutation; every
runner's summary line; what you saw in the browser in your own words; and anything you noticed and
did not fix.
