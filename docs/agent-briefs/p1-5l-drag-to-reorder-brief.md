# P1-5l + P1-5i — drag to reorder, on screen

**One build, two surfaces.** The node tree gains reorder-as-well-as-re-parent; the
level list gains drag. They ship together because they share one pointer block,
and building them apart means writing that block twice and then reconciling two
copies (D95b).

---

## §1. Read this first: PART A IS ALREADY IN THE REPO. DO NOT REWRITE IT.

The design session wrote, probed and mutation-tested the decision logic and it is
**already committed to the files below**. Your job is the on-screen half.

| already done, do not touch | what it gives you |
|---|---|
| `src/features/admin/lib/treeDrag.ts` — `rowDropZones`, `resolveDropZone`, `DropZone` | what a row offers, and which zone a pointer is in |
| `src/features/admin/lib/levelDraft.ts` — `{ kind: "moveTo", from, to }` | the level-list reorder, as one draft action |
| `src/test/treeDrag.test.ts` — 79 cases | 36 of them new, for the above |
| `src/test/levelDraft.test.ts` — 54 cases | 16 of them new |

Verified: **36 assertions / 16 mutations for the tree, 23 / 7 for the levels, all
caught.** If you believe one of these functions is wrong, **say so in your report
and stop** — do not edit it. That is rule 15: a disagreement gets re-measured by
the design session, not patched by the builder.

### The one thing you must understand about them

**A row offers TWO zones or ONE, never three.** Adoption needs the dragged node
one rung *below* the reference row; a sibling slot needs it on the *same* rung.
Both cannot hold, so:

- the row is a **peer** → `before` + `after`, the row splits in **half**
- the row is a possible **parent** → `adopt`, the **whole row**
- neither → the row refuses

`resolveDropZone` already encodes this. **Do not add band fractions**, a
three-way split, or a clamp — all three were written, came back uncatchable by
any test, and were deleted. `§19.48` has the proof.

---

## §2. Non-goals, with reasons

1. **No keyboard drag mode.** The "Move to…" menu is the keyboard path and
   already exists. A second one would be two implementations of one rule.
2. **No auto-scroll and no auto-expand on hover.** Both are real features and
   both are separate; a drag that also mutates the tree's collapse state while
   you hold the pointer is a different design conversation.
3. **No multi-select drag.** One node at a time.
4. **No cross-surface drag.** A level cannot be dragged into the node tree or
   vice versa; they are different lists that happen to share a gesture.
5. **No change to `place_node`, `move_node` or any migration.** The server half
   has been applied since migration 0017.
6. **No new error codes.** The closed set stays at twelve.

---

## §3. Files

| file | operation |
|---|---|
| `src/lib/interaction.ts` | **NEW** — see §4.1 |
| `src/features/board/lib/interaction.ts` | edit — re-export, see §4.1 |
| `src/features/admin/lib/dragPointer.ts` | **NEW** — pure, see §4.2 |
| `src/test/dragPointer.test.ts` | **NEW** — vitest, see §7 |
| `src/features/admin/components/NodeTreeEditor.tsx` | edit — §5 |
| `src/features/admin/components/NodeTreeEditor.module.css` | edit — §6 |
| `src/features/admin/components/LevelEditor.tsx` | edit — §5.4 |
| `src/features/admin/components/LevelEditor.module.css` | edit — §6.3 |

**Plan by property, not by count.** If the render makes a ninth file necessary,
add it and report the breach — do not contort to hit the table.

---

## §4. The pure layer you add

### §4.1 `DRAG_THRESHOLD_PX` moves to `src/lib/`

It is `4` and it lives at `src/features/board/lib/interaction.ts:17` today (D32).
The admin tree needs the same number, and **`conventions.md` forbids
cross-feature imports** — `src/features/auth/` is the only named exception.

Create `src/lib/interaction.ts` holding the constant, and **re-export it from
the board's file** so no board import changes:

```ts
// src/features/board/lib/interaction.ts — add near the old definition
export { DRAG_THRESHOLD_PX } from "@/lib/interaction";
```

Precedent: `placement.ts` moved to `src/lib/` the moment it had two consumers in
two features. **Do not duplicate the number.** A test that asserts both features
see the same value is worth one line.

### §4.2 `src/features/admin/lib/dragPointer.ts` — NEW, pure, `import type` only

This is the shared pointer block D95b exists for. It must be **dependency-free
and `import type`-only** so it runs under `node --experimental-strip-types` and
is testable without a DOM.

**It holds decisions, not effects.** No `document`, no `window`, no React.

```ts
export interface PointerOrigin { x: number; y: number; }

/** Has the pointer moved far enough to count as a drag rather than a click? */
export function passedThreshold(
  origin: PointerOrigin,
  x: number,
  y: number,
  thresholdPx: number,
): boolean;

/**
 * Whether this pointer should drag from the WHOLE ROW or only from the handle.
 *
 * D95a: `.dragHandle` carries `touch-action: none` so a touch drag moves the
 * node instead of scrolling the page. Putting that on the whole row leaves
 * NOWHERE on the tree a finger can scroll from — checked: the only
 * `overflow-y: auto` in the component is the "Move to…" popover, so the
 * scroller is the PAGE. Hence: mouse and pen drag from anywhere on the row;
 * touch keeps the handle.
 */
export function rowIsDragSource(pointerType: string): boolean;

/** Offset of `clientY` within a row, given the row's top edge. */
export function offsetInRow(clientY: number, rowTop: number): number;
```

**Required behaviour, and each line is a case in §7:**

- `passedThreshold` uses **Euclidean distance**, not per-axis. A diagonal drag of
  3px in x and 3px in y is 4.24px and must pass a 4px threshold; two per-axis
  comparisons would refuse it.
- A **non-finite** coordinate returns `false` — a drag that cannot be measured
  has not started.
- **Do NOT add a `thresholdPx <= 0` short-circuit.** `Math.hypot(...)` is never
  negative, so `hypot >= t` is already true for every `t <= 0`. One was written
  into the reference implementation, came back `NOT CAUGHT` by all 19 cases, and
  was deleted (gotcha 17). T12/T13 still assert the behaviour — they just assert
  it against the general expression.
- `rowIsDragSource` returns `true` for `"mouse"` and `"pen"`, `false` for
  `"touch"`, and **`false` for anything it does not recognise** — an unknown
  pointer type is not assumed to be safe to scroll over. Same fail-closed shape
  as `adminAccess`.

⚠️ **`e.pointerType` is `""` in some synthetic-event paths.** Treat `""` as
unrecognised, which the rule above already does. Do not special-case it.

---

## §5. The React wiring

### §5.1 What replaces what in `NodeTreeEditor.tsx`

Today (line ~100) `handleDragPointerDown` is on the `⠿` button and sets `drag`
immediately. That becomes:

- **`onPointerDown` moves to the row element**, and records only an *origin* —
  `{draggedId, pointerId, origin:{x,y}, source:"row"|"handle"}` — **without**
  starting a drag.
- **`onPointerMove` starts the drag** the first time `passedThreshold` is true,
  and only then computes `eligibleTargetIds`.
- The handle keeps its own `onPointerDown` for touch.

**⭐ THIS IS THE COST D95a NAMES, AND IT IS DELIBERATE.** P1-5g could say *"a
pointerdown on the handle is unambiguously a drag start and no threshold logic
exists to get wrong."* That sentence stops being true here: a whole-row source
means every click is a zero-length drag unless the threshold gates it. The
threshold is the price of the affordance, not an optimisation.

**Guard the controls.** `onPointerDown` on the row must ignore the event when
`(e.target as Element).closest("button")` is non-null — the disclosure triangle,
the `⋮` menu and the handle all live inside the row and must keep working as
buttons.

### §5.2 Hit-testing, and the one thing that is easy to get wrong

Keep `document.elementFromPoint(...)?.closest("[data-node-id]")`. **`e.target`
does not work** — `setPointerCapture` routes every subsequent event to the
capturing element, so `e.target` is always that element and a naive version
reports one unchanging hover row. That comment is already in the file; keep it.

You now also need the row's **top edge**:

```ts
const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]");
const rect = rowEl?.getBoundingClientRect();
const zone = rect
  ? resolveDropZone(
      rowDropZones(draggedId, rowEl!.getAttribute("data-node-id")!, rows, nodes, levels, templates),
      offsetInRow(e.clientY, rect.top),
      rect.height,
    )
  : null;
```

`rect.height`, **not a hard-coded row height** — the row scales with
`--chrome-scale` (D84) and a literal would silently stop matching at 4K.

### §5.3 `releasePointerCapture`, which P1-5g never called

The independent review of P1-5g found `DragState.pointerId` was written and never
read — **dead state is the fingerprint of a dropped requirement**. Release the
capture in `onPointerUp` **and** `onPointerCancel`:

```ts
if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
```

Same review found the Escape listener keyed on `[drag]`, which is a new object
every `pointermove` — so the listener was torn down and re-added on every frame.
Key it on `drag !== null`, or on `drag?.draggedId`.

### §5.4 `LevelEditor.tsx`

The same block, over a flat list. **No `canDropOn`, no zones, no refusals** — a
level list has no illegal target. A drop dispatches
`applyLevelAction(draft, { kind: "moveTo", from, to })`.

`to` is **the index the row ends up at**, read against the list with the dragged
row removed. The caret between rows *i* and *i+1* means `to = i` when dragging
downward from above, `to = i + 1` when dragging upward from below. Get this from
the same `resolveDropZone` half-split: top half of row *i* → land at *i*, bottom
half → land at *i+1*, then subtract one if `from < to`.

**The arrows stay.** They are the keyboard path (§2.1) and P1-5j's Save gate
still governs both.

---

## §6. The CSS, verbatim

**Rendered and iterated before this brief was written**
(`docs/mockups/p1-5l-drop-zones.png`). Paste it; do not re-derive it. The first
version was wrong twice — the caret sat *inside* the row above, and the demo
state showed a caret directly above the dragged row, which is a no-op.

### §6.1 `NodeTreeEditor.module.css` — append

```css
/* P1-5l — THE INSERTION CARET.

   Sits EXACTLY on the boundary between two rows: `-var(--row-pad-y)` is the
   row's own padding edge, which IS the seam. The first version used
   `- 1px` beyond that and the line landed INSIDE the row above, reading as
   that row's underline rather than as a gap between two rows.

   It starts at the indent the dragged node will occupy and carries a knob
   there, so a caret at depth 3 cannot be read as one at depth 2. */
.caretBefore,
.caretAfter {
  position: relative;
}

.caretBefore::before,
.caretAfter::before {
  content: "";
  position: absolute;
  left: calc(0.25rem + var(--caret-rails) * 1.125rem + 0.5rem);
  right: 0.25rem;
  height: 0;
  border-top: 2px solid var(--signal-ok);
  z-index: 1;
}

.caretBefore::before {
  top: calc(-1 * var(--row-pad-y) - 1px);
}

.caretAfter::before {
  bottom: calc(-1 * var(--row-pad-y) - 1px);
}

.caretBefore::after,
.caretAfter::after {
  content: "";
  position: absolute;
  left: calc(0.25rem + var(--caret-rails) * 1.125rem + 0.5rem - 3px);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--signal-ok);
  z-index: 2;
}

.caretBefore::after {
  top: calc(-1 * var(--row-pad-y) - 4px);
}

.caretAfter::after {
  bottom: calc(-1 * var(--row-pad-y) - 4px);
}
```

`--caret-rails` is set inline per row, exactly as `--drop-rails` already is for
the adopt tick, and comes from `dropRailIndex`'s sibling: the caret sits at the
**dragged node's** depth, which for a sibling placement is the **reference
row's** depth. Pass `row.depth`, not `row.depth + 1`.

### §6.2 An expired comment you must rewrite

`.dropTick`'s block currently says the affordance is *"deliberately NOT a
horizontal line BETWEEN two rows… P1-5g does not ship reordering, so a caret
would promise an outcome the drop does not deliver."*

**That reasoning was correct and is now spent.** Rewrite it in the same change to
say the tick marks adoption and the caret marks placement, and that they are
mutually exclusive because a row never offers both. Leaving it is the third
instance of decision-record drift in this project.

### §6.3 `LevelEditor.module.css`

The same two rules, without `--caret-rails` (a flat list has no indent): the
caret spans the row's full width.

---

## §7. `src/test/dragPointer.test.ts` — a VITEST suite

**A vitest suite** — `describe` / `it` / `expect` from `"vitest"` — because
`npm run test` is what guards this permanently. A standalone
`--experimental-strip-types` script with its own runner **passes when you run it
and fails collection under vitest**; that has happened here before, and the tell
nobody read was a test count that did not move.

**One plain `it()` per case. No `it.each`, no dynamic registration**, so the
number vitest reports is literally the count of `it(` lines.

**Write exactly these 19 cases:**

| # | case |
|---|---|
| T1 | no movement does not pass a 4px threshold |
| T2 | 3px in x alone does not pass |
| T3 | 4px in x alone passes |
| T4 | 5px in x alone passes |
| T5 | 3px in x AND 3px in y passes — 4.24px, the case per-axis comparisons get wrong |
| T6 | 2px in x and 2px in y does not pass — 2.83px |
| T7 | negative movement passes on magnitude, not sign |
| T8 | a NaN x returns false |
| T9 | a NaN y returns false |
| T10 | an Infinite coordinate returns false |
| T11 | an **INFINITE** origin returns false |
| T11b | a NaN origin returns false |
| T12 | a zero threshold passes for any finite movement |
| T13 | a negative threshold passes for any finite movement |
| T14 | `"mouse"` drags from the row |
| T15 | `"pen"` drags from the row |
| T16 | `"touch"` does not |
| T17 | an unrecognised pointer type does not — including `""` |
| T18 | `offsetInRow` subtracts the row top, and is negative above it |

⭐ **T11 must use an INFINITE origin, and T11b a NaN one, and the split is the
point.** A NaN origin propagates through `hypot` and the comparison is false
anyway, so a NaN-only fixture cannot tell whether the origin guard exists —
mutation U8 came back `NOT CAUGHT` against exactly that fixture. An infinite
origin gives `hypot === Infinity`, which passes any threshold. This is rule 3b
landing on the design session's own case list, before the brief shipped.

**Predicted count after this build: 579 tests in 17 files** — 560 today plus
these 19. **If your number differs, do not adjust the brief: report it.**

---

## §8. Mutations — run them, record what each one breaks

Apply each to your own `dragPointer.ts`, one at a time, and name the case that
fails. **A `NOT CAUGHT` verdict means either a missing case or an inert
mutation, and which one it is must be written down.**

| # | mutation |
|---|---|
| U1 | Euclidean distance becomes `Math.abs(dx) >= t \|\| Math.abs(dy) >= t` |
| U2 | `>=` becomes `>` |
| U3 | the finite check on the coordinates is removed |
| U4 | the **origin** finite check is removed |
| U5 | `rowIsDragSource` returns true for anything that is not `"touch"` |
| U6 | `rowIsDragSource` returns true unconditionally |
| U7 | `offsetInRow` adds the row top instead of subtracting it |

**Executed and found inert, so deliberately NOT in the table:** removing a
`thresholdPx <= 0` short-circuit. It is caught by nothing because `hypot` is
never negative. Do not add the branch back in order to have something for it to
break.

**Measured against the reference implementation: all seven caught** — U1 by T5,
U2 by T3 and T12, U3 by T10, U4 by T11, U5 by T17, U6 by T16/T17, U7 by T18.

Collateral is **measured against your own cases**; report differences, do not
chase mine.

---

## §9. Delivery — by operation, not by file

- **New file** → `device_bash` heredoc.
- **Edit** → targeted in-place `python3` read-modify-write: read, assert the old
  text appears **exactly once**, replace, write. Never a whole-file rewrite of a
  file you did not create.
- **Never** a tarball, `SendUserFile`, or base64.
- ⚠️ **A large heredoc in one `device_bash` call FAILS OUTRIGHT** — the tool
  returns a plain failure and nothing is written. Append in chunks of a few
  hundred lines and `wc -l` after each.
- **Deliver before you report.** Every brief here puts delivery first, because a
  run that dies mid-report still leaves the code on disk.

## §10. Before you report

1. `node node_modules/typescript/lib/tsc.js -b --force` → exit 0. Run it **alone
   in its own `device_bash` call**; it lands near the 45s limit.
2. `node node_modules/eslint/bin/eslint.js .` → exit 0.
3. **You cannot run `vitest`** — the installed rollup binary is win32-arm64 and
   npm has no network on that VM. The count is Pratik's to run. Say so.
4. Report: what you changed, **which mutation broke which case**, every
   assumption you made, and **every place the brief was wrong**. Expect to find
   some; a flagged deviation is a lead, and briefs here have been wrong before.
