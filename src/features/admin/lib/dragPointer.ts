/**
 * The shared pointer block D95b exists for (brief P1-5l §4.2).
 *
 * ONE copy of "has this pointer started a drag, and may it start one from
 * here", used by BOTH admin drag surfaces: the node tree (P1-5l) and the level
 * list (P1-5i). They ship together precisely so this is written once — building
 * them apart means writing it twice and then reconciling two copies.
 *
 * IT HOLDS DECISIONS, NOT EFFECTS. No `document`, no `window`, no React, and
 * no value imports at all — `import type` only — so it runs unmodified under
 * `node --experimental-strip-types` and is testable without a DOM. Everything
 * that touches the DOM (`setPointerCapture`, `elementFromPoint`,
 * `getBoundingClientRect`) stays in the components, where it cannot be tested
 * and therefore must not be where any decision lives.
 */

/** Where the pointer went down, in client coordinates. */
export interface PointerOrigin {
  x: number;
  y: number;
}

/**
 * Has the pointer moved far enough from `origin` to count as a DRAG rather
 * than a CLICK?
 *
 * ⭐ EUCLIDEAN DISTANCE, NEVER TWO PER-AXIS COMPARISONS. A diagonal drag of 3px
 * in x and 3px in y has travelled 4.24px and must pass a 4px threshold; a pair
 * of `Math.abs(dx) >= t || Math.abs(dy) >= t` tests refuses it, and the user
 * who drags diagonally — which is most of them — finds the gesture dead in the
 * corner directions. Case T5 is that fixture and mutation U1 is that mistake.
 *
 * A NON-FINITE coordinate returns `false`, at BOTH ends: a drag that cannot be
 * measured has not started. The two guards are separate mutations (U3, U4) and
 * separate cases (T10, T11) because they fail differently — see the note on the
 * origin guard below.
 *
 * ⚠️ THERE IS DELIBERATELY NO `thresholdPx <= 0` SHORT-CIRCUIT. `Math.hypot`
 * is never negative, so `hypot >= t` is already true for every finite hypot and
 * every `t <= 0`; a branch saying so is unfalsifiable. One was written into the
 * reference implementation, came back NOT CAUGHT by all 19 cases, and was
 * deleted (gotcha 17). T12 and T13 still assert the behaviour — they assert it
 * against the general expression, which is the point.
 */
export function passedThreshold(
  origin: PointerOrigin,
  x: number,
  y: number,
  thresholdPx: number,
): boolean {
  // ⭐ THE ORIGIN GUARD IS NOT REDUNDANT WITH THE COORDINATE GUARD, and the
  // reason is the whole of case T11. A NaN origin propagates through `hypot`
  // and the comparison is false anyway, so a NaN-only fixture cannot tell
  // whether this line exists — mutation U8 in the design session came back NOT
  // CAUGHT against exactly that fixture. An INFINITE origin is different:
  // `Math.hypot(0 - Infinity, 0)` is `Infinity`, which passes ANY threshold, so
  // without this line a pointer whose origin was never measured starts a drag
  // on its first move. T11 uses the infinite origin; T11b keeps the NaN one, so
  // the pair records that the split was deliberate.
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.hypot(x - origin.x, y - origin.y) >= thresholdPx;
}

/**
 * Whether this pointer should drag from the WHOLE ROW, or only from the `⠿`
 * handle.
 *
 * D95a: `.dragHandle` carries `touch-action: none` so a touch drag moves the
 * node instead of scrolling the page. Putting that on the whole row would leave
 * NOWHERE on the tree a finger could scroll from — checked, and the check is
 * the argument: the only `overflow-y: auto` in the component is the "Move to…"
 * popover, so the scroller for the tree itself is the PAGE. Hence mouse and pen
 * drag from anywhere on the row; touch keeps the handle.
 *
 * ⭐ FAIL-CLOSED, same shape as `adminAccess`: anything NOT recognised returns
 * `false`. An unknown pointer type is not assumed to be safe to scroll over —
 * the cost of being wrong in that direction is a surface a finger cannot pan,
 * and the cost of being wrong in this direction is a handle that still works.
 *
 * ⚠️ `e.pointerType` is `""` in some synthetic-event paths. `""` is
 * unrecognised, which this rule already covers; it is NOT special-cased,
 * because a branch for it would be a second way of saying the same thing.
 */
export function rowIsDragSource(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
}

/**
 * Offset of a `clientY` within a row, given that row's top edge — the input
 * `resolveDropZone` measures its half-split against.
 *
 * DELIBERATELY NOT CLAMPED and deliberately allowed to go negative:
 * `resolveDropZone` documents that it wants an unclamped offset, because a
 * pointer a fraction of a pixel above the row it hit — which happens constantly
 * at the seam between two rows — must still resolve to the nearer half rather
 * than being snapped to zero.
 */
export function offsetInRow(clientY: number, rowTop: number): number {
  return clientY - rowTop;
}
