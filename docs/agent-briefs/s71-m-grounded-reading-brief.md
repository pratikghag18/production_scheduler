# S71-m — the model's reading must be grounded in what was heard (F-215, F-212; R-435, R-431)

Two findings from the 23 Sept evening walk (`grep -n "id: F-21[25]" -A 18 docs/plan.yaml`):
- **F-215**: Whisper wrote `"EF76."`; the model answered an unassign of everyone on the day and the
  bar offered "7 commands ready … Do all 7". A garbage transcript became a clear of the board, one
  press away.
- **F-212**: `"-2, Area 2, Frame A on cell 6, in line 3, from 8 a.m. to 2 p.m. today."` (the words
  "Assign Tom Baker to" lost to the microphone) was read by the model as a BOOKING of the job with
  no person and written at once, "read by the model". Nobody said book.

The model will keep guessing; the bar decides what a guess may do. Another lane (S71-l) is
editing `localRecognizer.ts`, `recognizer.ts`, `parse.ts`, `resolve.ts` and ONE line of
`CommandBar.tsx` in `startListening` (~3565) at the same time; do not touch those files, and touch
CommandBar.tsx only around `applyReading` (~2070) and wherever the guard's question is rendered.

## 1. The rule (R-435, when in doubt ask; R-431, nothing offered the server would refuse)

A reading from the model runs unchanged only when it is **grounded**: the heard text contains, in
some spelling the parser itself accepts, the intent word of the command the model produced.
Build a pure helper `src/lib/command/grounded.ts`:

```ts
export type Grounding = { ok: true } | { ok: false; intent: string; reason: "no_intent_word" | "sweeping" };
export function groundReading(heard: string, command: Command): Grounding;
```

- Intent words per command kind — take them from `parse.ts`'s own verb lists (extract, never
  retype: import the exported constants if they exist, otherwise export them from parse.ts as
  constants and import — `commandPurity.test.ts` U1 forbids runtime imports INTO resolve.ts, not
  from parse.ts, check the rule before wiring). Kinds: assign (assign/put/schedule…), book, unassign
  (clear/remove/unassign/take off…), move, several (each member grounded on its own), board (show/
  go to…), headcount (make … people / set … to N). Matching is case-insensitive, punctuation
  ignored, on word boundaries.
- **Sweeping** readings — an unassign of everyone, of a whole place or of a whole day, a lot of
  more than one command — from a text with NO intent word are `reason: "sweeping"`.
- A single assign/book/move/headcount whose intent word is absent is `reason: "no_intent_word"`.

In `CommandBar.tsx` `applyReading` (~2070): when `groundReading(sentence, result.command)` is not ok:
- `sweeping` → refuse: status and trace entry "Did not run: nothing in \"EF76.\" says clear, remove
  or unassign. Say it again." — no buttons, `outcome: "refused: ungrounded"` (use the trace's own
  refused shape; read how `fallbackToRules` records a refusal and match it).
- `no_intent_word` → ask, with the model's reading as the one candidate button and the readout as
  its label: "I heard \"-2, Area 2, Frame A on cell 6 …\". Did you mean: Book Area 2 Frame A · Cell 6
  · 08:00–14:00?" — pressing it runs the command exactly as today; no or Escape drops it. Reuse the
  existing candidate-question machinery (`Candidate`, the chips, `answered`) — do not build a
  second question shape. Trace: `asked` carries the question, `offered` the one label.
- A grounded reading runs exactly as today.

## 2. Pins
`src/test/grounded.test.ts` (GR-1…): "EF76." + unassign-everyone → sweeping; "clear Cell 3 today"
+ unassign → ok; "-2, Area 2, Frame A on cell 6 …" + book → no_intent_word; "book Bracket A on Cell
3 …" + book → ok; "put Sam on Cell 1 8 to 4" + assign → ok (a synonym the parser accepts); "Sam Patel
to Cell 1 from 8am to 4pm" + assign → no_intent_word; a several whose members are all grounded →
ok, one ungrounded member → not ok; case and punctuation ignored.
`src/test/commandBar.test.tsx` CB-ground-1: a reader answering an unassign-everyone for "EF76." →
the status reads the refusal, nothing ran, no Do all button, the trace entry's outcome is the
refused shape; CB-ground-2: a reader answering a book for the "-2, Area 2 …" text → the question
with one button; pressing it writes (onBook called once); CB-ground-3: the same with "no" → nothing
written, `answered` "no"; CB-ground-4: a grounded reading runs unchanged (an existing case's shape).
Also grep the existing CB cases whose fixtures hand the reader a command for a sentence that does
NOT contain its intent word — they will go red; read each and say in the report whether it was
pinning the bug (rewrite it) or a contract that must survive (tell me, do not weaken the rule).

## 3. Run
`npx vitest run src/test/grounded.test.ts src/test/commandBar.test.tsx src/test/commandPurity.test.ts`;
prettier, eslint, `npx tsc -b`. Files you own: `src/lib/command/grounded.ts` (new), `parse.ts` ONLY
if a verb list must be exported (say so; the other lane edits its split grammar — coordinate by
touching only the export), `CommandBar.tsx` around `applyReading` and the question rendering,
`src/test/grounded.test.ts`, `src/test/commandBar.test.tsx`. No `npm run test`, no commit, no
`docs/plan.yaml`, no restarts, no git stash.

## 4. Report
Under 30 lines: the verb lists' source, the two outcomes and their exact wording, the CB cases that
went red and your verdict on each, pin ids, totals.
