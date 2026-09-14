# Brief S51-a: the bar runs a several — one question at a time, one yes for the lot

Stage S51, requirement R-400 (read it in `docs/plan.yaml`; its claim is the contract), design
§19.98 (D127). Another lane (S50-b, the voice data) is running at the same time; it owns
`scripts/voice/**`, `src/lib/voice/{decode,readSentence}.ts`, `data/voice/heldout.jsonl` and
`src/test/{voiceData,voiceRead,voiceTrain}.test.ts`. Do not touch those; ignore `tsc` errors in
them if any appear while it works (report them, do not fix them).

## 1. What exists (read first)

- `src/lib/command/parse.ts` (committed, abdae16): `SeveralCommand { intent: "several";
  commands: SingleCommand[] }`, `SingleCommand` the four-member union, `Command` the five.
  `formatCommand(several)` joins inner sentences with "; ".
- `src/lib/command/resolve.ts`: `resolveCommand(single, ctx)` → `Resolution`; for a several it
  returns the `several_unsupported` question (leave that as the resolver's own answer; the
  bar intercepts a several BEFORE calling it). `ResolvedCommand` (assign: `target` run |
  direct | retime), `ResolvedBook` (run_create | retime_run), `ResolvedUnassign`,
  `ResolvedMove` (retime | move_cell). `describeQuestion`.
- `src/features/board/components/CommandBar.tsx` (~1130 lines): read it whole. The held
  command (`heldCommand`/`lastCommand` — find the name) and how `pickCandidate` /
  `pickExisting` substitute into it and re-resolve; `questionToStatus`; `withBlockHighlight`;
  `submitText` (confirm/cancel words, the S50 mismatch answer, then the reader, then the
  rules); `Status` (`kind: "question"` with `candidates`, `blockHighlight`); the `on*` props;
  `YES_SUFFIX`; Escape and `handleChange` clearing. The unmount cleanup reports
  `onHighlight(null)`.
- `src/features/board/lib/highlight.ts`: `Highlight { kind: "remove"|"move"|"retime";
  assignmentIds }`, `HighlightProvider`, `useHighlightKind(id)`.
- `src/features/board/BoardPage.tsx` ~line 795–870: the launcher's props: `onOpen` →
  `dragApi.openCreateFromCommand` (opens the create pop-up prefilled), `onRetime` →
  `dragApi.retimeAssignmentFromCommand`, `onBook` → `dragApi.openCreateRunFromCommand`,
  `onRetimeRun` → `dragApi.retimeRunFromCommand`, `onUnassign` → `dragApi.removeAssignment`,
  `onMove` → retime or `dragApi.openMoveFromCommand` (opens the move pop-up). `dragApi` is
  `useDragGesture(...)` (line ~334) — read that hook's file for what each of those does and
  which mutation the pop-ups finally call. `CreatePopover.tsx`: `submitIfClean()` (R-384) is
  the pop-up's clean-Enter path — find the mutation it calls and its payload; the move
  pop-up's confirm (D120 `moveAssignment`, one server writer).
- Tests: `src/test/commandBar.test.tsx` (`renderBar`, fixtures BLK1/BLK2/BLK_C2, the CB-yes
  and CB-else cases), `src/test/commandLauncher.test.tsx`, `src/test/directBlockAndChip.test.tsx`
  (H1/H2 outline), `e2e/roleWalk.spec.ts` (must stay green).

## 2. What to build

1. **The lot state** in `CommandBar.tsx`. When the parsed command (from the rules or the
   model reader — both paths land in the same place; find it) is a several: hold
   `{ several, index, done: Resolved[] }` and run `resolveNext()`: resolve
   `several.commands[index]` with `resolveCommand`; on a question, show it through the
   existing `questionToStatus` with the message prefixed `"${index+1} of ${N}: "` and the
   buttons/outline as today — but `pickCandidate`/`pickExisting` must substitute into
   `several.commands[index]` (not into a lone held command) and call `resolveNext()` again
   from the same index; on ok, push the resolved, advance, repeat. When `index === N`: the
   lot status (below). A typed edit (`handleChange`), a cancel word, or Escape drops the lot
   entirely (state null, highlight null) — same as a single question today.
2. **The lot status**: `kind: "question"`, message
   `"${N} commands ready: 1. <readout 1>; 2. <readout 2> — say or type yes to do them, no to leave them."`
   (readouts through the same `renderReadout` substitution the single readout gets), one
   candidate button labelled `"Do all ${N}"`, and a highlight that is a LIST: widen
   `onHighlight`'s parameter to `Highlight | Highlight[] | null`; in `highlight.ts` keep the
   `Highlight` type, make the provider's value normalise either shape into a lookup so
   `useHighlightKind` is unchanged for the chips (`BoardPage`'s state type widens; nothing
   else there changes). The list holds one `Highlight` per removal (`remove`), per re-time
   (`retime`) and per move to another cell (`move`), in order; creates and bookings add
   nothing. Confirm words: only `UNIVERSAL_CONFIRM_WORDS` confirm the lot; "remove it"/"move
   it" get an in-place answer `"That is a lot of ${N} commands; say yes to do them all, or no."`
   (extend the S50 mismatch branch; the lot's status needs a marker, e.g. `lot: true`, since
   `blockHighlight.kind` no longer identifies it).
3. **Running the lot**: one new prop `onRunLot(resolved: ResolvedAny[]) => Promise<LotResult>`
   where `ResolvedAny` is the four resolved unions and `LotResult = { done: number; error:
   string | null }`. The bar sets a `"reading"`-style busy status (`"Doing 1 of N…"` is fine,
   or reuse the reading status text `"Working…"`), awaits, then: `error === null` → status
   `{kind:"shape"?/"ok"}` with message `"Done: ${N} commands."`, input cleared, highlight
   null, lot null; else message `"Did ${done} of ${N}; the next failed: ${error}"`, input
   kept, highlight null, lot null. Use whatever `Status` kind the bar uses for a success
   readout today (find the successful-open readout's kind).
4. **The board's writers** (`BoardPage.tsx`, and `useDragGesture`'s file if the direct calls
   must live beside the pop-up openers): implement `onRunLot` as a sequential `for` over the
   list, `await`ing each, catching the first error (its message as the app already formats
   errors — find the toast/error text helper the pop-ups use) and returning `{done, error}`:
   - `unassign` → the same `dragApi.removeAssignment(id)` the single path uses (await it if
     it returns a promise; if it does not, read what it does and say so).
   - `move` with `target.kind === "retime"` and `assign` with `target.kind === "retime"` →
     the same re-time the drag uses — NOT `retimeAssignmentFromCommand` if that only opens a
     pop-up; find the writer it ends in and call that directly.
   - `assign` with `direct` / `run` → a new `dragApi.createFromCommand({...})` that calls the
     SAME mutation `CreatePopover.submitIfClean` calls, with the same payload shape (node,
     range, operator, product or run attach) and nothing the pop-up would have refused — the
     resolver already applied the pop-up's own rules; if the mutation is a hook inside the
     pop-up, lift the call (not a copy of it) into a function both use.
   - `move` with `move_cell` → the same `moveAssignment` writer the move pop-up's confirm
     calls (D120).
   - `book` `run_create` → the run-create mutation the run pop-up's clean submit calls;
     `retime_run` → the run re-time the drag uses.
   Say in the report, for each, the function you ended in and where the pop-up calls the
   same one. No new RPCs, no new SQL, no second copy of a payload builder.
5. **Tests** (`src/test/commandBar.test.tsx`, new `describe("CB-lot: a several runs one
   question at a time and writes on one yes (S51)")`), CB-lot-1..9: (1) a several of two
   removals from one cell, both people with one block: the lot status lists two readouts,
   `onHighlight` last called with a list of two `remove` highlights, a "Do all 2" button; (2)
   yes + Enter calls `onRunLot` with two `ResolvedUnassign` in order and shows "Done: 2
   commands." with the input cleared; (3) `onRunLot` resolving `{done:1, error:"boom"}` shows
   "Did 1 of 2; the next failed: boom", input kept, highlight null; (4) the first command asks
   (two blocks → remove_which): message starts "1 of 2: ", its buttons work, picking one
   continues to command two and then the lot status; (5) the first command's block is
   elsewhere (S49): "1 of 2: … but has one on Cell 2 …", yes answers THAT question (one
   candidate), then the lot; (6) "remove it" at the lot status is answered in place, no
   `onRunLot`; (7) no / Escape / a typed edit drops the lot and clears the highlight; (8) a
   mixed lot (one removal, one move in time) outlines with two kinds and `onRunLot` receives
   both resolved shapes; (9) a single sentence still calls `onUnassign`, never `onRunLot`
   (regression pin). Plus in `src/test/directBlockAndChip.test.tsx` H3: a list highlight
   colours each id by its own kind. Keep every CB-yes/CB-else/CL case passing.
   Run `npx vitest run src/test/commandBar.test.tsx src/test/commandLauncher.test.tsx
   src/test/directBlockAndChip.test.tsx src/test/createPopover.test.tsx
   src/test/commandPurity.test.ts src/test/popoverStandard.test.ts`, `npx tsc --noEmit -p .`,
   eslint and prettier on your files, then `npx playwright test e2e/roleWalk.spec.ts --workers=1`.

## 3. Rules

- Files you own: `CommandBar.tsx` and its CSS module, `highlight.ts`, `BoardPage.tsx`, the
  drag-gesture hook's file and `CreatePopover.tsx` ONLY to lift a submit call into a shared
  function (no behaviour change to the pop-up; its tests must pass), `DirectBlock`/`AssignmentChip`
  only if the highlight lookup needs it, the test files named. Not `src/lib/command/*`, not
  `src/lib/voice/*`, not `docs/plan.yaml`.
- `CommandBar.tsx` must not import supabase or `@/lib/api/mutations` (commandPurity U2) — the
  writers live in `BoardPage`/the hook, behind the `onRunLot` prop. No new dependencies. Do
  not run the full `npm run test`. Do not commit.
- One question at a time; never write before the yes; never write a partial lot silently.
- Report: the files with a line each; for every writer, the function reached and where the
  pop-up calls the same one; each test title; the exact new status strings; vitest/tsc/lint/
  roleWalk summaries; `git diff --stat`.
