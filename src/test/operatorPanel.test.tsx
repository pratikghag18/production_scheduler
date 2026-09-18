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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import type { BoardOperator, ShiftTemplate } from "@/lib/api";
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

function renderPanel(
  over: {
    open?: boolean;
    widthStorageKey?: string | null;
    /** S66-c: additive overrides, all optional and all defaulting to the
     *  ORIGINAL single-ELENA, no-pattern fixture -- OP-1..4 above pass none
     *  of these and are unaffected. */
    operators?: BoardOperator[];
    hereOperatorIds?: ReadonlySet<string>;
    rootTemplate?: ShiftTemplate | null;
    templateForNode?: ReadonlyMap<string, ShiftTemplate | null>;
    now?: Date;
  } = {},
) {
  const onToggleOpen = vi.fn();
  const ops = over.operators ?? [ELENA];
  const utils = render(
    <OperatorPanel
      operators={ops}
      hereOperatorIds={over.hereOperatorIds ?? new Set(ops.map((o) => o.id))}
      skillById={new Map()}
      nodeById={new Map()}
      assignmentsByOperator={new Map()}
      windowStart={new Date("2026-01-01T00:00:00.000Z")}
      windowMinutes={1440}
      capacityCap={1}
      rootTemplate={over.rootTemplate ?? null}
      templateForNode={over.templateForNode}
      now={over.now}
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

/**
 * S66-c (R-448): THE SHIFT CHIPS AND THE SHIFT-BASED DEFAULT LIST.
 *
 * `now` is always a literal `Date` passed as a prop (never the real clock) —
 * this file's own `renderPanel` skips the internal ticking timer entirely
 * whenever a `now` is given (`OperatorPanel.tsx`'s own contract), so these
 * cases are deterministic and leak no interval.
 */
describe("OperatorPanel: the shift chips and the shift-based default list (S66-c, R-448)", () => {
  const NOW = new Date("2026-09-18T10:00:00.000Z"); // 10:00 UTC -- inside Shift 1

  const THREE_SHIFT: ShiftTemplate = {
    id: "pat-1",
    name: "Three shift",
    shifts: [
      { id: "s1", name: "Shift 1", startMin: 360, endMin: 840, breaks: [] }, // 06:00-14:00
      { id: "s2", name: "Shift 2", startMin: 840, endMin: 1320, breaks: [] }, // 14:00-22:00
      { id: "s3", name: "Shift 3", startMin: 1320, endMin: 1800, breaks: [] }, // 22:00-06:00(+1d)
    ],
  };

  function operatorOnShift(id: string, name: string, homeShiftId: string | null): BoardOperator {
    return {
      id,
      homeNodeId: null,
      homeShiftId,
      displayName: name,
      employeeRef: null,
      active: true,
      siteNodeId: "n-plant",
      sitePath: "plant_a",
      skillIds: [],
      skillExpiries: [],
    };
  }

  it("SC-1: with no pattern on the root, no chips row is drawn at all", () => {
    renderPanel({ now: NOW });
    expect(screen.queryByRole("button", { name: "Shift 1" })).toBeNull();
  });

  it("SC-2: one chip per band, in band order -- the one covering `now` is filled and pressed, the rest are not", () => {
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW });
    const s1 = screen.getByRole("button", { name: "Shift 1" });
    const s2 = screen.getByRole("button", { name: "Shift 2" });
    const s3 = screen.getByRole("button", { name: "Shift 3" });
    expect(s1.getAttribute("aria-pressed")).toBe("true");
    expect(s2.getAttribute("aria-pressed")).toBe("false");
    expect(s3.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("On shift now: Shift 1")).not.toBeNull();
  });

  it("SC-3: clicking an outlined chip toggles it in, and the heading names every shown band", () => {
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW });
    fireEvent.click(screen.getByRole("button", { name: "Shift 2" }));
    expect(screen.getByRole("button", { name: "Shift 2" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("Showing: Shift 1, Shift 2")).not.toBeNull();
  });

  /**
   * RC-1 (reviewer found, S66-c review): `aria-pressed` alone is not a
   * defect BY ITSELF -- it is the CORRECT accessible state -- but nothing
   * SIGHTED read it before this fix. Caught from the lane's own screenshot
   * (`test-results/s66-c-rail-toggled.png`): "Showing: Shift 1, Shift 2" in
   * the heading, but Shift 1's chip painted exactly like the still-off
   * Shift 3 chip -- `OperatorPanel.tsx`'s className expression only ever
   * added `styles.shiftChipFilled` for the "on now" chip, never anything
   * keyed on `aria-pressed`/`toggledShiftIds` for the others, so the CSS
   * classes on an off and a toggled-in chip were IDENTICAL strings and no
   * jsdom class-list assertion (`vitest.config.ts`'s `css: false` means no
   * stylesheet is ever loaded here to begin with) could have told them
   * apart. The only place this is checkable at all is the stylesheet's own
   * source text -- `stickyHeaderStandard.test.ts` already reads a
   * `.module.css` file straight off disk for exactly this reason, one file
   * over. This asserts TWO separate rules against the compiled component's
   * own real classnames: a rule keyed on `[aria-pressed="true"]` that does
   * NOT also require `.shiftChipFilled` (so it fires for a merely-toggled
   * chip, not only the "on now" one), and that the "on now" filled look
   * itself is never reachable via a bare `aria-pressed` selector (so the two
   * states cannot be made to collapse back into each other by a future
   * edit).
   */
  it("RC-1: the stylesheet gives a toggled-in (non-filled) chip its own rule, distinct from the filled look", () => {
    const css = fs.readFileSync(
      `${process.cwd()}/src/features/board/components/OperatorPanel.module.css`,
      "utf8",
    );
    const shiftChipCss = css.replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments first
    const pressedNotFilled =
      /\.shiftChip\[aria-pressed="true"\]:not\(\.shiftChipFilled\)\s*\{([^}]*)\}/.exec(
        shiftChipCss,
      );
    expect(pressedNotFilled, "no rule styles a pressed-but-not-filled chip").not.toBeNull();
    const body = pressedNotFilled![1];
    // Something visible actually changes -- not an empty or no-op rule.
    expect(/border-color|background|box-shadow|outline/.test(body)).toBe(true);
    // The filled ("on now") look is reached only via its own class, never a
    // bare aria-pressed selector that would also catch this one.
    expect(/\.shiftChip\[aria-pressed="true"\]\s*\{/.test(shiftChipCss)).toBe(false);
  });

  it("SC-4: clicking it again removes it -- 'they stay until clicked again'", () => {
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW });
    const s2 = screen.getByRole("button", { name: "Shift 2" });
    fireEvent.click(s2);
    fireEvent.click(s2);
    expect(s2.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("On shift now: Shift 1")).not.toBeNull();
  });

  it("SC-5: clicking the filled (on-now) chip does nothing -- it is always shown", () => {
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW });
    const s1 = screen.getByRole("button", { name: "Shift 1" });
    fireEvent.click(s1);
    expect(s1.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("On shift now: Shift 1")).not.toBeNull();
  });

  it("SC-6: the default list shows only the on-now shift's people, plus anyone with no shift at all, at the end", () => {
    const ana = operatorOnShift("op-1", "Ana", "s1");
    const ben = operatorOnShift("op-2", "Ben", "s2");
    const cy = operatorOnShift("op-3", "Cy", null);
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW, operators: [ana, ben, cy] });
    expect(screen.getByText("Ana")).not.toBeNull();
    expect(screen.queryByText("Ben")).toBeNull(); // Shift 2 -- not shown by default
    expect(screen.getByText("Cy")).not.toBeNull(); // no shift -- listed anyway

    const anaChip = screen.getByText("Ana").closest("div") as HTMLElement;
    const cyChip = screen.getByText("Cy").closest("div") as HTMLElement;
    expect(within(anaChip).queryByText("No shift")).toBeNull();
    expect(within(cyChip).queryByText("No shift")).not.toBeNull();
  });

  it("SC-7: toggling Shift 2 in brings Ben into the list too, without hiding Ana or Cy", () => {
    const ana = operatorOnShift("op-1", "Ana", "s1");
    const ben = operatorOnShift("op-2", "Ben", "s2");
    const cy = operatorOnShift("op-3", "Cy", null);
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW, operators: [ana, ben, cy] });
    fireEvent.click(screen.getByRole("button", { name: "Shift 2" }));
    expect(screen.getByText("Ana")).not.toBeNull();
    expect(screen.getByText("Ben")).not.toBeNull();
    expect(screen.getByText("Cy")).not.toBeNull();
  });

  it("SC-8: 'no shift' people sort to the end, after everyone whose band is currently shown, regardless of name order", () => {
    const noShift = operatorOnShift("op-3", "Aaa-no-shift", null); // alphabetically first
    const onShift1 = operatorOnShift("op-1", "Zzz-on-shift", "s1");
    renderPanel({ rootTemplate: THREE_SHIFT, now: NOW, operators: [noShift, onShift1] });
    const names = screen.getAllByText(/-no-shift$|-on-shift$/).map((el) => el.textContent);
    expect(names).toEqual(["Zzz-on-shift", "Aaa-no-shift"]);
  });

  it("SC-9: a cross-pattern home band (matched by name, R-443) counts as a real band, not 'no shift'", () => {
    const homeTemplate: ShiftTemplate = {
      id: "away-pattern",
      name: "Away",
      shifts: [{ id: "away-s1", name: "shift 1", startMin: 300, endMin: 780, breaks: [] }],
    };
    const dana = { ...operatorOnShift("op-4", "Dana", "away-s1"), homeNodeId: "home-node" };
    renderPanel({
      rootTemplate: THREE_SHIFT,
      now: NOW,
      operators: [dana],
      templateForNode: new Map([["home-node", homeTemplate]]),
    });
    // Dana's home band ("shift 1", case-insensitive) matches the root's own
    // Shift 1, which IS on now -- so she is shown by default, with no "No
    // shift" mark, even though her own `homeShiftId` is not a row in
    // `THREE_SHIFT` at all.
    const danaChip = screen.getByText("Dana").closest("div") as HTMLElement;
    expect(within(danaChip).queryByText("No shift")).toBeNull();
  });

  it("SC-10: the chip grid uses R-447's column rule -- two bands -> two columns; four bands -> repeat(2, ...)", () => {
    const twoShift: ShiftTemplate = {
      id: "pat-2",
      name: "Two",
      shifts: [
        { id: "a", name: "A", startMin: 0, endMin: 720, breaks: [] },
        { id: "b", name: "B", startMin: 720, endMin: 1440, breaks: [] },
      ],
    };
    const { container: twoContainer } = renderPanel({ rootTemplate: twoShift, now: NOW });
    const twoGrid = twoContainer.querySelector('[class*="shiftChips_"]') as HTMLElement;
    expect(twoGrid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");

    const fourShift: ShiftTemplate = {
      id: "pat-4",
      name: "Four",
      shifts: [
        { id: "a", name: "A", startMin: 0, endMin: 360, breaks: [] },
        { id: "b", name: "B", startMin: 360, endMin: 720, breaks: [] },
        { id: "c", name: "C", startMin: 720, endMin: 1080, breaks: [] },
        { id: "d", name: "D", startMin: 1080, endMin: 1440, breaks: [] },
      ],
    };
    const { container: fourContainer } = renderPanel({ rootTemplate: fourShift, now: NOW });
    const fourGrid = fourContainer.querySelector('[class*="shiftChips_"]') as HTMLElement;
    expect(fourGrid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  /**
   * RC-3 (reviewer, S66-c review): the brief's own file header says "`now`
   * ... refreshed once a minute (`useEffect`/`setInterval`)" and "a `now`
   * PROP ... wins ... production never passes one" -- but every other case
   * in this describe block passes `now` explicitly, so the internal
   * `setInterval` path itself (the one path production code actually runs)
   * had NO pin at all: nothing here proved the rail's own clock ever ticks,
   * flips the band at the boundary without a remount, or is torn down on
   * unmount rather than leaking a timer that keeps firing `setState` against
   * an unmounted component (a React warning that fails CI under strict
   * mode). All three, with fake timers so nothing here waits a real minute.
   */
  describe("RC-3: the rail's own clock (no `now` prop -- the internal setInterval)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("ticks the band forward at the boundary, one minute later, with no remount", () => {
      // 13:59:30 UTC -- inside Shift 1 (06:00-14:00) with 30s left on the clock.
      vi.setSystemTime(new Date("2026-09-18T13:59:30.000Z"));
      renderPanel({ rootTemplate: THREE_SHIFT }); // no `now` -- exercises the real timer path
      expect(screen.getByText("On shift now: Shift 1")).not.toBeNull();

      // Advance the FAKE CLOCK itself (not just a jump via setSystemTime,
      // which would not fire the pending interval at all) past the minute
      // mark -- the interval fires once, reads `new Date()` under the fake
      // clock, and that instant is now 14:00:00+, inside Shift 2. Wrapped in
      // `act` because the interval callback's `setState` runs outside any
      // React-managed event, so nothing else flushes it before the assertion.
      act(() => {
        vi.advanceTimersByTime(90_000);
      });
      expect(screen.getByText("On shift now: Shift 2")).not.toBeNull();
      expect(screen.queryByText("On shift now: Shift 1")).toBeNull();
    });

    it("clears its interval on unmount -- no further setState once the component is gone", () => {
      vi.setSystemTime(new Date("2026-09-18T13:59:30.000Z"));
      const { unmount } = renderPanel({ rootTemplate: THREE_SHIFT });
      unmount();
      // If the interval were still live, advancing past several ticks after
      // unmount would call `setState` on an unmounted component -- React
      // logs that as an error/warning. Asserting on the spy is the only way
      // jsdom can see a leak that has nowhere left to render into.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.advanceTimersByTime(5 * 60_000);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
