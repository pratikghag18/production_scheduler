// F-159 -- the board's "today" is the PLANT's calendar day, not the UTC one.
//
// Reproduced 16 Sept at 19:09 America/Chicago (00:09Z on the 17th): the board
// opened on the 17th, `todayIndex` was -1, and a day-less sentence in the
// command bar answered "today is not on the board" with a Show-that-day button
// that computed today the same wrong way and so changed nothing. Every earlier
// walk and the typed spec ran in the afternoon, when the UTC date and the
// plant's date agree -- which is precisely why a fixed clock is the only thing
// that pins this. Each case below sets the system time explicitly; none of them
// reads the machine's own clock or its own zone.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useBoardViewStore } from "@/features/board/store/boardView";
import { buildDayAxis, startOfUtcDay, zonedTimeToInstant } from "@/features/board/lib/time";

const CHICAGO = "America/Chicago";
const TOKYO = "Asia/Tokyo";

/** 18:30 Chicago on the 16th -- the UTC date and the plant's date agree. */
const BEFORE_SEAM = "2026-09-16T23:30:00.000Z";
/** 19:30 Chicago on the 16th -- UTC has already rolled over to the 17th. */
const AFTER_SEAM = "2026-09-17T00:30:00.000Z";

/** The store's "which day" marker as a plain calendar date, for readable
 *  failures: a marker is a UTC midnight whose CALENDAR DAY is the day meant. */
function markerDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A pristine store -- the shape `create` gives it, before any interaction. */
function resetStore(marker: Date) {
  useBoardViewStore.setState({
    windowStartDate: marker,
    windowDayCount: 3,
    scrollToNowNonce: 1,
    windowMovedByUser: false,
    anchoredToZone: false,
  });
}

/**
 * `BoardPage`'s own `todayIndex`, rebuilt from the two lines that actually
 * produce it: `buildBoardIndex` turns the store's marker into that calendar
 * day's LOCAL midnight (`zonedTimeToInstant` on the marker's UTC parts) and
 * hands THAT to `buildDayAxis`; the memo then finds which visible day contains
 * `now`. Reproducing those lines rather than calling the index keeps this a
 * store test with no payload fixture, while still failing for the real reason.
 */
function todayIndexFor(marker: Date, dayCount: number, zone: string): number {
  const origin = zonedTimeToInstant(
    zone,
    marker.getUTCFullYear(),
    marker.getUTCMonth() + 1,
    marker.getUTCDate(),
    0,
    0,
  );
  const axis = buildDayAxis(origin, dayCount, zone);
  const now = new Date();
  return axis.dayStarts.findIndex(
    (s, i) => i < axis.dayCount && now >= s && now < axis.dayStarts[i + 1],
  );
}

describe("F-159: the default window's day is the plant's", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("TD-1: with the plant's zone the marker is the plant's date, on BOTH sides of the UTC midnight seam", () => {
    const { goToToday } = useBoardViewStore.getState();

    vi.setSystemTime(new Date(BEFORE_SEAM)); // 18:30 Chicago on the 16th
    resetStore(startOfUtcDay(new Date()));
    goToToday(CHICAGO);
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-16");

    vi.setSystemTime(new Date(AFTER_SEAM)); // 19:30 Chicago, still the 16th
    resetStore(startOfUtcDay(new Date()));
    goToToday(CHICAGO);
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-16");
  });

  it("TD-1b: the marker stays a UTC-midnight 'which day' marker -- only the DAY moved", () => {
    vi.setSystemTime(new Date(AFTER_SEAM));
    resetStore(startOfUtcDay(new Date()));
    useBoardViewStore.getState().goToToday(CHICAGO);
    const m = useBoardViewStore.getState().windowStartDate;
    expect(m.getUTCHours()).toBe(0);
    expect(m.getUTCMinutes()).toBe(0);
    expect(m.getUTCSeconds()).toBe(0);
    expect(m.getUTCMilliseconds()).toBe(0);
  });

  it("TD-2: east of UTC the day moves the OTHER way -- Tokyo at 16:00Z is already the next date", () => {
    vi.setSystemTime(new Date("2026-09-16T16:00:00.000Z")); // 01:00 on the 17th in Tokyo
    resetStore(startOfUtcDay(new Date()));
    useBoardViewStore.getState().goToToday(TOKYO);
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-17");
  });

  it("TD-3: with no zone the UTC date is the documented first guess (store init, before any payload)", () => {
    vi.setSystemTime(new Date(AFTER_SEAM));
    resetStore(startOfUtcDay(new Date()));
    useBoardViewStore.getState().goToToday();
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-17");
  });
});

describe("F-159: the page re-anchors the guess once, and never over a moved window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_SEAM)); // 19:30 Chicago on the 16th
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("TD-4: a store still on the UTC-date guess moves to the plant's day when the zone arrives -- once, and not as a user move", () => {
    resetStore(startOfUtcDay(new Date()));
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-17"); // the guess
    const nonceBefore = useBoardViewStore.getState().scrollToNowNonce;

    useBoardViewStore.getState().anchorToZone(CHICAGO);

    const after = useBoardViewStore.getState();
    expect(markerDay(after.windowStartDate)).toBe("2026-09-16");
    expect(after.windowMovedByUser).toBe(false);
    expect(after.anchoredToZone).toBe(true);
    expect(after.scrollToNowNonce).toBe(nonceBefore + 1);
  });

  it("TD-5: a window the user moved is NOT re-anchored when the zone arrives", () => {
    resetStore(startOfUtcDay(new Date()));
    useBoardViewStore.getState().shiftWindowByDays(2);
    const moved = useBoardViewStore.getState();
    expect(moved.windowMovedByUser).toBe(true);
    expect(markerDay(moved.windowStartDate)).toBe("2026-09-19");

    // The page's own guard, in the shape `BoardPage`'s effect applies it.
    const state = useBoardViewStore.getState();
    const shouldAnchor = !state.windowMovedByUser && !state.anchoredToZone;
    expect(shouldAnchor).toBe(false);
    expect(markerDay(useBoardViewStore.getState().windowStartDate)).toBe("2026-09-19");
  });

  it("TD-5b: every deliberate move marks the window as the user's -- goToToday included", () => {
    for (const move of [
      (s: ReturnType<typeof useBoardViewStore.getState>) => s.shiftWindowByDays(1),
      (s: ReturnType<typeof useBoardViewStore.getState>) =>
        s.setWindowStartDate(new Date("2026-09-20T00:00:00.000Z")),
      (s: ReturnType<typeof useBoardViewStore.getState>) => s.setWindowDayCount(7),
      (s: ReturnType<typeof useBoardViewStore.getState>) => s.goToToday(CHICAGO),
    ]) {
      resetStore(startOfUtcDay(new Date()));
      expect(useBoardViewStore.getState().windowMovedByUser).toBe(false);
      move(useBoardViewStore.getState());
      expect(useBoardViewStore.getState().windowMovedByUser).toBe(true);
    }
  });

  it("TD-6: the exact failure -- todayIndex is 0 on the plant's marker at 19:30 Chicago, and -1 on the UTC one", () => {
    const utcGuess = startOfUtcDay(new Date());
    expect(todayIndexFor(utcGuess, 3, CHICAGO)).toBe(-1); // what the defect saw

    resetStore(utcGuess);
    useBoardViewStore.getState().goToToday(CHICAGO);
    const plantMarker = useBoardViewStore.getState().windowStartDate;
    expect(todayIndexFor(plantMarker, 3, CHICAGO)).toBe(0);
  });

  it("TD-6b: in the afternoon -- when the two dates agree -- nothing changes, which is why this was invisible", () => {
    vi.setSystemTime(new Date(BEFORE_SEAM)); // 18:30 Chicago
    const utcGuess = startOfUtcDay(new Date());
    expect(todayIndexFor(utcGuess, 3, CHICAGO)).toBe(0);
    resetStore(utcGuess);
    useBoardViewStore.getState().goToToday(CHICAGO);
    expect(useBoardViewStore.getState().windowStartDate.getTime()).toBe(utcGuess.getTime());
  });
});
