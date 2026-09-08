/**
 * leave.ts — the one place a board pop-up turns `absenceGaps`' answer into the
 * sentence a planner reads (R-357, R-359). Both `CreatePopover` and
 * `AssignmentPopover` call it, so the two cannot drift into two different
 * phrasings of "on leave".
 *
 * The dates come out of `absence_overlap` / `absenceGaps` as inclusive
 * `YYYY-MM-DD`, and are shown through the app's date seam in the org's chosen
 * format — the same seam the expired-certificate line uses (R-338), so a plant
 * on `dd/mm/yyyy` reads its absences in `dd/mm/yyyy` too.
 *
 * ⚠️ `zone` IS OPTIONAL AND DEFAULTS TO `BOARD_ZONE` ("UTC") so every existing
 * caller — none of which knows the absent person's own plant zone yet — keeps
 * compiling and keeps its whole-day sentence byte for byte; a whole-day hit
 * never reads `zone` at all. A part-day hit's hours are read in whichever zone
 * is passed, which must be the PERSON'S OWN plant zone (R-359 decision 4, not
 * the reader's plant filter) for the hours to mean what they say.
 */
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import type { AbsenceHit } from "@/lib/absence";
import { BOARD_ZONE, formatClock } from "./time";

/**
 * "On leave 14 Sep 2026 – 18 Sep 2026: sick" for a whole-day hit (unchanged);
 * "On leave 14 Sep 2026, 09:00–13:00: sick" for a part-day one, the hours read
 * in `zone`. The reason is the person's own free text; a blank one (the server
 * forbids it, but a mirror should never throw) drops the colon.
 */
export function leaveLine(
  hit: AbsenceHit,
  dateFormat: DateFormat,
  zone: string = BOARD_ZONE,
): string {
  const from = formatCalendarDay(hit.from, dateFormat);
  const reason = hit.reason.trim() === "" ? "" : `: ${hit.reason}`;
  if (hit.startsAt !== undefined && hit.endsAt !== undefined) {
    const hours = `${formatClock(new Date(hit.startsAt), zone)}–${formatClock(new Date(hit.endsAt), zone)}`;
    return `On leave ${from}, ${hours}${reason}`;
  }
  const to = formatCalendarDay(hit.to, dateFormat);
  const when = hit.from === hit.to ? from : `${from} – ${to}`;
  return `On leave ${when}${reason}`;
}
