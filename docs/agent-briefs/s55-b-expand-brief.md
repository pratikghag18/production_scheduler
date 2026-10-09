# S55-b — the resolver: boundary names, the clock, and the board writing the lot (R-404, R-406 to R-410, D130)

You are lane B of S55. You own `src/lib/command/resolve.ts` and `src/test/commandResolve.test.ts`
and nothing else. Lane A has landed the types in `src/lib/command/parse.ts` (read its header and
the S55-a brief, `docs/agent-briefs/s55-a-grammar-brief.md` §1–§2, for every name: `EVERYONE`,
`ALL_DAY`, `END_OF_SHIFT`, `END_OF_DAY`, `BOUNDARY_SHIFTS`, `DAY_END`, `ReplaceCommand`,
`SwapCommand`, `CopyCommand`, `BoardCommand`, `UnassignCommand.until`, the four new `DayWord`
kinds). Read `docs/design-plan.md` §19.101 (D130) and §19.98 (D127, the lot) first, then the S49
and S52-b briefs for the house style of this file. `resolve.ts` imports only types.

Do not run the full `npm run test`; run `npx vitest run src/test/commandResolve.test.ts` and
`npx tsc --noEmit -p tsconfig.json` (errors in `CommandBar.tsx`/`BoardPage.tsx`/`decode.ts` are
lanes C and D's — list them, do not fix them). No commits, no plan edits.

## 1. `ResolveContext` grows (lane D feeds these from `BoardPage`; your tests build them)

```ts
/** D130 item 3: minutes since midnight, plant zone, on the day `todayIndex` names; null when today is off the board. */
nowMinuteOfDay: number | null;
/** The inverse of wallToOffset for a window offset: which day, and the wall-clock minute of that day. */
wallOf: (offsetMin: number) => { dayIndex: number; minuteOfDay: number };
```
`ContextAssignment` gains `runId: string | null` (the run a block is attached to; null for a direct
block). `ContextRun` gains `productName: string | null` and `headcount: number | null`. Every
existing test fixture in your file must build these (a plain `wallOf` for a non-DST window is
`{ dayIndex: floor(m/1440), minuteOfDay: m % 1440 }`).

## 2. Boundary names (R-404) — inside `resolveShiftSpanStep` and the place-less shift path

Before a shift name is matched against the pattern's bands, check it (case-insensitive, exact)
against `BOUNDARY_SHIFTS`; a band actually called "All Day" is never reached by the word, say so
in a comment.
- `ALL_DAY`: first band's start to last band's end, in the pattern's own order (`shiftsAt`); no
  pattern → `no_shift_pattern` (existing question).
- `END_OF_SHIFT` with a `start` (assign/book carry one): the end of the band whose
  `[startMin, endMin)` contains the start; none contains it → the next band that starts after it;
  none → a new question `{ kind: "no_shift_at"; cell; time: string }` ("No shift on Cell 1 covers
  10:00; it has Shift 1 06:00–14:00, …"). No pattern → `no_shift_pattern`.
- `END_OF_DAY` with a start: last band's end; no pattern → midnight (`wallToOffset(day, 1440)`).
- Either "end of" name WITHOUT a start (an assign/book that said "for the rest of the day", or any
  removal/move): when the day is today and `nowMinuteOfDay` is not null, the start is now rounded UP
  to the next quarter hour (10:07 → 10:15; 10:15 stays); on any other day, an assign or a booking
  gets a new question `{ kind: "no_start"; text: string }` ("Say when it starts — from 10, say.")
  and a removal or a move covers the whole shift/day (the band containing now is meaningless on
  another day; for END_OF_SHIFT on another day with no start use the FIRST band).
- The resulting span still goes through the minimum-duration check.
- A removal's or move's span whose `end` equals `DAY_END` (23:59) reads as midnight, 1440 — one
  helper, used everywhere a span is turned into minutes, with the comment that 23:59 is the only
  value `ClockTime` can hold for "the day's end" (D130 item 3).

## 3. `expandCommand` (R-406 to R-410) — one new exported pure function

```ts
export type Expansion =
  | { ok: true; command: SingleCommand | SeveralCommand }
  | { ok: false; question: Question };
export function expandCommand(command: Command, ctx: ResolveContext): Expansion
```
Returns the SAME object for every ordinary form (a single with an operator that is not
`EVERYONE` and `until` null; any `several`). Otherwise it reads the board and writes a `several`
of ordinary `SingleCommand`s in BOARD ORDER (`ctx.assignments`' own order, then `ctx.runs`'),
with `existing`/`attach` filled from the blocks it found so no step asks again, or a single when
only one command results. `expandCommand` never resolves the commands it writes — the bar's lot
does that with `resolveCommand`, unchanged. Its own questions, all new `Question` kinds:
- `{ kind: "lot_too_big"; count: number; max: number }` when more than `LOT_CEILING = 100`
  commands would result (R-410) — counted before building, never truncated.
- `{ kind: "nothing_to_do"; text: string }` — a plain answer, not an error: "Cell 1 has nobody on
  it 2026-09-03." / "Sam has no block from 2026-09-14 to 2026-09-18." / "Cell 1 already matches
  yesterday."
- `{ kind: "split_needed"; person: string; cell: string; block: string; span: string }` (R-407).
- `{ kind: "swap_which"; person: string; when: string; blocks: string[] }` (R-406).
- `{ kind: "day_order"; first: string; second: string }` (an `until` before the day, or a copy
  whose two sides are the same day after resolution).
Existing questions reused where they fit: `unknown` (a place or person that is not there),
`ambiguous` (a person's words matching two people — use the same `resolvePersonStep`),
`no_block`, `day_off_board`.

**How a written command names things** (the lot re-resolves each by words, so the words must
resolve to exactly one thing): the person is the operator's `employeeRef` when it is not null,
else `displayName`; the cell is `[cell.name, nearest ancestor's name]` from `nodeById` by path
(so "Cell 1" under two lines still resolves); the part is `productName`; the day is
`{ kind: "date", iso }` from `ctx.days`; hours are `ctx.wallOf` of the block's minutes. Write one
private helper for each and use them everywhere.

### 3.1 `EVERYONE` on a removal (R-407)
Place → the cells at or below it (`resolveCellStep`'s own matching, then `isAtOrBelow`-style
path prefix on `ctx.cells`; a line or area names every track cell under it); place `[]` → every
cell in `ctx.cells`. Day → `resolveDay`. Window → the span (edges as in §2), the shift (through the
cell's own pattern, per cell), or the whole day. For each block on those cells overlapping the
window, in board order: inside the window → an `unassign` with `existing: { kind: "remove",
assignmentId }` and `span` = the block's own hours; across ONE edge → a `move` with `toPlace:
null`, `span` = the part outside the window, `existing: { kind: "move", assignmentId }`; across
BOTH edges → `split_needed`, nothing built. No blocks → `nothing_to_do`.

### 3.2 `EVERYONE` on a move (R-407)
Same gathering (place, day, window). Each block → a `move` with `toPlace` = the sentence's
`toPlace` (unchanged words), `span: null`, `existing: { kind: "move", assignmentId }`. A sentence
with `toPlace === null` (a re-time of everyone) → each block → a `move` with the sentence's `span`
or `shift` and `existing` filled. The not-offered question is the lot's, per step, as R-407 says.

### 3.3 `replace` (R-406)
Person A → `resolvePersonStep`; B likewise (both must resolve; A === B → `nothing_to_do` "Sam
cannot cover for Sam"). Blocks → A's blocks on the named cell (or anywhere when `[]`) that day,
overlapping the span/shift window when one is said, else the whole day. For each: an `unassign` of
that block (`existing` filled) then an `assign` of B with the block's part, cell words, day and
hours, `attach: { kind: "run", runId }` when the block has a run, else `{ kind: "direct" }`,
`existing: null`, `shift: null`. All removals first, then all assigns. None → `no_block` (existing
question, cell null when `[]`).

### 3.4 `swap` (R-406)
Both people resolved; A === B → `nothing_to_do`. Day and window as in 3.3. Each must have EXACTLY
one block in the window: none → `no_block`; more than one → `swap_which` listing that person's
blocks as "Housing A 08:00–12:00" strings. Four commands: remove A's block, remove B's block, assign
A onto B's block (B's part, cell, hours, attach), assign B onto A's block.

### 3.5 `copy` (R-408)
`from`/`to`: a day kind → `resolveDay` (add `yesterday`: `todayIndex - 1`, off the board →
`day_off_board` "yesterday"); a week kind → the seven day indexes of that week: `this_week` = the
Monday-to-Sunday week containing today, `next_week`/`last_week` = that shifted by seven; every day
of BOTH weeks must be on the board (`ctx.days`), else `day_off_board` naming the first missing
iso. Pair source days to target days in order. Cells: the named place's cells at or below, or every
cell shown. For each pair and each cell, in board order: each run → a `book` with `productName`,
the cell words, `headcount`, the target day, the run's wall-clock hours, `existing: null`, `shift:
null`; each block → an `assign` with the person's words, the part, the cell words, the target day,
the hours, `attach: { kind: "direct" }`, `existing: null`, `shift: null`. Skip a run when the target
day already holds a run on that cell with the same product and hours; skip a block when the target
already holds a block of the same person on that cell with the same part and hours (R-408, "said
twice does nothing"). A block whose `operatorId`/`productId` is null (departed person, deleted part)
is skipped with no question. Nothing left → `nothing_to_do` ("… already matches …"). Ceiling as
above.

### 3.6 an absence with `until` (R-409)
`until` non-null on an unassign with `place: []` and `span: null`: days from `day` (resolved) to
`until` (resolved) inclusive; `until` earlier → `day_order`. Per day, per block of the person
anywhere (the S49 gathering), an `unassign` with `existing` filled, `span` = the block's hours,
`until: null`. None over all days → `nothing_to_do`. An unassign with `until` AND a place or a span
is not something the grammar produces; if it arrives, treat the place/span as narrowing each day
the same way — say so in a comment.

## 4. `resolveCommand` on the new shapes
A `BoardCommand` that reaches `resolveCommand` unexpanded (a future caller) gets a new question
`{ kind: "expand_first"; intent: string }` — never a crash, like `several_unsupported`. An
`EVERYONE` operator or an `until` on a single that reaches `resolveCommand` unexpanded: the
person lookup fails naturally (`unknown` operator "everyone"); pin that.

## 5. Tests (`commandResolve.test.ts`)
A fixture with three cells (Cell 1 and Cell 2 under Line 1, Cell 3 under Line 2), a pattern on
Line 1 (Shift 1 06:00–14:00, Shift 2 14:00–22:00) and none on Line 2, five days, today = day 1,
runs with headcounts and names, blocks direct and run-attached. Cases, one id each, at least:
- BN1–BN8: all day; end of shift with a start inside a band, between bands, after the last (the
  question); end of day with and without a pattern; no start on today (rounded up); no start on
  tomorrow (assign asks, removal covers the day); 23:59 reads as midnight; boundary word never
  matches a band called "All Day".
- EX1–EX6 everyone: clear a cell with two blocks → a several of two removals in board order with
  existing filled; a line → every cell under it; after 14:00 with a straddling 08:00–16:00 block →
  a move to 08:00–14:00; a block across both edges → split_needed; nobody → nothing_to_do; move
  everyone on Line 1 to Cell 3 → moves with existing filled.
- RP1–RP4 replace: one block direct → remove + assign direct; one block in a run → attach run; two
  blocks → four commands, removals first; Sam with Sam → nothing_to_do.
- SW1–SW3 swap: one each → four commands crossed; two for one person → swap_which; none → no_block.
- CP1–CP6 copy: a day onto a day for one cell (runs become bookings with headcount, blocks
  direct assigns); already there → skipped; everything there → nothing_to_do; week onto week
  pairs Monday to Monday; a week off the board → day_off_board; over the ceiling → lot_too_big
  with the count.
- AB1–AB3 absence: three days, two blocks on two of them → two removals; until before the day →
  day_order; nothing → nothing_to_do.
- PT1–PT2: an ordinary command and a several come back as the same object.
Every existing case stays green unless a contract changed; write why beside any re-pin.

## 6. Report
The new question kinds with their message-worthy fields (lane D writes the sentences); the ctx
fields you added and what your fixture feeds them; anything in D130 you could not do and why; the
file's case count before and after; tsc errors outside your files.
