# S72-e — a clear (unassign) over a span of days, and a day phrase that was heard but not read is asked about (F-224, R-435)

The maintainer, 24 Sept (session 191), the night after the third round's fixes landed: "it refused the
clean on cell 5 saying no one is assigned when I can see Maria assigned on friday plus in an earlier
prompt, remainder of the week did not do the job as the whole week." Finding **F-224** in
`docs/plan.yaml` has the trace; read it first. Two readers, two ways of losing the same words:

- the model's unassign form carries `day` (one day) and `until` (R-409's "off until Friday") and no
  week kind, so for "clear Cell 5 for the whole week" it answered `day: null` — today — and the week
  was gone, silently;
- the rules' unassign grammar has no week phrase either, so `parseCommand("clear Cell 5 for the
  whole week")` today yields `place: ["Cell 5 for the whole week"]` (probe it with `npx tsx` on a
  scratch .mts in the repo root, then delete the file), the resolver asks "No place called …", and the
  press loses the week.

## 0. Read first
- `src/lib/command/parse.ts`: the unassign grammar (`parseUnassignRest` or its name — grep `intent:
  "unassign"`), R-409's `until` (`ABSENCE_WORDS`, `until`), the day words (`parseDayWord`,
  `DayWord`, the week kinds used ONLY by copy: `this_week`/`next_week`/`last_week`, and assign's
  repeat kinds `weekdays`/`every_day` with `week`), `formatUnassignCommand`, and `expectedShape`.
- `src/lib/voice/decode.ts`: `decodeUnassign`, `decodeDayWord`, `decodeDayWordOrRepeat` (assign's
  repeat kinds), and `scripts/voice/serve/form.schema.json` + `scripts/voice/train/system_prompt.txt`
  (the model's schema and prompt — the schema is what the server enforces; the prompt is what the
  trained model was taught; you may extend the SCHEMA's unassign day kinds so the served model CAN
  answer a repeat kind, and note in the report that the model was not trained on it and may not).
- `src/lib/command/resolve.ts`: `resolveUnassignCommand` (one day), and how assign's repeat day is
  expanded into a lot (`weekdays`/`every_day` → one command per day on the board; grep
  `isRepeatDay`, `expandRepeat` or similar). Copy's week → days helper.
- `src/lib/command/grounded.ts` and `src/lib/voice/verbGuess.ts` for the grounding style (pure,
  verb lists handed in, `hasAnyWord`).
- Tests: `src/test/commandParse.test.ts` (R-409 cases, the repeat-day cases), `commandResolve.test.ts`
  (the repeat lot cases), `grounded.test.ts` (GR-1..15), `commandBar.test.tsx` (CB-ground-*).

## 1. The grammar: unassign takes the same repeat days assign takes
`UnassignCommand.day` accepts `DayWord | RepeatDay` exactly as `AssignCommand.day` does (extract
assign's own type and parsing; never a second copy), with these spoken shapes, all reading as a
repeat over THIS week unless "next week" is said:
- "this week", "for the whole week", "the whole week", "all week", "every day this week" →
  `{kind: "every_day", week: "this_week"}`;
- "for the rest of the week", "for the remainder of the week", "rest of this week" → a NEW repeat
  kind ONLY if assign's two cannot express it: check first whether `every_day` + the resolver's
  expansion already starts from today for this week (a repeat over this week must never touch a day
  that has passed — read how assign's expansion treats days before today and pin it); if it does,
  "rest of the week" is `every_day this_week` and the expansion's own today-forward rule is the
  answer; say which in the report;
- "every weekday this/next week" → `weekdays` as assign;
- "next week", "for the whole of next week" → `every_day next_week`.
`formatUnassignCommand` round-trips each. The `until` clause (R-409) stays as it is; a sentence with
both a repeat day and `until` is a `bad_day` failure, never a guess.

## 2. The resolver: a repeat unassign is a lot, one day per command
Expand exactly as assign's repeat does — one `unassign` per day the board holds in the span, in board
order, presented as the lot ("N commands ready …", which R-459's lane will reword later — do not
reword here), and each day's own no-block case dropped from the lot rather than refusing the whole
(if EVERY day has nobody, the refusal names the span: "Cell 5 has nobody on it this week."). Reuse
the lot machinery; do not build a second expansion.

## 3. The guard: a day phrase heard but not read is asked about (R-435)
Both readers can still drop words. Add to `grounded.ts` (pure, same style as `groundReading`) a
second check, `groundDays(heard, command, dayWords)`: when the heard text contains a day or span
phrase from a list the caller hands in (the parser's own day words: today, tomorrow, yesterday, the
weekdays, "this week", "next week", "whole week", "rest of the week", "remainder of the week",
"every day", "weekday", a date) and the command carries NO day at all (`day` null and, for unassign,
`until` null; for copy, `from`/`to`), return `{ ok: false, reason: "day_dropped", phrase }`. The bar
(you own the ONE call site in `applyReading` beside `groundReading`, and its twin in the rules path)
turns that into the R-435 question: `I heard "for the whole week" but read it as today. Did you
mean: unassign everyone from Cell 5 every day this week?` with the re-read as a button — build the
candidate by re-parsing the heard text with the new grammar; if it does not parse, ask the plain
question "Which days? Say today, tomorrow, a weekday, this week or next week." with no button.

## 4. The model's schema
Extend `form.schema.json`'s unassign `day` to the same repeat kinds assign's has, so the served
model may answer them; the trained model has not seen them, and the guard in §3 is what covers the
gap until the next training run (say so in the report; the training set generator under
`scripts/voice/train/` may gain the new shapes only if that is a one-line template addition — read it
and say).

## 5. Pins
`commandParse.test.ts` UW-1..: every spoken shape in §1 parses to the repeat kind and formats back;
"clear Cell 5 xyzzy" (an unread tail) is a `bad_day`/unknown failure, never a place named "Cell 5
xyzzy" (read the existing P-cases that pin the tail-as-place behaviour before you change it; say what
they pinned). `commandResolve.test.ts` UW-r-1..: "clear Cell 5 this week" on a board with blocks on
Thu and Fri and none on Sat expands to two removals; a day before today is never in the lot; every
day empty refuses with the span. `grounded.test.ts` GD-1..: the day guard's hits and non-hits
("Sam is off today" carries today, no guard; "Sam is off" no phrase, no guard). `commandBar.test.tsx`
CB-days-1..3: the question and its button, and the no-parse fallback.

## 6. Files you own / must not touch
Own: `parse.ts`, `resolve.ts`, `grounded.ts`, `decode.ts`, `form.schema.json`, the tests named, and
in `CommandBar.tsx` ONLY the two call sites beside `groundReading`. Lane S72-d (wording) is waiting to
start on `CommandBar.tsx`/`resolve.ts` strings and will be held until you land; nothing else is in
flight. Run the named test files, `npx tsc -b`, eslint and prettier on your files. No full suite, no
commit, no `db:reset`, no dev-server restart, never `git stash`.

## 7. Report
Under 30 lines: the shapes and the kind each reads as; how "rest of the week" was resolved; what the
old tail-as-place cases pinned; the schema change and the training note; totals per file; tsc.
