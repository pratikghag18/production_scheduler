/**
 * shiftNow.test.ts — S66-c (R-448): `bandCoveringNow`, pure.
 *
 * Every `now` here is a literal `Date` — never `new Date()`/`Date.now()` —
 * per CLAUDE.md §7's own instruction: a clock-dependent function is pinned
 * with a frozen clock, in both directions (west and east of UTC) and on both
 * sides of midnight.
 */
import { describe, it, expect } from "vitest";
import { bandCoveringNow } from "@/features/board/lib/shiftNow";
import type { ShiftTemplate } from "@/lib/api";

function template(shifts: ShiftTemplate["shifts"]): ShiftTemplate {
  return { id: "t1", name: "Pattern", shifts };
}

const THREE_SHIFT: ShiftTemplate = template([
  { id: "s1", name: "Shift 1", startMin: 360, endMin: 840, breaks: [] }, // 06:00-14:00
  { id: "s2", name: "Shift 2", startMin: 840, endMin: 1320, breaks: [] }, // 14:00-22:00
  { id: "s3", name: "Shift 3", startMin: 1320, endMin: 1800, breaks: [] }, // 22:00-06:00(+1d)
]);

describe("bandCoveringNow (R-448)", () => {
  it("SN-1: no template at all -> null", () => {
    expect(bandCoveringNow(null, new Date("2026-09-18T12:00:00.000Z"), "UTC")).toBeNull();
  });

  it("SN-2: a template with no shifts -> null", () => {
    expect(bandCoveringNow(template([]), new Date("2026-09-18T12:00:00.000Z"), "UTC")).toBeNull();
  });

  it("SN-3: an ordinary day band covers the instant squarely inside it", () => {
    // 10:00 UTC sits inside Shift 1 (06:00-14:00).
    const now = new Date("2026-09-18T10:00:00.000Z");
    expect(bandCoveringNow(THREE_SHIFT, now, "UTC")).toEqual(THREE_SHIFT.shifts[0]);
  });

  it("SN-4: the boundary minute belongs to the band that is STARTING, not the one that just ended", () => {
    // Exactly 14:00 UTC: Shift 1 ends here (endMin exclusive), Shift 2 starts.
    const now = new Date("2026-09-18T14:00:00.000Z");
    expect(bandCoveringNow(THREE_SHIFT, now, "UTC")).toEqual(THREE_SHIFT.shifts[1]);
  });

  it("SN-5: a gap between bands (none covers it) -> null", () => {
    const gappy = template([{ id: "s1", name: "Day", startMin: 360, endMin: 840, breaks: [] }]);
    // 20:00 UTC is well outside the one 06:00-14:00 band.
    expect(bandCoveringNow(gappy, new Date("2026-09-18T20:00:00.000Z"), "UTC")).toBeNull();
  });

  /**
   * SN-6/SN-7: THE NIGHT BAND, BOTH SIDES OF MIDNIGHT (Shift 3, 22:00-06:00).
   * `endMin` (1800) exceeds 1440, `Shift`'s own shape for a band that wraps.
   */
  it("SN-6: a night band covers an instant BEFORE midnight, on its own start day", () => {
    // 23:00 UTC: minuteOfDay 1380, inside [1320, 1440) — the "started earlier
    // today" half of the wrap.
    const now = new Date("2026-09-18T23:00:00.000Z");
    expect(bandCoveringNow(THREE_SHIFT, now, "UTC")).toEqual(THREE_SHIFT.shifts[2]);
  });

  it("SN-7: the SAME night band covers an instant AFTER midnight, on the following day", () => {
    // 02:00 UTC the next day: minuteOfDay 120, inside [0, 1800-1440) === [0, 360)
    // — the "started yesterday, still running" half of the wrap.
    const now = new Date("2026-09-19T02:00:00.000Z");
    expect(bandCoveringNow(THREE_SHIFT, now, "UTC")).toEqual(THREE_SHIFT.shifts[2]);
  });

  /**
   * SN-8/SN-9 (CLAUDE.md §7): the SAME instant, read in a zone east of UTC and
   * one west of it, must select the band the PLANT's clock is actually in —
   * never the machine's. 2026-09-18T23:30:00Z is 19-Sep 05:00 in Kolkata
   * (UTC+5:30, inside Shift 1's 06:00 start? no — 05:00 is still Shift 3's
   * night band) and 18-Sep 18:30 in Chicago (UTC-5 in September, DST) —
   * inside Shift 2 (14:00-22:00).
   */
  it("SN-8: the same instant, read east of UTC (Asia/Kolkata, UTC+5:30) -- still the night band, one calendar day later", () => {
    const now = new Date("2026-09-18T23:30:00.000Z");
    // 23:30Z + 5:30 = 2026-09-19 05:00 local -- minuteOfDay 300, inside [0, 360).
    expect(bandCoveringNow(THREE_SHIFT, now, "Asia/Kolkata")).toEqual(THREE_SHIFT.shifts[2]);
  });

  it("SN-9: the SAME instant, read west of UTC (America/Chicago) -- a different band entirely, and the PREVIOUS calendar day", () => {
    const now = new Date("2026-09-18T23:30:00.000Z");
    // 23:30Z - 5:00 (CDT) = 2026-09-18 18:30 local -- minuteOfDay 1110, inside
    // Shift 2's [840, 1320). A needle reading the machine's own zone could not
    // have told these two cases apart, let alone landed on different bands.
    expect(bandCoveringNow(THREE_SHIFT, now, "America/Chicago")).toEqual(THREE_SHIFT.shifts[1]);
  });

  it("SN-10: overlapping bands -- the first match in the pattern's own array order wins", () => {
    const overlapping = template([
      { id: "a", name: "A", startMin: 0, endMin: 720, breaks: [] },
      { id: "b", name: "B", startMin: 600, endMin: 1440, breaks: [] },
    ]);
    const now = new Date("2026-09-18T11:00:00.000Z"); // minuteOfDay 660, inside both
    expect(bandCoveringNow(overlapping, now, "UTC")).toEqual(overlapping.shifts[0]);
  });
});
