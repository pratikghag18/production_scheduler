# Lane brief: S194-H, the bar never throws a sentence away (R-464, F-236)

You are a build lane. Nobody else is editing the repository. The tree is clean at 3175af7.

## Read this first: how this work is to be done

Three attempts at the piece before this one (F-233) were green on the unit suite and wrong in a
browser. It was fixed only when the failing walk was run with the bar's own state logged to the
browser console, which showed the cause in two lines. `docs/plan.yaml`, finding F-233, story and
fix: read both. Then work the same way:

1. **Browser first.** Before you change anything, reproduce F-236 in a real browser on the
   tester's stack with a small throwaway spec, and log what the bar does. Write down the order of
   events you SEE.
2. **Then the unit case**, red, for what you saw.
3. **Then the fix.**
4. **Then the browser again**, many runs, more than one timing.

A unit suite is not proof of anything that depends on when a render or a promise happens. Do not
report this piece as done on unit tests.

## The decision (the maintainer, 29 Sept) -- not open

R-464 in `docs/plan.yaml` (grep `^- id: R-464`): every sentence the bar hears runs to an outcome, in
the order it was heard. A second sentence entered while the first is still being read, or while
the first's save has not come back, waits for the first and then runs; it does not cancel it.
Escape, or a typed cancel, takes back every sentence that has not yet run, writes nothing, and
says Cancelled in the thread. No turn is ever left with a blank line. This replaces the rule the
bar was built with (S44-b: a second Enter aborts the reading in flight).

## What is true today

- `submitText` / `startReading` in `src/features/board/components/CommandBar.tsx`: a sentence is
  first READ (by the served model through `activeReader`, or by the rules when there is no model),
  then resolved and run by `runCommand`. `readingAbortRef.current?.abort()` fires when a second
  sentence is entered; the aborted reading has no catch; the first sentence never becomes a
  command and its turn is filed with no outcome. `src/test/s194fgReview.test.tsx`, the describe
  block "a second Enter aborts the first sentence's own reading -- proved, not fixed", holds it.
- F-233 (96b5a37) built a queue one level down, AFTER reading: `heldQueueRef`, `holdSentence`,
  `drainHeldQueue`, `dropHeldQueueAsCancelled`, `dropHeldQueue` (the bound), `writesStillSettling`,
  `checkCaughtUp`. A sentence whose reading has finished while a save is in flight waits there.
- With the model served, a reading takes 9 to 15 seconds. With no model it is immediate.

## What to build

**One queue, entered when a sentence is heard.** Not a second queue in front of the first.

1. A sentence entered while anything is ahead of it (a reading in flight, a save in flight, the
   board not caught up, or other sentences waiting) joins the queue AS TEXT, shows its bubble at
   once with the working status the bar already uses, and posts its trace entry at once (R-434,
   DEF-0049's shape: post at the ask, correct at the outcome).
2. The queue runs one sentence at a time, to its outcome: read, resolve, write, board caught up,
   then the next. F-233's hold becomes this queue's "board caught up" step; `heldQueueRef`'s items
   either become this queue's items at a later stage or the two merge. Say which and why.
3. **A standing question stops the queue** (F-162, unchanged): a sentence that ends on a question
   ("which block?", "Ready to do N things", a night shift question) waits for its answer. What a
   person types while a question stands is read by today's rule for that: an answer if it is one
   (yes, no, a candidate's label, a cancel word), otherwise a new sentence that supersedes the
   question as it does today. Find that rule in the code and keep it exactly; R-464 is about
   sentences in flight, not about questions standing. Sentences already WAITING in the queue
   behind a standing question stay waiting until it is answered or cancelled.
4. **Escape and a typed cancel** drop every sentence that has not started to write: the ones
   waiting, and the one being read (aborting a reading is right HERE, because the person asked).
   Each says Cancelled in the thread and closes its trace entry with outcome cancelled. A sentence
   whose save is already in flight is not cancelled by this (the write has been asked for); it runs
   to its outcome and says so.
5. **The bound.** F-233's five seconds is a bound on waiting for the BOARD to catch up with a save.
   It must not count time spent reading: with the model served, a second sentence would otherwise
   be refused every time. Find where the bound starts and make it start when a sentence begins
   waiting on the board, not when it is entered. A reading has its own timeout already
   (`READING_TIMEOUT` or whatever it is called); leave it.
6. **A spoken sentence** (the microphone) enters the same queue by the same door. Read how the mic
   hands its text in (`submitText` or beside it) and make sure a sentence spoken while another is
   in flight is queued, not dropped and not interleaved. Do not run the voice e2e (the model
   container is not running); cover it with unit cases and say it was not proved in a browser.
7. **The blank line.** After this, no turn in the thread can have no outcome. Grep for every place
   a trace entry is closed or superseded and check each leaves an outcome. The reviewer's case for
   F-236 changes from "documents the fault" to "asserts both sentences ran, in order"; say in the
   file that the contract changed (R-464).

## Also owed from F-233

8. **The unit case for the ordering.** Nothing in the unit suite fails if `checkCaughtUp` is
   removed from `barWriteSettled`; only the walk does. Write the case: the board hands down the
   `ctx` that holds the new row BEFORE the writer answers (the reporter path: the writer first
   answers `popup`, the refreshed `ctx` arrives, then the reporter says `written` with the id), and
   a sentence said in between runs once the writer has answered, without any further `ctx`. Red
   with `window.setTimeout(checkCaughtUp, 0)` removed, green with it.
9. **The throttled spec** in `e2e/typedWalk.spec.ts` ("F-233: a create held back ...") waits for the
   first sentence's written line before it says the second, to dodge F-236. With R-464 built that
   dodge goes: the spec enters the two sentences back to back, no wait between.

## Files you own

`src/features/board/components/CommandBar.tsx` and its CSS Module,
`src/features/board/store/commandConversation.ts`, `src/lib/voice/trace.ts` if the entry's shape
needs it, `src/test/commandBar.test.tsx`, `src/test/commandConversation.test.ts`,
`src/test/s194fgReview.test.tsx`, `src/test/commandLauncher.test.tsx`, `e2e/typedWalk.spec.ts`,
and throwaway specs under `e2e/` that you delete before you report.

## Rules

Do not commit. Never `npm run db:reset`. Write nothing to the maintainer's database
(`supabase_db_production_scheduler`). No migration. Do not edit `docs/defects/*.md`,
`docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`. PowerShell runs npm and npx (no `&&`). Never
`git checkout -- <file>` (copy first, restore from the copy). Never patch with
`Get-Content`/`Set-Content`.

**The tester's stack is UP** (the main session started it and will stop it when you report). Do not
run `node scripts/tester-stack.mjs up` or `down` and do not start or stop any container. If the
stack is gone when you need it, stop and report; do not report unproven work as proven.

**Memory is short on this machine** (about 1.5 GB available). ONE Playwright process at a time,
`--workers=1`, in the FOREGROUND (a background run is stopped by the harness when memory is low).
`npx vitest run --maxWorkers=2` for the unit suite. Playwright only against the tester's stack; set
the environment from `node scripts/tester-stack.mjs env` and confirm before every run that
`$env:VITE_SUPABASE_URL` is `http://127.0.0.1:54421`. Specs you may run: `e2e/typedWalk.spec.ts`,
`e2e/touch.spec.ts`, `e2e/roleWalk.spec.ts`, and your throwaway ones.

## Proving it

1. What you saw in the browser before the fix, as log lines.
2. Unit cases: two sentences back to back with a reader that resolves late, both run in order;
   three; a sentence entered while a save is in flight and another while that one is being read;
   Escape with one being read and two waiting; a question standing with sentences waiting behind
   it; the bound not counting reading time; a spoken sentence queued; item 8's ordering case.
3. Mutations, copy-backed, red by name: the queue at entry removed (the old abort back); the order
   reversed; Escape not aborting the reading; the bound started at entry; `checkCaughtUp` removed.
4. In the browser, on the tester's stack: the throttled spec with the two sentences back to back,
   `--repeat-each=10`, at 2000, 200 and 0 ms (`F233_THROTTLE_MS`): thirty of thirty. Both walk
   lists, each twice over the same database, about thirty seconds each (a walk that takes minutes
   is holding sentences and is a failure even if it passes; report each duration). The touch spec
   and the role walk once.
5. ONE full unit run. Before this lane: `Test Files 3 failed | 183 passed (186)`,
   `Tests 3 failed | 4705 passed (4708)`; the three reds are DEF-0040's pin, DEF-0043's headcount
   pin and DEF-0020's live pin. `npx tsc -b`, eslint, prettier over your files.

## Report

Plain prose. What you saw in the browser first. How the two queues became one. What a person
sees: two sentences entered quickly; three; Escape in the middle; a question standing with a
sentence waiting behind it; a spoken sentence during a save. Every case added or rewritten. The
mutations. Every run's result line and duration, copied. What you did not do or could not prove.
A draft commit message in the repo's style: plain ASCII, reasoning in prose, no bullets.
