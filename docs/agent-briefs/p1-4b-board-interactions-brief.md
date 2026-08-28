# Agent Brief P1-4b — Board Interactions I: Create, Move, Resize

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, sixth build task.
**Depends on:** P1-1/P1-2/P1-3a/P1-3b (all built and proven) and **P1-4a, which is built, verified and accepted** — the board renders live data, virtualized, with a hierarchy rail, shift layer and operator panel.
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

**One-line scope:** make the board editable for the gestures a supervisor uses all day — **drag on empty track to create**, **drag a block to move it in time**, **drag its edges to resize** — for both run bands and assignments, **within a single cell**.

Cross-cell run moves, the split-coverage flow, eligibility overrides and drag-from-the-operator-panel are **P1-4c**. They are the concurrency-heavy half and get their own brief.

---

## 0. Read this first — the npm block, and the hole in it

**You cannot run npm.** This container's egress blocks the registry (**403 by policy** — also pip and apt). No `npm install`, no `npm test`, no dev server. Do not hunt for mirrors.

**But Node 22 here runs TypeScript directly** via `node --experimental-strip-types`, which erases type annotations. P1-4a proved this works end to end, and this brief uses the same split:

| Part | What | You validate it? |
| --- | --- | --- |
| **A** | `src/features/board/lib/interaction.ts` — all drag arithmetic, snapping, hit-testing, clamping. Pure, no React, no DOM. | **YES. §11 and §12 are mandatory and you must report real output.** |
| **B** | Pointer handlers, the create popover, toasts, wiring | No. Author only. Report §14 items as **NOT RUN — no npm in container**. |

Reporting §11 or §12 as NOT RUN makes the delivery incomplete. Part A exists precisely so that the maths — which is where drags go wrong — is provably correct before it reaches a browser.

---

## 1. Study first (in this order)

1. **`src/features/board/`** — everything P1-4a built. Read `lib/geometry.ts`, `lib/boardIndex.ts`, `lib/time.ts`, `components/BoardGrid.tsx`, `components/TrackRow.tsx`, `components/RunBand.tsx`, `components/AssignmentChip.tsx`, `components/DirectBlock.tsx`, `store/boardView.ts`. **You are extending this code, not replacing it.**
2. **`docs/mockups/model-hybrid.html`** — the gesture reference. Read `startCreateGeneric`, `startBandDrag`, `startStaffDrag`, `startDirectDrag`, `doSnap`, `openCreatePop`, `openRunPop`, `openChipPop`, `openDirectPop`, and the `#pop` / `.ghost` / `.seg` CSS. **Everything this brief does not explicitly change, port faithfully.**
3. **`docs/api-client.md`** — the mutation hooks you must use and their two deliberate behaviours (no auto-retry on `CapacityExceeded`; `useMoveRun` retries `RaceLost` exactly once).
4. **`docs/api.md` §1, §3, §4** — the error-code table, and which edits are RPCs vs plain PostgREST writes.
5. **`src/features/board/hooks/useRunMutations.ts` and `useAssignmentMutations.ts`** — already written in P1-3b with optimistic update and rollback. **Do not rewrite them.** If one is missing something you need, say so in your report rather than working around it.
6. **`docs/design-plan.md` §14.1** (hybrid rules), **§15.1** (capacity), **§17.4** (why transitions matter), **§18–§18.4** (the board's decisions and what P1-4a acceptance corrected).
7. **`docs/conventions.md`**.

Files are on the device at `<repo root>`. Stage with `device_stage_files` to read them here.

---

## 2. Scope fence — what belongs to P1-4c

Do not build, and leave no stubs for:

- **moving a run or an assignment to a different cell** — a drag that leaves its own track is clamped to that track (§4, `moveWithinTrack`), not re-parented
- the **split-coverage popover** — a `CapacityExceeded` rejection surfaces as a typed message and a revert (§7)
- **eligibility overrides** — a `NotEligible` block surfaces as a message; you never send `p_override`
- **dragging from the operator panel** onto the board
- **re-parenting an assignment between runs** (`startStaffDrag`'s `targetBand` logic in the mockup)
- realtime subscriptions

In scope and required: create-by-drag, move-in-time, resize, the create popover, the edit popovers for an existing block, delete, and the plain field edits (`notes`, `plannedHeadcount`, `efficiencyPercent`, `targetQty`, `targetUnit`).

---

## 3. Decisions already made — implement, do not revisit

**D29 — one drag controller, three gestures.** Create, move and resize are the same state machine over pointer events, differing only in how a pointer delta becomes a candidate range. Put that state machine in one hook (`useDragGesture`) and the arithmetic in Part A. Three separate copies of pointer handling is how the mockup's four `start*Drag` functions ended up subtly different from each other.

**D30 — snapping is ported from the mockup's `doSnap`, generalized.** At Compact zoom a drag snaps to the resolved shift boundaries of the row being dragged in; at Standard/Fine it snaps to the zoom's `snapMinutes` (30/15). **Holding Alt disables snapping entirely** and gives whole minutes. `ZOOMS[].snapMinutes` and `shiftSnapPoints()` already exist in `geometry.ts` from P1-4a — use them, do not redefine them.

**D31 — a block never becomes shorter than 15 minutes.** `MIN_DURATION_MINUTES = 15`, one constant, applied to create and to both resize edges. Not the snap step: at Compact the snap step is a whole shift, and clamping to that would make a resize jump absurdly.

**D32 — 4px drag threshold.** A pointer that moves less than 4px between down and up is a **click**, not a drag, and opens that block's edit popover. Without this every click becomes a zero-length drag. The mockup uses 3px; 4 is a touch more forgiving and the exact number is not load-bearing.

**D33 — `setPointerCapture` on pointerdown, released on pointerup.** The drag must survive the pointer leaving the element and the window. **Escape cancels an in-flight drag and reverts** with no mutation sent.

**D34 — during a drag, the dragged block renders from local drag state, not from the index.** This is the load-bearing decision of the whole brief; §6 (T10) explains why.

**D35 — the create popover's mode is pre-selected from `profile.defaultCreateMode`** (design plan §14.1), and the user can flip it. `useSession()` already exposes `profile`.

**D36 — every mutation goes through the existing P1-3b hooks**, which already do optimistic update and rollback. This brief adds no new `supabase.rpc` call and no new file under `src/lib/api/`.

**D37 — a rejected edit reverts and says why, in one place.** One `useSchedulerToast` hook; every failure path calls it with the typed `SchedulerError`. `describeSchedulerError` supplies the sentence. For `CapacityExceeded` specifically, resolve `operatorId` to a display name from the loaded board (the error layer cannot — `docs/api-client.md` says so) and append the peak, e.g. *"Maria would reach 150% (cap 100%) — reverted."* Do not write a generic "something went wrong" anywhere.

**D38 — the edge grip narrows on short blocks.** `grip = Math.min(handlePx, Math.floor(blockWidthPx / 3))`. Without this, a block narrower than twice the handle has overlapping start/end zones and no body at all — so a 40-minute chip at Compact zoom could not be moved, only resized. A third each way is the rule; verified to leave a body zone at 12px against an 8px handle.

---

## 4. Part A — `src/features/board/lib/interaction.ts`

Same constraints as P1-4a's `lib/`: **no React, no DOM, every import `import type`**, no enums/namespaces/parameter-properties, every function pure. It may `import type` from `@/lib/api` and may import **values** from `./geometry` (as `boardIndex.ts` already does — the harness rewrites that one specifier, see §11).

```ts
export const MIN_DURATION_MINUTES = 15;   // D31
export const DRAG_THRESHOLD_PX = 4;       // D32

export type DragMode = "create" | "move" | "resize-start" | "resize-end";
export type EdgeHit = "start" | "end" | "body";

/** Which part of a block the pointer landed on. `handlePx` is the hit width
 *  of each edge grip (the mockup's `.h` spans: 8px on a band, 7px on a chip). */
export function hitTestBlock(offsetXPx: number, blockWidthPx: number, handlePx: number): EdgeHit;
// D38: grip = min(handlePx, floor(blockWidthPx / 3)) — see §3.

/** D30. `shiftPoints` is `shiftSnapPoints(template, dayCount)` for the row, or
 *  `[]` when the row resolves no template. `snapMinutes` is the zoom's step.
 *  `useShiftSnap` is true only at Compact. `altKey` disables snapping. */
export function snapMinute(
  rawMin: number, opts: {
    altKey: boolean; useShiftSnap: boolean; snapMinutes: number; shiftPoints: number[];
  },
): number;

/** Create: two snapped instants in either drag direction -> a normalized
 *  range, or `null` if it is shorter than MIN_DURATION_MINUTES. */
export function createRange(
  anchorMin: number, currentMin: number, windowMinutes: number,
): { startMin: number; endMin: number } | null;

/** Move: preserves duration, clamps to [0, windowMinutes] WITHOUT squashing —
 *  a block pushed past an edge stops there at full length. */
export function moveWithinTrack(
  original: { startMin: number; endMin: number },
  deltaMin: number, windowMinutes: number,
): { startMin: number; endMin: number };

/** Resize: moves one edge only; the other is fixed. Enforces D31 against the
 *  fixed edge and clamps to the window. */
export function resizeRange(
  original: { startMin: number; endMin: number },
  edge: "start" | "end", deltaMin: number, windowMinutes: number,
): { startMin: number; endMin: number };

/** Does this candidate range overlap another run on the same node? The
 *  database enforces this (D4's exclusion constraint) but the UI must refuse
 *  the drop before sending it, so the user gets an instant answer. */
export function findRunOverlap<T extends { id: string; startMin: number; endMin: number }>(
  candidate: { startMin: number; endMin: number }, runsOnNode: T[], excludeRunId: string | null,
): T | null;

/** Resizing a run inward strands crew outside it. Returns which assignments
 *  get clipped and which fall out entirely (mockup: `startBandDrag`'s resize
 *  branch). P1-4b only WARNS with this — see §5. */
export function classifyCrewAgainstRun<T extends { id: string; startMin: number; endMin: number }>(
  run: { startMin: number; endMin: number }, crew: T[],
): { clipped: T[]; stranded: T[] };

/** Minutes -> the instant, for popover labels. Pure; takes windowStart. */
export function minuteToDate(windowStart: Date, minute: number): Date;
```

Two rules that are easy to get wrong and are tested in §11:

- **`moveWithinTrack` clamps, it does not squash.** Dragging a 6-hour block toward minute 0 stops it at `[0, 360)`. It must never return `[0, 300)`.
- **`resizeRange` enforces the minimum against the *fixed* edge.** Dragging the start edge rightwards past `endMin - 15` pins it at exactly `endMin - 15`; it must never produce an inverted or sub-15-minute range.

---

## 5. Part B — the gestures

### 5.1 `useDragGesture` (`src/features/board/hooks/useDragGesture.ts`)

One hook owning the state machine. It exposes the current drag (`null` when idle) and the `onPointerDown` handler that tracks bind to.

```ts
interface ActiveDrag {
  mode: DragMode;
  nodeId: string;
  subject: { kind: "run"; runId: string } | { kind: "assignment"; assignmentId: string } | { kind: "new" };
  original: { startMin: number; endMin: number } | null;   // null for "create"
  candidate: { startMin: number; endMin: number } | null;
  moved: boolean;          // D32 threshold crossed
  pointerId: number;
}
```

Pointer flow: `pointerdown` → capture, record origin, `hitTestBlock` picks the mode → `pointermove` → convert `clientX` delta to minutes with `pxToMinutes`, snap with `snapMinute`, compute the candidate with the §4 function for the mode → `pointerup` → release, and if `moved` is false open the edit popover, otherwise commit. `keydown` Escape → cancel, revert, send nothing.

**Do not read layout in `pointermove`.** Capture the track's bounding rect once on `pointerdown` and reuse it — `getBoundingClientRect()` per move event forces a synchronous layout on every frame of every drag, on a grid with hundreds of absolutely-positioned children.

### 5.2 Rendering the drag

While a drag is active, `TrackRow` renders the dragged block at `candidate`, and its time label updates live (the mockup rewrites `.tm`). Give it the mockup's `.dragging` styling. A create drag renders the mockup's `.ghost` with the range as its text.

### 5.3 Commit

| Gesture | Call |
| --- | --- |
| create → run | `useCreateRun` |
| create → direct assignment | `useCreateAssignment` with `target: { kind: "direct", productId }` |
| move/resize a **run** (same node) | `useUpdateRunFields` with the new `timerange` — **not** `useMoveRun`; §4 of `docs/api.md` documents a same-node time change as a plain field edit, and `move_run` is for the cross-cell case that is P1-4c |
| move/resize an **assignment** | `useUpdateAssignmentFields` with the new `timerange` |
| field edits from a popover | the same two `useUpdate*Fields` hooks |
| delete a run | `useDeleteRun` — the popover must make the user choose `cascade` or `detach`, in those words, because the two do very different things to the crew |

**Moving a run does not move its crew in P1-4b.** The mockup shifts every crew assignment by the same delta; doing that here means N separate writes with no transaction around them, and a partial failure leaves the board wrong. Instead: **refuse the drag** if the run has crew, with the message *"Moving a staffed run is coming in the next build — detach or move the crew first."* Say so plainly in the popover too. This is a deliberate P1-4b limitation, not an oversight; P1-4c does it properly as one RPC.

Resizing a run **is** allowed with crew, and uses `classifyCrewAgainstRun` to warn before committing: *"2 crew assignments fall outside the new run window."* It does not modify them. The confirm proceeds; cancel reverts.

### 5.4 Popovers

Port the mockup's `#pop` as a single `BoardPopover` component (positioned, dismissed on outside-click and Escape, focus-trapped, `role="dialog"`, first field autofocused).

- **Create** — port `openCreatePop`: the run/direct segmented toggle (D35 for the initial mode), full-shift quick-action chips from the row's resolved template, product select, planned headcount (run) or operator/product/efficiency/target (direct), the range as a label, Cancel/Create. The mockup's per-operator hints (*"— at 100% (will ask to split)"*, *"— not certified (override)"*) are **P1-4c**; omit them and do not fake them.
- **Run** — port `openRunPop`: product, planned headcount, notes, delete with the cascade/detach choice.
- **Assignment** (both run-attached and direct) — port `openChipPop`/`openDirectPop`: efficiency percent, target qty + unit, status, delete.

**Efficiency is always a percent at the boundary** (`efficiencyPercent`) and converts only inside `src/lib/api/serde.ts`. Never multiply or divide by 100 in this feature.

---

## 6. Transitions — the part that will actually break

P1-4a's §10 list still applies unchanged. These are the new ones a drag creates. **Each is a required behaviour.**

**T10 — a refetch lands mid-drag.** `useBoardWindow` has a 30s `staleTime`; a background refetch *will* land while someone is dragging. The dragged block must not jump to server state under the pointer. D34: while `activeDrag` is non-null the dragged block renders from `candidate`, and the incoming index is used for everything else on the board. On pointerup the mutation goes out against the **current** server state, not the state at pointerdown.

**T11 — the drag's own optimistic update must not be re-read as a new drag origin.** The mutation hooks patch the cache immediately. If the drag state is still alive when that patch lands, the block would move twice. Clear `activeDrag` **before** calling `.mutate()`, not in the mutation's callback.

**T12 — a rollback while the popover is open.** A mutation fired from a popover can fail after the popover has closed and the user has moved on. The toast must still name the block (*"Widget X 06:00–14:00 — reverted"*), never a bare error.

**T13 — the identity changes mid-drag.** `DevProfileSwitcher` resets the query cache (§17.4). Any in-flight drag must be cancelled with no mutation sent, because the node may not even be visible to the new identity.

**T14 — the window scrolls or zooms mid-drag.** Zoom is only reachable by clicking the toolbar, which ends the drag — but a trackpad can scroll horizontally during one. The candidate is stored **in minutes**, never in pixels, so a scroll changes only where it is drawn. Verify that is true of your implementation; if you cached a pixel origin, this is where it breaks.

**T15 — the collapse toggle removes the dragged row.** Cancel the drag.

**T16 — pointercancel.** The browser fires `pointercancel` instead of `pointerup` (touch gesture, context menu, tab switch). Treat it exactly as Escape: revert, send nothing. A missing `pointercancel` handler leaves a permanently stuck drag.

---

## 7. Errors

Every rejection reverts the optimistic change (the hooks already do this) and calls `useSchedulerToast`. Map by kind:

| Kind | Message shape |
| --- | --- |
| `CapacityExceeded` | *"{Operator} would reach {peak}% (cap {cap}%) — reverted."* Resolve the name from the board's operator list (D37). Add: *"Split coverage is coming in the next build."* |
| `NotEligible` | *"{Operator} is not certified for {Cell}: missing {skills} — reverted."* No override in P1-4b. |
| `RunOverlap` | *"{Cell} already runs {product} {from}–{to} — reverted."* Prefer catching this **before** sending, with `findRunOverlap`. |
| `RaceLost` | *"Someone else changed this — refreshed, try again."* Refetch. |
| `NotPermitted` | *"You don't have permission to edit {Cell}."* |
| `InvalidArgument` / `Unknown` | `describeSchedulerError(err)` verbatim. |

**`PTxxx` → HTTP status is still unverified** (design plan §17.2, open since P1-3a). A capacity rejection is now reachable for real. **Force one** (drag a second assignment onto an operator already at 100%), record in your report exactly what the client receives — HTTP status, `error` field, whether `toSchedulerError` produced `CapacityExceeded` or fell through to `Unknown` — and say plainly whether the mapping holds. If it does not, **do not change the client to match**; report it. The contract deliberately switches on the `error` field precisely so it survives either answer.

---

## 8. Accessibility

Every gesture needs a keyboard path, because a drag-only board is unusable for some supervisors and untestable by Playwright.

- Blocks are focusable (`tabIndex={0}`), Enter/Space opens the edit popover.
- With a block focused: **arrow left/right moves it by one snap step**, **shift+arrow resizes the end edge**, both committing on keyup. Same Part A functions, same clamps.
- The create popover is reachable from a focused empty track with Enter, defaulting to the current shift.
- Every icon-only control has an `aria-label`; the popover is `role="dialog"` with `aria-modal`.

---

## 9. Files

```
src/features/board/
  lib/interaction.ts                                   ← Part A
  hooks/useDragGesture.ts  hooks/useSchedulerToast.ts
  components/
    BoardPopover.tsx        + .module.css              generic popover shell
    CreatePopover.tsx       + .module.css
    RunPopover.tsx          + .module.css
    AssignmentPopover.tsx   + .module.css
    DragGhost.tsx           + .module.css
    Toasts.tsx              + .module.css
  (edited) components/TrackRow.tsx, RunBand.tsx, AssignmentChip.tsx,
           DirectBlock.tsx, BoardGrid.tsx, BoardPage.tsx
src/test/
  interaction.test.ts   dragGesture.test.ts
```

---

## 10. Two traps P1-4a fell into — do not repeat them

1. **Flattening a descendant selector into a CSS-Module class silently loses specificity.** The mockup's `.zoom button.on` (0,2,1) beats `.zoom button` (0,1,1); the flattened `.zoomOn` is (0,1,0) and *loses*, so the style appeared to do nothing. When you port `.pop .seg button.on`, `.ghost`, `.toast.crit` and friends, **keep the element+class shape**: `.seg button.segOn`, not `.segOn`.
2. **When this brief enumerates what a ported component contains, that list is not exhaustive.** P1-4a's brief listed the toolbar's contents and the agent correctly built exactly that list — silently dropping the mockup's day-navigation buttons, which the list happened not to mention. **Port everything the mockup's popovers have**, and if you find something in the mockup that this brief never mentions, build it and flag it in your report rather than assuming it was cut.

---

## 11. Part A validation — MANDATORY

Build a harness in `/tmp/harness/` (never in the repo, never in the tarball). Copy `interaction.ts` and `geometry.ts` there, rewrite the `./geometry` specifier to `./geometry.ts`, and run:

```bash
node --experimental-strip-types /tmp/harness/run.ts
```

Print `PASS`/`FAIL` lines; exit non-zero on any failure. Minimum cases:

**Snapping**
1. `snapMinute(370, {altKey:false, useShiftSnap:false, snapMinutes:30, shiftPoints:[]})` ⇒ `360`; the same input at `snapMinutes:15` ⇒ `375`. (Pick the input deliberately: 367 does **not** work, because it rounds to 360 at *both* steps and so cannot tell them apart. Verified by execution before this brief shipped.)
2. `altKey: true` ⇒ `370` exactly, at every zoom, ignoring `shiftPoints`.
3. With `useShiftSnap:true` and `shiftPoints:[360,840,1320]`, an input of `500` ⇒ `360` (nearest), `700` ⇒ `840`.
4. `useShiftSnap:true` with an **empty** `shiftPoints` falls back to `snapMinutes` — a row with no resolved template must not stop snapping.

**Create**
5. A backwards drag (anchor 600, current 360) ⇒ `{360, 600}` — normalized, not negative.
6. A 10-minute drag ⇒ `null` (D31).
7. A drag beyond `windowMinutes` clamps to it.

**Move — the clamp-vs-squash rule**
8. A 360-minute block at `{600,960}` moved by `-900` ⇒ `{0,360}`. **Assert the duration is still 360.**
9. The same block moved past the right edge of a 4320-minute window ⇒ `{3960,4320}`, duration 360.
10. A move of `0` returns an equal range.

**Resize**
11. Start edge dragged right past the minimum ⇒ `startMin === endMin - 15` exactly, never inverted.
12. End edge dragged left past the minimum ⇒ `endMin === startMin + 15`.
13. End edge dragged past `windowMinutes` clamps there.
14. Resizing the start edge never moves `endMin`, and vice versa.

**Hit testing**
15. `hitTestBlock(2, 200, 8)` ⇒ `"start"`; `(198, 200, 8)` ⇒ `"end"`; `(100, 200, 8)` ⇒ `"body"`.
16. On a block narrower than twice the handle (`blockWidthPx: 12, handlePx: 8`) there is still a `"body"` zone — assert that D38's rule leaves one.

**Overlap and crew**
17. `findRunOverlap` ignores the run being dragged (`excludeRunId`) and finds a genuine clash.
18. Two runs that merely touch (`[0,60)` and `[60,120)`) do **not** overlap — half-open ranges.
19. `classifyCrewAgainstRun` puts a partially-overlapping assignment in `clipped` and a fully-outside one in `stranded`.

---

## 12. Mutation testing — MANDATORY, report the exact failure text

Break each in your `/tmp` copy only, re-run, record the failing line, restore. **Never mutate the delivered files.**

| # | Break | Must fail |
| --- | --- | --- |
| M1 | `moveWithinTrack` — clamp `startMin` and `endMin` independently (the squash bug) | case 8's duration assertion |
| M2 | `resizeRange` — enforce the minimum against the moving edge instead of the fixed one | case 11 |
| M3 | `createRange` — drop the `Math.min`/`Math.max` normalization | case 5 |
| M4 | `snapMinute` — ignore `altKey` | case 2 |
| M5 | `snapMinute` — use shift points whenever they are non-empty, not only when `useShiftSnap` | case 1 (with shift points supplied at Standard zoom — add that case if yours does not already cover it) |
| M6 | `findRunOverlap` — change the overlap test to `<=` | case 18 |
| M7 | `hitTestBlock` — widen the edge zones to half the block | case 15's `"body"` |

If a mutation does **not** fail, the test is the bug. Fix the test, say so, re-run. **This happened twice in P1-4a** — two of its prescribed mutations named a case that could not distinguish mutated from correct code, and the agent caught it. Expect the same here.

---

## 13. Self-review (all doable by reading)

1. `lib/interaction.ts` imports only types plus `./geometry` values. Show the import lines.
2. No `getBoundingClientRect` inside a `pointermove` path. Show a grep.
3. Every `setPointerCapture` has a matching release on **both** `pointerup` and `pointercancel`.
4. Every pointer/key listener added in an effect is removed in its cleanup.
5. No `supabase.rpc` / `supabase.from` outside `src/lib/api/`. Show a grep.
6. No `* 100` or `/ 100` on an efficiency anywhere in the feature. Show a grep.
7. No cross-cell logic: no code path sets a `nodeId` different from the block's own. Show a grep.
8. `activeDrag` is cleared before `.mutate()` (T11). Name the lines.
9. Each of T10–T16: name the file and lines, or state plainly it is unimplemented.
10. Every ported CSS rule that was `.parent child.state` in the mockup is still element+class in the module (§10.1).
11. Every popover control has a label or `aria-label`; every gesture has the §8 keyboard path.

---

## 14. Acceptance — the user runs this

```powershell
npm run format
npm run lint; npm run typecheck; npm run test; npm run build
```

Then `npm run dev`, signed in as Admin:

1. Drag on empty track in Cell 1 → ghost follows with a live time label → popover opens → create a run → it appears and survives a refresh.
2. Same, switched to Direct assignment → creates with an operator and efficiency.
3. Drag an unstaffed run band sideways → it moves, snapping to 30 min at Standard.
4. Alt-drag → snapping off, minute precision.
5. Compact zoom → drag snaps to shift boundaries.
6. Drag a run band's left edge → resizes; it will not go under 15 minutes.
7. Drag a **staffed** run → refused with the "coming in the next build" message, block reverts.
8. Resize a staffed run inward → warns how many crew fall outside, then commits.
9. Drag an assignment chip → moves; drag it hard left → stops at the window edge **at full length**.
10. Create a second assignment for an operator already at 100% in that window → **capacity rejection**: block reverts and the toast names the operator and the peak.
11. Click a block without moving → edit popover, not a zero-length drag.
12. Start a drag, press Escape → reverts, nothing sent.
13. Keyboard: Tab to a block, arrow keys move it, shift+arrow resizes.
14. Delete a run → cascade/detach choice, both behave as named.
15. Leave the board idle 40s mid-drag (hold the pointer down) → the refetch does not move the block under the pointer.
16. No console errors.

Mark every item **NOT RUN — no npm in container**. Do not estimate.

---

## 15. Delivery

Tar `src/` **only** — never `docs/`, never `node_modules/`, never `/tmp/harness/`. `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\board-interactions.tar.gz` → `device_bash` to extract → `git status --short`.

Device gotchas, all previously hit:

- Extracted files land **read-only** — `chmod u+w` before patching in place.
- **On this OneDrive-backed mount, an in-place `tar` overwrite of an EXISTING file silently no-ops** — tar reports success, content stays old. **Verify every overwritten file with `md5sum` on both sides**, and write pre-existing files via a `device_bash` heredoc instead.
- `device_bash` **cannot delete files**. If you run `git`, warn in your report that a stray `.git/index.lock` may need `Remove-Item .git\index.lock` from PowerShell.
- `device_commit_files` can be refused by Windows Controlled Folder Access — do not retry the same path, use a heredoc and say so.

**Do not commit or push. Do not run any npm command.**

---

## 16. Required final step

Edit `docs/roadmap.md`: mark the "Board interactions" Phase 1 line with "P1-4b code delivered, acceptance pending user run", add a P1-4b row to the brief queue, refresh **Last updated**. Leave every other row alone.

---

## 17. Report format

1. Full file tree, one line each.
2. **§11 harness output — the real printed text.** Not optional.
3. **§12 mutation results — the exact failing line for each of M1–M7.** Not optional.
4. **§7's `PTxxx` → HTTP finding** — what the client actually received on a real capacity rejection, or explicitly "could not force one in-container" if you could not.
5. §13 self-review, item by item, with evidence.
6. §14 acceptance block, every item NOT RUN.
7. **Every assumption where this brief was silent, and anything in the mockup this brief failed to mention** (§10.2). On this project the agent's flagged deviations have repeatedly been real bugs in the brief — three in P1-2, two in P1-4a's own mutation table.
8. Anything left undone.
