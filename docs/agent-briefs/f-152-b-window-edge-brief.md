# F-152 (second half) — a block that starts before the board's window

The first fix (441786c) went green and then failed on the maintainer's real board, 16 Sept
10:02 and 10:04 (the trace file's three lines): "clear Cell 1 today" still answered "1 of 2:
That is -120 minutes". Cause, read in `src/features/board/lib/time.ts`'s `wallOf`: an offset
OUTSIDE the window clamps to the nearest end's `dayIndex` (0 or `dayCount - 1`) while the
`minuteOfDay` stays the instant's real wall clock. The maintainer's window starts today; John
Kim's block starts yesterday 02:00 (offset -1320). `copyableSpan` saw start `{0, 120}` and end
`{0, 0}` (today's 00:00), called that a same-day pair, and rendered 02:00 to 00:00 on today.
Every MN pin used a builder whose window held yesterday, so none could see this. Worse: with
the clamp, `expandReplace` on that block would remove John's whole block and write Tom a
02:00 to 06:00 block TODAY — a silent, wrong write, not a question.

Two rules. You own `src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts`,
`src/features/board/components/CommandBar.tsx` and `src/test/commandBar.test.tsx`.

1. **The kept part of a partly-inside block is an EDGE ADJUST on the sentence's own day,
   never a re-dated span.** In `expandEveryoneUnassign`, the `insideStart !== insideEnd` branch
   builds a move with `adjust`: block starts outside and ends inside → `{ edge: "end", at:
   <wall clock of window.startMin on dayIndex> }`; starts inside and ends outside →
   `{ edge: "start", at: <wall clock of window.endMin> }`, DAY_END (23:59) when that edge is
   the day's own end (1440). `span: null`, `existing: { kind: "move", assignmentId }`, `day:
   dayWordForIndex(dayIndex)`. The window's edges are always on that day by construction, so
   no `wallOf` of the BLOCK's edges is needed at all — delete `remainderDayAndSpan`'s use
   there. Read the adjust resolution path (R-412, `adjust_inverts`, `adjust_off_day`) and
   confirm: (a) a prefilled `existing` is honoured (no search by day), (b) `at: 00:00` on a
   block that starts the day before yields end = that day's 00:00 with the block's own
   start kept, (c) `at: DAY_END` yields start = the next day's 00:00. If any of (a)–(c) is not
   true today, make it so in the adjust path and say what changed. The bar's readout for the
   step should read like the existing adjust readout ("John Kim · Cell 1 · ends 00:00, was
   06:00"). Item 3 (both edges outside) and item 4 (off-board) of the first brief no longer
   apply to the clear: both-edges-outside is still `split_needed`/`across_midnight` as now.
2. **Nothing trusts the clamp.** Add to resolve.ts one predicate `edgeOnBoard(offsetMin,
   ctx)`: `0 <= offsetMin && offsetMin <= ctx.wallToOffset(lastDayIndex, 1440)` where
   `lastDayIndex` is `ctx.days[ctx.days.length - 1].index` (assert `ctx.days` is non-empty in
   the comment; it always is once the bar shows). Every builder that reads a WHOLE block's
   own edges through `wallOf` — `expandReplace`, `expandSwap`, `expandSplit`, `expandAbsence`,
   `expandCopy`'s `copyableSpan` callers, and any other you find — checks both edges first. An
   edge before the window → `{ kind: "day_off_board", text: addDaysToIso(ctx.days[0].iso, -1) }`;
   after → `addDaysToIso(lastDay.iso, +1)` (the day the person must show; a block that
   pokes further out asks again after the move, which is honest). Say in a comment why the
   clamp exists (a defensive read for overnight bands) and why the resolver must never lean on
   it for a block's own edges.

Tests. The fake `wallOf` in `commandResolve.test.ts`'s builders must clamp exactly as
`time.ts` does (read `wallOf` there and mirror it, with a comment naming it), otherwise the
tests cannot see this class of bug. Then, with a ONE-DAY window that starts today (the
maintainer's board) and Chicago-shaped offsets:
MN13 John Kim -1320..360 and Sam Patel 540..660 on Cell 1, "clear Cell 1 today" → a several
of a move with `adjust {edge:"end", at 00:00}` for John (existing id, span null, day today)
and a remove for Sam; then resolve BOTH steps through `resolveCommand` against the same ctx
and assert John's resolved end is offset 0 and start -1320, no question anywhere.
MN14 a block 1320..1800 (22:00 today to 06:00 tomorrow, tomorrow off the board), "clear Cell
1 today" → adjust `{edge:"start", at DAY_END}`, resolved start = 1440.
MN15 "cover John Kim with Tom Baker" on the -1320..360 block → `day_off_board` with
yesterday's ISO; MN16 the same for a swap; MN17 for "split John Kim at 3"; MN18 the absence
form over that block; MN19 a block 0..360 (starts exactly at the window's first minute) is on
the board and a cover of it works as a plain same-day pair.
Re-run MN1–MN12 and re-point any that assumed the re-dated move (MN1, MN2, MN4 at least).
Bar: CB-mid-2 renders the lot's adjust step readout for MN13's first command.

Run `npx vitest run src/test/commandResolve.test.ts src/test/commandPurity.test.ts
src/test/commandBar.test.tsx`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/lib/command
src/features/board`, `npx prettier --check` on the four files. No commits, no plan edits.
Report: (a)–(c) as found, the builders touched under rule 2, the pins, the totals.
