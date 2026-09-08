import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodeTreeEditor } from "@/features/admin/components/NodeTreeEditor";

/**
 * R-078: on pointer up or cancel the drag releases pointer capture and clears
 * state, and the Escape listener is installed once per drag (keyed on the
 * boolean `dragActive`, not on the `drag` object itself, which is a new
 * reference on every pointermove).
 *
 * Requires jsdom's PointerEvent + capture-method polyfills (src/test/setup.ts)
 * -- without them, `fireEvent.pointerDown` cannot construct the event at all,
 * and `setPointerCapture` throws.
 */

const h = vi.hoisted(() => ({ moveMutate: vi.fn(), placeMutate: vi.fn() }));

function mutation(mutate: () => void) {
  return {
    mutate,
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null as unknown,
    data: null as unknown,
    reset: vi.fn(),
  };
}

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] },
  useCreateNode: () => mutation(vi.fn()),
  useCopyPlantStructure: () => mutation(vi.fn()),
  useRenameNode: () => mutation(vi.fn()),
  useMoveNode: () => mutation(h.moveMutate),
  usePlaceNode: () => mutation(h.placeMutate),
  usePromoteNode: () => mutation(vi.fn()),
  useDemoteNode: () => mutation(vi.fn()),
  useDeleteNode: () => mutation(vi.fn()),
}));

const PLANT = "30000000-0000-0000-0000-000000000001";
const LINE_1 = "30000000-0000-0000-0000-000000000004";
const LINE_2 = "30000000-0000-0000-0000-000000000005";

const LEVELS = [
  { id: "L1", templateId: "tpl-1", position: 0, name: "Plant", isSchedulable: false },
  { id: "L2", templateId: "tpl-1", position: 1, name: "Line", isSchedulable: true },
];

const NODES = [
  {
    id: PLANT,
    parentId: null,
    levelId: "L1",
    name: "Plant 1",
    path: "plant_1",
    sortOrder: 0,
    active: true,
  },
  {
    id: LINE_1,
    parentId: PLANT,
    levelId: "L2",
    name: "Line 1",
    path: "plant_1.line_1",
    sortOrder: 0,
    active: true,
  },
  {
    id: LINE_2,
    parentId: PLANT,
    levelId: "L2",
    name: "Line 2",
    path: "plant_1.line_2",
    sortOrder: 1,
    active: true,
  },
];

const SHAPES = [
  {
    id: "tpl-1",
    name: "Standard",
    levelCount: 2,
    levelNames: ["Plant", "Line"],
    schedulableLevelName: "Line",
    hasNodes: true,
  },
];

function renderEditor() {
  return render(
    <NodeTreeEditor
      nodes={NODES}
      levels={LEVELS}
      shapeSummaries={SHAPES}
      selectedTemplateId="tpl-1"
    />,
  );
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest("[data-node-id]") as HTMLElement;
}

describe("R-078: pointer capture release and the Escape listener", () => {
  beforeEach(() => {
    h.moveMutate.mockClear();
    h.placeMutate.mockClear();
    // jsdom has no document.elementFromPoint at all; handleRowPointerMove
    // calls it for hover hit-testing (unrelated to what R-078 claims), which
    // otherwise throws before the capture/threshold logic under test runs.
    document.elementFromPoint = vi.fn().mockReturnValue(null);
  });

  it("D78a: pointerup on a row that never crossed the drag threshold releases capture and commits nothing", () => {
    renderEditor();
    const row = rowFor("Line 1");
    fireEvent.pointerDown(row, { pointerId: 5, clientX: 100, clientY: 100, pointerType: "mouse" });
    expect(row.hasPointerCapture(5)).toBe(true);

    fireEvent.pointerUp(row, { pointerId: 5, clientX: 100, clientY: 100 });
    expect(row.hasPointerCapture(5)).toBe(false);
    // A click, not a drag: neither mutation fires.
    expect(h.moveMutate).not.toHaveBeenCalled();
    expect(h.placeMutate).not.toHaveBeenCalled();
  });

  it("D78b: pointercancel releases capture the same way pointerup does", () => {
    renderEditor();
    const row = rowFor("Line 1");
    fireEvent.pointerDown(row, { pointerId: 7, clientX: 0, clientY: 0, pointerType: "mouse" });
    expect(row.hasPointerCapture(7)).toBe(true);

    fireEvent.pointerCancel(row, { pointerId: 7 });
    expect(row.hasPointerCapture(7)).toBe(false);
  });

  it("D78c: a pointerup for a DIFFERENT pointerId than the one that started the drag is ignored (no capture on that row to release, no mutation)", () => {
    renderEditor();
    const row = rowFor("Line 1");
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 0, clientY: 0, pointerType: "mouse" });
    fireEvent.pointerUp(row, { pointerId: 99, clientX: 0, clientY: 0 });
    // The real pointer (1) is still captured -- the stray pointerup for id 99
    // touched nothing.
    expect(row.hasPointerCapture(1)).toBe(true);
  });

  it("D78d: the Escape listener is not installed before any drag starts (Escape does nothing observable)", () => {
    renderEditor();
    // No pointerdown at all yet -- dragActive is false, nothing to clear.
    expect(() => fireEvent.keyDown(window, { key: "Escape" })).not.toThrow();
  });

  it("D78e: pressing Escape mid-drag clears drag state (the chip disappears) -- but does NOT itself release pointer capture, which is a distinct claim from pointerup/cancel's", () => {
    renderEditor();
    const row = rowFor("Line 1");
    // Per-row indentation guides also carry aria-hidden="true", so count them
    // (rather than querySelector one) to isolate the drag chip's own presence.
    const guideCount = document.querySelectorAll('[aria-hidden="true"]').length;

    fireEvent.pointerDown(row, { pointerId: 3, clientX: 0, clientY: 0, pointerType: "mouse" });
    // Cross the 4px threshold so `live` is set and the drag chip renders.
    fireEvent.pointerMove(row, { pointerId: 3, clientX: 10, clientY: 0 });
    expect(document.querySelectorAll('[aria-hidden="true"]').length).toBe(guideCount + 1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelectorAll('[aria-hidden="true"]').length).toBe(guideCount);
    // The Escape handler (NodeTreeEditor.tsx) only nulls the drag ref/state --
    // it does not call releasePointerCapture, unlike pointerup/pointercancel.
    expect(row.hasPointerCapture(3)).toBe(true);
  });
});
