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
  formatCalendarDay,
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
