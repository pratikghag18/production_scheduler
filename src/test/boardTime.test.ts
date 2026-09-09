import { describe, expect, it } from "vitest";
import {
  BOARD_ZONE,
  formatClock,
  formatDayLabel,
  formatFull,
  formatNumber,
  startOfUtcDay,
  utcMondayOfWeek,
  startOfDay,
  mondayOfWeek,
  zonedTimeToInstant,
  addMinutes,
  minutesBetween,
  boardFetchBounds,
  MINUTES_PER_DAY,
} from "@/features/board/lib/time";

/**
 * F-125: `formatClock`/`formatDayLabel` (and `partsInZone` beneath them) used
 * to build a fresh `Intl.DateTimeFormat` on every call — measured as 62% of
 * all CPU on a 384-cell board. `dateTimeFormat` in `lib/format/timezones.ts`
 * now caches one per (zone, options). This proves the cache is doing its job,
 * without depending on the exact count any other case has already warmed the
 * shared module-level cache to.
 */
describe("F-125: Intl.DateTimeFormat construction is cached", () => {
  it("formatFull reuses formatters instead of building one per call", () => {
    const Real = Intl.DateTimeFormat;
    let constructions = 0;
    class Counting extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        constructions++;
      }
    }
    (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Counting;
    try {
      for (let i = 0; i < 500; i++) {
        formatFull(new Date("2026-08-17T06:00:00Z"), "d_mon_yyyy", "America/Chicago");
      }
    } finally {
      (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = Real;
    }
    // formatFull touches at most 3 distinct option sets (formatDayLabel's
    // parts, its inner `named`, and formatClock) — however many of those the
    // cache had already warmed before this case, 500 more calls must add at
    // most 3 new constructions, never one per call.
    expect(constructions).toBeLessThanOrEqual(3);
  });
});

/**
 * §12 case 1-3, ported to Vitest. Authored, not run in this container (no
 * npm) — the harness under /tmp/harness proved these exact assertions
 * against this exact code (see the agent report).
 */
describe("time.ts", () => {
  it("BOARD_ZONE is UTC (D13)", () => {
    expect(BOARD_ZONE).toBe("UTC");
  });

  it("formatClock is 24h, BOARD_ZONE (case 1)", () => {
    expect(formatClock(new Date("2026-08-17T06:00:00Z"))).toBe("06:00");
    expect(formatClock(new Date("2026-08-17T22:30:00Z"))).toBe("22:30");
  });

  it("formatClock never prints 24:00 at midnight", () => {
    expect(formatClock(new Date("2026-08-17T00:00:00Z"))).toBe("00:00");
  });

  it("formatDayLabel has no comma (mockup's DAY_NAMES style)", () => {
    expect(formatDayLabel(new Date("2026-08-17T00:00:00Z"))).toBe("Mon Aug 17");
  });

  it("formatDayLabel keeps the weekday and reformats the date per token (R-309)", () => {
    const d = new Date("2026-08-17T00:00:00Z");
    // Default is byte-identical to v1, so an untouched board reads the same.
    expect(formatDayLabel(d, "d_mon_yyyy")).toBe("Mon Aug 17");
    expect(formatDayLabel(d, "dmy_slash")).toBe("Mon 17/08");
    expect(formatDayLabel(d, "mdy_slash")).toBe("Mon 08/17");
    expect(formatDayLabel(d, "iso")).toBe("Mon 2026-08-17");
  });

  it("formatDayLabel renders the added presets, weekday first (0038)", () => {
    const d = new Date("2026-08-17T00:00:00Z");
    expect(formatDayLabel(d, "ymd_slash")).toBe("Mon 2026/08/17");
    expect(formatDayLabel(d, "dmy_dash_mon")).toBe("Mon 17-Aug-2026");
    expect(formatDayLabel(d, "d_month_yyyy")).toBe("Mon 17 August 2026");
    expect(formatDayLabel(d, "month_d_yyyy")).toBe("Mon August 17, 2026");
  });

  it("formatDayLabel resolves the day in BOARD_ZONE, not local time (R-309)", () => {
    // Late-UTC instant: in UTC it is still the 17th, which the label must show
    // whatever token is chosen — the format changes the writing, not the day.
    const late = new Date("2026-08-17T23:30:00Z");
    expect(formatDayLabel(late, "iso")).toBe("Mon 2026-08-17");
    expect(formatDayLabel(late, "dmy_slash")).toBe("Mon 17/08");
  });

  it("formatFull composes day label and clock", () => {
    expect(formatFull(new Date("2026-08-17T06:00:00Z"))).toBe("Mon Aug 17 06:00");
  });

  it("startOfUtcDay truncates to a whole UTC day", () => {
    const d = startOfUtcDay(new Date("2026-08-17T14:32:10Z"));
    expect(d.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("utcMondayOfWeek returns the same Monday for that Monday, the Wednesday after, and the Sunday after (case 2)", () => {
    const monday = new Date("2026-08-17T00:00:00Z");
    const wednesday = new Date("2026-08-19T13:00:00Z");
    const sunday = new Date("2026-08-23T09:00:00Z");
    expect(utcMondayOfWeek(monday).getTime()).toBe(monday.getTime());
    expect(utcMondayOfWeek(wednesday).getTime()).toBe(monday.getTime());
    expect(utcMondayOfWeek(sunday).getTime()).toBe(monday.getTime());
  });

  it("addMinutes / minutesBetween are inverses", () => {
    const base = new Date("2026-08-17T06:00:00Z");
    const next = addMinutes(base, 90);
    expect(next.toISOString()).toBe("2026-08-17T07:30:00.000Z");
    expect(minutesBetween(base, next)).toBe(90);
  });

  it("formatNumber: 2dp, trailing zeros stripped (case 3)", () => {
    expect(formatNumber(1)).toBe("1");
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(1.25)).toBe("1.25");
  });
});

/**
 * D88a (R-353): the formatters and calendar primitives are ZONE-AWARE now, and
 * default to UTC so every case above (and every pre-D88 caller) is unchanged.
 */
describe("time.ts, zone-aware (D88a)", () => {
  it("formatClock/formatDayLabel render the PLANT's wall clock, and default to UTC", () => {
    // 2026-08-17 06:00 UTC is 01:00 in Chicago (CDT, UTC-5) the SAME day.
    const inst = new Date("2026-08-17T06:00:00Z");
    expect(formatClock(inst)).toBe("06:00"); // default UTC, unchanged
    expect(formatClock(inst, "America/Chicago")).toBe("01:00");
    expect(formatDayLabel(inst, "iso", "America/Chicago")).toBe("Mon 2026-08-17");
    // 2026-08-17 02:00 UTC is 21:00 Chicago the PREVIOUS day — the label follows.
    const late = new Date("2026-08-17T02:00:00Z");
    expect(formatDayLabel(late, "iso", "America/Chicago")).toBe("Sun 2026-08-16");
  });

  it("startOfDay/mondayOfWeek resolve local midnight in the zone", () => {
    const inst = new Date("2026-08-17T06:00:00Z"); // Mon, 01:00 Chicago
    // Chicago local midnight of the 17th = 05:00 UTC (CDT is UTC-5).
    expect(startOfDay(inst, "America/Chicago").toISOString()).toBe("2026-08-17T05:00:00.000Z");
    // The Monday of that ISO week is the 17th itself.
    expect(mondayOfWeek(inst, "America/Chicago").getTime()).toBe(
      zonedTimeToInstant("America/Chicago", 2026, 8, 17, 0, 0).getTime(),
    );
    // UTC default matches the legacy helper.
    expect(startOfDay(inst).getTime()).toBe(startOfUtcDay(inst).getTime());
    expect(mondayOfWeek(inst).getTime()).toBe(utcMondayOfWeek(inst).getTime());
  });
});

/**
 * The board's FETCH bounds — `board_window`'s `p_from`/`p_to` — follow the
 * plant's zone, not UTC, so a run late on the last visible LOCAL day is inside
 * the range the server filters on rather than past a UTC midnight (the DEF that
 * saved then vanished on reload). `windowStartDate` is the store's UTC "which
 * day" marker.
 */
describe("boardFetchBounds (fetch bounds follow the plant zone)", () => {
  const windowStartDate = new Date("2026-08-24T00:00:00.000Z"); // Mon, a UTC marker
  const dayCount = 7;

  it("UTC: the bounds equal the old whole-UTC-day values exactly", () => {
    const { from, to } = boardFetchBounds(windowStartDate, dayCount, "UTC");
    expect(from.getTime()).toBe(windowStartDate.getTime());
    // The pre-fix computation: `addMinutes(windowStartDate, dayCount*1440)`.
    expect(to.getTime()).toBe(addMinutes(windowStartDate, dayCount * MINUTES_PER_DAY).getTime());
  });

  it("America/Chicago: the bounds are the local-midnight instants the axis is anchored at", () => {
    const { from, to } = boardFetchBounds(windowStartDate, dayCount, "America/Chicago");
    // Local midnight of Aug 24 in Chicago (CDT, UTC-5) is 05:00 UTC — the same
    // instant `zonedTimeToInstant` (and the axis origin) resolves.
    expect(from.getTime()).toBe(zonedTimeToInstant("America/Chicago", 2026, 8, 24, 0, 0).getTime());
    expect(from.toISOString()).toBe("2026-08-24T05:00:00.000Z");
    // p_to is the local midnight `dayCount` days later, not a UTC midnight, so a
    // 22:00-local run on the last visible day (Aug 30) falls inside [from, to).
    expect(to.getTime()).toBe(
      zonedTimeToInstant("America/Chicago", 2026, 8, 24 + dayCount, 0, 0).getTime(),
    );
    expect(to.toISOString()).toBe("2026-08-31T05:00:00.000Z");
  });

  it("first load (zone unknown): a whole-day pad each side — a safe superset", () => {
    const { from, to } = boardFetchBounds(windowStartDate, dayCount, null);
    expect(from.getTime()).toBe(addMinutes(windowStartDate, -MINUTES_PER_DAY).getTime());
    expect(to.getTime()).toBe(
      addMinutes(windowStartDate, (dayCount + 1) * MINUTES_PER_DAY).getTime(),
    );
  });
});
