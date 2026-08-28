# Agent Brief P1-4a — The Board, Read-Only: Grid, Rail, Shift Layer, Operator Panel

**Executor:** a fresh Sonnet agent (no prior context). **Phase:** 1, fifth build task.
**Depends on:** P1-1 (scaffold, building clean), P1-2 + P1-3a (schema + RPCs live in local Supabase), P1-3b (typed API client, dev sign-in, React Query hooks — all working end to end).
**Rules:** no design decisions of your own. Note assumptions; do not ask questions mid-run.

**One-line scope:** replace the temporary `BoardProof` panel with a real, virtualized, read-only board that renders live `board_window` data exactly the way `docs/mockups/model-hybrid.html` renders its fake data. **No drag, no click-to-create, no popovers, no mutations.** Those are brief P1-4b.

---

## 0. Read this first — two things about this container

**(a) You cannot run npm.** This container's egress blocks the npm registry (**403 by policy** — also pip and apt). You cannot `npm install`, `npm run typecheck`, `npm test`, `npm run build`, or start a dev server. Do not attempt it, do not hunt for mirrors, do not install anything. `node_modules/` is already installed on the user's device; read from it if you need to check an API.

**(b) But you CAN execute part of this deliverable, and you are required to.** Node 22 is present and supports `node --experimental-strip-types`, which runs a `.ts` file directly by erasing its type annotations. This brief is deliberately structured so that **the entire load-bearing math layer is pure, dependency-free TypeScript** that you can run, test, and mutation-test in this container without npm. See §4 and §12.

So the split is:

| Part | What | You can validate? |
| --- | --- | --- |
| **A** | `src/features/board/lib/*.ts` — time, geometry, board index. Pure functions, no React, no runtime imports. | **YES — run it. §12 and §13 are mandatory and you must report real results.** |
| **B** | React components, CSS Modules, virtualization wiring, `vite.config.ts`, Vitest spec files | No. Author only. Report every acceptance item in §15 as **NOT RUN — no npm in container**. |

A green checklist you did not execute is worse than no checklist. A previous brief on this project was reported honestly as blocked and that was the right call. But **Part A has no excuse** — if you report §12/§13 as NOT RUN, the delivery is incomplete.

---

## 1. Study first (in this order)

1. **`docs/mockups/model-hybrid.html`** — the whole point. Read the `<style>` block and the `/* ============ render ============ */` section closely. You are porting `ZOOMS`, `minToX`/`xToMin`, `shiftInstances`, `breakInstances`, `shiftBoundaries`, `offShiftGaps`, `cellRow`'s lane packing, `bandEl`, `chipEl`, `dblkEl`, `buildHeaderTrack`, `groupRow`, and `renderPanel`. This brief tells you exactly where each one changes; **everything it does not name changes, port verbatim.**
2. **`src/lib/api/shapes.ts`** — the exact `BoardWindow` interface you are rendering. Every field name, every nullability.
3. **`docs/api.md` §2 `board_window`** — what the payload contains and what is guaranteed (every array key always present and array-valued, `nodes` ordered by `path`, `node_shift_map` has one entry per returned node with `template_id` possibly null).
4. **`src/lib/api/serde.ts`** — `parseTstzRange`, `fromEfficiency`. You will use both. Note that `parseTstzRange` **throws**; §5 tells you where that is caught.
5. **`docs/api-client.md`** — the import rules. `@/lib/api` is the only path feature code imports from; hooks come from `@/features/board/hooks/`.
6. **`docs/conventions.md`** — folder rules, CSS Module rules, the `@/` alias, file naming.
7. **`src/features/board/BoardPage.tsx`** and **`BoardProof.tsx`** — what exists now and what you are replacing.
8. **`src/styles/tokens.css`** — the design tokens, already ported from the mockup in P1-1.
9. **`docs/design-plan.md` §15.3** (operator panel), **§16.2** (board rendering), **§17.4** (why transitions matter — read this one twice).

Files are on the device at `<repo root>` (`$HOME/mnt/production_scheduler` via `device_bash`). Stage with `device_stage_files` to read them in the container.

---

## 2. Scope fence — what you are NOT building

Do not build, and do not leave stubs, handlers, or dead code for:

- any `pointerdown` / drag / resize behaviour on bands, chips, blocks, tracks, or panel entries
- the create popover, run popover, chip popover, split-coverage popover, shift editor overlay
- any call to `useCreateRun` / `useCreateAssignment` / `useMoveRun` / `useApplySplitCoverage` / `useDeleteRun` / `useUpdateRunFields` / `useUpdateAssignmentFields` / `probeCapacity` / `checkEligibility`
- realtime subscriptions
- the eligibility-hint dimming that the mockup applies *during a drag* (`markEligibility`/`clearHints`) — there is no drag

The **only** data call in this brief is `useBoardWindow`. Everything else on screen is derived from its payload.

Two things that look like interactions but are in scope because they are pure view state, touch no API, and the board is unreadable without them:

- **collapse/expand a group row** (caret click)
- **zoom level buttons** and the **window date-range control**

`title` attributes (native tooltips), exactly as the mockup uses them, are also in scope. A styled tooltip component is not.

---

## 3. Decisions already made — implement these, do not revisit

These close the gaps between the mockup's fake fixed 3-day world and the real continuous window. They are recorded in `docs/design-plan.md` §18; you are implementing them, not choosing them.

**D13 — the board renders in UTC in v1.** `src/features/board/lib/time.ts` exports `export const BOARD_ZONE = "UTC";` and every single clock/day label in the board goes through `formatClock(date)` / `formatDayLabel(date)` in that file, implemented with `Intl.DateTimeFormat` and `timeZone: BOARD_ZONE`. No component may call `Date#getHours`, `toLocaleTimeString`, or any other local-time method. Rationale: D10 anchored the seed to UTC and per-site timezone is an open roadmap question; UTC is the honest placeholder and it is a one-constant seam when that question closes. Consequence you may rely on: **in v1 every day is exactly 1440 minutes — there is no DST discontinuity in board geometry.**

**D14 — the board window is always whole UTC days.** The date-range control picks *dates*; `useBoardWindow` is always called with `from` = 00:00:00.000Z of the start date and `to` = 00:00:00.000Z of the day *after* the end date. Therefore day boundaries sit at exact multiples of 1440 minutes from the window origin, and `buildHeaderTrack`'s day strip ports over unchanged.

**D15 — the x coordinate is minutes since `windowStart`.** The mockup's "minutes since Monday 00:00" generalizes to "minutes since the window's first instant". `DAY_MIN` (a hardcoded 4320) becomes `windowMinutes = (windowEnd - windowStart) / 60000`, and `dayCount = windowMinutes / 1440`. Every mockup loop written as `for (let day = -1; day <= 2; day++)` becomes `for (let day = -1; day <= dayCount; day++)` — the `-1` is load-bearing (it is what makes a previous day's overnight shift tail appear on the first rendered morning) and so is running one past the last day.

**D16 — zoom table ported verbatim**, including the `snap` column even though nothing in this brief uses it (P1-4b does, and it belongs with the table):

```ts
export const ZOOMS = [
  { name: "Compact",  pxPerHour: 64,  snapMinutes: 60 },
  { name: "Standard", pxPerHour: 104, snapMinutes: 30 },
  { name: "Fine",     pxPerHour: 168, snapMinutes: 15 },
] as const;
```

Default zoom index **1 (Standard)**, matching the mockup's `let zoom = 1`.

**D17 — default window = 3 days beginning the UTC Monday of the current week**, matching seed decision D10, so a freshly seeded database shows populated rows on first load. The date-range control may widen it; `board_window` raises `invalid_argument` past 92 days, so the control must not offer a range longer than 92 days (see §10, T6).

**D18 — a node is a track row iff its level is schedulable.** Join `nodes[].levelId` → `levels[].isSchedulable`. Schedulable ⇒ a track row with a time track. Not schedulable ⇒ a group row (collapsible, no blocks). Do not hardcode "department / line / cell" anywhere — the hierarchy is org-defined (design plan §2). The mockup's `.grp-cell.line` indent becomes an indent computed from the node's depth (`path.split(".").length` relative to the root's depth), 12px per level.

**D19 — no new npm dependency.** Virtualization is hand-rolled (§6). Rationale: row heights here are *computed*, not measured, so a measuring virtualizer buys nothing; and every line of the windowing math then lives in Part A where you can actually test it. This matches the existing precedent of hand-rolled runtime guards in `shapes.ts` instead of zod.

---

## 4. Part A — the pure layer (`src/features/board/lib/`)

This is the heart of the brief. Three files, **all of which must satisfy these constraints** so that §12 can run them:

- No React import. No CSS import. No DOM API.
- Every import is `import type { … } from "@/lib/api";` — **the `type` keyword is mandatory**, because `--experimental-strip-types` erases type-only imports entirely and cannot resolve the `@/` alias at runtime.
- No `enum`, no `namespace`, no constructor parameter properties, no decorators (strip-types cannot transform those, only erase annotations).
- Every exported function is pure: same input ⇒ same output, no mutation of its arguments, no `Date.now()`.

### 4.1 `time.ts`

```ts
export const BOARD_ZONE = "UTC";
export const MS_PER_MINUTE = 60_000;
export const MINUTES_PER_DAY = 1440;

export function minutesBetween(a: Date, b: Date): number;      // (b - a) / 60000
export function addMinutes(base: Date, minutes: number): Date;
export function formatClock(d: Date): string;                  // "06:00", 24h, BOARD_ZONE
export function formatDayLabel(d: Date): string;               // "Mon Aug 17", BOARD_ZONE
export function formatFull(d: Date): string;                   // "Mon Aug 17 06:00"
export function startOfUtcDay(d: Date): Date;
export function utcMondayOfWeek(d: Date): Date;                // D17's default window origin
export function formatNumber(n: number): string;               // mockup's fmtNum: 2dp, trailing zeros stripped
```

`formatClock`/`formatDayLabel` use `Intl.DateTimeFormat("en-US", { timeZone: BOARD_ZONE, … })`. `utcMondayOfWeek` must return Monday for a Sunday input too (ISO weeks: Sunday belongs to the week that started six days earlier), and must return a whole-day instant.

### 4.2 `geometry.ts`

Pure geometry and layout. Every function here is ported from the mockup unless marked NEW.

```ts
export const ZOOMS = [...] as const;                            // D16
export type ZoomIndex = 0 | 1 | 2;

export function minutesToPx(minutes: number, pxPerHour: number): number;   // minutes / 60 * pxPerHour
export function pxToMinutes(px: number, pxPerHour: number): number;

/** Greedy first-fit lane packing — the mockup's cellRow loop, extracted. */
export function packLanes<T extends { startMin: number; endMin: number }>(
  items: T[],
): { laneOf: Map<T, number>; laneCount: number };

/** Mockup: h = 36 + max(1, lanes) * 28 + 4. Keep those constants; name them. */
export function trackRowHeight(laneCount: number): number;
export const GROUP_ROW_HEIGHT: number;    // measure the mockup's .grp-row; 30px
export const BAND_TOP = 4;                // .band { top: 4px }
export const LANE_TOP_OFFSET = 36;        // chip top = 36 + lane * 28
export const LANE_HEIGHT = 28;

/** NEW — prefix-sum offsets for vertical virtualization (§6). */
export function buildRowOffsets(heights: number[]): { offsets: number[]; total: number };

/** NEW — binary search + overscan. Returns [firstIndex, lastIndexExclusive]. */
export function visibleRowRange(
  offsets: number[], total: number, scrollTop: number, viewportHeight: number, overscanRows: number,
): [number, number];

/** NEW — the horizontal equivalent, in minutes. */
export function visibleMinuteRange(
  scrollLeft: number, viewportWidth: number, pxPerHour: number,
  windowMinutes: number, overscanMinutes: number,
): [number, number];

export function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean;
export function clipToWindow(startMin: number, endMin: number, windowMinutes: number):
  { startMin: number; endMin: number } | null;                  // null when fully outside
```

**Shift geometry** — the mockup's four functions, generalized per D15. Signatures take a resolved `ShiftTemplate` (from `@/lib/api`) and `dayCount`, and return minutes-from-window-origin:

```ts
export function shiftInstances(t: ShiftTemplate, dayCount: number):
  { shift: Shift; startMin: number; endMin: number; rawStartMin: number; rawEndMin: number }[];
export function breakInstances(t: ShiftTemplate, dayCount: number):
  { shiftBreak: ShiftBreak; shift: Shift; startMin: number; endMin: number }[];
export function shiftBoundaries(t: ShiftTemplate, dayCount: number): number[];
export function offShiftGaps(t: ShiftTemplate, dayCount: number): number[][];
export function shiftSnapPoints(t: ShiftTemplate, dayCount: number): number[];  // unused here; P1-4b needs it
```

Two ports to get exactly right, because both are easy to get subtly wrong:

- `shiftBoundaries` skips boundaries that coincide with a day boundary (the mockup's `s !== 1440 && s !== 2880`). Generalize to `m % 1440 !== 0`, and keep `m === 0` and `m === windowMinutes` excluded too — the window edges are not interior boundaries.
- `offShiftGaps` merges overlapping instances before subtracting. Port the merge loop; do not rewrite it.

**Derived board facts:**

```ts
/** sum(efficiency) over a run's assignments — the mockup's effHC, but in DB units. */
export function effectiveHeadcount(assignments: { efficiency: number }[]): number;
export function isUnderstaffed(effectiveHc: number, plannedHeadcount: number | null): boolean;
```

`isUnderstaffed` returns **false when `plannedHeadcount` is null** — the mockup's runs always have a `planned`, the real column is nullable, and "no plan" is not "understaffed".

### 4.3 `boardIndex.ts`

The one place the raw `BoardWindow` becomes something renderable. Export a single builder:

```ts
export interface BoardIndex {
  windowStart: Date;
  windowMinutes: number;
  dayCount: number;
  rows: BoardRow[];                       // full tree order, before collapse filtering
  runsByNode: Map<string, IndexedRun[]>;
  assignmentsByNode: Map<string, IndexedAssignment[]>;
  assignmentsByRun: Map<string, IndexedAssignment[]>;
  assignmentsByOperator: Map<string, IndexedAssignment[]>;
  templateForNode: Map<string, ShiftTemplate | null>;
  skillsForNode: Map<string, Skill[]>;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  skillById: Map<string, Skill>;
  nodeById: Map<string, BoardNode>;
  capacityCap: number;
  droppedRanges: number;                  // see "unparseable ranges" below
}

export function buildBoardIndex(
  data: BoardWindow, windowStart: Date, windowEnd: Date,
): BoardIndex;
```

`IndexedRun` / `IndexedAssignment` = the API shape plus `startMin` / `endMin` (numbers, clipped to the window) and, for assignments, `efficiencyPercent` via `fromEfficiency`. **`boardIndex.ts` is the only file in the board feature that calls `parseTstzRange` or `fromEfficiency`.** Components read numbers.

Rules this builder must implement:

1. **Rows.** Walk `data.nodes` (already ordered by `path`). Each becomes a `BoardRow` carrying `node`, `depth` (path segment count minus the root's), `isTrack` (D18), and for track rows the packed lanes and computed height. Group rows get `GROUP_ROW_HEIGHT`.
2. **Node-scoped assignments.** An assignment belongs to the row named by `assignment.nodeId` — **not** by its run's node. D5 already forces a run-attached assignment's `node_id` to equal its run's, so the two agree; using `nodeId` directly means a detached assignment still lands somewhere.
3. **Lane packing input** is the node's assignments sorted by `startMin`, then `endMin` — the mockup's `sort((x, y) => x.s - y.s || x.e - y.e)`. Sort before packing; `packLanes` does not sort.
4. **`templateForNode` — nearest-ancestor resolution over ltree paths.** Build a `Map<nodeId, templateId>` from `nodeShiftMap` entries whose `templateId` is non-null. For a node, test its own path first, then walk ancestors by dropping trailing `.segment`s, and return the first template found; `null` if none. Do **not** use `parentId` chains — a node's parent may be outside the loaded window when `p_root_path` starts mid-tree, and the path always works.
5. **`skillsForNode`** — the union of `nodeSkillRequirements` attached at the node **or any ancestor** (same path walk; `docs/api.md` §2 says requirements may be attached above a returned node). Dedupe by skill id; order by skill name.
6. **`capacityCap`** = `data.org.settings.capacity_cap` if it is a finite number, else `1.0`. `settings` is typed `Json`, so narrow it defensively; never throw.
7. **Unparseable ranges must not white-screen the board.** Wrap each `parseTstzRange` call in try/catch. On failure, **drop that row** from the index and increment `droppedRanges`. `BoardPage` renders a small dev-only warning strip when `droppedRanges > 0`. Rationale: `parseTstzRange` throws by contract, and one malformed row must degrade to one missing block, not to a blank application.

---

## 5. Part B — files to create

```
src/features/board/
  BoardPage.tsx                    (rewritten — see §9)
  BoardPage.module.css
  lib/time.ts  lib/geometry.ts  lib/boardIndex.ts        ← Part A
  store/boardView.ts                                     (Zustand)
  components/
    BoardToolbar.tsx  + .module.css      zoom buttons, date range, snap note, legend
    BoardGrid.tsx     + .module.css      the scroll container + virtualization
    BoardHeader.tsx   + .module.css      day strip, hour ticks, day boundaries
    GroupRow.tsx      + .module.css      collapsible group row + its shift boundary strip
    TrackRow.tsx      + .module.css      rail label + track, shift layer, bands, chips, blocks
    ShiftLayer.tsx    + .module.css      off-shift wash, break hatches, shift boundaries
    RunBand.tsx       + .module.css
    AssignmentChip.tsx+ .module.css      run-attached (.achip)
    DirectBlock.tsx   + .module.css      direct (.dblk)
    OperatorPanel.tsx + .module.css      left panel (§8)
    BoardEmptyState.tsx
src/test/
  boardGeometry.test.ts  boardIndex.test.ts  boardTime.test.ts        (Vitest — authored, user runs)
```

**Delete `BoardProof.tsx` and `BoardProof.module.css`.** They are a P1-3b scaffold and the roadmap says P1-4 replaces them wholesale. Since you cannot delete files on the device (`unlink` is not permitted through `device_bash`), overwrite each with a single line — `// removed by P1-4a; delete this file` — and say so in your report so the user removes them from PowerShell.

Colour and token rule: every colour comes from `src/styles/tokens.css`. Product colour follows the **product**, cycling `--product-1..4` by the product's index in `data.products` (the mockup hardcodes four; the real org may have more — cycle with modulo, do not add colours). Set it as `--pc` on the element, exactly as the mockup does.

---

## 6. Virtualization (hand-rolled, per D19)

One scroll container (`BoardGrid`), scrolling **both** axes, with:

- a sticky header (`position: sticky; top: 0`) as a direct child, and
- a spacer `div` of `height: totalRowsHeight` and `width: railWidth + trackWidth`, inside which visible rows are **absolutely positioned** at `top: offsets[i]`.

The rail cell inside each row keeps the mockup's `position: sticky; left: 0` — sticky resolves against the scroll container, so this still works for absolutely positioned rows and is why the rail stays put while the track scrolls.

**Vertical:** `visibleRowRange(offsets, total, scrollTop, viewportHeight, 4)`. Only rows in that slice are rendered.

**Horizontal:** `visibleMinuteRange(scrollLeft, viewportWidth, pxPerHour, windowMinutes, 240)`. Every per-row renderer — bands, chips, blocks, break hatches, off-shift washes, shift boundaries — filters to items intersecting that range before rendering. Hour ticks in the header do the same. Lane assignment is computed over the **whole** window, never over the visible slice, or a block would change lanes as you scroll.

`scrollTop`/`scrollLeft` are read in a `scroll` handler into React state, coalesced with `requestAnimationFrame` (one state update per frame, cancel any pending frame on the next event, cancel on unmount).

Sizing: read the container's dimensions with a `ResizeObserver`. Until the first observation, render with a height of 0 visible rows and no crash — `visibleRowRange` must return an empty range for `viewportHeight === 0`, not throw.

92 days at Fine zoom is ~371,000 px wide, well inside browser limits; do not try to virtualize the spacer's width.

---

## 7. Rendering spec

Port the mockup's markup and CSS class-for-class. The class names in the mockup (`.hdr-row`, `.hdr-track`, `.day-strip`, `.day-box`, `.hour-tick`, `.daybound`, `.grp-row`, `.grp-cell`, `.grp-fill`, `.cell-row`, `.cell-label`, `.req-badge`, `.track`, `.off-shift`, `.shift-break`, `.shiftbound`, `.shift-lbl`, `.band`, `.achip`, `.dblk`, `.chip`, `.pill`, `.sk`, `.avatar`) become CSS Module class names in the colocated module of whichever component owns them — same names, camelCased where the module syntax needs it. Do not invent a different visual language.

Specific ports:

- **Header** — day strip boxes one per day (width = 1440 minutes at current zoom), hour ticks every hour, **every 2 hours at Compact** (`hr % 2 !== 0` skip), day boundary rules at every multiple of 1440 (mockup draws them at `minToX(m) - 1`).
- **Group row** — caret, name, and the level name from `levels[].name` in the `.lvl` slot (the mockup hardcodes `lvl`; take it from the payload). Its fill strip renders shift boundaries for the group's own resolved template — the mockup does this for line rows only; do it for **every** group row that resolves a template, and render the shift-name labels at Compact zoom only, exactly as `lineShiftLayerHTML` does.
- **Track row** — rail label with node name and one `.req-badge` per skill from `skillsForNode`; track of `height = trackRowHeight(laneCount)`; `ShiftLayer` behind; then run bands; then chips/blocks at `top = LANE_TOP_OFFSET + lane * LANE_HEIGHT`, `width = max(46, px(end) - px(start))`.
- **RunBand** — `--pc` from the product, `.under` modifier when `isUnderstaffed`, and the `⚠ {effHc}/{planned}` headcount pill. `effHc` is formatted with `formatNumber` and is a **headcount sum of efficiencies** (0.5 + 0.5 = 1), not a percent. When `plannedHeadcount` is null, render the pill as `{effHc}` alone with no denominator and no warning state.
- **AssignmentChip / DirectBlock** — port `chipEl`/`dblkEl` including the `title` strings, initials avatar, the ` · 50%` efficiency suffix shown **only when the percent is not 100**, the `⌖{target}` suffix, and the `.override` dashed amber outline driven by `assignment.eligibilityOverride`.
- **Cancelled rows are not rendered.** `runs` and `assignments` both carry `status`; skip anything whose `status === "cancelled"` when building the index. The mockup has no cancelled state, so this is an addition, not a port.

---

## 8. The operator panel (read-only half)

Left of the hierarchy rail, collapsible, per design plan §15.3. Port `renderPanel` with these real-data substitutions:

- entries from `data.operators` where `active`, ordered by `displayName`
- avatar initials from `displayName`, skill badges by resolving `skillIds` through `skillById`
- **count pill** = the number of that operator's assignments in the loaded window (`assignmentsByOperator`), omitted at zero
- **`title`** listing each of those assignments as `{nodeName} · {formatFull(start)}–{formatClock(end)} · {percent}%`
- **dimmed** when fully allocated. Port `isFullyAllocated`, but generalize it: the mockup hardcodes a Tue 06:00–22:00 test window; use **the loaded board window**, and compare peak load against `index.capacityCap` (a fraction, e.g. `1.0`) rather than the mockup's `100`. An operator is dimmed when they have at least one assignment in the window and their instantaneous load is `>= capacityCap` at every instant across the union of their assignments **with no gaps**. Put this function in `geometry.ts` as `isFullyAllocated(assignments, windowMinutes, cap)` so §12 can test it.

There is no drag from this panel in P1-4a.

---

## 9. View state and `BoardPage`

`store/boardView.ts` — a Zustand store holding **only** view state: `zoomIndex`, `collapsedNodeIds: Set<string>`, `windowStartDate`, `windowDayCount`, `operatorPanelOpen`, plus their setters and a `toggleCollapsed(nodeId)`. No server data in the store; React Query owns that.

`BoardPage.tsx` composes: `BoardToolbar` + `OperatorPanel` + `BoardGrid`, calls `useBoardWindow(rootPath, from, to)`, and builds the index with `useMemo(() => buildBoardIndex(data, from, to), [data, from, to])`.

`rootPath`: keep P1-3b's existing behaviour — `BoardProof` already resolves a root path; read how it does it and reuse exactly that, in a small `useRootPath()` hook under `src/features/board/hooks/`. Do not change the resolution rule; if it is currently a hardcoded constant, keep the constant and mark it in your report as inherited.

Collapse filtering: a row is hidden if **any** ancestor node id is in `collapsedNodeIds`. Test by path prefix against the collapsed nodes' paths, so it is one pass over the ordered `rows` array.

---

## 10. Transitions — specify these, they are where the bugs live

Design plan §17.4: both real bugs in the previous build were transitions, not steady states. Each item below is a required behaviour, and §12/§14 check them.

**T1 — a refetch lands while the user is scrolled.** Row heights can change (a new assignment changes a lane count), so a preserved `scrollTop` in pixels silently jumps the view. Instead: before each render, record the **node id of the first visible row** and its pixel offset within the viewport; after the index changes, restore `scrollTop` so that same node sits at the same offset. If that node is gone, fall back to the nearest still-present ancestor by path; if none, clamp to `min(scrollTop, total - viewportHeight)`.

**T2 — zoom change.** Preserve the time instant under the **horizontal centre** of the viewport: capture `centreMin = pxToMinutes(scrollLeft + viewportWidth / 2, oldPxPerHour)`, then after the zoom set `scrollLeft = minutesToPx(centreMin, newPxPerHour) - viewportWidth / 2`, clamped to `[0, trackWidth - viewportWidth]`. (The mockup preserves the left edge; centre is the correction.)

**T3 — the signed-in identity changes.** `DevProfileSwitcher` swaps user; the board comes back with a different node set. `collapsedNodeIds` may reference nodes that no longer exist — that is harmless and must **not** be pruned (switching back should restore the user's collapse state). The T1 anchor node may vanish — T1's fallback covers it. Verify the board does not crash and does not keep the previous user's rows on screen.

**T4 — do not blank the board on a background refetch.** `useBoardWindow` has a 30s `staleTime`, so refetches happen. Render the spinner only on `status === "pending"` **with no cached data**; when `isFetching` is true and data exists, keep rendering the data and show a subtle refreshing indicator in the toolbar. Getting this wrong makes the board flash empty every half minute.

**T5 — scrolling never triggers a fetch.** The loaded window is exactly what the toolbar requests. Scrolling to the right edge does not extend it. This is a deliberate limit of P1-4a; name it in the toolbar with an end-of-window marker so it does not read as a bug.

**T6 — window longer than 92 days.** `board_window` raises `invalid_argument`. The date-range control must clamp to 92 days before requesting, **and** the error path must still render `describeSchedulerError(error)` in an error state rather than a blank grid — a clamp is not a substitute for handling the error.

**T7 — a collapse toggle while scrolled below the collapsed group.** Rows above the viewport disappear and everything shifts up. Apply T1's anchor logic to the toggle as well: keep the first visible row where it is, unless it is inside the group being collapsed, in which case scroll to the collapsed group's own row.

**T8 — empty and partial payloads.** Zero nodes (a viewer with no grants) ⇒ `BoardEmptyState`, not an empty grid. Nodes but no runs/assignments ⇒ normal empty tracks. A node whose level id is missing from `levels` ⇒ treat as a group row and do not throw.

**T9 — `viewportHeight === 0` before the first `ResizeObserver` callback** ⇒ empty visible range, no crash, no division by zero.

---

## 11. Code-splitting (`vite.config.ts`)

Design plan §17.3 deferred this here. Add to `build.rollupOptions.output`:

```ts
manualChunks: {
  react: ["react", "react-dom", "react-dom/client"],
  router: ["react-router-dom"],
  query: ["@tanstack/react-query"],
  supabase: ["@supabase/supabase-js"],
}
```

Change nothing else in `vite.config.ts`. Report the pre-change baseline from `docs/design-plan.md` §17.3 (548 kB / 161 kB gzipped when empty; 560 kB / 165 kB after P1-3b) so the user can compare after running `npm run build` — do **not** predict a number.

---

## 12. Part A validation — MANDATORY, you can run this

Create a scratch harness under `/tmp` (never in the repo, never in the delivery tarball). Because Part A uses only `import type` imports, each module runs standalone:

```bash
node --experimental-strip-types /tmp/harness/run.ts
```

Copy the three Part A files into `/tmp/harness/` alongside a `run.ts` that imports them by **relative** path with an explicit `.ts` extension (`import { packLanes } from "./geometry.ts"`). The `@/` alias does not resolve under strip-types; the type-only imports vanish, so nothing else needs rewriting. Write plain assertions; print `PASS`/`FAIL` lines and exit non-zero on any failure, the same style as `supabase/tests/`.

This harness pattern was executed in this container by the design session before the brief was written — Node 22.22, relative `.ts` imports, `import type` erased, mutations M1 and M3 confirmed to break their named cases. It works. If it does not work for you, you have deviated from it; say so rather than abandoning §12.

Cases you must cover, at minimum:

**Time**
1. `formatClock` on `2026-08-17T06:00:00Z` ⇒ `"06:00"`; on `…T22:30:00Z` ⇒ `"22:30"`.
2. `utcMondayOfWeek` returns the same Monday for that Monday, for the Wednesday after it, and for the **Sunday** after it.
3. `formatNumber(1)` ⇒ `"1"`, `formatNumber(1.5)` ⇒ `"1.5"`, `formatNumber(1.25)` ⇒ `"1.25"`.

**Geometry**
4. `minutesToPx(60, 104)` ⇒ `104`; `pxToMinutes(104, 104)` ⇒ `60`; round-trip at all three zooms.
5. Lane packing: three assignments 06:00–14:00, 06:00–10:00, 10:00–14:00, sorted by start then end ⇒ **laneCount 2**, and 10:00–14:00 shares a lane with 06:00–10:00 — it starts exactly when that one ends, and half-open ranges do **not** collide. (Assert `laneOf(10:00–14:00) === laneOf(06:00–10:00)`, not a specific lane number: greedy first-fit puts both on lane 0 and 06:00–14:00 on lane 1, which is easy to get backwards when writing the assertion.)
6. `trackRowHeight(0)` equals `trackRowHeight(1)` (the `max(1, lanes)` floor).
7. `shiftInstances` on the 3×8h template over a 3-day window produces a **day -1 tail**: an instance clipped to start at 0 whose `rawStartMin` is negative, from the overnight 22:00–06:00 shift.
8. `offShiftGaps` on 3×8h (06:00→06:00 next day, fully covered) returns **no** interior gap on days 1..n; on 2×10h (06:00–02:00, a 4h hole) returns one gap per day of exactly 240 minutes.
9. `shiftBoundaries` contains no multiple of 1440, and none at 0 or `windowMinutes`.
10. `clipToWindow` returns `null` for a range entirely before the window, and clips a straddling range to the edge.
11. `visibleRowRange` on 500 rows of mixed heights: the returned slice covers the viewport, includes the overscan, is correct at `scrollTop = 0` and at the very bottom, and is empty for `viewportHeight = 0`.
12. `effectiveHeadcount([{efficiency:0.5},{efficiency:0.5}])` ⇒ `1`; `isUnderstaffed(1, 2)` ⇒ true; `isUnderstaffed(1, null)` ⇒ **false**.
13. `isFullyAllocated`: one assignment at efficiency 1.0 covering the whole window ⇒ true; the same with a one-minute gap ⇒ false; two 0.5 assignments covering the window in parallel ⇒ true at cap 1.0.

**Board index** — build a fixture `BoardWindow` by hand (mirror `supabase/seed.sql`'s shape; you do not need real UUIDs):
14. Nearest-ancestor template: a template attached at `plant_1.assembly` resolves for `plant_1.assembly.line_1.cell_1`; a template attached at `plant_1.machining.cnc_line` **overrides** the department for `…cnc_line.cell_6`; a node with no ancestor attachment resolves `null`.
15. `skillsForNode` unions an ancestor-attached requirement onto a descendant node, deduped.
16. A run and its assignments land under the assignment's own `nodeId`.
17. `status === "cancelled"` rows are excluded from every map.
18. A malformed `timerange` string increments `droppedRanges` by exactly 1 and **does not throw**, and the rest of the payload still indexes.
19. `capacityCap` reads `1.2` from `org.settings`, and falls back to `1.0` when `settings` is `{}`, `null`, or has a non-numeric `capacity_cap`.

---

## 13. Mutation testing — MANDATORY, and report the exact failure text

A suite that passes proves nothing until you have watched it fail. For each mutation: break it **in your `/tmp` copy only**, re-run the harness, record the failing assertion's exact printed line, then restore. Never mutate the delivered files.

| # | Break this | The case that must fail |
| --- | --- | --- |
| M1 | `packLanes` — change the lane-reuse test from `laneEnd <= item.startMin` to `laneEnd < item.startMin` (touching ranges now collide) | case 5 — laneCount becomes 3 |
| M2 | Nearest-ancestor resolution — return the **first** match walking down from the root instead of the nearest | case 14's CNC override |
| M3 | `shiftInstances` — start the day loop at `0` instead of `-1` | cases 7, 8a **and** 8b — the tail vanishes and a spurious `[0, 360]` gap appears in both templates |
| M4 | `isUnderstaffed` — treat `null` planned headcount as `0` | case 12's null case |
| M5 | Remove the try/catch around `parseTstzRange` in `buildBoardIndex` | case 18 (the harness must report a thrown error, not a silent pass) |
| M6 | `visibleRowRange` — drop the overscan | case 11 |

If a mutation does **not** produce a failure, the test is the bug, not the mutation. Fix the test, say so in your report, and re-run.

---

## 14. Your self-review (you CAN do all of this by reading)

Report item by item with evidence:

1. No file under `src/features/board/lib/` imports React, CSS, a DOM type, or anything with a runtime value — and every one of its imports uses `import type`. (Show the import lines.)
2. `parseTstzRange` and `fromEfficiency` appear in `boardIndex.ts` and nowhere else in the feature. (Show a grep.)
3. No component calls `Date#getHours`/`getMinutes`/`toLocaleTimeString`/`toLocaleDateString`; every clock string comes from `time.ts`. (Show a grep.)
4. No colour literal outside `tokens.css`; every colour is a `var(--…)`. (Show a grep for `#` in the new CSS modules.)
5. No `pointerdown`, `onDragStart`, `draggable`, or mutation-hook import anywhere in the delivery (§2's fence). (Show a grep.)
6. Every `useMemo`/`useEffect`/`useCallback` dependency array is complete — walk each one.
7. The `scroll` handler cancels its pending `requestAnimationFrame` on unmount, and the `ResizeObserver` is disconnected on unmount.
8. `BoardProof` is no longer imported anywhere.
9. Each of T1–T9 in §10: name the file and lines that implement it, or state plainly that it is unimplemented.
10. Nothing outside `src/lib/api/` imports `@/lib/database.types`.

---

## 15. Acceptance — the user runs this, not you

Include this block verbatim in your report:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
```

Then `npm run dev` in PowerShell (Supabase already up in WSL), at `localhost:5173`:

1. Sign in as **Admin** → a board with 7 cell rows under their groups, 8 run bands, 12 assignment chips/blocks, product colours matching the legend.
2. Assembly cells show **3 × 8h** shift striping; CNC cells show **2 × 10h** — visibly different break positions on adjacent rows.
3. Zoom Compact / Standard / Fine → block widths change, the instant under the viewport centre stays put, hour ticks thin out to every 2h at Compact.
4. Collapse a group → its cells disappear; expand → they come back with the same scroll position.
5. Left panel lists operators with skill badges and count pills; fully-allocated operators render dimmed; hovering an entry lists their assignments.
6. Switch to **Ana** → 5 cells, Assembly only. Switch to **Marco** → 2 cells, CNC only. No stale rows from the previous identity, no crash.
7. Widen the window to 60 days → still scrolls smoothly; the board does not blank while refetching.
8. No console errors, no React key warnings.

Mark every item **NOT RUN — no npm in container**. Do not estimate whether they would pass.

---

## 16. Delivery

Build in the container, deliver to the device: tar `src/` and `vite.config.ts` **only** — never the whole `docs/` folder, never `node_modules/`, never `/tmp/harness/`. Then `SendUserFile` → `device_commit_files` to `…\production_scheduler\_delivery\board-render.tar.gz` → `device_bash` to extract in place → `git status --short`.

Three device gotchas, all hit before on this project:

- Files extracted from a tarball land **read-only** — `chmod u+w` before patching one in place.
- `device_commit_files` can be refused outright by Windows Controlled Folder Access. If it is, do not retry the same path; write via `device_bash` heredoc and say so.
- `device_bash` **cannot delete files**. Do not try. If you run any `git` command, note in your report that a stray `.git/index.lock` may be left behind and that the user must remove it from PowerShell (`Remove-Item .git\index.lock`).

Write the roadmap edit with a `device_bash` heredoc so `docs/` is only added to. **Do not commit or push. Do not run any npm command.**

---

## 17. Required final step

Edit `docs/roadmap.md`: mark the "Board UI: virtualized timeline grid…" Phase 1 line `[x]` with the note "P1-4a code delivered, acceptance pending user run", add a **P1-4a** row to the Phase 1 brief queue table, refresh **Last updated**. Leave every other row alone.

---

## 18. Report format

Report, in this order:

1. The full file tree you created, with a one-line purpose each.
2. **§12 harness results — the actual printed output.** This is not optional.
3. **§13 mutation results — the exact failing line for each of M1–M6.** Also not optional.
4. Your §14 self-review, item by item, with the evidence.
5. The §15 acceptance block for the user, every item marked NOT RUN.
6. Every assumption you made where this brief was silent — and be specific, because on this project the agent's flagged deviations have repeatedly turned out to be real bugs in the brief rather than misreadings of it.
7. Anything left undone.
