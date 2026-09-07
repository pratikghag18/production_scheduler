/**
 * leave.ts — the one place a board pop-up turns `absenceGaps`' answer into the
 * sentence a planner reads (R-357). Both `CreatePopover` and `AssignmentPopover`
 * call it, so the two cannot drift into two different phrasings of "on leave".
 *
 * The dates come out of `absence_overlap` / `absenceGaps` as inclusive
 * `YYYY-MM-DD`, and are shown through the app's date seam in the org's chosen
 * format — the same seam the expired-certificate line uses (R-338), so a plant
 * on `dd/mm/yyyy` reads its absences in `dd/mm/yyyy` too.
 */
import { formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import type { AbsenceHit } from "@/lib/absence";

/**
 * "On leave 14 Sep 2026 – 18 Sep 2026: sick" — or, for a one-day absence, "On
 * leave 14 Sep 2026: sick". The reason is the person's own free text; a blank
 * one (the server forbids it, but a mirror should never throw) drops the colon.
 */
export function leaveLine(hit: AbsenceHit, dateFormat: DateFormat): string {
  const from = formatCalendarDay(hit.from, dateFormat);
  const to = formatCalendarDay(hit.to, dateFormat);
  const when = hit.from === hit.to ? from : `${from} – ${to}`;
  const reason = hit.reason.trim() === "" ? "" : `: ${hit.reason}`;
  return `On leave ${when}${reason}`;
}
