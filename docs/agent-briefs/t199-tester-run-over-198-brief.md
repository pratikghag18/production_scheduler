# Tester run 199t, over developer session 198 (commit a637947, plan f522e2c)

You are the **tester** (`.claude/agents/tester.md` is your role; read it first and follow it in full).
You never fix code. You work in the tester worktree `C:\dev\scheduler-test` on branch `tester`.

## What serves what

- **DEF-0061** (fix-claimed at `a637947`): a lot of two people where one is short a certificate. Violates
  R-425 and R-432; the maintainer's chosen shape is the new **R-467** (ask that step's reason, take it for
  that step only, carry on, list every step with its reason for one yes; under the block policy name the
  step "Not doing ..." and list the rest).
- **DEF-0062** (fix-claimed at `a637947`): "replace Sam Patel with Priya Shah on Cell 1" with Priya busy on a
  line Ana cannot read. Violates **R-466** and **R-435** (restated 30 Sept: whenever the bar is in any doubt
  or the instruction is unclear, it asks what to do next). Expected: one plain sentence why Priya cannot go,
  then "Take Sam Patel off anyway" / "Leave it", two buttons of one width (R-447), nothing written before the
  press.
- Also in the commit: **F-246** (a lot on a day off the board re-ran only its first step after the board
  moved; now re-runs the whole sentence), the lot writer now passes a step's override/areaOverride (RL-0), a
  swap is refused whole, a copy keeps drop-and-list. **F-248** is OPEN by the developer's own note (two of
  Sam's blocks in the window, Priya busy for only one: the button also places Priya on the other without
  saying so) -- confirm it in the browser and decide whether it is a defect against R-466/R-431 (the button's
  words do not describe what it writes). File it if so.
- Session 198 numbers to match: `Tests  4944 passed (4944)` in 191 files, db_checks 937, e2e 58 tests.
  Session 198 noted CB-rep-1 flaked once under full-suite load; watch for it and report it if it recurs.

## Already done, do not redo

- 197t verified DEF-0060; do not re-verify it, just watch that the suites stay green.
- The maintainer approved starting the tester stack for this one run. Do not ask again.

## The walk, step by step

1. `git status` clean (this brief is the only untracked file, expected). `git merge --ff-only Development`
   (tester at fa8abdf, Development at f522e2c). If not a fast-forward, merge normally; a `docs/plan.yaml`
   sessions conflict keeps both, newest first. `npm ci` only if `package-lock.json` changed. Check
   `node_modules/.bin/supabase` exists (last run it went missing; `npm ci` restores it).
2. `docker ps` (note what else runs; never touch containers without `_tester`). `node
   scripts/tester-stack.mjs up`, then `env` and export what it prints. Print "Tester stack is UP." on its own
   line.
3. `node scripts/tester-run.mjs --sql --e2e`. Read the whole report. Copy the runner's own total lines. Save
   the SQL lines before re-running anything (Playwright deleted the report last time). Flaky e2e: re-run that
   spec alone in the foreground with `--workers=1`.
4. **DEF-0061 cold, by its own Reproduction**, as Ana, fresh demo seed, dev server on `$env:E2E_PORT`
   `--strictPort`, a one-off Playwright script in `test-results/` (uncommitted). Both orders (Lena first, Sam
   first), with 2026-10-13 / 2026-10-14 as in the reproduction (day off the board, F-246). Answer with the
   reason, then the yes. Read rows back as Dana: Lena's row has eligibility_override and the reason, Sam's
   has neither. Also try "no" at Lena's question (what happens to Sam?) and a reason then "no" at the final
   yes (nothing written). Delete your test rows afterwards. Green: `verified`. Red: `reopened`, paste output
   below the old.
5. **DEF-0062 cold**, as Ana: "replace Sam Patel with Priya Shah on Cell 1" today in Priya's Cell 4 hours.
   Paste the sentence and buttons. Press "Leave it": nothing written (read back). Fresh state, press "Take Sam
   Patel off anyway": Sam's block gone, nothing for Priya, readout says so plainly. Check the two buttons
   share one width (measure bounding boxes). Then the certificate door: a replace whose incoming person is
   short a certificate (e.g. Lena into Cell 2) asks the same question shape rather than "Nothing changed.".
   A swap with a busy person is refused whole. Restore Sam's block if your walk removes it (or reseed).
6. **F-248** in the browser as described above; file or not, with the reason in your summary.
7. **R-459 / R-431 / R-447 on every new sentence and button**: plain supervisor wording (no ISO dates, arrows,
   internal words like "lot"), no button that the server would refuse, buttons in one group same width.
8. **Mutation pass** on scratch edits (restore with `git checkout -- <file>`, tree clean after): at least
   (a) drop `coupled` handling so a replace shrinks again, (b) stop passing a step's override in the lot writer
   in `useDragGesture.ts`, (c) make the lot reason path fall back to the held single. Run only
   `npx vitest run src/test/commandBar.test.tsx src/test/commandResolve.test.ts src/test/dragGesture.test.ts`.
   Each must go red by name; a mutant with zero passes did not run.
9. **Adversarial pass, one job:** the new question doors in `CommandBar.tsx` and `resolve.ts`. Is there a
   lot shape that still shrinks quietly (three people; a person short a certificate AND busy elsewhere; the
   area rule; a copy whose one step is short a certificate; "move" instead of "replace")? Does "Take X off
   anyway" ever appear when the removal itself would be refused (Ana cannot edit the place)? Say what turned up
   nothing.
10. File new defects from `docs/defects/TEMPLATE.md` from DEF-0063 on, against a requirement id, pins under
    `src/test/defects/` where a unit case can be red. Set `contradicted` on what an open defect violates;
    restore `covered` on R-466, R-435, R-467, R-425, R-432 when the defects verify and nothing else holds
    them (the validator may want a non-manual proof: name the developer's CB-lot-ask / CB-rep cases and the
    typed-walk case).
11. `node scripts/tester-stack.mjs down`, stop the dev server, `docker ps` shows no `_tester` container, port
    5174 free. Print "Tester stack is DOWN." on its own line.
12. Session entry `id: 199t` at the top of `sessions`, numbers from the runners, `confirmed: true` only if
    read yourself; `meta.updated: '2026-10-01'`. `npm run plan` green (quote all-digit shas). Commit on `tester`
    with `git commit -F <file>`, plain ASCII prose, no bullets, ending with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. File list from `git status`;
    include this brief.

## Files

- You may write: `docs/defects/*.md` (your own fields; on the developer's defects only status and appended
  output), `src/test/defects/*`, `docs/plan.yaml`, `docs/plan.html` (via `npm run plan`), this brief.
  Scratch in `test-results/` or the scratchpad, uncommitted.
- Must not touch: anything else under `src/`, `e2e/`, `supabase/`, `scripts/`, `CLAUDE.md`.
- No other lane is running. Do not make throwaway worktrees that share `node_modules` by junction.

## Environment notes

Windows, PowerShell primary, Git Bash available. Never patch text with Get-Content/Set-Content. Text passed
to node as an argument is cut at the first double quote. Playwright in the foreground, one worker.

## Report shape

1. Stack up/down lines and `docker ps` after.
2. Runner total lines (vitest, SQL, e2e) against session 198.
3. DEF-0061 and DEF-0062: verified or reopened, with pasted bubbles and rows read back.
4. F-248 and step 7: what you saw.
5. Mutations: each mutant and the tests that went red.
6. Adversarial pass: findings, and what turned up nothing.
7. New defects (id, plain-language title, severity), questions for the maintainer, and the commit sha.
