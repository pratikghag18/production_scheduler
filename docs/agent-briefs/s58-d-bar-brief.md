# S58-d — the bar and the board for group 2: the headcount write, the new questions, the new readouts (R-412 to R-416, D132)

You are lane D of S58. You own `src/features/board/components/CommandBar.tsx`,
`src/features/board/BoardPage.tsx`, `src/features/board/hooks/useDragGesture.ts` (ONLY a new
`setHeadcountFromCommand` beside the S51 lot helpers, and the lot runner's refusal of a headcount
step), `src/test/commandBar.test.tsx`, `src/test/dragGesture.test.ts`, and the ResolveContext
fixture lines of `src/test/commandLauncher.test.tsx` if the types moved. Lanes A, B, C have
landed: read `docs/agent-briefs/s58-a-grammar-brief.md` §1, the S58-b brief and lane B's report
(the question kinds `adjust_inverts {person, block}`, `adjust_off_day {person, block}`,
`split_outside {person, at, blocks}`, `no_job {product, cell, when}`, `which_job {product, cell,
runs}`, and the resolved member `ResolvedHeadcount {intent:"headcount", runId, nodeId, headcount,
readout}` — take the exact fields from lane B's report, which will be pasted into your prompt),
`docs/design-plan.md` §19.103 (D132), and the S55-d brief for how the bar expands before it
resolves. Do not edit resolve.ts, parse.ts, decode.ts or their tests. Run `npx vitest run
src/test/commandBar.test.tsx src/test/dragGesture.test.ts src/test/commandLauncher.test.tsx`,
`npx tsc --noEmit -p tsconfig.json` (clean across the repo when you finish) and `npx eslint
src/features/board src/test/commandBar.test.tsx src/test/dragGesture.test.ts`. No full suite, no
commits, no plan edits.

1. **The headcount write.** `CommandBar` gains `onSetHeadcount(resolved: ResolvedHeadcount,
   anchor)`; `BoardPage` wires it to a new `setHeadcountFromCommand(runId, headcount)` in
   `useDragGesture.ts` that calls the SAME field-edit mutation the job panel's headcount uses
   (find the callback near `updateRunFields`/`plannedHeadcount`, around line 2266, and reuse its
   mutation and its invalidation — never a second door). The readout after the write:
   `Housing A on Cell 1 08:00–16:00: 4 people.` (lane B's readout text, rendered like every other).
   A failure shows the mutation's error in the bar's error line as other writes do.
2. **A headcount inside a lot** cannot happen by type; the lot runner's switch gets an explicit
   refusal branch (`LotStepRefused`) so a future caller never falls through silently — pin it.
3. **The new questions, in the bar's words** (`questionToStatus`, no candidates):
   `adjust_inverts` → `${person}'s ${block} block would end before it starts; say a smaller change.`;
   `adjust_off_day` → `${person}'s ${block} block would leave the day; say a time inside it.`;
   `split_outside` → `${at} is outside ${person}'s block${blocks.length > 1 ? "s" : ""} (${blocks.join(", ")}); say a time inside one.`;
   `no_job` → `There is no ${product} job on ${cell} ${when}; book it first, or say the hours.`;
   `which_job` → `${product} runs more than once on ${cell}: ${runs.join(", ")}. Say the hours.`
   The grammar's `which_job` failure (the maintainer's "make it 4 people") → `Say which job — "make the Housing A job on Cell 1 4 people".`; `bad_adjust` → `Say how much — "by an hour", or "at 3".`; `no_split_time` → `Say where to split — "at noon".`
4. **Expanded lots for split and every weekday** use the S55 path unchanged; the readouts of the
   written commands already print. Pin CB-y-1 `split Sam's block at noon` → a lot of two (move
   then assign) with the two outlines; CB-y-2 `assign Sam to Housing A on Cell 1 every weekday this
   week 8 to 4` → a lot of five; CB-y-3 `extend Sam's block by an hour` → the single move path,
   readout with the new hours; CB-y-4 `make the Housing A job on Cell 1 4 people` → `onSetHeadcount`
   called with the run id and 4, the readout shown; CB-y-5 `make it 4 people` → the grammar's
   sentence; CB-y-6 `add Sam to the Housing A job on Cell 1` → an assign resolved with the run
   target and the run's hours; CB-y-7 `add Sam to the Housing A job on Cell 1` with two such jobs →
   the which_job sentence; CB-y-8 the model path with a decoded `headcount` form reaches
   `onSetHeadcount`.
5. `dragGesture.test.ts`: `setHeadcountFromCommand` calls the mutation with `{ runId, edit: {
   plannedHeadcount } }` and keeps `notes` as they were (read what the existing callback passes —
   a headcount change must not blank the notes: if the existing edit requires both, read the run's
   notes from the index first; pin it).
Report: the mutation you reused and how notes are preserved; every re-pin and why; tsc/eslint;
case counts.
