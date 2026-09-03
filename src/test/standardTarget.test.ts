/**
 * R-316: the derived default target.
 *
 * The arithmetic the maintainer asked for — "(how much time a person is
 * assigned - breaks) / standard cycle time" — plus the two things they were
 * explicit about afterwards: that a cycle time is never mandatory, and that a
 * part whose cycle is longer than the shift must still show its progress rather
 * than round away to nothing.
 *
 * The template here mirrors the seed's "3 × 8h" exactly (shift 1 breaks at
 * 480-495, 600-630, 720-735; shift 3 overnight, breaking at 1440-1455,
 * 1560-1590, 1680-1695) so these numbers can be read against a real board.
 */
import { describe, it, expect } from "vitest";
import type { ShiftTemplate } from "@/lib/api";
import {
  breakRangesAround,
  buildCycleTimeIndex,
  cycleTimeKey,
  netMinutes,
  overlapMinutes,
  roundTarget,
  standardTargetQty,
  targetDisplay,
} from "@/features/board/lib/standardTarget";

const SEED_TEMPLATE: ShiftTemplate = {
  id: "70000000-0000-0000-0000-000000000001",
  name: "3 × 8h",
  shifts: [
    {
      id: "s1",
      name: "Shift 1",
      startMin: 360,
      endMin: 840,
      breaks: [
        { id: "b1", name: "Break 1", startMin: 480, endMin: 495 },
        { id: "b2", name: "Lunch", startMin: 600, endMin: 630 },
        { id: "b3", name: "Break 2", startMin: 720, endMin: 735 },
      ],
    },
    {
      id: "s2",
      name: "Shift 2",
      startMin: 840,
      endMin: 1320,
      breaks: [
        { id: "b4", name: "Break 1", startMin: 960, endMin: 975 },
        { id: "b5", name: "Lunch", startMin: 1080, endMin: 1110 },
        { id: "b6", name: "Break 2", startMin: 1200, endMin: 1215 },
      ],
    },
    {
      id: "s3",
      name: "Shift 3",
      startMin: 1320,
      endMin: 1800,
      breaks: [
        { id: "b7", name: "Break 1", startMin: 1440, endMin: 1455 },
        { id: "b8", name: "Lunch", startMin: 1560, endMin: 1590 },
        { id: "b9", name: "Break 2", startMin: 1680, endMin: 1695 },
      ],
    },
  ],
};

/** A morning shift, 06:00-14:00 on the window's first day. */
const MORNING = { startMin: 360, endMin: 840 };

describe("T1-T5: net minutes are the assigned time less the breaks inside it", () => {
  it("T1: a full morning shift is 480 minutes gross, 420 net (three breaks, 60 minutes)", () => {
    expect(MORNING.endMin - MORNING.startMin).toBe(480);
    expect(netMinutes(MORNING, SEED_TEMPLATE)).toBe(420);
  });

  it("T2: 420 net minutes at 90 seconds a unit is a target of 280", () => {
    expect(
      standardTargetQty({
        range: MORNING,
        template: SEED_TEMPLATE,
        efficiencyPercent: 100,
        secondsPerUnit: 90,
      }),
    ).toBe(280);
  });

  it("T3: the same assignment at 50% efficiency is a target of 140", () => {
    expect(
      standardTargetQty({
        range: MORNING,
        template: SEED_TEMPLATE,
        efficiencyPercent: 50,
        secondsPerUnit: 90,
      }),
    ).toBe(140);
  });

  it("T4: only the overlapping part of a break is subtracted", () => {
    // 470-490 is 20 minutes and clips the 480-495 break by 10.
    expect(netMinutes({ startMin: 470, endMin: 490 }, SEED_TEMPLATE)).toBe(10);
  });

  it("T5: a cell with no shift pattern loses nothing to breaks", () => {
    expect(netMinutes(MORNING, null)).toBe(480);
    expect(breakRangesAround(null, MORNING)).toEqual([]);
  });
});

describe("T6-T10: a cycle time is optional, and the day tiling is real", () => {
  it("T6: no cycle time means no derived target — null, never zero", () => {
    expect(
      standardTargetQty({
        range: MORNING,
        template: SEED_TEMPLATE,
        efficiencyPercent: 100,
        secondsPerUnit: null,
      }),
    ).toBeNull();
  });

  it("T7: the same shift on the window's SECOND day loses the same 60 minutes", () => {
    // 1800-2280 is 06:00-14:00 on day 1. If breaks were not tiled per day this
    // would come back as the full 480.
    expect(netMinutes({ startMin: 1800, endMin: 2280 }, SEED_TEMPLATE)).toBe(420);
  });

  it("T8: an overnight break past midnight is counted once, not twice", () => {
    // Shift 3's first break sits at 1440-1455 — minute-of-day 0 on the next
    // day. A range of 1440-1500 covers exactly that 15 minutes.
    expect(netMinutes({ startMin: 1440, endMin: 1500 }, SEED_TEMPLATE)).toBe(45);
  });

  it("T9: a block starting BEFORE the window still sees the previous day's breaks", () => {
    // -30 to 30 straddles the window's left edge. Shift 3's 1440-1455 break,
    // tiled onto day -1, lands at 0-15 and must be subtracted. This is the case
    // `breakInstances` cannot answer: it clips everything to [0, windowMinutes].
    expect(netMinutes({ startMin: -30, endMin: 30 }, SEED_TEMPLATE)).toBe(45);
  });

  it("T9b: a late overnight break reaches into the NEXT day, two calendar days on", () => {
    // Shift 3's last break is at 1680-1695 — 04:00-04:15 the following morning.
    // Tiled onto day -1 it lands at 240-255, inside a block that starts at 250
    // on the window's own first day. Scanning only from the block's own day
    // would miss it: this is the case that makes the two-day lookback in
    // `breakRangesAround` load-bearing rather than defensive.
    expect(netMinutes({ startMin: 250, endMin: 300 }, SEED_TEMPLATE)).toBe(45);
  });

  it("T10: a zero or negative cycle time derives nothing", () => {
    for (const secondsPerUnit of [0, -1]) {
      expect(
        standardTargetQty({
          range: MORNING,
          template: SEED_TEMPLATE,
          efficiencyPercent: 100,
          secondsPerUnit,
        }),
      ).toBeNull();
    }
  });
});

describe("T11-T12: overlapping breaks, and the lookup", () => {
  it("T11: two shifts breaking over the same minutes subtract it once", () => {
    const overlapping: ShiftTemplate = {
      id: "t",
      name: "Overlapping",
      shifts: [
        {
          id: "a",
          name: "A",
          startMin: 360,
          endMin: 840,
          breaks: [{ id: "x", name: "X", startMin: 480, endMin: 510 }],
        },
        {
          id: "b",
          name: "B",
          startMin: 360,
          endMin: 840,
          breaks: [{ id: "y", name: "Y", startMin: 495, endMin: 525 }],
        },
      ],
    };
    // 480-510 and 495-525 merge to 480-525: 45 minutes, not 60.
    expect(netMinutes(MORNING, overlapping)).toBe(480 - 45);
  });

  it("T12: the index keys by node and product, last write winning", () => {
    const index = buildCycleTimeIndex([
      { nodeId: "cell-1", productId: "wx", secondsPerUnit: 90 },
      { nodeId: "cell-2", productId: "wx", secondsPerUnit: 120 },
      { nodeId: "cell-1", productId: "wx", secondsPerUnit: 45 },
    ]);
    expect(index.get(cycleTimeKey("cell-1", "wx"))).toBe(45);
    expect(index.get(cycleTimeKey("cell-2", "wx"))).toBe(120);
    expect(index.get(cycleTimeKey("cell-3", "wx"))).toBeUndefined();
  });
});

describe("T13-T16: a part slower than the shift still shows progress", () => {
  it("T13: an empty index derives nothing anywhere — the normal case", () => {
    const index = buildCycleTimeIndex([]);
    expect(
      standardTargetQty({
        range: MORNING,
        template: SEED_TEMPLATE,
        efficiencyPercent: 100,
        secondsPerUnit: index.get(cycleTimeKey("cell-1", "wx")),
      }),
    ).toBeNull();
  });

  it("T14: a 12-hour cycle across an 8-hour shift shows 0.7, not 0", () => {
    expect(
      standardTargetQty({
        range: MORNING,
        template: null,
        efficiencyPercent: 100,
        secondsPerUnit: 12 * 3600,
      }),
    ).toBe(0.7);
  });

  it("T15: at or above one unit the target is whole — 1.9 units means 1 made", () => {
    expect(roundTarget(1.9)).toBe(1);
    expect(roundTarget(1)).toBe(1);
    expect(roundTarget(280.4)).toBe(280);
  });

  it("T16: a tiny fraction of a unit never rounds away to nothing", () => {
    expect(roundTarget(0.02)).toBe(0.1);
    expect(roundTarget(0.55)).toBe(0.6);
  });

  it("T16b: a range with no working time at all derives nothing", () => {
    expect(
      standardTargetQty({
        range: { startMin: 600, endMin: 600 },
        template: SEED_TEMPLATE,
        efficiencyPercent: 100,
        secondsPerUnit: 90,
      }),
    ).toBeNull();
    // A block entirely inside the lunch break is all break and no work.
    expect(
      standardTargetQty({
        range: { startMin: 605, endMin: 625 },
        template: SEED_TEMPLATE,
        efficiencyPercent: 100,
        secondsPerUnit: 90,
      }),
    ).toBeNull();
  });

  it("T16c: overlapMinutes ignores empty and inverted blocks", () => {
    expect(overlapMinutes(MORNING, [])).toBe(0);
    expect(overlapMinutes(MORNING, [{ startMin: 500, endMin: 500 }])).toBe(0);
    expect(overlapMinutes(MORNING, [{ startMin: 500, endMin: 400 }])).toBe(0);
  });
});

/**
 * How a target reads on a block. One function for both block shapes — the
 * chip and the direct block previously carried this line for line, which is
 * the shape of the R-313 duplication that wrote a unit with no quantity.
 */
describe("T17: a block reads its typed target, else the standard, else NA", () => {
  it("T17a: a typed target wins and keeps its unit", () => {
    expect(targetDisplay({ targetQty: 500, targetUnit: "boxes", defaultTargetQty: 280 })).toEqual({
      suffix: " ⌖500",
      tip: " · ⌖ 500 boxes",
    });
  });

  it("T17b: a typed target with no unit carries no stray trailing space", () => {
    expect(targetDisplay({ targetQty: 500, targetUnit: null, defaultTargetQty: null })).toEqual({
      suffix: " ⌖500",
      tip: " · ⌖ 500",
    });
  });

  it("T17c: with nothing typed, the standard shows and is MARKED as the standard", () => {
    const shown = targetDisplay({ targetQty: null, targetUnit: null, defaultTargetQty: 280 });
    expect(shown.suffix).toBe(" ⌖280");
    expect(shown.tip).toBe(" · ⌖ 280 (standard)");
  });

  it("T17d: a derived target never invents a unit — R-313's whole point", () => {
    // targetUnit cannot be set without targetQty (R-314 is a CHECK), but even
    // if a stale row carried one, a derived reading must not borrow it.
    const shown = targetDisplay({ targetQty: null, targetUnit: "units", defaultTargetQty: 280 });
    expect(shown.tip).not.toContain("units");
  });

  it("T17e: neither typed nor derived still reads NA, exactly as before", () => {
    expect(targetDisplay({ targetQty: null, targetUnit: null, defaultTargetQty: null })).toEqual({
      suffix: "",
      tip: " · target: NA",
    });
  });
});
