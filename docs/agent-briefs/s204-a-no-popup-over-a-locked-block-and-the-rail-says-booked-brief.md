# Lane brief: S204-A, no split pop-up over a block the supervisor cannot change, and the rail says booked for a readable block off the board (DEF-0068, DEF-0069, R-470, R-465)

You are a build lane on the developer's tree (branch `Development`, clean at the tester's merge d731b1c
plus an uncommitted edit to `docs/plan.yaml`, which you do not touch). Nobody else is editing the
repository. Read `CLAUDE.md` first (sections 4 and 7: "Extract, never retype", "a migration ...
`db:types`", "Anything resolved by walking UP the tree is resolved by the server as a definer", "A write
that reports success can have changed nothing"), then `docs/defects/DEF-0068.md` and `DEF-0069.md`, then
in `docs/plan.yaml`: R-470 (new, the maintainer's decision), R-465, R-431, R-459, F-254, and session 202's
entry. Then `docs/agent-briefs/s202-a-split-only-where-she-can-and-questions-in-order-brief.md` and its
review brief: yesterday's piece gave `capacity_probe` the `editable` flag and the bar the `overlap_locked`
answer and its sentence; this piece carries both to two more doors. Do not redo it.

## Read this first

Browser first (both defects' reproductions add a read-only grant on Cell 4 for Ana by psql on the TESTER's
database and remove it after; the stack is up on 54421), then red unit and SQL cases, then the fix, then
the browser again with permanent e2e cases. Do not report this piece as done on unit tests. Do PART 1
whole before PART 2; they share the browser's demo data.

## PART 1 --- DEF-0068 (R-470): no pop-up over a block she cannot change

As Ana with a viewer grant on Cell 4: "put Priya Shah on Common Fastener at Cell 1 today from 8 am to 10
am" answers "Priya Shah is already booked then. The board is asking how to split the time. Answer it on the
board.", the Split coverage pop-up opens, and Confirm is refused ("Not done: You cannot change that block
from here."). A drag or a create onto Cell 1 over Priya's hours opens the same pop-up.

THE RULE (R-470, the maintainer, 2 Oct): refuse straight away, in the lot's words, no pop-up:

    Not done: Priya Shah is already on Cell 4 today from 6 am to 2 pm, and you cannot change that block
    from here.

Nothing written, no button. The board's drag and create doors refuse the same way with the same sentence
(a toast or the create pop-up's own refusal line -- read how `submitCreateDirect` reports a refusal today
and use that channel; do not add a new one). Where Ana CAN change every overlapping block, the pop-up
opens as before (no stale refusal).

What to build:
- `submitCreateDirect` (`useDragGesture.ts` ~l.2729) probes `capacity_probe`, then `isBusyElsewhere`
  refuses and `!fits` opens the pop-up. Add the locked case between them from the SAME probe result and
  the SAME builder yesterday's `precheckBeforeWrite` uses (`busyElsewhere.ts`): one function answers
  ok / busy_elsewhere / overlap_locked / overlap for a probe, and both `precheckCommandStep` and
  `submitCreateDirect` call it. If `precheckBeforeWrite` already is that function, call it; if the pop-up
  path has its own copy of the gate, make it call the shared one and say so (R-449).
- The bar's single sentence: `refusalBeforeAsking`/the single path treats `overlap_locked` as it treats
  `busy_elsewhere` -- the refusal before any readout or question (R-465's shape) -- so the sentence never
  reaches the writer. CB-lock-4 pins today's "unchanged, goes to the writer": the CONTRACT CHANGED (R-470);
  rewrite it and say so. CB-pre-7 (a readable EDITABLE overlap still reaches the writer and the pop-up)
  stays true.
- The create pop-up (a typed create that opened the pop-up, then Create): same gate, same words, through
  `submitCreateDirect`.
- A re-time or a move over a locked block: say what happens today (the server refuses; the words) and
  whether the same gate is cheap to add there; add it if it is one call, otherwise file it in the report.

## PART 2 --- DEF-0069 (R-465): the rail says booked for a readable block off the board

With the same grant, Ana's rail reads "Priya Shah ... free"; without it, "booked (Cell 4, 6 am to 2 pm)".
The rail is fed by the board's own window (rows under the board's root, Line 1) plus
`operator_blocks_elsewhere(p_from, p_to)` (defined LAST in `20260930000085_capacity_counts_every_block.sql`
~l.271-296), which returns only blocks on places the caller CANNOT read. A block on a readable place
OUTSIDE the board's root is in neither source.

What to build:
- Migration `supabase/migrations/20261002000087_blocks_elsewhere_off_the_board.sql`: EXTRACT the function
  from 0085 with a script (assert on the assembled text: SECURITY DEFINER, pinned search_path, the company
  boundary `a.org_id = app_current_org()`, `app_can_read_operator`, the ORDER BY) and give it a third
  parameter, the board's root, so it returns every block of a readable person that is NOT under that root
  --- whether or not the caller can read its place. Decide how the root is passed from what the client has
  (`rootPath` in `useBoardWindow.ts`/`BoardPage.tsx` -- a path string; read `nodes`' columns and how
  `isAtOrBelow`/`app_readable_node_ids` compare paths, and compare the same way, never a re-derivation) and
  whether a null root keeps today's behaviour (it should, so nothing else breaks). Postgres: a changed
  signature is a NEW function; DROP the old `(timestamptz, timestamptz)` one in the same migration and
  re-emit its COMMENT, REVOKE and GRANT block for the new signature (read 0085's, take them whole). Rows
  on a readable place may carry the same columns as today (place, parent, hours, efficiency) -- the rail
  needs nothing more; say whether the client's `BlockElsewhere` shape needs an `outside`/readable flag for
  the bar's words (the rail title says "booked (Cell 4, ...)" either way).
- SQL cases in a new `supabase/tests/99_blocks_elsewhere_off_the_board_test.sql` (harness as
  `99_capacity_counts_every_block_test.sql`, whose CB7-CB9 are the function's existing cases -- they must
  stay green with the null root): as Sue (supervisor on Line 1) with a viewer grant on Cell 4, with the
  Line 1 root, Priya's Cell 4 block is returned; without the grant it is returned too (the old behaviour);
  with the PLANT root the plant admin gets nothing for a block under the plant; a block under the root is
  never returned; company 2 gets nothing; a null root is 0085's answer exactly.
- `src/lib/api/board.ts` `fetchBlocksElsewhere` (~l.81-100) passes the root; `useBlocksElsewhere`
  (`useBoardWindow.ts` ~l.72) already keys on `rootPath` -- pass it through. `shapes.ts` if a field is
  added. `npm run db:types` AGAINST THE TESTER'S STACK after applying 0087 there (`psql -f` to the tester's
  container is fine; say that you did), commit the regenerated `src/lib/database.types.ts` (the signature
  changed, so it WILL differ this time). `tsc` is inconclusive until then.
- The rail (`OperatorPanel.tsx` ~l.558-585, `railWords.ts`, `busyElsewhere.ts`'s `elsewhereTitle`/
  `elsewhereBrackets`): with the new rows the word is "booked (Cell 4, 6 am to 2 pm)" for Priya with or
  without the grant. Read `e2e/roleWalk.spec.ts`'s R-465 case (it asserts Ana's rail against the plant
  admin's) -- the tester suspects its 201t flake was this defect under a parallel spec's grant; say whether
  that reading holds.
- The bar: `isBusyElsewhere`'s sentence for a readable off-board block -- the bar's own precheck already
  handles readable overlaps (editable or locked) through the probe, so the rail is the only consumer that
  changes; confirm nothing in the bar reads `blocksElsewhere` and double-counts.

## Files you own

`supabase/migrations/20261002000087_blocks_elsewhere_off_the_board.sql` (new), `supabase/tests/
99_blocks_elsewhere_off_the_board_test.sql` (new), `src/lib/database.types.ts` (regenerated),
`src/lib/api/board.ts` (the one call), `src/lib/api/shapes.ts` (only if a field is added),
`src/features/board/hooks/useDragGesture.ts`, `src/features/board/hooks/useBoardWindow.ts`,
`src/features/board/lib/busyElsewhere.ts`, `src/features/board/lib/railWords.ts`,
`src/features/board/components/OperatorPanel.tsx`, `src/features/board/components/CommandBar.tsx` (the
single's locked refusal only), `src/features/board/BoardPage.tsx` (only to pass the root), and the tests:
`src/test/commandBar.test.tsx`, `src/test/busyElsewhere.test.ts`, `src/test/dragGesture.test.ts`,
`src/test/railWords.test.ts`, `src/test/operatorPanel.test.tsx` (or wherever the rail is pinned -- grep
R-465), `src/test/shapes.test.ts`, `e2e/typedWalk.spec.ts`, `e2e/roleWalk.spec.ts`, `e2e/walk/*`,
throwaway specs under `e2e/` that you delete before you report.

## Files you must not touch

Every OTHER migration (never edit 0085 or 0086), `src/lib/api/mutations.ts`, `src/lib/command/**`,
`src/features/board/components/SplitCoveragePopover.tsx`, `src/features/board/components/
CreatePopover.tsx` (unless the refusal line is there -- say), `src/features/admin/**`, `src/test/defects/**`,
`docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, `playwright.config.ts`, `scripts/**`.

## Rules

Do not commit. Never `npm run db:reset`. Never apply anything to the DEVELOPER's stack (`127.0.0.1:54321`
/ `54322`, container `supabase_db_production_scheduler`); the main session applies 0087 there after the
review. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never patch a file with `Get-Content`/`Set-Content`;
use your Edit tool, and write the migration with the Write tool from text your script assembled and
asserted on. Never `git checkout -- <file>`. **The tester's stack is UP** (the main session started it and
will stop it); do not run `tester-stack.mjs up`/`down`, start or stop containers. Set the environment from
`node scripts/tester-stack.mjs env` in the same PowerShell command as each Playwright run;
`$env:VITE_SUPABASE_URL` must read `http://127.0.0.1:54421`. ONE Playwright process at a time,
`--workers=1`, FOREGROUND. Put back whatever your browser runs write, including the viewer grant (the
defect cards have the exact insert and delete). The voice model is not served. `npx vitest run
--maxWorkers=2 <files>`; do NOT run the full `npm run test`. Ignore `tsc` errors in files you do not own.

## Proving it

1. What you saw in the browser BEFORE the fix, both defects, as the thread's lines, the pop-up, the rail.
2. SQL: the new test file's cases and the whole suite's per-file lines (copied), CB7-CB9 still green.
   `db:types` against the tester's stack: the diff of `database.types.ts` (the new signature and nothing
   else beyond a BOM).
3. Unit: `CB-lock-6..` (the single sentence refuses before any readout with the sentence; an editable
   overlap still reaches the writer; the trace outcome refused, asked null); `DG-lock-N` in
   `dragGesture.test.ts` (`submitCreateDirect` refuses a locked overlap through the shared gate with the
   sentence, opens the pop-up for an editable one, refuses busy-elsewhere as before -- one gate, three
   answers); the rail cases (Priya's readable off-board block reads booked with the cell and the hours;
   the title sentence); `shapes` if a field is added.
4. Mutations, copy-backed, each red BY NAME then restored: the locked case removed from
   `submitCreateDirect`; the single's locked refusal removed; the root ignored by the function (SQL);
   the root not passed by the client.
5. In the browser, as Ana, on the tester's stack: DEF-0068's sentence with the grant (one refusal, no
   pop-up, nothing written), a drag onto Cell 1 over Priya's hours (the same refusal, the same words), the
   grant raised to supervisor on Cell 4 (the pop-up opens, Split writes 0.5/0.5, restored); DEF-0069's rail
   with and without the grant ("booked (Cell 4, 6 am to 2 pm)" both times, read from the chip and its
   title); permanent cases in `e2e/typedWalk.spec.ts` (DEF-0068) and `e2e/roleWalk.spec.ts` (DEF-0069, the
   grant added and removed inside the case); then `npx playwright test e2e/typedWalk.spec.ts --workers=1`
   twice and once with `$env:WALK_SET = "2"`; `e2e/roleWalk.spec.ts` twice. Copy each result line.
6. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`, `src/test/busyElsewhere.test.ts`,
   `src/test/dragGesture.test.ts`, `src/test/railWords.test.ts`, the rail's test file,
   `src/test/shapes.test.ts`, `src/test/commandConversation.test.ts` and `src/test/defects/`: copy the
   totals. `npx tsc -b` AFTER `db:types` (then conclusive; say so), `npx eslint` and `npx prettier --check`
   over your files.

## Report

Plain prose. What you saw in the browser first. The one gate and its three answers, and every door that
calls it. How the root is passed and compared, and the assembled body's guards you asserted on. What a
person sees now at each door and on the rail. Every case added or changed (wrong, or contract changed,
with the rule). The mutations' red lines. Every run's result line, copied; the SQL suite's per-file lines;
the `database.types.ts` diff. What you wrote to the stack's database and put back. What you did not do or
could not prove. A draft commit message in the repo's style: plain ASCII, the reasoning in prose, no bullet
lists.
