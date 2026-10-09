# Lane brief: S195-B, the clear-everyone guard and two proofs that could not fail (DEF-0056, DEF-0044's new item, DEF-0057)

You are a build lane on the developer's tree at 992ffbc (branch `Development`). One other lane,
S195-A, is working at the same time on the bar's wording; its files are listed under "Files you
must not touch". Read `CLAUDE.md` first (sections 4 and 7), then these defect files from top to
bottom, tester's notes included: `docs/defects/DEF-0056.md`, `docs/defects/DEF-0041.md` (the
defect DEF-0056 continues), `docs/defects/DEF-0044.md` (the last paragraph, "ONE MORE"), and
`docs/defects/DEF-0057.md`.

## The standards this serves

- **R-431, nothing offered that the server refuses** and **R-435, when in doubt, ask**: a
  misheard sentence must never reach a "Do all" button that clears the whole board unless the
  person actually said to clear it. `grounded.ts`'s own header: "Refusing more is the safe side: a
  refusal only asks the person to say it again."
- **R-433, a walk is a spec first**: the typed walk is the proof, and a proof that is green only
  when run by itself is a proof somebody has to know how to run.
- DEF-0044's class: a limit that holds today but no test would notice going.

## What is already done and must not be redone

Session 194 (504a74b) replaced "any removal word anywhere" with a phrase test for the sweeping
reading: `hasRemovalPhrase` and `groundSweepingUnassign` in `src/lib/command/grounded.ts`
(~l.129 to 290: `SWEEP_PEOPLE`, `SWEEP_VERB_REACH`, `SWEEP_VERBS`, `SWEEP_BOARD_OBJECTS`,
`SWEEP_PARTICLE_VERBS`, `SWEEP_ORDER_PARTICLES`, `SWEEP_TAIL_WORDS`, `endsClause`). The tester
verified DEF-0041: its own sentences are refused, and so are "clear skies today", "everyone is
out to lunch", "who cleared everyone", "wipe the board clean", "everyone off the clock at five".
The narrow cases (an unassign that names a person or a place) keep the old any-word rule and are
NOT part of this lane. DEF-0037's fix gates Remove on the server's recordable set in both absence
screens and is verified.

## The work

### 1. DEF-0056: ten sentences that still ground a clear of the whole board

Pin: `src/test/defects/DEF-0056.test.ts`, ten cases red now. Do not edit it.

```
do not clear the board              I did not say clear the board      never clear the board
don't clear everyone                is everyone off today              should I clear the board
did we get everyone out             I will clear it with everyone
let me clear that with everybody tomorrow      I would like to take everyone out tonight
```

The rule to build (the main session's choice; the tester suggested it in DEF-0041's lead and
session 194 did not take it): **a sweeping clear is grounded only when the removal phrase is what
the clause SAYS, from its head.**

- The removal phrase must begin its clause. Before it, only an opener that leaves an order an
  order may stand: nothing, "please", "ok"/"okay", "now", "then", "and", "just", "go ahead and",
  "can you", "could you", "would you", "will you" (each optionally followed by "please"). Read the
  existing positive cases in `src/test/grounded.test.ts`, `src/test/defects/DEF-0041.test.ts`,
  `src/test/s194bReview.test.ts` and `src/test/voiceRead.test.ts` FIRST and write down every
  sentence that must still ground; if one of them starts with a word not on this list, add that
  word only if no sentence in the refuse list could then ground, and say so. If an existing
  positive cannot be kept without letting one of the ten through, stop and report the conflict;
  do not flip an existing case quietly.
- Anything else before the phrase in its clause refuses: a negation ("do not", "don't", "never",
  "did not say"), a question about it ("should I", "shall we", "is", "are", "did we", "do we",
  "who", "why"), a first-person preamble ("I will", "I would like to", "let me").
- Between the verb and its object only an article or a particle may sit ("clear OUT everyone",
  "clear ALL OF the board", "clear THE board"), never a pronoun or a preposition phrase ("clear
  IT WITH everyone", "clear THAT WITH everybody"). `SWEEP_VERB_REACH = 3` is what admits those
  today; replace the reach with an allowed-word test or keep the reach and test the words in it.
- The subject-first shape ("everyone off", "everybody out") must also begin its clause: "IS
  everyone off today" and "DID WE GET everyone out" are questions.

The refusal is the existing one (`{ ok: false, reason: "sweeping", intent }`); the bar's sentence
for it already exists (`CommandBar.tsx` ~l.3343, "Not done: nothing in ... says clear ... Say it
again.") and is NOT yours to change.

Keep the code a table plus one small function, the way the file is written now; match its comment
style and explain the head-of-clause rule once, where the constants are.

New cases go in `src/test/grounded.test.ts`: at least these still GROUND: "clear the board",
"clear everyone", "please clear the board", "could you clear everyone today", "ok clear the
board", "take everyone off", "everyone off", "clear everyone out", "clear everyone on Cell 2
today" (check how a named place is handled; that one may be the narrow case), and the same
sentence after an earlier clause that ends ("that is wrong. clear the board"). And these REFUSE,
beyond the pin's ten: "we should not clear the board", "nobody said clear everyone", "can I clear
the board", "when do we clear everyone", "I want to take everybody out for lunch", "clear it up
with everyone". If a sentence on either list seems wrong to you, report it rather than drop it.

### 2. DEF-0044, the new item: Remove offered while the permission answer is still loading

`src/features/admin/components/OperatorAbsences.tsx` ~l.140 computes `isRecordable` (null while
`recordableQuery` is loading) and ~l.212 renders Remove only when `isRecordable === true`; its
comment says a pending answer "offers no Remove ... fail closed". The tester changed `=== true`
to `!== false` and every suite stayed green (operatorAbsences, absencesPanel, absenceOnBoard,
s194deReview, the DEF-0037 pins).

Write the case in `src/test/operatorAbsences.test.tsx`: the recordable query held pending (a
promise that does not resolve), an absence listed, NO Remove button; then resolve it to a set
that contains the person and the button appears; resolve it to a set that does not and it stays
absent. Then the mutation (copy the file first, restore from the copy): `=== true` to
`!== false`, red BY NAME, restored green. Read `src/features/admin/components/AbsencesPanel.tsx`
for the same state (what does each row offer while `recordableIds` is loading, and on a failed
load?) and give it the same case in its own test file (`src/test/absencesPanel.test.tsx`, or
wherever the panel's cases live) with its own mutation. If either screen actually fails OPEN on a
pending or failed answer, that is a code fix, in your files, and you say so in the report.

### 3. DEF-0057: the typed walk is red under `npm run e2e`

`playwright.config.ts` sets `fullyParallel: true`; locally the workers are not capped.

(a) `e2e/typedWalk.spec.ts` ~l.1767: the F-233 case is a top-level test in the same file, so it
runs beside the walk (~l.618), types its own sentence on the walk's day, and writes to the same
`data/voice/trace/bar.jsonl` the walk's cross-check reads line by line (run 2's failure: "trace
line 1's heard, expected clear Cell 4 ..., received Assign Sam Patel ... from 5am to 6am"). Make
the file run in order: `test.describe.configure({ mode: "serial" })` at the top of the file
(read the Playwright docs on what that does at file level before you rely on it), so the F-233
case runs after the walk, never beside it. Then read HOW the walk's cross-check reads the trace
(grep `bar.jsonl` and the function that reads it): if it takes "every line since the walk
started", any other spec that types in the bar in another worker can still poison it
(`touch.spec.ts`, `roleWalk.spec.ts`, `absenceOnBoard.spec.ts` all use the bar or may). Make the
cross-check pick out the walk's own entries by something the entry carries (read the entry's
shape in `src/lib/voice/trace.ts`: a session or page id, the signed-in person, a start time) and
say what you chose. If the entry carries nothing usable, do NOT add a field (that file belongs to
the other lane's area); report it.

(b) Entry 6, the booking (~l.840 to 858), reads `runs` once, straight after the readout. Every
assignment check around it polls (`waitForAssignment` in `e2e/walk/db.ts`, whose own comment says
why a single read is a race). Add `waitForRun` beside it, the same polling shape, and use it
here; grep the spec for every other single read of `runs` or `assignments` that follows a write
and give each the same treatment, listing them.

(c) `weekTemplates.spec.ts:145` (afterAll timeout, five full runs of five) and
`copyWeek.spec.ts:68` (once): read both and say what you think is happening (a cleanup that does
a slow delete under six workers is the tester's guess). Propose the fix; make it only if it is
small and obviously right (a longer hook timeout with a reason is acceptable; a retry loop around
an assertion is not).

**You cannot run Playwright: the database stack is down and stays down.** Everything in item 3 is
written and type-checked by you and PROVED LATER by the main session on the tester's stack. Say so
in the report, and write down the exact commands the proof needs: the walk alone twice per list,
and `npm run e2e` three times.

## Files you own

`src/lib/command/grounded.ts`, `src/test/grounded.test.ts`,
`src/features/admin/components/OperatorAbsences.tsx`,
`src/features/admin/components/AbsencesPanel.tsx`, `src/test/operatorAbsences.test.tsx`, the
panel's test file, `e2e/typedWalk.spec.ts`, `e2e/walk/db.ts`, `e2e/weekTemplates.spec.ts`,
`e2e/copyWeek.spec.ts`.

## Files you must not touch

- `src/lib/command/resolve.ts`, `src/lib/command/parse.ts`,
  `src/features/board/components/CommandBar.tsx`, `src/features/board/hooks/useDragGesture.ts`,
  `src/lib/voice/trace.ts`, `e2e/walk/sentences.ts`, `e2e/walk/sentences2.ts`,
  `src/test/commandBar.test.tsx`, `src/test/commandResolve.test.ts`, the `s194*Review` test files:
  lane S195-A is editing these now. That lane is changing what the bar's buttons and lot sentences
  say; if a regular expression in `e2e/typedWalk.spec.ts` asserts a wording, leave it as it is and
  the main session will reconcile the two lanes.
- `src/test/defects/**`, `docs/defects/**`, `docs/plan.yaml`, `docs/plan.html`, `CLAUDE.md`,
  `supabase/**`, `playwright.config.ts` (the config is the contract the defect holds the spec to;
  do not make the suite green by capping workers). No migration.
- Ignore `tsc` errors in files you do not own; report them.

## Rules

Do not commit. Never `npm run db:reset`. Do not start, stop or reset any container. PowerShell
runs `npm`/`npx` (no `&&`; use `;`). Never patch a file with `Get-Content`/`Set-Content`; use your
Edit tool. Never `git checkout -- <file>` (copy first, restore from the copy). Memory is short:
`npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`.

## Proving it

1. `npx vitest run src/test/defects/DEF-0056.test.ts src/test/defects/DEF-0041.test.ts
   src/test/grounded.test.ts src/test/s194bReview.test.ts src/test/voiceRead.test.ts`: all green,
   DEF-0056's ten green for the first time. Copy the total line.
2. Mutations on `grounded.ts`, copy-backed, each red BY NAME then restored: the head-of-clause
   test removed; the opener list widened to accept "do not"; the between-words test removed (the
   old reach of 3); the subject-first shape allowed mid-clause.
3. `npx vitest run src/test/operatorAbsences.test.tsx <the panel's test file>
   src/test/defects/DEF-0037.test.tsx src/test/defects/DEF-0037-panel.test.tsx` and the two
   mutations of item 2.
4. `npx tsc -b` (the e2e files are type-checked by their own tsconfig; find it and run that too),
   `npx eslint` and `npx prettier --check` over the files you changed.

## Report

Plain prose. For item 1: the rule as you built it in two or three sentences, the list of every
sentence that grounds and every one that refuses with the test that holds it, any existing case
whose expectation you had to change and why. For item 2: what each screen offers while the answer
is pending and after a failed load, the cases, the mutations' red lines. For item 3: what you
changed, how the cross-check now picks the walk's own trace entries, every single read you turned
into a poll, what you found in weekTemplates and copyWeek, and the exact proof commands left for
the main session. Every runner total line, copied. What you did not do or could not prove. A
draft commit message in the repo's style: plain ASCII, the reasoning in prose, no bullet lists.
