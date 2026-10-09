# Lane brief: S196-A, the bar refuses BEFORE it speaks (DEF-0060, F-239, R-465, R-431)

You are a build lane on the developer's tree (branch `Development`, clean at the tester's merge
f0f4a4b). Nobody else is editing the repository. Read `CLAUDE.md` first (sections 4 and 7), then
`docs/defects/DEF-0060.md`, then in `docs/plan.yaml`: R-465, R-431, F-239 (grep `^- id: F-239`),
F-233 (its story: three attempts green on the unit suite and wrong in a browser), and session 195's
entry for what lanes D and E built yesterday (`docs/agent-briefs/s195-d-the-popups-answer-brief.md`
is the brief the pop-up reporter and `explainRefusal` came from).

## Read this first: how this work is to be done

This piece is about WHEN the bar says things. On 28 and 29 Sept three attempts at a piece of this
kind were green on the unit suite and wrong in a browser (F-233). So:

1. **Browser first.** Reproduce DEF-0060 as Ana on the tester's stack with a throwaway spec (both
   sentences of its Reproduction), and F-239 (a PATCH delayed by a few seconds through
   `page.route`, then "shorten Sam Patel by 30 minutes"), and copy the thread's bubbles and the
   trace entry as they are now.
2. **Then the unit cases**, red, for what you saw.
3. **Then the fix.**
4. **Then the browser again**, and permanent cases in `e2e/typedWalk.spec.ts`.

Do not report this piece as done on unit tests.

## The two defects, one cause

DEF-0060 (the tester, today, as Ana; Priya Shah is on Cell 4 of Line 2, which Ana cannot read):

```
[you]   put Priya Shah on Housing A at Cell 2 today from 10 am to noon
[board] Priya Shah is on Cell 2 Wed Sep 30 from 10 am to noon, making Housing A.
[board] Not done: Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.
trace: asked = the readout, ran = [], outcome = refused: ...
```

and on Cell 1, which has a job: "A Housing A job is already booked on Cell 1, 6 am to 2 pm. Join
it, or make a separate block?" with two buttons, and BOTH lead to the same refusal.

F-239 (the reviewer, yesterday, the PATCH delayed by five seconds): at 1.5 s the thread read "Sam
Patel's block on Cell 1 now ends 1:30 pm; it was 2 pm." while the database still held 2 pm, and the
trace had no entry yet.

The cause is one: `CommandBar.tsx` prints a step's done-form readout the moment the writer is
CALLED (grep `readoutStatus`, ~l.2723 `if (!handedToPopup) setStatus(readoutStatus)`), and the
capacity probe that knows about the outside block is only asked AFTER the server has refused
(`explainRefusal` in `useDragGesture.ts`). The join question is asked by the resolver before
anything has been checked against the server.

## The rule (the maintainer's standards, not open)

R-431: every button the bar offers and every readout it prints as done is decided by the check the
server runs -- certificates, the area rule, capacity, absence. R-465: the bar refuses before the
yes, never after it. R-459: one or two plain sentences. R-434: every turn traces.

## What to build

1. **A pre-check between resolving and speaking.** When a sentence resolves to a step that places a
   person over a span (a create, a move to other hours or another cell, a re-time, a lot step of
   those kinds) -- or to a QUESTION about such a placement (the join-or-separate question, the
   which-hours question, any question whose every answer leads to that same write) -- the bar asks
   `capacity_probe` (`probeCapacity` in `src/lib/api/board.ts`) for that person, those hours and
   that share BEFORE it prints the readout or the question. If the probe reports a block on a place
   the caller cannot read (`isBusyElsewhere`, `src/features/board/lib/busyElsewhere.ts`), the turn
   is "Not done: Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm." and NOTHING
   else: no readout, no join question, trace outcome refused, the same sentence builder lane D
   wrote. If the probe says the person does not fit on READABLE blocks only, keep today's
   behaviour (the split pop-up after the create, through the same path as now). If the probe
   itself fails (network), keep today's behaviour and say nothing new: the probe is a convenience,
   the server's write is the gate (`useDragGesture.ts` ~l.2461 says why).
   Find the ONE place to put this so every door into a write passes it: read how `runCommand` /
   `resolveLotStep` / `startLot` in `CommandBar.tsx` hand a resolved step to `useDragGesture.ts`'s
   writers, and where the resolver's questions are turned into status. The check must not be a
   second copy of `submitCreateDirect`'s probe: if the create path keeps its own probe for the
   split pop-up, say why both exist and make one call the other's helper.
2. **Nothing is printed as done before it is done (F-239).** While a writer is in flight the live
   line reads the bar's existing working status ("Working…"; grep for it), not the readout. When
   the writer answers written, the readout bubble and "Written: ..." appear as today; refused,
   "Not done: <reason>". The trace entry is posted when the sentence is heard (DEF-0049's shape,
   `postTrace` at the ask) with the readout as `asked` only once it is true -- decide with the code
   what `asked` should hold for a direct write and say so in the report; the trace's `ran` and
   `outcome` are already right and must stay so.
3. **A lot.** "Ready to do N things" lists readouts before any yes; a step whose person is busy on
   a place the caller cannot read must not be listed as a thing to do. Run the pre-check over the
   lot's steps before the listing; a step that fails it is dropped from the lot and named in the
   listing's own sentence ("Not doing Priya Shah on Cell 2 today from 10 am to noon: she is already
   on Cell 4 in Line 2 today from 6 am to 2 pm." -- one sentence per dropped step, then "Ready to
   do N things" for the rest, or the refusal alone when nothing is left). If the lot's listing is
   built synchronously today and the probe makes it asynchronous, that is the change; keep the
   working status up while the probes run, and probe the steps together, not one after another.
4. **The typed walk** (`e2e/typedWalk.spec.ts`, `e2e/walk/sentences*.ts`) asserts the bar's
   bubbles and the trace for many sentences. Read how it reads a turn (`runEntry`, `expectAnswered`,
   the `written` field) and keep it green; where an expectation pinned the old order (a readout
   before the server answered), say so in the file: the contract changed (R-431, F-239).

## Files you own

`src/features/board/components/CommandBar.tsx` and its CSS Module,
`src/features/board/hooks/useDragGesture.ts`, `src/features/board/lib/busyElsewhere.ts`,
`src/features/board/store/commandConversation.ts`, `src/lib/command/resolve.ts` ONLY to export or
add a field a question needs (say which), `src/lib/voice/trace.ts` if the entry's shape needs it,
and the tests: `src/test/commandBar.test.tsx`, `src/test/dragGesture.test.ts`,
`src/test/busyElsewhere.test.ts`, `src/test/commandConversation.test.ts`, the `s194*Review` files
if they pin the old order, `e2e/typedWalk.spec.ts`, `e2e/walk/*`, and throwaway specs under `e2e/`
that you delete before you report.

## Files you must not touch

`supabase/**`, `src/lib/database.types.ts`, `src/lib/api/shapes.ts`, `src/lib/api/board.ts`,
`src/features/board/components/OperatorPanel.tsx`, `src/features/board/lib/railWords.ts`,
`src/lib/command/grounded.ts`, `src/lib/command/parse.ts`, `src/features/admin/**`,
`src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, `playwright.config.ts`.
No migration.

## Rules

Do not commit. Never `npm run db:reset`. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never
patch a file with `Get-Content`/`Set-Content`; use your Edit tool. Never `git checkout -- <file>`
(copy first, restore from the copy). **The tester's stack is UP** with migration 0085 (the main
session started it and will stop it); do not run `tester-stack.mjs up`/`down`, start or stop any
container. Set the environment from `node scripts/tester-stack.mjs env` in the same PowerShell
command as each Playwright run and confirm `$env:VITE_SUPABASE_URL` is `http://127.0.0.1:54421`.
ONE Playwright process at a time, `--workers=1`, FOREGROUND. Put back whatever your browser runs
write (Priya's refused writes write nothing; Sam's shortened block must be restored). The voice
model is not served; `/v1/chat/completions` proxy errors are noise.
`npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`.

## Proving it

1. What you saw in the browser BEFORE the fix, both defects, as the thread's lines and the trace's.
2. Unit cases in `commandBar.test.tsx` (a scripted probe): the outside block refuses before any
   readout or question, for a create, a move, a re-time, the join question, the which-hours
   question; a readable-only overlap still reaches the split; a failing probe keeps today's words;
   the live line reads "Working…" until the writer answers, then Written; a refusal after a slow
   write reads Not done with no readout before it; the trace entry is posted at the ask and its
   `asked` holds what you decided; a lot with one step busy elsewhere lists the rest and names the
   dropped one; a lot where every step is busy elsewhere.
3. Mutations, copy-backed, each red BY NAME then restored: the pre-check removed (the readout
   returns before the refusal); the readout printed at call time again; the lot's pre-check
   removed; the join question asked before the probe.
4. In the browser, on the tester's stack: DEF-0060's two sentences as Ana (thread and trace copied);
   F-239's delayed PATCH (the thread at 1.5 s reads Working…, then Written); a permanent case for
   each in `e2e/typedWalk.spec.ts` (after the DEF-0054 cases, in the file's serial order); then
   `npx playwright test e2e/typedWalk.spec.ts --workers=1` twice and once with
   `$env:WALK_SET = "2"`; `e2e/roleWalk.spec.ts` once. Copy each result line and duration; a walk
   that takes minutes is holding sentences and is a failure even if it passes.
5. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`, `src/test/dragGesture.test.ts`,
   `src/test/busyElsewhere.test.ts`, `src/test/commandConversation.test.ts`, the `s194*Review`
   files, `src/test/commandLauncher.test.tsx` and `src/test/defects/`: copy the total lines.
   `npx tsc -b` (conclusive; no migration), `npx eslint` and `npx prettier --check` over your files.

## Report

Plain prose. What you saw in the browser first. Where the pre-check sits and why every door passes
it. What a person sees now for: the two DEF-0060 sentences, a slow write that succeeds, a slow
write that is refused, a lot with one busy step, a lot with all busy. What `asked` holds for a
direct write and why. Every case added or changed (and for a changed one, whether it was wrong or
the contract changed). The mutations' red lines. Every run's result line and duration, copied.
What you wrote to the stack's database and put back. What you did not do or could not prove. A
draft commit message in the repo's style: plain ASCII, the reasoning in prose, no bullet lists.
