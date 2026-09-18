# S66-c — a person belongs to a shift: the board (R-448, with R-438 and R-441)

Read R-448 (its claim and both DECIDED notes), R-438, R-441, R-446, R-447 in `docs/plan.yaml` and
CLAUDE.md §4 ("Ask where and how before placing anything new on a screen" — every placement below is the
maintainer's own answer; build it exactly, and if something is still unspecified, STOP and report the
question rather than guess) and §7 (the plant's zone is the one clock; every button in one group is the
same size). Then `src/features/board/components/OperatorPanel.tsx` and its stylesheet (the two-line chip,
the here/elsewhere split, the width drag), `src/features/board/lib/railWords.ts` (`bookingWords`,
`rootBand`: the interim whole-span band the person's own band now replaces), `src/lib/api/shapes.ts`
(`BoardOperator.homeShiftId`, the payload's `shift_templates`/`node_shift_map`, and `me`),
`src/features/board/lib/boardIndex.ts` (`templateForNode`), `src/features/board/components/AssignmentChip.tsx`
and `DirectBlock.tsx` (the chip's name line and title), `src/lib/api/shapes.ts` for the write envelope's
`shift` (S66-a: `{fit, band, overtime_minutes}`), and `src/features/board/BoardPage.tsx` where
`<OperatorPanel` is rendered.

You own `OperatorPanel.tsx` and its stylesheet, `railWords.ts`, a new pure `src/features/board/lib/shiftNow.ts`
(+ test), `AssignmentChip.tsx`/`DirectBlock.tsx` and their stylesheets for the OT tag only, `src/test/operatorPanel.test.tsx`,
`src/test/railWords.test.ts`, `src/test/directBlockAndChip.test.tsx`, and the `<OperatorPanel` render in
`BoardPage.tsx` ONLY (another lane edits BoardPage's writer props at the same time — touch nothing else
there; a third lane edits the admin panels). No commits, no docs edits, no full `npm run test`, no
playwright; never `db:reset`.

1. **The rail shows the people on shift now.** `shiftNow.ts`: pure, `bandCoveringNow(template, now, zone)`
   returns the band of the root's pattern whose window (start_min..end_min, a night band wrapping past 1440)
   covers the plant's clock now — `partsInZone(now, zone)` for the minute of the day, never `getHours()`
   (R-426; pin both sides of midnight and a night band, west and east of UTC with a frozen clock). The rail
   lists, by default, the people whose `homeShiftId` names that band (matched by id, else by name ignoring
   case against the root's pattern, R-443's rule); people with no shift are listed too, at the end, with
   their "No shift" words. `now` comes from the board's own clock (the same source the board's "today" uses;
   find it — do not add a second `new Date()` outside the seam), refreshed each minute.
2. **The shift chips (option B).** Under the rail's "Operators" heading, a row of chips, one per band of the
   root's pattern, in band order: the one on now is filled (the launcher button's `--ink` on `--avatar-fg`,
   the app's one filled look), the others outlined; clicking an outlined chip adds that shift's people to
   the list (they stay until clicked again), clicking the filled one on now does nothing (it is always
   shown). R-447: the chips share one width — a CSS grid: two bands → two columns, three → three, four →
   a 2×2 matrix (`grid-template-columns: repeat(2, minmax(0, 1fr))`), five or more → two columns wrapping;
   `aria-pressed` on each chip; the heading says which are showing ("On shift now: Shift 2" / "Showing:
   Shift 2, Shift 3"). Smooth: the chip's fill and the list's rows transition (a `transition` on
   background/colour of ~150ms; rows added or removed fade rather than jump — `@media (prefers-reduced-motion)`
   turns both off). No shift name on a person's chip (R-448).
3. **The words against the person's own band.** `bookingWords` takes the person's band (their home band by
   id or name), else the interim whole span as today; RW pins updated and RW-8 added (a person on Shift 2
   booked 14–22 reads "booked"; on Shift 1 with nothing reads "free").
4. **The OT tag.** A block whose envelope or index says it is outside the person's own band (compute from
   the person's band and the block's range in the plant's zone, the same arithmetic as the server's
   `app_shift_overtime_minutes` — transcribe its rule, do not invent; where the client cannot know, show
   nothing) carries a small "OT" tag inside the chip beside the name, in the board's amber signal token
   (`--signal-warn`), with "overtime, N min" in the chip's title. Pin DC-ot-1..3 (in, overtime, no band →
   no tag). Nothing else on the block changes.

Then `npx vitest run src/test/operatorPanel.test.tsx src/test/railWords.test.ts src/test/shiftNow.test.ts
src/test/directBlockAndChip.test.tsx src/test/dateSeam.test.ts src/test/scaleAudit.test.ts src/test/fieldStandard.test.ts`,
`npx tsc -b` (ignore the two other lanes' files), `npx eslint src/features/board src/test`, `npx prettier --check`
on your files, and a throwaway playwright script (deleted after; Dana, as e2e/typedWalk.spec.ts signs in) to
screenshot the rail with the chips at rest and after one chip is toggled, to `test-results/s66-c-rail.png`
and `test-results/s66-c-rail-toggled.png`; no writes. Report: the pins, the cases changed with reasons,
the runners' totals verbatim, the screenshot paths, and — most important — anything the brief left
unspecified that you had to decide: name each plainly, the maintainer wants to be asked.
