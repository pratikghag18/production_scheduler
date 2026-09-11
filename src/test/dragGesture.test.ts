import {
  createElement,
  StrictMode,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run, AbsenceRecord, Skill, BoardOperator, BoardNode } from "@/lib/api";
import { useDragGesture, type UseDragGestureArgs } from "@/features/board/hooks/useDragGesture";
import { useToastStore } from "@/features/board/hooks/useSchedulerToast";
import { absenceKeys } from "@/features/board/hooks/useAbsences";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { buildDayAxis } from "@/features/board/lib/time";

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
    // R-361: `useDragGesture` now also reads `useAbsences` (the same query
    // `BoardPage` already subscribes to, R-357) to mirror the resize's warn
    // toast. Defaults to an empty list so every EXISTING case above, which
    // never mocks this, still resolves the query instead of hanging on the
    // real network call.
    fetchAbsences: vi.fn(async () => ({ absences: [], skipped: 0 })),
  };
});

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");
const WINDOW_MINUTES = 1440;

const runFixture: IndexedRun = {
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
    // D88a: a UTC axis reproduces the pre-D88 geometry exactly.
    zone: "UTC",
    dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
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
    // R-331: `BoardIndex` gained a per-node policy map. Empty here on purpose
    // — none of these cases opens a create popover, and an empty map is the
    // state `policyForNode` reads the company scalar above for.
    eligibilityPolicyByNode: new Map(),
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
  canPlace = true,
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
    // DEF-0015: the server's `can_place`. True (a scheduler) for every case
    // except the viewer cases below, which pass false.
    canPlace,
    // R-357: the plant's date format, used only to phrase a warn-move's absence
    // warnings in the success toast (`leaveLine`). The default token is fine here.
    dateFormat: "d_mon_yyyy",
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
    dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
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
      // R-357: `parseMoveRunResult` always fills this (defaulting to []), so the
      // mock reflects the real contract the success handler reads.
      absenceWarnings: [],
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

  /**
   * R-357 — A WARN-MOVE'S ABSENCE WARNINGS REACH THE DRAG TOAST. The create and
   * reassign pop-ups already show the leave a warn-placement went ahead over; the
   * drag path was the one silent place. `move_run` returns `absence_warnings` for
   * every crew member carried onto a window they are away for (informational, D60
   * — the move already succeeded), and the success toast now names them the way
   * the pop-ups do (`leaveLine`: the person, then "On leave <dates>: reason").
   */
  it("R-357: a staffed warn-move whose result carries absence_warnings toasts the person and the leave", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.moveRun).mockResolvedValue({
      run: {} as Run,
      assignments: [],
      eligibilityWarnings: [],
      absenceWarnings: [
        {
          operatorId: "op-1",
          absence: { absent: true, from: "2026-08-24", to: "2026-08-25", reason: "sick" },
        },
      ],
    } as never);
    const crew = [crewFixture()]; // staffed → the move goes through move_run
    const index = buildIndex(crew);
    // Name the person on the index so the toast can render a display name rather
    // than the bare id fallback — the pop-ups name the person, so this must too.
    index.operatorById.set("op-1", {
      id: "op-1",
      homeNodeId: null,
      displayName: "Ana Operator",
      employeeRef: null,
      active: true,
      siteNodeId: "cell-1",
      sitePath: "plant_1.cell_1",
      skillIds: [],
      skillExpiries: [],
    });
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    await waitFor(() => expect(api.moveRun).toHaveBeenCalledTimes(1));
    // The one thing the drag path used to swallow: the person, and the leave in
    // `leaveLine`'s own words.
    await waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => m.includes("Ana Operator") && m.includes("On leave"))).toBe(true);
    });
  });

  /**
   * R-359 / migration 0069 — THE PART-DAY HOLE. `move_run`'s `absence_warnings`
   * entries now carry `startsAt`/`endsAt` for a part-day hit, and this toast
   * must read those hours in the board's own zone (`index.zone`, the same value
   * `toastCtx`'s `formatRange` uses at line ~308) rather than in UTC. Before the
   * fix the toast built `leaveLine`'s argument from only `from`/`to`/`reason`
   * and called it with no third argument, so a part-day hit rendered as a
   * whole-day one (no hours at all) — always in UTC even once that was fixed.
   */
  it("R-359: a part-day absence_warnings entry reads its hours in the board's own zone, not UTC", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.moveRun).mockResolvedValue({
      run: {} as Run,
      assignments: [],
      eligibilityWarnings: [],
      absenceWarnings: [
        {
          operatorId: "op-1",
          absence: {
            absent: true,
            from: "2026-08-24",
            to: "2026-08-24",
            reason: "sick",
            // 09:00Z-13:00Z is 04:00-08:00 in America/Chicago (CDT, UTC-5 in August).
            startsAt: "2026-08-24T09:00:00.000Z",
            endsAt: "2026-08-24T13:00:00.000Z",
          },
        },
      ],
    } as never);
    const crew = [crewFixture()];
    const index = buildIndex(crew);
    index.zone = "America/Chicago"; // not UTC — the case the bug shipped as
    index.operatorById.set("op-1", {
      id: "op-1",
      homeNodeId: null,
      displayName: "Ana Operator",
      employeeRef: null,
      active: true,
      siteNodeId: "cell-1",
      sitePath: "plant_1.cell_1",
      skillIds: [],
      skillExpiries: [],
    });
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    await waitFor(() => expect(api.moveRun).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      // The hours must survive AND read in the plant's own zone, not UTC.
      expect(messages.some((m) => m.includes("04:00–08:00"))).toBe(true);
      expect(messages.some((m) => m.includes("09:00–13:00"))).toBe(false);
    });
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

  /**
   * DEF-0015 — A VIEWER (can_place: false) OPENS NO WRITE POP-UP AND STARTS NO
   * DRAG. `board_window` answers `can_place: false` for a viewer, and the
   * gesture layer is handed that one boolean so the refusal is decided in one
   * place. Enter on a track (and a click-drag on it) do nothing — the create
   * pop-up never opens; a block move commits nothing.
   */
  describe("DEF-0015: the viewer's gesture layer", () => {
    function fakeTrackKeyEvent(key: string) {
      return {
        key,
        preventDefault: vi.fn(),
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, right: 0 }) },
      } as unknown as ReactKeyboardEvent;
    }

    it("Enter on a track opens NOTHING when canPlace is false", () => {
      const index = buildIndex([]);
      const { result } = renderHook(
        () => useDragGesture(baseArgs(index, "user-1", "plant_1", /* canPlace */ false)),
        { wrapper },
      );
      act(() => {
        result.current.handleTrackKeyDown(fakeTrackKeyEvent("Enter"), {
          nodeId: "cell-1",
          template: null,
          windowMinutes: WINDOW_MINUTES,
        });
      });
      expect(result.current.popover).toBe(null);
    });

    it("a click-drag on a track opens no create pop-up when canPlace is false", () => {
      const index = buildIndex([]);
      const { result } = renderHook(
        () => useDragGesture(baseArgs(index, "user-1", "plant_1", false)),
        { wrapper },
      );
      act(() => {
        result.current.beginTrackCreateDrag(
          {
            nodeId: "cell-1",
            pxPerHour: 100,
            windowMinutes: WINDOW_MINUTES,
            template: null,
            dayCount: 1,
            dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
            zoomIndex: 1,
            trackLeftPx: 0,
            offsetXPx: 0,
          },
          fakePointerEvent(100),
        );
      });
      // No drag began, so there is nothing to update/end and no pop-up appears.
      expect(result.current.activeDrag).toBe(null);
      expect(result.current.popover).toBe(null);
    });

    it("a viewer's block drag commits no mutation and instead opens the read-only pop-up", async () => {
      const api = await import("@/lib/api");
      const index = buildIndex([]);
      const { result } = renderHook(
        () => useDragGesture(baseArgs(index, "user-1", "plant_1", false)),
        { wrapper },
      );
      act(() => {
        result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
      });
      // A viewer's block never follows the pointer: `moved` stays false...
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });
      // ...so the pointerup reads as a click and opens the pop-up (BoardPage
      // renders it read-only), and no field edit / move is ever sent.
      expect(result.current.popover?.kind).toBe("run");
      expect(api.updateRunFields).not.toHaveBeenCalled();
      expect(api.moveRun).not.toHaveBeenCalled();
    });
  });

  /**
   * R-361 — A RESIZE ASKS THE SAME TWO QUESTIONS THE OTHER FOUR WRITERS ASK.
   * Migration 0070's `assignments_resize_guard` is silent under `warn` (a
   * trigger cannot return a warning), so the toast the maintainer asked for
   * ("similar warnings as other 4") has to come from the CLIENT running the
   * same mirrors (`certificateGaps`, `absenceGaps`) the create/reassign
   * pop-ups already run, then reusing the crew-drag success toast's own
   * wording (`commitBlockDrag`'s `move_run` `onSuccess`, above) rather than
   * inventing new copy. `updateAssignmentFields` (the plain PATCH, no RPC)
   * is mocked to resolve, so these cases are about what the CLIENT decides
   * to say before/around the write, not the server's own refusal — that half
   * is `88_absences_test.sql`'s AB26-AB32.
   *
   * A same-cell NUDGE ("move" mode, body-zone `offsetXPx`) is used for every
   * case rather than an edge resize — `commitBlockDrag`'s assignment branch
   * runs the identical code for both (R-361's own two named cases, "a drag on
   * the block's EDGE, or a nudge to a new time in the same cell"), and a body
   * hit needs no `hitTestBlock` grip-zone arithmetic to set up. The fixture
   * assignment is DIRECT (no run) and its window sits far from `runFixture`'s
   * own (13:20-15:20 vs. 06:00-10:00) so a 30-minute nudge never enters
   * `assignmentFitsRun` range for either run on the node — the edit sent is
   * `timerange` alone, exactly the PATCH docs/api.md §4 describes.
   */
  describe("R-361: a resize runs the same mirrors the create/reassign pop-ups run", () => {
    function directAssignmentFixture(
      overrides: Partial<IndexedAssignment> = {},
    ): IndexedAssignment {
      return {
        id: "asg-direct-1",
        orgId: "org-1",
        nodeId: "cell-1",
        operatorId: "op-1",
        operatorDisplayName: null,
        runId: null,
        productId: "prod-1",
        productSku: null,
        productName: null,
        productColorToken: null,
        timerange: "[2026-08-24 13:20:00+00,2026-08-24 15:20:00+00)",
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
        startMin: 800,
        endMin: 920,
        efficiencyPercent: 100,
        lane: 0,
        defaultTargetQty: null,
        ...overrides,
      };
    }

    function operatorFixture(overrides: Partial<BoardOperator> = {}): BoardOperator {
      return {
        id: "op-1",
        homeNodeId: "cell-1",
        displayName: "Elena",
        employeeRef: "EMP-1",
        active: true,
        siteNodeId: "plant-1",
        sitePath: "plant_1",
        skillIds: [],
        skillExpiries: [],
        ...overrides,
      };
    }

    function assignmentChipDescriptor(a: IndexedAssignment) {
      return {
        nodeId: "cell-1",
        subject: { kind: "assignment" as const, assignment: a, homeRun: null },
        original: { startMin: a.startMin, endMin: a.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1 as const,
        handlePx: 8,
        blockWidthPx: 200,
        offsetXPx: 100, // body zone, same grip math runDescriptor's comment gives
        runsOnNode: [runFixture],
        crew: [] as IndexedAssignment[],
      };
    }

    /** A private `QueryClient`, exposed so a case can wait for `useAbsences`'
     *  own query (the same key `BoardPage` subscribes to, R-357) to settle
     *  BEFORE driving the drag — the mirror reads whatever `resizeAbsences`
     *  holds at the moment `endBlockDrag` commits, synchronously, so a case
     *  that cares about the mirror's answer must not race the fetch. */
    function absencesWrapper() {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      function w({ children }: { children: ReactNode }) {
        return createElement(QueryClientProvider, { client }, children);
      }
      return { wrapper: w, client };
    }

    function toastMessages(): string[] {
      return useToastStore.getState().toasts.map((t) => t.message);
    }

    it("under warn, a nudge onto a recorded absence toasts the SAME leave sentence the crew-drag toast uses, and still commits", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const absence: AbsenceRecord = {
        id: "ab-1",
        operatorId: "op-1",
        from: "2026-08-24",
        to: "2026-08-24",
        reason: "sick",
        source: "manual",
        externalId: null,
      };
      vi.mocked(api.fetchAbsences).mockResolvedValue({ absences: [absence], skipped: 0 });

      const a = directAssignmentFixture();
      const index: BoardIndex = {
        ...buildIndex([a]),
        operatorById: new Map([["op-1", operatorFixture()]]),
      };
      const { wrapper: w, client } = absencesWrapper();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper: w });
      await waitFor(() => expect(client.getQueryState(absenceKeys.all())?.status).toBe("success"));

      act(() => {
        result.current.beginBlockDrag(assignmentChipDescriptor(a), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300)); // 60px -> +30min (Standard snap)
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const messages = toastMessages();
      expect(messages.some((m) => m.includes("Elena") && /on leave/i.test(m))).toBe(true);
      expect(messages.some((m) => m.includes("Override recorded"))).toBe(true);
      // The write still went through — a warn placement is not a refusal.
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.timerange).toBeDefined();
    });

    it("under warn, a nudge past a required certificate the operator never held toasts the SAME wording the crew-drag toast uses", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      vi.mocked(api.fetchAbsences).mockResolvedValue({ absences: [], skipped: 0 });

      const a = directAssignmentFixture();
      const requiredSkill: Skill = { id: "skill-cnc", name: "CNC" };
      const index: BoardIndex = {
        ...buildIndex([a]),
        operatorById: new Map([["op-1", operatorFixture({ skillIds: [] })]]), // never trained
        skillsForNode: new Map([["cell-1", [requiredSkill]]]),
      };
      const { wrapper: w, client } = absencesWrapper();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper: w });
      await waitFor(() => expect(client.getQueryState(absenceKeys.all())?.status).toBe("success"));

      act(() => {
        result.current.beginBlockDrag(assignmentChipDescriptor(a), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const messages = toastMessages();
      expect(messages.some((m) => m.includes("Elena") && /not certified for/i.test(m))).toBe(true);
      expect(messages.some((m) => /override recorded/i.test(m))).toBe(true);
    });

    it("under warn, a nudge that clears neither the absence nor the certificate mirror toasts nothing, and still commits", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      vi.mocked(api.fetchAbsences).mockResolvedValue({ absences: [], skipped: 0 });

      const a = directAssignmentFixture();
      const index: BoardIndex = {
        ...buildIndex([a]),
        operatorById: new Map([["op-1", operatorFixture()]]),
      };
      const { wrapper: w, client } = absencesWrapper();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper: w });
      await waitFor(() => expect(client.getQueryState(absenceKeys.all())?.status).toBe("success"));

      act(() => {
        result.current.beginBlockDrag(assignmentChipDescriptor(a), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      expect(toastMessages()).toEqual([]);
    });

    it("under block, the client never runs the mirror toast — the server's own refusal (failWith) is the only voice", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const absence: AbsenceRecord = {
        id: "ab-2",
        operatorId: "op-1",
        from: "2026-08-24",
        to: "2026-08-24",
        reason: "sick",
        source: "manual",
        externalId: null,
      };
      vi.mocked(api.fetchAbsences).mockResolvedValue({ absences: [absence], skipped: 0 });

      const a = directAssignmentFixture();
      const index: BoardIndex = {
        ...buildIndex([a]),
        operatorById: new Map([["op-1", operatorFixture()]]),
        eligibilityPolicy: "block",
      };
      const { wrapper: w, client } = absencesWrapper();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper: w });
      await waitFor(() => expect(client.getQueryState(absenceKeys.all())?.status).toBe("success"));

      act(() => {
        result.current.beginBlockDrag(assignmentChipDescriptor(a), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      // No client-side "on leave" mirror toast under block — a real server,
      // unmocked, would refuse this write outright (AB26); the mock here just
      // resolves it, so the only thing this case pins is that a `block`
      // policy never gets the `warn` mirror's toast.
      expect(toastMessages().some((m) => /on leave/i.test(m))).toBe(false);
    });

    it("a departed person's row (operatorId null, D110) has nobody to mirror and toasts nothing, but still commits", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      vi.mocked(api.fetchAbsences).mockResolvedValue({ absences: [], skipped: 0 });

      const a = directAssignmentFixture({ operatorId: null, operatorDisplayName: "Departed Dana" });
      const index = buildIndex([a]);
      const { wrapper: w, client } = absencesWrapper();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper: w });
      await waitFor(() => expect(client.getQueryState(absenceKeys.all())?.status).toBe("success"));

      act(() => {
        result.current.beginBlockDrag(assignmentChipDescriptor(a), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      expect(toastMessages()).toEqual([]);
    });
  });

  /**
   * R-365 — A DROP THAT CHANGES A CHIP'S RUN ASKS FIRST. `commitBlockDrag`'s
   * assignment branch already computes `stillFitsHome`/`otherFit` (D66) to
   * decide the `edit`'s `runId`/`productId`; R-365 reuses that SAME choice
   * to decide whether to ask before writing at all, via `attachmentChangeMessage`
   * (`src/features/board/lib/interaction.ts`) and the existing `askConfirm`
   * mechanism (§9 debt 2, already used by run resize). Detach and re-parent
   * ask; a nudge that stays inside its own run does not; Cancel writes
   * nothing because `endBlockDrag` already cleared `activeDrag` (T11)
   * before `commitBlockDrag` ran, so a prompted-and-cancelled drop leaves
   * the chip exactly where the untouched index has it.
   */
  /*
   * R-031 — A RESIZE OF A BLOCK WITH A TYPED TARGET ASKS: KEEP THE TOTAL, OR
   * SCALE IT. Decided by the maintainer in session 122. The target is a total
   * for the block's window, so changing the window's length changes what the
   * number means; the prompt is the R-365 confirm shell with two answers and
   * Cancel. These drive a REAL edge drag through the hook (offsetXPx in the
   * end-handle zone, `hitTestBlock` picks "resize-end"), the way the R-365
   * cases drive a move, and read the write that follows each answer.
   */
  describe("R-031: a resize of a block with a typed target asks keep-or-scale first", () => {
    function targetedChip(): IndexedAssignment {
      return { ...crewFixture(), targetQty: 80, targetUnit: "pieces" };
    }

    function descriptorFor(
      a: IndexedAssignment,
      offsetXPx: number,
      homeRun: IndexedRun | null = runFixture,
    ) {
      return {
        nodeId: "cell-1",
        subject: { kind: "assignment" as const, assignment: a, homeRun },
        original: { startMin: a.startMin, endMin: a.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1 as const,
        handlePx: 8,
        blockWidthPx: 200,
        offsetXPx, // 195 is the end grip (`hitTestBlock`: >= width - 8); 100 is the body
        runsOnNode: [runFixture],
        crew: [] as IndexedAssignment[],
      };
    }

    function name(index: BoardIndex) {
      index.operatorById.set("op-1", {
        id: "op-1",
        homeNodeId: null,
        displayName: "Elena",
        employeeRef: null,
        active: true,
        siteNodeId: "cell-1",
        sitePath: "plant_1.cell_1",
        skillIds: [],
        skillExpiries: [],
      });
    }

    /** Drag the block's end grip 60px left: 600 -> 570, 4h -> 3h 30m. */
    function shrinkFromEnd(
      result: { current: ReturnType<typeof useDragGesture> },
      a: IndexedAssignment,
    ) {
      act(() => {
        result.current.beginBlockDrag(descriptorFor(a, 195), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(440, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(440, 300));
      });
    }

    function prompt(result: { current: { popover: unknown } }) {
      const p = result.current.popover as {
        kind: string;
        title?: string;
        message?: string;
        choices?: { label: string }[];
      } | null;
      return p && p.kind === "confirm" ? p : null;
    }

    it("R-031a: the resize asks before writing, naming the person, the target, both lengths and the scaled figure", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = targetedChip();
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      shrinkFromEnd(result, a);

      const p = prompt(result);
      expect(p).not.toBeNull();
      expect(p?.title).toBe("Keep or scale?");
      expect(p?.message).toBe(
        "Elena's block carries a target of 80 pieces for 4h. It is now 3h 30m: keep 80 pieces as the total, or scale it to 70 pieces?",
      );
      expect(p?.choices?.map((c) => c.label)).toEqual(["Keep 80 pieces", "Scale to 70 pieces"]);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
    });

    it("R-031b: Keep writes the new window and leaves the target out of the patch", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = targetedChip();
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      shrinkFromEnd(result, a);
      act(() => {
        result.current.confirmChoose(0);
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent && "targetQty" in sent).toBe(false);
      expect(sent?.timerange?.end.toISOString()).toBe("2026-08-24T09:30:00.000Z");
      expect(result.current.popover).toBeNull();
    });

    it("R-031c: Scale writes the scaled target on the same patch as the new window, unit untouched", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = targetedChip();
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      shrinkFromEnd(result, a);
      act(() => {
        result.current.confirmChoose(1);
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.targetQty).toBe(70);
      expect(sent && "targetUnit" in sent).toBe(false);
      expect(sent?.timerange?.end.toISOString()).toBe("2026-08-24T09:30:00.000Z");
    });

    it("R-031d: Cancel writes nothing and the prompt closes; Enter on a choice prompt picks nothing", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = targetedChip();
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      shrinkFromEnd(result, a);
      act(() => {
        result.current.confirmYes(); // no default answer to "keep or scale?"
      });
      expect(prompt(result)).not.toBeNull();
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmNo();
      });
      expect(result.current.popover).toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
    });

    it("R-031e: a MOVE of the same block does not ask -- its length is unchanged", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      // 300-540 inside the 360-600 run would leave the run (R-365 would ask);
      // keep the nudge inside the run by starting the chip short of the run's end.
      const a = {
        ...targetedChip(),
        timerange: "[2026-08-24 06:00:00+00,2026-08-24 09:00:00+00)",
        endMin: 540,
      };
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(descriptorFor(a, 100), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300)); // +30min: 390-570, still inside 360-600
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      expect(result.current.popover).toBeNull();
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent && "targetQty" in sent).toBe(false);
    });

    it("R-031f: a block with no typed target resizes without asking -- its derived target already follows (R-316)", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = crewFixture(); // targetQty null
      const index = buildIndex([a]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      shrinkFromEnd(result, a);

      expect(result.current.popover).toBeNull();
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent && "targetQty" in sent).toBe(false);
      expect(sent?.timerange?.end.toISOString()).toBe("2026-08-24T09:30:00.000Z");
    });

    it("R-031g: a DIRECT block (no run, DirectBlock.tsx's own subject shape) asks the same question and Scale writes the same patch", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      // Direct: carries its own product, belongs to no run, and sits clear of
      // run-1's window so no R-365 attachment question can join in.
      const a: IndexedAssignment = {
        ...targetedChip(),
        runId: null,
        productId: "prod-1",
        timerange: "[2026-08-24 12:00:00+00,2026-08-24 16:00:00+00)",
        startMin: 720,
        endMin: 960,
      };
      const index = buildIndex([]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(descriptorFor(a, 195, null), fakePointerEvent(500, 300));
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(440, 300)); // end grip 60px left: 960 -> 930
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(440, 300));
      });

      const p = prompt(result);
      expect(p?.title).toBe("Keep or scale?");
      expect(p?.choices?.map((c) => c.label)).toEqual(["Keep 80 pieces", "Scale to 70 pieces"]);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmChoose(1);
      });
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.targetQty).toBe(70);
      expect(sent && "runId" in sent).toBe(false); // no attachment change rides along
      expect(sent?.timerange?.end.toISOString()).toBe("2026-08-24T15:30:00.000Z");
    });

    it("R-031h: an Alt-drag resize that changes the block's LENGTH but scales back to the same typed figure asks nothing (DEF-0031)", async () => {
      // R-031a-g all drive a 30-minute-snapped drag, so `scaled` only ever
      // equals `targetQty` via the zero-length-change branch (R-031e). This
      // drives a genuine length change through the same "asks nothing" path:
      // a direct block (bounds = the full window, so a 1000-minute length
      // fits) carrying a typed target of 80, Alt-dragged (whole-minute
      // snapping, `snapMinute`'s own branch) so its end moves by exactly 1
      // minute, 1000 -> 1001. scaledTarget(80, 1000, 1001) =
      // Math.max(1, roundTarget(80 * 1001 / 1000)) = Math.floor(80.08) = 80
      // -- the SAME figure, so the "scaled === typed" guard in
      // `useDragGesture` (the one DEF-0031 found unpinned) should skip the
      // keep-or-scale prompt and commit the new window directly, exactly
      // like R-031e/R-031f.
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a: IndexedAssignment = {
        ...targetedChip(),
        runId: null,
        productId: "prod-1",
        timerange: "[2026-08-24 00:00:00+00,2026-08-24 16:40:00+00)",
        startMin: 0,
        endMin: 1000,
      };
      const index = buildIndex([]);
      name(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(descriptorFor(a, 195, null), fakePointerEvent(500, 300));
      });
      act(() => {
        // +1 minute at pxPerHour 100 is 1.6667px on X; the +4 on Y clears
        // DRAG_THRESHOLD_PX (4px) without adding to the horizontal (minute)
        // delta the Alt-drag resize reads.
        result.current.updateBlockDrag(fakePointerEvent(501.6666666666667, 304, true));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(501.6666666666667, 304, true));
      });

      expect(result.current.popover).toBeNull();
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent && "targetQty" in sent).toBe(false);
      expect(sent?.timerange?.end.toISOString()).toBe("2026-08-24T16:41:00.000Z");
    });
  });

  describe("R-365: a drop that changes a chip's run asks first", () => {
    const runFixtureB: IndexedRun = {
      ...runFixture,
      id: "run-2",
      productId: "prod-2",
      timerange: "[2026-08-24 10:00:00+00,2026-08-24 15:00:00+00)",
      startMin: 600,
      endMin: 900,
    };

    function chipDescriptor(
      a: IndexedAssignment,
      homeRun: IndexedRun | null,
      runsOnNode: IndexedRun[],
    ) {
      return {
        nodeId: "cell-1",
        subject: { kind: "assignment" as const, assignment: a, homeRun },
        original: { startMin: a.startMin, endMin: a.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1 as const,
        handlePx: 8,
        blockWidthPx: 200,
        offsetXPx: 100, // body zone, same grip math runDescriptor's comment gives
        runsOnNode,
        crew: [] as IndexedAssignment[],
      };
    }

    function nameOperator(index: BoardIndex) {
      index.operatorById.set("op-1", {
        id: "op-1",
        homeNodeId: null,
        displayName: "Elena",
        employeeRef: null,
        active: true,
        siteNodeId: "cell-1",
        sitePath: "plant_1.cell_1",
        skillIds: [],
        skillExpiries: [],
      });
    }

    function confirmMessage(result: { popover: unknown }): string | null {
      const p = result.popover as { kind: string; message?: string } | null;
      return p && p.kind === "confirm" ? (p.message ?? null) : null;
    }

    it("a nudge that takes a chip off its run asks before writing (detach)", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = crewFixture(); // 360-600, attached to run-1, matching the run's own window exactly
      const index = buildIndex([a]);
      nameOperator(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(
          chipDescriptor(a, runFixture, [runFixture]),
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300)); // 60px -> +30min: 360-600 -> 390-630, past the run's own end
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      expect(result.current.popover?.kind).toBe("confirm");
      expect(confirmMessage(result.current)).toMatch(
        /off the .* run and makes them a standalone assignment/,
      );
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmYes();
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.runId).toBe(null);
      expect(sent?.productId).toBe(runFixture.productId);
    });

    it("F-128: Continue sends the write exactly ONCE under StrictMode, which the app runs in", async () => {
      // `src/main.tsx` mounts the app in <StrictMode>, and StrictMode invokes
      // state UPDATER functions twice in development to flush out side effects
      // hidden inside them. `confirmYes` used to call `onConfirm()` inside its
      // `setPopover` updater -- so every Continue sent its write twice, seen
      // as "2 PATCH to assignments" in loadSanity.spec.ts's own print line the
      // first time R-365 put a prompt in front of a real write. The run-resize
      // confirm had the same shape from the day it replaced window.confirm.
      // The other cases in this block render WITHOUT StrictMode and could not
      // see it; this one renders the way the app does.
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = crewFixture();
      const index = buildIndex([a]);
      nameOperator(index);
      const strictWrapper = ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, createElement(wrapper, null, children));
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), {
        wrapper: strictWrapper,
      });

      act(() => {
        result.current.beginBlockDrag(
          chipDescriptor(a, runFixture, [runFixture]),
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });
      expect(result.current.popover?.kind).toBe("confirm");

      act(() => {
        result.current.confirmYes();
      });
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalled());
      // Give a second, double-invoked call every chance to land before counting.
      await new Promise((r) => setTimeout(r, 20));
      expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1);
      expect(result.current.popover).toBe(null);
    });

    it("a nudge that moves a chip fully onto a different run asks before writing (re-parent)", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      // Attached to run-1 (360-600) but sitting near its right edge (540-600)
      // so a 60-minute nudge lands it entirely inside run-2 (600-900) and no
      // longer inside run-1.
      const a: IndexedAssignment = { ...crewFixture(), startMin: 540, endMin: 600 };
      const index: BoardIndex = {
        ...buildIndex([a]),
        runsByNode: new Map([["cell-1", [runFixture, runFixtureB]]]),
        runById: new Map([
          ["run-1", runFixture],
          ["run-2", runFixtureB],
        ]),
      };
      nameOperator(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(
          chipDescriptor(a, runFixture, [runFixture, runFixtureB]),
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(620, 300)); // 120px -> +60min: 540-600 -> 600-660, inside run-2 only
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(620, 300));
      });

      expect(result.current.popover?.kind).toBe("confirm");
      expect(confirmMessage(result.current)).toMatch(/from the .* run to the .* run/);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmYes();
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.runId).toBe(runFixtureB.id);
      expect(sent?.productId).toBe(null);
    });

    it("a nudge that stays inside its own run does not ask", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      // 400-550, well inside run-1 (360-600) on both sides of a 30-minute nudge.
      const a: IndexedAssignment = { ...crewFixture(), startMin: 400, endMin: 550 };
      const index = buildIndex([a]);
      nameOperator(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(
          chipDescriptor(a, runFixture, [runFixture]),
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300)); // 60px -> +30min: 400-550 -> 430-580, still inside 360-600
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });

      expect(result.current.popover).toBe(null);
      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent && "runId" in sent).toBe(false);
      expect(sent?.timerange).toBeDefined();
    });

    it("Cancel writes nothing and toasts nothing — the chip is already back where it was", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = crewFixture();
      const index = buildIndex([a]);
      nameOperator(index);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(
          chipDescriptor(a, runFixture, [runFixture]),
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        result.current.updateBlockDrag(fakePointerEvent(560, 300));
      });
      act(() => {
        result.current.endBlockDrag(fakePointerEvent(560, 300));
      });
      expect(result.current.popover?.kind).toBe("confirm");

      act(() => {
        result.current.confirmNo();
      });

      expect(result.current.popover).toBe(null);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([]);
    });
  });

  describe("R-384: which openers may set autoCreate", () => {
    function panelOperator(): BoardOperator {
      return {
        id: "op-1",
        homeNodeId: null,
        displayName: "Ana Ortiz",
        employeeRef: null,
        active: true,
        siteNodeId: "plant-1",
        sitePath: "plant_1",
        skillIds: [],
        skillExpiries: [],
      };
    }

    /** `endPanelDrag` refuses to open unless the resolved drop hit is a
     *  track row the index actually knows about — the shared `buildIndex`
     *  fixture's `nodeById` is empty (no case above needed it), so this
     *  case adds the one node it drops onto. */
    function indexWithNode(): BoardIndex {
      const node: BoardNode = {
        id: "cell-1",
        parentId: null,
        levelId: "cell",
        name: "Cell 1",
        path: "plant_1.line_1.cell_1",
        sortOrder: 0,
        active: true,
      };
      return { ...buildIndex([]), nodeById: new Map([["cell-1", node]]) };
    }

    it("openCreateFromCommand's popover carries autoCreate: true (the typed command bar's Enter path)", () => {
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });

      act(() => {
        result.current.openCreateFromCommand({
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          target: { kind: "direct", productId: "prod-1" },
          anchor: { x: 10, y: 10 },
        });
      });

      const p = result.current.popover;
      if (p?.kind !== "create") throw new Error("expected a create popover");
      expect(p.autoCreate).toBe(true);
      expect(p.presetOperatorId).toBe("op-1");
      expect(p.presetProductId).toBe("prod-1");
    });

    it("endPanelDrag's popover carries no autoCreate (a panel drop never auto-creates)", () => {
      const { result } = renderHook(() => useDragGesture(baseArgs(indexWithNode())), { wrapper });

      act(() => {
        result.current.setDropRowResolver(() => ({
          nodeId: "cell-1",
          isTrack: true,
          minute: 360,
        }));
      });
      act(() => {
        result.current.beginPanelDrag(panelOperator(), fakePointerEvent(100, 100));
      });
      act(() => {
        result.current.endPanelDrag(fakePointerEvent(100, 100));
      });

      const p = result.current.popover;
      if (p?.kind !== "create") throw new Error("expected a create popover");
      expect(p.autoCreate).toBeUndefined();
      expect(p.presetOperatorId).toBe("op-1");
    });
  });
});
