# Lane brief: S194-B, the resolver -- DEF-0046, DEF-0047, DEF-0043 (resolver half), DEF-0044 items 2, 5, 6

You are a build lane. Two other lanes run at the same time: lane A owns the absence screens,
`BoardPage.tsx`, the pop-ups and `OperatorPanel.tsx`; lane C owns `scripts/voice/**`, the demo seed
and the e2e walk files. Do not touch their files. Ignore `tsc` errors in files you do not own. Do not
run the full `npm run test`. Do not run `npm run db:reset`. Do not commit. Do not edit
`docs/defects/*.md`, `docs/plan.yaml` or `CLAUDE.md`.

This machine: the shell for npm and npx is PowerShell (no `&&`; separate commands with `;`). Never
patch a file with `Get-Content`/`Set-Content` (it re-encodes UTF-8); use your edit tool or node.

## Files you own, and no others

- `src/lib/command/resolve.ts`
- `src/test/commandResolve.test.ts`

You do NOT own `src/features/board/components/CommandBar.tsx`, `src/lib/command/grounded.ts`,
`src/lib/voice/verbGuess.ts`, `src/features/board/hooks/useDragGesture.ts` or
`src/test/commandBar.test.tsx`. A later lane (E) takes those. If a fix seems to need one of them,
stop at the resolver's edge and describe what the bar must do in your report.

## What must NOT be done in this lane

**DEF-0040 and R-461 (the night shift split at midnight, the two questions) are NOT yours.** A later
lane (D) builds them in this same file after you land. So in `expandEveryoneUnassign` (l.3724 to
about l.3890) change ONLY the wording sites named below; do not restructure the block loop or the
`remove_run` loop, and do not try to make `DEF-0040.test.ts` green. **DEF-0048 (the one-day absence)
is also lane D's**; leave `expandAbsence` alone.

## Read first

1. `CLAUDE.md` §4 ("a green case can be pinning the bug") and §7 (R-431, R-432, R-434, R-435, R-459).
2. `docs/defects/DEF-0046.md`, `DEF-0047.md`, `DEF-0043.md`, `DEF-0044.md`, in full.
3. The pins: `src/test/defects/DEF-0046.test.ts`, `DEF-0047.test.ts`, `DEF-0043.test.ts`,
   `DEF-0043-headcount.test.ts`. Read each assertion before writing code.
4. In `resolve.ts`: `expandEveryoneMove` (l.3909), `resolveMoveCommand` (l.2763),
   `expandRepeatUnassign` (l.5117), `LOT_CEILING` (l.726), `roundUpToQuarterHour` (l.1265),
   `edgeOnBoard` (l.3367). Line numbers are from 28 Sept; trust the names.

## Piece 1 -- DEF-0046: "extend everyone on Cell 1 by 30 minutes" must not throw

What is wrong: a move of everyone expands to one move per block with `existing` filled, but the
sentence's `adjust` ({edge, by}) is dropped (`adjust: null`). Each step is then a move with no new
cell, no span, no shift and no adjust, and `resolveMoveCommand` reads `.start` of a null span.

What to build, both halves:
1. The expansion carries everything the sentence said into each step: `adjust`, and check `span`,
   `shift` and `toPlace` the same way while you are there. Write down in the report which fields the
   expansion carried before and which it carries now.
2. `resolveMoveCommand` never throws on a step with nothing to change. A move that names no new
   place, no span, no shift and no adjust is a QUESTION in the resolver's existing question shape
   (look for how the resolver already answers "nothing to do" or asks what to change; reuse that kind
   rather than inventing one, and if none fits say so in the report and name the one you added).
   A `TypeError` out of the resolver is never an acceptable answer to any parsed command.

Cases in `commandResolve.test.ts`: extend everyone on a cell by 30 (two blocks, both extended, board
order); shorten everyone; an adjust on a cell with no blocks (the existing empty answer); the bare
move with nothing to change (the question, no throw).

## Piece 2 -- DEF-0047: a night block is removed once in a week clear

What is wrong: `expandRepeatUnassign` loops the week's days and pushes a removal for every block each
day's window overlaps; a block across midnight overlaps two days and is queued twice. The bar's
duplicate guard then refuses the whole lot.

What to build: within one expansion, an assignment id is queued once, on the FIRST day it overlaps,
in board order. Apply the same de-duplication to the `remove_run` half if a run across midnight can be
queued twice the same way (check; say which you found). Do not touch the bar's duplicate guard.
Note for the report: R-461 will later change what a clear does with a block across the edge of the
span; your job is only that one block is one removal.

The pin uses the REAL board axis (`buildDayAxis`/`wallOf`) in the week of the 8 March 2026 clock
change; keep that in mind when you compare windows (compare instants, never wall-clock strings).

## Piece 3 -- DEF-0043, the resolver's words (R-459)

1. "people" is written unconditionally at three sites: about l.2526 ("For N people."), l.3138 ("now
   takes N people"), l.3818 (", for N people"). One is "1 person". Make ONE small helper in this file
   and call it at all three; grep the file for any fourth site (`people`) and treat it the same.
2. The run removal's readout (about l.3860) prints the raw `YYYY-MM-DD` where the question before it
   printed the spoken day ("Mon Oct 12"). The Done line and the question must take the SAME string
   from the same builder. Find where the question's day string comes from and use it; do not format a
   date yourself (R-426: no `toLocale*`, no `getDate()`; `src/test/dateSeam.test.ts` will fail you).
3. `expandRepeatUnassign`'s empty case (about l.5210) says "The board has nobody on it this week."
   when the sentence named a person. When the removal names a person, the answer names the person
   ("Sam Patel has nothing on the board this week." or the form the single-day answer already uses
   for a named person with no block: find it and match it).

The second-pass items in DEF-0043 (24-hour spans on the which-block buttons, "everyone" in quotes,
"those two lines") live in the bar and are lane E's. If the BUTTON LABELS are built in `resolve.ts`,
fix the 24-hour span there using the spoken-hours builder the readouts already use ("9 am to 11 am"),
and say so; if they are built in `CommandBar.tsx`, leave them and say so.

## Piece 4 -- DEF-0044 items 2, 5 and 6: limits that a test must hold

Code does not change here; tests do. For each, write the case, then PROVE it can fail: make the
mutation the defect names on the file, run the case, see it red by name, restore the file from a COPY
you made first (never `git checkout -- <file>`; it would destroy your uncommitted work), run it green.

- Item 2: a week clear whose removals exceed `LOT_CEILING` answers `lot_too_big` (a cell full of
  short blocks across seven days). Mutation: delete the `total > LOT_CEILING` refusal in
  `expandRepeatUnassign`.
- Item 5: `roundUpToQuarterHour` with "now" exactly on :00, :15, :30, :45 stays where it is. Mutation:
  remove the on-the-quarter short-circuit. The function may not be exported; test it through the
  command that uses it with a frozen clock, or export it for the test if the file already exports
  helpers that way.
- Item 6: `edgeOnBoard` with a block edge exactly on the board's last midnight. Mutation: `<=` to `<`.

## Proving it

1. The pins, green by name:
   `npx vitest run src/test/defects/DEF-0046.test.ts src/test/defects/DEF-0047.test.ts src/test/defects/DEF-0043.test.ts src/test/defects/DEF-0043-headcount.test.ts`
2. `npx vitest run src/test/commandResolve.test.ts`. The tester counted 281 cases on 28 Sept; yours is
   281 plus your new ones, zero failed. Copy the runner's line.
3. `npx vitest run src/test/commandBar.test.tsx src/test/commandParse.test.ts src/test/dateSeam.test.ts`
   -- you do not own them, but your wording changes can turn a string expectation red (`tsc` cannot
   see a string expectation). If one goes red, do NOT edit it: list the case, the old string and the
   new string in your report; the main session hands it to lane E.
4. Grep `e2e/` and `scripts/` for the strings you changed ("people", "has nobody on it") and list
   every hit in the report; lane C owns the walk files and will be told.
5. `npx vitest run src/test/defects/DEF-0040.test.ts src/test/defects/DEF-0048.test.ts` must be
   exactly as red as before you started (one failing case each). Greener or redder means you moved
   something that is not yours; say which.

## Report

Plain prose. Include: each piece, what changed and at which function; the four mutation results
(red by name, then green); the vitest total lines COPIED from the runner; every string you changed,
old and new, as a two-column table; every red case in a file you do not own; anything you found that
you did not fix. Include a draft commit message in the repo's style: plain ASCII, reasoning in
prose, no bullet lists.
