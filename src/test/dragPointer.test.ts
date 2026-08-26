/**
 * Acceptance for `src/features/admin/lib/dragPointer.ts` (brief P1-5l §7).
 *
 * A VITEST suite, not a standalone `--experimental-strip-types` script with its
 * own runner: `npm run test` is what guards this permanently, and a script that
 * passes when you run it by hand can still fail COLLECTION under vitest — that
 * has happened on this project, and the tell nobody read was a test count that
 * did not move.
 *
 * 19 plain `it()` cases — no `it.each`, no dynamic registration, no loops — so
 * the number vitest reports for this file is literally the count of `it(` lines
 * below.
 */
import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX } from "../lib/interaction.ts";
import {
  offsetInRow,
  passedThreshold,
  rowIsDragSource,
} from "../features/admin/lib/dragPointer.ts";

/** One origin for every distance case, so only the movement varies. */
const O = { x: 100, y: 100 };

describe("dragPointer.ts — passedThreshold: distance", () => {
  it("T1: no movement does not pass a 4px threshold", () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(passedThreshold(O, 100, 100, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T2: 3px in x alone does not pass", () => {
    expect(passedThreshold(O, 103, 100, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T3: 4px in x alone passes", () => {
    // The boundary is INCLUSIVE. Mutation U2 (`>=` -> `>`) dies here.
    expect(passedThreshold(O, 104, 100, DRAG_THRESHOLD_PX)).toBe(true);
  });

  it("T4: 5px in x alone passes", () => {
    expect(passedThreshold(O, 105, 100, DRAG_THRESHOLD_PX)).toBe(true);
  });

  it("T5: 3px in x AND 3px in y passes — 4.24px, the case per-axis comparisons get wrong", () => {
    // ⭐ THE CASE THE WHOLE FUNCTION EXISTS FOR. Two per-axis comparisons
    // (mutation U1) both see 3 < 4 and refuse a gesture that has travelled
    // 4.2426px. Euclidean distance is not an optimisation here, it is the
    // difference between a diagonal drag working and not existing.
    expect(Math.hypot(3, 3)).toBeGreaterThan(DRAG_THRESHOLD_PX);
    expect(passedThreshold(O, 103, 103, DRAG_THRESHOLD_PX)).toBe(true);
  });

  it("T6: 2px in x and 2px in y does not pass — 2.83px", () => {
    // The other side of T5: a diagonal that is genuinely short still refuses,
    // so T5 is not passing because the function says yes to everything.
    expect(passedThreshold(O, 102, 102, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T7: negative movement passes on magnitude, not sign", () => {
    expect(passedThreshold(O, 96, 100, DRAG_THRESHOLD_PX)).toBe(true);
    expect(passedThreshold(O, 100, 96, DRAG_THRESHOLD_PX)).toBe(true);
    expect(passedThreshold(O, 97, 97, DRAG_THRESHOLD_PX)).toBe(true);
  });
});

describe("dragPointer.ts — passedThreshold: unmeasurable pointers", () => {
  it("T8: a NaN x returns false", () => {
    expect(passedThreshold(O, Number.NaN, 100, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T9: a NaN y returns false", () => {
    expect(passedThreshold(O, 100, Number.NaN, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T10: an Infinite coordinate returns false", () => {
    // ⭐ THIS is the case that kills mutation U3, and T8/T9 cannot. A NaN
    // coordinate propagates through `hypot` and the comparison is false with or
    // without the guard; an infinite one gives `hypot === Infinity`, which
    // passes every threshold, so only this fixture can see the guard at all.
    expect(passedThreshold(O, Number.POSITIVE_INFINITY, 100, DRAG_THRESHOLD_PX)).toBe(false);
    expect(passedThreshold(O, 100, Number.NEGATIVE_INFINITY, DRAG_THRESHOLD_PX)).toBe(false);
  });

  it("T11: an INFINITE origin returns false", () => {
    // ⭐ AND THIS is the case that kills mutation U4 — the ORIGIN guard, which
    // is a separate line from the coordinate guard and fails separately.
    // `Math.hypot(100 - Infinity, 0)` is `Infinity`, so without the guard a
    // pointer whose origin was never measured starts a drag on its first move.
    expect(passedThreshold({ x: Number.POSITIVE_INFINITY, y: 100 }, 100, 100, 4)).toBe(false);
    expect(passedThreshold({ x: 100, y: Number.NEGATIVE_INFINITY }, 100, 100, 4)).toBe(false);
  });

  it("T11b: a NaN origin returns false", () => {
    // Kept beside T11, and the SPLIT is the point: this fixture alone cannot
    // tell whether the origin guard exists, because NaN gives `false` either
    // way. Recorded so nobody later "simplifies" T11 into this one.
    expect(passedThreshold({ x: Number.NaN, y: 100 }, 100, 100, 4)).toBe(false);
    expect(passedThreshold({ x: 100, y: Number.NaN }, 100, 100, 4)).toBe(false);
  });
});

describe("dragPointer.ts — passedThreshold: degenerate thresholds", () => {
  it("T12: a zero threshold passes for any finite movement", () => {
    // Asserted against the GENERAL expression — there is no `thresholdPx <= 0`
    // short-circuit to test, because `Math.hypot` is never negative and such a
    // branch came back uncatchable. Zero movement is a finite movement, and it
    // is the sub-case that kills mutation U2 a second time: `0 > 0` is false.
    expect(passedThreshold(O, 100, 100, 0)).toBe(true);
    expect(passedThreshold(O, 101, 100, 0)).toBe(true);
  });

  it("T13: a negative threshold passes for any finite movement", () => {
    expect(passedThreshold(O, 100, 100, -1)).toBe(true);
    expect(passedThreshold(O, 100.5, 99.5, -1)).toBe(true);
  });
});

describe("dragPointer.ts — rowIsDragSource", () => {
  it('T14: "mouse" drags from the row', () => {
    expect(rowIsDragSource("mouse")).toBe(true);
  });

  it('T15: "pen" drags from the row', () => {
    expect(rowIsDragSource("pen")).toBe(true);
  });

  it('T16: "touch" does not', () => {
    // D95a: the finger keeps the handle, because `touch-action: none` on the
    // whole row would leave nowhere on the tree to scroll from.
    expect(rowIsDragSource("touch")).toBe(false);
  });

  it('T17: an unrecognised pointer type does not — including ""', () => {
    // Fail-closed, same shape as `adminAccess`. `""` is what `e.pointerType`
    // reports on some synthetic-event paths and is covered by the general rule
    // rather than by a branch of its own.
    expect(rowIsDragSource("")).toBe(false);
    expect(rowIsDragSource("kinect")).toBe(false);
    expect(rowIsDragSource("Mouse")).toBe(false);
    expect(rowIsDragSource("stylus")).toBe(false);
  });
});

describe("dragPointer.ts — offsetInRow", () => {
  it("T18: offsetInRow subtracts the row top, and is negative above it", () => {
    // The negative arm is not decoration: `resolveDropZone` is documented as
    // taking an UNCLAMPED offset precisely so a pointer a fraction of a pixel
    // above the row it hit still resolves to the nearer half.
    expect(offsetInRow(100, 40)).toBe(60);
    expect(offsetInRow(30, 40)).toBe(-10);
    expect(offsetInRow(40, 40)).toBe(0);
  });
});
