# F-152 review — break the midnight-remainder fix

Read `docs/agent-briefs/f-152-midnight-remainder-brief.md` first, then the follow-up the lane
was sent afterwards (a replace or swap on a night-shift block must work through the shift
form, not refuse). Then `git diff src/lib/command/resolve.ts src/test/commandResolve.test.ts`.
Your one job is to break it. Do not fix anything; report.

Attack in this order, each with a concrete sentence and a concrete board:

1. **The arithmetic under a real zone.** The tests' builders use a fixed zone; the maintainer's
   plant is America/Chicago. Build a context whose window crosses the DST end (1 Nov 2026,
   Chicago) and put a block from 22:00 on the 31st to 06:00 on the 1st. Does `remainderDayAndSpan`
   date and clock it right when the day has 25 hours? `wallToOffset`/`wallOf` are the only
   allowed arithmetic (the comment on `ResolveContext.wallToOffset` bans `dayIndex * 1440`);
   grep the diff for any `1440` or `24 * 60` used as a day length and say whether each is a
   clock (fine) or a day length (a bug).
2. **The lot runs against an unwritten board.** `resolveLotStep` resolves every step of a
   several against the same `ctx` (see the S58-e comment near the split builder). For the
   John Kim case the several is a move (the kept part) plus a remove: does the second step
   still find its block after the first is resolved but not written? And the reverse order.
3. **Replace on Shift 3 end to end.** With the follow-up applied: "cover Sam with Tom" where
   Sam's block is exactly Shift 3 on a cell whose pattern is A's 3 x 8h. Walk the built
   several through `resolveLotStep` by hand in a test: does the assign with `shift: "Shift 3"`
   resolve to the same `startMin/endMin` as Sam's block, attached to the same run? Then a
   block that is Shift 3 minus 30 minutes (someone left early): no band matches — what does
   the person see, and is the `split_needed` text honest about why?
4. **`expandAbsence`'s dedupe.** The lane added a `seen` set because a block spanning two
   per-day windows was removed twice. Find a block that spans THREE windows (a 30-hour
   leftover) and one that touches a window only at its edge (ends exactly at 00:00): once
   each, never zero, never twice.
5. **The off-board day.** MN4 pins `day_off_board` with an ISO. Press "Show that day" in your
   head: the bar reruns the SAME sentence ("clear Cell 1 today") on a window that now holds
   yesterday — does "today" still mean the 16th on that window (`ctx.todayIndex`), and does the
   kept part now build? Read `CommandBar.tsx`'s rerun (`pendingRerunRef`, `isTargetOnBoard`)
   and say whether the target day the question names is the one the button moves to.
6. **The split builder.** A block from yesterday 22:00 to today 06:00, "split Sam at 2" (02:00
   today): both halves — 22:00–DAY_END dated yesterday and 00:00–02:00 / 02:00–06:00 dated
   today? Or refused? Whichever it is, is it what a person would expect, and is it pinned?
7. **Every pin's expected number.** The brief said pins derive spans from the builder's own
   `wallToOffset`, never a hand-summed number. Check each MN pin; a literal like `1560` or
   `-120` in an expectation is a finding.
8. **Formatting and purity.** `npx vitest run src/test/commandPurity.test.ts` and `npx
   prettier --check src/lib/command/resolve.ts src/test/commandResolve.test.ts`.

Do not run the full `npm run test`. Do not edit the two owned files; you may add a scratch
test file under `src/test/` to prove a break and must delete it before reporting. Report
each attack as BROKEN (with the failing sentence, board and the wrong output) or HELD, and
the one thing you would change first.
