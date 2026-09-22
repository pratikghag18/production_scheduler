/**
 * S61-c — plant-zone date helpers for the typed walk spec.
 *
 * Plant A's zone is whatever its settings say (R-426: the plant's zone is the
 * one clock), read by the spec from the server at setup (`plantZone` in
 * `db.ts`) and passed in here -- never a constant (F-190: the brief said
 * America/Chicago, the reset said UTC, and the spec wrote every block five
 * hours off). The spec needs its own window (the walk day to the walk day +
 * 8) as UTC instants so the cleanup query can compare against `timerange`'s
 * lower bound; the spec body needs the walk day as a plain ISO date to fill
 * the board's own window-start field. `zonedTimeToInstant` is `src/lib/format/timezones.ts`'s own seam --
 * the SAME one `CommandBar.tsx`'s `renderReadout` uses -- imported rather
 * than re-implemented (CLAUDE.md §4: never a second copy of a zone rule).
 * This file only READS from `src/`; nothing here is edited there.
 */

/**
 * `zonedTimeToInstant`, reimplemented here rather than imported from
 * `src/lib/format/timezones.ts`. Both a bare `@/*` alias import and a
 * relative one were tried; both fail `tsc -b` -- the alias with TS2307
 * (`tsconfig.node.json`, the project that actually lists `e2e` in its own
 * `include`, declares no `@/*` path), and the relative path with TS6307
 * (`tsconfig.node.json`'s own `include` lists `e2e` and a couple of named
 * files, not arbitrary `src/` paths -- `loadSanity.spec.ts`'s own comment on
 * the generated `Database` type warns about exactly this: "importing it from
 * a spec is the TS6307 its own comment warns about"). The established e2e
 * convention (that same file, and `roleWalk.spec.ts`'s `SHOW_DAY_WEEKDAY_NAMES`/
 * `CommandBar.tsx` mirroring pattern) is a small, self-contained copy at the
 * one place it is read, not a cross-project import -- so this is that copy,
 * not a re-derivation: same two-pass DST-fold algorithm, same contract,
 * `src/lib/format/timezones.ts`'s own doc comment reproduced below.
 */
function partsInZone(
  d: Date,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
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
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
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
 * 1-based. Two offset passes handle the DST fold: the first offset (at the
 * naive UTC guess) places the instant, and if the zone's offset at THAT
 * instant differs (a spring-forward/fall-back boundary sits between), one
 * correction lands it.
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

/** `YYYY-MM-DD` of `date` as it reads on a wall clock in `zone`. */
export function isoDateInZone(date: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `isoDate` plus `days` calendar days -- pure calendar arithmetic (like
 *  `CommandBar.tsx`'s own `isoWeekOf`), never a zoned instant. */
export function addDaysToIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Midnight of `isoDate`, as the UTC instant that reads back as 00:00 in
 *  `zone` -- `zonedTimeToInstant`'s own contract. */
export function midnightInZone(isoDate: string, zone: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return zonedTimeToInstant(zone, y, m, d, 0, 0);
}

/** `hh:mm` of `isoDate` in `zone`, as epoch milliseconds -- what the
 *  database's own `assignments.timerange` stores a sentence's clock time as
 *  once the plant's own zone has been applied to it. */
export function clockMsInZone(isoDate: string, zone: string, hh: number, mm: number): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return zonedTimeToInstant(zone, y, m, d, hh, mm).getTime();
}

/** Today's `YYYY-MM-DD` on the plant's own clock. */
export function todayInZone(zone: string): string {
  return isoDateInZone(new Date(), zone);
}

/**
 * The walk's own day (F-182): the Monday of the week AFTER the one today
 * falls in, on the plant's clock. Never the day the board opens on, so the
 * clears the walk ends with never empty the day a person is using; "next
 * week" in the repeat entry is this very week by construction; and the demo
 * seed, anchored on the current week, never writes here. On a Sunday that is
 * tomorrow -- still a day nobody is scheduling by hand while the walk runs.
 */
export function walkDayInZone(zone: string): string {
  const today = todayInZone(zone);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const daysToNextMonday = dow === 0 ? 1 : 8 - dow;
  return addDaysToIso(today, daysToNextMonday);
}

/**
 * The spec's own cleanup window: the walk day to the walk day + 8, Chicago
 * (F-182: the walk's own week and the Monday after it, which `far` lands
 * on) -- half-open `[start, end)` in UTC, where `start` is midnight of the
 * walk day and `end` is midnight of (walk day + 9), one past the last day
 * the window names, so "+ 8" is included whole. Nothing before the walk day
 * is touched: the day a person is using is never in this window.
 */
export function cleanupWindow(zone: string): { startUtc: Date; endUtc: Date } {
  const day = walkDayInZone(zone);
  const startIso = day;
  const endIso = addDaysToIso(day, 9);
  return {
    startUtc: midnightInZone(startIso, zone),
    endUtc: midnightInZone(endIso, zone),
  };
}
