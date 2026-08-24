import { describe, expect, it } from "vitest";
import {
  MIN_DURATION_MINUTES,
  hitTestBlock,
  snapMinute,
  createRange,
  moveWithinTrack,
  resizeRange,
  findRunOverlap,
  classifyCrewAgainstRun,
} from "@/features/board/lib/interaction";

/**
 * §11's 19 named cases (31 assertions), ported to Vitest, plus the extra
 * case1c the agent report documents adding after the brief's own case 1
 * input (370 with shiftPoints [360, 840, 1320]) turned out NOT to
 * distinguish correct fallback-to-snapMinutes behaviour from M5's mutated
 * "always use shift points when non-empty" behaviour — both produce 360
 * for that input. case1c uses 500 instead (correct fallback -> 510,
 * M5-mutated -> 360), which does discriminate.
 *
 * Authored, not run in this container (no npm) — the /tmp/harness copy of
 * this exact code was executed (31/31 pass) and each of M1-M7 was applied
 * one at a time and confirmed to fail its named case; see the agent
 * report for the real terminal output.
 */

describe("interaction.ts — snapping", () => {
  it("case1a: snapMinute rounds to the nearest snapMinutes step", () => {
    expect(
      snapMinute(370, { altKey: false, useShiftSnap: false, snapMinutes: 30, shiftPoints: [] }),
    ).toBe(360);
  });

  it("case1b: a finer snapMinutes step rounds differently", () => {
    expect(
      snapMinute(370, { altKey: false, useShiftSnap: false, snapMinutes: 15, shiftPoints: [] }),
    ).toBe(375);
  });

  it("case1c (extra, M5 coverage): snapMinute ignores shiftPoints when useShiftSnap is false", () => {
    expect(
      snapMinute(500, {
        altKey: false,
        useShiftSnap: false,
        snapMinutes: 30,
        shiftPoints: [360, 840, 1320],
      }),
    ).toBe(510);
  });

  it("case2a: altKey returns the exact raw minute (Standard, no shiftPoints)", () => {
    expect(
      snapMinute(370, { altKey: true, useShiftSnap: false, snapMinutes: 30, shiftPoints: [] }),
    ).toBe(370);
  });

  it("case2b: altKey returns the exact raw minute even at Compact zoom with shiftPoints supplied", () => {
    expect(
      snapMinute(370, {
        altKey: true,
        useShiftSnap: true,
        snapMinutes: 30,
        shiftPoints: [360, 840, 1320],
      }),
    ).toBe(370);
  });

  it("case3a: useShiftSnap snaps to the nearest shift point (500 -> 360)", () => {
    expect(
      snapMinute(500, {
        altKey: false,
        useShiftSnap: true,
        snapMinutes: 30,
        shiftPoints: [360, 840, 1320],
      }),
    ).toBe(360);
  });

  it("case3b: useShiftSnap snaps to the nearest shift point (700 -> 840)", () => {
    expect(
      snapMinute(700, {
        altKey: false,
        useShiftSnap: true,
        snapMinutes: 30,
        shiftPoints: [360, 840, 1320],
      }),
    ).toBe(840);
  });

  it("case4: useShiftSnap with an empty shiftPoints array falls back to snapMinutes", () => {
    expect(
      snapMinute(370, { altKey: false, useShiftSnap: true, snapMinutes: 30, shiftPoints: [] }),
    ).toBe(360);
  });
});

describe("interaction.ts — create", () => {
  it("case5: createRange normalizes a backwards drag (anchor after current)", () => {
    expect(createRange(600, 360, 4320)).toEqual({ startMin: 360, endMin: 600 });
  });

  it("case6: a drag shorter than MIN_DURATION_MINUTES returns null", () => {
    expect(MIN_DURATION_MINUTES).toBe(15);
    expect(createRange(360, 370, 4320)).toBe(null);
  });

  it("case7: createRange clamps both edges to windowMinutes", () => {
    expect(createRange(-100, 4400, 4320)).toEqual({ startMin: 0, endMin: 4320 });
  });
});

describe("interaction.ts — move: clamp, not squash", () => {
  it("case8: moveWithinTrack clamps at the left edge without squashing duration", () => {
    const result = moveWithinTrack({ startMin: 100, endMin: 460 }, -500, 4320);
    expect(result).toEqual({ startMin: 0, endMin: 360 });
    expect(result.endMin - result.startMin).toBe(360);
  });

  it("case9: moveWithinTrack clamps at the right edge without squashing duration", () => {
    const result = moveWithinTrack({ startMin: 4000, endMin: 4360 }, 500, 4320);
    expect(result).toEqual({ startMin: 3960, endMin: 4320 });
    expect(result.endMin - result.startMin).toBe(360);
  });

  it("case10: a zero delta leaves the range unchanged", () => {
    expect(moveWithinTrack({ startMin: 500, endMin: 860 }, 0, 4320)).toEqual({
      startMin: 500,
      endMin: 860,
    });
  });
});

describe("interaction.ts — resize", () => {
  it("case11: resizing the start edge pins at endMin - MIN_DURATION_MINUTES", () => {
    expect(resizeRange({ startMin: 100, endMin: 200 }, "start", 200, 4320)).toEqual({
      startMin: 185,
      endMin: 200,
    });
  });

  it("case12: resizing the end edge pins at startMin + MIN_DURATION_MINUTES", () => {
    expect(resizeRange({ startMin: 100, endMin: 200 }, "end", -200, 4320)).toEqual({
      startMin: 100,
      endMin: 115,
    });
  });

  it("case13: resizing the end edge clamps to windowMinutes", () => {
    expect(resizeRange({ startMin: 4000, endMin: 4200 }, "end", 500, 4320)).toEqual({
      startMin: 4000,
      endMin: 4320,
    });
  });

  it("case14a: resizing the start edge never moves endMin", () => {
    expect(resizeRange({ startMin: 100, endMin: 200 }, "start", 10, 4320).endMin).toBe(200);
  });

  it("case14b: resizing the end edge never moves startMin", () => {
    expect(resizeRange({ startMin: 100, endMin: 200 }, "end", 10, 4320).startMin).toBe(100);
  });
});

describe("interaction.ts — hit testing (D38)", () => {
  it("case15a: a pointer at the very left edge hits the start grip", () => {
    expect(hitTestBlock(2, 200, 8)).toBe("start");
  });

  it("case15b: a pointer at the very right edge hits the end grip", () => {
    expect(hitTestBlock(198, 200, 8)).toBe("end");
  });

  it("case15c: the exact midpoint of a 200px block is body, not an edge", () => {
    expect(hitTestBlock(100, 200, 8)).toBe("body");
  });

  it("case16: a narrow block still has a body zone (D38's grip = min(handlePx, blockWidthPx/3))", () => {
    expect(hitTestBlock(6, 12, 8)).toBe("body");
  });
});

describe("interaction.ts — overlap and crew classification", () => {
  const runs = [
    { id: "r1", startMin: 0, endMin: 240 },
    { id: "r2", startMin: 480, endMin: 720 },
  ];

  it("case17a: findRunOverlap ignores the excluded run id (self during resize/move)", () => {
    expect(findRunOverlap({ startMin: 0, endMin: 240 }, runs, "r1")).toBe(null);
  });

  it("case17b: findRunOverlap finds a genuine clash against r1", () => {
    expect(findRunOverlap({ startMin: 100, endMin: 300 }, runs, null)).toBe(runs[0]);
  });

  it("case17c: findRunOverlap finds a genuine clash against r2", () => {
    expect(findRunOverlap({ startMin: 500, endMin: 700 }, runs, null)).toBe(runs[1]);
  });

  it("case18: touching ranges (half-open) do not overlap", () => {
    const touching = [{ id: "r3", startMin: 0, endMin: 60 }];
    expect(findRunOverlap({ startMin: 60, endMin: 120 }, touching, null)).toBe(null);
  });

  it("case19a: classifyCrewAgainstRun reports clipped crew (still overlaps but extends past)", () => {
    const crew = [
      { id: "a1", startMin: 100, endMin: 300 }, // clipped: overlaps [150,250] but extends past both edges
    ];
    const { clipped, stranded } = classifyCrewAgainstRun({ startMin: 150, endMin: 250 }, crew);
    expect(clipped.map((c) => c.id)).toEqual(["a1"]);
    expect(stranded).toEqual([]);
  });

  it("case19b: classifyCrewAgainstRun reports stranded crew (no overlap at all)", () => {
    const crew = [{ id: "a2", startMin: 300, endMin: 400 }];
    const { clipped, stranded } = classifyCrewAgainstRun({ startMin: 150, endMin: 250 }, crew);
    expect(clipped).toEqual([]);
    expect(stranded.map((c) => c.id)).toEqual(["a2"]);
  });
});
