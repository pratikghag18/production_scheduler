# Lane brief: S194-E, the bar's conversation -- DEF-0052, DEF-0049, DEF-0041, DEF-0051, the bar's half of DEF-0046 and DEF-0043, DEF-0044 items 1 and 7

You are a build lane working in the command bar. Line numbers below are from 28 Sept; trust the
names, not the numbers.

## Who else is in the tree right now

- A reviewer is working in `src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts` and
  `src/test/s194bReview.test.ts`. After it, lane D builds the night shift clear (DEF-0040, R-461) and
  the one-day absence (DEF-0048) in `resolve.ts` and `src/features/board/hooks/useDragGesture.ts`.
- Two other reviewers are in the absence screens, the board pop-ups, `OperatorPanel.tsx`,
  `scripts/voice/**`, `supabase/` and `e2e/`.

**You do not touch any of those files.** Ignore `tsc` errors in them. Do not commit. Do not run the
full `npm run test`. Do not run `npm run db:reset`. Do not run any Playwright spec. Do not edit
`docs/defects/*.md`, `docs/plan.yaml` or `CLAUDE.md`. PowerShell runs npm and npx (no `&&`). Never
`git checkout -- <file>` (copy first, restore from the copy). Never patch with
`Get-Content`/`Set-Content`.

## Files you own

- `src/features/board/components/CommandBar.tsx` and its CSS Module
- `src/lib/command/grounded.ts`
- `src/lib/voice/verbGuess.ts`
- `src/lib/voice/trace.ts` and `src/lib/voice/traceServer.ts`
- `src/features/board/store/commandConversation.ts`
- `src/test/commandBar.test.tsx`, `src/test/grounded.test.ts` (or whatever the grounding test is
  called), `src/test/verbGuess.test.ts`, `src/test/trace.test.ts`, `src/test/traceServer.test.ts`,
  `src/test/commandConversation.test.ts`
- ONE new file if you need it: `src/test/defects/` is the tester's, do not add there; put a new
  suite at `src/test/lotAnswer.test.ts`.

## Read first

1. `CLAUDE.md` §4 ("a green case can be pinning the bug", "tsc cannot see a string expectation") and
   §7, all of it: R-430, R-431, R-432 as restated, R-434, R-435, R-447, R-459.
2. `docs/defects/DEF-0052.md`, `DEF-0049.md`, `DEF-0041.md`, `DEF-0051.md`, `DEF-0046.md`,
   `DEF-0043.md`, `DEF-0044.md` (items 1 and 7), in full.
3. In `docs/plan.yaml`, the rows `R-432` and `R-459` whole (grep `^- id: R-432`), including R-432's
   note: it carries the layout the maintainer chose.
4. The pin `src/test/defects/DEF-0041.test.ts`. It is the only pin in your lane; the others have none
   and you write the cases.

## Piece 1 -- DEF-0052 / R-432: the answer names what was done, what was not, what was never tried

Today (`runLotNow`, about l.2163 to l.2230): "Did 1 of 3 things; the next failed: <raw error>. What
was already done stayed: ...". The runner (`useDragGesture.ts`, NOT yours) stops at the first failure
and returns `{ done, error }`; you already hold the full list (`resolved`).

The maintainer chose the layout on 28 Sept: SEPARATE LINES.

    I made 1 of the 3 changes.
    Done: Sam Patel is on Cell 2 today from 8 am to 4 pm.
    Not done: Lena Novak on Cell 3. She is not certified for Welding, which Cell 3 needs.
    Not tried: Tom Baker stays on Cell 1.

Rules:
- The first line is the count. "I made none of the 3 changes." when the first one is refused.
  "change" is singular for one.
- One labelled line per group that has anything in it; a group with nothing in it prints no line.
  Several changes in a group are sentences one after another on that line.
- **Done** takes each change's own readout through `renderReadout`, as the success path does.
- **Not done** is the refused change, said as who and where, then the reason IN THE PLANT'S WORDS.
  The raw error ("Tom Baker is not certified for Cell 1: missing Welding") is not such a sentence.
  Find how a SINGLE command's refusal is worded for the thread today (the single-sentence path
  already rewrites server refusals; R-459's wording lane built it) and route the lot's error through
  the same builder. Do not write a second rewriter (R-449). If the single path has no rewriting for
  some error kind, that kind prints the builder's fallback; list those kinds in your report.
- **Not tried** is every change after the refused one, `resolved.slice(done + 1)`, each said as what
  stays the way it was. Build that sentence from the resolved command's own facts (person, place,
  day, hours) with the builders the readouts use. If a resolved step does not carry enough to say
  what stays, say "<the change, as its readout would have read> was not tried." and name the step
  kinds that needed the fallback in your report. Do NOT reach into `resolve.ts` to add fields; say
  what field is missing and lane D's successor will add it.
- How separate lines are drawn in the thread: look at how a thread turn renders its message. If
  turns are plain text, find whether any existing turn already shows more than one line and draw
  these the same way; the labels are bold only if the thread already has a bold. Do not invent a new
  visual element. The trace entry's `outcome` carries the same text.
- `CB-lot-3` and `CB-lot-fail-1` in `commandBar.test.tsx` pin the OLD wording. The contract changed
  on 28 Sept; they were not wrong when written. Rewrite them to the new answer and say so in the
  report. Add: a lot of five with the second refused (one done, one not done, three not tried); a lot
  whose first is refused; a lot whose last is refused (no "Not tried" line).

## Piece 2 -- DEF-0046, the bar's half: a throw never freezes the thread

Lane B fixed the resolver's crash. Your half: ANY exception thrown while the bar resolves or runs a
command (typed, a candidate button pressed, a yes) is caught at the bar, shown as a turn in the
thread in one plain sentence ("Something went wrong and nothing was changed. Say it again.", and only
claim nothing was changed when that is known: if a lot had already written, use piece 1's answer
with the failure as the Not done reason), and recorded as a trace entry with its outcome. The
question and its buttons do not stay frozen. Find the narrowest place that covers `runCommand`,
`resolveLotStep`, `startLot` and `runCandidateAction`; a case in `commandBar.test.tsx` forces a throw
from a mocked resolver and asserts the turn and the trace entry (R-434: a pin for a bar feature
asserts its trace entry).

## Piece 3 -- DEF-0049: the trace keeps every turn

Missing today: a question left open when the page closes; a turn that crashed; the answer after the
bar moves the board and reruns (the entry ends at "Moved the board to this week." with no outcome).

Read `startTrace` / `finishTrace` (about l.1207 to l.1350) and the comment near l.1342 about
`postTraceOnTeardown` first: a teardown path already exists; find out why the tester's open
questions still went missing (is it wired to `pagehide`/`visibilitychange`, or only to unmount?).
Then:
- An entry is written when the bar ASKS, not only when the turn finishes, and is completed when the
  answer arrives. Read `traceServer.ts` for how an entry is identified; if entries are append-only
  lines with no id, the smallest honest shape is a second line that carries the first's id and the
  outcome. Keep every existing reader of `bar.jsonl` working: grep `scripts/` and `src/test/` for
  what parses the file (the scorer's `--from-trace` does) and show in your report that each still
  reads a finished turn as one turn. If that cannot be kept, stop and describe the two options in
  your report instead of choosing.
- Piece 2's crash is an entry with its outcome.
- The moved-then-refused turn: after the rerun, whatever the bar says (a refusal included) closes
  the entry (R-455: "the trace entry stays open across the move and the rerun's outcome closes it").
- Cases in `commandBar.test.tsx` or `trace.test.ts` for all three.

## Piece 4 -- DEF-0041: an everyday word does not ground a clear of everyone

`groundReading` (`grounded.ts` l.156) asks whether ANY word of the intent's list appears ANYWHERE
in the heard text. The unassign list holds everyday words ("take", "out", "off", "away").

Build: for the SWEEPING case only (read the pin and `grounded.ts` for how sweeping is already
defined; keep that definition), the everyday words do not ground on their own. A sweeping removal is
grounded only when the heard text holds a word that means removal and little else ("clear",
"remove", "unassign", "empty", "delete", and whatever else in `UNASSIGN_VERBS` is of that kind; list
your split of strong and everyday words in the report as a two-column table), or an everyday word
together with a word for everyone or a place the board knows ("take everyone off", "everybody out").
The narrow cases (a named person, a named place) keep today's rule unchanged. The two lists live in
ONE place and the bar's `GROUNDING_VERBS` (l.238) takes them from there: the pin copies the bar's
lists field for field, so if you change the shape of `VerbLists`, the pin must still compile and go
green WITHOUT editing the pin; if it cannot, stop and say so.
Sentences that must still ground: "clear everyone", "take everyone off the board", "everybody out",
"clear the board". Sentences that must not: the two in the pin, and "I will be out of the office
tomorrow", "take your time".

## Piece 5 -- DEF-0051 / R-430: a cell that is not on her board

Ana types "clear Cell 3 today"; the bar says `No cell called "Cell 3" on this board.` and offers
nothing. Find why the nearest-match offer (about l.2928 to l.2953) produced no buttons for a name one
character from "Cell 1" and "Cell 2" (a distance threshold? an exact-form rule?). After the fix the
bar asks, with her own cells as buttons: `No cell called "Cell 3" on your board. Did you mean one of
these?`. The client must not say where Cell 3 really is: a supervisor cannot read places above or
beside her grant, so the bar does not know, and must not learn it. The buttons are data labels (the
one exception R-447 allows). Trace entry asserted.

## Piece 6 -- DEF-0043, the bar's words

1. The Done line shows a raw `2026-10-12`: `runLotNow` pushes `r.readout` to the trace and to the
   Done line without `renderReadout` (about l.2184), while the question before it used
   `renderReadout` (l.2120). Same builder at both.
2. `I heard "...". Did you mean: extend "everyone" by 30 minutes?` (about l.2392): the reserved word
   printed as data in quotes. Say "everyone" as a word, no quotes; check `formatCommand` for the same.
3. `Those two lines (2 and 5) are about the same block; say them one at a time.` (l.2108) answers a
   person who said ONE sentence. When the lot came from one sentence, say it as the board's own
   difficulty in a plain sentence and name the block: "I could not do that in one go: two of the
   changes are about Maria Lopez's block on Cell 2. Say them one at a time." When it came from a
   typed list of several sentences, the existing wording may keep its line numbers.
4. NOT yours: the 24-hour spans on the which-block buttons are built in `resolve.ts`. Leave them.

## Piece 7 -- DEF-0044 items 1 and 7: limits a test must hold

Tests only. For each, write the case, make the mutation on the file (copy first), see the case red
BY NAME, restore from the copy, see it green.
- Item 1: `verbGuess.ts` about l.290, the sound-alike branch's `if (built.length >= 3) break;`. A
  fixture whose heard word sits near four or more verbs. Mutation: `>= 30`.
- Item 7: `groundDays` (`grounded.ts` about l.228), `.some` to `.every`: a lot where some members
  kept the day and some dropped it.

## Proving it

1. `npx vitest run src/test/defects/DEF-0041.test.ts` green by name.
2. `npx vitest run src/test/commandBar.test.tsx src/test/commandConversation.test.ts src/test/trace.test.ts src/test/traceServer.test.ts src/test/verbGuess.test.ts src/test/commandParse.test.ts src/test/dateSeam.test.ts`
   plus the grounding suite and your new file. Copy the runner's total lines.
3. The R-459 wording inventory: grep `src/test` for the suite that holds every string the bar shows
   (the wording lane of 24 Sept left one pin per sentence shape). Every sentence you added or changed
   gets its pin there in that suite's own style.
4. After deleting the old wording, grep `src/`, `e2e/` and `scripts/` for its words ("the next
   failed", "things;", "What was already done stayed", "Those two lines", "on this board"). List
   every hit outside your files with the old and the new string; you do not edit `e2e/`.
5. `npx tsc -b`: no error in a file you own.

## Report

Plain prose. Per piece: what changed and where; the cases added, by name; every existing case you
rewrote and whether it was wrong or the contract changed. A two-column table of every sentence the
bar says that you changed, old and new. The strong and everyday word lists. The two mutations, red
by name then green. Every hit from step 4. The runner's totals, copied. What you did not do, stated
plainly. A draft commit message in the repo's style: plain ASCII, reasoning in prose, no bullets.
