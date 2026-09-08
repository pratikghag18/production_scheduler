# Lane brief: the hours must survive the payload, not only the pop-up (R-359)

You are a build lane finishing one hole the wave-four reviewer found and deliberately did not close,
because it lives in a file neither building lane owned. You own exactly these files and no others:

- `src/lib/api/shapes.ts`
- `src/features/board/hooks/useDragGesture.ts`
- `src/test/shapes.test.ts` (add cases only)
- `src/test/dragGesture.test.ts` (add cases only)
- `src/test/absenceOnBoard.test.tsx` (add cases only)

Nothing is committed; you are working on top of the wave-four working tree. No other lane is
running. Do not commit, do not edit `docs/plan.yaml` or `docs/defects/*.md`, do not run
`npm run db:reset`, and do not write a migration — the server side is already correct and finished.

Read first: `CLAUDE.md` §4, then `docs/plan.yaml`'s **R-359** row (grep `^- id: R-359`), then
`src/lib/absence.ts` and `src/features/board/lib/leave.ts` whole — they are the shape you are
matching, already built and green.

## What is wrong, exactly

Migration 0069 made an absence able to be part of a day, and `absence_overlap` now returns two extra
keys on a part-day hit — `starts_at` and `ends_at`, ISO instants. Those keys are forwarded whole by
`create_assignment` (under `absence`) and by `move_run` (inside each `absence_warnings` entry).

`parseAbsenceInfo` in `src/lib/api/shapes.ts` reads only `absent`, `from`, `to` and `reason`, and
drops the two new keys on the floor:

    const { from, to, reason } = v;
    if (!isStr(from) || !isStr(to) || !isStr(reason)) return none;
    return { absent: true, from, to, reason };

So every board surface fed by that shape renders a part-day absence as though it were a whole-day
one — the hours vanish silently. Two surfaces are affected today: the crew-drag toast after an
override (`useDragGesture.ts` around line 695) and the `absence` warning returned by a successful
warn-policy create (`CreateAssignmentResult.absence`). The pop-ups were fixed separately and are not
your problem; do not touch `CreatePopover.tsx` or `AssignmentPopover.tsx`.

`useDragGesture.ts` has a second, independent bug in the same block: its `leaveLine(...)` call passes
no zone, so even once the hours arrive they will be printed in UTC. The zone is already in scope as
`index.zone` — the same value the file uses at line 308 for `formatClock`.

## What to build

**`shapes.ts`.** `AbsenceInfo` gains the two optional fields, named to match what
`src/lib/absence.ts` already calls them on `AbsenceHit` — read that file and use the SAME names, so
the two shapes cannot drift. `parseAbsenceInfo` reads them when present and leaves them absent
otherwise. The existing four fields keep their exact current behaviour: a payload with no part-day
keys must parse byte-for-byte as it does today, and a malformed part-day key must not turn a valid
whole-day hit into `none` — an additive key is additive, and a shape guard that got stricter would
be a regression, not a fix.

**Then follow the type.** `AbsenceInfo` is shared. Grep every reader of it — `CreateAssignmentResult`,
`MoveRunResult`, `MoveRunAbsenceWarning`, and anything else the grep turns up — and confirm in
writing that each still behaves. The reviewer flagged this as cross-cutting; that is exactly why it
is worth doing carefully rather than quickly.

**`useDragGesture.ts`.** The toast's `leaveLine` call passes the part-day fields through and passes
`index.zone` as the third argument. Keep the existing `from !== null && to !== null` guard — a mirror
never throws.

## Proving it

Copy each runner's own summary line into your report; never a number you reasoned to.

1. **Break it first.** Before you fix anything, add the failing cases: a `move_run` payload carrying
   a part-day `absence_warnings` entry, and a `create_assignment` payload carrying a part-day
   `absence`, and assert the hours reach the sentence. Watch them fail. Report what the sentence
   said before your fix, verbatim — that is the evidence this lane was needed.
2. `npx vitest run src/test/shapes.test.ts src/test/dragGesture.test.ts src/test/absenceOnBoard.test.tsx src/test/absence.test.ts`
   — green, with a case pinning the zone (a part-day toast under a non-UTC `index.zone` must not
   read UTC) and a case pinning that a payload with no part-day keys parses exactly as before.
3. `npx tsc --noEmit` and `npx eslint` over the files you own.
4. `npm run test` — the whole suite. A clean measurement on this tree is
   `Test Files 1 failed | 109 passed (110)` / `Tests 1 failed | 2485 passed (2486)`, and the single
   failure is `src/test/defects/DEF-0020.test.ts` timing out at 5000ms on a live HTTP call; it
   passes alone. **Do not edit that pin** — it belongs to the tester. Your total must be 2486 plus
   your new cases, with that one known failure and nothing else.
5. `npx playwright test e2e/absenceOnBoard.spec.ts e2e/roleWalk.spec.ts --project=chromium`.
   `npm run dev` is expected on http://localhost:5173; start it in the background if it is not and
   say so.

## Report

Plain prose, no bullet lists. Lead with what the toast said BEFORE your fix and what it says after,
both verbatim. Then the field names you chose and why they match `absence.ts`; every reader of
`AbsenceInfo` you checked and what you concluded about each; every runner's summary line; and
anything you noticed and did not fix.
