/**
 * View-state-only store (brief P1-4a §9, extended by P1-4c D46 and P1-4d
 * D53 for density). Holds zoom, density mode, collapse, the requested
 * window, and the operator panel's open/closed state — nothing
 * server-derived. React Query owns `BoardWindow`; this store never holds a
 * copy of it.
 */
import { create } from "zustand";
import { partsInZone } from "@/lib/format/timezones";
import type { ZoomIndex, DensityMode } from "../lib/geometry";
import { startOfUtcDay, MINUTES_PER_DAY, MS_PER_MINUTE } from "../lib/time";

export interface BoardViewState {
  zoomIndex: ZoomIndex;
  /**
   * P1-4d D53 (amends P1-4c D46): `"fit"` computes the vertical scale
   * automatically from the measured available height (see
   * `computeFitScale`/`scaleDensity` in `lib/geometry.ts`); `0 | 1 | 2`
   * is a manual override that turns Fit off and renders that named
   * density unscaled, exactly as P1-4c did before this brief. Default
   * `"fit"`.
   */
  densityMode: DensityMode;
  collapsedNodeIds: Set<string>;
  windowStartDate: Date;
  windowDayCount: number;
  operatorPanelOpen: boolean;
  selectedRootPath: string | null;
  /** Bumped to ask `BoardGrid` to scroll the current instant into view. */
  scrollToNowNonce: number;
  /**
   * F-159: has a PERSON chosen which day the board shows? False from init
   * until the first `setWindowStartDate` / `shiftWindowByDays` /
   * `setWindowDayCount` / `goToToday` — `goToToday` is a deliberate move
   * too. `BoardPage` only re-anchors the window onto the plant's calendar
   * day (below) while this is false; a window somebody moved is never
   * yanked back under them.
   */
  windowMovedByUser: boolean;
  /**
   * F-159: has the page already re-anchored the window onto the plant's
   * zone? The zone rides on the board payload, so the store is initialised
   * with the UTC date as a first guess and corrected once. This flag is
   * what stops that correction from looping.
   */
  anchoredToZone: boolean;

  setZoomIndex: (index: ZoomIndex) => void;
  setDensityMode: (mode: DensityMode) => void;
  setWindowStartDate: (date: Date) => void;
  setWindowDayCount: (days: number) => void;
  setOperatorPanelOpen: (open: boolean) => void;
  setSelectedRootPath: (path: string) => void;
  toggleCollapsed: (nodeId: string) => void;
  shiftWindowByDays: (delta: number) => void;
  goToToday: (zone?: string) => void;
  /**
   * F-159: the page's ONE automatic correction, once the payload has said
   * which zone the plant keeps. Deliberately NOT `goToToday`: this is not a
   * person moving the window, so it leaves `windowMovedByUser` false (a
   * later re-anchor is still allowed to be refused for the right reason)
   * and sets `anchoredToZone` instead.
   */
  anchorToZone: (zone: string) => void;
}

/**
 * D17 (REVISED 2026-08-24): the default window starts on **today**, not
 * on the Monday of the current week.
 *
 * The original rule made the board open on Monday whatever day it actually
 * was, so opening it on a Friday put the useful part of the schedule four
 * days off the right-hand edge — the user had to scroll to find the present
 * before doing anything. "Today first" is what a scheduling board is for.
 * The Monday anchor was only ever chosen to line up with the seed's own
 * anchor (D10), which is a fixture concern, not a product one.
 *
 * ⭐ F-159: "TODAY" IS THE PLANT'S CALENDAR DAY, NOT THE UTC ONE. What this
 * returns is a "which day" MARKER — a UTC midnight whose CALENDAR DATE is the
 * day meant; `buildBoardIndex` re-anchors that date at the plant zone's own
 * midnight (`zonedTimeToInstant`). The marker's shape is unchanged; only which
 * date it names moved. `startOfUtcDay(new Date())` named the UTC date, so at
 * 19:09 in America/Chicago (00:09Z the next day) the board opened on TOMORROW
 * and today was off it entirely — `todayIndex` -1, and the command bar's "today
 * is not on the board" with a Show-that-day button that computed today the same
 * wrong way and so changed nothing.
 *
 * With a `zone` the date is read in that zone. WITHOUT one it stays the UTC
 * date, and that is a documented FIRST GUESS, not an answer: the store is
 * created before any board payload has landed, and the plant's zone rides on
 * that payload. `BoardPage` corrects the guess once the zone is known
 * (`anchorToZone`), which is why the guess only has to be close, not right.
 */
function defaultWindowStart(zone?: string): Date {
  if (zone === undefined) return startOfUtcDay(new Date());
  const p = partsInZone(new Date(), zone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

export const useBoardViewStore = create<BoardViewState>((set) => ({
  zoomIndex: 1, // D16: default Standard
  densityMode: "fit", // D53: default Fit — automatic vertical scale
  collapsedNodeIds: new Set<string>(),
  windowStartDate: defaultWindowStart(),
  windowDayCount: 3, // D17
  operatorPanelOpen: true,
  selectedRootPath: null,
  // Starts at 1, not 0, so the first mount scrolls to now exactly once.
  scrollToNowNonce: 1,
  windowMovedByUser: false, // F-159
  anchoredToZone: false, // F-159

  setZoomIndex: (index) => set({ zoomIndex: index }),
  setDensityMode: (mode) => set({ densityMode: mode }),
  setWindowStartDate: (date) => set({ windowStartDate: date, windowMovedByUser: true }),
  setWindowDayCount: (days) => set({ windowDayCount: days, windowMovedByUser: true }),
  setOperatorPanelOpen: (open) => set({ operatorPanelOpen: open }),

  /**
   * Which place the board is showing. ⚠️ A REMEMBERED CHOICE OUTLIVES THE
   * IDENTITY THAT MADE IT — the dev switcher changes person with no reload,
   * and React Query resets its cache on that while this store does not. So
   * this is only ever a HINT: `resolveRootPath` drops it when the server's
   * list no longer contains it. See `../lib/rootSelection`, case W5.
   */
  setSelectedRootPath: (path) => set({ selectedRootPath: path }),

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
      windowMovedByUser: true, // F-159
    })),

  /**
   * Jump back to today AND re-scroll so the current instant is on screen.
   * F-159: `zone` is the PLANT's zone (`BoardPage` reads it off the payload
   * and passes it from both the Today button and the command bar's "Show
   * that day" for "today"); without it the UTC date is the first guess, as
   * at store-init.
   */
  goToToday: (zone) =>
    set((state) => ({
      windowStartDate: defaultWindowStart(zone),
      scrollToNowNonce: state.scrollToNowNonce + 1,
      windowMovedByUser: true,
    })),

  /**
   * F-159: the page's one automatic correction of the store's zone-free
   * first guess. Same marker `goToToday(zone)` would produce, and the same
   * scroll-to-now, but it is not a person's choice: `windowMovedByUser`
   * stays false and `anchoredToZone` becomes true, so this can happen at
   * most once and never over a window somebody moved.
   */
  anchorToZone: (zone) =>
    set((state) => ({
      windowStartDate: defaultWindowStart(zone),
      scrollToNowNonce: state.scrollToNowNonce + 1,
      anchoredToZone: true,
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
