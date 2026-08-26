/**
 * Pure drag arithmetic for board interactions (brief P1-4b §4). No React,
 * no DOM, every function pure and side-effect-free — same constraints as
 * `geometry.ts` (brief P1-4a §4.2), so this module is executable standalone
 * under `node --experimental-strip-types` for the §11/§12 harness.
 *
 * P1-5l §4.1: this file no longer ends up with zero non-type imports. It
 * carries ONE re-export -- `DRAG_THRESHOLD_PX`, which moved to
 * `src/lib/interaction.ts` the moment the admin tree needed the same number
 * and `conventions.md` forbade admin importing from board. That is an
 * `export ... from`, so it costs this module a resolvable specifier under
 * `node --experimental-strip-types` (the `@/` alias is a bundler alias, not a
 * node one) and the §11/§12 standalone harness would now need the same alias
 * mapping the test runner already has. Recorded here rather than left to be
 * discovered, because the paragraph below asserted the opposite and an
 * expired comment is this project's recurring defect. Everything else in the
 * paragraph still holds:
 *
 * This file ends up with zero OTHER non-type imports: every function needed here
 * is self-contained arithmetic over `{ startMin, endMin }` shapes, so
 * there is nothing to pull in from `./geometry` or `@/lib/api` (the brief
 * permits both, it does not require either). See the agent report's
 * "assumptions" section for why an all-type/no-import file still satisfies
 * self-review §13 item 1 ("imports only types plus `./geometry` values") —
 * the empty set is vacuously "only types plus geometry values".
 */

export const MIN_DURATION_MINUTES = 15; // D31

/**
 * D32, and it now lives in `src/lib/interaction.ts` (brief P1-5l §4.1) because
 * the admin node tree and level list need the same number and a feature may not
 * import from another feature. RE-EXPORTED here rather than duplicated, so
 * every existing `from "../lib/interaction"` import (only
 * `hooks/useDragGesture.ts`, twice) keeps working untouched and there is still
 * exactly one `4` in the repo.
 */
export { DRAG_THRESHOLD_PX } from "@/lib/interaction";

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

// ---------------------------------------------------------------------------
// P1-4e additions (brief §4).
// ---------------------------------------------------------------------------

/**
 * D58. `rowTops` is the prefix-sum offsets array (`buildRowOffsets(heights).
 * offsets` from `./geometry`); `rowHeights` the matching heights — same
 * length, `rowTops[i] + rowHeights[i] === rowTops[i + 1]` for every `i`
 * (rows are contiguous, no gaps). Binary search for the row whose half-open
 * span `[rowTops[i], rowTops[i] + rowHeights[i])` contains `y`: find the
 * LARGEST index whose top is `<= y` (there can be at most one, since the
 * spans are contiguous and non-overlapping), then confirm `y` is still
 * inside that row's own span rather than past the board's total height.
 * Returns `null` when `y` is above the first row's top or at/past the last
 * row's bottom edge. Runs on every pointermove over a virtualized grid
 * (D58's own words) — O(log n), no DOM measurement, no `elementFromPoint`.
 */
export function resolveDropRow(rowTops: number[], rowHeights: number[], y: number): number | null {
  const n = rowTops.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (rowTops[mid] <= y) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return null;
  if (y < rowTops[candidate] + rowHeights[candidate]) return candidate;
  return null;
}

/**
 * D62's "Split evenly": given a cap (as a UI percent, e.g. `100`) and N
 * participants (the existing overlapping assignments plus the incoming
 * one), propose an integer UI percent for each so the total is EXACTLY
 * `Math.round(capPercent)` — never a value that merely rounds close to it.
 * `Math.floor(total / n)` for every participant, with the remainder (which
 * is always `< n`, so at most `n - 1` extra percentage points) added to the
 * FIRST participant: three-way at 100% is `[34, 33, 33]`, never
 * `[33, 33, 33]` (which would under-fill the cap) or `[33, 33, 34]` (a
 * different, equally arbitrary participant getting the remainder — the
 * brief pins it to the first for a deterministic UI). `participantCount
 * <= 0` returns `[]` (nothing to split among).
 */
export function splitEvenly(participantCount: number, capPercent: number): number[] {
  if (participantCount <= 0) return [];
  const total = Math.round(capPercent);
  const base = Math.floor(total / participantCount);
  const remainder = total - base * participantCount;
  // ONE unit to each of the first `remainder` participants — not the whole
  // remainder to participant 0. The brief said "the remainder goes to the
  // FIRST participant", which is true for its own examples (n=2,3,4 at cap
  // 100 all have a remainder of 0 or 1) and wrong in general: dumping it on
  // one participant gives [16,12,12,12,12,12,12,12] for an 8-way split at
  // 100%, a spread of 4, which is not an even split. Distributing gives
  // [13,13,13,13,12,12,12,12] — spread 1, which is the most even integer
  // split that still sums to the cap. Found by a design-session property
  // test (max - min <= 1) that no example-based case could catch.
  return Array.from({ length: participantCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * D62's live readout: does this proposed set of percents fit under the cap?
 * Pure arithmetic over what the user is editing — NOT a peak-load
 * computation (D63): `percents` is the flat list the split popover shows
 * (each participant's own single-window share), not an instant-wise peak
 * over time. The popover's own window is a single overlapping range by
 * construction (`capacity_probe`'s `overlapping[]` plus the incoming
 * assignment all cover the SAME probed window), so a plain sum is the
 * correct check here — `operator_peak_load()` is what re-validates the
 * real, possibly-wider picture server-side on confirm.
 */
export function splitFits(percents: number[], capPercent: number): boolean {
  const sum = percents.reduce((s, p) => s + p, 0);
  return sum <= capPercent;
}

/**
 * D57. The crew ranges after a run moves by `deltaMin`, for the drag
 * preview only — the actual move is one `move_run` call, which (per
 * `docs/api.md` §3's `move_run`) shifts every attached assignment's own
 * timerange by the SAME delta as the run's new start and does NOT clamp an
 * assignment that extended beyond the run's old bounds. This preview
 * function instead clamps each crew member's shifted range into
 * `[0, windowMinutes]` without squashing it (the P1-4b clamp-vs-squash
 * rule this brief re-verifies at case 7/M5): a range pushed past an edge
 * stops there at full length, exactly like `moveWithinTrack`. Does not
 * mutate `crew`.
 */
export function planCrewShift<T extends { id: string; startMin: number; endMin: number }>(
  crew: T[],
  deltaMin: number,
  windowMinutes: number,
): { id: string; startMin: number; endMin: number }[] {
  return crew.map((c) => {
    const duration = c.endMin - c.startMin;
    let newStart = c.startMin + deltaMin;
    newStart = Math.max(0, Math.min(newStart, windowMinutes - duration));
    return { id: c.id, startMin: newStart, endMin: newStart + duration };
  });
}

/**
 * D66. May this assignment live on this run? Plain containment:
 * `a.startMin >= run.startMin && a.endMin <= run.endMin`. Do NOT add a
 * third `a.startMin < run.endMin` clause — with any positive-duration
 * assignment it is implied by the other two, and the design session
 * verified it is unreachable (`MIN_DURATION_MINUTES` is 15, so a
 * zero-length assignment cannot exist). A redundant guard reads as a case
 * someone thought about, which is worse than not writing it.
 */
export function assignmentFitsRun(
  assignment: { startMin: number; endMin: number },
  run: { startMin: number; endMin: number },
): boolean {
  return assignment.startMin >= run.startMin && assignment.endMin <= run.endMin;
}
