/**
 * Pure geometry and layout (brief P1-4a §4.2, extended by P1-4c §4 for
 * density). No React, no CSS, no DOM API. The one import is a type-only
 * import from `@/lib/api` — it is erased entirely under `node
 * --experimental-strip-types` (brief §4/§12), so this module still
 * executes standalone.
 *
 * `MINUTES_PER_DAY` is intentionally duplicated from `./time.ts` rather
 * than imported — importing a *value* from a sibling module would be a
 * real runtime dependency, and this file otherwise has none. See the
 * agent report's "assumptions" section for why this file does not import
 * `./time.ts`.
 */
import type { Shift, ShiftBreak, ShiftTemplate } from "@/lib/api";

const MINUTES_PER_DAY = 1440;

// ---------------------------------------------------------------------------
// D16 — zoom table, ported verbatim.
// ---------------------------------------------------------------------------

export const ZOOMS = [
  { name: "Compact", pxPerHour: 64, snapMinutes: 60 },
  { name: "Standard", pxPerHour: 104, snapMinutes: 30 },
  { name: "Fine", pxPerHour: 168, snapMinutes: 15 },
] as const;

export type ZoomIndex = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// P1-4c D43 — density table. Zoom is the *horizontal* scale (px per hour);
// density is the *vertical* one. They are independent and both are
// user-chosen (D46) — density is never derived from viewport size.
//
// Standard (index 1) reproduces today's pre-P1-4c constants EXACTLY:
// GROUP_ROW_HEIGHT was 30, BAND_TOP was 4, LANE_TOP_OFFSET was 36,
// LANE_HEIGHT was 28 — so at Standard density nothing moves by a pixel
// (brief §3, the acceptance-item-1 regression guard, and §8 case 1).
// ---------------------------------------------------------------------------

/**
 * Widened deliberately. P1-4c's D43 wrote this table `as const`, which made
 * `Density` a union of LITERAL types (`laneHeight: 34 | 28 | 22`) — fine while
 * the only densities were the three in the table, but P1-4d's `scaleDensity`
 * returns computed numbers, which no literal type can hold. `as const` and a
 * scaling function are mutually exclusive; the interface is what reconciles
 * them. (Design-session fix at P1-4d acceptance — the brief specified both and
 * they cannot both be true.)
 */
export interface Density {
  name: string;
  laneHeight: number;
  laneTopOffset: number;
  groupRowHeight: number;
  bandTop: number;
  bandHeight: number;
  rowPadBottom: number;
  /** Height of an assignment chip / direct block inside a lane. */
  chipHeight: number;
  /** Height (and width) of the round operator avatar inside a chip. */
  avatarSize: number;
}

export const DENSITIES: readonly Density[] = [
  {
    name: "Comfortable",
    laneHeight: 34,
    laneTopOffset: 42,
    groupRowHeight: 36,
    bandTop: 5,
    bandHeight: 30,
    rowPadBottom: 6,
    chipHeight: 26,
    avatarSize: 18,
  },
  {
    name: "Standard",
    laneHeight: 28,
    laneTopOffset: 36,
    groupRowHeight: 30,
    bandTop: 4,
    bandHeight: 26,
    rowPadBottom: 4,
    chipHeight: 22,
    avatarSize: 15,
  },
  {
    name: "Compact",
    laneHeight: 22,
    laneTopOffset: 28,
    groupRowHeight: 24,
    bandTop: 3,
    bandHeight: 22,
    rowPadBottom: 3,
    chipHeight: 18,
    avatarSize: 13,
  },
];

export type DensityIndex = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// P1-4d D53 — density mode: automatic Fit, or a manual override that turns
// Fit off and renders one of the three named densities unscaled.
// ---------------------------------------------------------------------------

export type DensityMode = "fit" | DensityIndex;

// ---------------------------------------------------------------------------
// P1-4d D51/D52 — automatic vertical fit. `computeFitScale` derives one
// scale factor from NATURAL (Standard, unscaled) row heights and the
// measured available height, in a single pass. It must never be called
// with heights that were themselves already produced by a previous
// `scaleDensity` call — that turns a single computation into a feedback
// loop that oscillates instead of converging (brief §3 item 3 / mutation
// M5). `scaleDensity` then produces a new `Density` with every numeric
// field multiplied by that factor and rounded to an integer pixel value.
// ---------------------------------------------------------------------------

/** D51: below this, a two-row board 600px tall is a worse board, not a better one. */
export const FIT_MIN = 0.75;
/** D51: above this, one tiny row stretched to fill a TV is a worse board too. */
export const FIT_MAX = 2.5;

/**
 * D51. `naturalHeights` are row heights at Standard, unscaled. Returns 1
 * when there is nothing to measure (no rows, or availableHeight <= 0) — a
 * board that has not been measured yet must render at its natural size,
 * never at a degenerate scale.
 */
export function computeFitScale(naturalHeights: number[], availableHeight: number): number {
  // NaN/Infinity guard, added by the design session's verification pass.
  // `Math.max(FIT_MIN, NaN)` is NaN and `<= 0` is false for NaN, so without
  // this an unmeasured or garbage input propagates a NaN scale into
  // `scaleDensity`, every row height becomes NaN, and the board renders
  // blank. Not reachable through today's call path (ResizeObserver always
  // reports finite numbers) — but this single number is what all board
  // geometry hangs off, so it is cheap insurance rather than a live fix.
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return 1;
  if (naturalHeights.length === 0) return 1;
  const naturalTotal = naturalHeights.reduce((sum, h) => sum + h, 0);
  if (!Number.isFinite(naturalTotal) || naturalTotal <= 0) return 1;
  const raw = availableHeight / naturalTotal;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(FIT_MAX, Math.max(FIT_MIN, raw));
}

/**
 * D52. Every numeric field of `base`, multiplied by `factor` and rounded to
 * an integer — row offsets are pixel positions, and a sub-pixel one blurs
 * every border on the board. `name` is preserved. Does not mutate `base`.
 * `scaleDensity(d, 1)` returns values equal to `d` for every field (every
 * field of every `DENSITIES` entry is already an integer, and rounding an
 * integer times 1 leaves it unchanged) — the Fit-off regression guard
 * (brief §6 case 1).
 */
export function scaleDensity(base: Density, factor: number): Density {
  return {
    name: base.name,
    laneHeight: Math.round(base.laneHeight * factor),
    laneTopOffset: Math.round(base.laneTopOffset * factor),
    groupRowHeight: Math.round(base.groupRowHeight * factor),
    bandTop: Math.round(base.bandTop * factor),
    bandHeight: Math.round(base.bandHeight * factor),
    rowPadBottom: Math.round(base.rowPadBottom * factor),
    chipHeight: Math.round(base.chipHeight * factor),
    avatarSize: Math.round(base.avatarSize * factor),
  };
}

// ---------------------------------------------------------------------------
// Pixel <-> minute conversion.
// ---------------------------------------------------------------------------

export function minutesToPx(minutes: number, pxPerHour: number): number {
  return (minutes / 60) * pxPerHour;
}

export function pxToMinutes(px: number, pxPerHour: number): number {
  return (px / pxPerHour) * 60;
}

// ---------------------------------------------------------------------------
// Lane packing — the mockup's `cellRow` greedy first-fit loop, extracted.
// ---------------------------------------------------------------------------

export function packLanes<T extends { startMin: number; endMin: number }>(
  items: T[],
): { laneOf: Map<T, number>; laneCount: number } {
  const laneEnds: number[] = [];
  const laneOf = new Map<T, number>();
  for (const item of items) {
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = item.endMin;
    laneOf.set(item, lane);
  }
  return { laneOf, laneCount: laneEnds.length };
}

/**
 * D44: `trackRowHeight` is density-aware. Mockup/pre-P1-4c formula at
 * Standard: `h = 36 + max(1, lanes) * 28 + 4` — that is exactly
 * `density.laneTopOffset + max(1, laneCount) * density.laneHeight +
 * density.rowPadBottom` evaluated at `DENSITIES[1]`.
 */
export function trackRowHeight(laneCount: number, density: Density): number {
  return density.laneTopOffset + Math.max(1, laneCount) * density.laneHeight + density.rowPadBottom;
}

// ---------------------------------------------------------------------------
// Virtualization primitives (NEW, D19 — hand-rolled, no measuring virtualizer).
// ---------------------------------------------------------------------------

export function buildRowOffsets(heights: number[]): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let total = 0;
  for (const h of heights) {
    offsets.push(total);
    total += h;
  }
  return { offsets, total };
}

/** First index `i` in `arr` such that `arr[i] > value` (arr assumed non-decreasing). */
function upperBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visibleRowRange(
  offsets: number[],
  total: number,
  scrollTop: number,
  viewportHeight: number,
  overscanRows: number,
): [number, number] {
  const n = offsets.length;
  if (n === 0 || viewportHeight <= 0) return [0, 0];

  const clampedScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, total - viewportHeight)));
  const viewportBottom = clampedScrollTop + viewportHeight;

  let first = upperBound(offsets, clampedScrollTop) - 1;
  if (first < 0) first = 0;
  let last = upperBound(offsets, viewportBottom);
  if (last > n) last = n;

  first = Math.max(0, first - overscanRows);
  last = Math.min(n, last + overscanRows);
  return [first, last];
}

export function visibleMinuteRange(
  scrollLeft: number,
  viewportWidth: number,
  pxPerHour: number,
  windowMinutes: number,
  overscanMinutes: number,
): [number, number] {
  if (viewportWidth <= 0) return [0, 0];
  const startMin = pxToMinutes(scrollLeft, pxPerHour) - overscanMinutes;
  const endMin = pxToMinutes(scrollLeft + viewportWidth, pxPerHour) + overscanMinutes;
  return [Math.max(0, startMin), Math.min(windowMinutes, endMin)];
}

export function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function clipToWindow(
  startMin: number,
  endMin: number,
  windowMinutes: number,
): { startMin: number; endMin: number } | null {
  if (endMin <= 0 || startMin >= windowMinutes) return null;
  return { startMin: Math.max(0, startMin), endMin: Math.min(windowMinutes, endMin) };
}

// ---------------------------------------------------------------------------
// Shift geometry (D15 — generalized from the mockup's fixed 3-day world).
// ---------------------------------------------------------------------------

export interface ShiftInstance {
  shift: Shift;
  startMin: number;
  endMin: number;
  rawStartMin: number;
  rawEndMin: number;
}

/**
 * Instantiate every shift of a template across day offsets `-1..dayCount`,
 * clipped to `[0, windowMinutes]`. D15: the `-1` is load-bearing (lets a
 * previous day's overnight shift tail show up on the first rendered
 * morning) and so, per the brief, is running one iteration past the last
 * day — though for any template with `startMin >= 0` (guaranteed by the
 * DB schema) that final iteration can never actually contribute an
 * instance, since its raw start always lands at or past `windowMinutes`.
 */
export function shiftInstances(t: ShiftTemplate, dayCount: number): ShiftInstance[] {
  const windowMinutes = dayCount * MINUTES_PER_DAY;
  const out: ShiftInstance[] = [];
  for (const sh of t.shifts) {
    for (let day = -1; day <= dayCount; day++) {
      const off = day * MINUTES_PER_DAY;
      const rawStartMin = off + sh.startMin;
      const rawEndMin = off + sh.endMin;
      if (rawEndMin <= 0 || rawStartMin >= windowMinutes) continue;
      out.push({
        shift: sh,
        startMin: Math.max(0, rawStartMin),
        endMin: Math.min(windowMinutes, rawEndMin),
        rawStartMin,
        rawEndMin,
      });
    }
  }
  return out;
}

export interface BreakInstance {
  shiftBreak: ShiftBreak;
  shift: Shift;
  startMin: number;
  endMin: number;
}

export function breakInstances(t: ShiftTemplate, dayCount: number): BreakInstance[] {
  const windowMinutes = dayCount * MINUTES_PER_DAY;
  const out: BreakInstance[] = [];
  for (const sh of t.shifts) {
    for (const br of sh.breaks) {
      for (let day = -1; day <= dayCount; day++) {
        const off = day * MINUTES_PER_DAY;
        const rawStart = off + br.startMin;
        const rawEnd = off + br.endMin;
        if (rawEnd <= 0 || rawStart >= windowMinutes) continue;
        out.push({
          shiftBreak: br,
          shift: sh,
          startMin: Math.max(0, rawStart),
          endMin: Math.min(windowMinutes, rawEnd),
        });
      }
    }
  }
  return out;
}

/** Every shift start/end instant across all rendered days — Compact-zoom snapping. */
export function shiftSnapPoints(t: ShiftTemplate, dayCount: number): number[] {
  const windowMinutes = dayCount * MINUTES_PER_DAY;
  const out = new Set<number>();
  for (const sh of t.shifts) {
    for (let day = -1; day <= dayCount; day++) {
      const s = day * MINUTES_PER_DAY + sh.startMin;
      const e = day * MINUTES_PER_DAY + sh.endMin;
      if (s >= 0 && s <= windowMinutes) out.add(s);
      if (e >= 0 && e <= windowMinutes) out.add(e);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Boundary lines: shift starts + ends, deduped, skipping any that coincide
 * with a day boundary. `m % 1440 !== 0` generalizes the mockup's
 * `s !== 1440 && s !== 2880`, and — because `windowMinutes` is itself
 * always a multiple of 1440 — the same test also excludes `m === 0` and
 * `m === windowMinutes`, so no separate check is needed for the window
 * edges.
 */
export function shiftBoundaries(t: ShiftTemplate, dayCount: number): number[] {
  const windowMinutes = dayCount * MINUTES_PER_DAY;
  const out = new Set<number>();
  for (const sh of t.shifts) {
    for (let day = -1; day <= dayCount; day++) {
      const s = day * MINUTES_PER_DAY + sh.startMin;
      const e = day * MINUTES_PER_DAY + sh.endMin;
      if (s >= 0 && s <= windowMinutes && s % MINUTES_PER_DAY !== 0) out.add(s);
      if (e >= 0 && e <= windowMinutes && e % MINUTES_PER_DAY !== 0) out.add(e);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Gaps not covered by any shift instance -> off-shift wash. Merges overlapping instances first. */
export function offShiftGaps(t: ShiftTemplate, dayCount: number): number[][] {
  const windowMinutes = dayCount * MINUTES_PER_DAY;
  const insts = shiftInstances(t, dayCount)
    .map((x): [number, number] => [x.startMin, x.endMin])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of insts) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  const gaps: number[][] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < windowMinutes) gaps.push([cursor, windowMinutes]);
  return gaps;
}

// ---------------------------------------------------------------------------
// Derived board facts.
// ---------------------------------------------------------------------------

/** sum(efficiency) over a run's assignments — the mockup's effHC, but in DB units (fractions, not percent). */
export function effectiveHeadcount(assignments: { efficiency: number }[]): number {
  return assignments.reduce((sum, a) => sum + a.efficiency, 0);
}

/** `false` when `plannedHeadcount` is null — "no plan" is not "understaffed". */
export function isUnderstaffed(effectiveHc: number, plannedHeadcount: number | null): boolean {
  if (plannedHeadcount === null) return false;
  return effectiveHc < plannedHeadcount;
}

/**
 * Generalization of the mockup's `isFullyAllocated`: instead of a
 * hardcoded Tue 06:00-22:00 test window, this takes the loaded board
 * window (`[0, windowMinutes)`) and a capacity fraction (`cap`, e.g.
 * `1.0`) instead of the mockup's hardcoded `100`. An operator is fully
 * allocated when they have at least one assignment intersecting the
 * window and their instantaneous load is `>= cap` at every instant across
 * the union of their assignments, with no gaps.
 */
export function isFullyAllocated<
  T extends { startMin: number; endMin: number; efficiency: number },
>(assignments: T[], windowMinutes: number, cap: number): boolean {
  const WS = 0;
  const WE = windowMinutes;
  const mine = assignments.filter((a) => a.startMin < WE && a.endMin > WS);
  if (mine.length === 0) return false;

  const bounds = new Set<number>([WS, WE]);
  for (const a of mine) {
    if (a.startMin > WS && a.startMin < WE) bounds.add(a.startMin);
    if (a.endMin > WS && a.endMin < WE) bounds.add(a.endMin);
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i];
    const load = mine.reduce(
      (sum, a) => sum + (a.startMin <= t0 && t0 < a.endMin ? a.efficiency : 0),
      0,
    );
    if (load < cap) return false;
  }
  return true;
}
