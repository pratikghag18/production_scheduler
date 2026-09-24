# S72-d — every sentence the bar says is one a supervisor would say (R-459)

The maintainer, 24 Sept (session 191), after the third spoken round: "the model should return the form
based output in a conversational sentence as what it returns right now is of no use to a non-technical
user ... I thought people could have conversations with the board". Offered two ways — the board writes
every sentence (A), or the model rephrases the board's facts (B) — the maintainer chose A: "Go with A,
write the standard and start the wording lane." The standard is **R-459** in `docs/plan.yaml` and in
`CLAUDE.md` §7; read both first. R-426's duty applies: this lane inventories EVERY string the bar shows
and fixes each one, or queues it with a reason.

## 0. The register (the maintainer's own example, accepted)
"Done. John Kim is on Cell 6 today from 4 pm to 10 pm, making Housing A."

Rules of the register, all of them:
- One or two complete sentences. The first says what happened or what is asked; the second, when
  needed, says why or what to do.
- People by full name; cells by name ("Cell 6"); the line or area only when the cell's name is not
  unique on the board (check `ctx` for a duplicate name; otherwise drop the path).
- Hours as spoken: "4 pm", "10:30 am", "noon", "midnight", "from 8 am to 12 pm". Days: "today",
  "tomorrow", "yesterday", otherwise "Mon 28 Sep" (the plant's zone, R-426, through the existing
  `renderReadout`/`formatDayLabel` seam — never a new date site; `src/test/dateSeam.test.ts` will fail
  a new one).
- No arrows, no "·", no "›", no "→", no ISO dates, no "16:00–22:00", no "read by the model", no
  "ungrounded", no "lot", no "form", no "intent", no "<person>" placeholders, no "Say it like".
- A question ends by naming the choices in the words the buttons carry: "Which part? Cell 3 makes
  Housing A, Bracket A and Common Fastener." with those three as buttons.
- A refusal: "Not done: Lena Novak is not certified for Cell 2, she is missing Welding. Say the
  reason to schedule her anyway, or no."
- A lot: "Ready to do 2 things: remove Priya Shah from Cell 1 today from 6 am to 2 pm, and put Sam
  Patel there instead. Say yes to do both, or no." Then "Done, 2 things." or "Nothing changed."
- A move of the board (R-455): "Moved the board to Mon 28 Sep."
- "Done." leads every successful write; "Not done:" leads every refusal.

## 1. Inventory FIRST, then edit
Before editing, write `docs/walks/bar-sentences.md`: a table of EVERY sentence shape the thread can
show — the readout builders in `src/lib/command/resolve.ts` (~lines 270–400: the "→ · ›" labels for
assign, book, remove, remove-job, move, split, headcount, copy), `describeQuestion` (resolve.ts ~5050–
5220, every `case`), `failureToStatus`/the shape hints in `CommandBar.tsx` (grep `Say it like`,
`failureToStatus`, `whyForReason`, `failurePrefixForReason`, `lotOutcome`, `commands ready`, `Did not
run`, `read by the`, "Nothing was written", "stayed"), and `parse.ts`'s own `describeFailure`/grammar
strings (grep `Say it like`, `bad_time`, `no_time`, `time_order`). Three columns: where (file:function),
today's text, the new sentence. Around 60–90 rows. Commit nothing; the main session reads the table and
the maintainer may adjust wording before you go on — send your report at this point with the table's
path and WAIT for the main session's message before editing any file under `src/`.

## 2. Then the edits (after the go-ahead)
- The readout labels and `describeQuestion` in `resolve.ts`: rewrite in place; the `ran` labels the
  TRACE records may stay compact only if they are built separately — check whether the thread's readout
  and the trace's `ran` string are the same value (they are today, `runCommand` uses one label). If they
  are one value, the new sentence goes into both; R-459 says the trace may keep a compact form, but a
  second builder for the same fact is the very thing R-449 forbids, so keep ONE builder and let the
  trace carry the sentence. Say which you did.
- `CommandBar.tsx`'s own strings (the shape hints, the lot wording, the refusal prefixes, the "read by
  the model" suffix — that suffix goes away from the thread entirely; the trace already records `by`).
- `parse.ts`'s failure texts: the grammar hint is retired for any sentence R-456's verb guess answers;
  what remains (a sentence with no shape at all) says "I did not understand that. Say who, where and
  when, like: assign Sam Patel to Cell 1 today from 8 am to 4 pm." — one example sentence, no angle
  brackets.
- Every test that asserts the old text: `commandResolve.test.ts`, `commandBar.test.tsx`,
  `commandParse.test.ts`, `commandLauncher.test.tsx`, `commandBarGate.test.ts`, the e2e walks
  (`e2e/typedWalk.spec.ts` asserts `expect` regexes from `e2e/walk/sentences.ts` and `sentences2.ts` —
  those regexes must be updated to the new wording, and BOTH walks run green again, `WALK_SET=2` and
  without; that is R-433's own proof). Read each failing case before changing it; a case that pinned a
  FACT (which cell, which hours) keeps the fact and takes the new words.
- One pin per sentence shape in `commandResolve.test.ts` (RS-words-1..) asserting the exact new
  sentence for one example each — the table's third column is the expected text.

## 3. Files you own / must not touch
Own: `docs/walks/bar-sentences.md` (new), `src/lib/command/resolve.ts` (wording only), `src/lib/
command/parse.ts` (failure texts only — lane S72-a has just finished in it; re-read it fresh), `src/
features/board/components/CommandBar.tsx` (strings only — lane S72-b is finishing in it NOW; do not
open it for editing until the main session's go-ahead says S72-b has landed), `e2e/walk/sentences.ts`,
`e2e/walk/sentences2.ts` (regexes only), and the test files named above. Do not touch `docs/plan.yaml`,
`CLAUDE.md`, `scripts/`, `supabase/`, `verbGuess.ts`, `grounded.ts`. Run the named test files and the
two typed walks (`npx playwright test e2e/typedWalk.spec.ts`, then with `$env:WALK_SET="2"`), not the
full suite. The dev server on 5173 is the maintainer's: do not restart it. No commit, no `db:reset`.

## 4. Reports
Two: (1) after §1, under 15 lines: the table's path, row count, and the five sentences you are least
sure about, with two candidate wordings each for the maintainer. (2) after §2, under 40 lines: what
changed per file, which old cases pinned wording vs facts, the test and walk totals.
