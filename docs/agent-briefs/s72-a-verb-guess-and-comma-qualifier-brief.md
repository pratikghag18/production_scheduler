# S72-a — the verb the board did not hear is asked as a choice (R-456, F-222), and a comma before a line no longer keeps "in" inside the place (F-218)

The maintainer, 24 Sept (session 191), after the third spoken round on small.en. Every complaint below is
a real trace entry in `data/voice/trace/bar.jsonl` from 19:25Z on; read them first (`node -e` over the
file, print `heard`, `read`, `asked` for entries with `at >= 2026-09-24T19:25`).

- "Tom Baker to Cell 3 from 18 to 12 p.m. today." (the verb not heard) → the bar printed the grammar
  hint "Say it like: assign <person> to <part> ...". The maintainer: "even if it did not hear assign, it
  should have figured out that I was trying to assign someone and give me an option accordingly, what it
  has given as a response is not at all useful to an average non-technical user".
- "and John Kim's block at 10 a.m. today" ("end" heard as "and", four times in a row) → the hint twice,
  then a "move" the model invented. "why is the model not asking me what I want to with the prompt with
  some options?"
- "Show up Lena Novak and Priya Shah today." ("swap") → refused as ungrounded. "why can't the model
  anticipate what I'm trying to do here?"
- "Assign John Kim to Housing A on Cell 6, in Line 3 from 4 until end of shift today." (every word
  right, a comma before "in") → "There is no Cell 6 in in Line 3." three times. The typed sentence
  without the comma wrote. "It just lied to me about there being no cell 6 in line 3."

Requirement **R-456** and finding **F-222**, finding **F-218** — both in `docs/plan.yaml` (read the
rows). CLAUDE.md §7: R-435 (when in doubt, ask) and R-430 (a dead end offers the nearest choices).

## 0. Read first
- `src/lib/command/grounded.ts` whole (the `VerbLists` shape, `normalize`, `hasAnyWord`, the
  runtime-import rule in its header: this directory never imports `parse.ts` at runtime for its word
  lists — `commandPurity` U1 in `src/test/commandPurity.test.ts` enforces it; `parse.ts` itself is fine
  to import for `parseCommand`/`formatCommand` since `grounded.ts` already takes `Command` from it as a
  type — CHECK U1's exact rule before importing anything at runtime and say in the report what it allows).
- `src/lib/command/verbGuess.ts` — the PRE-SEATED STUB with the signature you fill in. Do not change the
  signature or the export names; lane S72-b is coding the bar against them right now.
- `src/features/board/components/CommandBar.tsx` lines ~205–260 (`GROUNDING_VERBS`: the lists the bar
  hands in — the same object will be handed to `guessVerbs`) and `fallbackToRules` (~2093): the two
  places the bar will call your helper. You do NOT edit that file.
- `src/lib/command/parse.ts`: `parseCommand`, `formatCommand`, the verb regexes (`ASSIGN_VERBS`,
  `COPY_VERB_RE`, `ADJUST_VERBS`, `SAME_AS_WORDS`, `BLOCK_TAIL_WORDS`, the place splitter around
  lines 1400–1530 and 2380–2420 where `place: [pl, ...pieces]` is built), and F-216's comma fix for split
  (grep `F-216`) — the shape to follow for F-218.
- `src/test/grounded.test.ts` (GR-1..15) and `src/test/commandParse.test.ts` for the test style.

## 1. F-218 — the comma before a qualifier (parse.ts)
`parseCommand("Assign John Kim to Housing A on Cell 6, in Line 3 from 4 until end of shift today.")`
today gives `place: ["Cell 6", "in Line 3"]`. Reproduce with `npx tsx` on a scratch file first, and
find WHERE the place list is split (the comma is treated as a separator and the following "in" is kept
as part of the piece). Fix at the splitter: after splitting a place phrase on commas/"in"/"on"/"at", each
qualifier piece loses a leading `in |on |at |of ` (case-insensitive, one preposition, whole word) — and
the same for a trailing comma. Check every `place: [pl, ...` site (there are about eight; the assign,
book, unassign, headcount, copy, split builders) goes through ONE helper so the fix lands once; if they
do not, route them through one (`splitPlacePieces` or whatever the existing name is) and say so.
Pins in `commandParse.test.ts`: the sentence above (with the comma, with a lowercase "cell 6, in line
3", and with a comma before "on Cell 6" too) parses to `place: ["Cell 6", "Line 3"]` and formats back
without quotes; a place that legitimately contains a preposition in its NAME (if any exists in the demo
— check `supabase/dev_demo.sql`; if none, note it) still round-trips. Run the whole parse file green.

## 2. R-456 — `guessVerbs(heard, verbs)` (verbGuess.ts)
Pure, no React, no runtime import of `parse.ts`'s word lists (the lists arrive as `verbs`). The rule:

1. **Already has a verb → `[]`.** If `normalize(heard)` contains any entry of any list in `verbs` as a
   whole word/phrase (reuse `grounded.ts`'s `hasAnyWord`; export it from there if it is not exported —
   that is the ONE edit you may make to `grounded.ts`), return `[]`. The bar keeps its current answer.
2. **No shape of a command → `[]`.** A sentence with none of: a clock time (`\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?`,
   "noon", "midnight"), the word "block"/"assignment"/"shift"/"cell"/"line"/"area"/"job"/"people", a
   capitalised two-word name (`[A-Z][a-z]+ [A-Z][a-z]+`), or a "'s" possessive, is not a command; `[]`.
3. **Otherwise, rank the verbs by sound.** Take the sentence's FIRST word (and first two words as a
   phrase), lowercased, stripped of punctuation. Score every entry in every list by a sound-alike
   distance: Levenshtein on the normalised strings, with a small hand table of known confusions that
   Whisper produces and that the trace shows, consulted first: `and`→end, `an`→end, `close`→end,
   `so`→swap, `show up`→swap, `swab`→swap, `a sign`→assign, `sign`→assign, `a string`→assign,
   `assigned`→assign, `book it`→book, `split it`→split, `spit`→split, `extent`→extend, `and of`→end.
   A table hit ranks first; then entries with distance ≤ 2 (≤ 1 for words of three letters or fewer),
   best first, ties in the order the lists are declared. Keep at most three.
4. **When no word sounds like a verb** (the verb was simply not heard: "Tom Baker to Cell 3 from 8 to
   12 today"), the candidates are the verbs whose sentence SHAPE fits: `assign` when there is a person
   AND a place; `book` when a part and a place and no person; `unassign` when a person and no hours;
   `move` when "'s block"/"'s assignment" and a span or "to"; `split` when "'s block" and one "at"
   time; `end` (the `move` list's own "end" entry) when "'s block" and "at" — in that order, at most
   three. Put the verb in FRONT of the sentence.
5. **Build each candidate's sentence**: for a table/distance hit, replace the misheard first word(s)
   with the verb; for a shape hit, prefix the verb. Then `parseCommand(sentence)`; keep only the ones
   that parse `ok`, and `label = formatCommand(command)`. If none parse, return `[]` (the bar keeps its
   old answer — never a button that cannot run).

Export also `describeVerbGuess(heardWord: string, guesses)` → the question's text: `I heard "and". Did
you mean:` when a word was replaced, `Did you mean:` when the verb was simply missing — the bar appends
the buttons. Keep it pure.

Pins in a new `src/test/verbGuess.test.ts` (VG-1..): the four trace sentences above give the expected
first candidate (`end John Kim at 10:00` for the "and" sentence; `assign Tom Baker to Cell 3 ...` for
the verbless one — check what `parseCommand` needs to accept "from 8 a.m. to 12 p.m." with the a.m.
dots and say if it does not; `swap Lena Novak and Priya Shah today` for "Show up"); a sentence that
already has a verb gives `[]`; "See you at the next one." gives `[]`; "Please, Cell 6 today." gives
`[]` or a clear — decide by rule 2 and pin what you decide; a candidate that does not parse is dropped;
at most three; `describeVerbGuess`'s two wordings. Also add the table's every entry as one
table-driven case so a future addition is one line.

## 3. Files you own / must not touch
Own: `src/lib/command/verbGuess.ts`, `src/lib/command/parse.ts` (F-218 only), `src/lib/command/
grounded.ts` (an export only), `src/test/verbGuess.test.ts` (new), `src/test/commandParse.test.ts`
(new cases). Do not touch `CommandBar.tsx`, `BoardPage.tsx`, anything under `src/features/`,
`docs/plan.yaml`, `scripts/`. Lane S72-b is editing `CommandBar.tsx`, `BoardPage.tsx` and
`commandConversation.ts` at the same time — ignore `tsc` errors in files you do not own. Run
`npx vitest run src/test/verbGuess.test.ts src/test/commandParse.test.ts src/test/grounded.test.ts
src/test/commandPurity.test.ts` — not the full suite. No commit, no `db:reset`.

## 4. Report
Under 30 lines: where the comma split lived and what changed; the rule as implemented (any departure
from §2 and why); the test totals for the four files; anything `parseCommand` refused that the trace
sentences need (a.m./p.m. dots, "18 to 12", etc.) as a list for the main session.
