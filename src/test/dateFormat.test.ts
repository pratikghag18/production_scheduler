/**
 * The calendar-date display seam (`src/lib/format/dates.ts`).
 *
 * Pure string work, so every case runs without a DOM, a clock or a network —
 * which is the whole reason the formatting lives here and not in a component.
 */
import { describe, it, expect } from "vitest";
import {
  coerceDateFormat,
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  dayMarker,
  formatCalendarDay,
  formatCalendarMonth,
  isCalendarDay,
  isoMondayOfWeek,
  isoOfDayMarker,
  isoPlusDays,
  isoWeekDays,
  weekdayOfIso,
  type DateFormat,
} from "@/lib/format/dates";
import { formatDay } from "@/features/admin/lib/operators";

const SAMPLE = "2026-09-03";

describe("formatCalendarDay renders each token", () => {
  const cases: Array<[DateFormat, string]> = [
    ["d_mon_yyyy", "3 Sep 2026"],
    ["dmy_slash", "03/09/2026"],
    ["mdy_slash", "09/03/2026"],
    ["iso", "2026-09-03"],
    ["dmy_dash_mon", "03-Sep-2026"],
    ["d_month_yyyy", "3 September 2026"],
    ["month_d_yyyy", "September 3, 2026"],
    ["ymd_slash", "2026/09/03"],
  ];
  for (const [fmt, want] of cases) {
    it(`${fmt} -> ${want}`, () => {
      expect(formatCalendarDay(SAMPLE, fmt)).toBe(want);
    });
  }

  it("defaults to d_mon_yyyy when no format is given", () => {
    expect(formatCalendarDay(SAMPLE)).toBe("3 Sep 2026");
    expect(DEFAULT_DATE_FORMAT).toBe("d_mon_yyyy");
  });

  it("drops the day's leading zero only in the month-name form", () => {
    // The slash forms keep two digits (03), the named form reads naturally (3).
    expect(formatCalendarDay("2026-01-05", "d_mon_yyyy")).toBe("5 Jan 2026");
    expect(formatCalendarDay("2026-01-05", "dmy_slash")).toBe("05/01/2026");
    expect(formatCalendarDay("2026-12-31", "mdy_slash")).toBe("12/31/2026");
  });

  it("returns a non-YYYY-MM-DD string UNCHANGED, whatever the format", () => {
    for (const fmt of DATE_FORMATS) {
      expect(formatCalendarDay("sometime", fmt)).toBe("sometime");
      expect(formatCalendarDay("", fmt)).toBe("");
      // Already-formatted values are left alone rather than mangled.
      expect(formatCalendarDay("3 Sep 2026", fmt)).toBe("3 Sep 2026");
    }
  });
});

describe("coerceDateFormat is defensive", () => {
  it("passes a known token through", () => {
    for (const fmt of DATE_FORMATS) expect(coerceDateFormat(fmt)).toBe(fmt);
  });

  it("falls back to the default for anything unrecognised", () => {
    for (const v of ["MM-DD-YYYY", "", "ISO", null, undefined, 3, {}, ["iso"]]) {
      expect(coerceDateFormat(v)).toBe(DEFAULT_DATE_FORMAT);
    }
  });
});

describe("the seam default and the dependency-free logic layer agree", () => {
  // `operators.ts` is dependency-free (it runs under strip-types) and keeps its
  // own DEFAULT-format `formatDay` for the eligibility reason strings it builds
  // where the org token is not in reach. This pins that its output is exactly the
  // seam's default, so the two renderings of the same date can never drift.
  for (const day of ["2026-09-03", "2026-01-05", "2025-11-02", "sometime"]) {
    it(`formatDay(${day}) === formatCalendarDay(${day}, default)`, () => {
      expect(formatDay(day)).toBe(formatCalendarDay(day, DEFAULT_DATE_FORMAT));
    });
  }
});

describe("formatCalendarMonth — labelling a whole month, not a day", () => {
  // ⚠️ IT EXISTS BECAUSE A SCREEN GREW ITS OWN MONTH-NAME ARRAY. `AuditPanel`
  // needed "August 2026" for a filter and wrote out twelve English month names
  // beside the picker; `dateSeam.test.ts` refused them. These cases are what
  // stops the next screen doing the same for want of a function to call.

  it("spells the month for every format that spells a month", () => {
    expect(formatCalendarMonth("2026-08-01", "d_mon_yyyy")).toBe("August 2026");
    expect(formatCalendarMonth("2026-08-01", "d_month_yyyy")).toBe("August 2026");
    expect(formatCalendarMonth("2026-08-01", "month_d_yyyy")).toBe("August 2026");
    expect(formatCalendarMonth("2026-08-01", "dmy_dash_mon")).toBe("August 2026");
  });

  it("⭐ stays numeric for an org that asked for numbers", () => {
    // A picker reading "August 2026" beside a column reading "2026-08-14" is two
    // dialects on one screen, which is the whole point of the org's token.
    expect(formatCalendarMonth("2026-08-01", "iso")).toBe("2026-08");
    expect(formatCalendarMonth("2026-08-01", "dmy_slash")).toBe("08/2026");
    expect(formatCalendarMonth("2026-08-01", "mdy_slash")).toBe("08/2026");
    expect(formatCalendarMonth("2026-08-01", "ymd_slash")).toBe("08/2026");
  });

  it("takes any day in the month, and a bare YYYY-MM", () => {
    expect(formatCalendarMonth("2026-08-31", "d_mon_yyyy")).toBe("August 2026");
    expect(formatCalendarMonth("2026-08", "d_mon_yyyy")).toBe("August 2026");
  });

  it("returns the input unchanged when it is not a date, as formatCalendarDay does", () => {
    // Shown rather than mangled — the same contract as its neighbour, so the two
    // cannot disagree about what a malformed value looks like on screen.
    for (const bad of ["sometime", "", "2026", "2026-13-01", "08/2026"]) {
      expect(formatCalendarMonth(bad, "d_mon_yyyy")).toBe(bad);
    }
  });

  it("every declared format returns a non-empty label", () => {
    // Built from DATE_FORMATS itself, so a format added later is covered here
    // without anybody remembering to widen this file.
    for (const fmt of DATE_FORMATS) {
      expect(formatCalendarMonth("2026-08-01", fmt)).not.toBe("");
    }
  });
});

/**
 * ⭐⭐ R-426 (S62-a) — CALENDAR ARITHMETIC ON A DAY STRING, THE OTHER HALF OF
 * THE SEAM.
 *
 * Five copies of this arithmetic had grown across the app (`BoardPage`,
 * `CommandBar`, `matrix.ts`, `absence.ts`, `api/absences.ts`), each with its
 * own correct paragraph explaining why pinning it to UTC was safe. The
 * explanation being right every time is exactly why it belongs in one place:
 * the sixth copy is the one that gets it wrong, and `dateSeam.test.ts` now
 * refuses one.
 *
 * ⚠️ WHAT THESE CASES ARE REALLY CHECKING is that the helpers never ask a
 * CLOCK anything. Every case runs without a frozen time and must give the same
 * answer on a machine in Chicago, in Tokyo and on UTC — a named calendar day
 * has one weekday and one successor everywhere on earth, and that is the
 * property the one-clock standard leans on when it lets this arithmetic stay
 * zone-free.
 */
describe("R-426: isoPlusDays walks the calendar, not the clock", () => {
  it("adds and subtracts plain days", () => {
    expect(isoPlusDays("2026-09-17", 1)).toBe("2026-09-18");
    expect(isoPlusDays("2026-09-17", -1)).toBe("2026-09-16");
    expect(isoPlusDays("2026-09-17", 0)).toBe("2026-09-17");
  });

  it("carries across a month and a year end", () => {
    expect(isoPlusDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(isoPlusDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isoPlusDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("knows February, including the leap year", () => {
    expect(isoPlusDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(isoPlusDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  /**
   * ⚠️⚠️ THE CASE THE WHOLE STANDARD IS ABOUT. 8 March 2026 is the US
   * spring-forward: in America/Chicago that day is 23 hours long, so "add one
   * day" done by adding 86,400,000 ms to a local instant lands at 23:00 on the
   * SAME date. A day STRING has no such problem, and this is what says so.
   */
  it("crosses a DST boundary without losing or repeating a day", () => {
    expect(isoPlusDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(isoPlusDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(isoPlusDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("returns a malformed day unchanged rather than mangling it", () => {
    expect(isoPlusDays("not a day", 1)).toBe("not a day");
    expect(isoPlusDays("2026-02-30", 1)).toBe("2026-02-30");
  });
});

describe("R-426: weekdayOfIso and the week helpers", () => {
  it("reads the weekday of a named day, Sunday = 0", () => {
    // 2026-09-17 is a Thursday.
    expect(weekdayOfIso("2026-09-17")).toBe(4);
    expect(weekdayOfIso("2026-09-20")).toBe(0);
    expect(weekdayOfIso("2026-09-21")).toBe(1);
  });

  it("answers -1 for a day that does not exist", () => {
    expect(weekdayOfIso("2026-13-01")).toBe(-1);
  });

  it("resolves the Monday of the week, and a Sunday goes BACK six days", () => {
    expect(isoMondayOfWeek("2026-09-17")).toBe("2026-09-14");
    expect(isoMondayOfWeek("2026-09-14")).toBe("2026-09-14");
    // The one that a Sunday-first week would get wrong.
    expect(isoMondayOfWeek("2026-09-20")).toBe("2026-09-14");
  });

  it("lists the seven days of the week, Monday first", () => {
    expect(isoWeekDays("2026-09-17")).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
    ]);
  });

  it("gives the same week for every day in it", () => {
    const week = isoWeekDays("2026-09-14");
    for (const day of week) expect(isoWeekDays(day)).toEqual(week);
  });
});

describe("R-426: isCalendarDay refuses a shape that is not a real day", () => {
  it("accepts a real day", () => {
    expect(isCalendarDay("2026-09-17")).toBe(true);
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("refuses a day that is shaped right and does not exist", () => {
    // The pair the shape test alone cannot tell apart from a real day — which
    // is why the import parsers call this rather than their own regex.
    expect(isCalendarDay("2026-02-30")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("2027-02-29")).toBe(false);
  });

  it("refuses anything not shaped like a day at all", () => {
    expect(isCalendarDay("")).toBe(false);
    expect(isCalendarDay("2026-9-7")).toBe(false);
    expect(isCalendarDay("2026-09-17T00:00:00Z")).toBe(false);
  });
});

describe("R-426: a which-day marker round-trips, and is not an instant", () => {
  it("encodes and decodes the same day", () => {
    expect(isoOfDayMarker(dayMarker("2026-09-17"))).toBe("2026-09-17");
  });

  /**
   * ⚠️ THE MARKER IS READ WITH `getUTC*` AND NOTHING ELSE. This case states the
   * encoding the board's whole window depends on: `buildBoardIndex` takes the
   * marker's UTC calendar day and anchors THAT DAY at the plant zone's own
   * midnight. If the marker were ever built at local midnight instead, the day
   * it names would move by one for anyone west of Greenwich.
   */
  it("is UTC midnight of the day it names", () => {
    const m = dayMarker("2026-09-17");
    expect(m.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(m.getUTCFullYear()).toBe(2026);
    expect(m.getUTCMonth() + 1).toBe(9);
    expect(m.getUTCDate()).toBe(17);
  });

  it("gives an Invalid Date for a day that does not exist, so callers can guard", () => {
    expect(Number.isNaN(dayMarker("2026-02-30").getTime())).toBe(true);
    expect(isoOfDayMarker(dayMarker("not a day"))).toBe("");
  });
});
