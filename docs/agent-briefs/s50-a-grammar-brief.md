# Brief S50-a: the rule grammar widens — no place, and several in one sentence

Stage S50, requirement R-398 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.97 (D126). No other lane is running. Only the parser and its tests change; the resolver
(S49) already accepts an empty place, and the bar is untouched.

## 1. What exists (read first)

- `src/lib/command/parse.ts` — the whole file, ~1130 lines, pure (no runtime imports;
  `commandPurity.test.ts` U1 pins that). `parseCommand(text)` returns `ParseResult`;
  `formatCommand(command)` is its inverse. Quoted segments are replaced by sentinels
  (`QUOTE_OPEN`/`QUOTE_CLOSE`, U+E000/U+E001) before any splitting and restored after
  (`restoreQuotes`) — never lose them. The intent is decided by the first word
  (`UNASSIGN_VERB_RE`, `BOOK_VERB_RE`, `MOVE_VERB_RE`, else assign). `parseUnassignRest`
  (~line 725) returns `no_place` when `placesText` is empty; `parseMoveRest` (~858) the same,
  and `no_move` when neither `toPlace` nor `span` was said. `splitOperatorPlaces` /
  `splitMoveOperatorPlaces` split the operator from the places on the FIRST of a small set of
  words; `splitProductPlaces` splits places on on/at/in/comma. `parseAssignRest` (~548)
  splits operator from product-and-places on " to work on | to | on ". The verb lists are
  exported; "shift" and "change" are deliberately in none (R-391) — leave that alone.
- `Command` union, `ParseFailure` union (~138), the doc comments on `place` (S49 already
  says a removal or a move may have an empty place).
- `src/test/commandParse.test.ts` — P/B/U/M/R cases, one `it` per case; every one must
  pass unchanged. `src/test/commandPurity.test.ts`, `src/test/commandAssignments.test.ts`,
  `src/test/voiceData.test.ts` (V2 runs every generator template's sentence through the
  parser — must still pass; you do not touch the generator).
- Consumers of `Command` you must keep compiling but not change in behaviour:
  `src/lib/command/resolve.ts` (`resolveCommand` dispatches on `intent`),
  `src/features/board/components/CommandBar.tsx`, `src/lib/voice/decode.ts`,
  `scripts/voice/lib/rows.mjs` (calls `parseCommand`).

## 2. What to build

1. **A place-less removal.** In `parseUnassignRest`, an empty `placesText` (after the day
   word and the optional time clause are taken) is `place: []`, not `no_place`. Examples
   that must parse: `remove Operator A3` → `{intent:"unassign", operator:"Operator A3",
   place:[], day:null, span:null, existing:null}`; `remove Operator A3 today`; `unassign
   "Ann At Bay" from 3 to 5` (span 15:00–17:00, place []); `clear A3 tomorrow from 8 to 11`.
   Careful: `from` is both the place preposition and the time clause's word —
   `extractOptionalTimeClause` takes the LAST `from`; after it, if the operator segment is
   the whole rest, `placesText` is "" and that is the empty place. `remove` alone is still
   `empty`. `remove from Cell 1` (no operator) is still `empty` as today.
2. **A place-less move.** In `parseMoveRest`, when the text after the operator has no
   place before the destination: `move Operator A3 to 8 pm to 11 pm` → `{intent:"move",
   operator:"Operator A3", place:[], toPlace:null, day:null, span:{20:00–23:00},
   existing:null}`; `move A3 tomorrow to 8 to 11`; `reschedule A3 to 14:00 to 16:00`. A
   move with no place and a new CELL but no hours (`move A3 to Cell 2`) also parses:
   `place:[]`, `toPlace:["Cell 2"]`, `span:null` — the resolver finds the block. Decide the
   split rule carefully: today `splitMoveOperatorPlaces` looks for on/at/from; with none
   found the operator is the whole text and `placesText` is "" → today `no_place`. With
   the destination clause " to Cell 2" still inside the operator text, the operator segment
   must be split on the FIRST " to " when no on/at/from separator precedes it. Write the
   rule down in the function's comment. `no_move` stays when neither is said (`move A3`,
   `move A3 on Cell 1`).
3. **Several.** A new `Command` member `SeveralCommand { intent: "several"; commands:
   SingleCommand[] }` where `SingleCommand` is today's four-member union (keep the name
   `Command` for the full five-member union so consumers compile; add `SingleCommand` and
   use it where the inner list is typed). Lists are recognised in exactly two segments:
   the OPERATOR segment (assign, unassign, move) and the FIRST PLACE segment (assign, book),
   split on ` and ` (case-insensitive, whitespace-collapsed) OUTSIDE quotes — the sentinels
   make a quoted `"Ann and Bob"` atomic, so a plain split on the restored-quote-free text is
   right; a leading `and` or a trailing `and` or an empty item is `empty`-style failure
   `{kind:"bad_list", text}` (add it to `ParseFailure`). Also accept `, ` between operator
   names with a final `and` (`A1, A2 and A3`) — but NOTE commas already split places
   (`splitProductPlaces`), so for the FIRST PLACE segment accept only ` and `.
   Combination (R-398): n people × 1 place → n commands; 1 person × m places → m commands
   (each with `place: [thatPlace, ...qualifiers]`); n = m → pairs in order; n ≠ m with both
   > 1 → `{kind:"list_mismatch", people:n, places:m}` (add to `ParseFailure`). Every other
   field (product, qualifiers after the first place, day, start/end or span, toPlace,
   headcount, attach, existing) is copied into every inner command. A sentence with no list
   anywhere is a single command exactly as today (never a one-element several).
   `formatCommand(several)` = the inner commands' `formatCommand`s joined by `"; "`, and
   `parseCommand` of THAT string need not round-trip (a `;` is not grammar) — instead pin
   that `parseCommand(original)` deep-equals the several and each inner command round-trips
   on its own. Update the top-of-file comment and the `Command` doc.
4. **Consumers compile, unchanged in behaviour.** `resolveCommand`'s overloads: add a
   branch for `several` that returns a question `{kind:"several_unsupported", count}` with
   `describeQuestion` → `"Several commands in one sentence are read but not yet run; say them
   one at a time for now."` (the bar's confirmation of a several is the next stage; this
   keeps the bar honest meanwhile). `decode.ts`: leave as is (the model does not emit
   several yet; the data brief changes it). `CommandBar.tsx`: if a `switch` or a type guard
   needs the new member to compile, the smallest change that keeps behaviour; say what.
5. **Tests**, `src/test/commandParse.test.ts`, new `describe("commandParse: S50 no place,
   and several in one sentence")`, cases L1–L14: L1 `remove Operator A3` empty place; L2
   with a day; L3 with hours only; L4 quoted name with hours; L5 `remove` alone still
   `empty`; L6 `move Operator A3 to 8 pm to 11 pm`; L7 with a day before the destination;
   L8 `move A3 to Cell 2` (toPlace, no hours); L9 `move A3` still `no_move`; L10 the
   maintainer's sentence `assign Operator A2 and Operator A3 to Housing A on Cell 1 and
   Cell 2 in Line 1 today from 3 to 5` → several of two, pairs, every field copied, deep
   equality on the whole form; L11 two people one cell; L12 one person two cells; L13 three
   people two cells → `list_mismatch {people:3, places:2}`; L14 `"Ann and Bob"` quoted is
   one name (single command), and `A1, A2 and A3` is three; plus L15 `remove A2 and A3 from
   Cell 1` (several unassign) and L16 formatCommand of L10 joined by "; " and each inner
   round-trips. In `src/test/commandResolve.test.ts` one case RS1: a several resolves to
   the `several_unsupported` question with the count and the message verbatim.
   Run `npx vitest run src/test/commandParse.test.ts src/test/commandPurity.test.ts
   src/test/commandAssignments.test.ts src/test/commandResolve.test.ts
   src/test/commandBar.test.tsx src/test/voiceData.test.ts src/test/voiceRead.test.ts`,
   then `npx tsc --noEmit -p .`, eslint and prettier on your files.

## 3. Rules

- Files you own: `src/lib/command/parse.ts`, `src/lib/command/resolve.ts` (the one branch and
  message), `src/test/commandParse.test.ts`, `src/test/commandResolve.test.ts` (RS1), and
  `CommandBar.tsx` only if it will not compile otherwise. Not the generator, not the
  templates, not `decode.ts`, not the schema, not `docs/plan.yaml`.
- `src/lib/command/*.ts` stay free of runtime imports. No new dependencies. Do not run the
  full `npm run test`. Do not commit.
- Every P/B/U/M/R case and V2 pass unchanged. If one fails, read it and report whether it
  pinned a rule you changed; do not edit it silently.
- Report: the files with a line each, the operator-split rule you wrote for the place-less
  move in one sentence, each test title, the vitest/tsc/lint summaries, `git diff --stat`.
