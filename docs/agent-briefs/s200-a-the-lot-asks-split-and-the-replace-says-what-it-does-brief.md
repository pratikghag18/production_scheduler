# Lane brief: S200-A, the lot asks split-or-skip, and the replace says exactly what its press does (DEF-0063, DEF-0064, R-468, R-469)

You are a build lane on the developer's tree (branch `Development`, clean at the tester's merge
9ebca19 plus one uncommitted edit to `docs/plan.yaml`, which you do not touch). Nobody else is
editing the repository. Read `CLAUDE.md` first (sections 4 and 7), then `docs/defects/DEF-0063.md`
and `docs/defects/DEF-0064.md`, then in `docs/plan.yaml`: R-468 (its note carries the maintainer's
WHERE AND HOW, chosen today), R-469 (new today), R-466, R-467, R-465, R-431, R-459, R-447, and session
198's entry. Then `docs/agent-briefs/s198-a-a-lot-step-that-cannot-go-asks-brief.md` and
`docs/agent-briefs/s198-a-review-brief.md` -- yesterday's piece, which this one extends; its report
and review are summarised in session 198's summary. Do not redo what it built.

## Read this first: how this work is to be done

Three attempts at a piece of this kind were green on the unit suite and wrong in a browser (F-233).
So: browser first (reproduce both defects as Ana on the tester's stack with a throwaway spec and copy
the thread's bubbles and the trace), then red unit cases, then the fix, then the browser again with
permanent cases in `e2e/typedWalk.spec.ts`. Do not report this piece as done on unit tests.

## The two defects

**DEF-0064 (R-468).** "put Sam Patel and Lena Novak on Housing A at Cell 2 today from 8 am to 10 am"
with Sam already on Cell 1 6 am to 2 pm (a block Ana CAN read). The lot lists "Ready to do 2 things"
and the server refuses Sam after the yes (200% of 100%). A single sentence for Sam alone is held back
before any write: `submitCreateDirect` (useDragGesture.ts ~l.2729) probes `capacity_probe`, finds
`!fits` with readable overlaps, and opens the board's Split coverage pop-up ("Sam Patel is already
booked then. The board is asking how to split the time. Answer it on the board."). Session 196's
lot pre-check (`refuseBusyLotSteps`, CommandBar.tsx) only refuses a person busy on a place the caller
CANNOT read (`isBusyElsewhere`); a readable overlap falls through to the writer.

**DEF-0063 (R-469).** "replace Sam Patel with Priya Shah on Cell 1" with Sam on TWO blocks that day
(6 am to 2 pm, 6 pm to 8 pm) and Priya busy on Line 2 only 6 am to 2 pm. Session 198's replace
question is built from the one refused block ("... Take Sam Patel off Cell 1 anyway? Nobody would be
covering Sam Patel's hours on Cell 1.") and the press runs every KEPT step -- both removals AND
Priya's placement on the 6 pm block -- so it writes something the question never said.

## The rules (decided by the maintainer, not open)

**R-468, where and how (today):** the lot step whose person is already booked on a readable block
asks IN THE BAR, numbered as the lot's step, with two buttons of one width:

    1 of 2: Sam Patel is already on Cell 1 today from 6 am to 2 pm. Split his time evenly between
    Cell 1 and Cell 2, or skip him?
    [ Split evenly ]  [ Skip Sam Patel ]

- Split evenly: the step is kept with the split; the listing reads "1. Sam Patel is on Cell 2 today
  from 8 am to 10 am, making Housing A, his time split evenly with Cell 1." and the one yes writes that
  step through the same server call the pop-up's Confirm uses (`applySplitCoverage`,
  `src/lib/api/mutations.ts` ~l.336: adjustments for the existing blocks + the new assignment), with
  the shares `splitEvenly(n, cap)` gives (`src/features/board/lib/interaction.ts` ~l.299 -- the same
  function the pop-up's button uses, never a second arithmetic).
- Skip Sam Patel: the step is dropped and NAMED in the listing's own words, the shape
  `refuseBusyLotSteps` already uses: "Not doing Sam Patel on Cell 2 today 8 am to 10 am: he is already
  on Cell 1 today from 6 am to 2 pm." then "Ready to do 1 thing: ..." -- or the refusal alone if nothing
  is left.
- A cancel word drops the whole lot. Nothing is written before the yes. No pop-up is opened by a lot.
  Uneven splits stay on the board's pop-up, as today. A person busy on a place the caller cannot read
  keeps R-465's up-front refusal (no question).
- The overlap sentence ("Sam Patel is already on Cell 1 today from 6 am to 2 pm.") is built from the
  probe's own `overlapping` rows through the SAME builder `isBusyElsewhere`'s sentence uses
  (`src/features/board/lib/busyElsewhere.ts` -- read it; it already renders a block's place and hours
  in the plant's zone). Several overlapping blocks: name them all, "and"-joined, as that builder does.
  Several cells: "Split his time evenly between Cell 1, Cell 3 and Cell 2" (the new one last).

**R-469, how it reads (today):** the replace question is built from the steps its press will run.

- One block of Sam's (as today, unchanged): "Priya Shah is already on Cell 4 in Line 2 today from 6 am
  to 2 pm. Take Sam Patel off Cell 1 anyway? Nobody would be covering Sam Patel's hours on Cell 1."
  [ Take Sam Patel off anyway ] [ Leave it ].
- Several blocks, Priya can take some: "Priya Shah is already on Cell 4 in Line 2 today from 6 am to
  2 pm, so she cannot take Sam Patel's 6 am to 2 pm block on Cell 1. Take Sam Patel off Cell 1 for
  both blocks and put Priya Shah on the 6 pm to 8 pm one? Nobody would be covering 6 am to 2 pm."
  [ Take Sam Patel off, place Priya Shah where she can ] [ Leave it ]. "both" for two, "all three" and so
  on for more (`thingsCount`-style words already exist in the bar; find them). The press runs exactly
  the steps the sentence names.
- Several blocks, Priya can take none: the one-block form with the blocks named ("... Take Sam Patel
  off Cell 1 for both blocks anyway? Nobody would be covering Sam Patel's hours on Cell 1.").
- Different cells (the sentence named no cell and Sam's blocks are on two cells): name each block's cell.
- The sync door (`replace_blocked` from `expandReplace`, a certificate or area gap) today refuses the
  WHOLE replace at expansion when ANY block's placement fails the gate. Keep that for now unless the
  change is small; say in the report what the sync door does with two blocks where only one fails the
  gate, and whether it should get R-469's wording too (it should, eventually -- say what it would take).

## What to build

1. **The probe answers more than busy-elsewhere.** `precheckCommandStep` (useDragGesture.ts ~l.989)
   answers `Promise<string | null>`. Widen it to a small result the bar can act on:
   `{ kind: "ok" } | { kind: "busy_elsewhere"; sentence: string } | { kind: "overlap"; sentence: string;
   blocks: Array<{ assignmentId: string; nodeId: string; nodeName: string; ... }>; cap: number }` (name
   and shape yours; the fields are what the split call and the sentence need). `busyElsewhereBeforeWrite`
   in busyElsewhere.ts stays the one gate for the outside case; add the readable-overlap answer beside
   it, from the same probe result, never a second probe. Every caller of `precheck` in CommandBar.tsx
   (`refusalBeforeAsking`, `refuseBusyLotSteps`) is updated; a single sentence's behaviour is UNCHANGED
   (it still goes to the writer and the board's pop-up for a readable overlap -- CB-pre-7 pins this).
2. **The lot asks before the listing.** R-468 says the question is asked as the lot's numbered step,
   not at the end. Decide, with the code, where the probe runs for a lot step: at the end in
   `refuseBusyLotSteps` (then the question for step k is asked after every step has resolved, numbered
   "k of N") or per step inside `resolveLotStep` (async stepping). Either is acceptable if the question
   is numbered, comes before the listing, and the busy-elsewhere refusal still happens up front; say
   which you chose and why. The answer is a `CandidateAction` (data, never a closure; add one kind, say
   `answer_lot_overlap` with `step` index and `answer: "split" | "skip"`), and the lot's state for the
   step lives on `Lot` (yesterday's `stepOptions` is the pattern). The buttons are the `yesNo` pair
   (one width, R-447) if a typed "yes"/"no" should press them -- decide whether "no" here means skip or
   cancel and say so (R-435: when in doubt the safer reading is cancel; the brief's recommendation is
   that typed yes/no do NOT press these two, since neither label is yes or no -- plain buttons).
3. **The split step.** A kept step with "split evenly" carries what the writer needs (`ResolvedCommand`
   gains an optional `split?: { adjustments: Array<{ assignmentId; efficiencyPercent }>;
   efficiencyPercent: number }` or a sibling field; say). `runLot` (useDragGesture.ts) writes such a step
   through `applySplitCoverage` (the existing `useApplySplitCoverage` mutation or the api function
   directly -- read how `confirmSplitAction` ~l.2900 does it and call the SAME thing, one path) instead
   of `createFromCommand`. The step's readout gains ", his time split evenly with Cell 1" (her/their by
   the person's pronoun field if the board has one -- grep `pronoun`; if not, use the person's name:
   "Sam Patel's time split evenly with Cell 1"). `buildLotOutcome`/`spokenStep` read it too so the trace
   and "Done:" say the same.
4. **The replace question from its steps.** In the replace branch of `refuseBusyLotSteps` (CommandBar.tsx
   ~l.3370), build the sentence and the button from `kept` and the refused steps per R-469 above; the
   press runs `kept` exactly as it does today (that part was right -- the words were wrong). A pure
   function `describeReplaceBlocked(...)` already exists; grow it to take the removals, the refused
   placements and the allowed placements, and unit-test it directly for the one-block, two-block-one-busy,
   two-block-both-busy and two-cells shapes.
5. **The sweep** (CLAUDE.md section 7, duty 2): grep CommandBar.tsx and useDragGesture.ts for every other
   sentence built from ONE step while a press runs SEVERAL (`kept`, `lot.done`, `runLotNow`): say for each
   that it names what it runs, or fix it if small.

## Files you own

`src/features/board/components/CommandBar.tsx` and its CSS Module, `src/features/board/hooks/
useDragGesture.ts` (the precheck, `runLot`, the split call), `src/features/board/lib/busyElsewhere.ts`,
`src/features/board/store/commandConversation.ts`, `src/lib/command/resolve.ts` (a field on
`ResolvedCommand`, the readout words), `src/lib/command/readout.ts` if the words live there, and the
tests: `src/test/commandBar.test.tsx`, `src/test/commandResolve.test.ts`, `src/test/busyElsewhere.test.ts`,
`src/test/dragGesture.test.ts`, `src/test/commandConversation.test.ts`, `e2e/typedWalk.spec.ts`,
`e2e/walk/*`, throwaway specs under `e2e/` that you delete before you report.

## Files you must not touch

`supabase/**` (no migration -- `apply_split_coverage` exists), `src/lib/database.types.ts`,
`src/lib/api/**`, `src/features/board/components/SplitCoveragePopover.tsx`, `src/features/board/
BoardPage.tsx`, `src/lib/command/grounded.ts`, `src/lib/command/parse.ts`, `src/features/admin/**`,
`src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, `playwright.config.ts`.

## Existing cases that may go red

Read each before touching the fix; say per case whether it was WRONG or the CONTRACT CHANGED (the rule):
CB-pre-1 to CB-pre-12 (the precheck's answer type widens -- their scripted probe `busy`/`free` returns a
string or null; adapt the fixture, not the assertions; CB-pre-7's "readable-only overlap still reaches
the writer" for a SINGLE must stay true); CB-rep-1 to 7 (the one-block wording is unchanged, so they
should stay green; CB-rep-2's press still runs the kept steps); CB-lot-ask-1 to 10 (unchanged);
`busyElsewhere.test.ts` (BE-*, PC-*) if the gate's signature changes.

## Rules

Do not commit. Never `npm run db:reset`. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never patch a
file with `Get-Content`/`Set-Content`; use your Edit tool. Never `git checkout -- <file>` (copy first,
restore from the copy). **The tester's stack is UP** (the main session started it and will stop it);
do not run `tester-stack.mjs up`/`down`, start or stop any container, and never point anything at
`http://127.0.0.1:54321` (the developer's own stack, the maintainer's app). Set the environment from
`node scripts/tester-stack.mjs env` in the same PowerShell command as each Playwright run and confirm
`$env:VITE_SUPABASE_URL` is `http://127.0.0.1:54421`. ONE Playwright process at a time, `--workers=1`,
FOREGROUND. Put back whatever your browser runs write (DEF-0063's second Sam block is YOURS to insert
and delete, as the defect's reproduction says; a split that writes changes Sam's Cell 1 efficiency --
restore it; remove Sam's and Lena's Cell 2 rows). The voice model is not served; `/v1/chat/completions`
proxy errors are noise. `npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`.
Ignore `tsc` errors in files you do not own.

## Proving it

1. What you saw in the browser BEFORE the fix, both defects, as the thread's lines and the trace's.
2. Unit cases: `CB-ovl-N` (DEF-0064): the numbered question with both buttons before any listing; Split
   evenly -> the listing's words and the yes calls the split writer with even shares and the new
   assignment, Lena's step unchanged beside it; Skip -> named as not doing, the rest listed, the yes
   writes Lena only; cancel drops the lot; busy-elsewhere still refuses up front with no question; a
   single sentence's readable overlap is unchanged (CB-pre-7); the trace at each point. `CB-rep-8..`
   (DEF-0063): two blocks one busy -> the sentence names both removals and the one placement, the button
   label, the press runs exactly those steps; two blocks both busy; two cells. `describeReplaceBlocked`
   directly for the four shapes. `dragGesture.test.ts`: `runLot` writes a split step through the split
   call with the even shares.
3. Mutations, copy-backed, each red BY NAME then restored: the overlap answer dropped from the precheck
   (the lot lists Sam again); the split step written through the plain create; the replace sentence
   built from the refused block alone again; the skip not named in the listing.
4. In the browser, as Ana, on the tester's stack: DEF-0064's sentence, both buttons, the rows read back
   (Sam's Cell 1 efficiency and the new Cell 2 row after Split evenly; nothing for Sam after Skip), then
   restored; DEF-0063's sentence with the second Sam block, the press, the rows read back, restored; a
   permanent case for each in `e2e/typedWalk.spec.ts` after the DEF-0062 case; then `npx playwright test
   e2e/typedWalk.spec.ts --workers=1` twice and once with `$env:WALK_SET = "2"`; `e2e/roleWalk.spec.ts`
   once. Copy each result line and duration.
5. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`, `src/test/commandResolve.test.ts`,
   `src/test/busyElsewhere.test.ts`, `src/test/dragGesture.test.ts`, `src/test/commandConversation.test.ts`,
   `src/test/commandLauncher.test.tsx` and `src/test/defects/`: copy the totals. `npx tsc -b`
   (conclusive; no migration), `npx eslint` and `npx prettier --check` over your files.

## Report

Plain prose. What you saw in the browser first. Where the lot's probe runs and why. What a person sees
now for DEF-0064 (both buttons, cancel) and DEF-0063 (one block, two blocks one busy, two blocks both
busy). What the sync door does with two blocks. The sweep's findings, one line each. Every case added or
changed (wrong, or contract changed, with the rule). The mutations' red lines. Every run's result line
and duration, copied. What you wrote to the stack's database and put back. What you did not do or could
not prove. A draft commit message in the repo's style: plain ASCII, the reasoning in prose, no bullet
lists.
