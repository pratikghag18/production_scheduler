# Brief S52-a: change and shift as move verbs; a shift's name in the form

Stage S52, requirements R-401 and R-402 (read them in `docs/plan.yaml`; the claims are the
contract), design §19.99 (D128). No other lane is running. Only the parser, the types it
exports, the minimal compile-fixes in its consumers, and the tests change here; the resolver's
shift-band step and the data are the next lanes.

## 1. What exists (read first)

- `src/lib/command/parse.ts` whole: the verb lists (`MOVE_VERBS` ~line 200; the R-391 comment
  above them saying shift/change are never verbs — rewrite it), `parseMoveRest` (the place-less
  split on the first " to " from S50), `splitMoveOperatorPlaces`, `parseAssignRest` (the
  operator/product/places split on " to work on | to | on "), `parseBookRest` (the `for <n>`
  headcount clause — read `extractHeadcount` or its equivalent: "for" followed by a whole number
  is headcount; anything else after "for" is ordinary text), `parseTimeAndDay` (the mandatory
  time clause for assign/book: `no_time` when absent), `extractOptionalTimeClause`, the quote
  sentinels, `formatCommand` and the four `format*Command`s, the list handling from S50
  (`detectAndList`, `combineLists`).
- `AssignCommand`/`BookCommand` have `start`/`end: ClockTime`; `UnassignCommand`/`MoveCommand`
  have `span: {start,end} | null`.
- Tests `src/test/commandParse.test.ts`: PV1–PV5 (R-391 — PV2 pins "neither shift nor change";
  the maintainer withdrew that, so PV2 is re-pinned to "both in move only, the lists still
  disjoint"), the P/B/U/M/L cases. `src/test/voiceData.test.ts` V2 (every template's sentence
  parses to its form — the templates draw verbs from your lists, so a new verb is exercised by
  V9's "every verb opens a clean row" automatically), V9.
- Consumers that must compile: `src/lib/command/resolve.ts`, `src/lib/voice/decode.ts`,
  `src/features/board/components/CommandBar.tsx`, `scripts/voice/lib/templates.mjs` (the
  generator's `baseCommand`), `scripts/voice/lib/templates.d.mts`.

## 2. What to build

1. **Verbs (R-401).** `MOVE_VERBS` gains `"change"` and `"shift"`. Rewrite the R-391 comment:
   the maintainer withdrew the exclusion on 13 Sept (session 163); the first-word rule keeps a
   noun "shift" mid-sentence out of the way. PV2 re-pinned; PV1 gains a case per new verb.
2. **The possessive timing tail (R-401).** In `parseMoveRest`, after the operator segment is
   found (either split rule), strip a trailing possessive tail from the operator:
   `/\s*(?:'s|’s|s)\s+(timing|hours|time|schedule|slot)$/i` — so `Operator A3's timing`,
   `operator a3s timing`, `Sam’s hours` all yield the person. Only in the move grammar. Cases:
   `change Operator A3's timing to 8 pm to 11 pm` → move, place [], span 20:00–23:00;
   `change operator a3s timing to 8:00 p.m. to 11:00 p.m.` (the recogniser's dotted form,
   F-144) → the same; `shift Operator A3 to Cell 2` → move to Cell 2; `change Sam on Cell 1 to
   Cell 2` → the placed move; `shift` mid-sentence is untouched (`assign Sam to Housing A on
   Cell 1 for shift 2 …` is not a move).
3. **The shift field (R-402).** Every single command gains `shift: string | null`.
   `AssignCommand`/`BookCommand`: `start: ClockTime | null; end: ClockTime | null` with the
   documented invariant "shift null ⇒ start and end non-null; shift non-null ⇒ both null".
   `UnassignCommand`/`MoveCommand`: `shift` non-null ⇒ `span` null. Grammar: a shift clause
   anywhere after the person, extracted BEFORE the time clause and the places are read:
   `(for|on|in|during)\s+(?:the\s+)?shift\s+(<name>)` where `<name>` is the next one or two
   words up to the next preposition/comma/end (`for shift 2`, `on shift B`, `for shift "Late
   Turn"` quoted), or `(for|on|in|during)\s+the\s+(<words>)\s+shift` (`for the night shift`,
   `on the morning shift` → shift "night"/"morning"). The name is stored as written (trimmed,
   quotes restored). With a shift clause present, assign/book no longer require the time
   clause (`no_time` only when neither hours nor a shift were said); a sentence with BOTH a
   shift and hours fails `{kind:"shift_and_hours"}` (add to `ParseFailure`). A move with a
   shift and no `toPlace` is a move in time (it satisfies R-389's "new hours").
4. **The product last (R-402).** In `parseAssignRest`, when the text after the operator
   separator starts directly with a place preposition or the shift clause already consumed
   it — i.e. no product precedes the places — read a trailing `for <product>` (the LAST " for "
   that is not the shift clause) as the product. The maintainer's sentence
   `assign Operator A2 to work for shift 2 on Cell 1 in Line 1 for Housing A` → assign,
   operator "Operator A2", product "Housing A", place ["Cell 1","Line 1"], shift "2", start
   null, end null. Also `Assign Operator A2 to work for shift 2 on Cell 1, Line 1 for Housing
   A` (the comma qualifier). A product-first sentence with a shift also works:
   `put Sam on Housing A on Cell 1 for shift 1`. `formatCommand` prints the canonical order
   (product first) and `for shift <name>` in place of the hours; round-trips.
5. **Consumers compile, no behaviour change.** `resolve.ts`: where `command.start`/`end`
   are used, a null start/end with a shift set must produce a new question
   `{kind:"shift_unsupported", text: shift}` for now (`describeQuestion`: `"Shifts by name
   are read but not yet resolved; say the hours for now."`) — the next lane replaces it. Guard
   `resolveDaySpanStep` callers accordingly. `decode.ts`: accept the `shift` field (string or
   null; refuse a form with both shift and hours; refuse start/end null without a shift);
   VR1's round-trips keep passing. `CommandBar.tsx`: compile only. `templates.mjs`
   `baseCommand`: `shift: null` in every form (V2/V4 must keep passing — the committed held-out
   forms have no `shift` key, so make `equalForms`/the oracle comparison treat a missing
   `shift` as null OR regenerate; regenerating is the data lane's job, so do the former in
   `scripts/voice/lib/form.mjs` `canonical` with a comment naming S52, and say so).
6. **Tests.** `commandParse.test.ts`: PV1/PV2 re-pinned; new `describe("commandParse: S52
   change, shift, and a shift by name")` SH1–SH14: the two change sentences, shift as a verb,
   the possessive variants (`'s`, `’s`, bare `s`), a mid-sentence shift noun not a verb; `for
   shift 2` on an assign (start/end null, shift "2"), `on the night shift` on a book, `for
   shift 1` on a removal (span null), `during shift 3` on a move in time (toPlace null,
   allowed), quoted shift name, shift AND hours → `shift_and_hours`, no hours and no shift on
   an assign → `no_time` unchanged, the maintainer's product-last sentence verbatim and with
   the comma, formatCommand round-trips for a shift assign and a shift removal, and a several
   with a shift (`assign A2 and A3 to Housing A on Cell 1 for shift 2`) copying `shift` into
   both. `commandResolve.test.ts` RS2: an assign with a shift resolves to `shift_unsupported`
   with the message verbatim. `voiceRead.test.ts` VR12: decode accepts `shift`, refuses both,
   refuses neither. Run `npx vitest run src/test/commandParse.test.ts src/test/commandResolve.test.ts
   src/test/commandBar.test.tsx src/test/commandPurity.test.ts src/test/voiceData.test.ts
   src/test/voiceRead.test.ts src/test/voiceTrain.test.ts`, `npx tsc --noEmit -p .`, eslint and
   prettier on your files.

## 3. Rules

- Files you own: `parse.ts`, the minimal compile-fixes in `resolve.ts`/`decode.ts`/
  `CommandBar.tsx`/`templates.mjs`/`templates.d.mts`/`form.mjs`, and the four test files named.
  Not the schema, not the prompt, not `docs/plan.yaml`, not `data/voice/heldout.jsonl`.
- `src/lib/command/*.ts` import only types. No new dependencies. Do not run the full
  `npm run test`. Do not commit. An existing case that fails is read and reported (pinned the
  old rule, or a real regression), never weakened silently.
- Report: files with a line each; the shift-clause regexes as written; the product-last rule
  in one sentence; every new/re-pinned test title; vitest/tsc/lint summaries; `git diff --stat`.
