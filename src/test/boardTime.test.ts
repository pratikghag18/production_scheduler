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
  buildDayAxis,
  wallOf,
} from "@/features/board/lib/time";
import { isoDayInZone, partsInZone, todayIsoInZone } from "@/lib/format/timezones";

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

/**
 * S55 (D130 item 3, R-404/R-406 to R-410): `wallOf` is the inverse of
 * `axis.wallToOffset` for a WINDOW offset -- `BoardPage` feeds it to
 * `ResolveContext.wallOf`, and `expandCommand`'s `copy` (R-408) reads a
 * block's/run's own wall-clock hours back off its real-minute
 * `startMin`/`endMin` through it. Reviewer (14 Sept follow-up): the one way
 * to get this wrong is `offsetMin % 1440` for the minute-of-day -- correct
 * on an ordinary day, silently wrong on a changeover day, where a real
 * minute and a wall-clock minute part ways. Pinned against a REAL zone
 * (America/New_York, the same 2026-03-08/2026-11-01 US changeover
 * `geometryDst.test.ts` already measures for `America/Chicago` -- the 2 AM
 * local jump is the same instant of the YEAR everywhere the rule applies,
 * only the UTC offset differs), never the stub linear `wallToOffset` the
 * command-bar fixtures use.
 */
describe("wallOf (S55, D130 item 3)", () => {
  const ZONE = "America/New_York";

  it("spring forward, 2026-03-08: before the 02:00 jump, minuteOfDay is the real elapsed minutes", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(axis.dayOffsets).toEqual([0, 1440, 2820, 4260]); // day 1 (Mar 8) is 1380 real minutes
    const offset = axis.dayOffsets[1] + 50; // 00:50, well before the jump
    expect(wallOf(axis, offset)).toEqual({ dayIndex: 1, minuteOfDay: 50 });
  });

  it("spring forward, 2026-03-08: after the 02:00 jump, minuteOfDay is the WALL-CLOCK reading, never offsetMin % 1440", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    const offset = axis.dayOffsets[1] + 500; // 500 real minutes past local midnight on Mar 8
    const result = wallOf(axis, offset);
    // The lost hour: 500 real minutes read as 09:20 (560), not 08:20 (500) --
    // and NOT `offset % 1440`, which lands on 500 here by coincidence
    // (dayOffsets[1] === 1440) and would be flatly wrong on day 2 or later.
    expect(result).toEqual({ dayIndex: 1, minuteOfDay: 560 });
    const instant = addMinutes(axis.windowStart, offset);
    const parts = partsInZone(instant, ZONE);
    expect(result.minuteOfDay).toBe(parts.hour * 60 + parts.minute);
    expect(result.minuteOfDay).not.toBe(offset % 1440);
  });

  it("an offset exactly at a day boundary belongs to the day that STARTS there, not the one that ends there", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 3, 7, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(wallOf(axis, axis.dayOffsets[2])).toEqual({ dayIndex: 2, minuteOfDay: 0 });
    expect(wallOf(axis, axis.dayOffsets[2] - 1)).toEqual({ dayIndex: 1, minuteOfDay: 1439 });
  });

  it("fall back, 2026-11-01: the long night's extra hour reads as a wall-clock hour, not a modulo artifact", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 10, 31, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    expect(axis.dayOffsets).toEqual([0, 1440, 2940, 4380]); // day 1 (Nov 1) is 1500 real minutes
    // 200 real minutes past local midnight on Nov 1 -- before the 02:00->01:00
    // fold, wall clock still reads real elapsed.
    expect(wallOf(axis, axis.dayOffsets[1] + 90)).toEqual({ dayIndex: 1, minuteOfDay: 90 });
    // 1000 real minutes in: past the fold, so the clock has gained the hour
    // back -- wall-clock minuteOfDay is 60 LESS than the real elapsed.
    const result = wallOf(axis, axis.dayOffsets[1] + 1000);
    expect(result).toEqual({ dayIndex: 1, minuteOfDay: 940 });
    expect(result.minuteOfDay).not.toBe(1000 % 1440);
  });

  it("a window with no changeover is exactly the plain (offset % 1440) shape -- the regression guard", () => {
    const origin = zonedTimeToInstant(ZONE, 2026, 6, 1, 0, 0);
    const axis = buildDayAxis(origin, 3, ZONE);
    for (let day = 0; day <= 2; day++) {
      for (const m of [0, 90, 600, 1439]) {
        expect(wallOf(axis, day * 1440 + m)).toEqual({ dayIndex: day, minuteOfDay: m });
      }
    }
  });
});

/**
 * ⭐⭐ R-426 (S62-a) — "WHICH DAY IS IT" IS A QUESTION FOR THE ZONE, AND THESE
 * ARE THE NUMBERS.
 *
 * Both of the wrong answers shipped, and neither was visible in the afternoon:
 * `toISOString().slice(0,10)` (the UTC day, already tomorrow through the
 * evening west of Greenwich — F-159, found at 19:09 in Chicago) and
 * `getFullYear()/getMonth()/getDate()` (the browser machine's day — F-161).
 * `isoDayInZone` is what replaced both, and `todayIsoInZone` is it asked of now.
 *
 * ⚠️ THE INSTANT IS FIXED AND THE EXPECTATIONS ARE WRITTEN OUT, so these cases
 * hold on a machine in any zone — which is the property the two bugs cost us.
 */
describe("R-426: an instant's calendar day belongs to a zone, not to a machine", () => {
  // 00:30 UTC on 17 September: three zones, three different DAYS.
  const AT = new Date("2026-09-17T00:30:00Z");

  it("reads the day the plant is having, not the UTC one", () => {
    expect(isoDayInZone(AT, "UTC")).toBe("2026-09-17");
    expect(isoDayInZone(AT, "America/Chicago")).toBe("2026-09-16");
    expect(isoDayInZone(AT, "Asia/Tokyo")).toBe("2026-09-17");
  });

  it("⭐ F-159's own instant: 19:09 Chicago is still the 16th there and the 17th in UTC", () => {
    const evening = new Date("2026-09-17T00:09:00Z");
    expect(isoDayInZone(evening, "America/Chicago")).toBe("2026-09-16");
    expect(evening.toISOString().slice(0, 10)).toBe("2026-09-17");
  });

  it("agrees with the zoned day axis, which is the whole point of sharing partsInZone", () => {
    const p = partsInZone(AT, "America/Chicago");
    expect(isoDayInZone(AT, "America/Chicago")).toBe(
      `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    );
  });

  it("todayIsoInZone is isoDayInZone asked of an instant, defaulting to now", () => {
    expect(todayIsoInZone("America/Chicago", AT)).toBe("2026-09-16");
    expect(todayIsoInZone("Asia/Tokyo", AT)).toBe("2026-09-17");
    // The default argument is the real clock, so only its SHAPE can be pinned.
    expect(todayIsoInZone("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("holds across a DST changeover, where the offset itself moves", () => {
    // 8 March 2026, 07:30 UTC — 01:30 Chicago, before the 02:00 spring forward.
    expect(isoDayInZone(new Date("2026-03-08T07:30:00Z"), "America/Chicago")).toBe("2026-03-08");
    // 04:30 UTC on 8 March is 22:30 on the 7th, before the change.
    expect(isoDayInZone(new Date("2026-03-08T04:30:00Z"), "America/Chicago")).toBe("2026-03-07");
  });
});
