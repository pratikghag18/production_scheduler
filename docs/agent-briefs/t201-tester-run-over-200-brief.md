# Tester run 201t, over developer session 200 (commit f7954a9, plan fc7fa1f)

You are the **tester** (`.claude/agents/tester.md` is your role; read it first and follow it in full).
You never fix code. You work in the tester worktree `C:\dev\scheduler-test` on branch `tester`.

## What serves what

- **DEF-0063** (fix-claimed at `f7954a9`), violates R-466; the maintainer's chosen form is **R-469**: the
  replace question names every change its press makes. Two of Sam's blocks, Priya busy for one: "Priya Shah
  is already on Cell 4 in Line 2 today from 6 am to 2 pm, so Sam Patel's 6 am to 2 pm block on Cell 1 cannot
  go to Priya Shah. Take Sam Patel off Cell 1 for both blocks and put Priya Shah on the 6 pm to 8 pm one?
  Nobody would be covering 6 am to 2 pm." button "Take Sam Patel off, place Priya Shah where possible". Both
  busy: "... for both blocks anyway?" and the press removes only. One block: unchanged from 199t.
- **DEF-0064** (fix-claimed at `f7954a9`), violates R-431 and **R-468** (option B, placed in the bar by the
  maintainer in session 200): "1 of 2: Sam Patel is already on Cell 1 today from 6 am to 2 pm. Split Sam Patel's
  time evenly between Cell 1 and Cell 2, or skip Sam Patel?" with "Split evenly" / "Skip Sam Patel" of one
  width. Split writes through apply_split_coverage with even shares (Cell 1 0.5, new Cell 2 0.5); Skip names
  him as not doing and lists the rest; a cancel word drops the lot. A single sentence is unchanged (the board's
  split pop-up). A replace's incoming placement over a readable block asks too; a swap is exempt.
- **F-251**: a test flake traced to the hold timer (`armHoldBound`) not cleared on unmount. Watch whether any
  case in `commandBar.test.tsx` goes red under the full run; report it if one does.
- Left open by the developer, do not file as new unless you find them worse than described: **F-249** (Split
  offered without edit rights on the overlapping block's cell), **F-250** (two steps over one block), **F-252**
  (a lot's move or re-time step with a readable overlap still falls through to the writer), and DEF-0063's
  "sync door" note (a certificate or area gap still refuses the whole replace and its press removes only).
  Do confirm F-249 in the browser as Ana if you can build the shape: if Split is offered and the server then
  refuses after the yes, that is R-431 and should be a defect, whatever its age.
- Session 200 numbers to match: `Tests  4969 passed (4969)` in 191 files, db_checks 937, e2e 62 tests.

## Already done, do not redo

- 199t verified DEF-0061 and DEF-0062; do not re-verify them. The maintainer approved starting the tester
  stack for this one run. Do not ask again.

## The walk, step by step

1. `git status` clean (this brief is the only untracked file, expected). `git merge --ff-only Development`
   (tester at 9ebca19, Development at fc7fa1f). If not a fast-forward, merge normally; a `docs/plan.yaml`
   sessions conflict keeps both, newest first. `npm ci` only if `package-lock.json` changed; check
   `node_modules/.bin/supabase` exists.
2. `docker ps` (never touch containers without `_tester`). `node scripts/tester-stack.mjs up`, then `env` and
   export. Print "Tester stack is UP." on its own line.
3. `node scripts/tester-run.mjs --sql --e2e`. Read the whole report; copy the runners' own total lines. Save
   the SQL lines before any rerun. A flaky e2e: rerun alone, foreground, `--workers=1`.
4. **DEF-0063 cold** as Ana, fresh seed, dev server on `$env:E2E_PORT` `--strictPort`, a one-off Playwright
   script in `test-results/` (uncommitted). Insert Sam's second Cell 1 block (6 pm to 8 pm, as in your
   reproduction), "replace Sam Patel with Priya Shah on Cell 1". Paste the sentence and buttons, measure the
   widths. Press the first button: read back as Dana that exactly the changes the sentence named were written
   (both Sam blocks off, Priya on 6 to 8 pm only). Fresh: "Leave it" writes nothing. Then both-busy (make Priya
   busy over both windows) and one-block, and check the press matches the words each time. Restore data.
5. **DEF-0064 cold** by its own reproduction, and with two certified people (no certificate question). Paste
   the question and the buttons (widths). Split: read back Cell 1 and Cell 2 shares and that no refusal comes
   after the yes. Skip: the listing names Sam as not doing with the reason, the yes writes only Lena. A cancel
   word: nothing written. The single sentence for Sam alone still opens the board's pop-up. Delete test rows.
6. **R-459 / R-431 / R-447 on every new sentence and button**: plain wording (no ISO date, arrow, "lot"), no
   button the server would refuse, each pair one width.
7. **Mutation pass** on scratch edits (restore with `git checkout -- <file>`, tree clean): at least (a) make
   the precheck ignore `overlap` (lot lists as ready again), (b) build the replace question from the refused
   block alone, (c) drop the `split` field in runLot so Split writes an ordinary placement, (d) remove the swap
   exemption's "earlier step" condition. Run only `npx vitest run src/test/commandBar.test.tsx
   src/test/commandResolve.test.ts src/test/dragGesture.test.ts` (and any file the developer added for PB/PC/RB
   cases). Each must go red by name; zero passes means the mutant did not run.
8. **Adversarial pass, one job:** the new split door. Split as Ana when the overlapping block is on a cell she
   can read but not edit (F-249) -- what happens after yes? Split where the existing block is already split
   (shares 0.5/0.5 already)? Split across midnight or across the plant's zone (R-426)? Three people with two
   overlaps (numbering)? A person both uncertified and overlapping? Say what turned up nothing.
9. File new defects from `docs/defects/TEMPLATE.md` from DEF-0065 on, against a requirement id, pins under
   `src/test/defects/` where a unit case can be red. Set `contradicted` on what an open defect violates;
   restore `covered` on R-466, R-468, R-469, R-431 when the defects verify and nothing else holds them (the
   validator wants a non-manual proof: name the developer's CB-ovl / CB-rep / RB cases and typed-walk cases).
10. `node scripts/tester-stack.mjs down`, stop the dev server, `docker ps` no `_tester` container, port 5174
    free. Print "Tester stack is DOWN." on its own line.
11. Session entry `id: 201t` at the top of `sessions`, numbers from the runners, `confirmed: true` only if
    read yourself; `meta.updated: '2026-10-01'`. `npm run plan` green (quote all-digit shas). Commit on
    `tester` with `git commit -F <file>`, plain ASCII prose, no bullets, ending with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. File list from `git status`;
    include this brief.

## Files

- You may write: `docs/defects/*.md` (on the developer's defects only status and appended output),
  `src/test/defects/*`, `docs/plan.yaml`, `docs/plan.html` (via `npm run plan`), this brief. Scratch in
  `test-results/` or the scratchpad, uncommitted.
- Must not touch: anything else under `src/`, `e2e/`, `supabase/`, `scripts/`, `CLAUDE.md`.
- No other lane is running. No throwaway worktrees that share `node_modules` by junction.

## Environment notes

Windows, PowerShell primary, Git Bash available. Never patch text with Get-Content/Set-Content. Text passed
to node as an argument is cut at the first double quote. Playwright in the foreground, one worker.

## Report shape

1. Stack up/down lines and `docker ps` after.
2. Runner total lines (vitest, SQL, e2e) against session 200; any commandBar flake.
3. DEF-0063 and DEF-0064: verified or reopened, with pasted bubbles, button widths and rows read back.
4. Step 6 and F-249: what you saw.
5. Mutations: each mutant and the tests that went red.
6. Adversarial pass: findings, and what turned up nothing.
7. New defects (id, plain-language title, severity), questions for the maintainer (with two candidates side
   by side when it is a choice), and the commit sha.
