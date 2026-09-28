# Review brief: S194-A, the screens lane -- one job: break it

You are a reviewer, not the author. Lane A changed the two absence screens, the New pop-up's zone,
`AssignmentPopover`, and the operator rail's heading, for DEF-0037, DEF-0038 and R-462. Its brief is
`docs/agent-briefs/s194-a-screens-brief.md`; read it, then `docs/defects/DEF-0037.md`,
`DEF-0038.md`, `DEF-0035.md`, then the diff:

`git diff -- src/features/admin/components src/features/board/BoardPage.tsx src/features/board/components src/test/absencesPanel.test.tsx src/test/operatorAbsences.test.tsx src/test/createPopover.test.tsx src/test/operatorPanel.test.tsx src/test/assignmentPopover.test.tsx src/test/absenceOnBoard.test.tsx`

The main session will re-run the pins; they were reported green. Green pins are where you START.

Another lane is still editing `scripts/voice/**`, `supabase/dev_demo.sql`, `supabase/tests/`,
`e2e/walk/**`, `e2e/typedWalk.spec.ts`, `e2e/touch.spec.ts`; a second reviewer is working in
`src/lib/command/resolve.ts`. Do not touch those. Do not commit. Do not run the full `npm run test`.
Do not run `npm run db:reset`. **Write nothing to the running database**: the maintainer is using
the app. Do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`. PowerShell runs npm and npx
(no `&&`). Never `git checkout -- <file>` (copy first, restore from the copy); never patch with
`Get-Content`/`Set-Content`.

## What you may write

New cases in the existing test files lane A touched. A small fix in a file lane A owned, when the
finding is clear and the fix is a few lines; anything larger you report. Say which you did.

## The main session's doubts -- test these first

1. **Nobody has looked at the screen.** Lane A had no browser. CLAUDE.md §4 requires the changed
   screens walked as the least-privileged person. Run
   `npx playwright test e2e/roleWalk.spec.ts --project=chromium` against the running dev server
   (http://localhost:5173; if it is not up, say so and do not start a second stack). Read the spec
   first and confirm it only reads; if it writes anything to the database, do NOT run it and say so.
   From its WALK lines copy the `chips=[...]` for Ana and for Marco: after the fix they must read the
   plant's own hours (Shift 1 06:00-14:00 in Chicago), not 11:00-19:00. Note that lane C is changing
   the seed file on disk but the running database still holds the old seed; that is expected.
2. **Remove, while the set is loading or has failed.** Lane A says Remove is hidden while
   `recordableQuery` is loading. What happens when the query ERRORS: does the screen show the
   absences with no Remove and say why, or does it show nothing, or does it show Remove? Write the
   case for each screen. What does a company admin see (the set should hold everyone): is there any
   person an admin can remove on the server but the set leaves out? Read
   `absence_recordable_people` and `remove_absence` from the LAST migration that defines each
   (`grep -in "function \(public\.\)\?<name>(" supabase/migrations/*.sql`, last hit) and compare the
   two predicates term by term. If they differ in any term, that is the finding that matters most.
3. **A person with no home.** `remove_absence` gates on `coalesce(home, site)`. A person whose home
   is NULL: is that person in the set for a supervisor of the site? Read, and if the SQL suite
   (`supabase/tests/88_absences_test.sql`) has no case for it, say so (do not write SQL tests; that
   directory is another lane's today).
4. **The zone prop made required.** Grep `src/` for every `<CreatePopover` and `<AssignmentPopover`
   and every `describeRefusal(` and confirm each passes the board's real zone, not a literal. A
   production call site passing the literal "UTC" to satisfy the compiler is a finding.
   `describeRefusal` now has a required parameter after an optional one: find its production
   callers and confirm none passes `undefined` for the date format by accident where it used to
   pass the plant's.
5. **The rail's new heading.** `Nobody on Shift 1`: check it against a search box or filter on the
   rail, if the rail has one. If typing a name that matches nobody empties the list, the heading must
   not claim the SHIFT is empty. Check the case where the person viewing has people on the shift she
   cannot see (a supervisor's rail shows her own line): "Nobody on Shift 1" is then a statement
   about her rail, not the plant; say whether the words mislead and propose the sentence. Do not
   change placement.
6. **R-447.** Lane A changed no CSS and argued the columns cannot shift. Check the argument for the
   Absences tab when NO row has a Remove (Ana's table holding only John Kim's absence): does the
   Actions column collapse and the header sit over nothing? Read the stylesheet and the markup.

## Then break it your own way

- Mutate each change on a copy-backed file and see a case go red BY NAME: drop `zone={zone}` at the
  mount; turn the Remove gate into `true`; turn it into a gate on loading only; swap the two rail
  sentences. A change no case notices is a finding.
- The two clock cases in `createPopover.test.tsx` (Chicago, Berlin): would they pass if the
  component ignored `zone` and the test's machine happened to be in that zone? Check how the test
  environment's own zone is set.
- Grep `e2e/` for "On shift now", "No one on shift", "Remove" on the absence screens and
  "edit rights on this cell": list every spec that asserts a string lane A changed.

## Run

`npx vitest run src/test/defects/DEF-0037.test.tsx src/test/defects/DEF-0037-panel.test.tsx src/test/defects/DEF-0038.test.ts src/test/absencesPanel.test.tsx src/test/operatorAbsences.test.tsx src/test/createPopover.test.tsx src/test/operatorPanel.test.tsx src/test/assignmentPopover.test.tsx src/test/absenceOnBoard.test.tsx src/test/dateSeam.test.ts src/test/scaleAudit.test.ts`

## Report

Plain prose. For each of the six doubts: confirmed or refuted, with the evidence (a case name and
the runner's line, the two predicates side by side, the WALK lines). Every finding: what a person
would see, the case that shows it, whether you fixed it. Every mutation and whether a case caught it
by name. The runner's total lines, copied. What you did not examine, and anything reported as not
run.
