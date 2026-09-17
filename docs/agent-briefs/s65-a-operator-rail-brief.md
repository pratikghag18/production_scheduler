# S65-a — the operator rail: two lines per person, free/booked in words, and a rail that drags wider (R-438, R-439)

Read R-438, R-439 (both with their DECIDED lines) and R-038 in `docs/plan.yaml`, and CLAUDE.md §4 and
§7 (the standards: the plant's zone is the one clock — every minute you compute is in the plant's zone
through the seams named there; a new date site that fails `dateSeam.test.ts` is wrong, not the audit).
Then `src/features/board/components/OperatorPanel.tsx` (props at ~33–70, `chip()` ~167–204,
`isFullyAllocated` at ~169, the absent set ~114–120, the here/elsewhere split ~129–137, the titles memo
~148–165), `OperatorPanel.module.css`, `src/features/board/lib/geometry.ts:450-473` (`isFullyAllocated`),
`src/features/board/lib/boardIndex.ts` (`templateForNode` ~94/416–422 — the root's shift pattern),
`src/lib/api/shifts.ts:127-134` (`ShiftRow`, `endMin` may exceed 1440), `src/features/board/BoardPage.tsx`
~197 (`operatorPanelOpen`), ~526–540 (the once-only auto-collapse), and where `OperatorPanel` is rendered;
`src/features/board/lib/panelSize.ts` (S63's, on disk uncommitted: `clampPanelSize`, `readPanelSize`,
`writePanelSize`, `MIN_PANEL_*`), `src/test/absenceOnBoard.test.tsx:374-410` (R-038a–d, which pin
TODAY's chip), and `e2e/linePeople.spec.ts`.

You own: `OperatorPanel.tsx`, `OperatorPanel.module.css`, a new pure `src/features/board/lib/railWords.ts`
(+ `src/test/railWords.test.ts`), a new `src/test/operatorPanel.test.tsx`, the R-038 block in
`absenceOnBoard.test.tsx`, and the smallest possible edit to `BoardPage.tsx` (the rail's width prop and
its persistence; another lane touches BoardPage's toolbar props at the same time — keep your edit to the
`OperatorPanel` render and the width state, nothing else) and `BoardPage.module.css` / `tokens.css` only
if `--rail-w` must become a variable the width sets. `panelSize.ts` belongs to S63: READ it and reuse
`clampPanelSize`/`readPanelSize`/`writePanelSize` with your own storage key prefix; if its API does not
fit (it is a width+height pair), wrap it in `railWords.ts` or a tiny `railWidth.ts` of your own rather
than editing it. Do not run the full `npm run test`; do NOT run playwright (the dev server is shared
with another lane's e2e runs; the developer runs the role walk after both land); no commits; no docs
edits; ignore `tsc` errors in files you do not own.

1. **R-438 — two lines, and the words.** Line one: the avatar and the NAME alone, never truncated
   (`white-space: nowrap; overflow: visible` on the name; the rail's width is the person's, R-439).
   Line two: up to TWO skill badges, ordered by the skills the cell requires first when a cell is the
   drag target (the panel already knows `skillById`; if the required-skill order is not available to
   the panel today, order by name and say so in the report), then "+n" for the rest with a `title`
   naming them; and on the right the booking words. The count pill and the "full" dimming go (R-038b
   and R-038d are the cases that pinned them: rewrite them to the new contract and say so in the file,
   R-438 supersedes R-038 when this ships). Keep "not from this area" and "on leave" as they are.
2. **The words, pure.** `railWords.ts`: `bookingWords(blocks, window, band, zone)` returning
   `"free" | "free 11:30" | "booked"`. `band` is the board ROOT's shift pattern's band covering the
   window's day (DECIDED on R-438: `templateForNode.get(rootId)`, the source the shift chips use), in
   the plant's zone; with no pattern on the root, the window itself. "free" when the person has no
   block inside the band; "free HH:MM" when they have blocks and the first uncovered minute inside the
   band is HH:MM (the band's start when the first block starts later; the minute after their last block
   otherwise); "booked" when the band is covered end to end. A night band (`endMin > 1440`) wraps into the
   next day. Times through `partsInZone`, never `getHours()`. Pin RW-1..RW-6 including a night band and a
   window west and east of UTC with a frozen clock (R-426's rule).
3. **R-439 — drag wider, remember.** The rail's right edge is a handle (pointer events, like S63's);
   width clamped to [190px × ui-scale, 480px]; remembered per person through `panelSize`'s
   storage with your own prefix and the same `historyKey`-style key BoardPage already derives for S63
   (user id + root path; read how `CommandLauncher` is given `historyKey` in BoardPage and reuse that
   value); restored on open and after the once-only auto-collapse; collapse/reopen returns to the
   chosen width. The grid reflows (the rail's width changes the available width; `computeFitScale`
   takes heights only — confirm and say so). Pin OP-1..OP-4: a drag changes the width, the width is
   remembered and restored, collapse then reopen keeps it, the clamp both ways.

Then `npx vitest run src/test/operatorPanel.test.tsx src/test/railWords.test.ts src/test/absenceOnBoard.test.tsx
src/test/dateSeam.test.ts src/test/scaleAudit.test.ts src/test/fieldStandard.test.ts`, `npx tsc -b` (report
"inconclusive" for files you do not own), `npx eslint src/features/board src/test`, `npx prettier --check`
on your files. Report: the pins, every R-038 case changed with its reason, the runners' totals verbatim,
what you reused from `panelSize.ts` and how, the exact BoardPage lines you touched, and anything the
brief got wrong.
