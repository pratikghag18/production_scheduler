# Review brief: S204-A (DEF-0068, DEF-0069, R-470, R-465) -- one job: break it

You are the reviewer of a lane's UNCOMMITTED work on the developer's tree (branch `Development`,
C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler). `git diff` and `git status` show the whole
piece (new: migration 0087, its SQL test, `src/test/blocksElsewhereRoot.test.ts`). You did not write it;
your one job is to find where it is wrong. Read `CLAUDE.md` sections 4 and 7, the lane's brief
`docs/agent-briefs/s204-a-no-popup-over-a-locked-block-and-the-rail-says-booked-brief.md`, the two defect
cards, R-470 and R-465 in `docs/plan.yaml`, then the diff file by file. You make NO edits except item 9's
allowance.

## What the lane says it built (its words; check them)

- `answerForProbe(probe, facts)` in `busyElsewhere.ts` is the one gate (ok / busy_elsewhere /
  overlap_locked / overlap); `precheckBeforeWrite`, `submitCreateDirect` and `explainCapacityRefusal`
  (the re-time/move refusal explainer) all call it. A single sentence over a locked block refuses before
  any readout (CB-lock-4 rewritten: contract changed, R-470); a rail drop / create refuses with the same
  sentence as a toast and a thrown `CapacityExceeded`, no pop-up; an editable overlap still opens the
  pop-up (CB-pre-7, CB-lock-7, DG-lock-3).
- Migration 0087: `operator_blocks_elsewhere(p_from, p_to, p_root_path ltree DEFAULT NULL)`; the
  two-argument function DROPPED; COMMENT/REVOKE/GRANT re-emitted; body `CASE WHEN p_root_path IS NULL THEN
  a.node_id NOT IN (readable) ELSE NOT (n.path <@ p_root_path) END`. SQL test BO1-BO5; CB7-CB9 green;
  `99_capacity_review_test.sql` RV16 edited to the new signature (outside the lane's list). `db:types`
  diff: one line (`p_root_path?: unknown`). Client: `fetchBlocksElsewhere(from, to, rootPath)`.
- The rail reads "booked (Cell 4, 6 am to 2 pm)" with or without the viewer grant; roleWalk's 201t flake
  was this defect under a parallel spec's grant (a new roleWalk case holds the grant itself).

## What to try to break

1. **The dropped function.** `grep -rn "operator_blocks_elsewhere" src/ supabase/ scripts/ e2e/` -- every
   caller of the OLD two-argument signature (the copy-week/template planners? a script? another SQL test or
   function?) must pass the new one or rely on the DEFAULT. A PostgREST call with two named args still
   resolves to the three-arg function with a default -- confirm (the lane's BR-1/BR-2 and the browser say
   so for the client; check SQL callers). Any caller NOT updated is a blocker (a 404 on the RPC at runtime,
   or a silent old answer).
2. **The migration against 0085, line by line.** `git diff --no-index` the 0085 body (~l.271-296 plus the
   COMMENT/REVOKE/GRANT block) against 0087. Only the signature, the CASE in the WHERE, the DROP, and the
   re-emitted COMMENT/REVOKE/GRANT may differ. Is `NOT (n.path <@ p_root_path)` the SAME comparison
   `board_window` uses for its root (`grep -in "<@" supabase/migrations/*.sql`, the last board_window)?
   Does a root path that names a node the caller cannot READ (a crafted call) leak anything it should not
   -- the function is a definer: with a root OUTSIDE the caller's grants, which rows come back, and are
   they all of people the caller can read (`app_can_read_operator` still there)? Say what a crafted root
   returns and whether it is more than 0085 would have returned for the same caller.
3. **The ltree over PostgREST.** `database.types.ts` says `p_root_path?: unknown`. The client passes a
   string; PostgREST casts text -> ltree on the function argument. Confirm from the browser run or a BR
   case that the RPC answers (not a 42883/22P02); say whether a path with a character ltree refuses
   (a node label with a space or a hyphen -- read how `nodes.path` labels are built) could make the RPC
   throw where it used to answer, and whether `fetchBlocksElsewhere` guards it.
4. **`explainCapacityRefusal` widened.** A server `CapacityExceeded` against a readable-but-locked block now
   says the locked sentence instead of the numbers. Is that right for a drag MOVE (the person's own block
   being moved overlaps a locked block)? And for a RE-TIME? Read what it said before and after; can the
   explainer now say "you cannot change that block" when the refusal was really the cap over EDITABLE
   blocks plus one locked one -- is the sentence still true? Both readings, your call.
5. **The thrown `CapacityExceeded` carrying `elsewhere`.** Who catches it: the create pop-up, the drag,
   the bar's writer answer? Every catcher renders the sentence, none prints the raw numbers or an id, and
   the bar's trace outcome is `refused: <sentence>` with `asked` null (R-434, R-459). Pin or read.
6. **CB-lock-4's rewrite and CB-lock-6** (a join question whose every answer is locked is not asked):
   read both; is CB-lock-6's "asked when only one answer is" right -- the other answer must be an
   EDITABLE overlap or ok, never busy-elsewhere.
7. **The rail.** `OperatorPanel.tsx`/`railWords.ts`: with the new rows a person can now appear in BOTH the
   board's window (a block under the root) AND elsewhere (another block off the root) -- the word and the
   brackets handle both without double-counting the hours? A person with a readable off-board block AND
   an unreadable one: both listed, "and"-joined, in the plant's zone? PE-10 covers what, exactly?
8. **The e2e cases.** DEF-0068 in typedWalk (viewer refusal, trace, supervisor grant opening the pop-up,
   Cancel writes nothing) and DEF-0069 in roleWalk (the grant added and removed inside the case): do the
   `finally` blocks restore the grant and every row on failure? roleWalk's R-465 case and the new DEF-0069
   case both touch Ana's grants -- serial, never parallel (read the file's mode)? The lane's "accidental
   Priya block on Cell 1, deleted by id": confirm with read-only psql on the TESTER's container that
   Priya has only her seed rows today and tomorrow, and Ana only `supervisor | Line 1`.
9. **Runs.** `npx tsc -b` (conclusive after the lane's db:types; confirm the one-line
   `database.types.ts` diff). `npx vitest run --maxWorkers=2 src/test/scaleAudit.test.ts
   src/test/dateSeam.test.ts src/test/commandBar.test.tsx src/test/busyElsewhere.test.ts
   src/test/dragGesture.test.ts src/test/railWords.test.ts src/test/operatorPanel.test.tsx
   src/test/shapes.test.ts src/test/blocksElsewhereRoot.test.ts src/test/commandConversation.test.ts
   src/test/defects/` -- copy the totals (scaleAudit and dateSeam must still pass with the new test file
   present). Do NOT run the full `npm run test`. The SQL suite as `scripts/run-sql-test.sh --rebuild` runs
   it (the tester's container): copy the lines for 99_blocks_elsewhere_off_the_board, 99_capacity_
   counts_every_block, 99_capacity_review, and the total. `npx eslint` and `npx prettier --check` over the
   changed files; if a lint or format problem is the only thing wrong in a file, fix that one thing and
   say so; nothing else.

## Rules

Do not commit. Never `npm run db:reset`, never start or stop containers, never touch the developer's
stack (54321/54322, `supabase_db_production_scheduler`). PowerShell: no `&&`. Read-only psql against the
TESTER's container is fine; the SQL suite as the runner does it is fine. Playwright against the tester's
stack ONLY when a finding needs the browser (env from `node scripts/tester-stack.mjs env` in the same
command, `--workers=1`, foreground); put back anything written. Do not touch `docs/plan.yaml`, `CLAUDE.md`,
`docs/defects/**`, `src/test/defects/**`, any migration.

## Report

Plain prose. Findings first, worst first, each with the file and line, what a person would see go wrong,
and how you know. Then the items above you checked and found sound, one line each. Then every runner's
total line, copied. Then your call: ship, or not, and what must change first.
