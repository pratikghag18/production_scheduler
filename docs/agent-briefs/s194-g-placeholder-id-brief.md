# Lane brief: S194-G, a row the server has not answered for is never sent to the server (F-233)

You built R-463 and found this while running the walk. It is yours to fix now. R-463 is committed;
the working tree is clean apart from `docs/plan.yaml` and the briefs, which are the main session's.
Nobody else is editing the repository.

## The fault, as you proved it

A create (`useCreateAssignment`, `src/features/board/hooks/useAssignmentMutations.ts` l.47 and
l.109; `useRunMutations.ts` l.50 does the same for a job) puts a row with the id
`optimistic-<uuid>` into the board's query cache and replaces it when a refetch, not awaited,
lands. A sentence said straight after reads the board, finds that row, and sends its id to the
server: `invalid input syntax for type uuid: "optimistic-..."`. In your run "clear Area 1" did 4
of 9 and stopped with "Something went wrong. Please try again."

A person can do this: place someone, then say "clear Cell 1" or "remove her" or drag the new block
before the server has answered. On a slow connection the window is seconds wide.

## The rules it breaks

- R-431: nothing offered that the server refuses. A row with no real id cannot be acted on.
- R-432: the answer after a failure names what was not done and why, in the plant's words. "Something
  went wrong" over a half-done clear is neither.
- CLAUDE.md §4: a write that reports success can have changed nothing; read the row back.

## Decide from the code, then build. Two shapes, pick by what you find:

A. **The placeholder never reaches anything that acts.** The board may DRAW the row at once (that is
   what the placeholder is for), but the index the resolver, the lot runner and the drag read holds
   only rows the server has answered for, or marks the placeholder so every one of them skips it.
   A sentence that names only a placeholder row ("remove Lena" a moment after placing her) then
   WAITS for the row to become real and goes on, within a bound, the way the bar already waits on
   `settled` before a rerun (R-455: read how the bar uses `ctx.settled` and the rerun after a board
   move; that mechanism may already be the right one, with the pending create counted as unsettled).
B. **The create is awaited before the next sentence runs.** The bar does not resolve a new sentence
   while a write of its own is in flight.

Prefer whichever the code already half-does. If `settled` exists and a pending create simply does
not count against it, making it count is the smallest honest fix and covers the bar. The DRAG is a
second door: a person can grab the placeholder chip with the pointer. Check what a drag or a pop-up
opened on an `optimistic-` row does (move, resize, remove, reassign) and close that door too: the
chip is drawn but not yet grabbable, or the action waits.

Whichever you build, no code compares an id against the string "optimistic-" in more than ONE
place: one helper, named, exported, used by the two mutation hooks and by whatever skips or waits.

## Also

- The lot's generic catch printed "Something went wrong. Please try again." Lane D built
  `buildLotOutcome` and `rewriteRefusal` for exactly this; find why this failure did not go through
  them (the error's kind was probably `Unknown` or `InvalidArgument`, which still print raw or
  generic) and make a lot that stops on an unexpected error still name what was done, what was not,
  and what was not tried, with the reason as "Something went wrong with that one." rather than a
  line that names nothing. Do not invent a sentence per error kind.
- Remove the one-second wait you added to the walk between the short block's entry and "clear Area
  1", and its comment. The walk must be green without it; that is the proof of the fix.

## Files you own

`src/features/board/hooks/useAssignmentMutations.ts`, `src/features/board/hooks/useRunMutations.ts`,
`src/features/board/hooks/useDragGesture.ts`, `src/features/board/BoardPage.tsx` (where the board
index and the bar's context are built), `src/features/board/components/CommandBar.tsx`, the board
components that draw a chip only if a placeholder must be drawn differently (do not restyle it
beyond what "not yet grabbable" needs, and say what you did), a new small module for the helper,
the tests beside these, `e2e/typedWalk.spec.ts`, `e2e/walk/sentences.ts`.

## Rules

Do not commit. Never `npm run db:reset`. Write nothing to the maintainer's database. No migration.
Do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`. Do not start or
stop containers. PowerShell runs npm and npx. Never `git checkout -- <file>`. Never patch with
`Get-Content`/`Set-Content`. You may run `e2e/typedWalk.spec.ts` and `e2e/touch.spec.ts` against
the TESTER'S stack only, confirming before every run that `$env:VITE_SUPABASE_URL` is
`http://127.0.0.1:54421` (the one-line setup is in `docs/agent-briefs/s194-f-no-minimum-length-brief.md`).

## Proving it

1. A case that reproduces the fault BEFORE your fix, red, and is green after: a create whose
   response is held back (a deferred promise in the mock), a clear of the same place said while it
   is held, and the assertion that no writer is ever called with an id that is not a real one and
   that the clear ends with the new row removed once the create lands. The same for a job
   (`useRunMutations`). The same for a drag started on the placeholder.
2. Mutation, copy-backed, red by name: the skip or the wait removed.
3. The walk, both lists, each green twice over the same database, WITHOUT the wait. Then, to make
   the race wide: throttle the create's response in the browser (Playwright `page.route` on the
   create call with a delay of two seconds) in ONE new walk entry or a small spec of its own inside
   `e2e/typedWalk.spec.ts`, place, clear at once, and read the database. If throttling cannot be
   done inside this spec, say why.
4. ONE full `npm run test`. Before this lane: `Test Files 3 failed | 181 passed (184)`,
   `Tests 3 failed | 4660 passed (4663)`; the three reds are DEF-0040's pin, DEF-0043's headcount
   pin and DEF-0020's live pin.
5. `npx tsc -b`, eslint, prettier over your files.

## Report

Plain prose. Which shape you built and why. What a person sees if they act on a row before the
server has answered: on the bar, by drag, in a pop-up. Every case added, the mutation, the runner's
totals and the walks' lines copied, what you did not do, and a draft commit message in the repo's
style: plain ASCII, reasoning in prose, no bullets.
