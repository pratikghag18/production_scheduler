/**
 * S61-c — Chicago-zone date helpers for the typed walk spec.
 *
 * Plant A is on America/Chicago (brief). `beforeAll`/`afterAll` need the
 * spec's own window (today - 1 to today + 8, Chicago) as UTC instants so the
 * cleanup query can compare against `timerange`'s lower bound; the spec body
 * needs "today" as a plain ISO date to fill the board's own window-start
 * field. `zonedTimeToInstant` is `src/lib/format/timezones.ts`'s own seam --
 * the SAME one `CommandBar.tsx`'s `renderReadout` uses -- imported rather
 * than re-implemented (CLAUDE.md §4: never a second copy of a zone rule).
 * This file only READS from `src/`; nothing here is edited there.
 */
export const PLANT_A_ZONE = "America/Chicago";

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
 *  once Plant A's own zone (America/Chicago) has been applied to it. */
export function clockMsInZone(isoDate: string, zone: string, hh: number, mm: number): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return zonedTimeToInstant(zone, y, m, d, hh, mm).getTime();
}

/** Today's `YYYY-MM-DD` on Plant A's own clock. */
export function todayInPlantA(): string {
  return isoDateInZone(new Date(), PLANT_A_ZONE);
}

/**
 * The spec's own cleanup window (brief §1): "today - 1 to today + 8,
 * Chicago" -- half-open `[start, end)` in UTC, where `start` is midnight of
 * (today - 1) and `end` is midnight of (today + 9) (one past the last day
 * the window names, so "today + 8" is included whole).
 */
export function cleanupWindow(): { startUtc: Date; endUtc: Date } {
  const today = todayInPlantA();
  const startIso = addDaysToIso(today, -1);
  const endIso = addDaysToIso(today, 9);
  return {
    startUtc: midnightInZone(startIso, PLANT_A_ZONE),
    endUtc: midnightInZone(endIso, PLANT_A_ZONE),
  };
}
