import { describe, expect, it } from "vitest";
import type { ShiftTemplate } from "@/lib/api";
import { shiftInstances } from "@/features/board/lib/geometry";
import { buildDayAxis, formatDayLabel, zonedTimeToInstant } from "@/features/board/lib/time";

/**
 * D88a/D88b (R-353/R-354) — the ACTUAL COST of a plant-local axis: two days a
 * year a local day is not 1440 minutes, and a shift keeps its posted wall-clock
 * start across the changeover. Pinned against a REAL zone (`America/Chicago`) on
 * the two 2026 changeover days, measured numerically before the geometry moved:
 *
 *   spring forward  2026-03-08  02:00 -> 03:00   the day is 23h = 1380 min
 *   fall back       2026-11-01  02:00 -> 01:00   the day is 25h = 1500 min
 *
 * The x-axis is REAL minutes from the window's local midnight; `wallToOffset`
 * turns a wall-clock (day, minute-of-day) into that position by resolving the
 * actual instant, so a band keeps its wall-clock time even when a DST jump sits
 * inside the day.
 */

const ZONE = "America/Chicago";

/** A single 22:00–06:00 overnight shift — the night crew that works the
 *  changeover. `start_min` 1320 (22:00), `end_min` 1800 (06:00 next day). */
const overnight: ShiftTemplate = {
  id: "night",
  name: "Nights",
  shifts: [{ id: "n", name: "Night", startMin: 1320, endMin: 1800, breaks: [] }],
};

describe("geometry under DST (D88a/D88b)", () => {
  it("spring forward: 2026-03-08 is 1380 minutes wide", () => {
    // Window opens on 2026-03-07 local midnight; day index 1 is the 8th.
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(axis.dayOffsets).toEqual([0, 1440, 2820, 4260]);
    expect(axis.dayOffsets[2] - axis.dayOffsets[1]).toBe(1380);
    // The whole window is one short day narrower than 3 × 1440.
    expect(axis.windowMinutes).toBe(3 * 1440 - 60);
  });

  it("spring forward: a 22:00–06:00 shift into the short morning is 7 hours of pixels (D88b)", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    // The night of the 7th->8th, whose 06:00 tail lands after the 02:00 jump.
    const night = shiftInstances(overnight, axis).find((i) => i.rawStartMin === 1320);
    expect(night).toBeDefined();
    // 420 minutes = 7 hours, not the 480 a `day*1440 + end_min` would give.
    expect(night!.endMin - night!.startMin).toBe(420);
  });

  it("fall back: 2026-11-01 is 1500 minutes wide, and the long night is 9 hours", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 10, 31, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(axis.dayOffsets).toEqual([0, 1440, 2940, 4380]);
    expect(axis.dayOffsets[2] - axis.dayOffsets[1]).toBe(1500);
    const night = shiftInstances(overnight, axis).find((i) => i.rawStartMin === 1320);
    expect(night).toBeDefined();
    // 540 minutes = 9 hours: the crew works the extra hour.
    expect(night!.endMin - night!.startMin).toBe(540);
  });

  it("the day labels stay on their own days across the spring changeover", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(formatDayLabel(axis.dayStarts[0], "d_mon_yyyy", ZONE)).toBe("Sat Mar 7");
    expect(formatDayLabel(axis.dayStarts[1], "d_mon_yyyy", ZONE)).toBe("Sun Mar 8");
    expect(formatDayLabel(axis.dayStarts[2], "d_mon_yyyy", ZONE)).toBe("Mon Mar 9");
  });

  it("a window that does not cross a changeover is pixel-identical to the pre-D88 axis", () => {
    // June: no DST transition. Every day is 1440 and wallToOffset is day*1440+m,
    // measured against the exact numbers the old `day * MINUTES_PER_DAY` math
    // produced — the regression guard the brief asks for.
    const origin = zonedTimeToInstant(ZONE, 2026, 6, 1, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(axis.dayOffsets).toEqual([0, 1440, 2880, 4320]);
    expect(axis.windowMinutes).toBe(4320);
    for (let day = -1; day <= 3; day++) {
      for (const m of [0, 360, 840, 1320, 1800]) {
        expect(axis.wallToOffset(day, m)).toBe(day * 1440 + m);
      }
    }
  });

  it("a UTC axis is day*1440 everywhere, so nothing shipped changes for a single-zone customer", () => {
    const origin = new Date(Date.UTC(2026, 2, 7, 0, 0)); // even across a US DST date
    const axis = buildDayAxis(origin, 3, "UTC");
    expect(axis.dayOffsets).toEqual([0, 1440, 2880, 4320]);
    for (let day = -1; day <= 3; day++) {
      for (const m of [0, 500, 1440, 1800]) {
        expect(axis.wallToOffset(day, m)).toBe(day * 1440 + m);
      }
    }
  });
});
