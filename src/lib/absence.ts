/**
 * absence.ts — the client's copy of `absence_overlap` (migration 0066), reached
 * on the board for the window a placement is about to be written, so a person on
 * leave is marked before Save the way an expired certificate is (R-357, R-338).
 *
 * ⭐ THE SERVER'S RULE, TRANSCRIBED RATHER THAN APPROXIMATED. `absence_overlap`
 * answers about the calendar DAYS a shift TOUCHES, in the server's date terms:
 *
 *     v_days = the days [d, d+1) that overlap the shift's tstzrange
 *     absent = EXISTS an absence whose stored daterange && v_days
 *
 * and an absence is stored `daterange(from, to, '[]')` — both ends inclusive.
 * Two boundaries are load-bearing and are pinned on BOTH sides (this module's
 * test and 88_absences_test.sql), by the same names:
 *
 *  1. A shift ENDING EXACTLY at midnight touches only the days strictly BEFORE
 *     that midnight. `[Mon 06:00, Tue 00:00)` touches Monday alone, so an absence
 *     that STARTS on Tuesday does not clash with it.
 *  2. An absence ENDING on the day a shift STARTS does clash — both name that
 *     day.
 *
 * ⭐ THE DAYS ARE COMPUTED IN UTC AND COMPARED AS TEXT, exactly as
 * `certificateGaps` does (boardIndex.ts): every date here is a fixed-width
 * zero-padded `"YYYY-MM-DD"`, for which lexicographic order IS chronological
 * order, and no `Date` is ever built from a timezone-less day — the bug
 * `src/lib/format/dates.ts` was written to end. The seed and every PostgREST
 * session run in UTC (D10), so the server's `::date` is this module's UTC day.
 *
 * Dependency-free, so it runs under `node --experimental-strip-types` and
 * `src/test/absence.test.ts` covers it without a network.
 */

/** One absence, in the server's date terms — `from`/`to` inclusive `YYYY-MM-DD`. */
export interface AbsenceRow {
  operatorId: string;
  from: string;
  to: string;
  reason: string;
}

/** The first overlapping absence, shaped like `absence_overlap`'s answer. */
export interface AbsenceHit {
  from: string;
  to: string;
  reason: string;
}

/** The window a placement is about to occupy. `end === null` is open-ended. */
export interface AbsenceWindow {
  start: Date;
  end: Date | null;
}

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whether an instant is exactly a UTC midnight (00:00:00.000). */
function isUtcMidnight(d: Date): boolean {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

/** The day after a `YYYY-MM-DD`, still `YYYY-MM-DD`. Built at explicit UTC. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDay(d);
}

/**
 * The first absence overlapping the DAYS `window` touches, for this operator, or
 * `null` (eligible). Mirrors `absence_overlap` day-for-day: `absent`, `from`,
 * `to`, `reason`.
 *
 * @param absences every absence the reader can see (any operator; filtered here).
 * @param operatorId the person being placed.
 * @param window the range being written; `end === null` is an open-ended window.
 */
export function absenceGaps(
  absences: readonly AbsenceRow[],
  operatorId: string,
  window: AbsenceWindow,
): AbsenceHit | null {
  const startDay = utcDay(window.start);

  // The upper-EXCLUSIVE day bound of the touched-day set. `null` = open-ended.
  let upperExcl: string | null;
  if (window.end === null) {
    upperExcl = null;
  } else if (isUtcMidnight(window.end)) {
    // ends at midnight: the last touched day is the day before, so the
    // exclusive bound is that midnight's own date.
    upperExcl = utcDay(window.end);
  } else {
    // ends mid-day: that day is touched, so the exclusive bound is the next day.
    upperExcl = nextDay(utcDay(window.end));
  }

  // A day d is touched iff startDay <= d < upperExcl (or, open-ended, d >=
  // startDay). An absence [from, to] overlaps that set iff its from is before
  // the exclusive bound AND its to is on or after the start day. Earliest-first,
  // to match the server's `ORDER BY lower(daterange) LIMIT 1`.
  const mine = absences
    .filter((a) => a.operatorId === operatorId)
    .slice()
    .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));

  for (const a of mine) {
    const startsBeforeBound = upperExcl === null || a.from < upperExcl;
    const endsAtOrAfterStart = a.to >= startDay;
    if (startsBeforeBound && endsAtOrAfterStart) {
      return { from: a.from, to: a.to, reason: a.reason };
    }
  }
  return null;
}
