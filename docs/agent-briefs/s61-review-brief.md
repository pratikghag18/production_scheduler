# S61 review — break the bar's conversation, the certificate question, the label and the lot's message

Read `docs/agent-briefs/s61-a-bar-keeps-its-conversation-brief.md`, `s61-b-training-before-the-yes-brief.md`,
the follow-up wiring described in `docs/design-plan.md` §19.105 (D134), then `git diff` (all
uncommitted work). One job: break it. Do not fix; report. Another lane is writing
`e2e/typedWalk.spec.ts` and `e2e/walk/` at the same time — do not touch those.

1. **The bar on placeholder data.** `useBoardWindow.ts` now keeps the previous window's data
   across a refetch. Between "Show that day" and the new window's arrival the bar's context is
   the OLD window's: can a sentence typed in that gap resolve against the old days and write
   onto them? Can the Show-that-day rerun fire against the placeholder (read `isTargetOnBoard`
   and `isPlaceholderData`)? Does anything else in `BoardPage.tsx` that derives from
   `boardQuery.data` (`canPlace`, `index`, the panel) now show the OLD window's rows drawn on
   the NEW window's axis for a frame — a block from Monday painted on Tuesday's column? Read
   `buildBoardIndex`'s inputs (`from`, the axis) against the placeholder's rows.
2. **The reason flow.** Drive the REAL bar in a browser (the stack is up: dev server on 5173,
   Plant A admin sign-in as `e2e/voiceBar.spec.ts` does). Type "assign Tom Baker to Housing A on
   Cell 1 from 8 to 4" (Tom holds no Welding): the question must name Welding. Type "yes" → re-asks.
   Type "covering for Sam" → the block is written; read it back through the database container
   (`docker exec supabase_db_production_scheduler psql -U postgres -d postgres -Atc "..."`):
   `eligibility_override` true and `override_reason` set. Then delete that row the same way.
   Then a swap that would put Tom on Cell 1: refused before any yes, nothing written (count the
   rows before and after). Then try to abuse: a reason that is also a cancel word ("no way"),
   a reason of only punctuation, a reason of 500 characters, Escape mid-question, and a
   second sentence typed while the question stands.
3. **The `?? 0` fix.** With the window moved so today is off the board, a day-less sentence
   asks day_off_board "today" — press Show that day: does the window come back to today and
   the sentence rerun? And a day-less sentence on a window that holds today: unchanged.
4. **The label.** In the browser, a lot's listing for a block on today names today's weekday
   under America/Chicago (compare with the board's own column header). Then read
   `renderReadout`'s new code and `zonedTimeToInstant`'s contract: a date on the DST
   fall-back day (2026-11-01) at 00:00 — any chance of the day before or a 01:00?
5. **The toast change.** `buildSchedulerErrorToast` no longer appends " — reverted."; grep
   every caller (`toast.reverted`, `toast.schedulerError`, `failWith`) and say for each whether
   the person now sees a true sentence: a drag that really snapped back must still say so; a
   create that failed must not.
6. **`answered: "auto"`.** Read the trace changes: is "auto" written ONLY when a single ran on
   its readout with nothing asked, never over a button label or a confirm word? A single whose
   readout ran and then a stray "yes" typed afterwards — what does the file say?
7. **Purity, formatting, the launcher fixture**: `npx vitest run src/test/commandPurity.test.ts
   src/test/commandLauncher.test.tsx`; `npx prettier --check` on every file in the diff.

A scratch test under `src/test/` is allowed and must be deleted before you report. Do not run
the full `npm run test`. Clean up every row you wrote. Report each attack BROKEN (sentence,
board, wrong output) or HELD, and the one thing you would change first.
