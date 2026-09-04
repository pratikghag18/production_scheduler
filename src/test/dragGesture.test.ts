import { createElement, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run } from "@/lib/api";
import { useDragGesture, type UseDragGestureArgs } from "@/features/board/hooks/useDragGesture";
import { useToastStore } from "@/features/board/hooks/useSchedulerToast";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";

/**
 * Authored, not run in this container (no npm — see the agent report).
 * `useDragGesture` composes React state, `@tanstack/react-query` mutation
 * hooks, and DOM `PointerEvent` handling, none of which the §11/§12
 * harness (a plain-node script) can exercise — this file is the
 * corresponding `renderHook`-based coverage for the parts of the hook the
 * pure-function harness cannot reach: T10/T11 (fresh-index commit, clear-
 * before-mutate), T13 (identity change cancels a drag), §5.3's staffed-run
 * move refusal, and click-vs-drag (§5.1's `moved` threshold) choosing
 * between "commit a mutation" and "open the edit popover".
 *
 * `@/lib/api`'s five mutation functions are mocked (`vi.mock`, spreading
 * the real module for everything else) so no network/Supabase client is
 * ever reached — this tests `useDragGesture`'s own state machine and
 * commit logic, not the wrapped P1-3b hooks themselves (already covered
 * by their own contract; D36: this brief adds no new mutation hook).
 */
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createRun: vi.fn(),
    updateRunFields: vi.fn(),
    deleteRun: vi.fn(),
    createAssignment: vi.fn(),
    updateAssignmentFields: vi.fn(),
    deleteAssignment: vi.fn(),
    // P1-4e: the staffed-run path now goes through `move_run`, and the
    // split flow through `capacity_probe` + `apply_split_coverage`.
    moveRun: vi.fn(),
    probeCapacity: vi.fn(),
    applySplitCoverage: vi.fn(),
  };
});

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");
const WINDOW_MINUTES = 1440;

const runFixture: IndexedRun = {
  // ⚠️ RUNS STILL CARRY A STATUS (R-323 removed the assignment's, not the
  // run's), so this stays while the assignment fixture below has none.
  status: "planned",
  id: "run-1",
  orgId: "org-1",
  nodeId: "cell-1",
  productId: "prod-1",
  productSku: null,
  productName: null,
  productColorToken: null,
  timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
  plannedHeadcount: 2,
  notes: null,
  createdBy: null,
  createdAt: WINDOW_START.toISOString(),
  updatedAt: WINDOW_START.toISOString(),
  startMin: 360,
  endMin: 600,
};

function crewFixture(): IndexedAssignment {
  return {
    id: "asg-1",
    orgId: "org-1",
    nodeId: "cell-1",
    operatorId: "op-1",
    operatorDisplayName: null,
    runId: "run-1",
    productId: null,
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
    efficiency: 1,
    eligibilityOverride: false,
    overrideReason: null,
    areaOverride: false,
    areaOverrideReason: null,
    targetQty: null,
    targetUnit: null,
    createdBy: null,
    createdAt: WINDOW_START.toISOString(),
    updatedAt: WINDOW_START.toISOString(),
    startMin: 360,
    endMin: 600,
    efficiencyPercent: 100,
    lane: 0,
    defaultTargetQty: null,
  };
}

/** A minimal BoardIndex with one node/run, crew optionally attached — T10
 *  reads THIS map fresh at commit time, never the descriptor captured at
 *  pointerdown, so each test controls staffing by varying this fixture,
 *  not the drag descriptor. */
function buildIndex(crew: IndexedAssignment[]): BoardIndex {
  const assignmentsByRun = new Map<string, IndexedAssignment[]>();
  if (crew.length > 0) assignmentsByRun.set("run-1", crew);
  return {
    windowStart: WINDOW_START,
    windowMinutes: WINDOW_MINUTES,
    dayCount: 1,
    rows: [],
    runsByNode: new Map([["cell-1", [runFixture]]]),
    assignmentsByNode: new Map([["cell-1", crew]]),
    assignmentsByRun,
    assignmentsByOperator: new Map(),
    templateForNode: new Map([["cell-1", null]]),
    cycleTimeByKey: new Map(),
    skillsForNode: new Map([["cell-1", []]]),
    productById: new Map(),
    operatorById: new Map(),
    skillById: new Map(),
    nodeById: new Map(),
    capacityCap: 1,
    droppedRanges: 0,
    // P1-4c D45: `BoardIndex` gained a `density`. Standard (index 1) is
    // defined to reproduce the pre-P1-4c constants exactly, so these
    // drag-gesture fixtures keep the geometry they were written against.
    density: DENSITIES[1],
    // P1-4e: `BoardIndex` gained id-keyed lookups (for T12's block labels)
    // and the org's eligibility policy. Built from the same rows the
    // node-keyed maps above hold, so the fixture stays self-consistent.
    runById: new Map([["run-1", runFixture]]),
    assignmentById: new Map(crew.map((a) => [a.id, a] as const)),
    eligibilityPolicy: "warn",
  };
}

function fakePointerEvent(clientX: number, clientY = 0, altKey = false) {
  return {
    clientX,
    clientY,
    altKey,
    pointerId: 1,
    stopPropagation: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
  } as unknown as ReactPointerEvent;
}

function baseArgs(
  index: BoardIndex,
  sessionUserId: string | null = "user-1",
  rootPath = "plant_1",
): UseDragGestureArgs {
  return {
    rootPath,
    from: WINDOW_START,
    to: new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
    index,
    defaultCreateMode: "run",
    // P1-4e: snapping needs the zoom to know its step. 1 = Standard (30 min).
    zoomIndex: 1,
    sessionUserId,
  };
}

function runDescriptor(runsOnNode: IndexedRun[], crew: IndexedAssignment[]) {
  return {
    nodeId: "cell-1",
    subject: { kind: "run" as const, run: runFixture },
    original: { startMin: runFixture.startMin, endMin: runFixture.endMin },
    pxPerHour: 100,
    windowMinutes: WINDOW_MINUTES,
    template: null,
    dayCount: 1,
    zoomIndex: 1 as const,
    handlePx: 8,
    blockWidthPx: 200,
    offsetXPx: 100, // body zone (grip = min(8, floor(200/3)) = 8; 8 < 100 < 192)
    runsOnNode,
    crew,
  };
}

// Plain `createElement`, not JSX — this file is named `.ts` (brief §9), and
// JSX syntax requires `.tsx`.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useDragGesture", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
  });

  it("a click (no movement past the 4px threshold) opens the edit popover, not a mutation", async () => {
    const api = await import("@/lib/api");
    const index = buildIndex([]);
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    // No updateBlockDrag call — the pointer never moved.
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(500, 300));
    });

    expect(result.current.activeDrag).toBe(null);
    expect(result.current.popover?.kind).toBe("run");
    expect(api.updateRunFields).not.toHaveBeenCalled();
  });

  it("T11: activeDrag is cleared and an unstaffed run move commits against the fresh index", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateRunFields).mockResolvedValue({} as Run);
    const index = buildIndex([]); // no crew — move is allowed
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300)); // 60px > 4px threshold
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    // The outcome T11 protects: no stale activeDrag survives past commit.
    expect(result.current.activeDrag).toBe(null);
    await waitFor(() => expect(api.updateRunFields).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateRunFields).mock.calls[0][0]).toBe("run-1");
  });

  it("P1-4e D57: moving a STAFFED run goes through move_run once — the crew follows atomically", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.moveRun).mockResolvedValue({
      run: {} as Run,
      assignments: [],
      eligibilityWarnings: [],
    } as never);
    const crew = [crewFixture()];
    const index = buildIndex(crew); // T10: commitBlockDrag reads this fresh map, not the descriptor
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      // The descriptor's own `crew` can be stale/empty — T10 says only the
      // fresh `index` at commit time governs which path is taken.
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    expect(result.current.activeDrag).toBe(null);
    // D57: ONE move_run, never N per-crew writes. This test previously
    // asserted P1-4b's refusal ("Moving a staffed run is coming in the next
    // build"); P1-4e deleted that behaviour deliberately, so the assertion
    // is inverted rather than removed — the refusal must NOT come back.
    await waitFor(() => expect(api.moveRun).toHaveBeenCalledTimes(1));
    expect(api.updateAssignmentFields).not.toHaveBeenCalled();
    expect(
      useToastStore.getState().toasts.some((t) => t.message.includes("Moving a staffed run")),
    ).toBe(false);
  });

  it("T13: a session identity change cancels an in-flight drag with no mutation sent", async () => {
    const api = await import("@/lib/api");
    const index = buildIndex([]);
    const { result, rerender } = renderHook(
      (props: { sessionUserId: string | null }) =>
        useDragGesture(baseArgs(index, props.sessionUserId)),
      { wrapper, initialProps: { sessionUserId: "user-1" } },
    );

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    expect(result.current.activeDrag).not.toBe(null);

    // The signed-in identity changes mid-drag (e.g. the dev profile switcher).
    rerender({ sessionUserId: "user-2" });

    expect(result.current.activeDrag).toBe(null);
    expect(api.updateRunFields).not.toHaveBeenCalled();
    expect(api.createRun).not.toHaveBeenCalled();
  });

  /**
   * DEF-0002, the half the picker fix did not reach.
   *
   * ⭐ FOUND BY DRIVING IT, NOT BY READING IT. `productOfferedAt` now scopes the
   * create popover's Product list to the plant on screen, which fixed the
   * reported path. But the popover itself survived a change of place: opened
   * over Plant A and then switching the picker to Plant B left it up, and its
   * dropdown went from Plant A's four parts to all thirteen in the company —
   * `BoardPage` cannot resolve a Plant A node inside Plant B's map, and its
   * fallback handed back the whole catalogue. Every one of the nine strangers
   * would have been refused by the database.
   *
   * ⚠️ EVERY KIND OF POPOVER, WHICH IS WHERE THIS DIFFERS FROM T13/T25 ABOVE.
   * An identity change closes only a "split", by that case's own literal text.
   * A ROOT change invalidates them all: a popover names a node in the window it
   * was opened over, and after the switch that node is not on the screen at all.
   */
  it("DEF-0002: changing the selected place closes the popover it was opened over", () => {
    const index = buildIndex([]);
    const { result, rerender } = renderHook(
      (props: { rootPath: string }) => useDragGesture(baseArgs(index, "user-1", props.rootPath)),
      { wrapper, initialProps: { rootPath: "plant_1" } },
    );

    // A click with no movement opens the edit popover over this run's cell —
    // the same path the case above uses. Any kind but "split" proves the
    // widening; "split" was already closed by T25 for a different reason.
    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(500, 300));
    });
    expect(result.current.popover?.kind).toBe("run");

    // The reader picks a different place while it is open.
    rerender({ rootPath: "plant_2" });

    expect(result.current.popover).toBe(null);
    expect(result.current.activeDrag).toBe(null);
  });

  /**
   * R-322/R-323 — THE PROGRESS LABEL IS GONE, AND SO IS THE SOFT DELETE.
   *
   * ⭐ TWO THINGS THAT LOOK LIKE ONE FIELD. The pop-up used to offer planned /
   * active / done, and `saveAssignmentFields` carried the chosen value down.
   * The maintainer removed the picker: nothing read the value, nothing obliged
   * anyone to set it, so it could only ever say "planned" about finished work.
   * But `cancelled` writes through the SAME field and is not a label — it is
   * the soft delete, and the overlap constraint, the capacity guard and
   * `boardIndex`'s rule 17 all key on it.
   *
   * ⚠️ tsc CANNOT SEE THE HALF THAT MATTERS HERE. It stops a status being
   * TYPED into a field edit (the interface takes the literal "cancelled" only),
   * but nothing in the type system says the save path stopped SENDING one, and
   * nothing says Delete still does. Both are asserted, because the failure this
   * guards against is a status quietly reappearing on the save path and going
   * stale in the database where no screen shows it.
   */
  it("R-322/R-323: saving sends no status, and Delete DELETES the row", async () => {
    const api = await import("@/lib/api");
    const index = buildIndex([]);
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.saveAssignmentFields("a-1", 110, 12, "pieces");
    });
    // The write is a mutation, so the api call lands a tick later — waited for
    // rather than assumed, the same way the move cases above do.
    await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
    expect(saved).toEqual({ efficiencyPercent: 110, targetQty: 12, targetUnit: "pieces" });
    expect(saved && "status" in saved).toBe(false);

    // ⚠️ R-323 CHANGED THIS HALF, and the contract changed rather than the case
    // being wrong: Delete used to write `status: "cancelled"` through the very
    // same field edit asserted above, which is what gave one concept two
    // behaviours depending on whether you deleted the assignment or its run.
    // It is a real delete now, and the field-edit path is not touched at all.
    act(() => {
      result.current.removeAssignment("a-1");
    });
    await waitFor(() => expect(api.deleteAssignment).toHaveBeenCalledWith("a-1"));
    expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1);
  });
});
