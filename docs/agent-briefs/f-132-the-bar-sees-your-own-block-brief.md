# F-132 / R-385 — the command bar sees a person's own block and offers to change its hours

_Brief for one Sonnet build lane and one Sonnet review lane. Written 11 Sept 2026 (session 143)
by the developer session, from reading the tree at commit c351757. The plan entry is
`docs/plan.yaml` R-385 (uncovered) and F-132 (open); S40 is the stage. The previous brief for
this feature, `docs/agent-briefs/p1-7a-typed-command-bar-brief.md`, is the background: read its
§2 (no second door) and §5 (the resolver) before anything here._

## §1. What this is, in the product's words

The maintainer typed *"Assign Operator A1 to Housing A on Cell 1 in Line 1 from 10 to 2"* and
the board created the block. Then they typed the same sentence with *from 10 to 3*, meaning
"that block, but until three". The bar opened the New block pop-up as if for a brand-new block,
and because the person was already working those hours the pop-up offered the efficiency box.
The board had misread the intent, and a second Enter on a clean pop-up would have stacked two
blocks on one person.

R-385, the maintainer's rule: **when a sentence names the same person, the same part and the
same cell as a block that person already has, and the hours overlap on that day, the bar treats
the sentence as a change to THAT block's hours, never as a second block on top of it.** It asks
one question in R-383's shape — the existing block as a button, and "Separate block" — and
choosing the block re-times it through the same door an edge-resize drag uses, so the server
re-asks training, area, absence and capacity for the new span exactly as it does for a drag
(R-361, R-031, R-365). Choosing "Separate block" is what the sentence would have made anyway,
and only then may the efficiency box appear. The bar never stacks silently.

## §2. ⛔ THE ONE DESIGN RULE, unchanged: no second door, and no second copy of a rule

- `src/lib/command/parse.ts` imports nothing. `src/lib/command/resolve.ts` imports only a type
  from `parse.ts`. `src/test/commandPurity.test.ts` fails the build on a runtime import, a
  `require(`, a `new Date(` or `Intl.` in either. **Every rule the resolver applies is passed in
  through `ResolveContext`** (`offeredAt`, `fitsRun`, `wallToOffset`, `minDurationMinutes`).
  The overlap test you add is passed in the same way.
- `CommandBar.tsx` imports nothing from `src/lib/api/`. Its job ends at a callback. Today that is
  `onOpen(resolved, anchor)`; you add `onRetime(resolved, anchor)`. The purity audit's U2 already
  guards this file; leave it guarding.
- **The re-time itself is the drag's own code.** `useDragGesture.ts`'s `commitBlockDrag` has an
  assignment branch (from `const a = d.subject.assignment;` through the final `proceed();`) that
  builds the `AssignmentFieldEdit`, decides run attachment by containment (`stillFitsHome` /
  `otherFit` / detach), asks R-365's attachment prompt, asks R-031's keep-or-scale prompt, runs
  R-361's warn mirrors and writes ONE `updateAssignmentFields` PATCH. You **extract that branch
  into one function and call it from both places**. You do not write a second PATCH builder. If
  you find yourself typing `updateAssignmentFields.mutate(` anywhere new, stop.

## §3. The shapes — exact

### `src/lib/command/parse.ts`

Add, beside `Attach`:

```ts
/**
 * R-385 (the maintainer, 11 Sept, session 142): when the sentence names a person, part
 * and cell the person is already on, with overlapping hours, the bar ASKS — change that
 * block's hours, or add a separate block. The answer travels here. `null` = not asked
 * yet (every fresh parse). `formatCommand` never prints it.
 */
export type Existing = { kind: "retime"; assignmentId: string } | { kind: "separate" };
```

`AssignCommand` gains `existing: Existing | null;` after `attach`. `parseCommand` sets it to
`null` (the one place `attach: null` is set today, line ~278). `formatCommand` does not print
it. Nothing else in the parser changes; every parser test stays green (the `cmd()` fixture in
`commandResolve.test.ts` and the sentence fixtures in `commandParse.test.ts` need `existing:
null` where they spell the whole object — say which files you touched for that and why).

### `src/lib/command/resolve.ts`

```ts
/** A block the board is showing, in the pop-up's own minute coordinates (R-385). */
export interface ContextAssignment {
  id: string;
  nodeId: string;
  /** null for a departed person (D110) — such a block never matches. */
  operatorId: string | null;
  /** The block's EFFECTIVE part: its own `productId` for a direct block, its run's
   *  product for a run-attached block; null when neither is known (deleted product,
   *  D110) — such a block never matches. */
  productId: string | null;
  startMin: number;
  endMin: number;
  /** "10:00–14:00" in the plant's zone — the same `formatClock` pair the run label
   *  uses, without the name (the question sentence supplies person, part and cell). */
  label: string;
}
```

`ResolveContext` gains two fields, documented like the others:

```ts
  /** Every block in the window (`commandAssignments(index)`, §7), board order. */
  assignments: ReadonlyArray<ContextAssignment>;
  /** Half-open overlap, passed in (`rangesOverlap` from `lib/interaction.ts`). */
  overlaps: (
    a: { startMin: number; endMin: number },
    b: { startMin: number; endMin: number },
  ) => boolean;
```

`CommandTarget` gains a third member:

```ts
export type CommandTarget =
  | { kind: "run"; runId: string }
  | { kind: "direct"; productId: string }
  /** R-385: not a create at all — re-time this existing block to `range`. */
  | { kind: "retime"; assignmentId: string };
```

Update the comment above it: the first two members are still structurally `AssignmentTarget`;
`BoardPage` narrows on `kind` before `openCreateFromCommand` and `tsc` proves the narrowing.

`Question` gains two members:

```ts
  /** R-385: the person already has one or more blocks for this part on this cell whose
   *  hours overlap the sentence's, and `command.existing` is still null. `blocks` are
   *  the candidates, board order; `span` is the sentence's "HH:MM–HH:MM"; `same` is
   *  true when there is exactly one block and its hours equal the sentence's. */
  | {
      kind: "block_exists";
      person: string;
      product: string;
      cell: string;
      span: string;
      blocks: Candidate[];
      same: boolean;
    }
  /** R-385: `command.existing` names a block that is no longer among the hits and no
   *  other block of this person's overlaps — the board changed under the question. */
  | { kind: "block_gone"; person: string; product: string; cell: string };
```

`Candidate.word` is `""` for a block, as for a run: the answer goes into `existing`, not the
sentence.

### `describeQuestion` — verbatim, tested verbatim

```
block_exists, one block, same === false:
  "<person> is already on <product> at <cell> <label>. Change it to <span>, or add a separate block?"
block_exists, one block, same === true:
  "<person> is already on <product> at <cell> <label> — nothing to change. Add a separate block?"
block_exists, two or more blocks:
  "<person> already has <n> <product> blocks at <cell> (<label1>, <label2>). Change one to <span>, or add a separate block?"
block_gone:
  "That <product> block of <person>'s at <cell> is no longer on the board. Add it as a new block?"
```

Use the en dash `—` and `–` exactly as the existing run wording does; the tests compare strings.

## §4. The resolver — where the step goes, and what it does

`resolveCommand` today: 1 cell, 2 part, 3 person, 4 day and span (with the too-short check),
5 the run question, then the readout. **Insert the own-block step as 5 and renumber the run
question to 6.** The order matters: the maintainer's sentence, typed against a block that sits
inside a job, must ask about the block first; "Separate block" then falls through to the run
question exactly as before.

Compute `timeText` (the `HH:MM–HH:MM` now built in the readout section) before step 5, since
the question needs it; the readout keeps using the same variable.

Step 5, in full:

```ts
  // 5. The own-block question (R-385).
  const own = ctx.assignments.filter(
    (x) =>
      x.nodeId === cell.id &&
      x.operatorId === operator.id &&
      x.productId === product.id &&
      ctx.overlaps({ startMin, endMin }, x),
  );
  const blockCandidates = (): Candidate[] =>
    own.map((x) => ({ id: x.id, label: x.label, word: "" }));
  const askBlock = (): Resolution => ({
    ok: false,
    question: {
      kind: "block_exists",
      person: operator.displayName,
      product: product.name,
      cell: cell.name,
      span: timeText,
      blocks: blockCandidates(),
      same: own.length === 1 && own[0].startMin === startMin && own[0].endMin === endMin,
    },
  });
  let retime: ContextAssignment | null = null;
  if (own.length > 0 && command.existing === null) {
    return askBlock();
  } else if (command.existing?.kind === "retime") {
    const hit = own.find((x) => x.id === command.existing.assignmentId) ?? null;
    if (hit) {
      retime = hit;
    } else if (own.length > 0) {
      return askBlock();                      // the board changed: re-ask, never guess
    } else {
      return {
        ok: false,
        question: { kind: "block_gone", person: operator.displayName, product: product.name, cell: cell.name },
      };
    }
  }
  // `existing.kind === "separate"`, or no own block at all: fall through to the run question.
```

Then step 6 (the run question) runs **only when `retime === null`**. When `retime !== null`,
`target = { kind: "retime", assignmentId: retime.id }` and the run question is skipped: a
re-timed block's attachment is decided by the drag's own containment logic on the way to the
write (§6), not by the resolver.

Readout for a retime: the existing readout string plus `` · changing ${retime.label} `` (the
same shape as `` · joining <run label> ``).

Add `rangesOverlap` to `src/lib/interaction.ts`, beside `assignmentFitsRun`, half-open:

```ts
/** R-385: two half-open minute ranges share at least one minute. */
export function rangesOverlap(
  a: { startMin: number; endMin: number },
  b: { startMin: number; endMin: number },
): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
```

If a helper with this exact meaning already exists in that file under another name, use it and
say so; do not add a twin.

## §5. The bar — `src/features/board/components/CommandBar.tsx`

- Props: add `onRetime: (resolved: ResolvedCommand, anchor: { x: number; y: number }) => void;`
  with a doc comment: "R-385: the resolved target is `retime` — the caller re-times the block
  through the drag's own path; nothing is created."
- `runCommand`: when `resolution.ok` and `resolution.resolved.target.kind === "retime"`, call
  `onRetime` instead of `onOpen`; the readout is set the same way either branch.
- `pickExisting(command, existing)`: the twin of `pickAttach` — the sentence stays, only the
  held command's `existing` changes, re-resolve directly (not through `parseCommand`, which
  always returns `existing: null`).
- `questionToStatus`: `block_exists` → the message plus, when `same` is false, one button per
  block labelled `` `Change ${b.label}` `` (so a single block reads "Change 10:00–14:00"),
  each calling `pickExisting(command, { kind: "retime", assignmentId: b.id })`; then always a
  "Separate block" button calling `pickExisting(command, { kind: "separate" })`. When `same` is
  true, ONLY the "Separate block" button. `block_gone` → the message plus one button "New
  block" calling `pickExisting(command, { kind: "separate" })`.
- `handleChange` already clears the held command; that clears `existing` too. Say so in a
  comment where `attach` is mentioned.
- Placeholder, Escape handling, the shape sentence: unchanged.

## §6. The hook — `src/features/board/hooks/useDragGesture.ts`

Two changes and nothing else in this file:

1. **Extract** the assignment branch of `commitBlockDrag` into a `useCallback` named
   `retimeAssignment` with the signature

   ```ts
   (
     a: IndexedAssignment,
     nodeId: string,
     homeRun: IndexedRun | null,
     candidate: Range,
     anchor: { x: number; y: number },
     revert: string,          // the label `failWith` shows if the server refuses
   ) => void
   ```

   Move the code, do not retype it: from `const nodeId = d.nodeId;` (drop that line and take
   the parameter) through the closing `proceed();` of that branch. Inside, the only
   substitutions are `d.nodeId → nodeId`, `d.homeRun → homeRun`, `d.subject.assignment → a`,
   `revertLabel(d.subject) → revert`. Its dependency array is the subset of `commitBlockDrag`'s
   the moved code uses. `commitBlockDrag`'s `else if (d.subject.kind === "assignment")` branch
   becomes the one call `retimeAssignment(d.subject.assignment, d.nodeId, d.homeRun, candidate,
   anchor, revertLabel(d.subject));`. Read `d.homeRun`'s type before you start; if it is not
   `IndexedRun | null`, match the extracted signature to what it is and say so.

2. **Add** the exported action:

   ```ts
   /**
    * R-385: the typed command bar's re-time path — the SAME function an edge-resize drag
    * commits through (`retimeAssignment`), so attachment, the R-365 prompt, the R-031
    * keep-or-scale prompt, the R-361 warn mirrors and the one PATCH are all the drag's own.
    */
   const retimeAssignmentFromCommand = useCallback(
     (r: { assignmentId: string; range: Range; anchor: { x: number; y: number } }) => {
       if (!canPlaceRef.current) return;                       // DEF-0015, as commitBlockDrag
       const a = index.assignmentById.get(r.assignmentId);
       if (!a) {
         toast.reverted("That block is no longer on the board.");
         return;
       }
       const homeRun = a.runId !== null ? (index.runById.get(a.runId) ?? null) : null;
       retimeAssignment(a, a.nodeId, homeRun, r.range, r.anchor, assignmentLabelById(a.id));
     },
     [index, toast, retimeAssignment, assignmentLabelById],
   );
   ```

   Return it from the hook beside `openCreateFromCommand`. Check `toast.reverted` is the
   method the hook already uses for a refused local check (it is, in the run-resize branch);
   if the toast API differs, use the one the file uses and say so.

## §7. The context — `BoardPage.tsx` and one new pure file

Create `src/features/board/lib/commandAssignments.ts`:

```ts
import type { BoardIndex } from "./boardIndex";
import type { ContextAssignment } from "@/lib/command/resolve";
import { addMinutes, formatClock } from "./time";   // whichever module BoardPage imports these from

/**
 * R-385: the command bar's view of the window's blocks. The effective part of a
 * run-attached block is its run's product; a departed person's block (D110,
 * operatorId null) is carried with null and never matches. The label is the same
 * `formatClock` pair the run label in `BoardPage` is built from.
 */
export function commandAssignments(
  index: Pick<BoardIndex, "assignmentById" | "runById" | "windowStart" | "zone">,
): ContextAssignment[]
```

Iterate `index.assignmentById.values()` in its own order. `productId` is `a.productId ??
index.runById.get(a.runId)?.productId ?? null` (guard `a.runId` null). Label
`` `${formatClock(addMinutes(index.windowStart, a.startMin), index.zone)}–${formatClock(addMinutes(index.windowStart, a.endMin), index.zone)}` ``
— copy the run-label expression in `BoardPage`'s `commandCtx` and drop the name.

`BoardPage.tsx`, in `commandCtx`: add `assignments: commandAssignments(index)` and `overlaps:
rangesOverlap`. In the `<CommandBar>` element: add

```tsx
onRetime={(resolved, anchor) => {
  if (resolved.target.kind !== "retime") return;
  dragApi.retimeAssignmentFromCommand({
    assignmentId: resolved.target.assignmentId,
    range: resolved.range,
    anchor,
  });
}}
```

and narrow `onOpen` so `tsc` is happy: `if (resolved.target.kind === "retime") return;` before
the existing `openCreateFromCommand` call (the union then narrows to `AssignmentTarget`).

## §8. Files — exclusive to the build lane

| file | change |
| --- | --- |
| `src/lib/command/parse.ts` | `Existing`, `AssignCommand.existing`, `existing: null` in `parseCommand` |
| `src/lib/command/resolve.ts` | `ContextAssignment`, two context fields, `CommandTarget.retime`, two `Question` members, step 5, `describeQuestion` |
| `src/lib/interaction.ts` | `rangesOverlap` |
| `src/features/board/components/CommandBar.tsx` | `onRetime`, `pickExisting`, the two question renderings |
| `src/features/board/hooks/useDragGesture.ts` | extract `retimeAssignment`; add `retimeAssignmentFromCommand` |
| `src/features/board/lib/commandAssignments.ts` | new, pure |
| `src/features/board/BoardPage.tsx` | the two context fields, `onRetime`, the narrowing |
| `src/test/commandResolve.test.ts` | R34–R42, `assignments`/`overlaps` in `baseCtx` |
| `src/test/commandBar.test.tsx` | C11–C14, the same in `buildCtx`, `onRetime` in `renderBar` |
| `src/test/commandParse.test.ts` | only `existing: null` where whole objects are spelled |
| `src/test/commandAssignments.test.ts` | new, A1–A4 |
| `src/test/dragGesture.test.ts` | D1–D4 for `retimeAssignmentFromCommand` |
| `src/test/commandPurity.test.ts` | NO change expected; if U1/U2 go red you have broken §2 |

Nothing else. If a change seems to need another file, stop and say why in your report.

## §9. Tests — every case named, every string verbatim

Fixtures: extend `commandResolve.test.ts`'s and `commandBar.test.tsx`'s `baseCtx`/`buildCtx`
with `assignments: []` and `overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin`
(a local stub, as `fitsRun` is), plus a `withBlocks(blocks, overrides)` helper. Fixture blocks,
all on day index 3, Operator 1 (`op1`), Cell 1 (`c1a`):

```ts
const blk1: ContextAssignment = { id: "blk1", nodeId: "c1a", operatorId: "op1", productId: "ha", startMin: 3*1440+600, endMin: 3*1440+840, label: "10:00–14:00" };  // the maintainer's first sentence
const blk2: ContextAssignment = { ...blk1, id: "blk2", startMin: 3*1440+840, endMin: 3*1440+960, label: "14:00–16:00" };
const blkHb: ContextAssignment = { ...blk1, id: "blkHb", productId: "hb", label: "10:00–14:00" };
const blkSp: ContextAssignment = { ...blk1, id: "blkSp", operatorId: "sp" };
const blkGone: ContextAssignment = { ...blk1, id: "blkGone", operatorId: null };
const blkC2: ContextAssignment = { ...blk1, id: "blkC2", nodeId: "c2" };
```

`commandResolve.test.ts` (sentence = `cmd()` = Operator 1, Housing A, Cell 1 in Line 1, today,
10:00–14:00 unless overridden):

- **R34** the maintainer's case: `cmd({ end: {hour: 15, minute: 0} })` with `[blk1]` → not ok,
  `kind: "block_exists"`, `describeQuestion` equals `"Operator 1 is already on Housing A at
  Cell 1 10:00–14:00. Change it to 10:00–15:00, or add a separate block?"`, `blocks` is
  `[{ id: "blk1", label: "10:00–14:00", word: "" }]`, `same` false.
- **R35** the identical sentence: `cmd()` with `[blk1]` → `same` true, text `"Operator 1 is
  already on Housing A at Cell 1 10:00–14:00 — nothing to change. Add a separate block?"`.
- **R36** answer retime: `cmd({ end: 15:00, existing: { kind: "retime", assignmentId: "blk1" } })`
  → ok, `target` equals `{ kind: "retime", assignmentId: "blk1" }`, `range` is `{ startMin:
  3*1440+600, endMin: 3*1440+900 }`, readout equals `R1_READOUT` with `10:00–14:00` replaced by
  `10:00–15:00` plus `" · changing 10:00–14:00"`.
- **R37** answer separate, no run: `existing: { kind: "separate" }` with `[blk1]` → ok, direct
  `ha`, no question.
- **R38** answer separate, inside a run: `withRuns([run1], { assignments: [blk1] })` and
  `existing: separate`, `attach: null` → the run question (`run_exists`, run1) — the two
  questions chain in this order and nothing is skipped.
- **R39** a different part asks nothing: `[blkHb]` → ok, direct.
- **R40** a different person asks nothing: `[blkSp]` → ok, direct. And a departed person's
  block: `[blkGone]` → ok, direct. And another cell: `[blkC2]` → ok, direct.
- **R41** no overlap asks nothing: `cmd({ start: 14:00, end: 16:00 })` with `[blk1]` → ok,
  direct (half-open: touching at 14:00 is not overlapping).
- **R42** two overlapping blocks list both in board order: `cmd({ start: 10:00, end: 16:00 })`
  with `[blk1, blk2]` → text `"Operator 1 already has 2 Housing A blocks at Cell 1
  (10:00–14:00, 14:00–16:00). Change one to 10:00–16:00, or add a separate block?"`, `blocks`
  ids `["blk1","blk2"]`.
- **R43** a stale retime re-asks, never falls back: `existing: retime "blk9"` with `[blk1]` →
  `block_exists` again (not ok, not direct). With `[]` → `block_gone`, text `"That Housing A
  block of Operator 1's at Cell 1 is no longer on the board. Add it as a new block?"`.
- **R44** the own-block question comes BEFORE the run question: `withRuns([run1], {
  assignments: [blk1] })`, `attach: null`, `existing: null`, span 10:00–15:00 (inside run1) →
  `block_exists`, not `run_exists`.

`commandBar.test.tsx`:

- **C11** typing the maintainer's second sentence with `[blk1]` shows R34's text verbatim and
  two buttons, `"Change 10:00–14:00"` and `"Separate block"`; `onOpen` and `onRetime` not
  called.
- **C12** pressing `"Change 10:00–14:00"` calls `onRetime` once with `target { kind: "retime",
  assignmentId: "blk1" }` and the 10:00–15:00 range; the input text is unchanged; `onOpen` not
  called; the status line shows the readout with `" · changing 10:00–14:00"`.
- **C13** pressing `"Separate block"` calls `onOpen` once with a direct `ha` target; with
  `RUN1` also present, it instead shows the run question and its buttons (C9's text), and
  pressing the run button then calls `onOpen` with the run target.
- **C14** the same-span sentence shows R35's text and ONLY the `"Separate block"` button.

`commandAssignments.test.ts` (build a minimal `Pick<BoardIndex, ...>` by hand; UTC zone,
window start 2026-08-24T00:00Z):

- **A1** a direct block carries its own product and a `"06:00–10:00"` label.
- **A2** a run-attached block (`productId: null, runId: "run-1"`) carries the run's product.
- **A3** a departed person's block (`operatorId: null`) is carried with `operatorId: null`.
- **A4** a run-attached block whose run is missing from `runById` carries `productId: null`.

`dragGesture.test.ts` (read the file's existing patterns first — `baseArgs`, `buildIndex`,
`crewFixture`, how `updateAssignmentFields` is asserted and how `popover` prompts are read
from `result.current.popover`; `buildIndex` may need `assignmentById` and `runById` populated,
which T-cases before you may not have needed — add them to the fixture builder, not to each
case):

- **D1** `retimeAssignmentFromCommand({ assignmentId: "asg-1", range: {360, 720}, anchor })`
  on a direct block with no run writes ONE `updateAssignmentFields` call whose `edit` is
  exactly `{ timerange: { start: 06:00Z, end: 12:00Z } }` — no `runId`, no `productId` keys.
- **D2** the same on `crewFixture()` (attached to `run-1`, 06:00–10:00) with range
  `{360, 720}` leaving the run: nothing is written yet and `popover` is R-365's confirm
  prompt; after `confirmYes()` the PATCH carries `runId: null, productId: "prod-1"` (the
  detach) beside the timerange.
- **D3** a block with a typed `targetQty: 100` re-timed from 4h to 6h: nothing is written and
  `popover` is the keep-or-scale choice with buttons `"Keep 100"` and `"Scale to 150"`;
  choosing Scale writes `targetQty: 150` in the same PATCH.
- **D4** with `canPlace: false` nothing is written and no popover opens.
- **D5** an unknown `assignmentId` writes nothing and the toast is `"That block is no longer
  on the board."` (mock/spy the toast the way the file already does, if it does; otherwise
  assert nothing was written and skip the toast assertion, and say so).

If any EXISTING case goes red, read it before touching your change and write down whether the
case was wrong or the contract changed (CLAUDE.md §4). The only expected reds are fixtures that
spell a whole `AssignCommand` or `ResolveContext` and now lack the new fields.

## §10. Mutations — apply each on a scratch copy, one at a time, record which case fails

| id | mutation | must be caught by |
| --- | --- | --- |
| M20 | delete step 5 entirely | R34 (R35, R42, R43, R44 collateral) |
| M21 | replace `ctx.overlaps` with `ctx.fitsRun` (containment instead of overlap) | R34 (10:00–15:00 is not inside 10:00–14:00) |
| M22 | drop `x.productId === product.id` from the filter | R39 |
| M23 | drop `x.operatorId === operator.id` | R40 |
| M24 | on a stale retime, fall through to create instead of re-asking | R43 |
| M25 | run step 6 before step 5 | R44 |
| M26 | the bar routes a retime through `onOpen` | C12 |
| M27 | `commandAssignments` reads `a.productId` only | A2 |
| M28 | `retimeAssignmentFromCommand` builds its own `{timerange}` PATCH instead of calling `retimeAssignment` | D2 (no detach), D3 (no prompt) |
| M29 | `same` computed with `>=`/`<=` instead of equality | R35 vs R34 |

Report the table filled in with what actually went red. A mutation nothing catches is a
finding, not a footnote.

## §11. Non-goals, each with its reason

- Same person, same part, **different cell**, overlapping: not this rule (the maintainer said
  "same group"); the capacity probe handles it as today. Leave it.
- Same person, **different part**, same cell: the split-coverage/efficiency flow is exactly
  right there. Leave it.
- Changing the CELL of a block by sentence ("Move … to Cell 2"): the queued MOVE command.
  R-385's "change it" button is its first half; do not build the second.
- A success toast for the re-time: a drag has none; the status line's "changing …" is the
  feedback, and `failWith`'s revert toast is the failure path, unchanged.
- Any change to `CreatePopover.tsx`, `submitCreateDirect`, `create_assignment`, or anything
  under `supabase/`. None is needed.

## §12. Acceptance — in order, all of them

1. `npx vitest run src/test/commandResolve.test.ts src/test/commandBar.test.tsx src/test/commandParse.test.ts src/test/commandPurity.test.ts src/test/commandAssignments.test.ts src/test/dragGesture.test.ts src/test/createPopover.test.tsx` — all green; report each file's count.
2. `npx tsc -b --force` — clean (no migration in this piece, so "clean" is an honest word).
3. `npx eslint src/lib/command src/lib/interaction.ts src/features/board src/test/commandResolve.test.ts src/test/commandBar.test.tsx src/test/commandAssignments.test.ts src/test/dragGesture.test.ts` — clean.
4. `npx prettier --check --end-of-line auto <every file you touched>` — clean.
5. The mutation table (§10) filled in.
6. **Do not run the full `npm run test`; the developer session does.** Do not commit; the
   developer session commits after the review lane reports.

## §13. Your report

Plain prose, in this order: what you built, file by file; every EXISTING case that went red and
your written verdict on each; the §12 counts copied from the runners; the §10 table; anything
in this brief that was wrong when you read the tree (say what the tree actually had); anything
you did not do and why. No claims about the running app: you have no browser; the review lane
drives it.

## §14. The review lane (a second Sonnet, after the build lane reports)

One job: break it. Read the diff (`git diff` on the working tree; nothing is committed). Then:

1. Re-read §2 against the diff: does `CommandBar.tsx` import anything from `src/lib/api/`?
   Does `retimeAssignmentFromCommand` call `retimeAssignment` and nothing else that writes? Is
   the moved code byte-for-byte the old branch apart from the four substitutions? Diff the
   two by eye and say so.
2. Apply M20, M21, M24, M26 and M28 yourself on scratch copies; confirm the named cases go red;
   restore the files (copy first, restore from the copy — never `git checkout --`).
3. Live, as Dana (a plant admin; credentials in `e2e/` — read `roleWalk.spec.ts`'s sign-in
   helper), with Playwright's chromium against `http://localhost:5173` (the dev server is
   expected to be running; if it is not, say so and stop, do not start one). On a day with no
   blocks for the person you pick (check the board first), type the maintainer's two sentences
   in order with a person homed on the cell who needs no training there (session 140 used
   Operator A3 on Cell 3, Line 2, Housing A — verify that is still true in the demo world):
   first `… from 10 to 2` (Enter creates, R-384), then `… from 10 to 3`. Expected: the
   block_exists question with "Change 10:00–14:00" and "Separate block"; press Change; the
   block on the board now reads 10:00–15:00; the database has exactly ONE row for that person
   that day (read it back with a read-only `psql` against `supabase_db_production_scheduler`,
   `assignments` filtered by the operator and the day). Then type it a third time identically:
   the "nothing to change" question with only "Separate block". Then delete the block through
   the app's own Delete button and confirm the row is gone. Screenshot each state to
   `C:\Users\prati\.claude\jobs\0586b6d2\tmp\` and name the files in your report. Write
   nothing else to the dev database. If Dana's grant has drifted again (session 139 found her
   demoted), say so and stop rather than fixing the database.
4. Report: what you tried, what broke, the exact assertion text of anything red, the
   screenshots' names, and one sentence: can this be called done or not, and why.
