/**
 * Boundary conversions (brief P1-3b §5): `tstzrange` / `ltree` serialisation
 * and the UI-percent <-> database-numeric(4,3) efficiency conversion.
 *
 * `ltree` needs no helper here — a node path is just a plain string
 * (`"plant_1.assembly.line_1.cell_1"`) at both ends; PostgREST accepts it
 * as a string and casts server-side (brief §2). `p_root_path` is passed
 * straight through by board.ts.
 */

/**
 * A `Date` pair -> the half-open Postgres tstzrange text form
 * (`[start,end)`), matching every range in the database (migration 0003's
 * exclusion constraint and every RPC's `p_timerange` argument). Millisecond
 * precision, quoted, no space after the comma — this exact form round-trips
 * through `parseTstzRange` below and is what PostgREST accepts for a
 * `tstzrange`-typed (generated-as-`unknown`) RPC argument.
 */
export function toTstzRange(start: Date, end: Date): string {
  return `["${start.toISOString()}","${end.toISOString()}")`;
}

/**
 * Normalises one Postgres timestamptz text token to a form every JS engine
 * parses identically via the ISO 8601 grammar (`Date` parsing of
 * non-ISO strings is implementation-defined per ECMA-262, so this must not
 * rely on the browser accepting Postgres's own `YYYY-MM-DD HH:MM:SS+TZ`
 * output — Node/V8 happens to, but that is not a portability guarantee):
 * the space between date and time becomes `T`, and a bare `+HH`/`-HH`
 * offset (no minutes, no colon — Postgres's default style, e.g. `+00`)
 * gets `:00` appended so it reads as a valid ISO offset. A `Z` suffix or an
 * already-colon-bearing offset (`+05:30`, our own `toTstzRange` output) is
 * left untouched.
 */
function normalizeTimestampToken(raw: string): string {
  let s = raw.trim();
  s = s.replace(" ", "T");
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  return s;
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

/** Splits `lower,upper` on the first comma that is outside a quoted bound. */
function splitRangeBounds(inner: string): [string, string] | null {
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      return [inner.slice(0, i), inner.slice(i + 1)];
    }
  }
  return null;
}

/**
 * The inverse of `toTstzRange`, and the parser for every `timerange` field
 * that comes back from a wrapper (`Run.timerange`, `Assignment.timerange`,
 * `CapacityProbeOverlap.timerange`, ...). Handles both `[`/`(` lower bounds
 * and `]`/`)` upper bounds (Postgres always emits `[...)`` for these
 * columns, but the parser doesn't assume that), and both quoted
 * (`"2026-08-18 06:00:00+00"`) and unquoted bound text.
 */
export function parseTstzRange(s: string): { start: Date; end: Date } {
  const trimmed = s.trim();
  const lowerChar = trimmed[0];
  const upperChar = trimmed[trimmed.length - 1];
  if ((lowerChar !== "[" && lowerChar !== "(") || (upperChar !== "]" && upperChar !== ")")) {
    throw new Error(`parseTstzRange: not a range literal: ${s}`);
  }

  const inner = trimmed.slice(1, -1);
  const bounds = splitRangeBounds(inner);
  if (bounds === null) {
    throw new Error(`parseTstzRange: could not split bounds: ${s}`);
  }

  const start = new Date(normalizeTimestampToken(unquote(bounds[0])));
  const end = new Date(normalizeTimestampToken(unquote(bounds[1])));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`parseTstzRange: unparseable timestamp in: ${s}`);
  }
  return { start, end };
}

/**
 * UI percent -> database `numeric(4,3)` (design-plan §14.2: `efficiency
 * numeric(4,3) NOT NULL DEFAULT 1.000 CHECK (efficiency > 0 AND
 * efficiency <= 2)`). The UI speaks percent (mockup: `eff: 50`); the
 * database stores a fraction rounded to 3 decimals. THE ONLY place this
 * math is implemented — every call site in board.ts/mutations.ts that
 * needs to send an efficiency value calls this function rather than
 * reimplementing `percent / 100` inline, which is what the brief's warning
 * is about: get this wrong (or duplicate it slightly differently
 * somewhere) and an operator at 50% is stored at 50000%.
 */
export function toEfficiency(percent: number): number {
  return Math.round(percent * 10) / 1000;
}

/** The inverse of `toEfficiency`, for displaying a stored value as a percent. */
export function fromEfficiency(value: number): number {
  return Math.round(value * 1000) / 10;
}
