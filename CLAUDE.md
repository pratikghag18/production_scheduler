# Working in this repo

This file loads in every Claude Code session and makes the ordinary session **the developer**.
The tester is a separate role with its own brief in `.claude/agents/tester.md`. The two never
blur: the developer builds and fixes, the tester judges and files. A personal, gitignored
`CLAUDE.local.md` may add machine-specific notes; nothing here names a person or a machine.

## 1. Start here

1. **`docs/plan.yaml` is the one document you must read.** `sessions[0]` says where things
   stand, `next` is the queue, `requirements` is what the product must do and what proves it,
   `findings` is everything that went wrong before. `docs/plan-format.md` explains the fields.
   `docs/plan.html` is generated from it — open it to read, never edit it.
2. **The defects inbox runs by itself at session start** (`scripts/defects-inbox.mjs`, a
   SessionStart hook in `.claude/settings.json`): it merges the `tester` branch into this one and
   prints every defect in `docs/defects/` whose `status` is `open`, `reopened` or `fix-claimed`.
   Read its output; it is the first thing in your context. If it says the merge was skipped
   (dirty tree) or aborted (conflict), do that merge by hand before anything else — a conflict
   is almost always both sides adding a session entry at the top of `docs/plan.yaml`: keep both,
   newest first, then `npm run plan -- --check`. A filed defect outranks the next queue item
   unless the maintainer says otherwise.
   **Then, before touching any code, tell the maintainer what you found — every time, without
   being asked.** For each open defect, three short lines in plain language: what a person using
   the app would see go wrong, which rule it breaks (the requirement's title, not its id), and
   what the tester suspects the cause is, marked as a suspicion. Then say whether you agree with
   the tester's call. If the folder is empty after the merge, one line: "Merged tester; no open
   defects." Do not start fixing until this has been said; the maintainer is the tiebreaker when
   you and the tester disagree.
3. `docs/design-plan.md` is the archive of _why_. Open it at the `§` or `D` number a plan entry
   cites; do not read it from the top.
4. **Confirm the baseline before touching code:** `npm run test` must report exactly the count
   in the newest `confirmed: true` session. A different number means a test file did not load
   or the plan was not updated; chase that first. Copy the runner's total line, never a number
   you reasoned to.

`docs/roadmap.md` and the old gameplan pages are retired; do not update them.

## 2. The loop with the tester

- **A defect is fixed when its reproduction passes**, not when the code looks right. Run the
  defect's `pin` (`src/test/defects/DEF-NNNN.test.ts`) and its **Reproduction** section yourself.
- When fixed: set the defect's `status: fix-claimed` and `fix_commit: <short sha>` in the same
  commit as the fix. **Never set `verified`** — only the tester does, by re-running its own
  reproduction. If you disagree with a defect, write why in the file under `## Developer note`
  and leave it `open`; do not close it.
- A pin the tester wrote may be **promoted** into the proper test file beside the code once the
  defect is `verified`, in one commit that deletes the copy under `src/test/defects/`.
- Never edit `docs/defects/*.md` beyond `status`, `fix_commit`, and a `## Developer note`.

## 3. Finishing a piece of work — the plan is part of the deliverable

Every coherent piece ends with these, in the same commit or the one after:

1. **`docs/plan.yaml`:** a new entry at the top of `sessions` (date, title, `shipped` stage ids,
   `commits`, `numbers` read from the runners, `confirmed: true` only when you ran `npm run test`
   yourself); the stage's `status`/`state`; any **new requirement** the maintainer stated, as a
   `requirements` row with `stated_by: maintainer`, its `source`, and the test that proves it;
   any defect found on the way as a `findings` card in plain language; `meta.tip` and
   `meta.updated`. Retire by status, never by deleting an id.
2. **`npm run plan`** — it validates and regenerates the page. A red validator is a finished
   piece with a hole in its record; fix the file, not the validator.
3. **Commit.** You commit as you finish each coherent piece; the maintainer pushes. Message in
   the repo's style: plain ASCII, the reasoning in prose, no bullet lists. Build the file list
   from `git status`, never from memory.

A decision the maintainer makes in conversation is a requirement the moment it is made: write
it into `requirements` in that turn, before the code.

## 4. What tends to go wrong here (each cost a defect)

- **A migration that makes a column NULLABLE is a client change `db:types` will not surface.**
  After any `DROP NOT NULL`, grep `src/` for the column and read every parser and guard on it.
- **`tsc` is inconclusive until `npm run db:types` has run** after a migration touches a column
  or an RPC. Say "inconclusive", never "clean".
- **A column list that appears twice is a bug with a delay on it.** Build fixtures from the
  constant; grep for the second copy before adding a column.
- **A screen that shows what the server will refuse is worse than one that refuses what the
  server allows.** Whatever a client hides or offers must be decided by the same test the
  server runs (`isAtOrBelow` on the path, the same predicate as the RLS policy).
- **A write that reports success can have changed nothing** — an RLS-filtered UPDATE or DELETE
  removes zero rows and raises nothing. Read the row back; compare `ROW_COUNT`.
- **A green case can be pinning the bug.** When a fix makes existing cases fail, read those
  cases before touching the fix; say in writing whether they were wrong or the contract changed.
- **`tsc` cannot see a string expectation.** After deleting a concept, grep the tests for its
  words. Adding a file to a directory an audit walks means editing the audit's list in both
  places (`REM_SURFACES` in `src/test/scaleAudit.ts` and its copy in `scaleAudit.test.ts`).
- **Extract, never retype.** `grep -n "function <name>" supabase/migrations/*.sql` and take the
  LAST hit, or `pg_get_functiondef` from the live database.
- **Never `npm run db:reset` while the maintainer is using the app.**
- **Do not stop to report.** Listing what is left is not progress; stop only for a decision
  only the maintainer can make, ask one question, and keep everything else moving. The queue's
  order is a guess about priority, not a fact — ask when it seems to have drifted.
- **Plain language.** Explain in the maintainer's register; when asked for simple terms, draw
  it — a small table, or two candidate answers side by side.

## 5. Parallel agents

Up to three lanes have worked cleanly. Pre-seat the shared files first, give each agent
exclusive named files, and tell each: ignore `tsc` errors in files you do not own; do not run
the full `npm run test`. A different agent than the author reviews the result with one job —
break it — before it is called done.

## 6. Conventions

`docs/conventions.md` for layout and naming. Migrations are append-only. One CSS Module per
component. Nothing committed names the maintainer or the machine. Prettier and ESLint run in
CI over everything they are not told to ignore; `docs/` is ignored by Prettier.
