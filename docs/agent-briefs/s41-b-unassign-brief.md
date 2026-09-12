# S41-b — "Unassign Sam from Cell 1 in Line 1 from 10 to 2": the typed UNASSIGN command

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 145)
by the developer session from the tree after S41-a (book a job) landed. Second of the three
commands the maintainer ordered after assign (session 139: book a job, unassign, move). Stage
S41; requirement R-388. Background, in this order: `p1-7a-typed-command-bar-brief.md` §2 and
§5, `f-132-the-bar-sees-your-own-block-brief.md` §2, and `s41-a-book-a-job-brief.md` §2–§3 —
the shapes this brief extends are the ones S41-a built (`Command`, the shared parse and resolve
steps, the four bar callbacks). Read the CURRENT `parse.ts`, `resolve.ts` and `CommandBar.tsx`
before writing a line; this brief names identifiers, never line numbers._

## §1. What this is, in the product's words

A scheduler types *"Unassign Sam from Cell 1 in Line 1 from 10 to 2"* and the board removes
Sam's block there — the same removal the block's own Delete button does, nothing else. Because
a removal cannot be undone and a sentence can be misheard, the bar never deletes on Enter: it
names the block it found — *"Remove Sam Patel's Housing A block on Cell 1, 10:00–14:00?"* — and
one press of that button removes it. With no hours, the sentence means every block of that
person's on that cell that day, each offered as its own button. A person with no block there
is told so. (The developer session's call, flagged for the maintainer: R-384's "Enter does it
when there is nothing to decide" is for creating; for deleting, the one button IS the thing to
decide.)

## §2. ⛔ THE RULES, unchanged

- No second door. The removal is `dragApi.removeAssignment(assignmentId)` — the SAME action the
  assignment pop-up's Delete button calls (`onDelete={dragApi.removeAssignment}` in
  `BoardPage.tsx`), which goes through `deleteAssignment` and its written-row check. No new
  `mutate(` call; `CommandBar.tsx` imports nothing from the API; the purity audit stays green.
- The resolver holds no rule: overlap is the passed-in `overlaps`; the person, cell and day
  steps are the shared helpers S41-a extracted (`resolveCellStep`, `resolveDaySpanStep`) plus
  a person step you extract from `resolveAssignCommand` the same way (`resolvePersonStep`),
  leaving the assign path byte-identical in behaviour.
- Never guess: two matching blocks are two buttons; none is a sentence saying so.

## §3. The shapes — exact

### `parse.ts`

```ts
export interface UnassignCommand {
  intent: "unassign";
  operator: string;           // words, never an id
  place: string[];            // most specific first, at least one
  day: DayWord | null;
  /** null when the sentence gave no hours: the whole day. */
  span: { start: ClockTime; end: ClockTime } | null;
  /** The pressed button's answer; null until asked. */
  existing: { kind: "remove"; assignmentId: string } | null;
}
export type Command = AssignCommand | BookCommand | UnassignCommand;
```

**Grammar.** The first word decides the intent: `unassign`, `remove` or `clear` → unassign
(`book`/`run` → book; the rest → assign, as today).

```
(unassign | remove | clear)  <operator>
   (from | off | on | at)  <place>  { (in | on | at | ,)  <place> }
   [on <day>]
   [from <time>  (to | - | – | until | till)  <time>]
```

The time clause is OPTIONAL here, and `from` is also the place word, so: take the LAST `from`;
if the text after it parses as `<time> <sep> <time>`, that is the time clause; otherwise there
is no time clause and the whole sentence is the middle. (P-case P13's `no_time` stays the
assign path's answer; the unassign path never returns `no_time`.) Then the day word as today,
the verb, and the middle split on the FIRST ` from ` / ` off ` / ` on ` / ` at ` into operator
and places; the places split as today. Empty operator → `empty`; no place → `no_place`.
`formatCommand` prints `unassign <person> from <cell> [in <line>] [on <day>] [from HH:MM to HH:MM]`.
`expectedShape()` gains a third clause: `— or: unassign <person> from <cell> [in <line>] [on <day>] [from <time> to <time>]`
(update every assertion of that sentence and say the contract changed).

### `resolve.ts`

`ContextAssignment` gains `productName: string | null` (the effective part's name, built in
`commandAssignments` from `index.productById` the same way its id is; null when unknown).

```ts
export interface ResolvedUnassign {
  intent: "unassign";
  assignmentId: string;
  /** "Removing Sam Patel's Housing A block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00" */
  readout: string;
}
```
`Resolution`'s `resolved` widens to `ResolvedCommand | ResolvedBook | ResolvedUnassign`;
`resolveCommand` gains the overload.

`Question` gains:
```ts
  /** R-388: the blocks the sentence names, each a button; `same` is irrelevant here. */
  | { kind: "remove_which"; person: string; cell: string; when: string; blocks: Candidate[] }
  | { kind: "no_block"; person: string; cell: string; when: string }
  | { kind: "block_gone_remove"; person: string; cell: string }
```
`when` is `"HH:MM–HH:MM"` when the sentence gave hours, else `"<ISO day>"` — the bar renders an
ISO day through `formatDayLabel` as it does the readout's (extend `renderReadout`'s use to the
question text: the same `ISO_DAY` replace, applied to the question message too).

The unassign path: 1 cell (shared), 2 person (extracted, shared), 3 day (shared `resolveDay`)
and span: with hours, `resolveDaySpanStep` as the others; without, the whole day —
`startMin = ctx.wallToOffset(dayIndex, 0)`, `endMin = ctx.wallToOffset(dayIndex, 24 * 60)`
(read `dayAxis.wallToOffset` in `boardIndex.ts` first: if it does not accept minute 1440,
use the next day's minute 0 and, on the window's last day, `days.length * 1440` — say which
you did); the minimum-duration check does not apply. 4 the blocks:

```ts
  const hits = ctx.assignments.filter((x) => x.nodeId === cell.id && x.operatorId === operator.id && ctx.overlaps({ startMin, endMin }, x));
  if (command.existing === null) {
    if (hits.length === 0) return ask no_block;
    return ask remove_which (blocks: hits, label `${x.productName ?? "block"} ${x.label}`, word "");
  }
  const hit = hits.find((x) => x.id === command.existing.assignmentId) ?? null;
  if (!hit) return hits.length > 0 ? ask remove_which : ask block_gone_remove;
  resolved = { intent: "unassign", assignmentId: hit.id, readout };
```

`describeQuestion`, verbatim:
```
remove_which, one:   "Remove <person>'s <productName> block on <cell>, <label>?"
remove_which, many:  "<person> has <n> blocks on <cell> <when>. Remove which?"
no_block:            "<person> has no block on <cell> <when>."
block_gone_remove:   "That block of <person>'s on <cell> is already gone."
```
Button labels for `remove_which`: one block → `Remove it`; many → `Remove <productName> <label>`
each. `no_block` and `block_gone_remove`: no buttons.

### `CommandBar.tsx`

One new prop `onUnassign(resolved: ResolvedUnassign, anchor)`. `runCommand` dispatches on
`intent === "unassign"`. `pickExisting` widens for the unassign answer. The readout after the
press is the resolved readout (a "Removing …" line); the status line is cleared by the next
edit as today.

### `BoardPage.tsx`

`onUnassign={(resolved) => dragApi.removeAssignment(resolved.assignmentId)}`. Nothing else;
`commandAssignments` gains `productName`.

## §4. Files — exclusive to the build lane

`src/lib/command/parse.ts`, `src/lib/command/resolve.ts`,
`src/features/board/components/CommandBar.tsx`, `src/features/board/lib/commandAssignments.ts`,
`src/features/board/BoardPage.tsx`, and tests `src/test/commandParse.test.ts`,
`src/test/commandResolve.test.ts`, `src/test/commandBar.test.tsx`,
`src/test/commandAssignments.test.ts`. `commandPurity.test.ts` unchanged and green. No change to
`useDragGesture.ts` or `CreatePopover.tsx`; if one seems needed, stop and say why.

## §5. Tests

`commandParse.test.ts` (U-cases): U1 `Unassign Sam from Cell 1 in Line 1 from 10 to 2` → operator
`Sam`, place `["Cell 1","Line 1"]`, day null, span 10:00–14:00, existing null. U2 `remove Sam
from Cell 1` → span null. U3 `clear Sam off Cell 1 on tomorrow` → day tomorrow, span null. U4
`unassign Sam from Cell 1 from 10 to 10:75` → `bad_time` `10:75`. U5 `unassign from Cell 1 from
10 to 2` → `empty`. U6 `unassign Sam from 10 to 2` → `no_place`. U7 `formatCommand` round-trips
U1 and U2. U8 `expectedShape()` is the exact three-clause sentence. U9 `assign Sam to Housing A
on Cell 1 from 10 to 2` and `book Housing A on Cell 1 from 6 to 2` still parse as before
(regression pins for the first-word rule).

`commandResolve.test.ts` (RU-cases; fixture blocks from R34's `blk1` etc., now with
`productName`): RU1 U1's sentence with `[blk1]` → `remove_which`, verbatim `"Remove Operator 1's
Housing A block on Cell 1, 10:00–14:00?"`, one candidate `blk1` labelled `Housing A 10:00–14:00`.
RU2 answer `remove blk1` → ok, `assignmentId "blk1"`, readout `"Removing Operator 1's Housing A
block · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 10:00–14:00"`. RU3 no hours with
`[blk1, blk2]` → `"Operator 1 has 2 blocks on Cell 1 2026-09-03. Remove which?"`, both
candidates in board order. RU4 no hours, `[]` → `no_block` verbatim `"Operator 1 has no block on
Cell 1 2026-09-03."`; with hours → `"… on Cell 1 10:00–14:00."`. RU5 hours 14:00–16:00 with
`[blk1]` (touching) → `no_block`. RU6 another person's / another cell's block asks nothing but
`no_block`. RU7 stale answer `remove "blk9"` with `[blk1]` → `remove_which` again; with `[]` →
`block_gone_remove` verbatim. RU8 the assign path's R1 and R34 and the book path's RB1 and RB3
still produce byte-identical results (regression pins for the person-step extraction).

`commandBar.test.tsx` (CU-cases): CU1 U1's sentence with `BLK1` shows RU1's text and one
button `Remove it`, calls nothing. CU2 pressing it calls `onUnassign` once with `blk1`, the
input unchanged, readout shown; `onOpen`/`onRetime`/`onBook` never called. CU3 no-hours
sentence with two blocks shows two buttons labelled with part and hours; CU4 the ISO day in a
question is rendered through `formatDayLabel` (the sentence shows `3 Sep 2026`, not the ISO).

`commandAssignments.test.ts`: A5 the direct block carries its product's name; A6 the run-attached
block carries its run's product's name; A7 an unknown product carries null.

## §6. Mutations — apply each on a scratch copy; record what went red

| id | mutation | must be caught by |
| --- | --- | --- |
| M40 | intent by any verb (`remove` → assign) | U1, U2 |
| M41 | a missing time clause returns `no_time` | U2 |
| M42 | the person filter dropped | RU6 |
| M43 | resolve with one hit returns ok without asking | RU1, CU1 |
| M44 | stale answer removes the first hit instead of re-asking | RU7 |
| M45 | `onUnassign` routed through `onOpen` | CU2 |
| M46 | whole-day span uses `dayIndex * 1440` instead of `wallToOffset` | a DST case in the shape of the assign path's R25–R26 (use `wallToOffsetDst`) |

## §7. Acceptance, in order

1. `npx vitest run` on the four test files plus `commandPurity.test.ts` — counts copied.
2. `npx tsc -b --force` clean; `npx eslint` and `npx prettier --check --end-of-line auto` on every touched file clean.
3. The §6 table filled in.
4. No full `npm run test`; no commit; no browser claims.

## §8. Report — as S41-a's §8.

## §9. The review lane

Break it: (1) §2 against the diff — no new `mutate(`, `CommandBar.tsx` imports nothing from the
API, `resolveAssignCommand` and `resolveBookCommand` unchanged in behaviour (P1–P24, B1–B11,
R1–R44, RB1–RB11 green). (2) Apply M43, M44 and M45 on scratch copies; confirm the named cases
go red; restore from your copies. (3) Live as Dana (`dana@example.test` / `devpassword`,
http://localhost:5173, Playwright chromium from the repo's `node_modules/playwright/index.mjs`
by file URL; the dev server is expected up): create one block by sentence on a clean day and
cell (`Assign Operator A3 to Housing A on Cell 3 in Line 2 from 10 to 2`, Enter creates), then
`Unassign Operator A3 from Cell 3 in Line 2 from 10 to 2` — the question names the block, one
`Remove it` button, nothing written yet (one row in the database); press it — the chip is gone
and the database has zero rows for that person that day; then type the same unassign sentence
again — `no block` sentence, no buttons. Screenshots `unassign-01…` to
`C:\Users\prati\.claude\jobs\0586b6d2\tmp\`. Write nothing else. (4) Report as before, with one
closing sentence.
