# S41-a — "Book Housing A on Cell 1 in Line 1 from 6 to 2": the typed BOOK A JOB command

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 144)
by the developer session from the tree at f4434ea. First of the three commands the maintainer
ordered after assign (session 139: book a job, unassign, move). Stage S41 in `docs/plan.yaml`
(created by the developer session when this ships); requirements R-386 and R-387. The two
briefs before this one are the background and the register: `p1-7a-typed-command-bar-brief.md`
(§2 no second door, §4 the parser, §5 the resolver) and
`f-132-the-bar-sees-your-own-block-brief.md` (the extraction pattern for a re-time, the
question-with-buttons shape). Read both before this._

## §1. What this is, in the product's words

A scheduler types *"Book Housing A on Cell 1 in Line 1 from 6 to 2"* and the board books the
JOB — a run of that part on that cell for those hours — the way a drag along the empty track
books one today: the same "New" pop-up in Product run mode, pre-filled, and Enter creates it
when the pop-up would show nothing to decide (R-384's rule, extended to jobs). *"… for 3
people"* sets the planned headcount. A cell runs one job at a time, so when a job already
overlaps those hours the bar says so before anything opens: if it is the SAME part, it asks
whether to change that job's hours (the lesson of F-132: same group, different timing is a
change, not a second booking); if it is a different part, it says which job is in the way,
in the words the board already uses when a drag lands on it, and offers nothing else.

## §2. ⛔ THE RULES, unchanged

- No second door. `parse.ts` imports nothing; `resolve.ts` imports only types from `parse.ts`;
  `CommandBar.tsx` imports nothing from `src/lib/api/`; the purity audit stays green untouched.
- The bar holds no rule: run overlap on a cell is decided by `findRunOverlap` (already in
  `src/features/board/lib/interaction.ts`), passed in through `ResolveContext` the way
  `fitsRun` and `overlaps` are.
- The write is the existing one. A new job goes through `CreatePopover` in run mode →
  `onSubmitRun` → `submitCreateRun` → `createRun` → `create_run`, the same chain a track drag
  uses. A re-timed job goes through the run-RESIZE branch of `commitBlockDrag` — its overlap
  refusal, its "N crew assignments fall outside the new run window. Continue?" prompt and its
  one `updateRunFields` PATCH — EXTRACTED into a function the drag and the bar both call, as
  `retimeAssignment` was in F-132. No new `mutate(` call anywhere.
- Every question string is tested verbatim.

## §3. The shapes — exact

### `parse.ts`

```ts
export interface BookCommand {
  intent: "book";
  product: string;            // words, never an id
  place: string[];            // most specific first, at least one
  /** "for 3" / "for 3 people" — null when the sentence did not say. */
  headcount: number | null;
  day: DayWord | null;
  start: ClockTime;
  end: ClockTime;
  /** R-387: the answer to "change that job's hours?" — null until asked. */
  existing: { kind: "retime"; runId: string } | null;
}
export type Command = AssignCommand | BookCommand;
export type ParseResult = { ok: true; command: Command } | { ok: false; failure: ParseFailure };
```

`ParseFailure` gains `{ kind: "bad_headcount"; text: string }` (a `for` clause whose number
is not a whole number 1–99).

**Grammar.** The intent is decided by the FIRST word: `book` or `run` → book; `assign` /
`put` / `schedule` / `add` or no verb → assign, exactly as today. Then, for book:

```
(book | run)  <product>
   (on | at | in)  <place>  { (in | on | at | ,)  <place> }
   [for <n> [people | persons | operators | heads]]
   [on <day>]
   from <time>  (to | - | – | until | till)  <time>
```

Read back to front like the assign shape: time clause (same code, share it — pull the time
clause and day-word steps into private helpers used by both intents rather than copying
them; say in the report that the assign path's P1–P24 still pass byte-for-byte), then the
optional `for <n> …` immediately before the day word (a `for` not followed by a number is part
of the place text, the same way "on funday" is a place; only `for <digits>` is a headcount,
and `for 0` / `for 250` / `for 3.5` is `bad_headcount` with the text), then the verb, then the middle split on the first ` on ` / ` at ` / ` in ` /`,` into
product and places. No product → `no_product`; no place → `no_place`.

`formatCommand(command: Command)` prints the book shape as `book <part> on <cell> [in <line>]
[for <n> people] [on <day>] from HH:MM to HH:MM`, quoting names as today, never printing
`existing`.

`expectedShape()` becomes the two shapes in one sentence, exactly:
`Say it like: assign <person> to <part> on <cell> [in <line>] [on <day>] from <time> to <time> — or: book <part> on <cell> [in <line>] [for <n> people] [on <day>] from <time> to <time>`
This changes a string R-382 tests verbatim (C5, C6, and any P-case asserting it): update
those assertions and say in writing that the contract changed (CLAUDE.md §4).

### `resolve.ts`

`ResolveContext` gains `findRunOverlap: (range, runs, excludeRunId: string | null) =>
ContextRun | null` — passed in from `interaction.ts`'s `findRunOverlap` (check its exact
signature and generic; `ContextRun` has `id/startMin/endMin` so it satisfies the bound).

```ts
export type BookTarget =
  | { kind: "run_create"; productId: string; headcount: number | null }
  | { kind: "retime_run"; runId: string };

export interface ResolvedBook {
  intent: "book";
  nodeId: string;
  productId: string;
  target: BookTarget;
  range: { startMin: number; endMin: number };
  /** "Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00 · 3 people"
   *  (+ " · changing <run label>" for a retime; the " · N people" part only when said). */
  readout: string;
}
```

`ResolvedCommand` gains `intent: "assign"` (add the field; every existing assertion that
spells the whole object needs it — expected reds, contract changed). `Resolution` becomes
`{ ok: true; resolved: ResolvedCommand | ResolvedBook } | { ok: false; question: Question }`.
`resolveCommand(command: Command, ctx)` dispatches on `intent`; the assign path is untouched.

`Question` gains:

```ts
  /** R-387: a job of the SAME part already overlaps the sentence's hours on that cell. */
  | { kind: "job_exists"; product: string; cell: string; span: string; run: Candidate; same: boolean }
  /** R-387: a job of ANOTHER part overlaps — a cell runs one job at a time; nothing to offer. */
  | { kind: "job_in_the_way"; product: string; cell: string; other: string /* its D66 label */ }
  | { kind: "job_gone"; product: string; cell: string }
```

The book path, in order: 1 cell (share the assign path's cell step), 2 part (share; the
offered-at check applies), 3 day and span (share; too-short applies), 4 the job question:

```ts
  const overlap = ctx.findRunOverlap({ startMin, endMin }, ctx.runs.filter((r) => r.nodeId === cell.id), null);
  if (command.existing === null) {
    if (overlap && overlap.productId === product.id) return ask job_exists (same = equal bounds);
    if (overlap) return ask job_in_the_way (other = overlap.label);
    target = run_create;
  } else {                                   // existing.kind === "retime"
    const hit = ctx.runs.find((r) => r.id === command.existing.runId && r.nodeId === cell.id) ?? null;
    if (!hit) return ask job_gone;
    // the retime must not collide with ANOTHER job: same rule the drag applies before writing
    const other = ctx.findRunOverlap({ startMin, endMin }, ctx.runs.filter((r) => r.nodeId === cell.id), hit.id);
    if (other) return ask job_in_the_way (other.label);
    target = { kind: "retime_run", runId: hit.id };
  }
```

`describeQuestion`, verbatim:

```
job_exists, same false:  "A <product> job is already booked on <cell> <run.label-without-name>. Change it to <span>, or pick other hours?"
job_exists, same true:   "A <product> job is already booked on <cell> <label> — nothing to change."
job_in_the_way:          "<cell> already runs <other>; a cell runs one job at a time. Pick other hours, or change that job on the board."
job_gone:                "That <product> job on <cell> is no longer on the board. Book it again?"
```

`run.label` today is `"<product name> HH:MM–HH:MM"` (D66); for the `job_exists` sentence use
the run's `label` with the product name already in the sentence — so build it as
`"A Housing A job is already booked on Cell 1 08:00–16:00."`: the lane strips the leading
product name from the label OR, cleaner, `ContextRun` gains `span: string` ("08:00–16:00")
beside `label`, built in `BoardPage` from the same `formatClock` pair. Do the cleaner one.
Button labels: `job_exists` (same false) → one button `Change 08:00–16:00`; `job_gone` →
one button `Book it`, which sets `existing` back to null and re-runs; `job_in_the_way` and
`job_exists` (same true) → no buttons.

### `CommandBar.tsx`

Two new props: `onBook(resolved: ResolvedBook, anchor)` for `run_create`, and
`onRetimeRun(resolved: ResolvedBook, anchor)` for `retime_run`. `runCommand` dispatches on
`resolved.intent` then on `target.kind`. `pickExisting` is reused for the run answer (widen
its type). Placeholder stays the assign sentence (it is an example, not the grammar).

### `CreatePopover.tsx`

- New optional prop `presetMode?: "run"` — when set, the initial mode is `"run"` regardless
  of `defaultCreateMode`, and the run/direct segment is rendered DISABLED (both buttons
  `disabled`), mirroring the intent of the `presetOperatorId` comment ("forced"). Read what
  `presetOperatorId` actually does to the segment today; if it does not disable it, do not
  disable it for `presetOperatorId` either — only for `presetMode` — and say so.
- New optional prop `presetHeadcount?: number` — initial `plannedHeadcount` when given.
- R-384 for jobs: `clean` gains a run-mode arm: `mode === "run" && productId !== ""`; the
  auto-press effect calls a new `submitRun()` (extract the Create button's run branch into it,
  as `submitDirect` was, so the button and the auto-press send identical arguments) when
  `mode === "run"`, else `submitDirect()` as now. The effect stays mount-only behind the ref
  (F-128).

### `useDragGesture.ts`

- Extract the run-RESIZE branch of `commitBlockDrag` (from the comment `// Resize: unchanged
  from P1-4b except the confirm step` through its closing `commitResize();`) into
  `retimeRun(run: IndexedRun, nodeId: string, candidate: Range, anchor, revert: string)`,
  moved not retyped; the only substitutions are `d.nodeId → nodeId`, `run` stays, `d.subject`
  in `revertLabel(d.subject)` → `revert`, and `currentRunsOnNode`/`currentCrew` recomputed
  inside from `index` (they are already read fresh from `index` at the top of the run branch;
  move those two lines in too). The drag's run branch calls it for `d.mode !== "move"`.
- New exported `retimeRunFromCommand({ runId, range, anchor })`: `canPlaceRef` guard; look up
  `index.runById`; missing → `toast.reverted("That job is no longer on the board.")`; else
  `retimeRun(run, run.nodeId, range, anchor, runLabelById(run.id))`.
- New exported `openCreateRunFromCommand({ nodeId, range, productId, headcount, anchor })`:
  sets the create popover with `presetMode: "run"`, `presetProductId`, `presetHeadcount`
  (when not null), `autoCreate: true`, shift chips as `openCreateFromCommand` does. `PopoverState`'s
  create member gains `presetMode?: "run"` and `presetHeadcount?: number`; thread both into
  `<CreatePopover>` where `presetProductId` is threaded (find that render in `BoardPage.tsx`).

### `BoardPage.tsx`

`commandCtx` gains `findRunOverlap` and each `ContextRun` gains `span`. `<CommandBar>` gains
`onBook` → `dragApi.openCreateRunFromCommand(...)` and `onRetimeRun` →
`dragApi.retimeRunFromCommand(...)`; `onOpen`/`onRetime` narrow on `resolved.intent === "assign"`.

## §4. Files — exclusive to the build lane

`src/lib/command/parse.ts`, `src/lib/command/resolve.ts`,
`src/features/board/components/CommandBar.tsx`, `src/features/board/components/CreatePopover.tsx`,
`src/features/board/hooks/useDragGesture.ts`, `src/features/board/BoardPage.tsx`, and the
tests: `src/test/commandParse.test.ts`, `src/test/commandResolve.test.ts`,
`src/test/commandBar.test.tsx`, `src/test/createPopover.test.tsx`, `src/test/dragGesture.test.ts`.
`src/test/commandPurity.test.ts` unchanged and green. Nothing else; if `interaction.ts` needs
a signature change for `findRunOverlap`, stop and say why rather than changing it.

## §5. Tests — every case named

`commandParse.test.ts` (B-cases, one `it()` each, whole-object assertions):
- B1 `Book Housing A on Cell 1 in Line 1 from 6 to 2` → book, product `Housing A`, place
  `["Cell 1","Line 1"]`, headcount null, 06:00–14:00, existing null.
- B2 `run Housing A on Cell 1 for 3 people from 6 to 2` → headcount 3.
- B3 `book Housing A on Cell 1 for 3 on tomorrow from 6 to 2` → headcount 3, day tomorrow.
- B4 `book Housing A on Cell 1 for 0 from 6 to 2` → `bad_headcount` text `0`; `for 3.5` the same with `3.5`.
- B5 `book Housing A on Cell 1 for lunch from 6 to 2` → `for` followed by a non-number is
  ordinary place text, so the place list is `["Cell 1 for lunch"]` (the split words are
  on/at/in/comma, never `for`). Assert exactly that.
- B6 `book Housing A from 6 to 2` → `no_place`. B7 `book from 6 to 2` → `no_product`.
- B8 `Book "Cell in 2 Part" on "Cell in 2" from 6 to 2` → quoted names atomic.
- B9 `formatCommand` round-trips B2 and B3 (`book Housing A on Cell 1 for 3 people from 06:00 to 14:00`).
- B10 `assign Sam to Housing A on Cell 1 from 10 to 2` still parses as assign with the same
  object as P2 (the first-word rule does not disturb assign); and `schedule Sam …` is assign.
- B11 `expectedShape()` is the exact two-shape sentence from §3.

`commandResolve.test.ts` (RB-cases; fixture as today plus `span` on `run1`/`run2` and
`findRunOverlap` as a local stub implementing half-open overlap over the list, excluding an id):
- RB1 `book Housing A on Cell 1 in Line 1 from 6 to 2`, no runs → ok, `run_create` with
  `productId "ha"`, headcount null, readout
  `"Housing A · Plant 1 › Assembly › Line 1 › Cell 1 · 2026-09-03 · 06:00–14:00"`.
- RB2 with `for 3` → headcount 3, readout ends `" · 3 people"`.
- RB3 with run1 (Housing A 08:00–16:00) and span 06:00–14:00 → `job_exists`, verbatim
  `"A Housing A job is already booked on Cell 1 08:00–16:00. Change it to 06:00–14:00, or pick other hours?"`, `same` false.
- RB4 span exactly 08:00–16:00 → `same` true, verbatim "— nothing to change." sentence.
- RB5 `existing: retime run1` → ok, `retime_run` `"run1"`, readout ends `" · changing Housing A 08:00–16:00"`.
- RB6 a Cover run (different part) overlapping → `job_in_the_way` verbatim
  `"Cell 1 already runs Cover 08:00–16:00; a cell runs one job at a time. Pick other hours, or change that job on the board."` (build a `runCov` fixture on `c1a` — note Cover is not offered at c1a, which is fine: the OTHER job's part need not be offered, only the sentence's).
- RB7 a run on another cell, or on this cell but not overlapping (touching at 16:00), asks nothing.
- RB8 `existing: retime "run9"` (gone) → `job_gone` verbatim.
- RB9 `existing: retime run1` but run2 (09:00–15:00, Housing A) also on the cell and the new
  span 06:00–14:00 overlaps run2 → `job_in_the_way` naming run2's label (the retime must not
  collide with another job).
- RB10 part not offered at the cell → `not_offered`, unchanged shape; too short → `too_short`.
- RB11 the assign path: R1 and R34 still produce byte-identical results (regression pin for the sharing refactor).

`commandBar.test.tsx` (CB-cases): CB1 the book sentence calls `onBook` once with the
`run_create` target and the range, readout shown; CB2 with run1 the `job_exists` question shows
with one button `Change 08:00–16:00`, pressing it calls `onRetimeRun` with `run1` and the
input unchanged; CB3 `job_in_the_way` shows with no buttons and calls nothing; CB4 `job_gone`
shows the `Book it` button and pressing it re-runs as a fresh sentence (calls `onBook`); CB5
C5/C6 updated to the new shape sentence.

`createPopover.test.tsx` (AC-cases continue): AC8 `presetMode: "run"` + `presetProductId` +
`autoCreate` → `onSubmitRun` called exactly once under StrictMode with `(nodeId, range,
"prod-1", 2)` and `onSubmitDirect` never; AC9 with `presetHeadcount: 3` → the fourth argument
is 3; AC10 `presetMode: "run"` with NO product offered → nothing called; AC11 the segment's two
buttons are disabled under `presetMode` and a click does not flip the mode.

`dragGesture.test.ts` (D-cases continue from D5): D6 `retimeRunFromCommand` on an unstaffed
run writes ONE `updateRunFields` call with the new timerange; D7 on a staffed run whose crew
would fall outside, nothing is written and `popover` is the confirm prompt naming the count;
`confirmYes()` then writes; D8 overlapping another run on the cell toasts and writes nothing;
D9 unknown run id writes nothing.

## §6. Mutations — apply each on a scratch copy; record which case goes red

| id | mutation | must be caught by |
| --- | --- | --- |
| M30 | intent decided by any verb (book → assign) | B1, B10 |
| M31 | `for <n>` parsed as a place | B2 |
| M32 | the job question skipped | RB3, RB6 |
| M33 | same-part overlap treated as in-the-way (no Change button) | RB3, CB2 |
| M34 | stale retime falls back to create | RB8 |
| M35 | retime ignores collision with another job | RB9 |
| M36 | `onBook` routed through `onOpen` | CB1 |
| M37 | run-mode `clean` ignores `productId` | AC10 |
| M38 | `retimeRunFromCommand` builds its own `updateRunFields` call | D7 (no prompt), D8 |
| M39 | `submitRun()` not shared: the button builds its own arguments | AC8 (compare with a click's arguments in the same case, as AC1 does) |

## §7. Acceptance, in order

1. `npx vitest run` on the six test files named in §4 plus `commandPurity.test.ts` — counts copied.
2. `npx tsc -b --force` clean; `npx eslint` on every touched file clean; `npx prettier --check
   --end-of-line auto` on every touched file clean.
3. The §6 table filled in with what actually went red.
4. Do NOT run the full `npm run test`; do NOT commit. You have no browser: say so; the review
   lane drives it.

## §8. Report

Plain prose: what you built file by file; every existing case that went red and your verdict
(the expected reds: whole-object assertions gaining `intent`, the shape sentence); the counts
copied from the runners; the §6 table; where the brief was wrong against the tree; what you
did not do and why.

## §9. The review lane (a second Sonnet, after the build lane reports)

One job: break it. Nothing is committed. (1) Verify §2 against the diff: no new `mutate(`
call; `retimeRun` byte-identical to the removed resize branch apart from the named
substitutions; `CommandBar.tsx` imports nothing from the API; the assign path's P1–P24 and
R1–R44 unchanged in meaning. (2) Apply M32, M35, M38 and M39 on scratch copies; confirm the
named cases go red; restore from your copies (never `git checkout --`). (3) Live as Dana
(`dana@example.test` / `devpassword`, http://localhost:5173, Playwright chromium from the
repo's `node_modules/playwright/index.mjs`; the dev server is expected up — if not, say so and
stop): on a day and cell with no jobs (check the board first; the previous review used
Operator A3's Cell 3 on Line 2, 2026-09-12), type `Book Housing A on Cell 3 in Line 2 from 6
to 2` — Enter creates the job with no pop-up left open; the board shows the band; the
database has exactly one `runs` row for that cell that day (read-only psql). Then `Book
Housing A on Cell 3 in Line 2 from 6 to 3` — the `job_exists` question with `Change
06:00–14:00`; press it; the band reads 06:00–15:00 and there is still ONE row. Then `Book
Bracket A on Cell 3 in Line 2 from 10 to 12` — the in-the-way sentence naming the Housing A
job, no buttons, nothing written. Then delete the job through the app's own Delete (cascade
if asked; it has no crew) and confirm zero rows. Screenshots to
`C:\Users\prati\.claude\jobs\0586b6d2\tmp\` named `book-01…`. Write nothing else to the dev
database. (4) Report: what you tried, what broke with exact text, screenshot names, and one
sentence on whether this can be called done.
