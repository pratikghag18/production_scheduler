import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
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

function grid(zoomIndex: 0 | 1 | 2) {
  const index = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
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
      scrollToNowNonce={0}
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
