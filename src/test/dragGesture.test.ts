import { createElement, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run } from "@/lib/api";
import { useDragGesture, type UseDragGestureArgs } from "@/features/board/hooks/useDragGesture";
import { useToastStore } from "@/features/board/hooks/useSchedulerToast";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "@/features/board/lib/boardIndex";

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
  };
});

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");
const WINDOW_MINUTES = 1440;

const runFixture: IndexedRun = {
  id: "run-1",
  orgId: "org-1",
  nodeId: "cell-1",
  productId: "prod-1",
  timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
  plannedHeadcount: 2,
  notes: null,
  status: "planned",
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
    runId: "run-1",
    productId: null,
    timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
    efficiency: 1,
    eligibilityOverride: false,
    overrideReason: null,
    targetQty: null,
    targetUnit: null,
    status: "planned",
    createdBy: null,
    createdAt: WINDOW_START.toISOString(),
    updatedAt: WINDOW_START.toISOString(),
    startMin: 360,
    endMin: 600,
    efficiencyPercent: 100,
    lane: 0,
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
    skillsForNode: new Map([["cell-1", []]]),
    productById: new Map(),
    operatorById: new Map(),
    skillById: new Map(),
    nodeById: new Map(),
    capacityCap: 1,
    droppedRanges: 0,
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

function baseArgs(index: BoardIndex, sessionUserId: string | null = "user-1"): UseDragGestureArgs {
  return {
    rootPath: "plant_1",
    from: WINDOW_START,
    to: new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
    index,
    defaultCreateMode: "run",
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

  it("§5.3: moving a STAFFED run is refused — no mutation is sent, an info toast is pushed", async () => {
    const api = await import("@/lib/api");
    const crew = [crewFixture()];
    const index = buildIndex(crew); // T10: commitBlockDrag reads this fresh map, not the descriptor
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      // The descriptor's own `crew` can be stale/empty — T10 says only the
      // fresh `index` at commit time governs the refusal.
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    expect(result.current.activeDrag).toBe(null);
    expect(api.updateRunFields).not.toHaveBeenCalled();
    expect(
      useToastStore.getState().toasts.some((t) => t.message.includes("Moving a staffed run")),
    ).toBe(true);
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
});
