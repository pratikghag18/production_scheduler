# F-152 (second half) review — break it on the maintainer's own board

Read `docs/agent-briefs/f-152-b-window-edge-brief.md`, then `git diff` of
`src/lib/command/resolve.ts`, `src/test/commandResolve.test.ts`, `src/test/commandBar.test.tsx`.
Your one job is to break it; do not fix; report.

1. **The maintainer's board, with the REAL clock helpers.** Build a context the way
   `BoardPage.tsx`'s `commandCtx` does, using `buildDayAxis`/`wallOf`/`wallToOffset` from
   `src/features/board/lib/time.ts` (not the test fakes), zone America/Chicago, a ONE-day window
   starting 2026-09-16, and these blocks from the maintainer's database (UTC): John Kim on Cell 1
   2026-09-15T07:00Z to 2026-09-16T11:00Z; Sam Patel on Cell 1 2026-09-16T14:00Z to 16:00Z.
   Expand "clear Cell 1 today", then resolve every step against the same ctx. Expected: no
   question; John's block ends at offset 0 with its start unchanged; Sam's is removed. Then do
   the same with a five-day window starting 2026-09-14 (yesterday on the board): the answer
   must be the same commands, not a re-dated move. Then a window starting 2026-09-17 (the
   block entirely before the window): "clear Cell 1 today" must say Cell 1 has nobody on it.
2. **The relaxed adjust check.** The lane made `adjust_off_day` validate only the adjusted
   edge. Try to abuse it: "end Sam at 3 today" where Sam's block is tomorrow 08:00–16:00 and
   `existing` is null (typed by a person, not the board) — does the search still find only
   today's blocks, or can the relaxed check now re-time tomorrow's block? "start Sam at 22
   today" on a block 08:00–10:00 today — `adjust_inverts` still? "end Sam at 00:00 today" typed
   by a person (not the lot) on a block 08:00–16:00 today — what happens, and is it sane?
3. **The adjust readout wording changed for EVERY adjust** ("Sam · Cell 1 · ends 15:00, was
   14:00"). Read the old text in the diff and the two re-pointed cases CB-y-3 and CB-y-11.
   Is anything else built on the old text (the trace's `ran`, an e2e spec under `e2e/`, the
   design-plan's quoted readout in §19.103)? `grep -rn "→" e2e/ src/test/ | grep -i adjust` and
   report every hit that would now fail or lie.
4. **`edgeOnBoard`'s upper bound.** `wallToOffset(lastDayIndex, 1440)` on the DST fall-back
   day (2026-11-01, Chicago, a 25-hour day): is minute 1440 the next day's 00:00 or 23:00?
   Build the axis and check; a block ending exactly at the window's last midnight must count
   as on the board.
5. **`expandCopy`'s new guard.** A copy of "Cell 1 to tomorrow" when Cell 1 holds an off-board
   leftover (John's block above) — is John's block skipped with a reason, or does it ask
   `day_off_board` and block the whole copy of the other blocks? Which did the lane choose,
   and which would a person expect? Report, do not decide.
6. **Purity and formatting**: `npx vitest run src/test/commandPurity.test.ts`; `npx prettier
   --check` on the three files.

A scratch test under `src/test/` is allowed and must be deleted before you report. Do not run
the full `npm run test`. Report each attack BROKEN (sentence, board, wrong output) or HELD,
and the one thing you would change first.
