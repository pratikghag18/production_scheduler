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
