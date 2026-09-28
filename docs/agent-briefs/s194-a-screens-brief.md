# Lane brief: S194-A, the screens -- DEF-0037, DEF-0038, and the rail's empty shift (R-462)

You are a build lane. Two other lanes run at the same time: lane B owns `src/lib/command/resolve.ts`
and `src/test/commandResolve.test.ts`; lane C owns `scripts/voice/**`, `supabase/dev_demo.sql`,
`supabase/tests/dev_demo_test.sql`, `e2e/walk/**`, `e2e/typedWalk.spec.ts` and `e2e/touch.spec.ts`.
Do not touch their files. Ignore `tsc` errors in files you do not own. Do not run the full
`npm run test`. Do not run `npm run db:reset` (the maintainer is using the app). Do not commit.
Do not edit `docs/defects/*.md`, `docs/plan.yaml` or `CLAUDE.md`; the main session does that.

This machine: the shell for npm and npx is PowerShell (no `&&`; separate commands with `;`). Never
patch a file with `Get-Content`/`Set-Content` (it re-encodes UTF-8); use your edit tool or node.

## Read first, in this order

1. `CLAUDE.md` §4 (the lines on "a screen that shows what the server will refuse" and on walking as
   the least-privileged person) and §7 (R-426 the one clock, R-431, R-447, R-449).
2. `docs/defects/DEF-0037.md` and `docs/defects/DEF-0038.md`, in full.
3. `docs/defects/DEF-0035.md` -- the same shape on the Record button, fixed once and reopened. Your
   fix is its other half; read how the record half is gated so the remove half is gated the same way.
4. The three pins: `src/test/defects/DEF-0037.test.tsx`, `src/test/defects/DEF-0037-panel.test.tsx`,
   `src/test/defects/DEF-0038.test.ts`. Read what each asserts BEFORE writing code, so the code you
   write is the code it looks for.

## Files you own

- `src/features/admin/components/OperatorAbsences.tsx`
- `src/features/admin/components/AbsencesPanel.tsx`
- `src/features/board/BoardPage.tsx` (only the `<CreatePopover>` mount near l.1460 and whatever a
  required `zone` forces)
- `src/features/board/components/CreatePopover.tsx`
- `src/features/board/components/AssignmentPopover.tsx`, `src/features/board/lib/leave.ts`,
  `src/features/board/hooks/useSchedulerToast.ts` (the `BOARD_ZONE` defaults, see piece 2)
- `src/features/board/components/OperatorPanel.tsx` and its CSS Module (piece 3 only)
- the existing test files beside these (`operatorPanel.test.tsx`, `createPopover.test.tsx`, the
  absence screens' tests): add or adjust cases only
- the error wording for the absence refusal, wherever `describeSchedulerError` is called from the two
  absence screens (see piece 1). If the wording lives in a shared file, change only the call site's
  context, not the shared sentence other screens use, and say so in your report.

## Piece 1 -- DEF-0037: no Remove where the server refuses

What is wrong: both absence screens render a Remove button on every absence the caller can READ.
The server's `remove_absence` refuses anyone outside the set `absence_recordable_people()` returns.
Both screens already fetch that set (`recordableQuery` in both; `recordableIds` in the panel).

What to build: a row's Remove renders only when the absence's person is in the server's set. The
absence itself stays listed (she may read it). While the set is loading, offer no Remove (fail
closed; the record half does the same, check it). R-449: this is one rule in two files because the
screens are two files; do NOT add a third helper that re-derives the predicate, and do NOT use
`canEditNode` (CLAUDE.md §4 says why: it fails open on a node the caller cannot read).

The wording half: pressing Remove today can answer "You do not have edit rights on this cell." on a
page with no cell. `AbsenceForm.tsx`'s header describes the wording it replaced for the record half;
give a refused removal the same kind of sentence ("You cannot remove an absence for this person from
here.") so that if the server does refuse (a stale page), the words fit the screen.

R-447: the rows' buttons share one width; a row with no Remove must not shift its neighbours'
columns. Look at how the table lays out before and after.

## Piece 2 -- DEF-0038: the New pop-up reads the plant's clock

What is wrong: `BoardPage.tsx` mounts `<CreatePopover>` without `zone=`; its chips and time line fall
to `BOARD_ZONE = "UTC"`. Every other pop-up mounted there passes `zone={zone}`.

What to build:
1. Pass the zone at the mount.
2. Make `zone` REQUIRED on `CreatePopover`'s props, so `tsc` finds the next omission. Fix every
   test or caller that then fails to compile by passing a zone explicitly ("UTC" in a test that was
   written in UTC is correct and honest).
3. The same default sits in `AssignmentPopover.tsx` (l.83, l.180), `leave.ts` (l.32) and
   `useSchedulerToast.ts` (l.90, l.220). For each: find every caller, confirm it passes the zone
   today (the tester found every other MOUNT does), then make the parameter required. If making one
   required would fan out past about ten call sites or into a file another lane owns, leave that one
   optional, and name it in your report with the count. Do NOT change `src/features/board/lib/time.ts`
   itself: its defaults are load-bearing for the UTC-written tests and that file's header says so.
4. One behavioural case in `createPopover.test.tsx`: mounted with `America/Chicago`, Shift 1 at
   06:00 reads "06:00" on its chip (in whatever form the chip prints), and a block starting 22:00
   Chicago on a Monday is labelled Monday. Add the east-of-UTC twin (`Europe/Berlin`), per R-426's
   note that a clock bug needs a pin in both directions.

## Piece 3 -- R-462: a shift with nobody on it says so

The maintainer decided on 28 Sept: when a shift covers the plant's clock now and nobody is homed on
it, the rail says "Nobody on Shift 1" (the shift's own name) instead of an empty list under "On
shift now: Shift 1". `OperatorPanel.tsx` l.317 already says "No one on shift now" when NO band covers
now; the new sentence goes in the same slot, the same element, the same style. That placement is
decided; do not invent another. When the person toggles other shifts on and the combined list is
still empty, name the shifts showing ("Nobody on Shift 1 or Shift 2"). Add cases to
`operatorPanel.test.tsx` beside SC-1 to SC-10: a band covers now with nobody homed on it; the existing
no-band sentence unchanged.

## Proving it

1. The pins, each green by name:
   `npx vitest run src/test/defects/DEF-0037.test.tsx src/test/defects/DEF-0037-panel.test.tsx src/test/defects/DEF-0038.test.ts`
2. The suites beside the code: `npx vitest run src/test/operatorPanel.test.tsx src/test/createPopover.test.tsx`
   plus every test file that names `AbsencesPanel`, `OperatorAbsences`, `AssignmentPopover`,
   `leaveLine` or `useSchedulerToast` (grep `src/test` for them). If an existing case goes red, READ
   it before touching your fix and say in the report whether the case was wrong or the contract changed.
3. `src/test/dateSeam.test.ts` and `src/test/scaleAudit.test.ts` stay green (you touch a CSS Module:
   lengths go through `calc(px * var(--ui-scale))` as the audit demands).
4. `npx tsc -b` over your files: no error in a file you own.
5. The screen, as Ana (`ana@example.test` / `devpassword`), on the running app at
   http://localhost:5173 if it is up: the New pop-up's chips against the axis; the Absences tab. Read
   only; record no absence on the maintainer's database. If you cannot drive a browser, say so plainly
   instead of claiming it.

## Report

Plain prose. Include: what each of the three pieces changed, file by file; the vitest total lines
COPIED from the runner; every existing case you changed and why; every `BOARD_ZONE` default you left
optional and why; anything you found that you did not fix. Include a draft commit message in the
repo's style: plain ASCII, reasoning in prose, no bullet lists.
