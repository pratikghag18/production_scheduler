# Lane brief: S194-G, second pass -- the hold is not reliable, and it is silent (F-233)

The reviewer broke your fix. Its cases are in `src/test/s194fgReview.test.tsx` (12, all green,
several of them DOCUMENTING behaviour that is wrong: read each one's name and comment). Nothing of
S194-G is committed. Nobody else is editing the repository.

## Finding 1, the one that matters most: the fix works on some runs and not on others

Your throttled spec in `e2e/typedWalk.spec.ts` ("F-233: a create held back two seconds, then
cleared at once") PASSED three times on the main session's runs and FAILED twice on the
reviewer's, unmodified, at the committed 2000 ms delay, on the same tester's stack:

    Assign Sam Patel to Housing A on Cell 1 in Line 1 from 5am to 6am 2026-10-05
    clear Cell 1 2026-10-05
    BAR: Cell 1 has nobody on it Mon Oct 5.

The clear wrote nothing and told the person a cell was empty while they had just put someone on
it. A proof that passes on some runs is DEF-0045's shape again. Do not make the spec pass; find
why the app answers wrongly, and make that impossible.

The main session's hypothesis, to test first and discard if wrong: `hasPendingCreate` is derived
from the query cache, and the placeholder enters the cache in the mutation's `onMutate`, which
awaits `cancelQueries` before it writes the row. Between the bar calling the writer and the
placeholder existing there is a gap, and after the placeholder is swapped out there may be a second
gap before the refetched row is in `ctx`. A sentence submitted in either gap sees
`hasPendingCreate === false` and a board with NEITHER the placeholder (filtered) NOR the real row.
The prop also has to travel through a render before the bar's ref sees it.

If that is the cause, the signal is in the wrong place. The bar KNOWS it has asked for a write and
not yet seen the result on the board: it called the writer itself. So:

- The bar counts its own writes in flight, from the moment it calls a writer (synchronously, before
  any await) until the board it is handed reflects the result: for a create, until the row the
  server answered with is in `ctx`; for any write, at least until the writer's promise settles AND
  the refetch it triggers has landed. Read how the writers the bar is given (`onAssign`, `onBook`,
  `onRunLot` and the rest) report back today; if they return the created row's id, waiting for that
  id to appear in `ctx.assignments` / `ctx.runs` is exact. If they return nothing, make them return
  it. Do not guess with a timer.
- Writes made by DRAG or a pop-up are not the bar's. Keep the cache-derived `hasPendingCreate` for
  those, and close its first gap: the hooks mark a create as pending synchronously when `mutate` is
  called, not inside an awaited `onMutate`. One small store or ref in `optimisticId.ts`'s module,
  counted up at the call and down in `onSettled` AFTER the refetch lands, is enough; say what you
  built.
- Prove the cause before you fix it: a case that submits the second sentence in the first gap, and
  one in the second gap, each red before and green after. Then run the throttled spec TEN times in
  a row on the tester's stack (`--repeat-each=10`) at 2000 ms, and ten at 200 ms (a short delay
  widens the second gap relative to the first). Ten of ten, both. Paste the lines.

## Finding 2: a second sentence drops the first for ever

`pendingUnsettledRef` is one slot. A second held sentence overwrites it; the first never runs and
its turn in the thread stays with no outcome, reading as if the board were still thinking. Held
sentences are a QUEUE, run in the order they were said, each to its own outcome, each with its own
trace entry closed. If the first one ends on a standing question (a which-block question, "Ready to
do N things"), the ones after it do what they would do today if typed while a question stands:
read the existing rule (F-162, the reviewer names it) and keep it; do not invent a new one.

## Finding 3: Escape does not cancel a held sentence

Escape, and a typed cancel word, drop every held sentence that has not started, write nothing, and
close each trace entry with outcome cancelled (the way `cancelStanding` does). A typed "yes" or
"no" while something is held and nothing is standing is not an answer to anything: today's rule
for a bare yes with nothing standing applies (CB-yes-8), and the held sentence is NOT dropped by it.

## Finding 4: the hold is silent

While a sentence is held the bar shows the status it already shows while one of its own writes is
in flight (find it: the word it uses today, "Working" or whatever it is; do not add a new one), and
the trace entry is posted at once, as DEF-0049's fix posts a question at the ask, then corrected at
the outcome. A page closed during the hold leaves an entry that says the sentence was heard and
held, not an entry with no outcome.

## Past the bound

Today, after five seconds, the sentence runs against a board that has neither the placeholder nor
the row, and can answer "Cell 1 has nobody on it" over a block the person can see. A wrong answer
said plainly is worse than a refusal. Past the bound the bar does NOT resolve the sentence. It says,
as a turn in the thread and in the trace:

    The board is still saving your last change. Say it again in a moment.

and drops the held sentences. One sentence, R-459's register, nothing written. The main session
chose these words and will show them to the maintainer; build exactly these. The bound stays five
seconds and starts when the FIRST held sentence is held; a later create does not restart it. Case:
a create that never answers.

## Finding 5: keep the reviewer's cases

The keyboard guard and the keyboard resize floor are now held by the reviewer's cases. Leave them.
Where a reviewer's case DOCUMENTS the wrong behaviour you are now fixing (the drop, Escape, the
silence), rewrite it to assert the right one and say in the file that the contract changed and why.
Delete none.

## Files you own

As in `docs/agent-briefs/s194-g-placeholder-id-brief.md`, plus `src/test/s194fgReview.test.tsx`.

## Rules

Unchanged: do not commit; never `npm run db:reset`; write nothing to the maintainer's database; no
migration; do not edit `docs/defects/*.md`, `docs/plan.yaml`, `CLAUDE.md`, `src/test/defects/`; do
not start or stop containers; only `e2e/typedWalk.spec.ts` and `e2e/touch.spec.ts`, only against
the tester's stack, confirming the 54421 address before every run; never `git checkout -- <file>`;
never patch with `Get-Content`/`Set-Content`.

## Proving it

1. The cause, shown by a case that is red before the fix.
2. The throttled spec ten of ten at 2000 ms and ten of ten at 200 ms. Then both walk lists, each
   twice over the same database, and the touch spec.
3. Cases for the queue (three sentences held, run in order), Escape, the status shown while held,
   the trace entry posted at the hold, the bound's sentence, a create that fails while a sentence
   is held (the sentence then runs against the board without the row, which is now the truth).
4. Mutations, copy-backed, red by name: the synchronous count; the wait for the row in `ctx`; the
   queue made one slot again; the Escape cancel; the bound's refusal.
5. ONE full `npm run test`. Before this pass: `Test Files 3 failed | 183 passed (186)`,
   `Tests 3 failed | 4688 passed (4691)`; the three reds are DEF-0040's pin, DEF-0043's headcount
   pin and DEF-0020's live pin. `npx tsc -b`, eslint, prettier over your files.

## Report

Plain prose. The cause as you PROVED it, and whether the hypothesis above was right. What you
built. What a person sees in each case: held and run, held and cancelled, held past the bound, two
sentences held. Every case added or rewritten. The mutations. The spec's twenty lines and the
runner's totals, copied. What you did not do. A draft commit message in the repo's style: plain
ASCII, reasoning in prose, no bullets.
