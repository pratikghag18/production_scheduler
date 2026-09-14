# Brief S52-b: the resolver turns a shift's name into the cell's band that day

Stage S52, requirement R-402 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.99 (D128). Lane S52-a (the grammar) is committed: every single command has `shift: string
| null`; an assign/book with a shift has `start`/`end` null, a removal/move with a shift has
`span` null; the resolver answers a shift today with `shift_unsupported`. Lane S52-c (the
data) runs at the same time and owns `scripts/voice/**`, `data/voice/**`, the prompt, the
schema and `src/test/{voiceData,voiceRead,voiceTrain}.test.ts`; do not touch those.

## 1. What exists (read first)

- `src/lib/command/resolve.ts`: `ResolveContext` (~line 76: `nodeById`, `assignments`, `runs`,
  `days`, `todayIndex`, `wallToOffset`, `overlaps`, `offeredAt`, `fitsRun`, `findRunOverlap`,
  `minDurationMinutes` — every rule passed in, never copied), `resolveDaySpanStep` (day +
  ClockTime start/end → `dayIndex`, `startMin`, `endMin`, `timeText`), the four intent paths,
  the `shift_unsupported` question lane A added, `describeQuestion`, `Question`'s
  `unknown`/`ambiguous` shapes (`field: "operator"|"product"|"place"`).
- `src/features/board/BoardPage.tsx` ~line 499: `commandCtx = useMemo<ResolveContext>` — read
  every field it builds and from where; `index.templateForNode: Map<string, ShiftTemplate |
  null>` (`src/features/board/lib/boardIndex.ts` ~94/420: the nearest-ancestor pattern per
  node, the same map `useDragGesture` reads to build the pop-up's shift chips through
  `shiftChipsFor`). `ShiftTemplate { id, name, shifts: Shift[] }` in `src/lib/api/shapes.ts`
  ~712; read `Shift` (name, `startMin`, `endMin` as minutes from the day's start; an overnight
  shift like the demo's Shift 3 runs 1320→1800, past midnight).
- `src/test/commandResolve.test.ts` (`baseCtx`, `withBlocks`, `cmd()`/`bookCmd()`/
  `unassignCmd()`/`moveCmd()`, the fixture tree c1a/c2/c1b), `src/test/commandBar.test.tsx`
  (`renderBar`'s ctx), `src/test/commandAssignments.test.ts` if it builds a ctx.

## 2. What to build

1. **The context.** `ResolveContext` gains `shiftsAt(nodeId: string): { name: string; startMin:
   number; endMin: number }[]` — the bands of the pattern that applies to that node, in the
   pattern's order, empty when the node has no pattern. `BoardPage` builds it from
   `index.templateForNode` (the same map the chips use; no ancestry walk of your own). Every
   test ctx gets a default (`() => []`) and the S52 cases their own.
2. **The step.** In `resolveDaySpanStep` (or a sibling it calls first), when `command.shift`
   is non-null: resolve the day as today; take `ctx.shiftsAt(cell.id)`; empty → question
   `{kind:"no_shift_pattern", cell}` → `"Cell 1 has no shift pattern, so say the hours."`;
   match the name case-blind and whitespace-collapsed: exact name first (`"Shift 2"` ==
   `"shift 2"`), else a bare number/word matching the name's last token (`"2"` → `"Shift 2"`,
   `"night"` → `"Night"` or `"Night Shift"`), else the one band whose name contains the words;
   none → `{kind:"no_shift", text, cell, shifts: string[]}` → `"No shift called "9" on Cell 1;
   it has Shift 1, Shift 2, Shift 3."`; several → `ambiguous` with `field: "shift"` and the
   bands as candidates (`word` = the band's full name, `label` = `"Shift 2 14:00–22:00"`).
   One match → `startMin = wallToOffset(dayIndex, band.startMin)`, `endMin =
   wallToOffset(dayIndex, band.endMin)` (an overnight band's end past 1440 lands on the next
   day exactly as the board's blocks do — check `wallToOffset` accepts minutes ≥ 1440; if it
   clamps, add the day's length the way `dayAxis` does and say so), `timeText` the band's
   `"HH:MM–HH:MM"` (24:00+ shown as the board shows an overnight block — read how
   `ContextAssignment.label` is built and match it). The rest of every path (the block, the
   run, the questions, `too_short`) is unchanged. A `retime`/`move` readout's arrow uses the
   same `timeText`. Remove `shift_unsupported` and its test RS2.
3. **The bar.** `pickCandidate` for an `ambiguous` shift question substitutes `shift:
   candidate.word` (read how it substitutes operator/product/place; add the fourth field). The
   rendered question message for `ambiguous` uses `fieldWord(field)` — add `"shift"`.
4. **Tests.** `commandResolve.test.ts`, `describe("commandResolve: S52 a shift by name")`
   SR1–SR10: the demo pattern (Shift 1 360–840, Shift 2 840–1320, Shift 3 1320–1800) on c1a;
   `for shift 2` on an assign → the same resolution as 14:00–22:00 typed (deep-equal to the
   hours form's result, readout included); `shift 2`, `Shift 2`, `2` all match; `night` against
   a pattern with `Night` matches by last token; `shift 9` → `no_shift` with the message
   verbatim listing the three; no pattern → `no_shift_pattern` verbatim; two bands sharing a
   word (`Day A`, `Day B`, text `day`) → `ambiguous` field shift with both candidates, and the
   answer resolves; Shift 3 overnight → `endMin` on the next day, `timeText` as the board
   prints it; a removal `for shift 1` finds the block overlapping 06:00–14:00; a move `during
   shift 3` re-times to the overnight band. `commandBar.test.tsx` CB-shift-1: the maintainer's
   sentence `assign Operator A2 to work for shift 2 on Cell 1 in Line 1 for Housing A` reaches
   `onOpen` with range 14:00–22:00; CB-shift-2: `shift 9` shows the no_shift message. Run
   `npx vitest run src/test/commandResolve.test.ts src/test/commandBar.test.tsx
   src/test/commandAssignments.test.ts src/test/commandPurity.test.ts
   src/test/commandLauncher.test.tsx`, `npx tsc --noEmit -p .`, eslint and prettier on your
   files, then `npx playwright test e2e/roleWalk.spec.ts --workers=1`.

## 3. Rules

- Files you own: `resolve.ts`, `BoardPage.tsx` (the ctx field only), `CommandBar.tsx` (the
  shift candidate substitution and field word only), the test files named. Not `parse.ts`,
  not `decode.ts`, not the data lane's files, not `docs/plan.yaml`.
- No copy of a rule: the bands come from `ctx.shiftsAt`, which BoardPage feeds from the
  index's map; `src/lib/command/*.ts` import only types. No new dependencies. Do not run the
  full `npm run test`. Do not commit.
- Report: files with a line each; the matching rule in three sentences; the exact question
  strings; every test title; vitest/tsc/lint/roleWalk summaries; `git diff --stat`.
