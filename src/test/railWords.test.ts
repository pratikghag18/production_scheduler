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
 *
 * RW-8 (S66-c, R-448) pins the reason `resolveHomeBand` exists at all: once a
 * person has their OWN band (Shift 2, say) instead of the whole pattern's
 * span, `bookingWords` asked of THAT band reads the SAME block a completely
 * different way than the interim whole-span reading did (RW-7's own fixture,
 * in fact — the same 14:00-22:00 booking that RW-7 pins as bare "free"
 * against the whole span reads "booked" against the person's own Shift 2).
 * `resolveHomeBand`/`overtimeMinutes` below are the two new pure pieces
 * S66-c adds; both are transcriptions of a server rule (R-443's id-then-name
 * match, `app_shift_overtime_minutes`'s day-by-day walk) rather than new
 * invention, per CLAUDE.md §4.
 */
import { describe, it, expect } from "vitest";
import {
  bookingWords,
  rootBand,
  resolveHomeBand,
  overtimeMinutes,
  type RailBlock,
} from "@/features/board/lib/railWords";
import { buildDayAxis } from "@/features/board/lib/time";
import type { Shift, ShiftTemplate } from "@/lib/api";

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

  /**
   * RW-8 (S66-c, R-448): the payoff of a person's OWN band replacing the
   * whole-pattern span. Same three-shift pattern as RW-7 (06-14/14-22/22-06),
   * same 14:00-22:00 booking — but measured against the person's OWN Shift 2
   * band (840-1320) rather than the pattern's whole 06:00-06:00(+1d) span,
   * it reads "booked" (the block covers the band end to end), not RW-7's bare
   * "free". A person on Shift 1 (360-840) with nothing booked at all reads
   * "free", exactly as `bookingWords` already answers for an empty band.
   */
  it("RW-8: a person's OWN shift band (not the whole pattern) -- booked inside it reads 'booked'; free on a different shift reads 'free'", () => {
    const shift2 = { startMin: 840, endMin: 1320 }; // Shift 2, 14:00-22:00
    const shift1 = { startMin: 360, endMin: 840 }; // Shift 1, 06:00-14:00
    const bookedOnShift2 = bookingWords(
      [block(840, 1320)],
      { start: WINDOW_START, minutes: 1440 },
      shift2,
    );
    expect(bookedOnShift2).toBe("booked");
    const freeOnShift1 = bookingWords([], { start: WINDOW_START, minutes: 1440 }, shift1);
    expect(freeOnShift1).toBe("free");
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

/**
 * S66-c (R-441/R-443/R-448): `resolveHomeBand` — the id-then-cross-pattern-
 * name match, transcribed from `shift_fit`'s own SQL (migration 0082).
 */
describe("resolveHomeBand (R-441/R-443/R-448)", () => {
  const dayShift: Shift = { id: "s1", name: "Day", startMin: 360, endMin: 840, breaks: [] };
  const nightShift: Shift = { id: "s2", name: "Night", startMin: 1320, endMin: 1800, breaks: [] };
  const rootTemplate = template([dayShift, nightShift]);

  it("HB-1: no homeShiftId at all -> null", () => {
    expect(resolveHomeBand({ homeShiftId: null, homeNodeId: null }, rootTemplate)).toBeNull();
  });

  it("HB-2: no target template -> null, even with a homeShiftId", () => {
    expect(resolveHomeBand({ homeShiftId: "s1", homeNodeId: null }, null)).toBeNull();
  });

  it("HB-3: matched BY ID directly against the target template -- the ordinary case", () => {
    expect(resolveHomeBand({ homeShiftId: "s2", homeNodeId: null }, rootTemplate)).toEqual(
      nightShift,
    );
  });

  it("HB-4: a cross-pattern match -- the id is a row in the person's HOME template, not the target one, but the NAME matches", () => {
    const homeTemplate = template([
      { id: "away-1", name: "day", startMin: 300, endMin: 780, breaks: [] }, // lowercase "day" on purpose (case-insensitive)
    ]);
    const templateForNode = new Map([["home-node", homeTemplate]]);
    const operator = { homeShiftId: "away-1", homeNodeId: "home-node" };
    expect(resolveHomeBand(operator, rootTemplate, templateForNode)).toEqual(dayShift);
  });

  it("HB-5: an unresolvable homeNodeId (not in templateForNode at all) -> null, not a throw", () => {
    const operator = { homeShiftId: "away-1", homeNodeId: "somewhere-outside-the-window" };
    expect(resolveHomeBand(operator, rootTemplate, new Map())).toBeNull();
  });

  it("HB-6: an id that matches neither the target template nor (via cross-pattern name) anything in it -> null", () => {
    const homeTemplate = template([
      { id: "away-1", name: "Graveyard", startMin: 0, endMin: 480, breaks: [] },
    ]);
    const templateForNode = new Map([["home-node", homeTemplate]]);
    const operator = { homeShiftId: "away-1", homeNodeId: "home-node" };
    expect(resolveHomeBand(operator, rootTemplate, templateForNode)).toBeNull();
  });

  it("HB-7: `templateForNode` omitted entirely -- the id-match half still works, the cross-pattern half degrades to null", () => {
    expect(resolveHomeBand({ homeShiftId: "s1", homeNodeId: null }, rootTemplate)).toEqual(
      dayShift,
    );
  });
});

/**
 * S66-c (R-441/R-448): `overtimeMinutes` — transcribed from
 * `app_shift_overtime_minutes` (migration 0082), in the board's own
 * window-relative real-minute space via `DayAxis.wallToOffset` rather than a
 * second zone/Date conversion of this file's own.
 */
describe("overtimeMinutes (R-441/R-448)", () => {
  const UTC_AXIS_2D = buildDayAxis(new Date("2026-01-15T00:00:00.000Z"), 2, "UTC");

  it("OT-1: fully inside the band -> 0", () => {
    const band = { startMin: 360, endMin: 840 }; // 06:00-14:00
    expect(overtimeMinutes({ startMin: 400, endMin: 500 }, band, UTC_AXIS_2D)).toBe(0);
  });

  it("OT-2: two hours before the band starts -> 120 minutes of overtime", () => {
    const band = { startMin: 360, endMin: 840 }; // 06:00-14:00
    expect(overtimeMinutes({ startMin: 240, endMin: 500 }, band, UTC_AXIS_2D)).toBe(120);
  });

  it("OT-3: entirely outside the band -> the whole block is overtime", () => {
    const band = { startMin: 360, endMin: 840 }; // 06:00-14:00
    expect(overtimeMinutes({ startMin: 900, endMin: 960 }, band, UTC_AXIS_2D)).toBe(60);
  });

  /**
   * OT-4/OT-5: a NIGHT band (22:00-06:00(+1d), startMin 1320/endMin 1800),
   * both sides of the wrap it introduces — a block fully inside its OWN
   * night's instance reads 0, and one that runs an hour past the band's own
   * end (into the next morning) reads exactly that hour as overtime.
   */
  it("OT-4: fully inside a night band's own instance -> 0", () => {
    const band = { startMin: 1320, endMin: 1800 }; // 22:00-06:00(+1d)
    expect(overtimeMinutes({ startMin: 1320, endMin: 1500 }, band, UTC_AXIS_2D)).toBe(0);
  });

  it("OT-5: one hour past the night band's own end -> 60 minutes of overtime", () => {
    const band = { startMin: 1320, endMin: 1800 }; // 22:00-06:00(+1d)
    // 1860 is 07:00 the next day -- 60 minutes past the band's own 06:00 end.
    expect(overtimeMinutes({ startMin: 1320, endMin: 1860 }, band, UTC_AXIS_2D)).toBe(60);
  });

  it("OT-6: a malformed/empty range (end <= start) -> 0, never negative", () => {
    const band = { startMin: 360, endMin: 840 };
    expect(overtimeMinutes({ startMin: 500, endMin: 500 }, band, UTC_AXIS_2D)).toBe(0);
    expect(overtimeMinutes({ startMin: 500, endMin: 400 }, band, UTC_AXIS_2D)).toBe(0);
  });

  /**
   * RC-2 (reviewer found, S66-c review): the DST FALLBACK NIGHT in
   * America/Chicago, 2026-11-01 -- the one calendar day CLAUDE.md §7 asks
   * every date-seam pin to try, in both directions. A night band 22:00-06:00
   * (1320-1800) spans the 2 a.m. -> 1 a.m. clock repeat, so band-covering
   * real time is 9 hours, not the nominal 8 -- but `app_shift_overtime_minutes`
   * (migration 20260918000082_home_shift.sql) does not stretch the band: it
   * resolves the band's START as a wall-clock instant and adds the nominal
   * DURATION as elapsed real minutes, landing the band's real end at 05:00
   * local, one hour short of the wall-clock 06:00. Before this fix,
   * `overtimeMinutes` resolved BOTH ends of the band via `wallToOffset`
   * independently, stretching the band to the full wall-clock 06:00 and
   * scoring a 05:30-06:30 block as half overtime (30 min) where the server
   * (verified live via psql against the running database, 18 Sept) scores it
   * entirely overtime (60 min) because the block falls entirely after the
   * server's un-stretched band end. The two MUST agree -- an OT tag the
   * client shows is meant to be a preview of the same number the server's
   * own writers compute, never an independent guess (CLAUDE.md §4, "extract,
   * never retype").
   */
  it("RC-2: a night band spanning the Chicago DST fallback (2026-11-01) agrees with the server's un-stretched band end", () => {
    const chicagoAxis = buildDayAxis(new Date("2026-10-31T05:00:00.000Z"), 3, "America/Chicago");
    const band = { startMin: 1320, endMin: 1800 }; // 22:00-06:00(+1d)
    // Nov 1, 05:30-06:30 local -- real minutes from the window's own local
    // midnight, via the same wallToOffset every board geometry call uses.
    const range = {
      startMin: chicagoAxis.wallToOffset(1, 5 * 60 + 30),
      endMin: chicagoAxis.wallToOffset(1, 6 * 60 + 30),
    };
    // app_shift_overtime_minutes(1320, 1800, '[2026-11-01 05:30-06,2026-11-01
    // 06:30-06)', 'America/Chicago') returns 60 (verified live via psql,
    // read-only, 18 Sept) -- the whole block, none of it inside the band.
    expect(overtimeMinutes(range, band, chicagoAxis)).toBe(60);
  });
});
