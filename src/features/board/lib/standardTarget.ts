/**
 * THE ONE PLACE THE DERIVED TARGET IS COMPUTED (R-316).
 *
 * The maintainer, 3 Sept: "how much product can be made based on (how much time
 * a person is assigned - breaks) / standard cycle time. This will become the
 * default target for that assignment. This however can be overwritten by the
 * already present mechanism."
 *
 * So: an assignment that carries no explicit `targetQty` shows a number derived
 * from the time it covers, minus the breaks falling inside it, scaled by its
 * efficiency, divided by the cell's standard seconds-per-unit for that product.
 * An explicit `targetQty` always wins and is never touched — `normalizeTarget`
 * in `TargetField.tsx` remains the only thing that decides what gets SAVED, and
 * this module only decides what gets SHOWN when nothing was saved.
 *
 * NOTHING HERE IS STORED. The derived number is recomputed on every render,
 * which is the whole reason it can be trusted: drag a block, resize it, edit a
 * break, re-point a cell's shift pattern, and the number is already right. A
 * stored default would need every one of those to rewrite rows.
 *
 * NO CYCLE TIME MEANS NO DEFAULT, never a zero and never a guess (the
 * maintainer: "This should not be mandatory... When no cycle time are defined,
 * the target for the assignment is null."). Every entry point returns null for
 * a missing or non-positive cycle time, and the chip then renders "target: NA"
 * exactly as it did before this feature existed.
 *
 * ⚠️ WHY THIS DOES NOT USE `breakInstances` FROM ./geometry. That function tiles
 * breaks for RENDERING: it needs a `dayCount`, and it CLIPS every instance to
 * [0, windowMinutes]. Neither suits arithmetic here. An assignment can begin
 * before the window starts (`boardIndex` keeps a negative `startMin` for a block
 * that straddles the left edge), and the create popover asks about a candidate
 * range that is not on the board yet and has no dayCount in scope. Clipping
 * would also silently shorten a break at a window edge and inflate the target.
 * So this module tiles its own, unclipped, from the range itself.
 */
import type { CycleTime, ShiftTemplate } from "@/lib/api";

const MINUTES_PER_DAY = 1440;

/**
 * Does the assignment's efficiency scale the derived default? The maintainer
 * chose yes (3 Sept): efficiency is "the share of this person on this cell", so
 * someone split 50/50 across two cells is expected to make half as much at
 * each. Named rather than inlined because it is a policy, not a fact.
 */
export const APPLY_EFFICIENCY = true;

/**
 * Whole units once at least one is achievable, one decimal below that.
 *
 * The maintainer's case for the decimal: "There could be products which have
 * very large cycle time, often more than the shift itself." Flooring those to 0
 * would say "this shift achieves nothing", when the useful reading is "this
 * shift gets you 0.7 of the way through one". Above 1 the floor is right —
 * a part is finished or it is not, so 1.9 units means 1 unit made.
 */
export function roundTarget(raw: number): number {
  if (raw >= 1) return Math.floor(raw);
  // A positive raw never rounds away to nothing: 0.02 of a unit is still
  // progress, and 0 would read as "impossible" rather than "barely started".
  return Math.max(0.1, Math.round(raw * 10) / 10);
}

/** Minutes since the board window's start; `startMin` may be negative. */
export interface MinuteRange {
  startMin: number;
  endMin: number;
}

/**
 * Every break of the template, tiled across the days this range could touch,
 * in the same minutes-since-window-start coordinates as the range. Unclipped.
 *
 * The scan starts two days early because a break's minute offset is measured
 * from its shift's own day origin and an overnight shift carries offsets past
 * 1440 (the seed's third shift breaks at 1440-1455, i.e. after midnight), so a
 * break belonging to "yesterday" can land inside today's range. It ends at the
 * range's own last day: offsets are never negative, so a later day's break
 * cannot start before the range ends.
 */
export function breakRangesAround(
  template: ShiftTemplate | null,
  range: MinuteRange,
): MinuteRange[] {
  if (!template) return [];
  const dayFrom = Math.floor(range.startMin / MINUTES_PER_DAY) - 2;
  const dayTo = Math.floor(range.endMin / MINUTES_PER_DAY);
  const out: MinuteRange[] = [];
  for (const shift of template.shifts) {
    for (const br of shift.breaks) {
      for (let day = dayFrom; day <= dayTo; day++) {
        const off = day * MINUTES_PER_DAY;
        out.push({ startMin: off + br.startMin, endMin: off + br.endMin });
      }
    }
  }
  return out;
}

/**
 * Minutes of `range` covered by any of `blocks`.
 *
 * Blocks are MERGED first. Two shifts may schedule overlapping breaks, and the
 * same wall-clock minute must not be subtracted twice — double-counting would
 * quietly deflate the target rather than fail.
 */
export function overlapMinutes(range: MinuteRange, blocks: readonly MinuteRange[]): number {
  if (blocks.length === 0) return 0;
  const sorted = [...blocks]
    .filter((b) => b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin);
  let total = 0;
  let cursor: MinuteRange | null = null;
  for (const block of sorted) {
    if (cursor && block.startMin <= cursor.endMin) {
      cursor = { startMin: cursor.startMin, endMin: Math.max(cursor.endMin, block.endMin) };
      continue;
    }
    if (cursor) total += clippedLength(range, cursor);
    cursor = { startMin: block.startMin, endMin: block.endMin };
  }
  if (cursor) total += clippedLength(range, cursor);
  return total;
}

function clippedLength(range: MinuteRange, block: MinuteRange): number {
  return Math.max(
    0,
    Math.min(range.endMin, block.endMin) - Math.max(range.startMin, block.startMin),
  );
}

/** The working minutes of a range: its length less the breaks inside it. */
export function netMinutes(range: MinuteRange, template: ShiftTemplate | null): number {
  const gross = range.endMin - range.startMin;
  if (gross <= 0) return 0;
  return Math.max(0, gross - overlapMinutes(range, breakRangesAround(template, range)));
}

/**
 * The derived default target, or null when there is none to derive.
 *
 * Null — not zero — whenever the cycle time is missing or non-positive, or the
 * range leaves no working time. Zero would render as a target of nothing;
 * null renders as "no target", which is the truth.
 */
export function standardTargetQty(input: {
  range: MinuteRange;
  template: ShiftTemplate | null;
  efficiencyPercent: number;
  secondsPerUnit: number | null | undefined;
}): number | null {
  const { range, template, efficiencyPercent, secondsPerUnit } = input;
  if (secondsPerUnit == null || !Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) {
    return null;
  }
  const net = netMinutes(range, template);
  if (net <= 0) return null;
  const efficiency = APPLY_EFFICIENCY ? efficiencyPercent / 100 : 1;
  if (!Number.isFinite(efficiency) || efficiency <= 0) return null;
  return roundTarget((net * 60 * efficiency) / secondsPerUnit);
}

/** The (node, product) key both the board index and the popovers look up by. */
export function cycleTimeKey(nodeId: string, productId: string): string {
  return `${nodeId}|${productId}`;
}

export function buildCycleTimeIndex(rows: readonly CycleTime[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(cycleTimeKey(row.nodeId, row.productId), row.secondsPerUnit);
  }
  return out;
}
