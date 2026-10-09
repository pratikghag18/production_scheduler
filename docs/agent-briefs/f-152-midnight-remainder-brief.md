# F-152 — clearing a day keeps the wrong part of a block that crosses midnight

What the maintainer saw, 16 Sept (session 175), typing into the real bar on Plant A (zone
America/Chicago): "clear Cell 1 today" answered

    1 of 2: That is -120 minutes; a block is at least 15 minutes.

John Kim's block on Cell 1 ran from 15 Sept 02:00 to 16 Sept 06:00 (a leftover from the
first walk). "Today" is the 16th. `expandEveryoneUnassign` (`src/lib/command/resolve.ts`,
the loop over `ctx.assignments` near line 2953) sees the block start outside today's window
and end inside it, so it keeps the outside part as a `move` with `existing: {kind: "move"}`.
The outside part runs from the block's start (15th 02:00) to `window.startMin` (16th 00:00).
`hoursOfBlock` renders both ends as bare clocks — 02:00 and 00:00 — and the command is dated
`dayWordForIndex(dayIndex)`, the 16th. `resolveDaySpanStep` then reads 02:00 to 00:00 on the
16th as a negative span and asks `too_short` with -120. Never a crash, never a sane question.
The realistic case is every night shift: Shift 3 is 22:00 to 06:00 on all three demo plants,
so "clear Cell 1 today" the morning after a night block always hits this.

You own `src/lib/command/resolve.ts` and `src/test/commandResolve.test.ts`. Read
`expandEveryoneUnassign`, `copyableSpan` (near line 3496 — it already converts a real span
into a same-day clock pair with DAY_END for a midnight end and `null` for "not representable";
reuse it or factor the shared piece out, do not copy it), `dayWordForIndex`, and the
`split_needed` and `day_off_board` questions.

1. **The kept part is dated by the day it starts on**, `ctx.wallOf(keptStart).dayIndex`, not
   by the day the sentence named. An end that falls exactly at 00:00 of the following day is
   written as DAY_END (23:59, F-146's shape). So John Kim's kept part becomes a move dated the
   15th, 02:00 to DAY_END, which `resolveDaySpanStep` already reads as 02:00 to midnight.
2. **The other direction too**: a block that starts inside today and ends tomorrow morning
   (a night shift started today, cleared today) keeps `window.endMin` (today 24:00) to the
   block's end (tomorrow 06:00): a move dated tomorrow, 00:00 to 06:00.
3. **A kept part that itself crosses into a later day's daytime hours is not representable**
   (a block from yesterday 22:00 to tomorrow 02:00, cleared today, keeps two pieces). Ask the
   existing `split_needed` question for it — the same one the both-sides case just below
   already asks — never a guess and never a skip that silently loses the block.
4. **A kept part whose day is not on the board**: `dayWordForIndex` finds no `ctx.days` row
   and writes `iso: ""`. Instead, return the `day_off_board` question naming that date's ISO
   (the shape R-419's "Show that day" button already answers) — the person moves the board
   and says the sentence again. Pin that the question's `text` is the date, not "".
5. **Look for the same shape elsewhere.** Grep the file for every place a block's REMAINDER
   is rendered with `hoursOfBlock` or `clockOfOffset` onto a `dayWordForIndex` day: the
   single-person partial removal ("unassign Sam from Cell 1 from 8 to 12" keeping the rest),
   the `until` form, `expandEveryoneMove` (near 3036 — it passes the sentence's own span, so
   probably untouched; say so either way), the split builder near 3838 (already handles a
   `dayEnd` end — read it and say whether a block that STARTS on the previous day is safe
   there). List each site in your report with "same bug, fixed" or "safe, because…", and fix
   every one that has it the same way, with a pin each.

Pins in `commandResolve.test.ts`, named MN1 onward, on a context whose window holds at least
three days (the file's existing multi-day builders — the ones EX6 and the `copyableSpan` cases
use — already have `wallOf`/`wallToOffset` over several days; reuse them):
MN1 the John Kim case (yesterday 02:00 to today 06:00, clear today) → one `several` of two:
a move dated yesterday 02:00–DAY_END with `existing.kind === "move"`, and the other block's
remove; MN2 today 22:00 to tomorrow 06:00, clear today → a move dated tomorrow 00:00–06:00;
MN3 yesterday 22:00 to tomorrow 02:00 → `split_needed`; MN4 the kept day off the board →
`day_off_board` with the ISO date; MN5 a block wholly inside today is unchanged (remove, dated
today); MN6+ one per extra site you fix under item 5. Every pin's expected span must be
derived from the builder's own zone arithmetic (`wallToOffset`), never a hand-summed number.

Run `npx vitest run src/test/commandResolve.test.ts src/test/commandPurity.test.ts
src/test/commandBar.test.tsx`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/lib/command`.
No commits, no plan edits, do not touch any other file. Report: the sites found under item 5
with their verdicts, the pins, the counts.
