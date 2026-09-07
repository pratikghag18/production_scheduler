/**
 * D88a (R-353) — the board renders in the PLANT'S LOCAL TIME. What was the
 * single `BOARD_ZONE = "UTC"` seam is now a ZONE THREADED THROUGH: every
 * clock/day formatter and every day-axis computation takes an IANA zone
 * (`Intl.DateTimeFormat` with `timeZone: zone`), never a local-time `Date`
 * method. The zone is resolved on the SERVER for the board's own root and
 * carried on the payload (`board_window.timezone`, migration 0063) — the client
 * never walks the ancestry for it (DEF-0016/DEF-0017 were both that walk).
 *
 * ⚠️ THE ZONE DEFAULTS TO "UTC" everywhere, so a caller that passes nothing gets
 * exactly the pre-D88 behaviour — which is what keeps the single-zone customer,
 * and every UTC-written test, unchanged. `BOARD_ZONE` is kept as that default
 * name so the intent reads.
 *
 * ⚠️ THE ONE IMPORT IS A TYPE, erased at compile time (and by
 * `--experimental-strip-types`), so the module still has no runtime dependency.
 * `formatDayLabel` takes the org-wide `DateFormat` token (R-309); the WEEKDAY is
 * always kept and only the date part follows the token.
 */
import type { DateFormat } from "@/lib/format/dates";

/** The default zone: the pre-D88 axis, and what a single-zone customer runs on. */
export const BOARD_ZONE = "UTC";
export const MS_PER_MINUTE = 60_000;
export const MINUTES_PER_DAY = 1440;

/** (b - a) in minutes. Positive when b is later than a. */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_PER_MINUTE;
}

export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MS_PER_MINUTE);
}

/**
 * "06:00" / "22:30" — 24h clock, in `zone`. `hourCycle: "h23"` (not
 * `hour12: false`) is deliberate: some ICU implementations render midnight as
 * "24:00" under `hour12: false`, and this board must never print that.
 */
export function formatClock(d: Date, zone: string = BOARD_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * The board's day label, weekday first, in the org-wide date format (R-309) and
 * the plant's zone (R-353). No comma, so `formatToParts` is used and the pieces
 * are joined by hand.
 *
 * ⚠️ ALL PARTS ARE IN `zone`, so which day an instant falls on now follows the
 * PLANT, not UTC — that is the whole of D88a. Month NAMES are reached through
 * `Intl` (month:"short"/"long"), never a month array, so the day-seam audit
 * stays green here.
 */
export function formatDayLabel(
  d: Date,
  fmt: DateFormat = "d_mon_yyyy",
  zone: string = BOARD_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const named = (length: "short" | "long"): { month: string; day: string } => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      month: length,
      day: "numeric",
    }).formatToParts(d);
    return {
      month: p.find((x) => x.type === "month")?.value ?? "",
      day: p.find((x) => x.type === "day")?.value ?? "",
    };
  };
  switch (fmt) {
    case "dmy_slash":
      return `${weekday} ${dd}/${mm}`;
    case "mdy_slash":
      return `${weekday} ${mm}/${dd}`;
    case "iso":
      return `${weekday} ${yyyy}-${mm}-${dd}`;
    case "ymd_slash":
      return `${weekday} ${yyyy}/${mm}/${dd}`;
    case "dmy_dash_mon": {
      const { month } = named("short");
      return `${weekday} ${dd}-${month}-${yyyy}`;
    }
    case "d_month_yyyy": {
      const { month, day } = named("long");
      return `${weekday} ${day} ${month} ${yyyy}`;
    }
    case "month_d_yyyy": {
      const { month, day } = named("long");
      return `${weekday} ${month} ${day}, ${yyyy}`;
    }
    case "d_mon_yyyy":
    default: {
      const { month, day } = named("short");
      return `${weekday} ${month} ${day}`;
    }
  }
}

/** "Mon Aug 17 06:00" — the mockup's `fmtFull`, in the plant's zone. */
export function formatFull(
  d: Date,
  fmt: DateFormat = "d_mon_yyyy",
  zone: string = BOARD_ZONE,
): string {
  return `${formatDayLabel(d, fmt, zone)} ${formatClock(d, zone)}`;
}

// ---------------------------------------------------------------------------
// Zone-aware calendar primitives (D88a). Everything below turns a wall-clock in
// a zone into an absolute instant, and back, WITHOUT a date library — the same
// `Intl.formatToParts` offset trick used everywhere zoned time is done by hand.
// ---------------------------------------------------------------------------

interface WallParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number; // 0..23
  minute: number;
  second: number;
}

/** The wall-clock `zone` shows for the instant `d`, as calendar numbers. */
function partsInZone(d: Date, zone: string): WallParts {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const m: Record<string, number> = {};
  for (const x of p) if (x.type !== "literal") m[x.type] = Number(x.value);
  // h23 gives 00 at midnight, but guard the "24" some engines still emit.
  const hour = m.hour === 24 ? 0 : m.hour;
  return { year: m.year, month: m.month, day: m.day, hour, minute: m.minute, second: m.second };
}

/** `zone`'s offset from UTC, in ms, at the instant `d` (east of UTC is +ve). */
function zoneOffsetMs(d: Date, zone: string): number {
  const w = partsInZone(d, zone);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUTC - d.getTime();
}

/**
 * The absolute instant that reads wall-clock `y-mo-d h:mi` in `zone`. `mo` is
 * 1-based; `d`, `h`, `mi` may be out of range (e.g. a negative day, or 26:00)
 * and are normalised by `Date.UTC`, which is what lets the day-axis add days and
 * carry overnight minutes without special cases.
 *
 * Two offset passes handle the DST fold: the first offset (at the naive UTC
 * guess) places the instant, and if the zone's offset at THAT instant differs
 * (a spring-forward/fall-back boundary sits between), one correction lands it.
 */
export function zonedTimeToInstant(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffsetMs(new Date(utcGuess), zone);
  let ts = utcGuess - off1;
  const off2 = zoneOffsetMs(new Date(ts), zone);
  if (off2 !== off1) ts = utcGuess - off2;
  return new Date(ts);
}

/** Local midnight (the instant) of the calendar day containing `d` in `zone`. */
export function startOfDay(d: Date, zone: string = BOARD_ZONE): Date {
  const w = partsInZone(d, zone);
  return zonedTimeToInstant(zone, w.year, w.month, w.day, 0, 0);
}

/**
 * D17's default-window origin, zone-aware. The Monday (local 00:00 in `zone`) of
 * the ISO week containing `d` — a Sunday resolves to the Monday six days before.
 */
export function mondayOfWeek(d: Date, zone: string = BOARD_ZONE): Date {
  const w = partsInZone(d, zone);
  // The weekday of a calendar date is zone-independent, so read it off the
  // Y-M-D directly rather than a second zoned format.
  const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay(); // 0 = Sun
  const back = dow === 0 ? 6 : dow - 1;
  return zonedTimeToInstant(zone, w.year, w.month, w.day - back, 0, 0);
}

// ---------------------------------------------------------------------------
// LEGACY UTC helpers — the pre-D88 "which calendar day" markers. The board-view
// STORE keeps producing one of these as a zone-free day marker (the zone is not
// known at store-init, before the board payload lands); `BoardPage` reinterprets
// that marker into the plant zone with `startOfDay`/`zonedTimeToInstant`. So
// these stay for the store's benefit and are `startOfDay(d, "UTC")` /
// `mondayOfWeek(d, "UTC")` by construction.
// ---------------------------------------------------------------------------

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function utcMondayOfWeek(d: Date): Date {
  const start = startOfUtcDay(d);
  const day = start.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return addMinutes(start, -daysSinceMonday * MINUTES_PER_DAY);
}

// ---------------------------------------------------------------------------
// THE DAY AXIS (D88a's actual cost). Under a plant-local axis a day is 1380 or
// 1500 real minutes twice a year, and a shift-band's position is no longer
// `day * 1440 + start_min`. The axis is REAL minutes from the window's local
// midnight; `wallToOffset` turns any wall-clock (day, minute-of-day) into its
// real-minute x-position by resolving the actual instant in the zone — so a
// 06:00 shift sits at 06:00 wall-clock (D88b) even on the changeover day, when
// 06:00 is only five real hours after midnight.
// ---------------------------------------------------------------------------

export interface DayAxis {
  zone: string;
  /** The instant of day 0's local midnight — the x = 0 origin. */
  windowStart: Date;
  dayCount: number;
  /** Instants of each local midnight, day 0..dayCount (length dayCount + 1). */
  dayStarts: Date[];
  /** Real minutes from `windowStart` to each local midnight (length dayCount+1);
   *  `dayOffsets[dayCount]` is the window's full real-minute width. */
  dayOffsets: number[];
  /** The window's width in REAL minutes — `dayCount * 1440` off a changeover,
   *  1380/1500 less/more across one. */
  windowMinutes: number;
  /**
   * The real-minute x-position of wall-clock `minuteOfDay` on day `dayIndex`.
   * `minuteOfDay` may exceed 1440 (an overnight `end_min`); the excess carries
   * into the following day, so an overnight band's width is measured across the
   * real gap between the two days' midnights — which is what makes a 22:00–06:00
   * shift 7 hours of pixels on the short night (D88b).
   */
  wallToOffset(dayIndex: number, minuteOfDay: number): number;
}

/**
 * Build the day axis for a window of `dayCount` local days starting at
 * `windowStart` (which MUST already be a local-midnight instant in `zone`, e.g.
 * from `startOfDay`). For `zone === "UTC"` every day is 1440 minutes,
 * `dayOffsets` is `[0, 1440, 2880, …]` and `wallToOffset(day, m) === day*1440+m`
 * exactly — so the board is pixel-identical to the pre-D88 output.
 */
export function buildDayAxis(
  windowStart: Date,
  dayCount: number,
  zone: string = BOARD_ZONE,
): DayAxis {
  const base = partsInZone(windowStart, zone);
  const dayStarts: Date[] = [];
  const dayOffsets: number[] = [];
  for (let i = 0; i <= dayCount; i++) {
    const inst = zonedTimeToInstant(zone, base.year, base.month, base.day + i, 0, 0);
    dayStarts.push(inst);
    dayOffsets.push((inst.getTime() - windowStart.getTime()) / MS_PER_MINUTE);
  }
  const windowMinutes = dayOffsets[dayCount];
  const wallToOffset = (dayIndex: number, minuteOfDay: number): number => {
    const carry = Math.floor(minuteOfDay / MINUTES_PER_DAY);
    const within = minuteOfDay - carry * MINUTES_PER_DAY;
    const inst = zonedTimeToInstant(
      zone,
      base.year,
      base.month,
      base.day + dayIndex + carry,
      Math.floor(within / 60),
      within % 60,
    );
    return (inst.getTime() - windowStart.getTime()) / MS_PER_MINUTE;
  };
  return { zone, windowStart, dayCount, dayStarts, dayOffsets, windowMinutes, wallToOffset };
}

/**
 * ⭐ THE BOARD'S FETCH BOUNDS — the `[p_from, p_to)` tstzrange `board_window` is
 * asked for — ANCHORED AT PLANT-LOCAL MIDNIGHT, the same frame the axis is drawn
 * in. The store's `windowStartDate` is a UTC-midnight "which day" marker (the
 * zone is unknown at store-init); `buildBoardIndex` already turns its calendar
 * day into the zone's LOCAL midnight for the axis origin (`zonedTimeToInstant`),
 * but the QUERY was still handed the raw UTC midnights. Under a westward zone
 * (America/Chicago) local midnight is 05:00/06:00 UTC, so a run late on the last
 * visible LOCAL day (22:00 local ≈ 04:00 UTC the next calendar day) sits PAST the
 * UTC `p_to` and `board_window` omits it — it saves, then vanishes on reload.
 * These bounds move `p_from`/`p_to` onto the same local midnights the axis uses,
 * so that run is inside the range the server filters on.
 *
 * ⚠️ `zone === null` IS THE FIRST LOAD, before any payload has carried the
 * plant's zone (the zone rides on the very payload these bounds fetch). The
 * bounds cannot be placed in a zone we do not yet know, so a WHOLE DAY is padded
 * onto each side of the UTC-day window. Every IANA zone is within ±14h of UTC, so
 * a full-day pad is guaranteed to enclose every run inside the visible local
 * days; the fetch is a little wider than needed for exactly one round trip, and
 * the moment the payload lands the zone is known and these bounds tighten to the
 * exact local midnights (a refetch on the narrowed key — the same settle the axis
 * itself makes). Over-fetching a day is safe; under-fetching drops real runs.
 *
 * ⚠️ FOR `zone === "UTC"` the local midnights ARE the UTC midnights, so the
 * bounds equal `windowStartDate` and `windowStartDate + dayCount·1440` EXACTLY —
 * the pre-fix values, and every UTC-written test, unchanged.
 */
export function boardFetchBounds(
  windowStartDate: Date,
  windowDayCount: number,
  zone: string | null,
): { from: Date; to: Date } {
  if (zone === null) {
    return {
      from: addMinutes(windowStartDate, -MINUTES_PER_DAY),
      to: addMinutes(windowStartDate, (windowDayCount + 1) * MINUTES_PER_DAY),
    };
  }
  const y = windowStartDate.getUTCFullYear();
  const mo = windowStartDate.getUTCMonth() + 1;
  const d = windowStartDate.getUTCDate();
  return {
    from: zonedTimeToInstant(zone, y, mo, d, 0, 0),
    to: zonedTimeToInstant(zone, y, mo, d + windowDayCount, 0, 0),
  };
}

/** The mockup's `fmtNum`: 2dp, trailing zeros (and a bare trailing dot) stripped. */
export function formatNumber(n: number): string {
  let s = n.toFixed(2);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
