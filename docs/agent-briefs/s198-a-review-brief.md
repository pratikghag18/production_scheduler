# Review brief: S198-A (DEF-0061, DEF-0062, R-466, R-467) -- one job: break it

You are the reviewer of a lane's UNCOMMITTED work on the developer's tree (branch `Development`,
C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler). `git diff` shows the whole piece.
You did not write it; your one job is to find where it is wrong. Read `CLAUDE.md` sections 4 and 7,
then the lane's brief `docs/agent-briefs/s198-a-a-lot-step-that-cannot-go-asks-brief.md` (what it
was asked to build and the rules it was held to), then `docs/defects/DEF-0061.md` and
`docs/defects/DEF-0062.md`, then R-466 and R-467 in `docs/plan.yaml`. Then the diff, file by file.

## What the lane says it built (its own words, so check them)

- A several lot's step that meets the certificate or area question under warn asks it numbered
  ("1 of 2: ..."), takes the typed reason for that step only (`Lot.stepOptions`, keyed by step
  index), carries on, lists all steps with the reason beside its step, and one yes runs them with
  `override.reason` on that step alone. Under block the step is named "Not doing ...: <reason>" and
  the rest listed; nothing left, the refusal alone. "no" drops the lot; "yes" re-asks.
- A lot step on a day off the board used to re-run only that step after the board moved, dropping
  the rest (the REAL cause of DEF-0061's Lena-first order); it now re-runs the whole sentence via
  `Lot.source`.
- `runLot` in `src/features/board/hooks/useDragGesture.ts` never sent a step's `override` /
  `areaOverride` to the writer; it does now (the lane's one deviation from its file list; pinned
  by RL-0 in `dragGesture.test.ts`).
- A replace lot is `coupled` (`Expansion.coupled`, `Lot.coupled`). Busy incoming (async door,
  `refuseBusyLotSteps`) and uncertified/outside-area incoming (sync door: `expandReplace` returns a
  new `replace_blocked` question carrying the gate's question as `reason`, `outgoing`, `incoming`,
  `place`, `removals`) both reach ONE status: "<reason> Take Sam Patel off Cell 1 anyway? Nobody
  would be covering Sam Patel's hours on Cell 1." with two buttons of one width (the `yesNo`
  pair), "Take Sam Patel off anyway" (runs the kept steps NOW, no second question) and "Leave it"
  (cancelled, nothing written).
- A swap or copy with a step busy elsewhere is now refused WHOLE at the async door ("Not doing ...
  Nothing changed."). THE MAIN SESSION DISAGREES FOR COPY -- see "one correction" below.

## What to try to break

1. **The bar as the LEAST-privileged person.** Every new sentence the bar shows: is it a
   supervisor's sentence (R-459)? No ISO date, no arrow, no internal word, no "lot". Read each new
   string in `CommandBar.tsx` and `resolve.ts`'s `describeQuestion`.
2. **The per-step reason.** Two uncertified people in one lot: does each get its own question and
   its own reason, and does the second never inherit the first's? A reason typed for step 1 then
   "no" at step 2: nothing written? A cancel word mid-lot: `stepOptions` cleared with the lot? A
   NEW sentence typed while the question stands (CB-nc-6's rule): runs as a sentence and the old
   lot is dropped, not half-kept?
3. **The trace (R-434).** One entry per lot. After the whole flow, `asked`, `answered`, `ran`,
   `outcome` are truthful and nothing is posted twice. Read `postTrace`/`setAsked`/`settleTurn`
   and how the lane appends to `asked`/`answered`. A refused lot run after a reason: the outcome
   names the refused step by `attempted`, not its readout.
4. **`Lot.source` and the board move.** The whole sentence re-runs -- with the reasons already
   given? (R-455: the rerun after the board moves never asks again.) Or does it re-ask Lena's
   reason a second time? Try: day off board, Lena first, reason typed... actually the move happens
   BEFORE any reason (day_off_board is step 1's first question) -- confirm, and confirm a lot whose
   SECOND step is off-board re-runs from the start without losing step 1's answers, or say it
   cannot happen.
5. **The replace question.** Sam with TWO blocks in the window, Priya busy for only one: what do the
   buttons do, and does the sentence say so? (The lane admits the label does not.) Decide whether
   that is a defect to file or acceptable; write both readings. `place` when the sentence named no
   cell. A replace whose incoming is refused by BOTH a gate (sync) and the probe: which door wins,
   and is the question asked once? The sync door's "anyway" starts a lot from `removals` and runs
   it: if one removal resolves to a question (a stale board), what happens -- a numbered question,
   or a silent nothing? Pressing "Take ... off anyway" twice fast: one run (`runningLotRef`)?
6. **`yesNo` reuse.** The replace question reuses the night-shift `yesNo` pair (keys "clear" /
   "keep"). A typed "no" here means "Leave it" -- is that traced as the button's label? A typed
   "yes" runs the removal -- is that what a supervisor would expect from "yes" to "Take Sam off
   anyway?" (say whether it is right). Does any existing `yesNo` code path (the
   `answer_other_day_part` action) get confused by a candidate whose action is the new kind?
7. **`refusalBeforeAsking` and `refuseBusyLotSteps` ordering.** The reason question inside a lot is
   asked BEFORE the busy probe runs (the probe runs once at the end). So: Lena busy elsewhere AND
   uncertified -- the bar asks her reason, takes it, then refuses her at the listing. Is that a
   "refusal after the yes" (R-465/R-431 violation) or acceptable (the yes has not been given)?
   Write both readings and your call.
8. **The deviation in `useDragGesture.ts`.** Read `runLot`'s change against `createFromCommand`
   and `submitMove`: are `override`/`areaOverride` passed exactly as the single-sentence path
   passes them (same field names, same shape)? A move step with an override: does the server
   route (`submitMove`) accept it? Is anything ELSE in `runLot` still dropping a resolved field the
   single path sends (compare field by field)?
9. **CB-pre-11 / CB-pre-12 / CB-nc-5b** must be byte-for-byte unchanged in the diff. Confirm.
10. **`tsc` and the audits.** `npx tsc -b` clean. `npx vitest run --maxWorkers=2
    src/test/scaleAudit.test.ts src/test/dateSeam.test.ts src/test/commandBar.test.tsx
    src/test/commandResolve.test.ts src/test/dragGesture.test.ts src/test/commandConversation.test.ts
    src/test/commandLauncher.test.tsx src/test/defects/` -- copy the totals. Do NOT run the full
    `npm run test`.
11. **The e2e cases** in `e2e/typedWalk.spec.ts` (the two new `test(...)` blocks): read them. Do
    they assert the database (rows read back), the thread AND the trace, both buttons for the
    replace, both orders for the lot? Do they restore what they wrote? Is `toPass` used to paper
    over a real race (the lane wrapped trace reads in `toPass` after one flaky run -- judge whether
    that hides a bug in when the entry is posted).

## One correction you MAKE (the only edit you make)

A COPY is a lot of independent placements (each copied block stands alone), so a copy with a step
busy elsewhere keeps session 196's shape: the busy step is named "Not doing ...: <reason>" and the
rest are listed for one yes (R-465, as the tester verified for a several). Only a SWAP is refused
whole at the async door (no half of a swap is worth keeping). Change `refuseBusyLotSteps` (or
wherever the lane put the whole-refusal for coupled swap/copy) so `coupled.kind === "copy"` takes
the several path, and the resolver's sync-door gates for a copy stay as they are (NC7: a copy
refuses whole on a certificate gap before the lot -- R-425, unchanged). Add or adjust one
`commandBar.test.tsx` case that pins a copy with one busy step listing the rest (name it
`CB-rep-7`), and run the files in item 10 again. If the diff has no such branch for copy (the lane
misreported), say so and change nothing.

## Rules

Do not commit. Do not run the full `npm run test`. Never `npm run db:reset`, never start or stop
containers, never touch port 54321. PowerShell: no `&&`. Use the Edit tool for every file change,
never Get-Content/Set-Content. Never `git checkout -- <file>`. You may run Playwright against the
tester's stack (UP on 54421; env from `node scripts/tester-stack.mjs env` in the same command,
`--workers=1`, foreground, one process at a time) ONLY if a finding needs the browser to confirm;
say what you ran and put back anything written. Do not touch `docs/plan.yaml`, `CLAUDE.md`,
`docs/defects/**`, `src/test/defects/**`, `supabase/**`.

## Report

Plain prose. Findings first, worst first, each with the file and line, what a person would see go
wrong, and how you know (a case you ran, a read of the code, the browser). Then the items above you
checked and found sound, one line each. Then the copy correction: what you changed, the case, the
totals. Then every runner's total line, copied. Then your call: ship, or not, and what must change
first.
