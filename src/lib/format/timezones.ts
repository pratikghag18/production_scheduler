/**
 * THE TIME-ZONE VOCABULARY for the board's axis (D88a, R-353) and the Settings
 * panel's third row (R-355).
 *
 * The zone is an IANA name (`America/Chicago`, `Europe/London`, `UTC`). The
 * server validates it against `pg_timezone_names` on the write; the client
 * cannot carry that whole table, so this module holds two things:
 *
 *   - a CURATED list of ~60 common zones, the offered options in the picker;
 *   - `supportedTimezones()`, which prefers the browser's full
 *     `Intl.supportedValuesOf("timeZone")` when the runtime has it and falls
 *     back to the curated list when it does not (older engines, and jsdom).
 *
 * ⚠️ NO React, no CSS — a leaf, like `dates.ts` beside it. The one runtime
 * touch is `Intl`, which every target has.
 */

/** The default zone: what a single-zone customer runs on until somebody sets a
 *  plant's own. Matches `board_window`'s COALESCE and `orgs.settings.timezone`. */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * ~60 common IANA zones, one per major offset/region, in rough west-to-east
 * order. This is the OFFERED list in the picker when the full browser list is
 * not available; when it is, `supportedTimezones()` returns that instead. UTC
 * leads because it is the app's shipped default and the answer a single-zone
 * customer keeps.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Tijuana",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/New_York",
  "America/Toronto",
  "America/Caracas",
  "America/Halifax",
  "America/Santiago",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Atlantic/Azores",
  "Atlantic/Reykjavik",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Dublin",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Warsaw",
  "Europe/Stockholm",
  "Europe/Athens",
  "Europe/Helsinki",
  "Europe/Bucharest",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Asia/Jerusalem",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Australia/Brisbane",
  "Pacific/Auckland",
  "Pacific/Fiji",
];

/**
 * The full offered list: the browser's own `Intl.supportedValuesOf("timeZone")`
 * where the runtime has it (every current browser does), else the curated
 * `COMMON_TIMEZONES`. Deduped and with `UTC` guaranteed present and first, so
 * the shipped default is always offerable.
 */
export function supportedTimezones(): string[] {
  let base: readonly string[] = COMMON_TIMEZONES;
  const intlAny = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof intlAny.supportedValuesOf === "function") {
    try {
      const all = intlAny.supportedValuesOf("timeZone");
      if (Array.isArray(all) && all.length > 0) base = all;
    } catch {
      // fall through to the curated list
    }
  }
  const seen = new Set<string>();
  const out: string[] = [DEFAULT_TIMEZONE];
  seen.add(DEFAULT_TIMEZONE);
  for (const z of base) {
    if (!seen.has(z)) {
      seen.add(z);
      out.push(z);
    }
  }
  return out;
}

/**
 * Is `z` a zone this runtime's `Intl` can actually format with? An unusable
 * zone name would make every `Intl.DateTimeFormat({ timeZone: z })` on the
 * board throw, blanking it — so a value read off the wire is checked here once
 * and replaced with `UTC` if the engine rejects it. Never throws.
 */
export function isUsableTimezone(z: unknown): z is string {
  if (typeof z !== "string" || z.length === 0) return false;
  try {
    // Throws a RangeError on an unknown time zone.
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrow an unknown (a token off the board payload, a value from an RPC) to a
 * usable IANA zone, falling back to `UTC` on anything the engine cannot format.
 * The peer of `coerceDateFormat` in `dates.ts`; never throws.
 */
export function coerceTimezone(v: unknown): string {
  return isUsableTimezone(v) ? v : DEFAULT_TIMEZONE;
}

/**
 * A human label for a zone in the picker: the IANA name with its current
 * UTC offset, e.g. `America/Chicago (UTC-06:00)`. The offset is read from
 * `Intl` at "now", so it shifts with DST — which is honest, since the whole
 * point of D88 is that the offset is not constant. Never throws; returns the
 * bare name if the engine cannot place it.
 */
export function timezoneLabel(z: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: z,
      timeZoneName: "shortOffset",
    }).formatToParts(at);
    const off = parts.find((p) => p.type === "timeZoneName")?.value;
    return off ? `${z} (${off})` : z;
  } catch {
    return z;
  }
}

// ---------------------------------------------------------------------------
// ⭐ WALL CLOCK <-> INSTANT, AND WHY IT LIVES HERE RATHER THAN ON THE BOARD.
//
// These three moved out of `src/features/board/lib/time.ts` on 9 Sept, whole
// and unedited, when the ABSENCE CSV IMPORT needed the same conversion (R-359).
// `src/features/admin/lib/absenceImport.ts` is a dependency-free planner, and a
// planner reaching into `src/features/board/` is exactly the cross-feature
// import the layering rule forbids -- two admin COMPONENTS already do it and
// adding a third from a lib would have made the wart the convention.
//
// This file is the right home and says so in its own header: a leaf, no React,
// no CSS, whose one runtime touch is `Intl`. That is all this maths is.
// `board/lib/time.ts` re-exports `zonedTimeToInstant`, so every existing call
// site is untouched.
// ---------------------------------------------------------------------------

export interface WallParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number; // 0..23
  minute: number;
  second: number;
}

/** The wall-clock `zone` shows for the instant `d`, as calendar numbers. */
export function partsInZone(d: Date, zone: string): WallParts {
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
