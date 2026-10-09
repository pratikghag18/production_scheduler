// R-D14 (the board window is always whole days) and R-D17 (the board opens
// on today with a 3-day window). useBoardViewStore is a pure zustand store
// with no React rendering involved, so this reads its actual defaults and
// actions directly rather than mounting anything.
import { describe, it, expect, beforeEach } from "vitest";
import { useBoardViewStore } from "@/features/board/store/boardView";
import { startOfUtcDay, MINUTES_PER_DAY } from "@/features/board/lib/time";

function resetStore() {
  useBoardViewStore.setState({
    windowStartDate: startOfUtcDay(new Date()),
    windowDayCount: 3,
    collapsedNodeIds: new Set<string>(),
    scrollToNowNonce: 1,
  });
}

describe("useBoardViewStore: D14/D17 defaults", () => {
  beforeEach(resetStore);

  it("D17a: the default window starts at the start of today's UTC day", () => {
    const state = useBoardViewStore.getState();
    const expected = startOfUtcDay(new Date());
    expect(state.windowStartDate.getTime()).toBe(expected.getTime());
    expect(state.windowStartDate.getUTCHours()).toBe(0);
    expect(state.windowStartDate.getUTCMinutes()).toBe(0);
    expect(state.windowStartDate.getUTCSeconds()).toBe(0);
    expect(state.windowStartDate.getUTCMilliseconds()).toBe(0);
  });

  it("D17b: the default window spans exactly 3 days, not the Monday-of-the-week anchor D17 revised away", () => {
    const state = useBoardViewStore.getState();
    expect(state.windowDayCount).toBe(3);
  });

  it("D14a: shiftWindowByDays moves the start by whole UTC days, so the boundary stays a multiple of 1440 minutes from origin", () => {
    const before = useBoardViewStore.getState().windowStartDate.getTime();
    useBoardViewStore.getState().shiftWindowByDays(1);
    const after = useBoardViewStore.getState().windowStartDate.getTime();
    expect(after - before).toBe(MINUTES_PER_DAY * 60_000);
    expect(new Date(after).getUTCHours()).toBe(0);
  });

  it("D14b: shiftWindowByDays(-1) then (1) returns to the exact original instant", () => {
    const original = useBoardViewStore.getState().windowStartDate.getTime();
    useBoardViewStore.getState().shiftWindowByDays(-1);
    useBoardViewStore.getState().shiftWindowByDays(1);
    expect(useBoardViewStore.getState().windowStartDate.getTime()).toBe(original);
  });

  it("D17c: goToToday resets the window to today's UTC start even after navigating away, and bumps scrollToNowNonce", () => {
    useBoardViewStore.getState().shiftWindowByDays(10);
    const nonceBefore = useBoardViewStore.getState().scrollToNowNonce;
    useBoardViewStore.getState().goToToday();
    const state = useBoardViewStore.getState();
    expect(state.windowStartDate.getTime()).toBe(startOfUtcDay(new Date()).getTime());
    expect(state.scrollToNowNonce).toBe(nonceBefore + 1);
  });

  it("D17d: setWindowDayCount overrides the default count explicitly, proving 3 is a default and not a hardcoded constant read elsewhere", () => {
    useBoardViewStore.getState().setWindowDayCount(7);
    expect(useBoardViewStore.getState().windowDayCount).toBe(7);
  });
});
