import { describe, expect, it } from "vitest";
import type { ShiftTemplate } from "@/lib/api";
import {
  ZOOMS,
  DENSITIES,
  minutesToPx,
  pxToMinutes,
  packLanes,
  trackRowHeight,
  buildRowOffsets,
  visibleRowRange,
  visibleMinuteRange,
  intersects,
  clipToWindow,
  shiftInstances,
  offShiftGaps,
  shiftBoundaries,
  effectiveHeadcount,
  isUnderstaffed,
  isFullyAllocated,
} from "@/features/board/lib/geometry";

/**
 * §12 cases 4-13, ported to Vitest — including the two supplementary cases
 * (11f, 12d) added after mutation testing showed the brief's own case 11 /
 * case 12 assertions could not distinguish M6 / M4 from correct behaviour.
 * See the agent report's "assumptions" section for the full explanation.
 * Authored, not run in this container (no npm) — the /tmp/harness copy of
 * this exact code was executed and mutation-tested (see the agent report).
 *
 * P1-4c addendum: `trackRowHeight` now takes a `Density` — every call below
 * passes `DENSITIES[1]` (Standard), which reproduces the pre-P1-4c
 * hardcoded constants exactly (brief §3/§8 case 1), so these assertions'
 * expected numbers are unchanged from before this brief.
 */

const t38: ShiftTemplate = {
  id: "t38",
  name: "3 x 8h",
  shifts: [
    { id: "s1", name: "Shift 1", startMin: 360, endMin: 840, breaks: [] },
    { id: "s2", name: "Shift 2", startMin: 840, endMin: 1320, breaks: [] },
    { id: "s3", name: "Shift 3", startMin: 1320, endMin: 1800, breaks: [] }, // 22:00-06:00, wraps
  ],
};
const t210: ShiftTemplate = {
  id: "t210",
  name: "2 x 10h",
  shifts: [
    { id: "d", name: "Days", startMin: 360, endMin: 960, breaks: [] },
    { id: "n", name: "Nights", startMin: 960, endMin: 1560, breaks: [] }, // 16:00-02:00, wraps
  ],
};

describe("geometry.ts", () => {
  it("minutesToPx / pxToMinutes round-trip at all three zooms (case 4)", () => {
    expect(minutesToPx(60, 104)).toBe(104);
    expect(pxToMinutes(104, 104)).toBe(60);
    for (const z of ZOOMS) {
      expect(pxToMinutes(minutesToPx(123, z.pxPerHour), z.pxPerHour)).toBeCloseTo(123, 9);
    }
  });

  it("lane packing: half-open ranges do not collide (case 5)", () => {
    const items = [
      { id: "a", startMin: 360, endMin: 840 }, // 06:00-14:00
      { id: "b", startMin: 360, endMin: 600 }, // 06:00-10:00
      { id: "c", startMin: 600, endMin: 840 }, // 10:00-14:00
    ];
    const { laneOf, laneCount } = packLanes(items);
    expect(laneCount).toBe(2);
    expect(laneOf.get(items[1])).toBe(laneOf.get(items[2])); // b and c share a lane
  });

  it("trackRowHeight(0) === trackRowHeight(1) (max(1, lanes) floor) (case 6)", () => {
    expect(trackRowHeight(0, DENSITIES[1])).toBe(trackRowHeight(1, DENSITIES[1]));
  });

  it("P1-4c: trackRowHeight(1, Standard) reproduces the pre-brief constant exactly", () => {
    expect(trackRowHeight(1, DENSITIES[1])).toBe(68); // 36 + 1*28 + 4
  });

  it("P1-4c: Comfortable > Standard > Compact for the same lane count", () => {
    for (const lanes of [1, 2, 5]) {
      expect(trackRowHeight(lanes, DENSITIES[0])).toBeGreaterThan(
        trackRowHeight(lanes, DENSITIES[1]),
      );
      expect(trackRowHeight(lanes, DENSITIES[1])).toBeGreaterThan(
        trackRowHeight(lanes, DENSITIES[2]),
      );
    }
  });

  it("shiftInstances produces a day -1 tail (case 7)", () => {
    const insts = shiftInstances(t38, 3);
    const tail = insts.find((i) => i.shift.id === "s3" && i.rawStartMin < 0);
    expect(tail).toBeDefined();
    expect(tail?.startMin).toBe(0);
    expect(tail && tail.rawStartMin < 0).toBe(true);
  });

  it("offShiftGaps: 3x8h has no interior gap, 2x10h has one 240min gap per day (case 8)", () => {
    expect(offShiftGaps(t38, 3)).toEqual([]);
    const gaps = offShiftGaps(t210, 3);
    expect(gaps.length).toBeGreaterThan(0);
    for (const [s, e] of gaps) expect(e - s).toBe(240);
  });

  it("shiftBoundaries has no multiple of 1440 and no window edge (case 9)", () => {
    const windowMinutes = 3 * 1440;
    const bounds = shiftBoundaries(t38, 3);
    expect(bounds.every((m) => m % 1440 !== 0)).toBe(true);
    expect(bounds).not.toContain(0);
    expect(bounds).not.toContain(windowMinutes);
  });

  it("clipToWindow: null before the window, clips a straddling range (case 10)", () => {
    expect(clipToWindow(-500, -10, 4320)).toBeNull();
    expect(clipToWindow(-100, 100, 4320)).toEqual({ startMin: 0, endMin: 100 });
  });

  it("visibleRowRange covers the viewport at both edges, empty at height 0 (case 11)", () => {
    const heights = Array.from({ length: 500 }, (_, i) => 20 + (i % 5) * 10);
    const { offsets, total } = buildRowOffsets(heights);
    const viewportHeight = 400;

    const [f0] = visibleRowRange(offsets, total, 0, viewportHeight, 4);
    expect(f0).toBe(0);

    const [fB, lB] = visibleRowRange(offsets, total, total - viewportHeight, viewportHeight, 4);
    expect(lB).toBe(500);
    expect(fB).toBeLessThan(lB);

    const [fE, lE] = visibleRowRange(offsets, total, 0, 0, 4);
    expect(fE).toBe(0);
    expect(lE).toBe(0);
  });

  it("visibleRowRange includes the overscan margin on both sides (case 11f)", () => {
    const heights = new Array(20).fill(10);
    const { offsets, total } = buildRowOffsets(heights);
    // scrollTop=100 (row 10), viewportHeight=50 -> strict [10,16); overscan 2 -> [8,18)
    const [f, l] = visibleRowRange(offsets, total, 100, 50, 2);
    expect([f, l]).toEqual([8, 18]);
  });

  it("visibleMinuteRange clamps to [0, windowMinutes] with overscan", () => {
    const [s, e] = visibleMinuteRange(0, 400, 104, 4320, 240);
    expect(s).toBe(0);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThanOrEqual(4320);
  });

  it("intersects treats ranges as half-open", () => {
    expect(intersects(0, 10, 10, 20)).toBe(false); // touching, not overlapping
    expect(intersects(0, 10, 9, 20)).toBe(true);
  });

  it("effectiveHeadcount / isUnderstaffed (case 12)", () => {
    expect(effectiveHeadcount([{ efficiency: 0.5 }, { efficiency: 0.5 }])).toBe(1);
    expect(isUnderstaffed(1, 2)).toBe(true);
    expect(isUnderstaffed(1, null)).toBe(false);
  });

  it("isUnderstaffed(-1, null) === false — distinguishes null-short-circuit from null-as-0 (case 12d)", () => {
    expect(isUnderstaffed(-1, null)).toBe(false);
  });

  it("isFullyAllocated (case 13)", () => {
    const windowMinutes = 4320;
    expect(
      isFullyAllocated(
        [{ startMin: 0, endMin: windowMinutes, efficiency: 1.0 }],
        windowMinutes,
        1.0,
      ),
    ).toBe(true);
    expect(
      isFullyAllocated(
        [{ startMin: 0, endMin: windowMinutes - 1, efficiency: 1.0 }],
        windowMinutes,
        1.0,
      ),
    ).toBe(false);
    expect(
      isFullyAllocated(
        [
          { startMin: 0, endMin: windowMinutes, efficiency: 0.5 },
          { startMin: 0, endMin: windowMinutes, efficiency: 0.5 },
        ],
        windowMinutes,
        1.0,
      ),
    ).toBe(true);
  });
});
