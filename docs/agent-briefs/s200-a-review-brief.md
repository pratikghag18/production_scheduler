# Review brief: S200-A (DEF-0063, DEF-0064, R-468, R-469) -- one job: break it

You are the reviewer of a lane's UNCOMMITTED work on the developer's tree (branch `Development`,
C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler). `git diff` shows the whole piece. You did
not write it; your one job is to find where it is wrong. Read `CLAUDE.md` sections 4 and 7, the lane's
brief `docs/agent-briefs/s200-a-the-lot-asks-split-and-the-replace-says-what-it-does-brief.md`,
`docs/defects/DEF-0063.md`, `docs/defects/DEF-0064.md`, R-468 (its note holds the maintainer's chosen
wording) and R-469 in `docs/plan.yaml`. Then the diff, file by file. You make NO edits except where
item 9 says so.

## What the lane says it built (its words; check them)

- `precheckCommandStep` now answers `PrecheckResult`: ok / busy_elsewhere (sentence) / overlap
  (sentence, blocks, cap), from the one probe (`precheckBeforeWrite` in busyElsewhere.ts;
  `busyElsewhereBeforeWrite` is a wrapper). A single sentence ignores overlap (CB-pre-7 unchanged).
- The lot's probe stays at the end (`refuseBusyLotSteps`); an overlap step is asked "k of N: Sam Patel
  is already on Cell 1 today from 6 am to 2 pm. Split Sam Patel's time evenly between Cell 1 and Cell
  2, or skip Sam Patel?" with [Split evenly] [Skip Sam Patel] (one width via a new `Status.pair`).
  Typed yes/no do not press them ("Say which one."); a typed label does; a cancel drops the lot.
  Split: `ResolvedCommand.split` carries adjustments + shares from `splitEvenly(n+1, cap)`; `runLot`
  writes it through `applySplitCoverage.mutateAsync`; the readout gains ", Sam Patel's time split
  evenly with Cell 1". Skip: "Not doing ...: <overlap sentence>" and the rest listed.
- A replace and a swap never ask the overlap question; a copy does; a step whose overlapping block is
  removed or moved by another step of the same lot is exempt.
- The replace question is built from the steps the press runs (`describeReplaceBlocked`,
  `replaceBlockedLabel`, `Coupled.blocks`): one block unchanged; two blocks one busy -> "... so Sam
  Patel's 6 am to 2 pm block on Cell 1 cannot go to Priya Shah. Take Sam Patel off Cell 1 for both
  blocks and put Priya Shah on the 6 pm to 8 pm one? Nobody would be covering 6 am to 2 pm." with
  [Take Sam Patel off, place Priya Shah where possible]; both busy -> "... for both blocks anyway?";
  two cells named.
- Walk entries (e2e/walk/sentences.ts entry 17, sentences2.ts its match) moved to hours where Lena is
  free: the lane says the old hours double-booked her and the old "Ready to do 5 things" was a green
  case pinning DEF-0064.

## What to try to break

1. **The walk-entry change.** Read the old and new entries in `git diff e2e/walk/`. Confirm with the
   demo seed (`supabase/seed*` / `dev_demo`, or `e2e/walk/*` fixtures -- find where Lena's blocks on
   the walk day come from) that Lena really was booked at the old hours. If she was, the old
   expectation was wrong and the change is right; if she was not, the lane changed a correct case to
   fit its code. Say which, with the rows.
2. **Numbering and order.** A sentence with Lena's reason question (asked during stepping, "2 of 2")
   and Sam's overlap question (asked after, "1 of 2"): what does the thread read, in order? Is "1 of
   2" after "2 of 2" acceptable (R-459: a supervisor's sentences) or a defect to file? Both readings
   and your call. Also: after Split or Skip, is the trace `asked`/`answered` chain in order and nothing
   posted twice?
3. **The exemption** ("a step is not asked about if another step of the same lot removes or moves the
   overlapping block"): read it. A clear-then-place lot ("clear Cell 1 and put Sam on Cell 2"?) -- can a
   lot even hold both today? If the exemption can never fire, say so; if it can, is it right that the
   server will then accept the placement (the removal runs first in `done` order -- confirm the lot's
   write order guarantees it)?
4. **The split write.** `runLot`'s split branch: adjustments cover EVERY overlapping block the probe
   returned (not just one), the shares sum to the cap, the new assignment carries the step's
   override/areaOverride too (a person both uncertified and overlapping, reason given then split),
   and the result's id/readout feed `LotResult` like a plain create. A split refused by the server
   mid-lot: `buildLotOutcome` names it by `attempted`. What happens if the overlapping block changed
   between the probe and the yes (a stale efficiency)? Acceptable or not; say.
5. **A swap never asks, a replace never asks.** Why is that right for a replace? Priya coming onto
   Sam's block while Priya has a readable block at the same hours: the writer refuses after the press
   -- is that a refusal after the yes (R-465)? The lane's reason is the swap's own self-overlap. Does
   that reason hold for a replace? Both readings and your call.
6. **Wording (R-459).** Every new string: "Split Sam Patel's time evenly between Cell 1 and Cell 2, or
   skip Sam Patel?", "Take Sam Patel off, place Priya Shah where possible", ", Sam Patel's time split
   evenly with Cell 1", "cannot go to Priya Shah", "Say which one.". No ISO date, arrow, internal word.
   Is any of them not what a supervisor would say? Suggest the plainer form if so (do not edit).
7. **CB-pre-1..12, CB-rep-1..7, CB-lot-ask-1..10**: fixture-only changes, assertions untouched. Confirm
   from the diff.
8. **The least-privileged person.** `Status.pair` buttons and the overlap question as Ana: nothing
   offers a cell she cannot edit (R-431). The e2e cases: do they read rows back, restore everything,
   and assert thread AND trace? Do the new `page.reload()`s hide a stale-board bug (the lane added
   reloads after one "Separate block" failure -- is the board missing a refetch after a split write, so
   the next sentence resolves against stale rows, which F-233's hold should have covered)? Read how the
   bar's hold (`awaitingRowIdRef`, `writesStillSettling`) treats a split write: does `runLot`'s split
   branch return an id the hold can wait for? If not, that is a real finding.
9. **Runs.** `npx tsc -b`; `npx vitest run --maxWorkers=2 src/test/scaleAudit.test.ts
   src/test/dateSeam.test.ts src/test/commandBar.test.tsx src/test/commandResolve.test.ts
   src/test/busyElsewhere.test.ts src/test/dragGesture.test.ts src/test/commandConversation.test.ts
   src/test/commandLauncher.test.tsx src/test/commandPurity.test.ts src/test/defects/` -- copy the
   totals. Do NOT run the full `npm run test`. `npx eslint` and `npx prettier --check` over the changed
   files. If a lint or format problem is the only thing wrong in a file, fix that one thing and say so;
   nothing else.

## Rules

Do not commit. Never `npm run db:reset`, never start or stop containers, never touch port 54321.
PowerShell: no `&&`. You may run Playwright against the tester's stack (UP on 54421; env from `node
scripts/tester-stack.mjs env` in the same command, `--workers=1`, foreground, one process at a time) ONLY
when a finding needs the browser; say what you ran and put back anything written. Read-only psql
against the tester's container (`supabase_db_production_scheduler_tester`) is fine. Do not touch
`docs/plan.yaml`, `CLAUDE.md`, `docs/defects/**`, `src/test/defects/**`, `supabase/**`.

## Report

Plain prose. Findings first, worst first, each with the file and line, what a person would see go
wrong, and how you know. Then the items above you checked and found sound, one line each. Then every
runner's total line, copied. Then your call: ship, or not, and what must change first.
