# Lane brief: S194-F, no minimum length beyond one minute (R-463)

You are a build lane. Nobody else is editing the repository. The working tree is clean apart from
`docs/plan.yaml` and this brief, which are the main session's.

## The decision (the maintainer, 29 Sept) -- not open

"There is no limit to schedule a job, if such a rule exists, please change it. Anything positive
and greater than 1 is good." Asked two follow-ups with two candidates each, the maintainer chose:
it holds for a person's BLOCK as well as a JOB, and the shortest length is ONE MINUTE.

So the app's 15-minute floor goes. It is requirement R-463 in `docs/plan.yaml`
(grep `^- id: R-463`); read its claim and note.

## What is true today

- ONE constant: `MIN_DURATION_MINUTES = 15` (`src/features/board/lib/interaction.ts` l.28, tagged
  D31). The drag (`useDragGesture.ts`), the pop-ups and the bar (through
  `ctx.minDurationMinutes`, handed over in `BoardPage.tsx` l.756, "passed in, never retyped") all
  read it. Nine sites in `src/lib/command/resolve.ts` answer `too_short` from it.
- The SERVER has no minimum. Every writer refuses only `isempty(p_timerange)`, a range of no length
  (last definitions in `supabase/migrations/20260918000082_home_shift.sql`). So after this change
  the client and the server agree, by the client dropping its rule. **No migration. Nothing under
  `supabase/` changes.**
- The developer's database holds no job and no block under 15 minutes (113 jobs, 116 blocks).

## Read first

1. `CLAUDE.md` §4 ("a green case can be pinning the bug", "tsc cannot see a string expectation")
   and §7 (R-431, R-447, R-459).
2. `src/features/board/lib/interaction.ts` whole: the constant, `rangeFromDrag` or whatever builds a
   range from a drag (about l.108 to l.160), and the comment near l.323 that says some branch is
   unreachable BECAUSE the minimum is 15. That reasoning stops being true; find what it protected.
3. Every hit of `MIN_DURATION_MINUTES`, `minDurationMinutes` and `too_short` under `src/`.
4. How the board snaps a drag to the time grid at each zoom (Compact, Standard, Fine): grep
   `snap` in `src/features/board/lib` and `useDragGesture.ts`.

## What to build

1. **The constant becomes 1**, in its one place. Keep the name and the single source; update its
   comment to say what it is now (the smallest length the board can show, one minute; R-463
   replaced D31's fifteen) and why it still exists (a range of no length is refused by the server).
   Do NOT delete the constant and scatter a literal 1.
2. **The sentence.** `too_short` reads "That is 5 minutes; a block is at least 15 minutes." The
   number comes from `min`. With 1 it must read as a sentence: "at least 1 minute", singular, and
   "That is 0 minutes" for a zero length. Find the one place the sentence is built
   (`describeQuestion`, `case "too_short"`, about resolve.ts l.6549) and use a minutes helper the way
   `peopleCount` does people. Check the negative case the file's comments mention ("-840 minutes"):
   a span whose end is before its start should never have read as "too short"; if it still can
   reach this sentence, say in your report what the person reads and whether another question
   (`day_order`, `across_midnight`) should have caught it first. Do not invent a new sentence for
   it; report it.
3. **The drag.** With a floor of 1 minute, what is the shortest block a DRAG can make? It should
   be one step of the snap grid at the current zoom, never a 1-minute sliver nobody can grab. Read
   how the range is snapped and whether the floor or the snap decides. Three things to settle from
   the code and prove with cases in `src/test/interaction.test.ts` (or wherever these are tested):
   - a drag shorter than one snap step makes nothing (as a drag under the minimum did before);
   - resizing an existing block by its edge cannot drag the edge past the other edge or onto it
     (the clamps at interaction.ts l.152 and l.156 and useDragGesture.ts l.920 and l.922 used the
     minimum for this; with 1 they allow a 1-minute block by drag). Decide by what is already
     there: if the drag snaps to the grid, the smallest result is one grid step and that is fine;
     if a resize can land on any minute, clamp the DRAG to one snap step and leave the TYPED and
     SPOKEN paths at one minute. Say which you found and what you did.
   - the comment near l.323 and the branch it calls unreachable: make it reachable-safe or remove
     the claim, with a case.
   A drag is not where the maintainer asked for short jobs; the bar and the pop-up's typed hours
   are. Do not make the board harder to use by hand to allow them.
4. **The pop-ups.** The New pop-up and the block's pop-up take typed hours. Find whether they
   refuse under 15 on their own (a disabled Create, a message) and bring them to one minute through
   the same constant. R-447: nothing shifts when the message appears or goes.
5. **How a short block is drawn.** A 1-minute or 5-minute block on the board at Compact zoom may be
   a pixel wide. Look at how `DirectBlock`, `AssignmentChip` and `RunBand` size themselves: is there
   a minimum drawn width, does the name overflow its neighbours, can it be clicked? Do NOT redesign
   it. If a short block is drawn unusably, give it the smallest change that keeps it clickable (a
   minimum drawn width in `calc(px * var(--ui-scale))`, as `src/test/scaleAudit.test.ts` demands)
   only if such a minimum already exists for something else on the board and you are reusing it;
   otherwise REPORT what it looks like and stop: how it should look is the maintainer's to decide.

## Tests

- Every case that pins 15 or "at least 15 minutes": grep `src/test` and `e2e/` for `15 minutes`,
  `too_short`, `MIN_DURATION`, `minDurationMinutes: 15`. For each, say in your report whether the
  contract changed (it did, 29 Sept) and what it asserts now. A fixture that passes
  `minDurationMinutes: 15` into the resolver should take the constant, not a retyped number
  ("a column list that appears twice is a bug with a delay on it").
- Lane D added MIN1 to MIN5 (a job remnant under the minimum asks `too_short`). They now hold for a
  remnant under ONE minute, which a whole-minute board cannot produce; keep what still means
  something (a remnant of zero length is no remnant: the job goes whole or is untouched) and say
  what you removed and why.
- New cases: a 5-minute job booked by the bar is written; a 1-minute block assigned by the bar is
  written; a zero-length span is refused with the sentence above; a split whose halves are 1 minute
  and the rest.
- `e2e/walk/sentences.ts` has an entry "Assign Lena Novak to Housing A on Cell 1 in Line 1 from 1pm
  to 1:05pm" expecting `That is 5 minutes; a block is at least 15 minutes.` Under R-463 that
  sentence WRITES a 5-minute block. Change the entry to what the bar does now, prove the block in
  the database the way the walk's other assigns do, and check every later entry that touches Lena
  Novak or Cell 1 that afternoon (the area clears at the end count what the walk left on the day:
  the expected counts change by what is really there, never to fit). The second list
  (`sentences2.ts`): grep it for the same.

## Files you own

`src/features/board/lib/interaction.ts`, `src/features/board/hooks/useDragGesture.ts`,
`src/lib/command/resolve.ts`, the pop-up components if piece 4 needs them, the board components in
piece 5 only under its condition, `src/features/board/BoardPage.tsx` only if the hand-over of the
constant changes, the test files beside these, `e2e/walk/sentences.ts`, `e2e/walk/sentences2.ts`,
`e2e/typedWalk.spec.ts`.

## Rules

Do not commit. Never `npm run db:reset`. Write nothing to the maintainer's database
(`supabase_db_production_scheduler`). No migration, nothing under `supabase/`. Do not edit
`docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`. Do not start or stop
containers. PowerShell runs npm and npx (no `&&`). Never `git checkout -- <file>` (copy first,
restore from the copy). Never patch with `Get-Content`/`Set-Content`.

You MAY run `e2e/typedWalk.spec.ts` (both lists) and `e2e/touch.spec.ts` against the TESTER'S stack
only. PowerShell, one line, then the spec:
$env:VITE_SUPABASE_URL = "http://127.0.0.1:54421"; $env:SUPABASE_DB_CONTAINER = "supabase_db_production_scheduler_tester"; $env:E2E_PORT = "5174"; $env:E2E_MAIL_URL = "http://127.0.0.1:54424"; $env:SUPABASE_WORKDIR = "C:\Users\prati\OneDrive\Documents\GitHub\scheduler-test-stack"; $env:VITE_SUPABASE_ANON_KEY = (node scripts/tester-stack.mjs env | Select-String 'ANON_KEY' | ForEach-Object { ($_ -split '"')[1] }); npx playwright test e2e/typedWalk.spec.ts --project=chromium --workers=1
`$env:WALK_SET = "2"` selects the second list. Confirm before EVERY run that
`$env:VITE_SUPABASE_URL` is the 54421 address. Run no other spec.

## Proving it

1. The suites beside the code, then ONE full `npm run test`. Before this lane the runner read
   `Test Files 3 failed | 181 passed (184)`, `Tests 3 failed | 4647 passed (4650)`. The three reds
   are known and stay: `DEF-0040.test.ts`, `DEF-0043-headcount.test.ts`, `DEF-0020.test.ts` (live,
   no edge function on this machine). Anything else red is yours.
2. `npx tsc -b`, eslint and prettier over your files: clean.
3. Both walk lists green, each twice over the same database (R-433), and the touch spec once.
4. Mutations, copy-backed, red by name: the constant back to 15; the sentence's singular removed;
   the drag's smallest step removed.
5. After the change, grep `src/`, `e2e/` and `docs/conventions.md` for the words of the old rule
   ("15 minutes", "fifteen", "D31") and list every hit left, with whether it is history (a comment
   about what used to be) or a live claim that is now false.

## Report

Plain prose. What the drag does now and how you decided it. What a short block looks like on the
board at each zoom and whether you changed anything about it. Every existing case changed and
what it asserts now. A two-column table of every sentence a person reads that changed. The
mutations. The runner's totals and the walks' lines, copied. The list from step 5. What you did
not do. A draft commit message in the repo's style: plain ASCII, reasoning in prose, no bullets.
