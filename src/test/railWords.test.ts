/**
 * railWords.test.ts — S65-a (R-438): `bookingWords`/`rootBand`, pure.
 *
 * RW-1..RW-7 pin `bookingWords`'s three answers ("free" / "free HH:MM" /
 * "booked") against a BAND, not the whole window (CLAUDE.md §4: `railWords.ts`'s
 * own doc explains why the minute space needs no offset). RW-5/RW-6 are the
 * night-band pair CLAUDE.md §7's one-clock standard asks for: the SAME
 * instant, read in a zone east of UTC and one west of it, must print the
 * correct wall-clock minute in both directions. RW-7 (OR-1, reviewer, S65-a
 * review) is the three-shift scenario that exposed `rootBand`'s old
 * "first band only" reading, and pins the interim WHOLE-pattern-span fix
 * and the "first uncovered minute == band start -> bare 'free'" wording
 * decision that came with it (RW-3 was rewritten the same way). Every `Date`
 * here is a literal, never `new Date()`/`Date.now()` — there is no live
 * clock in this file to freeze.
 */
import { describe, it, expect } from "vitest";
import { bookingWords, rootBand, type RailBlock } from "@/features/board/lib/railWords";
import type { ShiftTemplate } from "@/lib/api";

const WINDOW_START = new Date("2026-01-15T00:00:00.000Z");

function block(startMin: number, endMin: number): RailBlock {
  return { startMin, endMin };
}

describe("bookingWords (R-438)", () => {
  it("RW-1: no block anywhere inside the band -> bare 'free'", () => {
    const band = { startMin: 360, endMin: 1200 }; // 06:00-20:00
    expect(bookingWords([], { start: WINDOW_START, minutes: 1440 }, band)).toBe("free");
    // A block that exists but sits entirely OUTSIDE the band is the same as
    // no block at all, for this band.
    expect(bookingWords([block(0, 200)], { start: WINDOW_START, minutes: 1440 }, band)).toBe(
      "free",
    );
  });

  it("RW-2: coverage that stops before the band ends -> 'free' at the minute after the last block", () => {
    const band = { startMin: 360, endMin: 1200 }; // 06:00-20:00
    const blocks = [block(360, 600)]; // 06:00-10:00 covered, then a gap
    const words = bookingWords(blocks, { start: WINDOW_START, minutes: 1440 }, band);
    expect(words).toBe("free 10:00");
  });

  it("RW-3 (OR-1, reviewer): the first block starts after the band's own start -> bare 'free', not 'free 06:00'", () => {
    // OR-1 (reviewer, S65-a review): the band's OWN start is uncovered here,
    // the same fact `covering.length === 0` reports elsewhere as bare "free"
    // -- printing the band's own start time back ("free 06:00") would say
    // nothing more than "free" already says, and once `band` is the
    // pattern's WHOLE covered span (not one person's shift) it reads as if
    // every chip is stuck reporting the same clock time. See RW-7 for the
    // scenario that made this visible: a person booked well inside the span
    // whose first uncovered minute still lands on the span's own start.
    const band = { startMin: 360, endMin: 1200 }; // 06:00-20:00
    const blocks = [block(600, 1200)]; // covers 10:00-20:00, but not the first four hours
    const words = bookingWords(blocks, { start: WINDOW_START, minutes: 1440 }, band);
    expect(words).toBe("free");
  });

  it("RW-4: the band covered end to end (by more than one block, no gap) -> 'booked'", () => {
    const band = { startMin: 360, endMin: 1200 }; // 06:00-20:00
    const blocks = [block(360, 800), block(800, 1200)];
    const words = bookingWords(blocks, { start: WINDOW_START, minutes: 1440 }, band);
    expect(words).toBe("booked");
  });

  /**
   * RW-5/RW-6: a NIGHT band (`endMin > 1440`, `ShiftRow`'s own "that is what
   * a night shift IS") -- 22:00 day 0 to 06:00 day 1, minute 1320..1800 in
   * window-relative minutes. One block covers only the first three hours
   * (22:00-01:00), leaving a gap from window-minute 1500 (day 1, 01:00 UTC)
   * to the band's own end. `addMinutes(WINDOW_START, 1500)` is the SAME
   * instant in both cases (2026-01-16T01:00:00Z) -- only `zone` differs, and
   * the printed minute must follow it both ways, never the machine's.
   */
  it("RW-5: a night band, read east of UTC (Asia/Kolkata, UTC+5:30)", () => {
    const band = { startMin: 1320, endMin: 1800 };
    const blocks = [block(1320, 1500)]; // 22:00-01:00(+1d), then a gap to 06:00(+1d)
    const words = bookingWords(
      blocks,
      { start: WINDOW_START, minutes: 2880 },
      band,
      "Asia/Kolkata",
    );
    // 2026-01-16T01:00:00Z + 5:30 = 2026-01-16 06:30 local.
    expect(words).toBe("free 06:30");
  });

  it("RW-6: the SAME night band and gap, read west of UTC (America/Chicago, UTC-6)", () => {
    const band = { startMin: 1320, endMin: 1800 };
    const blocks = [block(1320, 1500)];
    const words = bookingWords(
      blocks,
      { start: WINDOW_START, minutes: 2880 },
      band,
      "America/Chicago",
    );
    // 2026-01-16T01:00:00Z - 6:00 = 2026-01-15 19:00 local -- the PREVIOUS
    // calendar day, which is exactly the point: a needle reading `getHours()`
    // or the machine's zone could not tell the two zones apart, let alone
    // roll the date back.
    expect(words).toBe("free 19:00");
  });

  /**
   * RW-7 (OR-1, reviewer, S65-a review): the exact scenario that exposed
   * `rootBand`'s old "first band only" reading -- a three-shift plant
   * (06-14, 14-22, 22-06) whose ENCOMPASSING span (`rootBand`'s new
   * reading) is 06:00 to 06:00(+1d), window-relative minutes 360..1800. A
   * person booked 14:00-22:00 (840..1320) is booked squarely inside a real
   * shift on this plant, so "free" alone (with no time) would be wrong --
   * except the band's own FIRST uncovered minute is still 360 (06:00), the
   * band's own start, because nothing covers the very beginning of the
   * 06:00-06:00 span. Decided here (OR-1): that reads as bare "free", not
   * "free 06:00" -- printing the span's own start time back would look like
   * every chip on the rail reports the same clock reading regardless of
   * what is actually booked, which is worse than saying nothing. The
   * correct per-person answer waits on R-441 (a person's own band); this is
   * the least-wrong reading of the interim, WHOLE-pattern span.
   */
  it("RW-7: booked inside a middle shift of a three-shift pattern -> bare 'free', not 'free 06:00'", () => {
    const band = { startMin: 360, endMin: 1800 }; // rootBand's encompassing span, 06:00-06:00(+1d)
    const blocks = [block(840, 1320)]; // 14:00-22:00, the middle shift
    const words = bookingWords(blocks, { start: WINDOW_START, minutes: 1440 }, band);
    expect(words).toBe("free");
  });

  it("with no pattern on the root (band === null), the band IS the window", () => {
    // A single block covering the whole window exactly: booked against the
    // window itself, the DECIDED fallback for a root with no shift pattern.
    const words = bookingWords([block(0, 1440)], { start: WINDOW_START, minutes: 1440 }, null);
    expect(words).toBe("booked");
    // And the same fallback still answers "free HH:MM" correctly.
    const partial = bookingWords([block(0, 480)], { start: WINDOW_START, minutes: 1440 }, null);
    expect(partial).toBe("free 08:00");
  });
});

function template(shifts: ShiftTemplate["shifts"]): ShiftTemplate {
  return { id: "t1", name: "Pattern", shifts };
}

describe("rootBand (R-438)", () => {
  it("no template at all -> null (bookingWords then falls back to the window)", () => {
    expect(rootBand(null)).toBeNull();
  });

  it("a template with no shifts -> null, same as no template", () => {
    expect(rootBand(template([]))).toBeNull();
  });

  /**
   * OR-1 (reviewer, S65-a review): the ORIGINAL reading here took only the
   * pattern's first shift, which made a person booked in a LATER shift read
   * "free" outright -- `bookingWords` was simply never shown that band. The
   * interim fix (until R-441 gives each person their own band) is the whole
   * PATTERN's covered span: the earliest start to the latest end, across
   * every shift, not just the first.
   */
  it("a template's WHOLE covered span, not just its first shift -- earliest start to latest end (R-441 not shipped yet)", () => {
    const t = template([
      { id: "s1", name: "Day", startMin: 360, endMin: 840, breaks: [] },
      { id: "s2", name: "Night", startMin: 1320, endMin: 1800, breaks: [] },
    ]);
    expect(rootBand(t)).toEqual({ startMin: 360, endMin: 1800 });
  });

  it("three shifts, unordered in the array -- still earliest start to latest end", () => {
    const t = template([
      { id: "s2", name: "Afternoon", startMin: 840, endMin: 1320, breaks: [] },
      { id: "s3", name: "Night", startMin: 1320, endMin: 1800, breaks: [] },
      { id: "s1", name: "Morning", startMin: 360, endMin: 840, breaks: [] },
    ]);
    expect(rootBand(t)).toEqual({ startMin: 360, endMin: 1800 });
  });

  it("a single-shift template -- the whole span IS that one shift, same as before", () => {
    const t = template([{ id: "s1", name: "Day", startMin: 360, endMin: 1200, breaks: [] }]);
    expect(rootBand(t)).toEqual({ startMin: 360, endMin: 1200 });
  });
});
