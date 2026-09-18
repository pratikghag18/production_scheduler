/**
 * operatorPanel.test.tsx — S65-a (R-439): the rail's own drag handle, OP-1..OP-4.
 *
 * `absenceOnBoard.test.tsx` already owns the chip's own content (R-038,
 * R-357, R-346's split) through its own `renderPanel` helper -- this file is
 * only the width behaviour `OperatorPanel.tsx` grew for S65-a: the handle,
 * `width` state, and the round trip through `railWidth.ts` (its own PS-shaped
 * unit reasoning stays in `panelSize.test.ts`; this is the PANEL's wiring to
 * it, the same division `commandLauncher.test.tsx`'s CL-10/CL-11 draw for the
 * command panel).
 *
 * ⚠️ `getBoundingClientRect()` ALWAYS RETURNS 0 IN JSDOM (no real layout), so
 * `OperatorPanel.tsx`'s `currentUiScale()` -- which measures `.scaleProbe`'s
 * resolved width -- falls through to its own `|| 1` default in every case
 * here. That makes `RAIL_MIN_WIDTH * uiScale` exactly 190 throughout this
 * file; the clamp's OWN `ui-scale`-varying floor has no unit case here for
 * the same reason `clampPanelSize`'s viewport-relative ceiling is pinned in
 * `panelSize.test.ts`, not through a component render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BoardOperator } from "@/lib/api";
import { OperatorPanel } from "@/features/board/components/OperatorPanel";
import { RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from "@/features/board/lib/railWidth";

const ELENA: BoardOperator = {
  id: "op-elena",
  homeNodeId: null,
  homeShiftId: null,
  displayName: "Elena",
  employeeRef: null,
  active: true,
  siteNodeId: "n-plant",
  sitePath: "plant_a",
  skillIds: [],
  skillExpiries: [],
};

function dragApi() {
  return {
    beginPanelDrag: vi.fn(),
    updatePanelDrag: vi.fn(),
    endPanelDrag: vi.fn(),
    cancelDrag: vi.fn(),
  };
}

function renderPanel(over: { open?: boolean; widthStorageKey?: string | null } = {}) {
  const onToggleOpen = vi.fn();
  const utils = render(
    <OperatorPanel
      operators={[ELENA]}
      hereOperatorIds={new Set([ELENA.id])}
      skillById={new Map()}
      nodeById={new Map()}
      assignmentsByOperator={new Map()}
      windowStart={new Date("2026-01-01T00:00:00.000Z")}
      windowMinutes={1440}
      capacityCap={1}
      open={over.open ?? true}
      onToggleOpen={onToggleOpen}
      dragApi={dragApi()}
      widthStorageKey={over.widthStorageKey ?? null}
    />,
  );
  return { ...utils, onToggleOpen };
}

function panel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Operators" });
}

function handle(): HTMLElement {
  return document.querySelector('[class*="resizeHandle"]') as HTMLElement;
}

/** A drag: pointerdown at `fromX`, pointermove to `toX`, pointerup there. */
function drag(fromX: number, toX: number): void {
  fireEvent.pointerDown(handle(), { clientX: fromX, pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("OperatorPanel: the rail's drag handle (S65-a, R-439)", () => {
  it("OP-1: at rest the rail has no inline width, and a drag on the handle sets one, grown from the 190px default", () => {
    renderPanel();
    expect(panel().style.width).toBe("");

    drag(300, 350); // +50px
    expect(panel().style.width).toBe(`${RAIL_MIN_WIDTH + 50}px`);
  });

  it("OP-2: the dragged width is remembered per key and restored on a later mount", () => {
    const key = "user-1|plant_a";
    const { unmount } = renderPanel({ widthStorageKey: key });
    drag(300, 360); // +60, well inside [190, 480]
    expect(panel().style.width).toBe(`${RAIL_MIN_WIDTH + 60}px`);
    unmount();

    // A fresh mount, same key: the stored width is read back on mount, no
    // drag needed this time.
    renderPanel({ widthStorageKey: key });
    expect(panel().style.width).toBe(`${RAIL_MIN_WIDTH + 60}px`);
  });

  it("OP-2b: a DIFFERENT key sees none of the first key's remembered width", () => {
    const key = "user-1|plant_a";
    const { unmount } = renderPanel({ widthStorageKey: key });
    drag(300, 400); // +100
    unmount();

    renderPanel({ widthStorageKey: "user-2|plant_a" });
    expect(panel().style.width).toBe("");
  });

  it("OP-3: collapsing and reopening the rail keeps the width it was dragged to", () => {
    const { rerender } = renderPanel({ open: true });
    drag(300, 380); // +80
    const grown = panel().style.width;
    expect(grown).toBe(`${RAIL_MIN_WIDTH + 80}px`);

    rerender(
      <OperatorPanel
        operators={[ELENA]}
        hereOperatorIds={new Set([ELENA.id])}
        skillById={new Map()}
        nodeById={new Map()}
        assignmentsByOperator={new Map()}
        windowStart={new Date("2026-01-01T00:00:00.000Z")}
        windowMinutes={1440}
        capacityCap={1}
        open={false}
        onToggleOpen={vi.fn()}
        dragApi={dragApi()}
        widthStorageKey={null}
      />,
    );
    // Collapsed: `.collapsed`'s own fixed CSS width wins, no inline style.
    expect(panel().style.width).toBe("");

    rerender(
      <OperatorPanel
        operators={[ELENA]}
        hereOperatorIds={new Set([ELENA.id])}
        skillById={new Map()}
        nodeById={new Map()}
        assignmentsByOperator={new Map()}
        windowStart={new Date("2026-01-01T00:00:00.000Z")}
        windowMinutes={1440}
        capacityCap={1}
        open={true}
        onToggleOpen={vi.fn()}
        dragApi={dragApi()}
        widthStorageKey={null}
      />,
    );
    expect(panel().style.width).toBe(grown);
  });

  it("OP-4: the clamp holds both ways -- a drag past the ceiling stops at 480px, a drag past the floor stops at 190px", () => {
    renderPanel();
    drag(300, 300 + 1000); // way past the ceiling
    expect(panel().style.width).toBe(`${RAIL_MAX_WIDTH}px`);

    drag(300, 300 - 1000); // way past the floor (from the now-480px width)
    expect(panel().style.width).toBe(`${RAIL_MIN_WIDTH}px`);
  });
});
