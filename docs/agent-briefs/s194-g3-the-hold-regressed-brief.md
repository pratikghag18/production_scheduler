# Lane brief: S194-G, third pass -- the second pass broke the bar after every create (F-233)

Nothing of S194-G is committed. Nobody else is editing the repository. The unit suite is green
(4699 passed, the three known reds) and the app is broken: that is the lesson of this pass.

## What the main session ran, and what it saw

Both walk lists on the tester's stack, one worker. Both FAIL, each at the first sentence said after
a create. List 1, full output in `%TEMP%\claude\walk-g2.txt`:

    SAY: Assign Priya Shah to Area 2 Frame A on Cell 5 in Line 3 2026-10-05 for shift 3
    BAR: Priya Shah is on Cell 5 Mon Oct 5 from 10 pm to 6 am, making Area 2 Frame A.
    SAY: clear Cell 5 2026-10-05
    BAR: The board is still saving your last change. Say it again in a moment.

The walk waits for Priya's row to be IN THE DATABASE before it says the next sentence. So the
create had long since answered, the row was real, and the bar still held the next sentence for
five seconds and refused it. In the real app, after a person places anyone, the next thing they
say is refused. Each walk took over four minutes where it takes thirty seconds.

The cause is almost certainly the count proxy (`awaitingRowCountRef`: wait until
`ctx.assignments.length` or `ctx.runs.length` has grown). A count is not the row. Find which of
these it is, and say so in your report: the snapshot is taken after the placeholder or the row is
already counted; the placeholder is filtered from `ctx` so the count never moves the way the code
expects; the walk day is not in the board's window so the new row is not in `ctx` at all; a night
block (22:00 to 06:00) lands in a day the window counts differently; or another row left the count
in the same render. Whatever it is, the proxy goes. **Do not repair the proxy.**

## Build the exact mechanism. No proxy, no timer standing in for a fact.

1. **The mutation's promise settles when the board's data holds the real row.** In the three
   create sites (`useAssignmentMutations.ts` two, `useRunMutations.ts` one) the refetch after a
   write is fired and not awaited. Return it: in React Query, `onSettled` returning the
   `invalidateQueries` promise keeps the mutation pending until the refetch has landed. Then for
   the whole life of the mutation the cache holds either the placeholder or the real row, and
   "a create is pending" is simply "a create mutation is pending". Check what else awaits these
   mutations (the pop-ups close on success; the lot runner awaits each step) and that nothing now
   waits visibly longer than before in a way a person would notice; say what you found.
2. **The writers answer the id of the row they made.** `PopupResult` / `WriteOutcome` in
   `src/features/board/store/commandConversation.ts` IS in your fence (it was in the first G
   brief's list by way of CommandBar's store; if you read it as outside, it is inside now, stated
   here). A create answers `{ id }` of the real row; the RPCs already return it
   (`create_run` returns `run.id`; read what `create_assignment` returns).
3. **The bar waits for that id, and only that.** After its own create, the bar holds later
   sentences until `ctx.assignments` or `ctx.runs` contains the id the writer answered, or the
   writer refused (then nothing is awaited), or the bound passes. For a write that creates nothing
   (move, remove, retime, headcount), the bar holds until the writer's promise has settled, which
   after item 1 means the refetch has landed, and `ctx` has been handed down once since.
4. **A row outside the board's window.** A sentence can create a row the board will never show
   (another day: the bar moves the board first today, R-455, but check a copy to another week, a
   repeat over next week, a lot whose rows span days). If the id can legitimately never appear in
   `ctx`, waiting for it is a five-second refusal for ever, the fault you have now. Decide from the
   code: either the wait applies only when the row's day is inside the window `ctx` covers, or the
   wait is for the refetch alone. Say which and prove it with a case.
5. The queue, Escape, the "Working…" status, the trace posted at the hold, and the bound's sentence
   from the second pass stay as built.

## The sentence dropped by a second Enter -- prove it, do not fix it

You reported that a second Enter aborts the first sentence while it is still being read (S44-b),
silently, and that this is why the throttled spec gave 8 of 10 at 200 ms. Whether the bar should
do that has been put to the maintainer. Your job here is to PROVE it is the cause, not to change
it: a case in `src/test/s194fgReview.test.tsx` where a `Reader` that resolves late is aborted by a
second submit, asserting what the first sentence's turn and trace entry hold afterwards (R-434
says a turn and an entry with an outcome; record what is actually there). Then make the throttled
spec immune to it WITHOUT weakening what it proves: it waits until the first sentence's turn shows
its written line before it says the second, which still lands inside the throttled create's
window because the throttle is on the network response, not the bar. If that ordering cannot be
had (the written line appears only after the response), say so and describe what the spec can
prove instead.

## Proving it -- on the real app, not only in units

The second pass reported green on units and did not run the walks because the machine was short
of memory. The machine has about 2 GB free. Run ONE Playwright process at a time, `--workers=1`,
and nothing else heavy beside it; use `npx vitest run --maxWorkers=2` for the unit suite.

1. A unit case that reproduces TODAY'S regression, red before the fix: a create whose row is real
   and in `ctx`, then a second sentence, which must run at once and not be held.
2. Walk list 1, then list 2, each TWICE over the same database. Each should take about thirty
   seconds; a walk that takes minutes is holding sentences and is a failure even if it passes.
   Report the duration of each.
3. The throttled spec, `--repeat-each=10`, at 2000 ms and at 200 ms. Ten of ten, both.
4. The touch spec and `e2e/roleWalk.spec.ts` once each (you may run roleWalk for this pass; it only
   reads).
5. Mutations, copy-backed, red by name: the awaited refetch; the id returned; the wait for the id;
   the rule from item 4.
6. The full unit suite once, two workers. `npx tsc -b`, eslint, prettier.

If the harness stops a run for memory again, stop, report exactly what ran and what did not, and
do not report the work as proven.

## Rules

Unchanged: do not commit; never `npm run db:reset`; write nothing to the maintainer's database; no
migration; do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`; do
not start or stop containers; Playwright only against the tester's stack, confirming the 54421
address before every run; never `git checkout -- <file>`; never patch with
`Get-Content`/`Set-Content`.

## Report

Plain prose. What exactly made the count proxy fail. What you built, item by item. What a person
sees after placing someone and speaking at once, and after placing someone and speaking ten
seconds later. The proof that a second Enter drops the first sentence, and what is left in the
thread and the trace. Every run's result line and duration, copied. The mutations. What you did
not do. A draft commit message in the repo's style: plain ASCII, reasoning in prose, no bullets.
