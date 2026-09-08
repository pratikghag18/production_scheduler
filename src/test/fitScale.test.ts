import { describe, expect, it } from "vitest";
import {
  computeFitScale,
  scaleDensity,
  FIT_MIN,
  FIT_MAX,
  DENSITIES,
} from "@/features/board/lib/geometry";

/**
 * R-056: "fitScale is the available height divided by the natural Standard
 * height, clamped to 0.75-2.5, computed in one pass from unscaled heights.
 * Every density field is rounded to an integer, NaN and Infinity are
 * guarded, a chip always fits its lane and an avatar its chip."
 *
 * `computeFitScale` and `scaleDensity` (geometry.ts) were genuinely
 * untested before this: scaleAudit.test.ts only lints which CSS files
 * reference --ui-scale, it never calls either function.
 */
describe("computeFitScale (R-056)", () => {
  it("F1: divides available height by the natural total, unclamped in range", () => {
    // natural total 100, available 150 -> raw 1.5, inside [0.75, 2.5]
    expect(computeFitScale([40, 60], 150)).toBe(1.5);
  });

  it("F2: clamps to FIT_MIN when the raw ratio is below it", () => {
    // natural total 1000, available 100 -> raw 0.1, clamped up to 0.75
    expect(computeFitScale([1000], 100)).toBe(FIT_MIN);
  });

  it("F3: clamps to FIT_MAX when the raw ratio is above it", () => {
    // natural total 10, available 1000 -> raw 100, clamped down to 2.5
    expect(computeFitScale([10], 1000)).toBe(FIT_MAX);
  });

  it("F4: an empty naturalHeights array returns 1 (nothing to measure)", () => {
    expect(computeFitScale([], 500)).toBe(1);
  });

  it("F5: availableHeight <= 0 returns 1 (unmeasured, never a degenerate scale)", () => {
    expect(computeFitScale([40, 60], 0)).toBe(1);
    expect(computeFitScale([40, 60], -10)).toBe(1);
  });

  it("F6: a NaN availableHeight returns 1, not NaN", () => {
    expect(computeFitScale([40, 60], NaN)).toBe(1);
  });

  it("F7: an Infinity availableHeight returns 1, not Infinity", () => {
    expect(computeFitScale([40, 60], Infinity)).toBe(1);
  });

  it("F8: a NaN entry in naturalHeights makes the total non-finite, returns 1", () => {
    expect(computeFitScale([40, NaN], 150)).toBe(1);
  });

  it("F9: the exact FIT_MIN/FIT_MAX boundary values pass through unclamped", () => {
    // total 100, available 75 -> raw exactly 0.75
    expect(computeFitScale([100], 75)).toBe(FIT_MIN);
    // total 100, available 250 -> raw exactly 2.5
    expect(computeFitScale([100], 250)).toBe(FIT_MAX);
  });
});

describe("scaleDensity (R-056)", () => {
  const STANDARD = DENSITIES[1];

  it("F10: factor 1 is the identity — the Fit-off regression guard", () => {
    expect(scaleDensity(STANDARD, 1)).toEqual(STANDARD);
  });

  it("F11: every numeric field is multiplied and rounded to an integer", () => {
    const scaled = scaleDensity(STANDARD, 1.5);
    expect(scaled.laneHeight).toBe(Math.round(STANDARD.laneHeight * 1.5));
    expect(scaled.chipHeight).toBe(Math.round(STANDARD.chipHeight * 1.5));
    expect(scaled.avatarSize).toBe(Math.round(STANDARD.avatarSize * 1.5));
    expect(Number.isInteger(scaled.laneHeight)).toBe(true);
    expect(Number.isInteger(scaled.chipHeight)).toBe(true);
    expect(Number.isInteger(scaled.avatarSize)).toBe(true);
  });

  it("F12: name is preserved and the input is not mutated", () => {
    const before = { ...STANDARD };
    const scaled = scaleDensity(STANDARD, 2);
    expect(scaled.name).toBe(STANDARD.name);
    expect(STANDARD).toEqual(before);
  });

  it("F13: a chip fits its lane and an avatar fits its chip at every clamp boundary and every named density", () => {
    for (const factor of [FIT_MIN, 1, FIT_MAX]) {
      for (const density of DENSITIES) {
        const d = scaleDensity(density, factor);
        expect(d.chipHeight).toBeLessThanOrEqual(d.laneHeight);
        expect(d.avatarSize).toBeLessThanOrEqual(d.chipHeight);
      }
    }
  });
});
