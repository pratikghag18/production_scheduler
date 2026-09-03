/**
 * D13 — the board renders in UTC in v1. `BOARD_ZONE` is the single seam:
 * every clock/day label in the board goes through the formatters below
 * (`Intl.DateTimeFormat` with `timeZone: BOARD_ZONE`), never a local-time
 * `Date` method. No React import, no CSS import, no DOM API.
 *
 * ⚠️ THE ONE IMPORT IS A TYPE, and it is erased at compile time (and by
 * `--experimental-strip-types`), so the module still has no runtime dependency:
 * `formatDayLabel` takes the org-wide `DateFormat` token (R-309) so the board's
 * day labels read in the format a system admin chose. TIMEZONE is untouched —
 * which instant maps to which day is still `BOARD_ZONE` and still R-D88's Phase-2
 * question; this only changes how the day is WRITTEN, and the weekday stays.
 */
import type { DateFormat } from "@/lib/format/dates";

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
 * "06:00" / "22:30" — 24h clock, BOARD_ZONE. `hourCycle: "h23"` (not
 * `hour12: false`) is deliberate: some ICU implementations render midnight
 * as "24:00" under `hour12: false` (a long-standing spec ambiguity fixed by
 * `hourCycle`), and this board must never print that.
 */
export function formatClock(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * The board's day label, weekday first, in the org-wide date format (R-309).
 * No comma, unlike `Intl`'s default en-US punctuation, so `formatToParts` is
 * used and the pieces are joined by hand.
 *
 * The WEEKDAY is always kept — it is what a schedule board is read by — and only
 * the date part follows the token (the maintainer's call, 3 Sept):
 *   d_mon_yyyy -> "Mon Aug 17"      (the default; unchanged from v1)
 *   dmy_slash  -> "Mon 17/08"
 *   mdy_slash  -> "Mon 08/17"
 *   iso        -> "Mon 2026-08-17"
 *
 * ⚠️ ALL PARTS ARE IN `BOARD_ZONE`, so this changes only the WRITING of the day,
 * never which day an instant falls on — that stays D13/R-D88's concern.
 */
export function formatDayLabel(d: Date, fmt: DateFormat = "d_mon_yyyy"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_ZONE,
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
  switch (fmt) {
    case "dmy_slash":
      return `${weekday} ${dd}/${mm}`;
    case "mdy_slash":
      return `${weekday} ${mm}/${dd}`;
    case "iso":
      return `${weekday} ${yyyy}-${mm}-${dd}`;
    case "d_mon_yyyy":
    default: {
      // The v1 shape: short month NAME and a NO-leading-zero day ("Aug 17").
      // A second `formatToParts` rather than a month array — this module reaches
      // month names through `Intl`, and the day audit stays green.
      const named = new Intl.DateTimeFormat("en-US", {
        timeZone: BOARD_ZONE,
        month: "short",
        day: "numeric",
      }).formatToParts(d);
      const monthShort = named.find((p) => p.type === "month")?.value ?? "";
      const dayNum = named.find((p) => p.type === "day")?.value ?? "";
      return `${weekday} ${monthShort} ${dayNum}`;
    }
  }
}

/** "Mon Aug 17 06:00" — the mockup's `fmtFull`. */
export function formatFull(d: Date): string {
  return `${formatDayLabel(d)} ${formatClock(d)}`;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * D17's default-window origin. Returns the Monday (00:00 UTC) of the ISO
 * week containing `d` — a Sunday input resolves to the Monday six days
 * *before* it (ISO weeks: Sunday belongs to the week that started the
 * previous Monday), not the Monday after.
 */
export function utcMondayOfWeek(d: Date): Date {
  const start = startOfUtcDay(d);
  const day = start.getUTCDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return addMinutes(start, -daysSinceMonday * MINUTES_PER_DAY);
}

/** The mockup's `fmtNum`: 2dp, trailing zeros (and a bare trailing dot) stripped. */
export function formatNumber(n: number): string {
  let s = n.toFixed(2);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
