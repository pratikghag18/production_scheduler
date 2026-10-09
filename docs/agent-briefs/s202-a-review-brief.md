# Review brief: S202-A (DEF-0065, DEF-0066, DEF-0067, F-247, F-249) -- one job: break it

You are the reviewer of a lane's UNCOMMITTED work on the developer's tree (branch `Development`,
C:\Users\prati\OneDrive\Documents\GitHub\production_scheduler). `git diff` and `git status` show the whole
piece (two new files: migration 0086 and its SQL test). You did not write it; your one job is to find
where it is wrong. Read `CLAUDE.md` sections 4 and 7 (especially "Extract, never retype" and DEF-0011's
story, and "Anything resolved by walking UP the tree"), the lane's brief `docs/agent-briefs/s202-a-split-
only-where-she-can-and-questions-in-order-brief.md`, the three defect cards, R-468's note in
`docs/plan.yaml`, then the diff file by file. You make NO edits except item 9's allowance.

## What the lane says it built (its words; check them)

- Migration `20261002000086_capacity_probe_editable.sql`, extracted from 0085 by script: one column
  `editable` in the inner select (`app_can_edit_node(...)`), `'editable', r.editable` on readable rows,
  `'editable', false` on outside rows, the COMMENT updated. "No identity at all (owner, seed) reads as
  editable true, matching how readable treats it." SQL test `99_capacity_probe_editable_test.sql`, 7
  cases (SE1-SE5 hold `editable` to the real `apply_split_coverage`, person by person). `db:types`
  unchanged (the function returns jsonb).
- `parseCapacityProbeOverlap`: `editable` boolean, default false when absent, always false on outside.
- `precheckBeforeWrite`: a new `overlap_locked` answer when any readable overlapping row is not editable;
  `refuseBusyLotSteps` refuses the step up front with the clause ", and you cannot change that block from
  here" ("those blocks" / "one of them" / "some of them"). The single sentence unchanged (CB-lock-4).
- `rewriteRefusal`'s no-edit-rights branch: the id looked up in the board's nodes -> "You cannot change
  Cell 4 from here."; unknown -> "that block"; a name passes through.
- The lot's REASON questions (`not_certified` warn, `outside_area`) are no longer asked while stepping:
  the step is resolved with a placeholder reason "-", the question queued; after the one probe,
  `askLotNext` asks each remaining step's reason then its overlap, in step order, numbered k of N over
  the steps LEFT after the probe dropped refused ones; then the listing. Every other resolver question
  is still asked at once while stepping. With no probe wired, reasons are asked once stepping ends.
- The split question's places are distinct (`distinctPlaces`): "across those blocks and the new one on
  Cell 2" / "between that block and the new one on Cell 1" / "between Cell 2, Cell 3 and Cell 1".

## What to try to break

1. **The migration, line by line against 0085.** `git diff --no-index` the 0085 body (l.168-262) against
   the 0086 body. The ONLY differences must be the `editable` column, the two `'editable'` keys and the
   COMMENT. Any other change -- a dropped guard, a changed join, a reordered key, a changed `search_path`
   -- is DEF-0011 again and blocks the commit. Then: `app_can_edit_node` -- read its LAST definition
   (`grep -in "function \(public\.\)\?app_can_edit_node(" supabase/migrations/*.sql`). Is it SECURITY
   DEFINER or INVOKER? What does it read for the caller (auth.uid()? a helper?) and does that still answer
   for the CALLER when called from inside `capacity_probe`, a definer with a pinned search_path? The lane
   says SE1-SE5 prove it as `authenticated`; read those cases and confirm they set the caller's identity
   the way the other suites do (`set local role authenticated; set local request.jwt.claims ...` or the
   harness's helper) and that at least one case is a person who can READ but not EDIT the block (a viewer
   grant on the cell) and gets `editable` false, and another who can edit gets true. "No identity reads as
   editable true": is that right, and does any client path call the probe with no identity (the service
   role, a script)? Say.
2. **The SQL suite.** Run it the way `scripts/tester-run.mjs --sql` does (read the script; the tester's
   stack is UP on 54421 and 0086 is applied there). Copy the per-file lines for the two capacity files and
   the new one, and the suite's total. If the runner rebuilds a scratch database from the migrations
   directory, say so; if it runs against the live tester database, say so.
3. **The reorder of the lot's questions -- the heart of the bar.** Read `resolveLotStepBody`,
   `askLotNext`, `refuseBusyLotSteps`, `answerLotReason`, `answerLotOverlap` as they stand now. Then try to
   break them with a scripted bar (the `commandBar.test.tsx` harness; `renderBar`/`bar(...)`, the `busy`
   / `free` probes, `say`):
   - A lot of THREE where step 1 needs a reason, step 2 is busy elsewhere, step 3 overlaps a readable
     editable block: what is asked, in what order, with what numbers, and what is listed? Is "k of N"
     over the steps left honest when step 2 was dropped (the thread then reads "1 of 2", "2 of 2" for
     steps 1 and 3) -- acceptable (R-459: plain) or confusing? Both readings, your call.
   - A reason question queued, then the person types a NEW sentence instead of a reason (CB-nc-6's
     rule): the old lot is dropped whole, nothing half-kept, the trace closed?
   - A reason question queued, then Escape / a cancel word: `stepOptions`, `overlaps`, the queue, all
     cleared?
   - A step whose placeholder-resolved form the probe refuses (busy elsewhere): its reason question is
     NEVER asked (F-247), and the listing names it with the busy sentence, not the certificate one.
   - Both a reason and an overlap on the SAME step: reason first, then overlap, both numbered the same k?
   - NO probe wired (CB-pre-8's world): the reasons are asked once stepping ends, synchronously, and
     CB-lot-ask-1..10 still describe the thread truthfully (the lane says no existing case changed -- is
     that because the cases never read the ORDER, or because the order is the same? Say).
   - A lot that is a REPLACE with a reason question at expansion: unchanged (`replace_blocked`)?
   - `heldOptionsRef` / `lastCtxRef` / `traceRef` after the queue drains: nothing stale carried into the
     next sentence.
4. **The placeholder reason "-".** It is used to resolve the step for the probe. Can it ever LEAK into a
   write (a step listed and run with `override.reason === "-"`) -- say, when the person answers the
   overlap question but the reason question was somehow skipped, or when `askLotNext` is re-entered after
   a board move (`Lot.source` rerun)? Read `runLotNow` and the listing: assert in a scripted case that no
   step reaches `onRunLot` with a "-" reason. If it can, that is a blocker (a write with a fake reason).
5. **The clause wording** ("that block", "those blocks", "one of them", "some of them") against R-459;
   and DEF-0067's forms. Is "across those blocks and the new one on Cell 2" what a supervisor would say?
   Suggest plainer if not (do not edit).
6. **The rewriter.** `rewriteRefusal` now takes a node lookup: how is it passed (a parameter, a ref)? Is
   every caller updated, and does the pure-function test (CB-ref-*) still hold? A node id of another
   company (not in `nodeById`) says "that block", never the id -- pinned?
7. **The e2e cases.** DEF-0065 adds Ana's viewer grant THROUGH DANA'S CLIENT: can Dana (a plant admin)
   insert a `profile_grants` row for Ana on Cell 4 under RLS, or does the case rely on the service role?
   Read it. The `finally` blocks: every grant and row restored even when an assertion fails mid-case?
   Does any case leave Sam's Cell 1 efficiency at 0.5 on failure? The three new cases are inserted BEFORE
   the DEF-0063 case -- does the file's serial order (the comment at its top) still hold?
8. **CB-pre-7 and the single sentence.** Unchanged: a readable overlap on a single still goes to the
   writer and the pop-up. Confirm from the diff that `submitCreateDirect`/`useDragGesture.ts` are
   untouched (the lane says so) and that the lane's "single-sentence pop-up has the same defect" claim is
   right from the code (`openSplitPopover` ~l.2691 builds participants from every overlapping row; a
   locked row's adjustment would be refused by `apply_split_coverage`). That is a finding for the plan,
   not this piece.
9. **Runs.** `npx tsc -b` (conclusive: `db:types` unchanged, the lane says; confirm `git diff --stat
   src/lib/database.types.ts` is empty). `npx vitest run --maxWorkers=2 src/test/scaleAudit.test.ts
   src/test/dateSeam.test.ts src/test/commandBar.test.tsx src/test/busyElsewhere.test.ts
   src/test/dragGesture.test.ts src/test/commandConversation.test.ts src/test/commandResolve.test.ts
   src/test/commandLauncher.test.tsx src/test/shapes.test.ts src/test/defects/` -- copy the totals. Do
   NOT run the full `npm run test`. `npx eslint` and `npx prettier --check` over the changed files; if a
   lint or format problem is the only thing wrong in a file, fix that one thing and say so; nothing else.

## Rules

Do not commit. Never `npm run db:reset`, never start or stop containers, never touch the developer's
stack (54321/54322, `supabase_db_production_scheduler`). PowerShell: no `&&`. Read-only psql against the
TESTER's container (`supabase_db_production_scheduler_tester`) is fine; the SQL suite as the runner does
it is fine. Playwright against the tester's stack (env from `node scripts/tester-stack.mjs env` in the
same command, `--workers=1`, foreground) ONLY when a finding needs the browser; put back anything
written. Do not touch `docs/plan.yaml`, `CLAUDE.md`, `docs/defects/**`, `src/test/defects/**`, any
migration.

## Report

Plain prose. Findings first, worst first, each with the file and line, what a person would see go wrong,
and how you know. Then the items above you checked and found sound, one line each. Then every runner's
total line, copied (the SQL suite's three capacity lines and total included). Then your call: ship, or
not, and what must change first.
