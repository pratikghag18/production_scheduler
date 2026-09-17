/**
 * THE CALENDAR-DATE DISPLAY SEAM.
 *
 * Every calendar date shown to a user as TEXT goes through `formatCalendarDay`,
 * and the format token it takes comes from the org setting via `useDateFormat()`
 * (`src/features/admin/hooks/useOrgSettings.ts`). This is the single seam — the
 * same discipline `src/features/board/lib/time.ts` keeps for the board's instant
 * axis (`BOARD_ZONE`), and for the same reason: the app had already grown two
 * independent date formatters (this one and the board's) and one of them was
 * about to become a third. `src/test/dateSeam.test.ts` fails the build if a
 * calendar date is formatted anywhere but here.
 *
 * ⚠️ FORMATTING IS PURE STRING WORK — no `Date`, no `Intl`, no timezone. A
 * Postgres `date` (`operator_skills.certified_at` / `expires_at`) arrives as
 * `"YYYY-MM-DD"` and is timezone-less by construction; parsing it through
 * `new Date("2026-09-03")` would reinterpret it as UTC midnight and print the
 * day before it for anyone west of Greenwich (the reasoning `operators.ts`
 * recorded when it first wrote `formatDay` by hand). Reformatting the string
 * sidesteps that class of bug entirely.
 *
 * ⚠️ THE SECOND HALF OF THIS FILE (R-426) IS CALENDAR ARITHMETIC, AND IT DOES
 * TOUCH `Date` — as a calendar machine at explicit UTC, never as a clock. See
 * its own banner. Nothing in either half reads the machine's zone.
 *
 * ⚠️ THIS SETTING GOVERNS DISPLAYED TEXT, NOT INPUTS. A native
 * `<input type="date">` renders in the browser/OS locale regardless, and its
 * value stays ISO; CSV import parsing stays strict ISO too, because a
 * deterministic input must not follow a display preference.
 *
 * NO IMPORTS — like `time.ts`, this module has nothing to import, which is what
 * lets it run under `node --experimental-strip-types` and be audited as a leaf.
 */

/**
 * The org-wide date-display formats. A CLOSED enum stored as a token in
 * `orgs.settings.date_format` — never a free-form pattern, so the server can
 * validate it and the client can map it exhaustively. Sample day `2026-09-03`:
 *
 *   d_mon_yyyy   -> "3 Sep 2026"      (default; the shape the app shipped with)
 *   dmy_slash    -> "03/09/2026"
 *   mdy_slash    -> "09/03/2026"
 *   iso          -> "2026-09-03"
 *   dmy_dash_mon -> "03-Sep-2026"
 *   d_month_yyyy -> "3 September 2026"
 *   month_d_yyyy -> "September 3, 2026"
 *   ymd_slash    -> "2026/09/03"
 */
export type DateFormat =
  | "d_mon_yyyy"
  | "dmy_slash"
  | "mdy_slash"
  | "iso"
  | "dmy_dash_mon"
  | "d_month_yyyy"
  | "month_d_yyyy"
  | "ymd_slash";

/** Absent or unrecognised setting resolves to this — the pre-setting behaviour. */
export const DEFAULT_DATE_FORMAT: DateFormat = "d_mon_yyyy";

/** Every token, in the order the settings screen offers them. */
export const DATE_FORMATS: readonly DateFormat[] = [
  "d_mon_yyyy",
  "dmy_slash",
  "mdy_slash",
  "iso",
  "dmy_dash_mon",
  "d_month_yyyy",
  "month_d_yyyy",
  "ymd_slash",
];

const MONTHS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTHS_FULL: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Narrow an unknown (a jsonb value read from `orgs.settings`, a string from an
 * RPC) to a `DateFormat`, falling back to the default on anything unexpected —
 * the same defensive idiom `boardIndex.ts` uses for `capacity_cap`. Never
 * throws.
 */
export function coerceDateFormat(v: unknown): DateFormat {
  return DATE_FORMATS.includes(v as DateFormat) ? (v as DateFormat) : DEFAULT_DATE_FORMAT;
}

/**
 * `"2026-09-03"` -> the given format's rendering. Returns the input UNCHANGED if
 * it is not a well-formed `YYYY-MM-DD` — matching the old `formatDay`, so a
 * malformed or already-formatted value is shown as-is rather than mangled.
 */
/**
 * A whole MONTH's name, for labelling a period rather than a day: `"2026-08-01"`
 * (or any day in that month) -> `"August 2026"`, or `"2026-08"` where the org
 * has chosen a numeric format.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE A SCREEN GREW ITS OWN MONTH-NAME ARRAY AND THE SEAM
 * AUDIT CAUGHT IT. `AuditPanel` needed to label "the previous calendar month" on
 * a filter and wrote out twelve English month names beside the picker — which is
 * a second vocabulary for something this module already owns, and the thing
 * `dateSeam.test.ts` exists to refuse. The names live here once.
 *
 * ⚠️ IT FOLLOWS THE ORG'S FORMAT RATHER THAN ALWAYS SPELLING THE MONTH. An org
 * that asked for `iso` dates is telling you it wants numbers, and a picker
 * reading "August 2026" beside a column reading "2026-08-14" is two dialects on
 * one screen. The numeric formats therefore get `YYYY-MM`, in their own order
 * where that order is unambiguous.
 *
 * Returns the input UNCHANGED when it is not a well-formed day, exactly as
 * `formatCalendarDay` does, so a malformed value is shown rather than mangled.
 */
export function formatCalendarMonth(day: string, fmt: DateFormat = DEFAULT_DATE_FORMAT): string {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(day);
  if (m === null) return day;
  const [, yyyy, mm] = m;
  const monFull = MONTHS_FULL[Number(mm) - 1];
  switch (fmt) {
    case "dmy_slash":
    case "mdy_slash":
    case "ymd_slash":
      return `${mm}/${yyyy}`;
    case "iso":
      return `${yyyy}-${mm}`;
    default:
      // Every remaining format spells a month, so this one does too.
      return monFull === undefined ? day : `${monFull} ${yyyy}`;
  }
}

export function formatCalendarDay(day: string, fmt: DateFormat = DEFAULT_DATE_FORMAT): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const [, yyyy, mm, dd] = m;
  const monShort = MONTHS[Number(mm) - 1];
  const monFull = MONTHS_FULL[Number(mm) - 1];
  switch (fmt) {
    case "dmy_slash":
      return `${dd}/${mm}/${yyyy}`;
    case "mdy_slash":
      return `${mm}/${dd}/${yyyy}`;
    case "iso":
      return `${yyyy}-${mm}-${dd}`;
    case "ymd_slash":
      return `${yyyy}/${mm}/${dd}`;
    case "dmy_dash_mon":
      if (monShort === undefined) return day;
      return `${dd}-${monShort}-${yyyy}`;
    case "d_month_yyyy":
      if (monFull === undefined) return day;
      return `${Number(dd)} ${monFull} ${yyyy}`;
    case "month_d_yyyy":
      if (monFull === undefined) return day;
      return `${monFull} ${Number(dd)}, ${yyyy}`;
    case "d_mon_yyyy":
    default: {
      if (monShort === undefined) return day;
      return `${Number(dd)} ${monShort} ${yyyy}`;
    }
  }
}

/* ===========================================================================
 * CALENDAR ARITHMETIC ON A DAY STRING (R-426, S62-a).
 *
 * ⭐⭐ THE ONE PLACE THAT ADDS DAYS TO A `YYYY-MM-DD`. Five copies of this
 * arithmetic had grown — `BoardPage`'s `isoPlusDays` and
 * `mondayIsoOfWeekContaining`, `CommandBar`'s `isoWeekOf` and
 * `isoPlusDaysUtc`, `matrix.ts`'s `addDays`, `absence.ts`'s `nextDay`,
 * `api/absences.ts`'s `prevDay` — each with its own paragraph explaining why
 * UTC was safe here. The explanation was right every time and that is exactly
 * why it belongs in ONE place: the sixth copy is the one that gets it wrong.
 *
 * ⚠️⚠️ A DAY STRING IS NOT AN INSTANT, AND THIS FILE NEVER TREATS IT AS ONE.
 * The plant's zone is the one clock (R-426): which calendar day an INSTANT
 * falls on is decided by `partsInZone` in `src/lib/format/timezones.ts`, and
 * the instant a wall-clock names is decided by `zonedTimeToInstant` there.
 * Neither question is asked here. Once a day is already NAMED as
 * `"YYYY-MM-DD"`, its weekday and the day seven before it are the same in
 * every zone on earth, so the arithmetic below is zone-free by construction —
 * it uses `Date` only as `Date.UTC`'s calendar normaliser (month overflow,
 * leap years) and reads every part back with `getUTC*`. It must NEVER grow a
 * `getHours()`/`getDate()`/`toLocale*` call, and `dateSeam.test.ts` refuses
 * one anywhere outside this file and `time.ts`.
 *
 * ⚠️ MALFORMED IN, MALFORMED OUT — the same contract `formatCalendarDay`
 * keeps: an input that is not a real calendar day comes back unchanged rather
 * than mangled into a neighbouring one.
 * ======================================================================== */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is `iso` a well-formed AND REAL calendar day? `"2026-02-30"` and
 * `"2026-13-01"` are both shaped right and neither exists, so the shape test
 * alone is not enough — the round trip through UTC is what rejects them.
 *
 * The import parsers (`absenceImport`, `certificationImport`) validate through
 * this rather than each building their own midnight instant, which is what lets
 * the audit ban a raw `T00:00:00` literal everywhere but the seams.
 */
export function isCalendarDay(iso: string): boolean {
  if (!ISO_DAY.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * A WHICH-DAY MARKER for `iso`: the UTC-midnight `Date` whose UTC calendar day
 * IS `iso`.
 *
 * ⚠️⚠️ A MARKER IS NOT A MOMENT IN TIME, and everything that consumes one says
 * so. The board's window start (`boardView.ts`'s `windowStartDate`) is one:
 * `buildBoardIndex` reads its calendar day back with `getUTC*` and anchors THAT
 * DAY at the plant zone's own midnight through `zonedTimeToInstant`. So the
 * marker's job is to carry a date through code that wants a `Date` object; its
 * time-of-day and its UTC-ness are an encoding, not a claim about when
 * anything happens. Reading a marker with `getHours()`/`getDate()` — the
 * machine's zone — is the bug this encoding exists to make impossible.
 *
 * ⚠️⚠️ AN UNREAL DAY GIVES AN INVALID DATE, AND IT TAKES THE EXPLICIT CHECK TO
 * GET THAT. `new Date("2026-02-30T00:00:00.000Z")` does NOT throw and is NOT
 * Invalid in V8 — it silently normalises to 2 March, so a typo'd or corrupt day
 * would come back as a real one two days along with nothing to show for it.
 * Measured while pinning this. `isCalendarDay` is the round trip that catches
 * it, so every marker goes through it first and callers that take a day from a
 * typed `<input type="date">` keep their `Number.isNaN(d.getTime())` guard.
 */
export function dayMarker(iso: string): Date {
  return isCalendarDay(iso) ? new Date(`${iso}T00:00:00.000Z`) : new Date(NaN);
}

/** The calendar day a marker names, `"YYYY-MM-DD"` — `dayMarker`'s inverse.
 *  Empty string for an Invalid Date, which no caller can render as a day. */
export function isoOfDayMarker(marker: Date): string {
  return Number.isNaN(marker.getTime()) ? "" : marker.toISOString().slice(0, 10);
}

/** `iso` plus `days` calendar days (negative to go back), still `"YYYY-MM-DD"`.
 *  Month lengths and leap years are `Date.UTC`'s problem, which is the whole
 *  reason this is not string maths. */
export function isoPlusDays(iso: string, days: number): string {
  const d = dayMarker(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The weekday of `iso`, `0` = Sunday .. `6` = Saturday — `-1` if `iso` is not
 *  a real day. Zone-free: a named calendar day has one weekday everywhere. */
export function weekdayOfIso(iso: string): number {
  const d = dayMarker(iso);
  return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
}

/** The MONDAY of the week containing `iso` (Monday-first, so a Sunday resolves
 *  to the Monday six days behind it). `iso` unchanged if it is not a real day. */
export function isoMondayOfWeek(iso: string): string {
  const w = weekdayOfIso(iso);
  if (w === -1) return iso;
  return isoPlusDays(iso, w === 0 ? -6 : 1 - w);
}

/** The seven days of the week containing `iso`, Monday first. */
export function isoWeekDays(iso: string): string[] {
  const monday = isoMondayOfWeek(iso);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) out.push(isoPlusDays(monday, i));
  return out;
}
