/**
 * D13 — the board renders in UTC in v1. `BOARD_ZONE` is the single seam:
 * every clock/day label in the board goes through the formatters below
 * (`Intl.DateTimeFormat` with `timeZone: BOARD_ZONE`), never a local-time
 * `Date` method. No React import, no CSS import, no DOM API, no imports at
 * all — this module has nothing to import (brief P1-4a §4/§4.1).
 */

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
 * "Mon Aug 17" — no comma, unlike `Intl`'s default en-US punctuation, so
 * `formatToParts` is used and the pieces are joined by hand.
 */
export function formatDayLabel(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${weekday} ${month} ${day}`;
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
