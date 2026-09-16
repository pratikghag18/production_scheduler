# S61-a — the bar keeps its conversation; the day label; the lot's honest failure; the trace complete (R-424, F-153, F-154 message, F-157)

Read `docs/plan.yaml`: R-424, R-421, F-153, F-154, F-157, and the trace file the maintainer's
walk left at `data/voice/trace/bar.jsonl` (15 lines; read it, it is the evidence). You own
`src/features/board/components/CommandBar.tsx`, `src/test/commandBar.test.tsx`,
`src/lib/voice/trace.ts`, `src/test/trace.test.ts`, and in `src/features/board/BoardPage.tsx`
ONLY the render part from the `<CommandBar` element to its closing `/>` and the gate that
mounts it. Another lane edits `BoardPage.tsx`'s `commandCtx` useMemo at the same time: use the
Edit tool with small anchors, never Write the whole file, and re-read before each edit.

1. **R-424 — the bar stays mounted and keeps its state.** Find why the bar vanished twice on
   16 Sept: after "Show that day" (the window moved, the board refetched) and after a single
   assign whose write drew the board's own message. Read the mount gate (`commandCtx` is `null`
   "before the board has data, which also gates the bar off screen") and the query's
   `keepPreviousData`/`placeholderData` on a window change. The rule: the bar is gated off only
   before the board has EVER loaded; during a refetch the bar keeps the last context and its
   status, question, lot and trace entry. If the bar must remount for a reason you cannot
   remove, its state (status, pending question, lot, trace entry, input text) lives in a ref
   or store that survives the remount. Pin CB-keep-1..3: a ctx going null then back keeps the
   status and the open trace entry; Show that day's rerun keeps the entry; a pop-up opening
   from a sentence keeps the status.
2. **F-153 — the day label.** `renderReadout` builds `new Date(iso + "T00:00:00Z")` and formats
   it in the plant's zone: a day early west of UTC. Format the ISO by its parts (the repo's own
   `src/lib/format/dates.ts` exists for exactly this; read it and use it, or `formatDayLabel`
   given an instant built with `zonedTimeToInstant`), never a UTC-midnight Date read in a zone.
   Grep the bar for every other `new Date(` on an ISO day and fix each the same way. Pin CB-day-1:
   a readout carrying 2026-09-16 under America/Chicago renders "Wed Sep 16" (whatever the
   label format is), never Tue.
3. **F-154 — the lot's failure text.** `runLot` (useDragGesture.ts, not yours) stops at the
   first failure and returns `{done, error}`; `error` is the drag toast's wording and can end
   in "— reverted", which is false for a lot. In the bar: strip nothing by regex; instead the
   status after a partial lot must say what stood: `Did 3 of 4; the next failed: <error without
   the drag's revert suffix>. The 3 done stayed: <their readouts>.` Ask the other lane's owner
   (me, in your report) if the suffix cannot be separated cleanly from the message; do NOT
   edit useDragGesture.ts. Pin CB-lot-fail-1.
4. **F-157 — the trace is complete.** Every entry records: `asked` = the readout text of a
   single (the text shown before its yes) or the question or the `shape`/parse-failure message
   ("Say it like…"), whichever stood last; `answered` = the confirm word, cancel word, button
   label or Escape; `ran` as now. An entry still open when the bar unmounts, the page hides
   (`visibilitychange`), or the tab closes is flushed with `navigator.sendBeacon("/__trace",
   line)` (fall back to fetch keepalive). Pin CB-t-9..12: a single's readout and yes recorded; a
   parse failure's message recorded; a headcount's readout recorded; unmount flushes.
5. **A yes with nothing standing.** The trace shows singles with `answered: null`: read whether
   a single runs on the readout without a yes (then `asked` is the readout and `answered` is
   "auto" — say which in the report) or after a yes (then record it). Do not change the
   behaviour; record it truthfully and say which it is.

Run `npx vitest run src/test/commandBar.test.tsx src/test/trace.test.ts src/test/traceServer.test.ts`,
`npx tsc --noEmit -p tsconfig.json`, `npx eslint src/features/board src/lib/voice`, `npx prettier
--check` on your files. No commits, no plan edits. Report: the cause of each vanish, the behaviour
under item 5, the pins, the totals.
