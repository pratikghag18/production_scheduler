# Tester run 203t, over developer session 202 (commits 586d921, b94a196; plan 2e00c57)

You are the **tester** (`.claude/agents/tester.md` is your role; read it first and follow it in full).
You never fix code. You work in the tester worktree `C:\dev\scheduler-test` on branch `tester`.

## What serves what

- **DEF-0065** (fix-claimed at `b94a196`), violates R-431, R-468, R-459: Split was offered on a block Ana can
  read but not change, then refused after the yes with a raw node id. The maintainer chose (session 202, written
  into R-468's note): **refuse that step up front**, R-465's shape, with the clause "and you cannot change that
  block from here"; the rest of the lot listed. The server now says which overlapping blocks the caller may
  change: **migration 0086** re-emits `capacity_probe` with an `editable` field, extracted from 0085.
- **DEF-0066** (cosmetic): the lot's questions now come in step order (resolve every step, probe once, ask in
  order). Also claimed to close **F-247** (a person uncertified AND overlapping).
- **DEF-0067** (cosmetic): each place named once in the split question.
- **F-253** (586d921): DEF-0020's live pin retries once on a cold edge runtime. Watch it in the first full run.
- **F-255**: the developer's stack was found two migrations behind. Not yours to fix; just note your stack's
  migration count after the rebuild (must be 86).
- Session 202 numbers to match: `Tests  4986 passed (4986)` in 191 files; db_checks 944 per the plan, BUT the
  developer says their hand tally and your runner count differently (937 + 7 new); **your runner's sum is the
  number to trust** -- report it and say plainly whether 944 matches.  e2e 65 tests.

## Already done, do not redo

- 201t verified DEF-0063 and DEF-0064. The maintainer approved starting the tester stack for this one run,
  rebuilt fresh with 0086. Do not ask again.

## The walk, step by step

1. `git status` clean (this brief is the only untracked file, expected). `git merge --ff-only Development`
   (tester at e3f0356, Development at 2e00c57). If not a fast-forward, merge normally. `npm ci` only if
   `package-lock.json` changed; check `node_modules/.bin/supabase` exists.
2. `docker ps` (never touch containers without `_tester`). `node scripts/tester-stack.mjs up`; make sure the
   stack's database is rebuilt from the migrations so 0086 is applied (read the script's subcommands; a reset of
   the TESTER stack only is fine). Confirm with a query that `capacity_probe`'s definition contains `editable`.
   Then `env` and **export every variable it prints in the same shell you start the dev server and Playwright
   from**. Last run the dev server briefly pointed at the developer's database because the variables were not
   exported: before any walk, print `$env:VITE_SUPABASE_URL` and confirm it is the tester's port. Print "Tester
   stack is UP." on its own line.
3. `node scripts/tester-run.mjs --sql --e2e`. **Copy the report file to the scratchpad immediately** (Playwright
   cleared `test-results/` last time). Copy the runners' own total lines. A flaky e2e: rerun alone, foreground,
   `--workers=1`. Last run roleWalk R-465 (Ana's rail said "free" for Priya instead of "booked") flaked under six
   workers; if it reds again, report it as a repeated flake with both outputs -- twice is a pattern worth a finding.
4. **Migration 0086, adversarially** (the riskiest change): diff it against the last prior definition of
   `capacity_probe` (`grep -in "function \(public\.\)\?capacity_probe(" supabase/migrations/*.sql`, take the
   two LAST hits) and confirm the only changes are the editable flag and its keys -- the definer, the pinned
   search_path, the company boundary, the blind answer for an operator the caller cannot read must all survive
   (DEF-0011 is the story of a dropped guard). Ask: can `editable` leak anything about a block outside the
   caller's company or grant beyond what R-465 allows (place and hours only)? Is `editable` computed for the
   CALLER (auth.uid()) and not the definer? Run the new SQL file and read its cases: could they pass with the
   flag hard-coded true?
5. **DEF-0065 cold** by its own reproduction (the read-only grant on Cell 4 for Ana on the TESTER database only;
   remove it after). Expected: no Split offered for Priya; one plain refusal naming the place and hours and "you
   cannot change that block from here", Maria listed and written on the yes, no raw id anywhere. Also the
   opposite direction (stale refusal): with Ana able to edit the block, Split IS still offered and writes. Rows
   read back as Dana.
6. **DEF-0066 and DEF-0067 cold** by their reproductions; F-247's shape (uncertified and overlapping) too.
7. **R-459 / R-431 / R-447** on every new sentence and button.
8. **Mutation pass** on scratch edits (restore with `git checkout -- <file>`, tree clean): (a) ignore
   `overlap_locked` in the bar, (b) return `editable` true always in a scratch copy of the SQL test's function
   (or point out which SQL case would catch it), (c) revert the step-order queue to ask-as-stepping, (d) drop the
   place de-duplication. Run only the relevant vitest files. Each must go red by name.
9. **Adversarial pass** beyond 0086: a lot where BOTH people overlap, one lockable and one not; a replace whose
   incoming person's overlap is locked; a single sentence (the board pop-up) over a locked block -- is Split
   offered there (the pop-up door, older)? Say what turned up nothing.
10. File new defects from DEF-0068 on, against a requirement id, pins under `src/test/defects/` where a unit
    case can be red. Set statuses: `contradicted` for what an open defect violates; `covered` back on R-431,
    R-459, R-468 when the defects verify and nothing else holds them.
11. `node scripts/tester-stack.mjs down`, stop the dev server, `docker ps` no `_tester` container, port 5174
    free. Print "Tester stack is DOWN." on its own line.
12. Session entry `id: 203t` at the top of `sessions`, numbers from the runners, `confirmed: true` only if read
    yourself; `meta.updated: '2026-10-02'`. `npm run plan` green (quote all-digit shas). Commit on `tester`
    with `git commit -F <file>`, plain ASCII prose, no bullets, ending with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. File list from `git status`;
    include this brief.

## Files

- You may write: `docs/defects/*.md` (on the developer's defects only status and appended output),
  `src/test/defects/*`, `docs/plan.yaml`, `docs/plan.html` (via `npm run plan`), this brief. Scratch in the
  scratchpad, uncommitted.
- Must not touch: anything else under `src/`, `e2e/`, `supabase/`, `scripts/`, `CLAUDE.md`. Never the
  developer's database or containers.
- No other lane is running.

## Environment notes

Windows, PowerShell primary, Git Bash available. Never patch text with Get-Content/Set-Content. Text passed
to node as an argument is cut at the first double quote. Playwright in the foreground, one worker.

## Report shape

1. Stack up/down lines, migration count, `docker ps` after, and the URL the dev server pointed at.
2. Runner total lines (vitest, SQL, e2e) against session 202; DEF-0020 and roleWalk behaviour.
3. Migration 0086 review: what survived, what changed, what could leak.
4. DEF-0065, DEF-0066, DEF-0067 (and F-247): verified or reopened, with pasted bubbles and rows read back.
5. Mutations: each mutant and the tests that went red.
6. Adversarial pass: findings, and what turned up nothing.
7. New defects (id, plain-language title, severity), questions for the maintainer (two candidates side by side
   when it is a choice), and the commit sha.
