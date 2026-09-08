/**
 * absence.ts — the client's copy of `absence_overlap` (migrations 0066, 0069),
 * reached on the board for the window a placement is about to be written, so a
 * person on leave is marked before Save the way an expired certificate is
 * (R-357, R-338, R-359).
 *
 * ⭐ THE SERVER'S RULE, TRANSCRIBED RATHER THAN APPROXIMATED. `absence_overlap`
 * answers about the calendar DAYS a shift TOUCHES for a WHOLE-DAY absence, in
 * the server's date terms:
 *
 *     v_days = the days [d, d+1) that overlap the shift's tstzrange
 *     absent = EXISTS a whole-day absence whose stored daterange && v_days
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
 * ⭐⭐ R-359 / 0069 — A PART-DAY ABSENCE IS JUDGED BY THE HOURS, NOT THE DAY.
 * `startsAt`/`endsAt` (ISO instant strings, `Date.toISOString()`'s fixed-width
 * `Z` form — the same "compare as text" trick as the UTC days above, since that
 * format is lexicographically ordered) mirror the server's `starts_at`/
 * `ends_at` keys and `timerange` column: an ABSOLUTE instant range, already
 * converted from wall-clock ON THE CLIENT (`zonedTimeToInstant`, the person's
 * plant zone — R-353's rule that only the client computes wall-clock
 * geometry). This module never imports that conversion or anything else — see
 * "dependency-free" below — so a caller builds the instants first and hands
 * them in already resolved. The overlap test mirrors Postgres's `&&` on two
 * `[)` ranges exactly: `s1 < e2 AND s2 < e1`, with an open-ended placement
 * window (`end === null`) standing for +infinity on that side, which is why an
 * open-ended window overlaps a part-day absence whenever the window's start is
 * before the absence's end. Pinned on both sides by the same names as
 * 88_absences_test.sql's AB15/AB16/AB17.
 *
 * Dependency-free, so it runs under `node --experimental-strip-types` and
 * `src/test/absence.test.ts` covers it without a network.
 */

/**
 * One absence, in the server's terms. `from`/`to` are the inclusive
 * `YYYY-MM-DD` day it falls on (a whole-day absence may span several days; a
 * part-day absence's `from` and `to` are the same single day). `startsAt`/
 * `endsAt` are present together, ISO instants, exactly when the row is a
 * part-day absence (R-359) — absent on a whole-day row, mirroring the
 * server's additive `starts_at`/`ends_at` keys.
 */
export interface AbsenceRow {
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  startsAt?: string;
  endsAt?: string;
}

/** The first overlapping absence, shaped like `absence_overlap`'s answer. */
export interface AbsenceHit {
  from: string;
  to: string;
  reason: string;
  startsAt?: string;
  endsAt?: string;
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
  // startDay). A whole-day absence [from, to] overlaps that set iff its from is
  // before the exclusive bound AND its to is on or after the start day.
  //
  // Sorted by effective start (`from`, the same day for both kinds — a
  // part-day row's `from`/`to` are always that one day), then whole-day before
  // part-day on a tied day (`startsAt === undefined` first) — the same
  // deterministic order 0069's `ORDER BY coalesce(lower(timerange)::date,
  // lower(daterange)), lower(timerange) NULLS FIRST` gives, so the row picked
  // when several would answer "absent" is the same one on both sides.
  const mine = absences
    .filter((a) => a.operatorId === operatorId)
    .slice()
    .sort((x, y) => {
      if (x.from !== y.from) return x.from < y.from ? -1 : 1;
      const xPartDay = x.startsAt !== undefined;
      const yPartDay = y.startsAt !== undefined;
      if (xPartDay !== yPartDay) return xPartDay ? 1 : -1;
      if (!xPartDay) return 0;
      return (x.startsAt as string) < (y.startsAt as string)
        ? -1
        : (x.startsAt as string) > (y.startsAt as string)
          ? 1
          : 0;
    });

  // The window's bounds as ISO instants, for the part-day (hours) test below —
  // `Date.toISOString()`'s fixed-width `Z` form, comparable as text exactly as
  // the UTC day strings above are (see the header).
  const windowStartIso = window.start.toISOString();
  const windowEndIso = window.end === null ? null : window.end.toISOString();

  for (const a of mine) {
    if (a.startsAt !== undefined && a.endsAt !== undefined) {
      // R-359: a part-day absence is judged by the HOURS, mirroring Postgres's
      // `&&` on two `[)` ranges: s1 < e2 AND s2 < e1. An open-ended placement
      // window (`windowEndIso === null`) stands for +infinity on that side, so
      // it overlaps a part-day absence whenever the window starts before the
      // absence ends — "an open-ended window overlaps any part-day window that
      // ends at or after its start" (the boundary AB16/AB17 pin).
      const startsBeforeWindowEnd = windowEndIso === null || a.startsAt < windowEndIso;
      const windowStartsBeforeEnds = windowStartIso < a.endsAt;
      if (startsBeforeWindowEnd && windowStartsBeforeEnds) {
        return { from: a.from, to: a.to, reason: a.reason, startsAt: a.startsAt, endsAt: a.endsAt };
      }
      continue;
    }
    const startsBeforeBound = upperExcl === null || a.from < upperExcl;
    const endsAtOrAfterStart = a.to >= startDay;
    if (startsBeforeBound && endsAtOrAfterStart) {
      return { from: a.from, to: a.to, reason: a.reason };
    }
  }
  return null;
}
