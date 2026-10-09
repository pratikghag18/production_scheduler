import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { BoardGrid } from "@/features/board/components/BoardGrid";
import { buildBoardIndex } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import type { BoardWindow } from "@/lib/api";
import type { TrackRowDragApi } from "@/features/board/components/TrackRow";

/**
 * R-051: zoom preserves the instant at the horizontal centre of the TRACK
 * area (viewport width minus the sticky rail), so repeated zooming does not
 * drift. BoardGrid.tsx's T2 effect (lines ~407-439) does the math from
 * `viewport.width`/`railWidth`/`trackWidth` state, all of which only get
 * populated by a REAL ResizeObserver callback -- jsdom's stub (setup.ts) is a
 * no-op that never fires one. This file supplies a controllable fake
 * ResizeObserver, local to this file only, that lets a test manually trigger
 * the callback with a fake contentRect -- the standard way to test
 * ResizeObserver-driven code without a real layout engine.
 *
 * ⚠️ railWidth cannot be exercised this way. It comes from
 * `getComputedStyle(railProbe).width`, which jsdom (no CSS engine) resolves
 * to "0px" regardless of the actual stylesheet -- so this test proves the
 * centring math with railWidth pinned at 0, not the real ~232px. The
 * calculation itself (`trackViewport = viewport.width - railWidth`) is
 * exercised either way; only the specific railWidth VALUE is a genuine jsdom
 * ceiling, same wall R-D77 and R-057 hit for CSS custom properties.
 */

let roCallback: ResizeObserverCallback | null = null;
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
function fireResize(width: number, height: number) {
  roCallback?.(
    [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
    null as unknown as ResizeObserver,
  );
}

function makeFixture(): BoardWindow {
  return {
    org: { id: "org-1", name: "Org" },
    levels: [
      { id: "lvl-cell", templateId: "tpl-a", position: 0, name: "Cell", isSchedulable: true },
    ],
    nodes: [
      {
        id: "n-cell1",
        parentId: null,
        levelId: "lvl-cell",
        name: "Cell 1",
        path: "cell_1",
        sortOrder: 0,
        active: true,
      },
    ],
    runs: [],
    assignments: [],
    operators: [],
    products: [],
    skills: [],
    nodeSkillRequirements: [],
    shiftTemplates: [],
    nodeShiftMap: [],
    cycleTimes: [],
    nodePolicies: [],
    canPlace: true,
    dateFormat: "dmy_dot",
    zone: "UTC",
  } as unknown as BoardWindow;
}

const STANDARD = DENSITIES[1];
const windowStart = new Date("2026-09-07T00:00:00.000Z");
const windowEnd = new Date("2026-09-08T00:00:00.000Z");

function makeDragApi(): TrackRowDragApi {
  return {
    activeDrag: null,
    beginBlockDrag: vi.fn(),
    updateBlockDrag: vi.fn(),
    endBlockDrag: vi.fn(),
    cancelDrag: vi.fn(),
    beginTrackCreateDrag: vi.fn(),
    updateTrackCreateDrag: vi.fn(),
    endTrackCreateDrag: vi.fn(),
    handleBlockKeyDown: vi.fn(),
    handleBlockKeyUp: vi.fn(),
    handleTrackKeyDown: vi.fn(),
  };
}

function grid(zoomIndex: 0 | 1 | 2, opts: { nonce?: number; from?: Date; to?: Date } = {}) {
  const index = buildBoardIndex(
    makeFixture(),
    opts.from ?? windowStart,
    opts.to ?? windowEnd,
    STANDARD,
  );
  const levelById = new Map([["lvl-cell", { isSchedulable: true }]]);
  return (
    <BoardGrid
      index={index}
      levelById={levelById as never}
      collapsedNodeIds={new Set()}
      onToggleCollapsed={vi.fn()}
      zoomIndex={zoomIndex}
      productById={new Map()}
      operatorById={new Map()}
      scrollToNowNonce={opts.nonce ?? 0}
      dragApi={makeDragApi()}
      setDropRowResolver={vi.fn()}
      onFitScaleChange={vi.fn()}
    />
  );
}

describe("R-051: zoom preserves the instant under the track viewport's centre", () => {
  it("D51a: zooming from Standard to Fine re-centres scrollLeft on the same instant rather than leaving it where it was or resetting to 0", () => {
    const realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { container, rerender } = render(grid(1));
      const root = container.firstElementChild as HTMLElement;
      expect(root).toBeTruthy();

      // Establish a real (fake) viewport so `viewport.width` is non-zero.
      fireResize(1000, 600);

      root.scrollLeft = 400;

      rerender(grid(2));

      // pxPerHour goes 104 -> 168 (Standard -> Fine). If the T2 effect never
      // ran, scrollLeft would stay exactly 400 -- the value BEFORE the zoom,
      // which now points at a different instant. If it ran but the centring
      // math were wrong (e.g. using full viewport.width instead of
      // viewport.width - railWidth), the result would still differ from a
      // naive "unchanged" value, so the strongest available assertion here is
      // that a genuine recentre happened, not a no-op.
      expect(root.scrollLeft).not.toBe(400);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  it("D51b: zooming to the SAME zoomIndex is a no-op -- the effect only fires when zoomIndex actually changes", () => {
    const realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { container, rerender } = render(grid(1));
      const root = container.firstElementChild as HTMLElement;
      fireResize(1000, 600);
      root.scrollLeft = 250;

      rerender(grid(1));

      expect(root.scrollLeft).toBe(250);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });
});

/**
 * R-055: "on first mount and on Today the board scrolls so now sits a quarter
 * of the way across the track. Prev and Next do not re-scroll."
 *
 * Found live at 19:2x Chicago right after F-159: the board opened on the right
 * DAY but was not scrolled to now. The scroll-to-now effect consumed the nonce
 * (`lastNowNonceRef`) BEFORE testing whether now lies inside the index's
 * window. `useBoardWindow` keeps the previous window's data across a refetch
 * (R-424), so the store's re-anchor bumped the nonce while `index` was still
 * the OLD window's -- `nowMin < 0`, return, nonce spent -- and when the
 * anchored window's index arrived there was no promise left to keep.
 *
 * The clock is fixed here because the whole bug is a relationship between
 * `Date.now()` and the window: 12:00Z inside a window that starts at 00:00Z is
 * 720 minutes in, which at Standard's 104 px/hour is 1248 px; a 1000 px
 * viewport with no rail (the jsdom ceiling this file's header documents) puts
 * the left edge at 1248 - 250 = 998, i.e. now exactly a quarter of the way
 * across. That 998 is the number both cases turn on.
 */
describe("R-055: the scroll-to-now nonce is a promise, discharged only by a scroll", () => {
  const NOON = new Date("2026-09-07T12:00:00.000Z");
  /** The day the clock is in, 00:00Z -- now is 720 minutes into it. */
  const DAY_WITH_NOW = new Date("2026-09-07T00:00:00.000Z");
  const THREE_DAYS_FROM_NOW_DAY = new Date("2026-09-10T00:00:00.000Z");
  /** Prev day: the window still HOLDS now (day 1 of 3), so anything that
   *  re-scrolled on a window change would be caught here. */
  const PREV_DAY = new Date("2026-09-06T00:00:00.000Z");
  const PREV_DAY_END = new Date("2026-09-09T00:00:00.000Z");
  /** A window three days behind the clock -- now is off it entirely. */
  const STALE_DAY = new Date("2026-09-04T00:00:00.000Z");
  const STALE_DAY_END = new Date("2026-09-05T00:00:00.000Z");
  /** now at 720 min · 104 px/hour = 1248 px, less a quarter of the 1000 px
   *  track viewport. */
  const NOW_A_QUARTER_ACROSS = 998;

  /** `fireResize` on its own leaves React's state update unflushed, so the
   *  layout effect it should trigger has not run when the next line asserts
   *  (the two cases above never noticed: both `rerender` afterwards, which
   *  flushes). These cases assert on the resize render ITSELF, so the
   *  callback goes through `act`. */
  function fireResizeFlushed(width: number, height: number) {
    act(() => fireResize(width, height));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("T-now-1: a nonce bump while now is off the index's window does not consume it -- the scroll happens when the window holding now arrives", () => {
    const realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      // The board is showing a stale window (the previous data React Query
      // keeps across the refetch) and the store has just bumped the nonce.
      const { container, rerender } = render(
        grid(1, { nonce: 1, from: STALE_DAY, to: STALE_DAY_END }),
      );
      const root = container.firstElementChild as HTMLElement;
      fireResizeFlushed(1000, 600);
      root.scrollLeft = 123;

      // The effect has run against the stale index by now; now is off it, so
      // nothing scrolls -- and that must NOT count as keeping the promise.
      expect(root.scrollLeft).toBe(123);

      // The anchored window's index lands. Same nonce: no new bump.
      rerender(grid(1, { nonce: 1, from: DAY_WITH_NOW, to: THREE_DAYS_FROM_NOW_DAY }));

      expect(root.scrollLeft).toBe(NOW_A_QUARTER_ACROSS);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  it("T-now-2: Prev/Next -- a window change with the nonce unchanged and already spent -- leaves the scroll where the user put it", () => {
    const realRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const { container, rerender } = render(
        grid(1, { nonce: 1, from: DAY_WITH_NOW, to: THREE_DAYS_FROM_NOW_DAY }),
      );
      const root = container.firstElementChild as HTMLElement;
      fireResizeFlushed(1000, 600);

      // First mount scrolled to now and spent the nonce.
      expect(root.scrollLeft).toBe(NOW_A_QUARTER_ACROSS);

      root.scrollLeft = 400; // the user scrolls somewhere of their own
      rerender(grid(1, { nonce: 1, from: PREV_DAY, to: PREV_DAY_END }));

      // The new window still contains now, so only the spent nonce is keeping
      // this from jumping -- exactly the rule Prev/Next relies on.
      expect(root.scrollLeft).toBe(400);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });
});
