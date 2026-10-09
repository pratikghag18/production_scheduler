# Review brief: S194-B, the resolver lane -- one job: break it

You are a reviewer, not the author. Lane B changed `src/lib/command/resolve.ts` and
`src/test/commandResolve.test.ts` for DEF-0046, DEF-0047, DEF-0043 (resolver half) and DEF-0044
items 2, 5, 6. Its brief is `docs/agent-briefs/s194-b-resolver-brief.md`; read it, then the four
defect files it names, then `git diff -- src/lib/command/resolve.ts src/test/commandResolve.test.ts`.
The main session re-ran the pins: they are green. Green pins are where you START, not evidence.

Two other lanes are still editing other files in this working tree (screens, scripts, seed, e2e).
Ignore their files and any `tsc` error in them. Do not commit. Do not run the full `npm run test`.
Do not run `npm run db:reset`. Do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`.
PowerShell runs npm and npx here (no `&&`). Never `git checkout -- <file>`; never patch with
`Get-Content`/`Set-Content`.

## What you may write

- New cases in ONE new file, `src/test/s194bReview.test.ts`, built the way
  `src/test/defects/DEF-0047.test.ts` builds its fixture (the REAL board axis, `buildDayAxis` /
  `wallOf`). A case that goes red is a finding; leave it red and report it.
- You may FIX `resolve.ts` only for a finding whose fix is a few lines and clearly inside lane B's
  brief; anything larger, or anything that belongs to DEF-0040 / R-461 / DEF-0048 (a later lane),
  you report and do not fix. Say which you did.

## The main session's three doubts -- test these first

1. **The defect's own live sentence may still be refused.** DEF-0047's reproduction is "clear Line 1
   for the rest of the week" -- the EVERYONE branch. The pin covers the NAMED-PERSON branch. Lane B
   de-duplicated only `unassign` removals and run removals in the everyone branch and left the
   per-block `move` commands alone. But `expandEveryoneUnassign`, called for one day, turns a block
   that crosses that day's edge into a MOVE (an edge trim to midnight). So for a night block Monday
   22:00 to Tuesday 06:00 with both days inside the week: Monday's call yields a trim of its end,
   Tuesday's call yields a trim of its start -- two commands on ONE assignment id, which is exactly
   what the bar's duplicate guard (`findDuplicateBlockPair`, `CommandBar.tsx`) refuses with "those
   two lines are about the same block". Build that case: everyone, a place, the week, one night block
   whose both days are inside the span. Assert what the expansion returns. The right answer is ONE
   removal of that block (it lies wholly inside the cleared span), no trims. Also the block on the
   span's LAST day running into the day after the span: that one is a single trim, and stays one.
   If it is broken, this is inside lane B's brief ("one block is one removal"): fix it if it is
   small, otherwise report the shape.
2. **The new sentence is not one a supervisor would say (R-459).** `"<person>'s block on <cell> --
   nothing to change."` carries a dash chain. Check how the bar prints a `nothing_to_do` text and
   whether any audit of the bar's wording (grep `src/test` for the R-459 inventory or wording pins)
   would catch it. Propose the plain sentence; change it if no test pins the old text.
3. **The guard in `resolveMoveCommand` sits before the destination logic.** Find every way a parsed
   move legitimately reaches that point with all four of `adjust`, `toPlace`, `span`, `shift` null
   and used to do something useful (a move by day only? a move "to tomorrow" that carries only
   `day`?). Read the parser's move shapes in `src/lib/command/parse.ts` (or wherever the grammar
   lives) and the existing move cases. If a day-only move exists, the guard has just broken it and
   no test noticed.

## Then break it your own way

- Mutate each of lane B's changes on a COPY-backed file (copy first, restore from the copy) and see
  that a case goes red BY NAME: drop the `adjust` carry; drop each `queued*` set; make `peopleCount`
  always plural; remove the nothing-to-change guard. A change no case notices is a finding.
- The three DEF-0044 cases: re-run lane B's three mutations yourself and confirm red by name.
- `peopleCount(0)`: what does the bar say for a headcount of zero, and can one be reached?
- The named-person empty week: "Sam Patel has no block this week." -- check the week words
  ("this week", "next week", "the rest of the week") read as a sentence with every `WEEK_WORD`.
- Clock: one of your cases in the week of a clock change, west (America/Chicago, 8 March 2026 or
  1 November 2026) and east (Europe/Berlin) of UTC.

## Run

`npx vitest run src/test/s194bReview.test.ts src/test/commandResolve.test.ts src/test/commandBar.test.tsx src/test/commandParse.test.ts src/test/dateSeam.test.ts src/test/defects/DEF-0046.test.ts src/test/defects/DEF-0047.test.ts src/test/defects/DEF-0043.test.ts src/test/defects/DEF-0043-headcount.test.ts`
`npx vitest run src/test/defects/DEF-0040.test.ts src/test/defects/DEF-0048.test.ts` must stay
exactly one red case each.

## Report

Plain prose. For each of the three doubts: confirmed or refuted, with the case's name and the
runner's line. Every finding: what a person at the bar would see, the case that shows it, whether
you fixed it. Every mutation and whether a case caught it by name. The runner's total lines, copied.
What you did not examine.
