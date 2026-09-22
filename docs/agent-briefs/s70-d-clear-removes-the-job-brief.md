# S70-d — a clear removes the jobs beside the people (R-436, first half)

Read R-436, R-407, R-432 and R-434 in `docs/plan.yaml` and CLAUDE.md §4 and §7. The maintainer,
17 Sept: "Unless specified clear means clearing everything." Restated 22 Sept after the spoken
walk left the Bracket A job on Cell 3: "The clear area 1 did not clear the Bracket A assignment,
we talked about this." Today "clear Cell 3 today" / "clear Area 1 today" (the `everyone` unassign
form, R-407) lists and removes every person's block on the place that day and leaves every job
(run) standing.

## The change

1. In `src/lib/command/resolve.ts`, where the `everyone` form expands into the lot of removals
   (grep `expandEveryoneUnassign`), add one command per RUN on the named place that day, after the
   people, each read out as "Removing the <part> job · <path> · <day> · <hours>" (and "· N people"
   when a headcount is set), in board order. The runs come from `ctx.runs` (already in the
   context). A sentence that names a part or says "the operators" / "take everyone off" keeps
   removing only the people (R-436's second clause) -- check what the grammar already carries for
   that; if nothing does, the people-only form is the one that names a part, and say so.
2. The bar runs it: the lot's write path (`runLotNow` in `CommandBar.tsx`, `onRunLot` in
   `BoardPage.tsx`) needs a `delete_run` step. `deleteRun` in `src/lib/api/mutations.ts` exists
   (`delete_run(p_run_id, p_mode)`, cascade removes the run's own assignments); use mode
   `cascade`, and order the lot so the people's removals run first and the jobs' after, so a job's
   cascade never removes a block the lot has already listed as its own step (or list the job only
   and let cascade take its people -- choose the one whose readout tells the truth, and say why).
3. The trace and the thread carry each job removal as its own line (R-434).
4. R-432 is not this lane's: a refused step still leaves the earlier ones in place until the S64
   lot RPC lands. Do not widen into that.
5. Pins: `src/test/commandResolve.test.ts` beside the `everyone` cases (CB-x-1 is in
   `commandBar.test.tsx`): a place with two people and one job lists three, the job last, worded as
   above; a place with a job and nobody lists the job alone (today that reads "has nobody on it" --
   decide whether an empty place with a job is "nobody" or "one job", and pin the choice: the
   maintainer's rule says clear means everything, so the job is listed). In
   `commandBar.test.tsx`, a yes on such a lot calls the delete-run path once per job with the run
   id. Then update `e2e/walk/sentences.ts` entries 21 and 22 ONLY in their expected count comment if
   it names people alone; do not run the walk (the developer runs it).

## Boundaries

- You own: `src/lib/command/resolve.ts` (the `everyone` expansion and its readout only),
  `CommandBar.tsx`'s lot-run path, `BoardPage.tsx`'s `onRunLot`, the two test files, and the
  comment in `e2e/walk/sentences.ts`. Another lane owns `parse.ts`; another owns
  `CommandBar.module.css`, `recognizerHint.ts` and the thread/spoken-answer code in `CommandBar.tsx`
  -- coordinate by touching only `runLotNow` and what it calls. `resolve.ts` may import nothing at
  runtime (commandPurity U1).
- `npx vitest run src/test/commandResolve.test.ts src/test/commandBar.test.tsx
  src/test/commandPurity.test.ts`; `npx prettier --write`, `npx eslint`, `npx tsc -b`. No full
  `npm run test`, no commit, no walk.
- Report: the readout wording, the order chosen and why, the pins, files changed from `git
  status`, runner output verbatim.
