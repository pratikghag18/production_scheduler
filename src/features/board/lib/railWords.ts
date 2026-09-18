/**
 * S65-a (R-438): THE RAIL'S BOOKING WORDS, PURE.
 *
 * The operator rail used to say how booked a person was with a count pill
 * ("2") and a dimmed chip when `isFullyAllocated` (`geometry.ts`) called the
 * WHOLE loaded window (a week, on a week board) fully covered -- a boolean
 * with no reading a supervisor could act on ("what would a full bar even
 * mean?", the maintainer, 17 Sept). R-438 replaces both with three words:
 * "free", "free HH:MM" (the first uncovered minute), "booked" -- measured
 * against a single BAND, not the whole window.
 *
 * `band` is resolved OUTSIDE this file (`rootBand`, below, from the board
 * ROOT's `ShiftTemplate` -- `templateForNode.get(rootId)`, the same source
 * `defaultShiftRange`/`shiftChipsFor` in `useDragGesture.ts` already read for
 * a cell's own shift chips) so `bookingWords` itself stays a pure function of
 * its four arguments, the same shape as `geometry.ts`'s `isFullyAllocated`.
 *
 * ⚠️ MINUTE SPACE. `blocks[].startMin/endMin` and `band.startMin/endMin` are
 * both "minutes since `window.start`" -- the same coordinate space
 * `IndexedAssignment` and `ShiftTemplate`'s own `Shift.startMin/endMin` share,
 * because `window.start` (== `BoardIndex.windowStart`, `boardIndex.ts`'s
 * `origin`) is always the PLANT-LOCAL MIDNIGHT of the window's first day
 * (D88a) -- so a shift's day-local minute 360 (06:00) IS window-relative
 * minute 360 too, with no offset to add. A night band's `endMin > 1440` is
 * exactly `ShiftRow`'s own note ("that is what a night shift IS",
 * `src/lib/api/shifts.ts`) and needs no special-case here: minutes past 1440
 * already name a minute in the window's SECOND day, the same way an
 * assignment that runs past midnight does.
 *
 * Times are read through `formatClock` (`../lib/time.ts`, one of
 * `dateSeam.test.ts`'s two allowed render seams) -- never a raw
 * `Intl.DateTimeFormat`/`getHours()` of this file's own, per CLAUDE.md
 * §7's one-clock standard.
 */
import type { ShiftTemplate } from "@/lib/api";
import { addMinutes, formatClock } from "./time";

/** Anything with a start/end in the shared minute space -- `IndexedAssignment`
 *  duck-typed the same way `geometry.ts`'s `isFullyAllocated` takes it. */
export interface RailBlock {
  startMin: number;
  endMin: number;
}

/** The window `bookingWords` measures against -- `start` is the instant
 *  minute 0 names, `minutes` its length. */
export interface RailWindow {
  start: Date;
  minutes: number;
}

/** A single span, in the same minute space as `RailBlock` -- the root's shift
 *  band, or (see `rootBand` below) `null` standing for "the window itself". */
export interface Band {
  startMin: number;
  endMin: number;
}

/**
 * R-438 DECIDED (session 178, "Yes to both"): the board ROOT's shift pattern
 * is the source, in the plant's zone; with no pattern on the root, the band
 * IS the window. `ShiftTemplate.shifts` can hold more than one band (a
 * day/swing/night pattern) -- nothing in the model yet says which one a given
 * OPERATOR belongs to (that is R-441, still `uncovered`).
 *
 * ⚠️ OR-1 (reviewer, S65-a review): taking the pattern's FIRST band only --
 * this file's original reading -- makes a person booked 14:00-22:00 on a
 * three-shift plant (06-14/14-22/22-06) read "free", because `bookingWords`
 * was never told about the 14-22 band at all; it only ever saw 06-14. Until
 * R-441 gives each person their OWN band, the interim reading is the
 * pattern's WHOLE covered span -- the earliest band's start to the latest
 * band's end (a night band's `endMin > 1440` included, so a 22-06 band pulls
 * the span's own end past midnight) -- so nothing booked inside ANY of the
 * plant's shifts is missed. The seam stays a plain `Band { startMin, endMin }`
 * so S66 can hand `bookingWords` a person's own single shift instead of
 * calling this function at all, once R-441 exists.
 */
export function rootBand(template: ShiftTemplate | null): Band | null {
  if (!template || template.shifts.length === 0) return null;
  let startMin = template.shifts[0].startMin;
  let endMin = template.shifts[0].endMin;
  for (const shift of template.shifts) {
    if (shift.startMin < startMin) startMin = shift.startMin;
    if (shift.endMin > endMin) endMin = shift.endMin;
  }
  return { startMin, endMin };
}

function clip(min: number, lo: number, hi: number): number {
  return Math.min(Math.max(min, lo), hi);
}

/**
 * "free" | "free HH:MM" | "booked", per R-438's claim:
 *  - "free" when nothing in `blocks` overlaps `band` at all, OR the first
 *    block inside `band` starts later than `band` itself does -- OR-1
 *    (reviewer, S65-a review): the band's own start is uncovered either way,
 *    and "free HH:MM" printing that same start time back said nothing a bare
 *    "free" didn't already say (see the OR-1 comment on the function body).
 *  - "free HH:MM" when the band's own start IS covered but not the whole
 *    band -- HH:MM is the minute after the covering run that starts at the
 *    band's own start ends.
 *  - "booked" when `band` is covered end to end.
 *
 * `band === null` (no pattern on the root): the band IS the window
 * (`[0, window.minutes)`), R-438's own fallback.
 */
export function bookingWords<T extends RailBlock>(
  blocks: readonly T[],
  window: RailWindow,
  band: Band | null,
  zone?: string,
): string {
  const b = band ?? { startMin: 0, endMin: window.minutes };

  const covering = blocks
    .filter((blk) => blk.startMin < b.endMin && blk.endMin > b.startMin)
    .map((blk) => ({
      start: clip(blk.startMin, b.startMin, b.endMin),
      end: clip(blk.endMin, b.startMin, b.endMin),
    }))
    .sort((a, c) => a.start - c.start);

  if (covering.length === 0) return "free";

  let covered = b.startMin;
  for (const span of covering) {
    if (span.start > covered) break; // a gap opens exactly at `covered`
    covered = Math.max(covered, span.end);
  }

  if (covered >= b.endMin) return "booked";

  // OR-1 (reviewer, S65-a review): the first uncovered minute landing on the
  // band's OWN start means nothing covers the very beginning of the span --
  // exactly the same fact `covering.length === 0` above already reports as
  // bare "free". Printing the clock time back in that case ("free 06:00" when
  // the band itself starts at 06:00) adds no information over plain "free"
  // and, now that `band` is the pattern's WHOLE covered span (not one
  // person's own shift), reads actively wrong: a person booked 14:00-22:00
  // inside a 06:00-06:00(+1d) span has `covered === b.startMin` for the exact
  // same reason a person with no booking anywhere in the span does, so both
  // must read the same word -- "free" -- rather than a "free 06:00" that
  // looks like every chip is stuck reporting the shift's own start time and
  // says nothing about the booking that exists later in the span. "free
  // HH:MM" is reserved for when SOME of the span's own start IS covered and
  // the person becomes free partway through.
  if (covered === b.startMin) return "free";
  return `free ${formatClock(addMinutes(window.start, covered), zone)}`;
}
