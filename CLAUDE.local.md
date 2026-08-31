# Resume context for this project (personal — gitignored, not shared)

This file loads automatically every Claude Code session. It carries the context that used
to live in the Cowork memory. **Start here, then read the brief.**

## 1. First, read the resume brief and follow it

`_delivery/cowork-memory/restart-prompt.md` is the session-18 resume prompt (it also lives at
`_delivery/restart-prompt.md`). Read it and do what it says.

## 2. Where the referenced memory lives

The brief tells you to "read `MEMORY.md`, then `session_state_aug28.md`". Those are NOT at the
repo root — they are snapshots copied out of Cowork's memory into:

    _delivery/cowork-memory/

Read in this order:

1. `_delivery/cowork-memory/session_state_aug28.md` ← THE resume point, read first
2. `_delivery/cowork-memory/MEMORY.md` ← index of every other note
3. any `[[link]]` the above point at → the matching file in `_delivery/cowork-memory/`

Then the in-repo docs the brief names: `docs/roadmap.md` (NEXT item 1(b)) and
`docs/design-plan.md` §19.74–§19.76.

⚠️ These cowork-memory files are a SNAPSHOT taken 2026-08-31. They do not update themselves.
Treat the live repo (`.git/refs/heads/Development`, `git status`, the actual source) as the
authority over any number in them.

## 3. What is different now that you run locally (vs the old Cowork sessions)

The memory files were written for a cloud session that reached this machine over a bridge and
COULD NOT run the test suite. You are running on the machine directly, so:

- **You CAN run `npm run test` (vitest), `npm run db:types`, `tsc`, `eslint`, `npm run build`
  yourself.** Where a memory note says "vitest cannot run / ask the maintainer for the count /
  typecheck is inconclusive over the bridge", that limitation is GONE for you — run it and read
  the real output. (Confirm the baseline yourself: the brief predicts 1149 tests in 28 files but
  says it was never confirmed. Run `npm run test` and check.)
- Docker, `supabase start` and `npm run dev` are expected to be running already.

## 4. How the maintainer wants to work (these each cost a defect to learn — keep them)

- **Git is run by the maintainer, not by you.** Hand over a copy-pasteable commit block; don't
  run `git commit`/`git push` yourself unless asked.
- **The shell is PowerShell. There is NO `\` line continuation and `&&` is a syntax error.**
  Write one `git add` per line with every path on that line; separate commands on their own lines
  or with `;`. Multi-line quoted `-m "..."` messages are fine.
- **Build the commit block from `git status`, not from memory** — last time that was short by
  13 real files.
- **Nothing committed to the repo names the maintainer or the machine** — the convention is
  "the maintainer" and `<repo root>`. (This file and `_delivery/` are personal and gitignored,
  so they are exempt.)
- **`tsc` is inconclusive right after a migration changes a column until `npm run db:types`
  regenerates `src/lib/database.types.ts`.**
- **A migration that makes a column NULLABLE is a CLIENT change `db:types` will NOT surface** —
  after any `DROP NOT NULL`, grep the client for the column and read every guard on it.
- **`tsc` cannot see a string expectation** — after deleting a concept, grep the tests for its
  words.
- **`_delivery/` is gitignored** — it holds the plan-of-record `schedulerbuildout.html` and this
  memory snapshot, and it lives on disk only.
- **Explain in plain language, not jargon.** Don't stop unless you need the maintainer to do
  something or want an opinion.

## 5. Keeping this snapshot honest

If you materially change project state, update `_delivery/cowork-memory/session_state_aug28.md`
(or add a newer `session_state_*.md`) so the next session resumes from the truth, the same way
the Cowork sessions did.
