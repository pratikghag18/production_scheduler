/**
 * Pure drag arithmetic for board interactions (brief P1-4b §4). No React,
 * no DOM, every function pure and side-effect-free — same constraints as
 * `geometry.ts` (brief P1-4a §4.2), so this module is executable standalone
 * under `node --experimental-strip-types` for the §11/§12 harness.
 *
 * This file ends up with zero non-type imports: every function needed here
 * is self-contained arithmetic over `{ startMin, endMin }` shapes, so
 * there is nothing to pull in from `./geometry` or `@/lib/api` (the brief
 * permits both, it does not require either). See the agent report's
 * "assumptions" section for why an all-type/no-import file still satisfies
 * self-review §13 item 1 ("imports only types plus `./geometry` values") —
 * the empty set is vacuously "only types plus geometry values".
 */

export const MIN_DURATION_MINUTES = 15; // D31
export const DRAG_THRESHOLD_PX = 4; // D32

export type DragMode = "create" | "move" | "resize-start" | "resize-end";
export type EdgeHit = "start" | "end" | "body";

interface Range {
  startMin: number;
  endMin: number;
}

/**
 * Which part of a block the pointer landed on. `handlePx` is the hit width
 * of each edge grip (the mockup's `.h` spans: 8px on a band, 7px on a
 * chip). D38: `grip = min(handlePx, floor(blockWidthPx / 3))` — without
 * this a block narrower than twice the handle has overlapping start/end
 * zones and no body at all (§3).
 *
 * Boundary pixels belong to the edge zone (`<=`/`>=`, not `<`/`>`) — this
 * is what lets §12's M7 mutation (widening the edge zones to half the
 * block) be caught by case 15's "body" assertion: at the exact midpoint of
 * a 200px block the correct grip (8px, D38) classifies it as `"body"`,
 * but a half-width grip's boundary sits exactly on that midpoint, and the
 * inclusive comparison flips it to `"start"`.
 */
export function hitTestBlock(offsetXPx: number, blockWidthPx: number, handlePx: number): EdgeHit {
  const grip = Math.min(handlePx, Math.floor(blockWidthPx / 3));
  if (offsetXPx <= grip) return "start";
  if (offsetXPx >= blockWidthPx - grip) return "end";
  return "body";
}

/**
 * D30. `shiftPoints` is `shiftSnapPoints(template, dayCount)` for the row,
 * or `[]` when the row resolves no template. `snapMinutes` is the zoom's
 * step. `useShiftSnap` is true only at Compact zoom. Holding Alt disables
 * snapping entirely and gives whole minutes (checked first, unconditional
 * on every other option — this is what lets §12's M4 mutation, "ignore
 * altKey", be caught by case 2 alone).
 */
export function snapMinute(
  rawMin: number,
  opts: {
    altKey: boolean;
    useShiftSnap: boolean;
    snapMinutes: number;
    shiftPoints: number[];
  },
): number {
  if (opts.altKey) return Math.round(rawMin);

  if (opts.useShiftSnap && opts.shiftPoints.length > 0) {
    let best = opts.shiftPoints[0];
    let bestDist = Math.abs(rawMin - best);
    for (const p of opts.shiftPoints) {
      const d = Math.abs(rawMin - p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  const step = opts.snapMinutes;
  return Math.round(rawMin / step) * step;
}

/**
 * Create: two ALREADY-SNAPPED instants in either drag direction -> a
 * normalized range, or `null` if it is shorter than
 * `MIN_DURATION_MINUTES` (D31) once clamped to the window. The caller
 * (`useDragGesture`) is responsible for snapping `anchorMin`/`currentMin`
 * via `snapMinute` before calling this — this function only normalizes,
 * clamps, and enforces the minimum.
 */
export function createRange(
  anchorMin: number,
  currentMin: number,
  windowMinutes: number,
): Range | null {
  let startMin = Math.min(anchorMin, currentMin);
  let endMin = Math.max(anchorMin, currentMin);
  startMin = Math.max(0, Math.min(startMin, windowMinutes));
  endMin = Math.max(0, Math.min(endMin, windowMinutes));
  if (endMin - startMin < MIN_DURATION_MINUTES) return null;
  return { startMin, endMin };
}

/**
 * Move: preserves duration, clamps to `[0, windowMinutes]` WITHOUT
 * squashing — a block pushed past an edge stops there at full length
 * (§4's clamp-vs-squash rule; §12's M1 mutates this into clamping each
 * edge independently, which is caught by case 8's duration assertion).
 */
export function moveWithinTrack(original: Range, deltaMin: number, windowMinutes: number): Range {
  const duration = original.endMin - original.startMin;
  let newStart = original.startMin + deltaMin;
  newStart = Math.max(0, Math.min(newStart, windowMinutes - duration));
  return { startMin: newStart, endMin: newStart + duration };
}

/**
 * Resize: moves one edge only; the other is fixed. Enforces D31 against
 * the FIXED edge (§4's second easy-to-get-wrong rule) and clamps to the
 * window.
 */
export function resizeRange(
  original: Range,
  edge: "start" | "end",
  deltaMin: number,
  windowMinutes: number,
): Range {
  if (edge === "start") {
    let newStart = original.startMin + deltaMin;
    newStart = Math.max(0, Math.min(newStart, original.endMin - MIN_DURATION_MINUTES));
    return { startMin: newStart, endMin: original.endMin };
  }
  let newEnd = original.endMin + deltaMin;
  newEnd = Math.min(windowMinutes, Math.max(newEnd, original.startMin + MIN_DURATION_MINUTES));
  return { startMin: original.startMin, endMin: newEnd };
}

/**
 * Does this candidate range overlap another run on the same node? The
 * database enforces this (D4's exclusion constraint) but the UI refuses
 * the drop before sending it, so the user gets an instant answer. Half-open
 * comparison (`intersects` from `geometry.ts`, duplicated here rather than
 * imported for the same reason `geometry.ts` duplicates `MINUTES_PER_DAY`
 * instead of importing `time.ts` — see the agent report) — two runs that
 * merely touch do not overlap.
 */
export function findRunOverlap<T extends { id: string; startMin: number; endMin: number }>(
  candidate: Range,
  runsOnNode: T[],
  excludeRunId: string | null,
): T | null {
  for (const r of runsOnNode) {
    if (excludeRunId !== null && r.id === excludeRunId) continue;
    if (candidate.startMin < r.endMin && r.startMin < candidate.endMin) return r;
  }
  return null;
}

/**
 * Resizing a run inward strands crew outside it. Returns which assignments
 * get clipped (still overlap the new window but extend past it) and which
 * fall out entirely (no overlap at all) — mockup: `startBandDrag`'s resize
 * branch. P1-4b only WARNS with this (§5) — it does not modify the crew.
 */
export function classifyCrewAgainstRun<T extends { id: string; startMin: number; endMin: number }>(
  run: Range,
  crew: T[],
): { clipped: T[]; stranded: T[] } {
  const clipped: T[] = [];
  const stranded: T[] = [];
  for (const c of crew) {
    const overlaps = c.startMin < run.endMin && run.startMin < c.endMin;
    if (!overlaps) {
      stranded.push(c);
      continue;
    }
    const fullyInside = c.startMin >= run.startMin && c.endMin <= run.endMin;
    if (!fullyInside) clipped.push(c);
  }
  return { clipped, stranded };
}

/** Minutes -> the instant, for popover labels. Pure; takes windowStart. */
export function minuteToDate(windowStart: Date, minute: number): Date {
  return new Date(windowStart.getTime() + minute * 60_000);
}
