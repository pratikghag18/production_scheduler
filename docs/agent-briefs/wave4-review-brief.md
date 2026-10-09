# Review brief: wave four — break the templates lane and the absence lane before they are called done

You are the **reviewer**, not a builder. A different agent built each of these, and your one job is
to **break them**. A finding you can demonstrate is worth more than a page of approval. You may edit
code only to fix something you have first demonstrated is broken, and you must say, for every fix,
what you broke first and how.

Nothing here is committed. Do not commit. Do not edit `docs/plan.yaml` or `docs/defects/*.md`.
Do not run `npm run db:reset` — the maintainer is using the app. You are the only lane running, so
the SQL scratch database and the browser are yours.

## What was built

Two lanes, from `docs/agent-briefs/wave4-a-templates-discoverable-brief.md` and
`docs/agent-briefs/wave4-b-absence-by-the-hour-brief.md`. Read both briefs, then read the three
requirements they implement in `docs/plan.yaml`: **R-358**, **R-359**, **R-360** (grep `^- id: R-358`).
Then `git diff` and `git status` to see exactly what changed; everything is uncommitted working-tree
state on top of `f679d6e`.

Lane A (templates): `BoardToolbar.tsx`, `CopyWeekDialog.tsx`, `SaveTemplateDialog.tsx`,
`TemplatesPanel.tsx` + CSS, `copyWeekDialogTemplate.test.tsx`, `e2e/weekTemplates.spec.ts`.

Lane B (absence by the hour, and a person's absences on their record): a new migration
`supabase/migrations/20260907000069_absence_by_the_hour.sql`, `supabase/tests/88_absences_test.sql`,
`src/lib/absence.ts`, `src/lib/api/absences.ts`, `src/features/board/lib/leave.ts`,
`AbsencesPanel.tsx` + CSS, new `OperatorAbsences.tsx` + CSS, one insertion in `OperatorsPanel.tsx`,
`scaleAudit.ts` + `scaleAudit.test.ts`, and several test files.

## The eight things to try first

These are chosen because this repo has been bitten by each of them before; `CLAUDE.md` §4 is the
list and you should read it in full before you start.

1. **The dropped function signature.** Lane B DROPPED the old five-argument `set_absence` and
   replaced it with a seven-argument one. Prove nothing still calls the old shape: grep `src/`,
   `supabase/tests/`, `supabase/functions/` and `e2e/` for `set_absence`, and check the grants on
   the NEW signature are all three (revoke from public, grant to authenticated, revoke from anon) —
   a changed signature is a new function as far as `grant execute` is concerned. Then call it over
   PostgREST as a real signed-in person, not only from psql.
2. **The two new partial exclusion constraints.** Try to insert the overlap each one is supposed to
   forbid, and try to insert the one they are supposed to allow (a part-day row inside a whole-day
   absence). Then ask the harder question: can a person now hold a part-day absence that
   contradicts a whole-day one, and does `absence_overlap` pick a sensible first row when both
   match? Read the `ORDER BY` and try to make it non-deterministic.
3. **The client mirror must not disagree with the server.** `src/lib/absence.ts` is a transcription
   of `absence_overlap`. Find an input where they disagree — a window ending exactly at a boundary,
   an open-ended window, a part-day absence touching a shift at exactly its start or exactly its
   end, a zero-length window. For every disagreement you find, say which one is right.
4. **The timezone hole lane B declared and did not fix.** `leaveLine`'s `zone` parameter defaults to
   `BOARD_ZONE` ("UTC") and the four board callers — `CreatePopover.tsx`, `AssignmentPopover.tsx`,
   `useDragGesture.ts`, `OperatorPanel.tsx` — do not pass a zone, so a part-day leave line reads in
   UTC on a plant that is not in UTC. Confirm it, decide whether the board already knows a zone it
   could pass (the board payload carries `board_window.timezone`; read `BoardPage.tsx` line ~228),
   and **fix it if the fix is small and you can prove it** with a case that fails without it. If it
   is not small, say exactly what it would take.
5. **The recording path in a non-UTC plant.** Lane B converts wall-clock to instants on the client
   using the PERSON's plant zone. Set a plant's timezone to something with a real offset (and,
   better, one with DST), record a part-day absence, and check the stored instants and the board
   agree. Then move the clock across a DST boundary and try again. This is the part most likely to
   be wrong and least likely to be covered.
6. **A green case that pins the bug.** Lane A had to rewrite an existing case because it pinned the
   old behaviour. Read every test either lane CHANGED (not added) — `git diff` on
   `src/test/*.test.ts*` — and say for each whether the case was wrong or the contract changed.
   Lane B also edited `src/test/operatorsPanel.test.tsx`, which was outside its brief; check that
   edit changed no assertion.
7. **The least-privileged person.** Walk the changed screens as Ana (a line supervisor on Line 1)
   and as a viewer, not only as the admin who built them: the board toolbar's three buttons, the
   Absences tab, and a person's record in the Operators tab. A screen must never offer what the
   server refuses, nor hide what it allows. `e2e/roleWalk.spec.ts` is the standing instrument.
8. **A write that reports success can have changed nothing.** Record and remove an absence from the
   NEW place (the Operators tab) as someone who may not, and check the refusal is shown in words
   rather than swallowed, and that the row really did not change.

## Also verify, and report the numbers

- `npm run db:types` then `npx tsc --noEmit`; `npx eslint` over the changed files.
- The whole SQL suite: `bash scripts/run-sql-test.sh --rebuild`, then every file in order.
  A clean measurement on this tree is **760 passed, 0 failed** across the 51 numbered suites. Your
  total must be that plus anything you add, and zero failed.
- The whole unit suite: `npm run test`. A clean measurement on this tree is
  `Test Files 1 failed | 109 passed (110)` / `Tests 1 failed | 2485 passed (2486)`, and the single
  failure is `src/test/defects/DEF-0020.test.ts` timing out at 5000ms under full-suite load — it
  passes in about 300ms when run alone, because it makes a live HTTP call to the invite Edge
  Function. **Do not edit that pin**; it belongs to the tester. Confirm the flake is what I say it
  is and report whether you saw it too.
- `npx playwright test --project=chromium` over `e2e/weekTemplates.spec.ts`,
  `e2e/absences.spec.ts`, `e2e/absenceOnBoard.spec.ts` and `e2e/roleWalk.spec.ts`. `npm run dev` is
  expected on http://localhost:5173; start it in the background if it is not and say so.

Copy every runner's own summary line verbatim. Never a number you reasoned to.

## Report

Plain prose, no bullet lists. Lead with **what you broke** — each finding with the exact input and
the exact wrong output — then what you fixed and what you left. If you broke nothing, say so
plainly and list, specifically, the things you tried that did not work; "it looks correct" is not a
review. End with every runner's summary line.
