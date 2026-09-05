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
 * ⚠️ PURE STRING WORK — no `Date`, no `Intl`, no timezone. A Postgres `date`
 * (`operator_skills.certified_at` / `expires_at`) arrives as `"YYYY-MM-DD"` and
 * is timezone-less by construction; parsing it through `new Date("2026-09-03")`
 * would reinterpret it as UTC midnight and print the day before it for anyone
 * west of Greenwich (the reasoning `operators.ts` recorded when it first wrote
 * `formatDay` by hand). Reformatting the string sidesteps that class of bug
 * entirely.
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
