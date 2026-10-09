# R-391 — the verbs each typed sentence accepts, one list per sentence, exported once

_Brief for one Sonnet build lane. Written 12 Sept 2026 (session 151) by the developer session.
Plan entry: `docs/plan.yaml` R-391 (uncovered) under stage S41. Background: `p1-7a-typed-command-bar-brief.md`
§4 and the four grammars' briefs; read the CURRENT `src/lib/command/parse.ts` (its verb handling:
`VERBS`, `BOOK_VERB_RE`, `UNASSIGN_VERB_RE`, `MOVE_VERB_RE` or whatever the file now names
them), `scripts/voice/lib/templates.mjs` (how templates choose a verb) and the P/B/U/MV cases._

## §1. What this is, in the product's words

The maintainer: *"The optional verb should include staff as well in addition to assign, put,
schedule, add, etc."* Shown a list per sentence, they said go with it. After this piece:

| sentence | verbs |
| --- | --- |
| assign | assign, put, schedule, add, **staff, place, allocate, give, set** — or no verb |
| book a job | book, run, **plan, open, start, launch, create** |
| unassign | unassign, remove, clear, **drop, cancel, delete, pull, free** |
| move | move, **reschedule, transfer, relocate, switch** |

Every verb belongs to exactly one sentence, so the first word never needs a guess. Not verbs
here, on purpose: "schedule" for a job (it stays with assign), "shift" (a noun everywhere in
this app), "change" (too broad), and word orders that put the verb after the person.

## §2. The rules

- **One copy.** The four lists live in `parse.ts` as exported constants
  (`ASSIGN_VERBS`, `BOOK_VERBS`, `UNASSIGN_VERBS`, `MOVE_VERBS`, readonly string arrays, lower
  case), and the regexes that decide intent are BUILT from them. The generator's templates draw
  their verb from these exports (`scripts/voice/lib/templates.mjs` imports them from
  `../../../src/lib/command/parse.ts`, the same path the oracle already uses); no template
  hard-codes a verb any more except where a template's id names one on purpose (say which).
- **Disjoint by test.** A case asserts the four lists share no word, and that none contains
  "shift" or "change" (the two the maintainer's list excluded by name).
- **Widening only.** No existing sentence stops parsing; the held-out set is NOT regenerated
  and V4 stays green. `expectedShape()` is unchanged (it shows one verb per clause).
- EDIT `parse.ts` in place; confirm `QUOTE_OPEN`/`QUOTE_CLOSE` bytes match HEAD (U+E000, U+E001).
- No change to the resolver, the bar or the board; `commandPurity.test.ts` green (an exported
  constant is not an import).

## §3. Tests

`src/test/commandParse.test.ts`:
- **PV1** one `it()` per NEW verb (staff, place, allocate, give, set; plan, open, start, launch,
  create; drop, cancel, delete, pull, free; reschedule, transfer, relocate, switch): the verb in
  front of that sentence's P1/B1/U1/MV1-shaped example parses to the same command as the
  original verb, intent included. Name each case by the verb.
- **PV2** the four exported lists are pairwise disjoint and contain neither "shift" nor "change".
- **PV3** "schedule Housing A on Cell 1 from 6 to 2" is still read as an assign sentence and fails
  `no_place` — pinned so nobody moves "schedule" to book without a decision.
- **PV4** `formatCommand` still prints the canonical verb (assign / book / unassign / move) for a
  command parsed from any synonym (round trip through the canonical form).
- **PV5** a capitalised or all-caps new verb ("STAFF Sam …") works like the old ones (case rule
  unchanged).

`src/test/voiceData.test.ts`:
- **V9** every verb in every exported list appears as the first word of at least one clean row
  in a generated training set of 2000 rows, seed 1 (so the model sees each). If a list's verbs
  are drawn uniformly this holds trivially; assert it anyway.

## §4. Mutations, on scratch copies

| id | mutation | must be caught by |
| --- | --- | --- |
| M70 | "staff" dropped from the assign list | PV1 staff |
| M71 | "plan" added to the assign list as well as book | PV2 |
| M72 | "schedule" moved to the book list | PV3 (and PV1 for schedule's existing case) |
| M73 | the generator draws only the first verb of each list | V9 |

## §5. Acceptance

`npx vitest run src/test/commandParse.test.ts src/test/commandBar.test.tsx src/test/commandResolve.test.ts src/test/commandPurity.test.ts src/test/voiceData.test.ts` — counts copied;
`npm run voice:score` still clean 200/200 (the held-out file is unchanged — assert with
`git diff --stat data/voice/heldout.jsonl` empty); `npx tsc -b --force` clean; eslint and prettier
clean on the touched files; the §4 table filled in; no full `npm run test`; no commit. Report
as the other briefs' §8, naming every verb's case.
