/**
 * S66-c (R-448): "THE RAIL SHOWS THE PEOPLE ON SHIFT NOW."
 *
 * `bandCoveringNow` answers exactly one question — of the board ROOT's shift
 * pattern, which band (if any) covers the plant's clock at `now` — and does
 * it purely, off arguments alone, so it can be pinned with a frozen clock
 * (CLAUDE.md §7: "a clock-dependent bug needs a pin with a frozen clock, in
 * both directions"). `OperatorPanel.tsx` is the one caller; it supplies `now`
 * (refreshed once a minute) and `zone` (the plant's own, off the board
 * payload) and reads no clock of its own.
 *
 * ⚠️ THE MINUTE-OF-DAY READING GOES THROUGH `partsInZone` (`@/lib/format/
 * timezones`), NEVER `getHours()`/`getMinutes()` — the machine's zone is
 * exactly the bug R-426 exists to prevent, and `dateSeam.test.ts` would
 * refuse a getter here outright. `partsInZone` is not itself a needle: it is
 * the primitive every non-seam file is meant to call.
 *
 * A NIGHT BAND (`endMin > 1440`, `Shift`'s own shape: "that is what a night
 * shift IS") covers `now` two ways, because its ONE instance straddles
 * midnight: `minuteOfDay >= startMin` is "the band that started earlier
 * today and has not yet ended", `minuteOfDay < endMin - 1440` is "the band
 * that started YESTERDAY and has not yet ended" — the two halves of the same
 * wrap, read from whichever side of midnight `now` currently sits on.
 */
import type { Shift, ShiftTemplate } from "@/lib/api";
import { partsInZone } from "@/lib/format/timezones";

/**
 * The band of `template`'s pattern whose daily window covers `now`, in
 * `zone` — `null` when `template` has no shifts, or when `now` falls in a
 * gap no band covers (shifts need not tile the whole day). The FIRST
 * matching band wins when two bands overlap, which is the array's own
 * declared order, same as `rootBand`'s "earliest start" reading elsewhere in
 * this file's sibling.
 */
export function bandCoveringNow(
  template: ShiftTemplate | null,
  now: Date,
  zone: string,
): Shift | null {
  if (!template || template.shifts.length === 0) return null;
  const parts = partsInZone(now, zone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  for (const shift of template.shifts) {
    if (shift.endMin <= 1440) {
      if (minuteOfDay >= shift.startMin && minuteOfDay < shift.endMin) return shift;
    } else if (minuteOfDay >= shift.startMin || minuteOfDay < shift.endMin - 1440) {
      return shift;
    }
  }
  return null;
}
