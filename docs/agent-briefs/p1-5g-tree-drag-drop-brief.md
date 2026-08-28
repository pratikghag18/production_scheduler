# P1-5g — tree drag-and-drop, and what a cross-structure refusal looks like

**Status:** written by the design session (Opus), 2026-08-25 late. Part A was
implemented, executed and mutation-tested in the design container before this
brief was written; Part B was rendered in headless Chromium and looked at.
**Baseline commit `53005fc` on `Development`. 430 tests in 16 files.**

---

## 1. What this brief is for, in one paragraph

P1-5d shipped half the re-parenting decision. The maintainer chose *"both — drag, with
the menu as fallback"*, and the menu exists: `⋮` → **Move to…**, listing exactly
`legalParentsFor`. `NodeTreeEditor.tsx` has **zero drag handlers** today. This
brief adds the other half. Almost all of it is wiring: `canDropOn` is the ONE
implementation of "is this a legal parent", it is already mutation-tested, and
the menu, the drag preview and the server all agree because they all ask it.
**The one genuinely new thing is the refusal.** A menu can only ever show legal
targets, so it never has to explain itself; a drag goes wherever the pointer
goes and lands on illegal targets constantly. And `canDropOn` deliberately
cannot help — it returns `level_mismatch` for two situations a plant manager
experiences as completely unrelated: *"a Line can only sit under a Department"*
and *"that block is a different site structure"*. Separating those two, in
words and on screen, is what this brief actually owes.

---

## 2. Environment, and how to deliver files

### 2.1 What you can and cannot run

- **You cannot run `npm`.** No `tsc`, no `vitest`, no `eslint`, no `vite build`,
  no browser. The maintainer runs the acceptance on his machine.
- **You CAN run `node --experimental-strip-types`.** Part A
  (`src/features/admin/lib/treeDrag.ts`) is `import type`-only for its types and
  takes two REAL value imports over relative `./x.ts` paths, which strip-types
  resolves. It is fully executable and fully mutation-testable in your
  container, and §8/§9 require you to do both.
- **`node_modules` is readable.** If you need a library's semantics, read the
  installed source. Do not recall it.

### 2.2 Delivery is specified BY OPERATION, not by file (D82 / brief-writing rule 13)

- **NEW file** → a `device_bash` heredoc. Byte-verify with `md5sum` against the
  `/tmp` original you actually tested, before you report.
- **EDIT to an existing file** → a targeted in-place `python3` read-modify-write:
  read, `assert old in s` (and `assert s.count(old) == 1`), replace, write.
- **Never** a tarball, `SendUserFile`, base64, or a re-transcription of a file
  you are changing four lines of.

### 2.3 The measuring instrument is the code nobody tests

Every anchor you use for a mutation must be asserted **present and unique**
before the edit. This project has lost measurements to an anchor on a shared
line (mutated the wrong function) and to an anchor with the wrong indentation
(matched zero lines and scored NOT CAUGHT). Both happened while writing THIS
brief's own mutation table — see §9.4.

---

## 3. Files

| # | Path | Op | Part |
|---|------|----|------|
| F1 | `src/features/admin/lib/treeDrag.ts` | **NEW** (heredoc) | A — executable, mutation-tested |
| F2 | `src/test/treeDrag.test.ts` | **NEW** (heredoc) | A — **a vitest suite** |
| F3 | `src/features/admin/components/NodeTreeEditor.tsx` | **EDIT** (python3) | B — author-only |
| F4 | `src/features/admin/components/NodeTreeEditor.module.css` | **EDIT, append** (python3) | B — author-only |

**Four files. No migration, no RPC, no new hook, no change to `AdminPage.tsx`,
no change to `hierarchy.ts` or `treeView.ts`.** `useMoveNode` already exists and
already invalidates; `NodeTreeEditor` is already handed `shapeSummaries`, which
is structurally the `HierarchyTemplateRef[]` §6 needs for template names.

`NodeTreeEditor.module.css` is **already** in `scaleAudit`'s `REM_SURFACES`, so
no change to `src/test/scaleAudit.ts` is needed — and F4's appended CSS has been
run through the real `unscaledPxLengths` matcher and reports zero offenders
(§7.4).

---

## 4. What exists today — quoted, not summarised (brief-writing rule 12)

### 4.1 `canDropOn`'s check order IS the contract

From `src/features/admin/lib/hierarchy.ts`, in order:

1. dragged node unknown, or its level id absent from `levels` → `invalid_argument`
2. `targetParentId === null` → allowed only when the node's level position is 0; then a collision check
3. self-parent → `node_cycle`
4. unknown target → `invalid_argument`
5. target is the node or one of its descendants → `node_cycle` — **must precede 6**
6. dragged position must be exactly `target position + 1` → `level_mismatch`
7. (6b, P1-5e/D86) both levels must belong to the **same template** → `level_mismatch`
8. path collision → `path_collision`

**Steps 6 and 6b both raise `level_mismatch`, on purpose**, because the server's
`nodes_check_level_adjacency` does too and `canDropOn` exists to predict the
server's code. Do not "improve" this. §6 adds a SEPARATE explanation layer that
reads the same data and never contradicts `canDropOn` about legality.

### 4.2 `move_node` — the actual signature, read from migration 0010

```sql
create function move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order int default null)
```

and its write:

```sql
update nodes set parent_id = p_new_parent_id, sort_order = coalesce(p_sort_order, sort_order)
  where id = p_node_id
  returning * into v_node;
```

**`move_node` CAN reorder siblings.** The design session's first draft of this
brief asserted it could not, and reading the migration corrected it. That fact
changes §5.1 from "impossible" to "deliberately out of scope", which is a
different and more honest claim. `move_node` is defined ONLY in 0010 — 0014 and
0015 do not redefine it (checked with `grep -l`, not assumed).

### 4.3 The client wrapper and hook, quoted

```ts
export interface MoveNodeInput {
  nodeId: string;
  /** `null` re-parents to root — legal only for a position-0 node. */
  newParentId: string | null;
  /** Omit to leave the node's existing `sort_order` unchanged (RPC coalesces). */
  sortOrder?: number;
}
```

```ts
export function useMoveNode() {
  const queryClient = useQueryClient();
  return useMutation<MoveNodeResult, SchedulerError, MoveNodeInput>({
    mutationFn: (input) => moveNode(input),
    onSuccess: () => { void invalidateHierarchy(queryClient); },
  });
}
```

`NodeTreeEditor` already holds `const moveMutation = useMoveNode();`. **Use that
same instance** — do not add a second.

### 4.4 What D90 changed, which none of the older notes mention

Three things, and all three are in this brief's favour:

- **`TreeRow` now carries `guides: readonly boolean[]` and `isLastSibling`.**
  `guides.length === depth`. A drop indicator therefore has real ancestry and
  does not have to guess an indent from a bare `depth` — §6.5 turns that into
  the one number the stylesheet needs.
- **The rows are no longer one flat `<ul>`.** They are **one `<ul>` per site
  structure**, produced by `groupRowsByShape`, each with a `templateId` that may
  be `null` (D90's "a row can never disappear" bucket). A drag has to reason
  about group boundaries in the DOM.
- **`canDropOn` already refuses a cross-structure drop on the DATA** (step 6b).
  So the logic is done. **What this brief owes is what that refusal LOOKS
  like** — §7.3 and the rendering in §10.1.

---

## 5. The decisions this brief encodes

### 5.1 Drop means RE-PARENT, never re-order — and that is a scope choice

A drop on a row makes that row the dropped node's new parent. There is **no
insertion caret between rows.** `move_node` would support it (§4.2), and it is
the natural P1-5i follow-up, but it is not in this brief because:

- nothing in the admin UI reorders siblings today, so drag would be smuggling a
  second new capability into a wiring brief;
- an insertion caret and an adopt highlight have to be disambiguated by where in
  a row the pointer sits (top third / middle / bottom third), which is real
  interaction design with its own verification budget;
- `sort_order` is surfaced nowhere in the admin UI, so a user who reordered by
  drag would produce an ordering they could not see or change any other way.

**A dropped node keeps its existing `sort_order`** and lands wherever
`compareSiblings` (sortOrder, name, id) puts it among its new siblings — which
is **not necessarily last**. This is precisely why §6.5's indicator is an adopt
mark on the PARENT: that is true wherever the node lands, and a caret between
two specific rows would not be.

### 5.2 There is no root drop zone, and that is measured

`describeDrop`'s `targetParentId` is typed `string`, never `string | null`. A
root drop can never be legal for well-formed data: `canDropOn(x, null)` succeeds
only when `x`'s level position is 0, and the adjacency trigger makes a
position-0 node's parent always `NULL` — so the answer is always
`{ok: true, noop: true}`, which `legalParentsFor` already discards as noise.
`treeView.ts` says the same of the menu: *"`(root)` is either the only entry or
absent."* §8's cases **R1–R3 assert this against `canDropOn` and
`legalParentsFor` directly** rather than leaving it as a paragraph.

### 5.3 The four non-goals, named so they do not read as oversights

1. **No reordering / no insertion caret** — §5.1.
2. **No root drop zone** — §5.2.
3. **No auto-expand of a collapsed target on hover.** A timer that mutates
   collapse state in the middle of a pointer capture is its own verification
   problem, and the menu already reaches into collapsed subtrees.
4. **No auto-scroll during drag.** The tree card has no scroll container today
   (`.tree` has no `max-height`); the page scrolls, and a drag near the viewport
   edge simply will not follow. Worth fixing when the tree gets virtualized,
   which is already on the open list.

And one thing that is deliberately NOT added:

5. **No keyboard drag mode.** The `⋮` → **Move to…** menu *is* the keyboard
   path, and it lists exactly the same set this brief highlights, because both
   call `legalParentsFor`. Adding a second keyboard affordance for the same
   operation is how two lists that mostly agree get born.

---

## 6. Part A — `src/features/admin/lib/treeDrag.ts` (F1)

Dependency-free apart from two REAL value imports:

```ts
import type { LevelRow, NodeRow } from "./hierarchy.ts";
import type { HierarchyTemplateRef } from "./shapePicker.ts";
import { canDropOn } from "./hierarchy.ts";
import { legalParentsFor } from "./treeView.ts";
```

Both are relative with an explicit extension, which is what makes
`node --experimental-strip-types` resolve them — the same pattern `treeView.ts`
already uses. No React, no CSS, no `supabase`, no `snake_case`.

### 6.1 The authority rule, restated because it is the whole design

**`canDropOn` decides legality. Nothing in this file re-derives it.** Every
function either forwards `canDropOn`'s answer or asks a question about how to
WORD it. If this module ever disagrees with `canDropOn` about whether a drop is
legal, this module is wrong. §8's **L1–L4 assert that equivalence as a property
over the whole fixture**, not as a comment.

### 6.2 Exported surface

```ts
export interface DropVerdict {
  kind: "ok" | "noop" | "blocked";
  /** canDropOn's own reason string, verbatim; null when the drop is legal. */
  reason: string | null;
  message: string;
}

export function describeDrop(
  draggedId: string,
  targetParentId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
  templates: readonly HierarchyTemplateRef[],
): DropVerdict;

export function eligibleTargetIds(
  draggedId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): Set<string>;

export type GroupDropState = "candidate" | "foreign";

export function groupDropState(
  draggedId: string,
  groupTemplateId: string | null,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): GroupDropState;

export function dropRailIndex(targetDepth: number): number;
```

### 6.3 `describeDrop`

`kind` is derived **entirely** from `canDropOn`'s result:

- `result.ok && !result.noop` → `{ kind: "ok", reason: null }`
- `result.ok && result.noop` → `{ kind: "noop", reason: null }`
- otherwise → `{ kind: "blocked", reason: result.reason }`

**⭐ AMENDED Aug 26 — WRITE THOSE THREE AS DISCRIMINANT CHECKS, NOT AS THE
COMPOUND CONDITIONS ABOVE.** The three bullets are the *truth table*; they are
not the code. Written literally — `if (result.ok && !result.noop) {…}
if (result.ok && result.noop) {…} return {…result.reason…}` — the file
**does not typecheck**: TypeScript's control-flow analysis does not eliminate
`CanDropResult`'s `{ok:true}` arm through a compound condition, so the trailing
`result.reason` is `TS2339: Property 'reason' does not exist`. Order it as

```
if (!result.ok) { … blocked, using result.reason … }
if (result.noop) { … noop … }
… ok …
```

**Found by the agent that built this brief, not by the design session** — whose
reference implementation ran under `node --experimental-strip-types`, which
STRIPS types without checking them, so a purely-typing defect survived a green
43-case run and a clean 12-mutation table. If you are writing a brief and your
reference implementation only ever ran under strip-types, you have not
typechecked it; `node node_modules/typescript/lib/tsc.js -b --force` works from
the repo root and is the check that was missing here.

`message` is chosen by a helper that reads the same `nodes`/`levels` and never
changes `kind`. **The message table is a contract — §8 asserts these strings
character for character, so produce them exactly.** `draggedName` falls back to
`"This node"` and `targetName` to `"that node"` when the row is not found.

| `reason` | condition | message |
|---|---|---|
| — (ok) | | ``Move ${draggedName} into ${targetName}.`` |
| — (noop) | | ``${draggedName} is already in ${targetName}.`` |
| `invalid_argument` | | ``${draggedName} can't be moved right now.`` |
| `node_cycle` | `targetParentId === draggedId` | ``You can't drop ${draggedName} onto itself.`` |
| `node_cycle` | otherwise | ``You can't move ${draggedName} into its own subtree.`` |
| `path_collision` | | ``${targetName} already has a child called ${draggedName}.`` |
| `level_mismatch` | dragged's level not in `levels` | ``${draggedName} can't be moved right now.`` |
| `level_mismatch` | target's level not in `levels` | ``We can't tell which site structure ${targetName} belongs to.`` |
| `level_mismatch` | templates differ, both named | ``${draggedName} belongs to the ${draggedTemplate.name} structure, not ${targetTemplate.name}.`` |
| `level_mismatch` | templates differ, a name missing | ``${draggedName} belongs to a different site structure.`` |
| `level_mismatch` | same template, dragged position 0 | ``A ${draggedLevel.name} is always a top-level node.`` |
| `level_mismatch` | same template, no level at `position - 1` | ``A ${draggedLevel.name} has no level above it in this structure.`` |
| `level_mismatch` | same template, otherwise | ``A ${draggedLevel.name} can only sit under a ${parentLevel.name}.`` |

**Two traps inside that table, both of which the design session hit:**

- **The `level_mismatch` branches are ordered differently from `canDropOn`'s
  checks, on purpose.** `canDropOn` asks position-then-template because that is
  what the server does. This asks *"can we even name the structure"* first,
  because a message saying "different structure" when the truth is "we could not
  resolve the level at all" is a wrong explanation, not a vaguer one. And the
  structure branch precedes the depth branch, because when a drop is BOTH
  cross-structure and wrong-depth, the structure is the dominant fact. **Case
  V14 exists only to catch that ordering** — it was added after a mutation
  swapping the two branches was caught by nothing.
- **The "level above" lookup is scoped to the DRAGGED node's own template.**
  A template-blind `levels.find(l => l.position === p - 1)` returns a real row
  from the *other* structure and produces a confident wrong sentence rather than
  an error. **E1 asserts the exact string** and the fixture is ordered so the
  wrong row is the one a blind lookup finds first.

There is one guard inside the helper — an early return when the dragged node's
level is missing — that is **unreachable at runtime**, because `canDropOn`
already returns `invalid_argument` in exactly that case. **Keep it anyway**: it
is load-bearing for TypeScript's narrowing, since the helper re-does the lookup
independently and `LevelRow | undefined` will not typecheck without it. §9.3
records the mutation that proves it inert, so the next reviewer does not delete
it as dead code and then wonder why nothing failed.

### 6.4 `eligibleTargetIds` and `groupDropState`

`eligibleTargetIds` **is** `legalParentsFor` — the menu's own list — with the
`(root)` entry dropped:

```ts
const out = new Set<string>();
for (const choice of legalParentsFor(draggedId, nodes, levels)) {
  if (choice.id !== null) out.add(choice.id);
}
return out;
```

Reusing it is the point: the rows highlighted during a drag and the entries in
**Move to…** are then provably the same set, because they are the same call.

`groupDropState` returns `"candidate"` only when `groupTemplateId` is non-null
and equal to the dragged node's level's `templateId`; everything else is
`"foreign"` (including a `null` group id, an unknown dragged id, and a dragged
node whose level is unresolvable).

**`"candidate"` is a DELIBERATELY WEAK claim** — it means the block is not ruled
out wholesale, NOT that any particular row in it is legal. Only `"foreign"` is
strong, and it is the one the UI leans on: every row in a foreign block is
refused by step 6b, so the block can be dimmed **once** instead of twenty rows
each refusing separately. **F3 asserts that implication against `canDropOn`
directly**, over every node × every group, rather than trusting the paragraph
you are reading. **F7 asserts the weakness** — that a candidate group does hold
illegal rows — so nobody can "strengthen" `candidate` to mean all-legal without
a test objecting.

### 6.5 `dropRailIndex`

```ts
export function dropRailIndex(targetDepth: number): number {
  return targetDepth + 1;
}
```

A row at depth `d` renders `d` guide rails (`guides.length === d`) plus one
elbow rail, so its elbow is rail index `d`. A new **child** of that row sits at
depth `d + 1`, and its elbow is rail index `d + 1` — which is exactly where the
adopt tick belongs, so it lines up with the elbows of the children the target
already has rather than floating at an invented indent.

**Returned as a UNITLESS COUNT, never a pixel value.** The component writes it
as a custom property and the stylesheet multiplies it by a `rem` rail width. A
px number in a `style` prop is invisible to `scaleAudit`, which reads CSS files
— that is D89, and it is exactly how D90's own row indent
(`paddingLeft: row.depth * 18`) shipped unscaled in this same component.

**X3 and X4 assert this against the COMPOSED output** — real rows from
`buildTreeRows` → `groupRowsByShape` — not against arithmetic. X4 covers depth 0,
where the target renders no rails at all and an off-by-one is likeliest.

---

## 7. Part B — the screens (author-only, unrun)

### 7.1 `NodeTreeEditor.tsx` (F3, EDIT)

State, one object, `null` when no drag is live:

```ts
type DragState = {
  draggedId: string;
  pointerId: number;
  /** computed ONCE at drag start — legalParentsFor is O(n) in canDropOn calls */
  eligible: ReadonlySet<string>;
  hoverId: string | null;
  verdict: DropVerdict | null;
  pointer: { x: number; y: number };
};
```

**The handle.** Each row gains a drag handle **before** the `⋮` button: a real
`<button type="button" className={styles.dragHandle} aria-label={`Drag ${row.node.name}`}>⠿</button>`.
A dedicated handle rather than a draggable row body, deliberately: the row body
already holds a disclosure triangle, selectable text and a menu button, and a
whole-row drag would need a movement threshold to disambiguate every one of them
from a click. The handle has no click action, so `pointerdown` on it is
unambiguously a drag start and no threshold logic exists to get wrong. It is
always rendered (a hover-only affordance does not exist on touch) and
low-contrast until its row is hovered or it takes focus.

**KEEP THE POINTER MECHANICS IN ONE SELF-CONTAINED BLOCK.** The `DragState`
type, the four pointer handlers, the `Escape` listener and the
`elementFromPoint` hit test must sit together in one contiguous region of the
file and must not be entangled with **this component's other state** — they own
"a drag started on element X / the pointer is now over element Y / it was
dropped / it was cancelled", and nothing about `collapsedIds`, the popover, or
the add-root form.

**⭐ AMENDED Aug 26.** This paragraph used to say the block must touch "nothing
about levels, templates or `canDropOn`", which contradicts this same section's
own worked example — `onPointerDown` calls
`eligibleTargetIds(row.node.id, nodes, levels)`, and it has to. The requirement
exists so that **P1-5i can LIFT the block into `LevelEditor`**, and what makes a
lift hard is entanglement with a component's own state, not a call to a pure
function that the lifted version will simply be handed. Calls into `treeDrag.ts`
and the `nodes`/`levels` props are fine; a handler that reads or writes
`collapsedIds` is not.

This is not decoration. **P1-5i will put the same pointer mechanics into
`LevelEditor`** to drag the level list, and two divergent copies of pointer
handling is precisely what `useDragGesture` was extracted on the board to
prevent — *"three separate copies of pointer handling is how the mockup's four
`start*Drag` functions ended up subtly different from each other."* A shared
hook is deliberately **not** being extracted now: P1-5i sits behind two other
pieces of work, and an abstraction built for a caller that far off is
speculative. The requirement above is what keeps the eventual lift mechanical
instead of archaeological. **Do not create `useDragHandle.ts` or any shared
hook in this brief** — that is a scope breach (§11), and if you think it is
unavoidable, report it rather than doing it.

**Each `<li>` gains `data-node-id={row.node.id}`.**

Handlers, all on the handle:

- `onPointerDown` — `e.preventDefault()`,
  `e.currentTarget.setPointerCapture(e.pointerId)`, set `DragState` with
  `eligible: eligibleTargetIds(row.node.id, nodes, levels)`, `hoverId: null`,
  `verdict: null`, pointer from `e.clientX`/`e.clientY`.
- `onPointerMove` — update `pointer`. Hit-test with
  `document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]")`.
  **`elementFromPoint`, not `e.target`** — `setPointerCapture` routes every
  subsequent event to the handle, so `e.target` is always the handle and a
  naive implementation reports one unchanging hover row. Only recompute
  `verdict` (via `describeDrop`) when the resolved id **changes**.
- `onPointerUp` — if `verdict?.kind === "ok"` and `hoverId` is non-null, call
  `moveMutation.mutate({ nodeId: draggedId, newParentId: hoverId })`. **A
  `noop` verdict commits nothing** — dropping a node on the parent it already
  has is not an error and not a write. Release capture, clear state.
- `onPointerCancel` — clear state, mutate nothing.
- While a drag is live, a `window` `keydown` listener cancels on `Escape`.

**Row classes**, in this order:

| condition | class |
|---|---|
| `row.node.id === drag.draggedId` | `styles.rowDragging` |
| `drag.eligible.has(row.node.id)` | `styles.eligible` |
| hover row **and** `verdict.kind === "ok"` | `styles.dropOk` + `styles.dropTick`, plus `style={{ "--drop-rails": dropRailIndex(row.depth) } as React.CSSProperties}` |
| hover row **and** `verdict.kind === "blocked"` | `styles.dropBlocked` |
| hover row **and** `verdict.kind === "noop"` | **nothing** — see below |

A `noop` hover gets no row treatment at all. It is not a failure, so red would
lie; it is not a destination, so green would lie too. The chip still shows its
message, unstyled.

**Group classes.** Each group `<div>` gains `styles.groupForeign` when a drag is
live and `groupDropState(drag.draggedId, group.templateId, nodes, levels)` is
`"foreign"`. When `showShapeHeadings` is true, that group's `.shapeHead` also
gains `<span className={styles.foreignNote}>different structure — not a
destination</span>`. **Only when `showShapeHeadings`** — with a single group
there is no heading to hang it on, and a single resolvable group is never
foreign anyway.

**The chip**, rendered once at the end of the `<section>` while a drag is live:

```tsx
<div
  className={`${styles.dragChip}${verdictBlocked ? " " + styles.dragChipBlocked : ""}${flip ? " " + styles.dragChipFlip : ""}`}
  style={{ left: drag.pointer.x, top: drag.pointer.y }}
  aria-hidden="true"
>
  <span className={styles.dragChipName}>{draggedName}</span>
  {drag.verdict && <span className={styles.dragChipMsg}>{drag.verdict.message}</span>}
</div>
```

`flip` is `drag.pointer.x > window.innerWidth * 0.72`. **The inline style
carries only the raw pointer coordinates**, which are px by nature; the offset
from the pointer lives in the stylesheet in `rem` (§7.2). The chip is
`pointer-events: none` — without it the chip becomes its own
`elementFromPoint` hit and the hover row freezes, which is the single most
common bug in this pattern.

**The live region**, also once, so the refusal reason exists for a screen reader
and not only for an eye:

```tsx
<p className={styles.srOnly} aria-live="polite">{drag?.verdict?.message ?? ""}</p>
```

The `<section>` gains `styles.dragging` while a drag is live (it suppresses text
selection).

### 7.2 `NodeTreeEditor.module.css` (F4, EDIT — append verbatim)

This CSS was rendered in headless Chromium and looked at, and **three defects
were found and fixed in the picture, not in review** (§10.1). Append it as-is;
do not re-derive it.

```css
/* ---------------------------------------------------------------------------
   P1-5g — tree drag and drop.

   Appended to `NodeTreeEditor.module.css`. Every length is `rem` (D84) and no
   value here is ever set from a `style` prop except `--drop-rails`, which is a
   UNITLESS COUNT — the rem arithmetic stays in this file, so the indent cannot
   escape `scaleAudit` the way D90's inline `paddingLeft: depth * 18` did (D89).
   Hairline borders stay in px, as everywhere else in this file.
   --------------------------------------------------------------------------- */

/* The drag handle. Always rendered — a hover-only affordance does not exist on
   touch — but low-contrast until its row is hovered or it takes focus. */
.dragHandle {
  flex: none;
  width: 1.375rem;
  height: 1.375rem;
  border: 0;
  border-radius: 0.3125rem;
  background: transparent;
  color: var(--grid);
  cursor: grab;
  font-size: 0.75rem;
  line-height: 1;
  padding: 0;
  /* A touch drag must move the node, not scroll the page. */
  touch-action: none;
}

.row:hover .dragHandle,
.dragHandle:focus-visible {
  color: var(--ink-2);
}

.dragHandle:active {
  cursor: grabbing;
}

/* Every legal destination for the node currently being dragged. This is the
   SAME SET "Move to…" lists, because it is the same `legalParentsFor` call —
   two separately-derived lists that mostly agree is the failure this project
   keeps paying for. */
.eligible {
  background: var(--page);
  /* DASHED and on `--axis`, not `--grid`. The first version used `--page` on
     `--surface` (a three-unit difference) with a `--grid` hairline, and the
     rendering showed NOTHING — the one affordance drag adds over the menu was
     invisible while every declaration was correct. D89's shape exactly.
     Dashed rather than solid because these rows are POSSIBLE destinations, not
     the chosen one; the chosen one is `.dropOk`, which is solid. */
  outline: 1px dashed var(--axis);
  outline-offset: -1px;
}

/* The row being dragged, shown as lifted out of the tree. `opacity` is safe
   here — nothing inside it needs to out-render its parent. */
.rowDragging {
  opacity: 0.45;
}

/* The row under the pointer, when the drop is legal. */
.dropOk {
  background: var(--page);
  box-shadow: inset 0 0 0 2px var(--signal-ok);
  /* The chosen target is also an eligible one; suppress the dashed hint so the
     two treatments do not stack on the same row. */
  outline: none;
}

/* The row under the pointer, when it is not. */
.dropBlocked {
  box-shadow: inset 0 0 0 2px var(--crit);
  cursor: not-allowed;
}

/* The "will adopt" tick: a stub at the target row's bottom edge, sitting in the
   SAME rail a real child's elbow occupies, so it lines up with the children the
   target already has instead of floating at an invented indent. That alignment
   is what `dropRailIndex` computes from D90's `guides` ancestry.

   It is deliberately NOT a horizontal line BETWEEN two rows. `move_node` CAN
   reorder — it takes `p_sort_order int default null` and writes
   `sort_order = coalesce(p_sort_order, sort_order)` (migration 0010) — but
   P1-5g does not ship reordering, so a caret would promise an outcome the drop
   does not deliver. A dropped node keeps its existing `sort_order` and lands
   wherever `compareSiblings` puts it among its new siblings, which is not
   necessarily last; an adopt mark on the PARENT is true regardless of where it
   lands, and a caret between two rows would not be. */
/* `position: relative` is LOAD-BEARING and was missing in the first version:
   `.row` is not positioned, so the tick was laid out against the initial
   containing block and rendered off the card entirely. The suite was green and
   the affordance simply was not on screen. */
.dropTick {
  position: relative;
}

.dropTick::after {
  content: "";
  position: absolute;
  left: calc(0.25rem + var(--drop-rails) * 1.125rem + 0.5rem);
  bottom: calc(-1 * var(--row-pad-y));
  width: 0.875rem;
  border-top: 2px solid var(--signal-ok);
}

/* A whole site-structure block that cannot hold the dragged node at all
   (`groupDropState` === "foreign"). Dimmed ONCE, rather than twenty rows each
   refusing separately — which is what a cross-structure drag looks like on
   screen, and the thing `canDropOn` returning false could never show. */
/* Dimmed by COLOUR, never by `opacity` on the block.
   The first version used `opacity: .42` on the group — and an `opacity` below 1
   creates a stacking context its children cannot escape, so the red refusal
   outline on the hovered row was dimmed by the very thing that was supposed to
   explain it. The message you most need to read was the one you could least
   see. Only text and rails are muted here; borders and outlines keep full
   strength. */
.groupForeign .name,
.groupForeign .levelChip,
.groupForeign .shapeName,
.groupForeign .shapePath,
.groupForeign .disclosure,
.groupForeign .menuBtn {
  color: var(--muted);
}

.groupForeign .guides {
  opacity: 0.45;
}

.groupForeign .row {
  cursor: not-allowed;
}

/* Said ONCE, on the block, so twenty rows do not each have to refuse
   separately. This is what a cross-structure drag looks like on screen —
   `canDropOn` returning false is the logic, and this is the affordance. */
.foreignNote {
  font-size: 0.6875rem;
  color: var(--crit);
  white-space: nowrap;
}

/* The chip that follows the pointer: what is being dragged, and the verdict.
   `position: fixed` because it is chrome, not part of the tree's flow, and
   `pointer-events: none` so it can never become its own drop target. */
.dragChip {
  position: fixed;
  z-index: 60;
  pointer-events: none;
  max-width: 20rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid var(--axis);
  background: var(--surface);
  box-shadow: 0 0.25rem 0.75rem rgb(0 0 0 / 18%);
  font-size: 0.75rem;
  /* The OFFSET from the pointer lives here, in `rem`, not in the `style` prop.
     The component may only ever write raw `left`/`top` pixel coordinates,
     because that is what `clientX`/`clientY` are; every dimension stays in the
     stylesheet where `scaleAudit` can read it (D89). */
  transform: translate(0.75rem, 1rem);
}

/* Near the right edge the chip flips to the pointer's left, so a refusal
   message is never the thing that runs off screen. */
.dragChipFlip {
  transform: translate(calc(-100% - 0.75rem), 1rem);
}

.dragChipName {
  display: block;
  font-weight: 600;
}

.dragChipMsg {
  display: block;
  color: var(--ink-2);
}

.dragChipBlocked {
  border-color: var(--crit);
}

.dragChipBlocked .dragChipMsg {
  color: var(--crit);
}

/* While a drag is live, nothing in the tree should select text. */
.dragging,
.dragging * {
  user-select: none;
}

/* The drag verdict, announced. The floating chip is `aria-hidden` chrome
   following a pointer; this is the same sentence in a polite live region, so
   the refusal reason exists for a screen reader and not only for an eye. */
.srOnly {
  position: absolute;
  /* 0.0625rem == 1px at the default root. Written in `rem` because a raw px
     length in a REM_SURFACE file is a `scaleAudit` failure (D84/D89) — and the
     audit is right to insist even here, since the alternative is an exemption
     that the next visually-hidden element inherits by accident. A hidden box
     measuring 1.35px at 4K is harmless. */
  width: 0.0625rem;
  height: 0.0625rem;
  margin: -0.0625rem;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

### 7.3 What a cross-structure refusal looks like, stated plainly

This is the thing the brief owes, so it is written out rather than left to the
CSS:

1. **The whole foreign block is muted by COLOUR** — text and rails only, never
   `opacity` on the block. An `opacity` below 1 creates a stacking context its
   children cannot escape, so the red refusal outline on the hovered row gets
   dimmed by the very thing meant to explain it. Measured: the first render did
   exactly that, and the message you most need to read was the one you could
   least see.
2. **The block says why, once**, in its heading: *"different structure — not a
   destination"*. Twenty rows do not each have to refuse separately.
3. **The hovered row still gets its own red outline at full strength**, and the
   chip names both structures: *"Line 2 belongs to the Standard Plant structure,
   not Compact Site."*
4. **Nothing in the foreign block is ever dashed**, because
   `eligibleTargetIds` cannot contain any of it — which is F3's assertion, in
   pixels.

### 7.4 `scaleAudit` — already checked, not assumed

The appended CSS was run through the repo's own `unscaledPxLengths` and
`countUiScaleUses` from `src/test/scaleAudit.ts`, both against `drag.css` alone
and against the concatenated `NodeTreeEditor.module.css`: **zero offenders, zero
`--ui-scale` uses.** `NodeTreeEditor.module.css` is already in `REM_SURFACES`,
so `missingRemSurfaces` is unaffected and **`src/test/scaleAudit.ts` must not be
edited by this brief.**

One detail worth knowing before you "simplify" it: the `.srOnly` rule uses
`0.0625rem` where every visually-hidden utility on earth writes `1px`. A raw px
length in a `REM_SURFACES` file is a `scaleAudit` failure, and the alternative —
an exemption — is something the next hidden element inherits by accident. A
hidden box measuring 1.35px at 4K is harmless.

---

## 8. Acceptance — `src/test/treeDrag.test.ts` (F2)

**A VITEST suite: `describe` / `it` / `expect`, imported from `"vitest"`.**
`npm run test` is `vitest run` and it collects every `src/test/*.test.ts`; a file
there that is not a `describe`/`it` suite **fails the whole run**. P1-5f's suite
existed at exactly the right path, ran, printed 42 passing assertions, and failed
`npm run test` on collection with *"No test suite found in file"* — passing and
failing at once depending which runner you asked. **The tell was the count: 349
before, 349 after.**

**Every case is a plain `it()`. No `it.each`, no dynamic registration.** The
count vitest reports is therefore exactly the number of `it(` lines, and the
prediction below is checkable by arithmetic.

**43 cases. `npm run test` must go from 430 in 16 files to 473 in 17 files.**

### 8.1 The fixture — use this verbatim

Every trap in it is load-bearing and several were discovered by executing the
mutation table, not by design (§9.4). Reproduce it exactly.

```ts
const TPL_S = "tpl1"; // "Standard Plant" — Site > Department > Line > Work Cell
const TPL_C = "tpl2"; // "Compact Site"   — Site > Line

const TEMPLATES: HierarchyTemplateRef[] = [
  { id: TPL_S, name: "Standard Plant" },
  { id: TPL_C, name: "Compact Site" },
];

// Deliberately NOT in position order, and Compact's position-1 level comes
// FIRST — see the header note on the template-blind lookup.
const LEVELS: LevelRow[] = [
  { id: "lv2", templateId: TPL_C, position: 0, name: "Site", isSchedulable: false },
  { id: "lv5", templateId: TPL_C, position: 1, name: "Line", isSchedulable: true },
  { id: "lv1", templateId: TPL_S, position: 0, name: "Site", isSchedulable: false },
  { id: "lv3", templateId: TPL_S, position: 1, name: "Department", isSchedulable: false },
  { id: "lv6", templateId: TPL_S, position: 3, name: "Work Cell", isSchedulable: true },
  { id: "lv4", templateId: TPL_S, position: 2, name: "Line", isSchedulable: false },
];

function node(
  id: string,
  name: string,
  path: string,
  parentId: string | null,
  levelId: string,
  sortOrder = 0,
): NodeRow {
  return { id, name, path, parentId, levelId, sortOrder, active: true };
}

const NODES: NodeRow[] = [
  node("n5", "Plant 1", "plant_1", null, "lv1", 0),
  node("n2", "Assembly", "plant_1.assembly", "n5", "lv3", 0),
  node("n8", "Packing", "plant_1.packing", "n5", "lv3", 1),
  node("n1", "Line 1", "plant_1.assembly.line_1", "n2", "lv4", 0),
  node("n7", "Line 2", "plant_1.assembly.line_2", "n2", "lv4", 1),
  node("n3", "Line 1", "plant_1.packing.line_1", "n8", "lv4", 0),
  node("n6", "Cell 1", "plant_1.assembly.line_1.cell_1", "n1", "lv6", 0),
  node("n9", "Plant 2", "plant_2", null, "lv2", 2),
  node("n4", "Line A", "plant_2.line_a", "n9", "lv5", 0),
  node("n10", "Orphan", "orphan", null, "lv_missing", 3),
  // A SECOND Standard root. Two roots in one group is the case D90's guide
  // fixture needed and the only way to reach "a position-0 node dropped on a
  // same-structure node that is not its own descendant" — every other
  // Standard node is beneath Plant 1, so V9 without this row measures a
  // node_cycle and silently stops testing what its name claims.
  node("n11", "Plant 3", "plant_3", null, "lv1", 4),
];
```

Also define, after it:

```ts
const drop = (d: string, t: string) => describeDrop(d, t, NODES, LEVELS, TEMPLATES);

// Compared as SORTED ARRAYS, not as Sets — see §8.3.
const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

const okTargets = (draggedId: string): Set<string> => {
  const out = new Set<string>();
  for (const n of NODES) if (drop(draggedId, n.id).kind === "ok") out.add(n.id);
  return out;
};
```

and, for group X:

```ts
const ROWS = buildTreeRows(NODES, LEVELS, new Set<string>());
const GROUPS = groupRowsByShape(ROWS, LEVELS, TEMPLATES);
const allRows = GROUPS.flatMap((g) => g.rows);
const rowOf = (id: string) => allRows.find((r) => r.node.id === id);
```

### 8.2 The cases

**R — no root drop zone (3)**

| id | claim |
|---|---|
| R1 | `canDropOn("n5", null, …)` is `{ok: true, noop: true}` — legal but always a no-op |
| R2 | `legalParentsFor("n5", …)` contains no `id === null` |
| R3 | `legalParentsFor("n1", …)` contains no `id === null` either |

**V — `describeDrop` verdicts and wording (14)**

| id | drop | expected |
|---|---|---|
| V1 | n7 → n8 | `ok`, `reason: null`, `"Move Line 2 into Packing."` |
| V2 | n1 → n2 | `noop`, `"Line 1 is already in Assembly."` |
| V3 | n1 → n1 | `blocked` / `node_cycle` / `"You can't drop Line 1 onto itself."` |
| V4 | n2 → n6 | `node_cycle` / `"You can't move Assembly into its own subtree."` — **not** level_mismatch; proves check order |
| V5 | n1 → n8 | `path_collision` / `"Packing already has a child called Line 1."` |
| V6 | n1 → n4 | `level_mismatch` / `"Line 1 belongs to the Standard Plant structure, not Compact Site."` — position-LEGAL, refused by 6b alone |
| V7 | n1 → n9 | same message — proves it does not flip on which `canDropOn` step fired |
| V8 | n6 → n5 | `level_mismatch` / `"A Work Cell can only sit under a Line."` |
| V9 | n5 → n11 | `"A Site is always a top-level node."` |
| V10 | n1 → n10 | `"We can't tell which site structure Orphan belongs to."` |
| V11 | n10 → n5 | `invalid_argument` / `"Orphan can't be moved right now."` |
| V12 | "nope" → n2 | `blocked` / `invalid_argument` / `"This node can't be moved right now."` |
| V13 | n1 → n4, `templates: []` | `"Line 1 belongs to a different site structure."` |
| V14 | n9 → n5 | `level_mismatch` / `"Plant 2 belongs to the Compact Site structure, not Standard Plant."` — a position-0 node dropped cross-structure |

**E — the level-above lookup is template-scoped (2)**

| id | claim |
|---|---|
| E1 | n1 → n5 is exactly `"A Line can only sit under a Department."`, and the message does **not** contain `"under a Line"` |
| E2 | with `lv3` filtered out of `levels`, n1 → n5 is `"A Line has no level above it in this structure."` |

**L — `eligibleTargetIds` ≡ `describeDrop` (7)**

| id | claim |
|---|---|
| L1 | `sorted(eligibleTargetIds("n7"))` equals `sorted(okTargets("n7"))` |
| L2 | same for n1 |
| L3 | same for n6 |
| L4 | same for n9, **and both are empty** |
| L5 | `eligibleTargetIds("n7")` is non-empty and contains `n8` — so L1 is not vacuously true |
| L6 | `eligibleTargetIds("n1")` contains neither `n9` nor `n4` |
| L7 | an unknown dragged id yields an empty set without throwing |

**F — `groupDropState` (7)**

| id | claim |
|---|---|
| F1 | `("n1", TPL_S)` is `"candidate"` |
| F2 | `("n1", TPL_C)` is `"foreign"` |
| F3 | for **every** node × **every** group where the state is `"foreign"`, `describeDrop(dragged, target).kind !== "ok"` for every row in that group — **and the loop asserts it examined at least one pair** |
| F4 | `("n1", null)` is `"foreign"` |
| F5 | `("n10", TPL_S)` and `("n10", TPL_C)` are both `"foreign"` |
| F6 | `("nope", TPL_S)` is `"foreign"` |
| F7 | a candidate group holds illegal rows: `("n1", TPL_S)` is `"candidate"` **and** `drop("n1","n5")` is `blocked` |

**X — `dropRailIndex`, composed (4)**

| id | claim |
|---|---|
| X1 | `dropRailIndex(0) === 1` |
| X2 | `dropRailIndex(2) === 3` |
| X3 | for the real rows: `rowOf("n2").depth === 1`, and `dropRailIndex(that)` equals `rowOf("n1").guides.length` |
| X4 | at depth 0: `rowOf("n5").depth === 0`, `guides.length === 0`, and `dropRailIndex(0)` equals `rowOf("n2").guides.length` |

**N — malformed arguments (6)** — verification-standard rule 4. A clean sweep is
a pass, not silence.

| id | claim |
|---|---|
| N1 | `describeDrop("n1","n2",[],[],[])` → `blocked` / `invalid_argument`, no throw |
| N2 | nodes present, `levels: []` → `invalid_argument` |
| N3 | n1 → `"nope"` → `invalid_argument` / `"Line 1 can't be moved right now."` |
| N4 | `eligibleTargetIds("n1", [], [])` is empty |
| N5 | `groupDropState("n1", TPL_S, [], [])` is `"foreign"` |
| N6 | `dropRailIndex(-1) === 0` — recorded, not clamped |

3 + 14 + 2 + 7 + 7 + 4 + 6 = **43**.

### 8.3 Compare Sets as sorted arrays, and here is why

L1–L4 assert on `sorted(...)`, not on the `Set`s themselves. The design
session's own strip-types shim compared with `JSON.stringify`, and
`JSON.stringify(new Set(["a"]))` is `"{}"` — so **every pair of Sets compared
equal and mutation M6 went uncaught** until the shim was fixed. vitest's own
`toEqual` handles Sets correctly, so this would have worked in CI; asserting on
sorted arrays means the case does not depend on that being true of whatever
runner reads it. **A measurement instrument that disagrees with the runner that
will guard the code is verification-standard rule 2b in a new form.**

### 8.4 Run it against the unfixed build, and read the result honestly

Before you write `treeDrag.ts`, the suite fails to import. That is a *module
resolution* failure, not a behavioural one, and it proves nothing except that
the file is absent. When you report, **separate the cases that fail for a
behavioural reason from those that fail because a symbol does not exist yet**
(verification-standard rule 6b — eight of P1-5f's ten "failing" cases failed
with `function does not exist`, which any signature change produces).

---

## 9. Mutation table — EXECUTED by the design session, not reasoned

All twelve were applied one at a time to a reference implementation, the suite
re-run, and the failing case names recorded. **The "must fail" column is the
commitment. The "also broke" column is measured against the design session's
reference implementation — your cases may differ; report the difference, do not
chase it** (brief-writing rule 14: P1-5f's collateral predictions were executed
and still wrong, because they were executed against the reference's own cases).

### 9.1 The twelve

| # | mutation | must fail | also broke (reference only) |
|---|---|---|---|
| M1 | level-above lookup drops `l.templateId === draggedLevel.templateId` | **E1** | E2 |
| M2 | the position-0 branch is moved ABOVE the cross-structure branch | **V14** | — |
| M3 | cross-structure compares `position` instead of `templateId` | **V8** | E1, E2, V14 |
| M4 | `noop` collapsed into `ok` | **V2** | L1, L2, L3 |
| M5 | self-drop no longer distinguished from a subtree cycle | **V3** | — |
| M6 | `eligibleTargetIds` re-derives the rule (all same-template nodes) instead of calling `legalParentsFor` | **L1** | L2, L3, L4 |
| M7 | the unresolved (`null`) group returns `"candidate"` | **F4** | — |
| M8 | `groupDropState` ignores the dragged node's structure, always `"candidate"` | **F2** | — |
| M9 | `dropRailIndex` returns `targetDepth` | **X1** | X2, X3, X4, N6 |
| M10 | an unresolvable TARGET is blamed on the structure instead | **V10** | — |
| M11 | the collision message swaps container and child | **V5** | — |
| M12 | `describeDrop` calls `canDropOn` with the arguments swapped | **V1** | E1, E2, L1, L3, V2, V4, V5, V8, V10, V11 |

**Twelve designed, twelve caught, none crashed, none NOT CAUGHT.**

### 9.2 Five UNPRESCRIBED mutations — also run, also all caught

Not part of your required table; recorded so you know the suite was probed
beyond its own brief (verification-standard rule 2). U1: an unknown dragged id
no longer forces `"foreign"` → F6, N5. U2: `eligibleTargetIds` includes the
dragged node itself → L1–L4, L7, N4. U3: `groupDropState` compares a LEVEL id
against a TEMPLATE id → F1, F3, F7. U4: `eligibleTargetIds` counts `noop`
targets as eligible → L1, L2, L3. U5: the level-above lookup reads
`position + 1` → E1, E2, V8.

### 9.3 One mutation executed and proved INERT — reported, not hidden

**N1 — deleting the `if (!draggedLevel)` guard inside the message helper: NOT
CAUGHT, and correctly so.** It is a **redundant clause**: `canDropOn` returns
`invalid_argument` whenever the dragged node's level is missing, so the
`level_mismatch` branch structurally cannot see that state. No case can catch it
because no input can reach it. **Keep the guard** — §6.3 explains that it is
load-bearing for the type narrowing even though it is dead at runtime — and do
not add a case for it. (Brief-writing rule 13: an inert mutation must be
reported as executed-and-inert, with its kind, not omitted and not listed as a
hole.)

### 9.4 Three defects the design session's own first pass had — expect the same

Recorded because they are the failure modes of this exact procedure, and because
you will probably hit at least one:

1. **M1's anchor had the wrong indentation and matched zero lines**, which the
   runner would have scored as NOT CAUGHT if the anchor-uniqueness assertion had
   not been there. Assert every anchor is present **and unique**.
2. **The measuring shim's `toEqual` could not see Sets** (§8.3), so M6 read as
   caught-by-one-case when it should have broken four.
3. **V9 originally dropped `n5` onto `n2`, which is `n5`'s own descendant**, so
   it measured a `node_cycle` and silently stopped testing what its name
   claimed. Fixed by adding `n11` — a second Standard root — to the fixture.
   **A case whose name promises more than its fixture can deliver is how a
   coverage gap hides in plain sight** (verification-standard rule 3b).

---

## 10. What this brief CAN and cannot verify

### 10.1 The rendering — already done, and it found three defects

Part B was rendered in headless Chromium against the **real** stylesheets, with
markup emitted by the **real** pure functions, at 1440 / 2560 / 3840 CSS px.
Three defects were found in the picture that the suite could not see:

1. **The eligible-row highlight was invisible.** `background: var(--page)` on
   `var(--surface)` is a three-unit difference with a `--grid` hairline. Every
   declaration was correct and the one affordance drag adds over the menu simply
   did not render. Now a dashed `--axis` outline. *(D89's shape exactly: a
   fully-compliant stylesheet and a defect made of an absent contrast.)*
2. **`opacity` on the foreign group dimmed the refusal it was explaining**
   (§7.3, item 1). Now colour-based.
3. **The adopt tick had no positioned ancestor** — `.row` is not
   `position: relative`, so the tick was laid out against the initial containing
   block and rendered off the card entirely. **The most novel piece of the whole
   affordance was silently absent while every test passed.**

The tick's alignment was then **measured**, not eyeballed: its computed left
edge against the left edge of the elbow drawn by the target's existing child.

| viewport | root font | tick left | child elbow | delta |
|---|---|---|---|---|
| 1440 | 16px | 437.00 | 437.00 | 0.00 |
| 2560 | 19.11px | 731.77 | 731.76 | 0.01 |
| 3840 | 21.60px | 1063.60 | 1063.58 | 0.02 |

Sub-pixel at every width, and the whole affordance scales (tick width
14 → 16.72 → 18.89px). **X3/X4 assert the same claim numerically; this asserts it
in pixels.**

### 10.2 Required in your report: quote your dependencies AND evaluate them

Not *"what would you expect `tsc` to complain about"* — that question invites
reasoning and has produced confident wrong answers here twice. Instead:

- **Which generated or third-party artifacts does your code depend on, and what
  does each one actually say? Quote the line.** In particular: `TreeRow`'s real
  declaration in `treeView.ts` (does `guides` have the type and the length
  invariant §6.5 assumes?), and `ShapeGroup.templateId`'s nullability.
- **At what input does each expression stop changing?** `dropRailIndex` is a
  one-liner; say what its domain actually is and which end of it your cases
  touch.
- **`shapeSummaries` is `readonly ShapeSummary[]` and §6.2 wants
  `readonly HierarchyTemplateRef[]`.** Confirm structurally that the former
  satisfies the latter by reading both declarations, and say so. If it does not,
  that is a real finding — report it, do not paper over it with a cast.

### 10.3 Not verifiable here

- **Everything in Part B.** No npm, no React, no real browser DOM. `tsc`, ESLint,
  the production build and the in-browser behaviour are the maintainer's run.
- **Pointer capture semantics.** `setPointerCapture` / `elementFromPoint` were
  reasoned from spec, not exercised — the rendering was static markup, not a
  live drag. **This is the single most likely place for a real defect in this
  brief**, and §7.1 names the two traps (`e.target` is always the handle; the
  chip must be `pointer-events: none`) precisely because they cannot be tested
  here.
- **Touch.** `touch-action: none` on the handle is specified and unexercised.

---

## 11. Scope fence

Fenced by **property**, not by a blanket file prohibition (brief-writing rule
10) — and if you must breach it, breach deliberately and **report it**:

- **No new RPC, no migration, no change to any `supabase/**` file.** The server
  already does everything this needs.
- **No change to `hierarchy.ts` or `treeView.ts`.** `canDropOn`,
  `legalParentsFor`, `flattenTree` and `groupRowsByShape` are all already
  mutation-tested; F1 consumes them and adds nothing to them. **If you find
  yourself wanting to export `compareSiblings`, stop** — that is the reordering
  feature §5.1 excludes, arriving through the side door.
- **No change to `src/test/scaleAudit.ts`** (§7.4).
- **No change to `AdminPage.tsx`, `LevelEditor.tsx`, `ShapePicker.tsx`, or
  anything under `src/features/board/`.**
- **No optimistic update.** Every mutation in this component invalidates and
  refetches; a move re-paths a whole subtree server-side and reproducing that
  cascade client-side is the duplicated logic the project forbids.
- **No new dependency.** No drag-and-drop library.

---

## 12. Final checklist — every line must be true before you report

- [ ] `src/features/admin/lib/treeDrag.ts` exists, is `import type`-only for its
      types, and takes exactly the two relative value imports §6 names.
- [ ] `node --experimental-strip-types` runs the module and **all 43 cases
      pass cold**.
- [ ] `src/test/treeDrag.test.ts` exists **and is a vitest suite** —
      `describe`/`it`/`expect` imported from `"vitest"`, 43 plain `it()` calls,
      no `it.each`, no dynamic registration.
- [ ] The fixture is §8.1's, verbatim, including `n11` and the deliberate
      `LEVELS` ordering.
- [ ] Every message string matches §6.3's table character for character.
- [ ] All **twelve** §9.1 mutations applied one at a time, each confirmed to
      break its named "must fail" case; every anchor asserted present and unique;
      the file restored and re-verified green afterwards.
- [ ] N1 re-run and reported as executed-and-inert, and the guard **kept**.
- [ ] Differences between your collateral and §9.1's "also broke" column reported
      as differences, not chased.
- [ ] `NodeTreeEditor.tsx` edited in place with a targeted `python3`
      read-modify-write; `data-node-id` on every `<li>`; the drag handle before
      the `⋮` button; `elementFromPoint` (not `e.target`) for the hit test; the
      chip `pointer-events: none` and `aria-hidden`; the live region present.
- [ ] `NodeTreeEditor.module.css` gained §7.2's block **verbatim**, appended.
- [ ] No file outside §3's table changed. Any breach of §11 reported explicitly.
- [ ] Your report quotes its dependencies and evaluates them (§10.2).
- [ ] **The prediction for the maintainer's run: `npm run test` goes 430 → 473, in 17
      files.** If your count differs, say so and reconcile it before reporting —
      a suite that adds zero to the framework's own number is P1-5f's defect
      arriving again.
