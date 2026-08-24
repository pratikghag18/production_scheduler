/**
 * View-state-only store (brief P1-4a §9). Holds zoom, collapse, the
 * requested window, and the operator panel's open/closed state — nothing
 * server-derived. React Query owns `BoardWindow`; this store never holds a
 * copy of it.
 */
import { create } from "zustand";
import type { ZoomIndex } from "../lib/geometry";
import { startOfUtcDay, MINUTES_PER_DAY, MS_PER_MINUTE } from "../lib/time";

export interface BoardViewState {
  zoomIndex: ZoomIndex;
  collapsedNodeIds: Set<string>;
  windowStartDate: Date;
  windowDayCount: number;
  operatorPanelOpen: boolean;
  /** Bumped to ask `BoardGrid` to scroll the current instant into view. */
  scrollToNowNonce: number;

  setZoomIndex: (index: ZoomIndex) => void;
  setWindowStartDate: (date: Date) => void;
  setWindowDayCount: (days: number) => void;
  setOperatorPanelOpen: (open: boolean) => void;
  toggleCollapsed: (nodeId: string) => void;
  shiftWindowByDays: (delta: number) => void;
  goToToday: () => void;
}

/**
 * D17 (REVISED 2026-08-24): the default window starts on **today**, not on
 * the Monday of the current week.
 *
 * The original rule made the board open on Monday whatever day it actually
 * was, so opening it on a Friday put the useful part of the schedule four
 * days off the right-hand edge — the user had to scroll to find the present
 * before doing anything. "Today first" is what a scheduling board is for.
 * The Monday anchor was only ever chosen to line up with the seed's own
 * anchor (D10), which is a fixture concern, not a product one.
 */
function defaultWindowStart(): Date {
  return startOfUtcDay(new Date());
}

export const useBoardViewStore = create<BoardViewState>((set) => ({
  zoomIndex: 1, // D16: default Standard
  collapsedNodeIds: new Set<string>(),
  windowStartDate: defaultWindowStart(),
  windowDayCount: 3, // D17
  operatorPanelOpen: true,
  // Starts at 1, not 0, so the first mount scrolls to now exactly once.
  scrollToNowNonce: 1,

  setZoomIndex: (index) => set({ zoomIndex: index }),
  setWindowStartDate: (date) => set({ windowStartDate: date }),
  setWindowDayCount: (days) => set({ windowDayCount: days }),
  setOperatorPanelOpen: (open) => set({ operatorPanelOpen: open }),

  /**
   * Prev/Next day. Moves the window start by whole UTC days so D14 (the
   * window is always whole UTC days) keeps holding — day boundaries stay at
   * exact multiples of 1440 minutes from the origin.
   */
  shiftWindowByDays: (delta) =>
    set((state) => ({
      windowStartDate: new Date(
        state.windowStartDate.getTime() + delta * MINUTES_PER_DAY * MS_PER_MINUTE,
      ),
    })),

  /** Jump back to today AND re-scroll so the current instant is on screen. */
  goToToday: () =>
    set((state) => ({
      windowStartDate: defaultWindowStart(),
      scrollToNowNonce: state.scrollToNowNonce + 1,
    })),

  toggleCollapsed: (nodeId) =>
    set((state) => {
      // T3: collapsedNodeIds may reference nodes that no longer exist for
      // the current identity — that is harmless and must NOT be pruned, so
      // this only ever adds/removes the one id being toggled.
      const next = new Set(state.collapsedNodeIds);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { collapsedNodeIds: next };
    }),
}));
