# Lane brief: S195-D, a sentence that ends in one of the board's pop-ups is finished by its answer, and a person busy on another line is refused in words (DEF-0054, R-465's bar and drag half)

You are a build lane on the developer's tree (branch `Development`). The tree holds the
UNCOMMITTED work of two lanes that finished this morning (S195-A, the bar's wording, and S195-B,
the clear-everyone guard); build on it, do not undo it. One other lane, S195-C, is working now in
`supabase/` only. Read `CLAUDE.md` first (sections 4 and 7), then `docs/defects/DEF-0054.md` and
`docs/defects/DEF-0053.md` from top to bottom, then R-465, R-434, R-431 and R-459 in
`docs/plan.yaml` (grep `^- id: R-465` and so on).

## Read this first: how this work is to be done

Item 1 depends on WHEN things happen (a pop-up opens, a promise settles, a page closes). On 28 and
29 Sept three attempts at a piece of this kind were green on the unit suite and wrong in a browser
(F-233 in `docs/plan.yaml`, story and fix: read both). So:

1. **Browser first.** Before you change anything, reproduce DEF-0054 in a real browser on the
   tester's stack with a small throwaway spec, as Ana, all three runs (close the page, Cancel,
   Continue), and write down what the thread and `data/voice/trace/bar.jsonl` hold after each.
2. **Then the unit cases**, red, for what you saw.
3. **Then the fix.**
4. **Then the browser again**, and a permanent case in `e2e/typedWalk.spec.ts`.

Do not report item 1 as done on unit tests.

## Item 1. DEF-0054: the pop-up's answer never reaches the bar

What the tester saw, as Ana, on a block that sits on a job:

```
SAY  extend Sam Patel by 30 minutes
Sam Patel's block on Cell 1 now ends 5:30 pm; it was 5 pm.
Waiting: a decision about the re-time (attachment or keep/scale)
POP-UP: Continue? This takes Sam Patel off the Housing A 15:00–17:00 run and makes them a standalone assignment.
```

After **Continue** the write happens and the thread and the trace do not say so. After **Cancel**
nothing is written and the thread still reads "now ends 5:30 pm". With the page closed while the
pop-up stands there is no trace entry at all.

Where it is: `src/features/board/hooks/useDragGesture.ts` ~l.1944 `retimeAssignmentFromCommand`
answers the bar `{ kind: "popup", waitingFor: "a decision about the re-time (attachment or
keep/scale)" }` (~l.1979) and then nobody hears `confirmYes` / `confirmNo`. The create pop-up
already has the mechanism this needs: a reporter (`report({ kind: "written", id })` / `refused` /
a cancel; read `CreatePopover.tsx` ~l.347 "Called EXACTLY ONCE", `commandResultRef` in
`useDragGesture.ts`, and how `CommandBar.tsx` settles a turn from it: grep `popup`, `settleWrite`,
`report`, `waitingFor` ~l.387 and ~l.2418). There are five `waitingFor` sites in
`useDragGesture.ts` (~l.1979, 2150, 2208, 2285, 2866) and one `"handed-off"` (the split-coverage
pop-up, ~l.2459).

What to build:

(a) **Every pop-up the bar can hand a sentence to reports its answer back, exactly once**: the
re-time's Continue? pop-up, the "crew outside the new window" pop-up (~l.2285), the split-coverage
pop-up, and the three create pop-up forms. Make a table of all six in your report: what opens it,
who reports today, who reports after your change. One reporter mechanism (the create pop-up's),
not a second one beside it.

(b) **Nothing is printed as done before it is done (R-431).** While a pop-up stands, the thread
shows ONE plain sentence that says what the board is asking, and not the done-form readout. Build
each from the board's own facts (R-459; no "re-time", "attachment", "keep/scale", "pop-up",
"standalone assignment", no 24-hour span). The sentences, as the main session chose them; if the
facts a site holds make one impossible, say so and propose the nearest:

- the re-time that takes a person off a job: `The board is asking whether to take Sam Patel off
  the Housing A job. Answer it on the board.`
- the re-time that asks keep or scale (read what that pop-up asks and say it the same way):
  `The board is asking what to do with the target for Sam Patel's block. Answer it on the board.`
- the crew outside a job's new hours: `The board is asking what to do with the people outside the
  job's new hours. Answer it on the board.`
- the create pop-up (all three forms): `The board has opened the details for this one. Finish it
  on the board.`
- split coverage: `Sam Patel is already booked then. The board is asking how to split the time.
  Answer it on the board.`

(c) **The answer settles the turn**, in the thread and in the trace (R-434):

- Continue / Create / Apply, and the server accepts: `Written: <the readout>` (the same readout
  builder the direct path uses), trace outcome written.
- the person cancels or closes the pop-up: `Cancelled. Nothing changed.`, trace outcome cancelled.
  Use the bar's existing Cancelled wording if it has one (grep `Cancelled`); one wording.
- the server refuses after Continue: `Not done: <reason>` through `rewriteRefusal`
  (`CommandBar.tsx` ~l.1094), the one rewriter.
- the page is closed while the pop-up stands: the trace entry was POSTED AT THE ASK with
  `answered: null` (DEF-0049's shape; read `postTrace` and `traceQuestionStatus` in
  `CommandBar.tsx` and do for a waiting status what they do for a question).

(d) **A lot.** Find out what the lot runner (`useDragGesture.ts` ~l.2842 to 2929) does today when
one step of "Do all N" needs a pop-up, and say so in the report. A lot must never hang on a pop-up
nobody is watching, and must never count a step as done that waits on one. If today's behaviour is
wrong, the least change that keeps R-432's three lines true is to treat such a step as not done
with a reason in words ("That one needs an answer on the board; say it on its own.") and carry on
to Not tried as for any refusal. Build that only if needed; report either way.

(e) **A second sentence while a pop-up stands.** Find today's rule (F-162: a standing question is
superseded by a new sentence) and make the waiting status follow the same rule as a standing
question. Do not invent a queue: R-464 is parked on another branch and is not this lane.

## Item 2. R-465 in the bar and on the board: busy on a line the caller cannot see

The decision (the maintainer, 30 Sept): the server counts every block of a person wherever it is;
when the block that makes the person busy is on a place the caller cannot read, the caller is told
**the place and the hours, never the product or the job**:

```
SAY  put Priya Shah on Cell 1 today from 10 am to noon
Not done: Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.
```

Lane S195-C is writing the migration. The shape you code against is already in
`src/lib/api/shapes.ts` (`CapacityProbeOverlap`, pre-seated by the main session, with cases in
`src/test/shapes.test.ts`): a row with `outside: true` carries `nodeName`, `parentName`,
`timerange`, `efficiency`, and null `assignmentId`, `nodeId`, `productName`. The tester's stack
does NOT have the migration yet, so this item is proved by unit cases with a scripted probe; the
main session proves it in a browser after the stack is rebuilt. Say so in the report.

What to build:

(a) **One sentence builder** in a new small module, `src/features/board/lib/busyElsewhere.ts`,
from a probe's outside rows: the person's name, then each outside block as `Cell 4 in Line 2 today
from 6 am to 2 pm`, several joined with "and". The day and the hours are in the PLANT'S zone
(R-426: through `partsInZone` and the helpers in `src/lib/format/dates.ts` and
`src/features/board/lib/time.ts`; `src/test/dateSeam.test.ts` audits new date sites, and a new file
in an audited directory may need adding to the audit's list: read the audit before you add the
file). The day word is the bar's own (today, tomorrow, "Mon Oct 5"): find how a readout's day is
rendered (`renderReadout`, `formatDayLabel`) and reuse it. The hours are the bar's spoken clock
(`spokenClock` / `formatSpan` in `src/lib/command/resolve.ts`; export what you need, do not write a
second clock formatter). `parentName` null: just `Cell 4`.

(b) **The create path** (`submitCreateDirect`, `useDragGesture.ts` ~l.2383): when the probe does
not fit and ANY overlapping row is outside, do not open the split-coverage pop-up (she cannot
change the other block, so the server would refuse the split: R-431) and do not send the write.
Refuse with the sentence: a toast on the board in the same words, and the bar's turn settles `Not
done: <sentence>`. `openSplitPopover` (~l.2348) maps every overlapping row to a participant with an
`assignmentId`; after the shape change it must only ever be reached with readable rows.

(c) **Every other write that can meet the cap**: a move, a re-time, a drag of an existing block,
the week copy, the lot runner's steps. Today a capacity refusal from the server reads "<name> would
reach 200% (cap 100%). Someone else changed their load — try the split again." and the bar
rewrites it to "<name> would be over the cap today (200% of 100%). Nothing changed."
(`CAP_REFUSAL`, `CommandBar.tsx` ~l.1070; `useSchedulerToast.ts` ~l.129; `describeSchedulerError`
in `src/lib/api/errors.ts`). Neither is true when the other block is one she cannot see. After a
`CapacityExceeded` refusal on any of these paths, ask `capacity_probe` for the same person and
hours (excluding the block being moved: `probeCapacity` takes the id; read `src/lib/api/board.ts`)
and, when an outside row is there, say the R-465 sentence instead, in the toast and in the bar.
When the probe itself fails, keep today's words. List every path you covered and every one you
did not.

(d) `SplitCoveragePopover`, `CopyWeekDialog.tsx` ~l.653 ("is already booked at this time") and any
other reader of `probe.overlapping` or of a capacity refusal: read each, and say in the report
whether it can now meet an outside row and what it shows.

## Item 3. The button on a lot of one

Lane S195-A made a lot of one read "Ready to do 1 thing: ... Say yes to do it, or no." but the
button still reads `Do all 1` (`CommandBar.tsx` `showLotStatus`, ~l.3012). It reads `Do it` for
one and `Do all N` otherwise. `e2e/typedWalk.spec.ts` clicks `/^Do all/` (~l.1866): make it match
both.

## Files you own

`src/features/board/hooks/useDragGesture.ts`, `src/features/board/hooks/useSchedulerToast.ts`,
`src/features/board/components/CommandBar.tsx` and its CSS Module,
`src/features/board/components/CreatePopover.tsx`, `SplitCoveragePopover.tsx`,
`CopyWeekDialog.tsx`, the confirm pop-up's component and `src/features/board/BoardPage.tsx` where
the pop-ups are mounted, `src/features/board/store/commandConversation.ts`,
`src/features/board/lib/busyElsewhere.ts` (new), `src/lib/api/errors.ts`, `src/lib/voice/trace.ts`
if the entry's shape needs it, `src/lib/command/resolve.ts` ONLY to export an existing helper, and
the tests: `src/test/commandBar.test.tsx`, `src/test/dragGesture.test.ts`,
`src/test/schedulerToast*.test.*`, a new `src/test/busyElsewhere.test.ts`, the audit lists if your
new file needs a line, `e2e/typedWalk.spec.ts`, `e2e/walk/*`, and throwaway specs under `e2e/` that
you delete before you report.

## Files you must not touch

`supabase/**` (lane S195-C), `src/lib/database.types.ts`, `src/lib/api/shapes.ts` and
`src/lib/api/board.ts` (pre-seated; if the shape is wrong for you, report it),
`src/features/board/components/OperatorPanel.tsx` and `src/features/board/lib/railWords.ts` (the
rail is the next lane's), `src/lib/command/grounded.ts`, `src/features/admin/**`,
`src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, `playwright.config.ts`.
No migration. Ignore `tsc` errors in files you do not own; report them.

## Rules

Do not commit. Never `npm run db:reset`. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never
patch a file with `Get-Content`/`Set-Content`; use your Edit tool. Never `git checkout -- <file>`
(copy first, restore from the copy).

**The tester's stack is UP** (the main session started it and will stop it). Do not run
`node scripts/tester-stack.mjs up` or `down`, do not start or stop any container, and do not touch
the databases `sql_test_db` / `sql_demo_db` in its container (lane S195-C is running the SQL suite
there). Set the environment from `node scripts/tester-stack.mjs env` (it prints the `$env:` lines)
in the same PowerShell command as each Playwright run, and confirm `$env:VITE_SUPABASE_URL` is
`http://127.0.0.1:54421` before every run. ONE Playwright process at a time, `--workers=1`, in the
FOREGROUND. Specs you may run: `e2e/typedWalk.spec.ts`, `e2e/roleWalk.spec.ts`,
`e2e/touch.spec.ts`, and your throwaway ones. Whatever your browser runs write to the stack's
database (Sam's block extended, a block created), put back: the next lane and the final proof use
the same seed. The voice model is not served; `[vite] http proxy error: /v1/chat/completions` lines
are noise.

Memory is short on this machine: `npx vitest run --maxWorkers=2 <files>`; do NOT run the full
`npm run test`.

## Proving it

1. What you saw in the browser BEFORE the fix, three runs, as the thread's lines and the trace's.
2. Unit cases in `commandBar.test.tsx` and `dragGesture.test.ts`: for each of the six pop-ups, the
   waiting sentence and no done-form readout while it stands; Continue settles Written with a trace
   outcome; Cancel settles "Cancelled. Nothing changed."; a refusal after Continue settles Not
   done; the trace entry is posted at the ask; a second sentence while it stands follows the
   question rule; the lot case of (d). For item 2: the sentence for one outside row, for two, with
   no parent, across midnight, in a zone west and east of UTC with the clock frozen (R-426's own
   rule for clock-dependent cases); the create path refuses and opens no split pop-up; a readable
   overlap still opens it; a capacity refusal on a move followed by a probe with an outside row
   says the sentence; the probe failing keeps today's words. For item 3: `Do it` / `Do all 3`.
3. Mutations, copy-backed, each red BY NAME then restored: the Continue? pop-up's report removed;
   the Cancel report removed; the done-form readout printed while waiting; the post-at-the-ask
   removed; the outside check removed from the create path (the split pop-up opens); the probe
   after a capacity refusal removed; `Do it` reverted.
4. In the browser, on the tester's stack, after the fix: DEF-0054's three runs again as Ana, the
   thread and the trace copied; a permanent case in `e2e/typedWalk.spec.ts` (after the F-233 case,
   in the file's serial order) for Cancel and Continue that reads the block back from the database
   and the trace entry from the file; then `npx playwright test e2e/typedWalk.spec.ts --workers=1`
   twice, and once with `$env:WALK_SET = "2"`, `e2e/roleWalk.spec.ts` once, `e2e/touch.spec.ts`
   once. Copy each result line and duration.
5. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`,
   `src/test/dragGesture.test.ts`, `src/test/commandResolve.test.ts`, the `s194*Review` files,
   `src/test/shapes.test.ts`, `src/test/dateSeam.test.ts`, `src/test/scaleAudit.test.ts`, your new
   file, and `src/test/defects/` : copy the total lines. `npx tsc -b`, `npx eslint` and
   `npx prettier --check` over your files.

## Report

Plain prose. What you saw in the browser first. The table of the six pop-ups. What a person sees
now for: Continue, Cancel, the page closed, a refusal after Continue, a second sentence while the
pop-up stands, a lot with a step that needs a pop-up. For item 2: the exact sentences from the
tests, every write path covered and not covered, what each other reader of the probe shows for an
outside row. Every case added or changed (and for a changed one, whether it was wrong or the
contract changed). The mutations' red lines. Every run's result line, copied. What you wrote to
the stack's database and put back. What you did not do or could not prove. A draft commit message
in the repo's style: plain ASCII, the reasoning in prose, no bullet lists.
