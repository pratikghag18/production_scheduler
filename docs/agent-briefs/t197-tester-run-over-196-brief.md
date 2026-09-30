# Tester run 197t, over developer session 196 (commit a6b1454)

You are the **tester** (`.claude/agents/tester.md` is your role; read it first and follow it in full).
You never fix code. You work in the tester worktree `C:\dev\scheduler-test` on branch `tester`.

## What serves what

- Serves **DEF-0060** (fix-claimed at `a6b1454`), which violates **R-465** and **R-431** ("Nothing
  offered that the server refuses": the bar refuses before the yes, never after). Also serves **F-239**
  (the live line said as done before the server answered), fixed in the same commit.
- Developer session `196` in `docs/plan.yaml` (on `Development`) states the numbers you must match:
  `Tests  4921 passed (4921)` in `191` files, db_checks 937, e2e 58 tests (52 passed, 6 skipped).

## Already done, do not redo

- Session 196t (yours, previous run) verified all ten of session 195's defects. Do not re-verify them;
  just watch that nothing regresses in the suites.
- The maintainer has approved starting the tester stack for this one run. Do not ask again.

## The walk, step by step

1. `git status` must be clean. `git merge --ff-only Development` (tester is at f0f4a4b, Development at
   62c4193; the fast-forward should be clean). If it is not a fast-forward, merge normally; a conflict in
   `docs/plan.yaml` sessions is kept both-sides, newest first. `npm ci` only if `package-lock.json` changed
   (`git diff --name-only f0f4a4b HEAD -- package-lock.json`).
2. `node scripts/tester-stack.mjs up`, then `node scripts/tester-stack.mjs env` and export what it prints.
   Print one line on its own: "Tester stack is UP." Check `docker ps` first; the Docker VM is ~7.5 GB, so
   note what else is running. Never touch the developer's stack (containers without `_tester`).
3. `node scripts/tester-run.mjs --sql --e2e`. Read the whole report in `test-results/`. The vitest total
   must equal 4921 in 191 files exactly; copy the runner's own line. If Playwright is flaky under memory
   pressure, rerun the e2e alone in the foreground with `--workers=1`.
4. **DEF-0060, cold, by its own Reproduction** (in `docs/defects/DEF-0060.md`), in the running app as
   **Ana** (Line 1 supervisor), on a fresh demo seed, dev server on `$env:E2E_PORT` with `--strictPort`.
   Drive it with a one-off Playwright script in the scratchpad or `test-results/` (not a committed spec),
   type both sentences, press both answers on sentence 2 if a question still appears, and paste the
   thread's bubbles and the trace entry into the defect as the evidence. Expected: exactly one board bubble
   "Not done: Priya Shah is already on Cell 4 in Line 2 today from 6 am to 2 pm.", no readout before it, no
   join question, trace outcome refused. Read Priya's blocks back from the database afterwards (still one
   that day). Green: `status: verified`, keep `fix_commit`. Red: `status: reopened` and paste the new
   output below the old; do not reword the old.
5. **Judge the new claims, as Ana, not as the company admin:**
   - A lot (several placements in one sentence) where one step is busy on another line: is the busy step
     named "Not doing ...", are the rest listed, and does it follow R-432 (done / not done, every untried
     step named)? The developer says this is unit-only; prove it in the browser.
   - "Working…" while a write is in flight, and the trace entry outcome "writing" then its final outcome.
     The developer says a slow refused write is unit-only; try to make a write slow or refused in the
     browser (e.g. throttle with Playwright route delay on the RPC) and check the line never says done
     before the server answers.
   - The override's "The reason given: ..." suffix reappears on the written readout.
   - Anything the bar now refuses up front that the server would ALLOW (stale refusal): e.g. a person busy
     on another line only for a non-overlapping span, or a probe that fails (network error) -- the
     developer says a failed probe says nothing and the server's write is the gate. Check that.
   - Every sentence reads as a supervisor would say it (R-459): no ISO dates, no arrows, no internal words.
6. **Mutation pass** on a scratch copy (never commit): at least remove the precheck call in
   `src/features/board/components/CommandBar.tsx` and flip the overlap check in
   `src/features/board/lib/busyElsewhere.ts`; run only the relevant files
   (`npx vitest run src/test/commandBar.test.tsx src/test/busyElsewhere.test.ts`). Something must go red by
   name. Restore with `git checkout -- <file>` and confirm `git status` is clean.
7. **Adversarial pass, one job:** the new precheck in the drag hook (`useDragGesture.ts`) and
   `busyElsewhere.ts`. Can a question still be asked whose SOME answers are placements and others are not,
   so the precheck is skipped? Is there a door into the writer that does not pass the precheck (drag on the
   board itself, the operator rail, a pop-up answer)? Say explicitly what turned up nothing.
8. File any new defect from `docs/defects/TEMPLATE.md` with the next number (DEF-0061 onward), against a
   requirement id, with a pin under `src/test/defects/` when a unit case can be red. Set `contradicted` on
   every requirement an open defect violates; restore to `covered` those DEF-0060 made contradicted if it
   verifies and nothing else holds them.
9. `node scripts/tester-stack.mjs down`, stop the dev server, `docker ps` shows no `_tester` container.
   Print one line on its own: "Tester stack is DOWN."
10. Session entry `id: '197t'` at the top of `sessions`, `title: "Tester run ..."` in the repo's style,
    numbers copied from the runners, `confirmed: true` only if you read them. Update `meta.updated`.
    `npm run plan` must be green (quote all-digit shas in YAML). Commit on `tester` with `git commit -F
    <file>` (message file in the scratchpad), plain ASCII prose, no bullets, ending with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Build the file list from
    `git status`. Include this brief file in the commit.

## Files

- You may write: `docs/defects/*.md`, `src/test/defects/*`, `docs/plan.yaml`, `docs/plan.html` (via
  `npm run plan` only), this brief. Scratch scripts go in `test-results/` or the scratchpad, uncommitted.
- You must not touch: anything else under `src/`, `e2e/`, `supabase/`, `scripts/`, `CLAUDE.md`.
- No other lane is running. The developer's worktree is elsewhere; do not touch it or its stack.

## Environment notes

- Windows, PowerShell primary; Git Bash available. Do not patch text with Get-Content/Set-Content (it
  re-encodes). Text passed to node as an argument is cut at the first double quote.
- Playwright in the foreground, one worker.

## Report shape (your final message)

1. Stack up/down lines and `docker ps` after.
2. The runners' own total lines (vitest, SQL, e2e) and whether they match session 196.
3. DEF-0060: verified or reopened, with the pasted bubbles.
4. Each claim in step 5: what you did, what you saw.
5. Mutations: each mutant and the test names that went red.
6. Adversarial pass: findings, and what turned up nothing.
7. New defects filed (id, one-line plain-language title, severity), and the commit sha.
