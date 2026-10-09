# Lane brief: S202-A, Split only where the supervisor can change the block, the lot's questions in step order, and the places named once (DEF-0065, DEF-0066, DEF-0067, F-247, F-249)

You are a build lane on the developer's tree (branch `Development`, clean at the tester's merge e3f0356
plus uncommitted edits to `docs/plan.yaml` and `src/test/defects/DEF-0020.test.ts`, which you do not
touch). Nobody else is editing the repository. Read `CLAUDE.md` first (sections 4 and 7 -- section 4's
"Extract, never retype", "a migration ... `db:types`", and "Anything resolved by walking UP the tree is
resolved by the server as a definer" all apply here), then `docs/defects/DEF-0065.md`, `DEF-0066.md`,
`DEF-0067.md`, then in `docs/plan.yaml`: R-468 (its note holds the maintainer's words and today's
decision for DEF-0065), R-431, R-465, R-459, F-247, F-249, and session 200's entry. Then yesterday's
brief `docs/agent-briefs/s200-a-the-lot-asks-split-and-the-replace-says-what-it-does-brief.md` and its
review brief: this piece extends that one; do not redo it.

## Read this first

Browser first, as the tester did (DEF-0065's reproduction adds a read-only grant on Cell 4 for Ana by
psql on the TESTER's database and removes it after; the stack is up on 54421), then red unit and SQL
cases, then the fix, then the browser again with permanent e2e cases. Do not report this piece as done
on unit tests.

## The three defects and the two findings they close

**DEF-0065 (R-431, R-468, R-459; F-249 seen).** Ana can READ a block on Cell 4 (a viewer grant) but not
change it. "put Priya Shah and Maria Lopez on Common Fastener at Cell 1 today from 8 am to 10 am" offers
"Split evenly", lists both Ready, and after the yes the server refuses the split with not_permitted; the
bar prints "You cannot change fc358b68-... from here" (a raw node id) and Maria is never tried. Cause:
`precheckBeforeWrite` (`src/features/board/lib/busyElsewhere.ts`) takes the probe's readable rows to
mean editable; `apply_split_coverage` needs `app_can_edit_node` on every adjusted block's node. And
`rewriteRefusal`'s `NO_EDIT_RIGHTS_REFUSAL` branch (`CommandBar.tsx` ~l.1204-1233) passes the server's
node id through.

THE MAINTAINER'S DECISION (today, from two candidates drawn side by side): a step whose overlapping block
the supervisor can read but NOT change is REFUSED UP FRONT, the R-465 shape, no question:

    Not doing Priya Shah on Cell 1 today 8 am to 10 am: she is already on Cell 4 today from 6 am to
    2 pm, and you cannot change that block from here. Ready to do 1 thing: Maria Lopez is on Cell 1
    today from 8 am to 10 am, making Common Fastener. Say yes to do it, or no.

(Use the person's name where the candidate says "she"; the board holds no pronoun.) Split is offered
only when EVERY overlapping block is one the caller can change. Decided by the server, never the
client: `capacity_probe` says so.

**DEF-0066 (R-468; closes F-247).** Sam booked (overlap), Lena short a certificate, one sentence: the bar
asks "2 of 2: Not done: Lena ..." (the reason, during stepping) BEFORE "1 of 2: Sam Patel is already on
Cell 1 ..." (the overlap, after the probe). F-247 is the same ordering seen from the other side: a step
both uncertified and busy elsewhere is asked its reason, then refused at the listing.

**DEF-0067 (R-468).** A person already on two blocks, one of them on the destination cell: "Split Sam
Patel's time evenly between Cell 1, Cell 2 and Cell 2". The listing's clause de-duplicates; the
question does not.

## What to build

### 1. The server says which overlapping blocks the caller can change (DEF-0065, the SQL half)

A new migration `supabase/migrations/20261002000086_capacity_probe_editable.sql`. `capacity_probe` is
defined LAST in `20260930000085_capacity_counts_every_block.sql` (~l.168-262; `grep -in "function
\(public\.\)\?capacity_probe(" supabase/migrations/*.sql` and take the LAST hit). EXTRACT its body --
slice it out of 0085 with a small node script into your scratch, never retype it -- and add ONE field to
each readable row's `jsonb_build_object` (~l.216-224): `'editable', app_can_edit_node(r.node_id)` (read
how `app_can_edit_node` is declared and called elsewhere -- `grep -in "app_can_edit_node" supabase/
migrations/*.sql`, the LAST definition -- and call it exactly so, as the caller, not as the definer:
`capacity_probe` is SECURITY DEFINER, so check what `app_can_edit_node` reads (`auth.uid()`?) and whether
it answers for the CALLER inside a definer; if it needs the caller's id passed in, pass it the way 0084's
`absence_recordable_people` does). The outside rows (~l.228-236) carry `'editable', false`. Before
writing the file, assert on the assembled text that every guard 0085's body has is still there (the org
boundary, the `fits`/`cap` null answer for an unreadable operator, the `outside` rows) -- DEF-0011 is
what happens otherwise. Update the COMMENT ON FUNCTION to name the new field. Re-emit nothing else.

SQL cases in a new `supabase/tests/99_capacity_probe_editable_test.sql` (read `99_capacity_counts_
every_block_test.sql` for the harness, the demo people and how a role is assumed): as Ana with a viewer
grant on Cell 4 and a supervisor grant on Line 1, a probe for Priya over her Cell 4 hours returns that row
with `editable` false; the same for a block on Cell 1 returns `editable` true; an outside row has
`editable` false; the plant admin sees `editable` true for both. Run the SQL suite the way
`scripts/tester-run.mjs --sql` does (read it; it runs against the TESTER's stack, which rebuilds from
the migrations dir on `up` -- the main session will bring the stack down and up again if your migration
must be applied; say so in the report if you need it, or apply the one file with `psql -f` to the tester's
container yourself and say that you did). Then `npm run db:types` AGAINST THE TESTER'S STACK (the tester
does this: read `scripts/tester-run.mjs` for how it points db:types at `SUPABASE_WORKDIR`) and commit the
regenerated `src/lib/database.types.ts` with the piece. `tsc` is inconclusive until that has run.

### 2. The client reads it (DEF-0065, the bar half)

- `src/lib/api/shapes.ts` `parseCapacityProbeOverlap` (~l.1048-1095): the new `editable` boolean, absent
  from a server older than 0086 -- decide the default (false is the safe one: nothing offered the server
  may refuse) and say so.
- `precheckBeforeWrite` (busyElsewhere.ts): the overlap answer is `overlap` only when every readable
  overlapping row is editable; otherwise a new answer (`kind: "overlap_locked"`, name yours) carrying the
  sentence above, built by the SAME sentence builder with the clause ", and you cannot change that
  block from here" (two blocks: "those blocks"). `refuseBusyLotSteps` treats it exactly as
  `busy_elsewhere`: the step is named "Not doing ...", the rest listed, nothing asked. A single sentence:
  keep today's behaviour (the writer and the pop-up) -- CB-pre-7 -- unless you can show the pop-up's
  Confirm is refused the same way; if so, say what the single should do and DO NOT build it (a question
  for the maintainer, filed in your report).
- `rewriteRefusal`'s `NO_EDIT_RIGHTS_REFUSAL` branch: the captured text is a node id; look it up in
  `lastCtxRef.current.nodeById` and say the cell's NAME ("You cannot change Cell 4 from here."); when it
  is not a known id (another org's node, a stale board) say "You cannot change that block from here."
  Never print a uuid (R-459). Read how `rewriteRefusal` gets at ctx (it may be a pure function today;
  pass the lookup in rather than reach for a ref inside it).

### 3. Questions in step order (DEF-0066, F-247)

The lot resolves its steps synchronously (`resolveLotStepBody`) and asks the certificate/area question
of step k the moment step k resolves to it; the probe (`refuseBusyLotSteps`) runs once, after every step
has resolved, and the overlap questions follow. Restructure so that EVERY question is asked in step
order and the probe runs BEFORE any question:

- Resolve every step first. A step that resolves to a reason question (`not_certified` warn /
  `outside_area`) is resolved PROVISIONALLY for the probe with a placeholder reason, exactly as
  `refusalBeforeAsking` already does for a single (`overrideReason: "-"`); its real question is queued,
  not asked. A step that resolves to any OTHER question (which shift, join, a day off the board) stops
  the stepping there as today -- say in the report which question kinds a lot step can raise and which
  ones you queue; the rule is: a question whose every answer is the same placement is queued; one that
  changes WHAT is placed is asked at once as before.
- Probe all placements together (as today). A step busy elsewhere or overlap-locked is refused and named
  (R-465, DEF-0065 above) BEFORE its reason question is ever asked -- that is F-247 closed; say so and
  pin it (a person both uncertified and busy elsewhere: one "Not doing" line, no reason asked).
- Then ask, in step order: for step k its reason question (numbered "k of N"), then its overlap question
  ("k of N"), then step k+1's. The answers land where they do today (`Lot.stepOptions`, `Lot.overlaps`).
- Then the listing. The trace chain (`traceCarry`) keeps every ask and answer in order.
- CB-lot-ask-*, CB-ovl-*, CB-rep-* and CB-pre-11/12 must stay green; where a case pinned the OLD order
  (a reason question asked before the probe ran) it is the contract that changed (R-468's "numbered as
  the lot's step", R-431) -- say so per case. A reason typed while a lot stands still goes to the
  CURRENT step's question (yesterday's `answerLotReason`).

### 4. The places named once (DEF-0067)

The "between ..." list in the overlap question is the distinct cells, the new one last; two blocks on
one cell read "between Cell 1 and Cell 2" and, when the new step's cell is already in the list, the
sentence makes it plain: "Sam Patel is already on Cell 1 today from 6 am to 2 pm and Cell 2 today from 6
am to 2 pm. Split Sam Patel's time evenly across those blocks and the new one on Cell 2, or skip Sam
Patel?" -- or a plainer form you prefer; write it out in the report. Use the listing clause's own
de-duplication (one builder, R-449).

### 5. The sweep (section 7, duty 2)

Grep the bar and `resolve.ts` for every other sentence that lists places or people from rows without
de-duplicating (`.map(... nodeName)`, `join(", ")`, `joinWithAnd`) and say for each: distinct already,
or fixed, or a defect card's worth.

## Files you own

`supabase/migrations/20261002000086_capacity_probe_editable.sql` (new), `supabase/tests/
99_capacity_probe_editable_test.sql` (new), `src/lib/database.types.ts` (regenerated only),
`src/lib/api/shapes.ts` (the parser field), `src/features/board/lib/busyElsewhere.ts`,
`src/features/board/components/CommandBar.tsx` and its CSS Module, `src/features/board/store/
commandConversation.ts`, `src/features/board/hooks/useDragGesture.ts` only if the precheck's plumbing
needs it (say what), `src/lib/command/resolve.ts` only for a readout/word builder (say what), and the
tests: `src/test/commandBar.test.tsx`, `src/test/busyElsewhere.test.ts`, `src/test/shapes.test.ts` (or
wherever `parseCapacityProbe` is pinned -- grep), `src/test/dragGesture.test.ts`, `e2e/typedWalk.spec.ts`,
`e2e/walk/*`, throwaway specs under `e2e/` that you delete before you report.

## Files you must not touch

Every OTHER migration (append-only; never edit 0085), `src/lib/api/board.ts`, `src/lib/api/mutations.ts`,
`src/features/board/components/SplitCoveragePopover.tsx`, `src/features/board/BoardPage.tsx`,
`src/lib/command/parse.ts`, `src/lib/command/grounded.ts`, `src/features/admin/**`, `src/test/defects/**`,
`docs/defects/**`, `docs/plan.yaml`, `CLAUDE.md`, `playwright.config.ts`, `scripts/**`.

## Rules

Do not commit. Never `npm run db:reset`. Never apply anything to the DEVELOPER's stack (`127.0.0.1:54321`
/ `54322`, container `supabase_db_production_scheduler`): the main session applies the migration there
after the review. PowerShell runs `npm`/`npx` (no `&&`; use `;`). Never patch a file with `Get-Content`/
`Set-Content`; use your Edit tool (and write the migration with the Write tool from text you assembled
and asserted on, never by hand). Never `git checkout -- <file>`. **The tester's stack is UP** (the main
session started it and will stop it); do not run `tester-stack.mjs up`/`down`, start or stop containers.
Set the environment from `node scripts/tester-stack.mjs env` in the same PowerShell command as each
Playwright run; `$env:VITE_SUPABASE_URL` must read `http://127.0.0.1:54421`. ONE Playwright process at a
time, `--workers=1`, FOREGROUND. Put back whatever your browser runs write, including the viewer grant
(three rows, one per plant's "Cell 4" -- the defect card has the exact insert and delete). The voice model
is not served. `npx vitest run --maxWorkers=2 <files>`; do NOT run the full `npm run test`. Ignore `tsc`
errors in files you do not own.

## Proving it

1. What you saw in the browser BEFORE the fix, all three defects, as the thread's lines and the trace's.
2. SQL: the new test file's cases and the whole suite's per-file lines (copied). `db:types` against the
   tester's stack: the diff of `database.types.ts` (the one new field and nothing else beyond a BOM).
3. Unit: `CB-lock-N` (DEF-0065: a locked overlap is refused up front and named with the clause; the rest
   listed; nothing asked; the single sentence unchanged; the refusal rewriter names the cell, never a
   uuid; an unknown id says "that block"); `CB-ord-N` (DEF-0066/F-247: Sam overlap + Lena certificate asks
   "1 of 2" then "2 of 2"; a step both uncertified and busy elsewhere is refused with no reason asked;
   two reason questions and one overlap in step order; the trace chain in order); `CB-ovl-12..` (DEF-0067:
   two blocks one on the destination cell, the sentence as you wrote it; three distinct cells);
   `shapes`: the parser's default and the field; `PB-*`: `precheckBeforeWrite`'s locked answer.
4. Mutations, copy-backed, each red BY NAME then restored: `editable` ignored by the precheck; the probe
   run after the reason questions again; the de-duplication removed; the rewriter printing the id again.
5. In the browser, as Ana, on the tester's stack: DEF-0065's reproduction with the grant (the "Not doing"
   line with the clause, Maria listed, the yes writes Maria only, rows read back, grant removed);
   DEF-0066's sentence (the order of the two questions, the write read back as the tester did: Cell 1 0.5,
   Cell 2 0.5, Lena 1.0, then restored); DEF-0067's (two blocks, the sentence, the write 0.34/0.33/0.33,
   restored); a permanent case for each in `e2e/typedWalk.spec.ts` after the DEF-0064 case (the grant
   added and removed inside the case, through the admin client the file already uses); then
   `npx playwright test e2e/typedWalk.spec.ts --workers=1` twice and once with `$env:WALK_SET = "2"`;
   `e2e/roleWalk.spec.ts` once. Copy each result line and duration.
6. `npx vitest run --maxWorkers=2` over `src/test/commandBar.test.tsx`, `src/test/busyElsewhere.test.ts`,
   `src/test/dragGesture.test.ts`, `src/test/commandConversation.test.ts`, `src/test/commandResolve.test.ts`,
   `src/test/commandLauncher.test.tsx`, the shapes test file and `src/test/defects/`: copy the totals.
   `npx tsc -b` AFTER `db:types` (then conclusive; say so), `npx eslint` and `npx prettier --check` over
   your files.

## Report

Plain prose. What you saw in the browser first. How `app_can_edit_node` answers for the caller inside the
definer, and the assembled body's guards you asserted on. What a person sees now for each defect. Which
question kinds a lot step can raise and which you queue. The sweep's findings, one line each. Every case
added or changed (wrong, or contract changed, with the rule). The mutations' red lines. Every run's
result line and duration, copied; the SQL suite's per-file lines; the `database.types.ts` diff. What you
wrote to the stack's database and put back. What you did not do or could not prove. A draft commit
message in the repo's style: plain ASCII, the reasoning in prose, no bullet lists.
