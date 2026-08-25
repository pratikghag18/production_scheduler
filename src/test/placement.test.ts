import { describe, expect, it } from "vitest";
import {
  resolvePopoverPlacement,
  DEFAULT_MARGIN,
  DEFAULT_GAP,
} from "@/features/board/lib/placement";
import type { PlacementInput } from "@/features/board/lib/placement";

/**
 * Brief P1-5c §8 group P (16 assertions) for `resolvePopoverPlacement`
 * (design plan §19.11). This is the regression test for the debt the brief
 * closes: the shipped code was `Math.min(anchor.x, innerWidth - width - 10)`
 * -- a ONE-SIDED clamp that goes negative on a viewport narrower than the
 * popover plus its margins. P3/P4/P7/P8 below exist for exactly that.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed and mutation-tested against all 15 of the
 * brief's §9 mutations (M1-M8) before this file was written. See the agent
 * report for the full run and the one deliberate strengthening of P6 (an
 * exact-value assertion alongside the ordering check, so a dropped margin
 * cannot hide behind two numbers that happen to stay correctly ordered).
 */

function place(overrides: Partial<PlacementInput>): PlacementInput {
  return {
    anchorX: 0,
    anchorY: 0,
    width: 272,
    height: 200,
    viewportWidth: 1200,
    viewportHeight: 800,
    ...overrides,
  };
}

describe("placement.ts: resolvePopoverPlacement", () => {
  // Table-driven: every case here is "given this input, expect this exact
  // {left, top}" -- the uniform shape the brief asks group P to use.
  const cases: Array<{
    name: string;
    input: Partial<PlacementInput>;
    expected: { left: number; top: number };
  }> = [
    {
      name: "P1: well inside — gap applied, no clamp",
      input: { anchorX: 100, anchorY: 100 },
      expected: { left: 100, top: 108 },
    },
    {
      name: "P2: right edge clamps down",
      input: { anchorX: 1150, anchorY: 100, width: 272, viewportWidth: 1200 },
      expected: { left: 1200 - 272 - DEFAULT_MARGIN, top: 108 },
    },
    {
      name: "P3: left edge clamped up (non-degenerate)",
      input: { anchorX: -50, anchorY: 100, width: 272, viewportWidth: 1200 },
      expected: { left: DEFAULT_MARGIN, top: 108 },
    },
    {
      name: "P4: viewport narrower than the box pins to margin, never negative",
      input: { anchorX: -9999, anchorY: 100, width: 272, viewportWidth: 200 },
      expected: { left: DEFAULT_MARGIN, top: 108 },
    },
    {
      name: "P7: viewport shorter than the box pins to margin",
      input: { anchorX: 0, anchorY: 50, height: 350, viewportHeight: 100 },
      expected: { left: DEFAULT_MARGIN, top: DEFAULT_MARGIN },
    },
    {
      name: "P8: negative anchorY clamps up (non-degenerate)",
      input: { anchorX: 0, anchorY: -100, height: 200 },
      expected: { left: DEFAULT_MARGIN, top: DEFAULT_MARGIN },
    },
    {
      name: "P9: unknown viewport (0) passes through unclamped",
      input: { anchorX: -50, anchorY: -50, viewportWidth: 0, viewportHeight: 800 },
      expected: { left: -50, top: -42 },
    },
    {
      name: "P10: NaN viewport passes through unclamped",
      input: { anchorX: 10, anchorY: 10, viewportWidth: NaN, viewportHeight: 800 },
      expected: { left: 10, top: 18 },
    },
    {
      name: "P12: unmeasured width (0) still clamps to the edge, not a hardcoded 272",
      input: { anchorX: 2000, anchorY: 100, width: 0, viewportWidth: 1200 },
      expected: { left: 1200 - 0 - DEFAULT_MARGIN, top: 108 },
    },
    {
      name: "P13: custom margin on both axes",
      input: { anchorX: 2000, anchorY: 2000, width: 272, height: 200, margin: 30 },
      expected: { left: 1200 - 272 - 30, top: 800 - 200 - 30 },
    },
    {
      name: "P14: custom gap shifts only the vertical desired position",
      input: { anchorX: 100, anchorY: 100, gap: 20 },
      expected: { left: 100, top: 120 },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(resolvePopoverPlacement(place(input))).toEqual(expected);
  });

  it("P5: bottom edge uses the MEASURED height, not the shipped hardcoded 420", () => {
    const p = resolvePopoverPlacement(
      place({ anchorX: 0, anchorY: 760, height: 350, viewportHeight: 800 }),
    );
    // 800 - 350 - 10 = 440. A hardcoded 420 would give 800 - 420 - 10 = 370.
    expect(p.top).toBe(440);
  });

  it("P6: a taller popover is pulled further up — proves height is not hardcoded", () => {
    const short = resolvePopoverPlacement(
      place({ anchorX: 0, anchorY: 760, height: 200, viewportHeight: 800 }),
    );
    const tall = resolvePopoverPlacement(
      place({ anchorX: 0, anchorY: 760, height: 400, viewportHeight: 800 }),
    );
    expect(tall.top).toBeLessThan(short.top);
    // Exact values too, not just ordering: an ordering-only check cannot
    // tell "the margin was forgotten" from "the height is respected" --
    // dropping the margin shifts both numbers by the same amount and the
    // ordering survives either way.
    expect(short.top).toBe(800 - 200 - DEFAULT_MARGIN);
    expect(tall.top).toBe(800 - 400 - DEFAULT_MARGIN);
  });

  it("P11: a scaled width changes the right-edge answer", () => {
    const base = resolvePopoverPlacement(
      place({ anchorX: 2000, anchorY: 0, width: 272, viewportWidth: 1200 }),
    );
    const scaled = resolvePopoverPlacement(
      place({ anchorX: 2000, anchorY: 0, width: 340, viewportWidth: 1200 }),
    );
    expect(base.left).not.toBe(scaled.left);
    expect(base.left).toBe(1200 - 272 - DEFAULT_MARGIN);
    expect(scaled.left).toBe(1200 - 340 - DEFAULT_MARGIN);
  });

  it("P15: the two default constants", () => {
    expect(DEFAULT_MARGIN).toBe(10);
    expect(DEFAULT_GAP).toBe(8);
  });

  it("P16: PROPERTY — input is not mutated", () => {
    const input = place({ anchorX: 5, anchorY: 5 });
    const snapshot = JSON.stringify(input);
    resolvePopoverPlacement(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * P17-P24 — design-session verification, added after the build (P1-5c review).
 *
 * The §8 table probed WRONG-but-well-formed inputs and never a MALFORMED one
 * (verification-standard rule 4, the same gap that produced P1-5a's
 * `delete_node(id, NULL)` and P1-5b's throwing `validateLevelDraft`).
 *
 * `resolvePopoverPlacement` sanitised three of its five numeric inputs --
 * `width`, `height` and both viewport dimensions -- and not the anchor,
 * `margin` or `gap`. NaN survives both `Math.max` and `Math.min`, so it
 * reached the DOM as `left: NaNpx`; the browser discards that, and a
 * `position: fixed` popover then renders at its STATIC position instead of
 * being clamped on screen -- the exact failure this module exists to prevent.
 * Reverting the fix fails P17, P18, P21 and P22 by name.
 */
describe("resolvePopoverPlacement — malformed numeric input", () => {
  it("P17: a NaN anchorX yields a finite left, pinned to the margin", () => {
    const { left } = resolvePopoverPlacement(place({ anchorX: Number.NaN }));
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBe(DEFAULT_MARGIN);
  });

  it("P18: a NaN anchorY yields a finite top, pinned to the margin", () => {
    const { top } = resolvePopoverPlacement(place({ anchorY: Number.NaN }));
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBe(DEFAULT_MARGIN);
  });

  it("P19: +Infinity anchorX still clamps to the right edge", () => {
    expect(resolvePopoverPlacement(place({ anchorX: Number.POSITIVE_INFINITY })).left).toBe(
      1200 - 272 - DEFAULT_MARGIN,
    );
  });

  it("P20: -Infinity anchorX still clamps up to the margin", () => {
    expect(resolvePopoverPlacement(place({ anchorX: Number.NEGATIVE_INFINITY })).left).toBe(
      DEFAULT_MARGIN,
    );
  });

  it("P21: a NaN margin falls back to the default rather than propagating", () => {
    const { left } = resolvePopoverPlacement(place({ anchorX: 99999, margin: Number.NaN }));
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBe(1200 - 272 - DEFAULT_MARGIN);
  });

  it("P22: a NaN gap falls back to the default rather than propagating", () => {
    const { top } = resolvePopoverPlacement(place({ anchorY: 100, gap: Number.NaN }));
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBe(100 + DEFAULT_GAP);
  });

  it("P23: an explicit ZERO margin is honoured, not replaced by the default", () => {
    expect(resolvePopoverPlacement(place({ anchorX: 99999, margin: 0 })).left).toBe(1200 - 272);
  });

  it("P24: an explicit ZERO gap is honoured, not replaced by the default", () => {
    expect(resolvePopoverPlacement(place({ anchorY: 100, gap: 0 })).top).toBe(100);
  });
});
