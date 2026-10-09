# S71-n — a second, fresh sentence list for the spoken walk, green twice as a typed spec first (R-433)

The maintainer, 24 Sept (session 191): "Can we do another round of voice recordings for all
models? I want to try different sentences than before. So, can you do a clean up and come up with
a fresh list?" Standard **R-433**: no sentence list is handed to the maintainer before it runs
green twice as an e2e spec over the same data file. The first list is `e2e/walk/sentences.ts`
(22 entries), run by `e2e/typedWalk.spec.ts`, documented for speaking in
`docs/walks/voice-walk-2026-09-22.md`. This lane makes a SECOND list of the same shape, different
sentences, and proves it the same way.

## 0. Read first
- `e2e/walk/sentences.ts` whole: the `Sentence` interface (`say`, `expect` regex, `question`/
  `answer`/`button`/`orDirect`/`then` shapes, `dates`), `buildSentences(dates)`, and the helper
  regexes (`headcountReadoutRe`, the escape helper). Copy the SHAPE exactly; every entry form the
  spec understands is already used there.
- `e2e/typedWalk.spec.ts`: how the list is loaded (~83 `buildSentences({day, tomorrow, far})`),
  how each entry is driven and asserted, the clean-up (`clearWindow` before and after), the trace
  read, the headcount poll. The spec must run the SECOND list without duplicating its own code:
  add one environment switch, `WALK_SET=2` (read once at module top, default 1), that picks
  `buildSentences2` from a new `e2e/walk/sentences2.ts`; nothing else in the spec changes unless
  an entry shape the new list needs is genuinely missing (say so; do not invent shapes).
- `docs/walks/voice-walk-2026-09-22.md`: the document the maintainer reads aloud from; the new one
  is `docs/walks/voice-walk-2026-09-24.md`, same sections (setup, the table with say / expect /
  then, the reading notes), with the new sentences.
- The demo world: `supabase/dev_demo.sql` for Plant A's people (Sam Patel, Maria Lopez, John Kim,
  Priya Shah, Tom Baker, Lena Novak — Sam Patel and Tom Baker on Cell 1 have the Welding
  certificate rule, Tom is NOT certified for Cell 1), parts (Housing A, Bracket A, Common Fastener,
  Line 1 Subassembly A, Area 2 Frame A; which cells may run which — cells 1-2 under Line 1, 3-4
  under Line 2, 5-6 under Line 3), the plant's shifts (Shift 1 06:00–14:00, Shift 2 14:00–22:00,
  Shift 3 22:00–06:00; each person's home shift by hash — read `home_shift_id` from the running
  database with a read-only psql if you need a person's band), absences.

## 1. The list — 22 entries, DIFFERENT from the first
Same command families as the first list so the two rounds compare, but different people, parts,
cells, hours and days, and a few shapes the first list never used. Every sentence must be one the
TYPED bar handles today (the first list's own `orDirect` note shows the model may read a sentence
directly; write `expect` for the rules' reading and `orDirect` where the model might land it
without the question, as the first list does). Do not use "end", "split" or "extend" with the
word "block" in more than one entry each, and use the "assignment" spelling once, so the second
round measures both. Cover:
1. a clear of a cell with nobody on it (refusal);
2. four assigns with hours, on different cells and lines from the first list (Priya on Cell 1
   from 6am to 2pm, Maria on Cell 6, Lena on Cell 2, John on Cell 5 — check each person's
   certificates and area rule so the ones that must WRITE do write and ONE is a not-certified
   question answered with a reason);
3. one assign where the part name is misheard on purpose ("Bracket Pay" → Did you mean Bracket A);
4. one assign with no part on a cell that makes several ("Which part? …" → press one);
5. one booking with headcount on a cell from Line 3;
6. one "until end of shift";
7. one "from 10 to 2" with no am/pm — R-435: the bar must ASK which half of the day; assert the
   question and press the morning;
8. one end, one split, one extend, one shorten (a shape the first list did not use — check the
   adjust grammar accepts "shorten … by 30 minutes");
9. one swap that is refused for a certificate, one swap that writes;
10. one headcount change on the booking from 5;
11. one copy of a cell's day to a NAMED day ("copy today to Friday for Cell 5") — check the copy
    grammar accepts a weekday; if not, use "tomorrow" and say so;
12. one "every weekday next week" that lands off the board → Show that day → the lot → no;
13. one absence sentence ("Sam Patel is off tomorrow") — R-409's shape; assert what the bar does
    with it today (a removal question or a write) and pin that;
14. one cover ("cover Priya Shah with Lena Novak today") — the S-series cover shape; same rule;
15. one "same as yesterday for Cell 3" — copy's other spelling;
16. two clears at the end: "clear Line 2 today" and "clear Area 2 today", asserting the lot's
    count and the run removals the way entries 21–22 of the first list do.
Number them 1–22 in the order they must be SPOKEN (state before each depends on the ones before).

## 2. Proving it (R-433)
`WALK_SET=2 npx playwright test e2e/typedWalk.spec.ts` (PowerShell: `$env:WALK_SET="2";` first)
must pass TWICE in a row against the running local stack, on the walk's own day (the spec picks
next Monday and cleans it before and after). Quote both runs' totals. Then run the FIRST set once
more without the variable to prove it is untouched. The dev server on 5173 is the maintainer's; do
not restart it. The Whisper container may be on any model; the typed walk does not use it.

## 3. Files you own / must not touch
Own: `e2e/walk/sentences2.ts` (new), `e2e/typedWalk.spec.ts` (the one switch), `docs/walks/
voice-walk-2026-09-24.md` (new), `e2e/walk/sentences.ts` ONLY to export a helper the second file
needs (no entry changes). Do not touch `src/`, `supabase/`, `scripts/`, `docs/plan.yaml`. No
`npm run test`, no commit, no `npm run db:reset`.

## 4. Report
Under 30 lines: the 22 sentences as a numbered list (the exact words to say), which entries ask a
question and what to press or say, the two green runs' totals and the first set's rerun, and any
shape you could not use and why.
