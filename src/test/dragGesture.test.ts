import {
  createElement,
  StrictMode,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run, AbsenceRecord, Skill, BoardOperator, BoardNode, BoardWindow } from "@/lib/api";
import { describeSchedulerError } from "@/lib/api";
import { useDragGesture, type UseDragGestureArgs } from "@/features/board/hooks/useDragGesture";
import { useToastStore } from "@/features/board/hooks/useSchedulerToast";
import { absenceKeys } from "@/features/board/hooks/useAbsences";
import { boardKeys } from "@/features/board/hooks/useBoardWindow";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { buildDayAxis } from "@/features/board/lib/time";
import { isPlaceholderId } from "@/features/board/lib/optimisticId";
import type { ResolvedAny, LotResult } from "@/features/board/components/CommandBar";
import type { ResolvedLotStep } from "@/lib/command/resolve";

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
    // S61-a (R-425, F-155): D12 below exercises `openMoveFromCommand`'s new
    // override branch, which writes directly through `submitMove` ->
    // `useMoveAssignment` -> this. Every earlier test in this file never
    // called it (only `openMoveFromCommand`'s POPOVER-opening branch,
    // D10/D11), so mocking it here changes nothing for them.
    moveAssignment: vi.fn(),
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
    // S194-D (DEF-0048): the lot's absence record goes through the Absences
    // form's own `setAbsence`; mocked so the runner's call can be asserted.
    setAbsence: vi.fn(),
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

/**
 * F-233 (S194-G): a minimal, valid `BoardWindow` -- everything a real
 * payload carries, mostly empty, just enough for `useCreateAssignment`'s/
 * `useCreateRun`'s own `onMutate` to find a `previous` board to add its
 * optimistic row onto (`snapshotBoard` reads exactly this shape off the
 * query cache). Seeded directly via `client.setQueryData`, never fetched --
 * these tests drive the mutation hooks' own optimistic-update path, not a
 * network layer.
 */
function boardWindowFixture(): BoardWindow {
  return {
    org: { id: "org-1", name: "Org", settings: null },
    levels: [],
    nodes: [],
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
    dateFormat: "d_mon_yyyy",
    timezone: "UTC",
    commandBar: "voice",
    me: null,
  };
}

/** F-233: `wrapper`'s own twin, taking an EXTERNALLY built `QueryClient` so
 *  a test can seed its cache (`boardWindowFixture`, above) before the hook
 *  ever mounts and read it back afterward -- `wrapper` builds its own
 *  client internally and hands no test a handle to it, which is fine for
 *  every OTHER case here (none needs to seed or re-read the cache) but not
 *  for these. */
function wrapperWithClient(client: QueryClient) {
  return function ({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
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
      homeShiftId: null,
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
      homeShiftId: null,
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
        homeShiftId: null,
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
        homeShiftId: null,
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

  /**
   * R-463 (29 Sept): the constant a POINTER resize is floored against is no
   * longer the bare `MIN_DURATION_MINUTES` (1) -- it is the zoom's own snap
   * step, computed in `computeBlockCandidate` and passed as `resizeRange`'s
   * new 5th argument (`interaction.ts`'s own comment on that parameter
   * explains why: the block's FIXED edge need not itself be on the grid, so
   * clamping only against a 1-minute floor could land the moving edge a
   * single minute from an off-grid fixed edge, a sliver nobody dragged to).
   * This drives a REAL pointer resize through the hook, the same shape the
   * R-031 cases above do, against a block whose fixed edge is deliberately
   * off the Standard zoom's 30-minute grid (607, not a multiple of 30) --
   * `interaction.test.ts`'s own cases 11b/12b prove `resizeRange`'s
   * parameter in isolation; this proves the WIRING that picks the value it
   * is called with.
   */
  describe("R-463: a pointer resize's floor is the zoom's own snap step, not the bare 1-minute floor", () => {
    it("dragging the start edge toward an off-grid fixed end stops one whole snap step short, not one minute short", () => {
      const a: IndexedAssignment = { ...crewFixture(), startMin: 360, endMin: 607 };
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.beginBlockDrag(
          {
            nodeId: "cell-1",
            // homeRun: null -- a direct assignment, so `boundsFor` returns
            // the full window and the ONLY clamp in play is `resizeRange`'s
            // own, isolating exactly the floor this case is about.
            subject: { kind: "assignment", assignment: a, homeRun: null },
            original: { startMin: a.startMin, endMin: a.endMin },
            pxPerHour: 100,
            windowMinutes: WINDOW_MINUTES,
            template: null,
            dayCount: 1,
            dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
            zoomIndex: 1, // Standard, 30-minute snap
            handlePx: 8,
            blockWidthPx: 200,
            offsetXPx: 2, // the start grip (hitTestBlock: <= 8)
            runsOnNode: [],
            crew: [],
          },
          fakePointerEvent(500, 300),
        );
      });
      act(() => {
        // +450px at 100px/hour = +270min; raw target 360+270 = 630, already
        // a multiple of 30 (no snapping ambiguity). 630 is only 607-630 =
        // -23 min BEFORE the fixed end -- i.e. past it -- so the floor clamp
        // fires: the mutated (bare 1-minute) floor would land the start at
        // 607-1=606 (OFF the 30-minute grid, a 1-minute block); the real
        // floor (30, the zoom's own step) lands it at 607-30=577, a whole
        // snap step short of the fixed end.
        result.current.updateBlockDrag(fakePointerEvent(950, 300));
      });

      expect(result.current.activeDrag?.candidate).toEqual({ startMin: 577, endMin: 607 });
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
        homeShiftId: null,
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
        homeShiftId: null,
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

    it("D10 (S41-c): openMoveFromCommand's popover carries presetMove, presetOperatorId, presetProductId and autoCreate: true", () => {
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });

      act(() => {
        result.current.openMoveFromCommand({
          assignmentId: "asg-1",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          productId: "prod-1",
          anchor: { x: 10, y: 10 },
        });
      });

      const p = result.current.popover;
      if (p?.kind !== "create") throw new Error("expected a create popover");
      expect(p.presetMove).toEqual({ assignmentId: "asg-1" });
      expect(p.presetOperatorId).toBe("op-1");
      expect(p.presetProductId).toBe("prod-1");
      expect(p.autoCreate).toBe(true);
      expect(p.nodeId).toBe("cell-1");
      expect(p.range).toEqual({ startMin: 360, endMin: 480 });
    });

    it("D11: two consecutive openMoveFromCommand calls produce popovers with different seq (the race fix)", () => {
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });

      act(() => {
        result.current.openMoveFromCommand({
          assignmentId: "asg-1",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          productId: "prod-1",
          anchor: { x: 10, y: 10 },
        });
      });
      const first = result.current.popover;
      if (first?.kind !== "create") throw new Error("expected a create popover");

      act(() => {
        result.current.openMoveFromCommand({
          assignmentId: "asg-2",
          nodeId: "cell-2",
          range: { startMin: 480, endMin: 600 },
          operatorId: "op-2",
          productId: "prod-2",
          anchor: { x: 20, y: 20 },
        });
      });
      const second = result.current.popover;
      if (second?.kind !== "create") throw new Error("expected a create popover");

      expect(second.seq).not.toBe(first.seq);
    });

    // -----------------------------------------------------------------
    // S62-b re-check fixes (2) and (3): the split-coverage pop-up is where a
    // sentence's write can end up, and it never told the bar anything. Both
    // pins drive `openCreateFromCommand` -> the capacity probe answering
    // "does not fit" -> the split pop-up, which is the real route.
    // -----------------------------------------------------------------
    async function reachSplitFromASentence(
      onResult: (r: { kind: string; message?: string }) => void,
      strict = false,
    ) {
      const api = await import("@/lib/api");
      vi.mocked(api.probeCapacity).mockResolvedValue({
        fits: false,
        cap: 1,
        peak: 1.5,
        overlapping: [],
      } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
      const strictWrapper = ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, createElement(wrapper, null, children));
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), {
        wrapper: strict ? strictWrapper : wrapper,
      });

      act(() => {
        result.current.openCreateFromCommand({
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          target: { kind: "direct", productId: "prod-1" },
          anchor: { x: 10, y: 10 },
          onResult: onResult as never,
        });
      });
      // The create pop-up opens first; its own Create is what probes.
      expect(result.current.popover?.kind).toBe("create");
      await act(async () => {
        await result.current.submitCreateDirect(
          "cell-1",
          { startMin: 360, endMin: 480 },
          "op-1",
          { kind: "direct", productId: "prod-1" },
          100,
          undefined,
          undefined,
          false,
          undefined,
          false,
          undefined,
          { x: 10, y: 10 },
        );
      });
      await waitFor(() => expect(result.current.popover?.kind).toBe("split"));
      return result;
    }

    it("D14 (S62-b re-check fix 2/3): cancelSplit reports `cancelled` to the sentence that reached the split pop-up", async () => {
      const seen: { kind: string }[] = [];
      const result = await reachSplitFromASentence((r) => seen.push(r));
      // The reporter the create pop-up was given is carried onto the split
      // pop-up -- otherwise nothing here could ever answer the sentence.
      expect(result.current.popover?.kind === "split").toBe(true);

      act(() => {
        result.current.cancelSplit();
      });

      // S195-D (CONTRACT CHANGED, CLAUDE.md 4: not wrong when written): the
      // split pop-up now tells the sentence what it waits on (the one plain
      // sentence, DEF-0054) the moment it opens, BEFORE the cancel.
      expect(seen).toEqual([
        {
          kind: "handed_off",
          what: "That person is already booked then. The board is asking how to split the time. Answer it on the board.",
        },
        { kind: "cancelled" },
      ]);
      expect(result.current.popover).toBeNull();
    });

    it("D15 (S62-b re-check fix 3, F-128's shape again): the reporter fires ONCE under StrictMode, with no latch of its own", async () => {
      // The report used to run INSIDE `setPopover`'s updater, which StrictMode
      // invokes twice on purpose. The reporter passed here deliberately has NO
      // "fire once" latch, so a second call would be visible -- the bar's own
      // latch must not be what makes this right.
      const seen: { kind: string }[] = [];
      const result = await reachSplitFromASentence((r) => seen.push(r), true);

      act(() => {
        result.current.cancelSplit();
      });
      // Give a second, double-invoked call every chance to land before counting.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      // S195-D: the hand-off note, then the ONE cancel -- still once each.
      expect(seen).toEqual([
        {
          kind: "handed_off",
          what: "That person is already booked then. The board is asking how to split the time. Answer it on the board.",
        },
        { kind: "cancelled" },
      ]);
    });

    it("D12 (S61-a, R-425, F-155): openMoveFromCommand with an override writes DIRECTLY through submitMove -- eligibilityOverride: true, overrideReason set, no popover opened", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.moveAssignment).mockResolvedValue(
        {} as Awaited<ReturnType<typeof api.moveAssignment>>,
      );
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });

      act(() => {
        result.current.openMoveFromCommand({
          assignmentId: "asg-1",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          productId: "prod-1",
          anchor: { x: 10, y: 10 },
          override: { reason: "Covering an absence" },
        });
      });

      await waitFor(() => expect(api.moveAssignment).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.moveAssignment).mock.calls[0][0];
      expect(sent.assignmentId).toBe("asg-1");
      expect(sent.nodeId).toBe("cell-1");
      expect(sent.eligibilityOverride).toBe(true);
      expect(sent.overrideReason).toBe("Covering an absence");
      expect(sent.areaOverride).toBe(false);
      expect(sent.areaOverrideReason).toBeUndefined();
      // No popover -- the reason was already collected once, in the bar's
      // own conversation; this never asks a second time.
      expect(result.current.popover).toBeNull();
    });

    it("D13 (S61-a review fix, R-425, F-155): openCreateFromCommand with an override writes DIRECTLY through the create mutation -- eligibilityOverride: true, the reason, no popover", async () => {
      // The reviewer's own live bug: BoardPage's onOpen never passed
      // `resolved.override` through at all, and this function had no
      // parameter to carry it even if it had -- the popover opened
      // unchecked and nothing was ever written, while the bar's own
      // readout already claimed "· override: ...".
      const api = await import("@/lib/api");
      vi.mocked(api.createAssignment).mockResolvedValue(
        {} as Awaited<ReturnType<typeof api.createAssignment>>,
      );
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });

      act(() => {
        result.current.openCreateFromCommand({
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          operatorId: "op-1",
          target: { kind: "direct", productId: "prod-1" },
          anchor: { x: 10, y: 10 },
          override: { reason: "Covering an absence" },
        });
      });

      await waitFor(() => expect(api.createAssignment).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.createAssignment).mock.calls[0][0];
      expect(sent.nodeId).toBe("cell-1");
      expect(sent.operatorId).toBe("op-1");
      expect(sent.eligibilityOverride).toBe(true);
      expect(sent.overrideReason).toBe("Covering an absence");
      // No popover -- the reason was already collected once, in the bar's
      // own conversation; this never asks a second time.
      expect(result.current.popover).toBeNull();
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

  describe("R-385: retimeAssignmentFromCommand -- the command bar's re-time path", () => {
    /** A direct (unattached) block, 06:00-10:00, no target typed. */
    function directFixture(overrides: Partial<IndexedAssignment> = {}): IndexedAssignment {
      return {
        ...crewFixture(),
        id: "asg-direct",
        runId: null,
        productId: "prod-1",
        startMin: 360,
        endMin: 480,
        ...overrides,
      };
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

    it("D1: a direct block with no run writes ONE updateAssignmentFields call, timerange only", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = directFixture();
      const index = buildIndex([a]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeAssignmentFromCommand({
          assignmentId: "asg-direct",
          range: { startMin: 360, endMin: 720 },
          anchor: { x: 10, y: 10 },
        });
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const call = vi.mocked(api.updateAssignmentFields).mock.calls[0];
      expect(call?.[0]).toBe("asg-direct");
      expect(call?.[1]).toEqual({
        timerange: {
          start: new Date("2026-08-24T06:00:00.000Z"),
          end: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
    });

    it("D2: leaving the home run asks (R-365); Continue writes the detach beside the timerange", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = crewFixture(); // 360-600, attached to run-1 (also 360-600)
      const index = buildIndex([a]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeAssignmentFromCommand({
          assignmentId: a.id,
          range: { startMin: 360, endMin: 720 }, // past run-1's own end (600) -- no longer contained
          anchor: { x: 10, y: 10 },
        });
      });

      expect(prompt(result)).not.toBeNull();
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmYes();
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.runId).toBe(null);
      expect(sent?.productId).toBe(runFixture.productId);
      expect(sent?.timerange).toEqual({
        start: new Date("2026-08-24T06:00:00.000Z"),
        end: new Date("2026-08-24T12:00:00.000Z"),
      });
    });

    it("D3: a typed target asks keep-or-scale; Scale writes the scaled figure in the same PATCH", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a = directFixture({
        id: "asg-target",
        startMin: 360,
        endMin: 600, // 4h
        targetQty: 100,
        targetUnit: null,
      });
      const index = buildIndex([a]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeAssignmentFromCommand({
          assignmentId: "asg-target",
          range: { startMin: 360, endMin: 720 }, // 6h -- scales 100 -> 150
          anchor: { x: 10, y: 10 },
        });
      });

      const p = prompt(result);
      expect(p).not.toBeNull();
      expect(p?.title).toBe("Keep or scale?");
      expect(p?.choices?.map((c) => c.label)).toEqual(["Keep 100", "Scale to 150"]);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmChoose(1); // Scale
      });

      await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
      const sent = vi.mocked(api.updateAssignmentFields).mock.calls[0]?.[1];
      expect(sent?.targetQty).toBe(150);
    });

    it("D4: canPlace false writes nothing and opens no popover", async () => {
      const api = await import("@/lib/api");
      const a = directFixture();
      const index = buildIndex([a]);
      const { result } = renderHook(
        () => useDragGesture(baseArgs(index, "user-1", "plant_1", /* canPlace */ false)),
        { wrapper },
      );

      act(() => {
        result.current.retimeAssignmentFromCommand({
          assignmentId: "asg-direct",
          range: { startMin: 360, endMin: 720 },
          anchor: { x: 10, y: 10 },
        });
      });

      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      expect(result.current.popover).toBe(null);
    });

    it("D5: an unknown assignmentId writes nothing and toasts that the block is gone", async () => {
      const api = await import("@/lib/api");
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeAssignmentFromCommand({
          assignmentId: "does-not-exist",
          range: { startMin: 360, endMin: 720 },
          anchor: { x: 10, y: 10 },
        });
      });

      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain("That block is no longer on the board. — reverted.");
    });
  });

  /**
   * S41-a — `retimeRunFromCommand`: the typed command bar's "change that
   * job's hours?" path (R-387), the SAME `retimeRun` an edge-resize drag
   * commits through (extracted from `commitBlockDrag`'s run-resize branch).
   */
  describe("S41-a: retimeRunFromCommand -- the command bar's re-time-a-job path", () => {
    /** A second run on cell-1, 12:00-15:00, so a candidate range can be made
     *  to collide with SOMETHING OTHER than run-1 itself (D8). */
    const run2Fixture: IndexedRun = {
      ...runFixture,
      id: "run-2",
      timerange: "[2026-08-24 12:00:00+00,2026-08-24 15:00:00+00)",
      startMin: 720,
      endMin: 900,
    };

    function buildIndexWithTwoRuns(): BoardIndex {
      return {
        ...buildIndex([]),
        runsByNode: new Map([["cell-1", [runFixture, run2Fixture]]]),
        runById: new Map([
          ["run-1", runFixture],
          ["run-2", run2Fixture],
        ]),
      };
    }

    function confirmPrompt(result: { current: { popover: unknown } }) {
      const p = result.current.popover as { kind: string; message?: string } | null;
      return p && p.kind === "confirm" ? p : null;
    }

    it("D6: retimeRunFromCommand on an unstaffed run writes ONE updateRunFields call", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      const index = buildIndex([]); // run-1, no crew
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeRunFromCommand({
          runId: "run-1",
          range: { startMin: 360, endMin: 720 },
          anchor: { x: 10, y: 10 },
        });
      });

      await waitFor(() => expect(api.updateRunFields).toHaveBeenCalledTimes(1));
      const call = vi.mocked(api.updateRunFields).mock.calls[0];
      expect(call?.[0]).toBe("run-1");
      expect(call?.[1]).toEqual({
        timerange: {
          start: new Date("2026-08-24T06:00:00.000Z"),
          end: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
    });

    it("D7: a staffed run whose crew would fall outside asks first; Continue then writes", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      const crew = crewFixture(); // 360-600, attached to run-1 (also 360-600)
      const index = buildIndex([crew]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeRunFromCommand({
          runId: "run-1",
          range: { startMin: 480, endMin: 600 }, // shrinks the run; crew (360-600) is clipped
          anchor: { x: 10, y: 10 },
        });
      });

      const p = confirmPrompt(result);
      expect(p).not.toBeNull();
      expect(p?.message).toContain("1 crew assignment");
      expect(api.updateRunFields).not.toHaveBeenCalled();

      act(() => {
        result.current.confirmYes();
      });

      await waitFor(() => expect(api.updateRunFields).toHaveBeenCalledTimes(1));
      const call = vi.mocked(api.updateRunFields).mock.calls[0];
      expect(call?.[0]).toBe("run-1");
      expect(call?.[1]).toEqual({
        timerange: {
          start: new Date("2026-08-24T08:00:00.000Z"),
          end: new Date("2026-08-24T10:00:00.000Z"),
        },
      });
    });

    it("D8: a candidate overlapping another run on the cell toasts and writes nothing", async () => {
      const api = await import("@/lib/api");
      const index = buildIndexWithTwoRuns();
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeRunFromCommand({
          runId: "run-1",
          range: { startMin: 600, endMin: 800 }, // overlaps run-2 (720-900)
          anchor: { x: 10, y: 10 },
        });
      });

      expect(api.updateRunFields).not.toHaveBeenCalled();
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages.some((m) => m.includes("already runs"))).toBe(true);
    });

    it("D9: an unknown run id writes nothing and toasts that the job is gone", async () => {
      const api = await import("@/lib/api");
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.retimeRunFromCommand({
          runId: "does-not-exist",
          range: { startMin: 360, endMin: 720 },
          anchor: { x: 10, y: 10 },
        });
      });

      expect(api.updateRunFields).not.toHaveBeenCalled();
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain("That job is no longer on the board. — reverted.");
    });
  });

  /**
   * S58 (R-415, D132 item 4): `CommandBar`'s own headcount write -- through
   * the SAME `updateRunFields` mutation `saveRunFields`'s own D6/D7/D8/D9
   * cases above already prove (no second door), never a popover (there is
   * nothing here to close).
   */
  describe("S58: setHeadcountFromCommand -- the command bar's headcount path", () => {
    it("writes plannedHeadcount and reads the run's OWN notes back unchanged -- a headcount change must never blank them", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      const index = buildIndex([]); // run-1, notes null by default
      const indexWithNotes: BoardIndex = {
        ...index,
        runById: new Map([["run-1", { ...runFixture, notes: "Handle with care" }]]),
      };
      const { result } = renderHook(() => useDragGesture(baseArgs(indexWithNotes)), { wrapper });

      act(() => {
        result.current.setHeadcountFromCommand("run-1", 4);
      });

      await waitFor(() => expect(api.updateRunFields).toHaveBeenCalledTimes(1));
      const call = vi.mocked(api.updateRunFields).mock.calls[0];
      expect(call?.[0]).toBe("run-1");
      expect(call?.[1]).toEqual({ notes: "Handle with care", plannedHeadcount: 4 });
    });

    it("a run with no notes at all sends notes: null, never undefined or blank", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      const index = buildIndex([]); // run-1, notes null by default
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.setHeadcountFromCommand("run-1", 6);
      });

      await waitFor(() => expect(api.updateRunFields).toHaveBeenCalledTimes(1));
      const call = vi.mocked(api.updateRunFields).mock.calls[0];
      expect(call?.[0]).toBe("run-1");
      expect(call?.[1]).toEqual({ notes: null, plannedHeadcount: 6 });
    });

    it("a mutation failure toasts the same way saveRunFields's own D8-style failure does (failWith, reverted)", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockRejectedValueOnce({ kind: "WriteRefused" });
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.setHeadcountFromCommand("run-1", 4);
      });

      await waitFor(() => {
        const messages = useToastStore.getState().toasts.map((t) => t.message);
        expect(
          messages.some(
            (m) =>
              m.includes("You don't have permission to change that.") && m.endsWith("— reverted."),
          ),
        ).toBe(true);
      });
    });

    /**
     * Reviewer fix (S58-d lane review, 14 Sept): a stale board -- the runId
     * the command bar resolved is no longer in `index.runById` -- used to
     * fall through to `run?.notes ?? null` and send the write ANYWAY,
     * fabricating `notes: null`; had the runId still existed server-side
     * (this client just has not caught up), that would have silently blanked
     * its real notes on a "successful" write -- the exact shape D9 above
     * already guards against for `retimeRunFromCommand`. No crash either
     * way (`buildIndex([])` still has `run-1`; only the unknown id is new
     * here), but the write must never leave this function at all.
     */
    it("an unknown run id writes nothing and toasts that the job is gone, same as D9's retimeRunFromCommand case", async () => {
      const api = await import("@/lib/api");
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      act(() => {
        result.current.setHeadcountFromCommand("does-not-exist", 4);
      });

      expect(api.updateRunFields).not.toHaveBeenCalled();
      const messages = useToastStore.getState().toasts.map((t) => t.message);
      expect(messages).toContain("That job is no longer on the board. — reverted.");
    });
  });

  /**
   * S58 (R-415, D132 item 4): a headcount can never reach a lot by type --
   * `ResolvedAny` (`CommandBar.tsx`) excludes `ResolvedHeadcount` -- so this
   * pins the runner's own DEFENSIVE refusal branch, reached only by forcing
   * a shape past the type system the way a future caller's bug might.
   */
  describe("S58: runLot refuses a headcount step it should never receive", () => {
    it("a headcount-shaped entry in the lot is refused with LotStepRefused's own message, nothing written, nothing else attempted", async () => {
      const api = await import("@/lib/api");
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      const lot = [
        {
          intent: "headcount",
          runId: "run-1",
          nodeId: "cell-1",
          headcount: 4,
          readout: "Housing A · Cell 1 · 2026-08-24 · 06:00-10:00 · 4 people",
        },
        { intent: "unassign", assignmentId: "asg-1", readout: "Removing block 1" },
      ] as unknown as ResolvedAny[];

      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });

      expect(outcome).toEqual({
        done: 0,
        error: "A headcount change cannot be part of a lot.",
      });
      expect(api.updateRunFields).not.toHaveBeenCalled();
      expect(api.deleteAssignment).not.toHaveBeenCalled();
    });
  });

  /**
   * S51 review fix -- blocker 1 (an awaited removal reports the lot's own
   * failure instead of counting a refused write as done) and blocker 2 (a
   * retime that would need a popover's own decision rejects instead of
   * opening one mid-lot, D127: the yes already given was for the readouts
   * shown, never for a question raised after it).
   */
  describe("S51 review fix: runLot", () => {
    it("a refused removal (the mutation rejects) yields {done: 0, error: <the toast wording>}, and the second command is never attempted", async () => {
      const api = await import("@/lib/api");
      // requireWritten's own shape for an RLS-refused zero-row delete.
      vi.mocked(api.deleteAssignment).mockRejectedValueOnce({ kind: "WriteRefused" });
      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      const lot: ResolvedAny[] = [
        {
          intent: "unassign",
          assignmentId: "asg-1",
          readout: "Removing block 1",
          attempted: "the step",
          notTried: "it stays.",
        },
        {
          intent: "unassign",
          assignmentId: "asg-2",
          readout: "Removing block 2",
          attempted: "the step",
          notTried: "it stays.",
        },
      ];

      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });

      expect(outcome).toEqual({ done: 0, error: "You don't have permission to change that." });
      expect(api.deleteAssignment).toHaveBeenCalledTimes(1);
      expect(api.deleteAssignment).toHaveBeenCalledWith("asg-1");
    });

    it("a lot-aware retime that would need a decision (an attachment change) rejects with the message and writes nothing", async () => {
      const api = await import("@/lib/api");
      const a = crewFixture(); // 360-600, attached to run-1 (also 360-600)
      const index = buildIndex([a]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      const lot: ResolvedAny[] = [
        {
          intent: "move",
          assignmentId: a.id,
          nodeId: "cell-1",
          operatorId: "op-1",
          productId: "prod-1",
          range: { startMin: 360, endMin: 720 }, // past run-1's own end -- an attachment change
          target: { kind: "retime" },
          readout: "Moving Test Person's block",
          attempted: "the step",
          notTried: "it stays.",
        },
      ];

      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });

      // S195-D (CONTRACT CHANGED, CLAUDE.md 4: the rule is the same -- a lot
      // never opens a question mid-way -- the WORDS were the code's: "re-time",
      // "pop-up"; R-459). See P-12 below for both such steps.
      expect(outcome).toEqual({
        done: 0,
        error: "That one needs an answer on the board; say it on its own.",
      });
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      expect(result.current.popover).toBeNull(); // never opened, D127
    });

    it("a plain retime (no ask needed) awaits the update mutation and reports it done", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
      const a: IndexedAssignment = {
        ...crewFixture(),
        id: "asg-direct",
        runId: null,
        productId: "prod-1",
        startMin: 360,
        endMin: 480,
      };
      const index = buildIndex([a]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

      const lot: ResolvedAny[] = [
        {
          intent: "assign",
          nodeId: "cell-1",
          operatorId: "op-1",
          productId: "prod-1",
          target: { kind: "retime", assignmentId: "asg-direct" },
          range: { startMin: 360, endMin: 720 },
          readout: "Test Person → Widget · Cell 1 · 06:00–12:00",
          attempted: "the step",
          notTried: "it stays.",
        },
      ];

      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });

      expect(outcome).toEqual({ done: 1, error: null });
      expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1);
      const call = vi.mocked(api.updateAssignmentFields).mock.calls[0];
      expect(call?.[0]).toBe("asg-direct");
      expect(call?.[1]).toEqual({
        timerange: {
          start: new Date("2026-08-24T06:00:00.000Z"),
          end: new Date("2026-08-24T12:00:00.000Z"),
        },
      });
    });
  });

  /**
   * S194-D (DEF-0044 item 4, DEF-0040, DEF-0048): the lot's job and absence
   * steps are held at the EXECUTION layer -- each asserts the writer was
   * called with the step's own id and mode, so deleting the call turns a
   * case red by name (it did not before: with `deleteRun.mutateAsync`
   * removed, 664 cases stayed green).
   */
  describe("S194-D: runLot writes the job removal, the job trim and the absence record", () => {
    it("RL-1: a remove_run step calls delete_run with that run id in cascade mode, and counts it done", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.deleteRun).mockResolvedValue({
        deletedRunId: "run-1",
        detachedAssignmentIds: [],
      } as never);
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });
      const lot: ResolvedAny[] = [
        {
          intent: "remove_run",
          runId: "run-1",
          readout: "The Housing A job is off Cell 1",
          attempted: "the step",
          notTried: "it stays.",
        },
      ];
      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });
      expect(outcome).toEqual({ done: 1, error: null });
      expect(api.deleteRun).toHaveBeenCalledTimes(1);
      expect(api.deleteRun).toHaveBeenCalledWith("run-1", "cascade");
    });

    it("RL-2: a trim_run step PATCHes that run's timerange to the kept part, even with its crew still reaching past it on the board the yes was given against", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      // The crew block still runs 06:00-10:00 in this (stale) index -- the
      // lot trimmed it in an earlier step; `retimeRunForLot` would refuse
      // here with the drag's "fall outside" ask.
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([crewFixture()]))), {
        wrapper,
      });
      const lot: ResolvedLotStep[] = [
        {
          intent: "trim_run",
          runId: "run-1",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          readout: "The job on Cell 1 keeps its part",
          attempted: "the step",
          notTried: "The job on Cell 1 stays as it was.",
        },
      ];
      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });
      expect(outcome).toEqual({ done: 1, error: null });
      expect(api.updateRunFields).toHaveBeenCalledTimes(1);
      expect(api.updateRunFields).toHaveBeenCalledWith("run-1", {
        timerange: {
          start: new Date("2026-08-24T06:00:00.000Z"),
          end: new Date("2026-08-24T08:00:00.000Z"),
        },
      });
    });

    it("RL-3: a trim_run step on a job no longer on the board writes nothing and stops the lot in plain words", async () => {
      const api = await import("@/lib/api");
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });
      const lot: ResolvedLotStep[] = [
        {
          intent: "trim_run",
          runId: "gone-run",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          readout: "The Housing A job on Cell 1 keeps its Sunday part",
          attempted: "the step",
          notTried: "The Housing A job on Cell 1 stays as it was.",
        },
      ];
      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });
      expect(outcome).toEqual({
        done: 0,
        error: "The Housing A job on Cell 1 keeps its Sunday part is no longer on the board.",
      });
      expect(api.updateRunFields).not.toHaveBeenCalled();
    });

    it("RL-4: a record_absence step calls setAbsence (the Absences form's own call) whole-day, with the person, the days and the reason", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.setAbsence).mockResolvedValue({} as never);
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });
      const lot: ResolvedLotStep[] = [
        {
          intent: "record_absence",
          operatorId: "op-1",
          person: "Sam Patel",
          from: "2026-08-24",
          to: "2026-08-25",
          reason: "Sick",
          readout: "Sam Patel is recorded as off from 2026-08-24 to 2026-08-25.",
          attempted: "the step",
          notTried: "No absence is recorded for Sam Patel.",
        },
      ];
      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });
      expect(outcome).toEqual({ done: 1, error: null });
      expect(api.setAbsence).toHaveBeenCalledTimes(1);
      expect(api.setAbsence).toHaveBeenCalledWith({
        operatorId: "op-1",
        from: "2026-08-24",
        to: "2026-08-25",
        reason: "Sick",
      });
    });

    it("RL-5: people first, then the job, then the absence -- written in the lot's own order; a refused record is the lot's own caught failure after the rest are done", async () => {
      const api = await import("@/lib/api");
      vi.mocked(api.deleteAssignment).mockResolvedValue(undefined as never);
      vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
      vi.mocked(api.deleteRun).mockResolvedValue({
        deletedRunId: "run-2",
        detachedAssignmentIds: [],
      } as never);
      vi.mocked(api.setAbsence).mockRejectedValueOnce({ kind: "WriteRefused" });
      const { result } = renderHook(() => useDragGesture(baseArgs(buildIndex([]))), { wrapper });
      const lot: ResolvedLotStep[] = [
        {
          intent: "unassign",
          assignmentId: "asg-1",
          readout: "Sam is off Cell 1",
          attempted: "the step",
          notTried: "it stays.",
        },
        {
          intent: "trim_run",
          runId: "run-1",
          nodeId: "cell-1",
          range: { startMin: 360, endMin: 480 },
          readout: "The job keeps its part",
          attempted: "the step",
          notTried: "The job stays.",
        },
        {
          intent: "remove_run",
          runId: "run-2",
          readout: "The other job is off Cell 1",
          attempted: "the step",
          notTried: "it stays.",
        },
        {
          intent: "record_absence",
          operatorId: "op-1",
          person: "Sam",
          from: "2026-08-24",
          to: "2026-08-24",
          reason: "Off",
          readout: "Sam is recorded as off 2026-08-24.",
          attempted: "the step",
          notTried: "No absence is recorded for Sam.",
        },
      ];
      let outcome: LotResult | undefined;
      await act(async () => {
        outcome = await result.current.runLot(lot);
      });
      expect(outcome).toEqual({ done: 3, error: "You don't have permission to change that." });
      const order = [
        vi.mocked(api.deleteAssignment).mock.invocationCallOrder[0],
        vi.mocked(api.updateRunFields).mock.invocationCallOrder[0],
        vi.mocked(api.deleteRun).mock.invocationCallOrder[0],
        vi.mocked(api.setAbsence).mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  /**
   * F-233 (S194-G): the fault, reproduced. `createAssignment`/`createRun`
   * are held back (a deferred promise, resolved only when the test says
   * so) -- while held, the optimistic row `onMutate` adds to the query
   * cache carries a placeholder id (`optimisticId.ts`), and a drag started
   * on THAT row (the second door -- a person grabbing the chip they just
   * placed, or dropped, before the server has answered) must do nothing at
   * all: no `activeDrag`, no popover, no writer ever called with that id.
   * `commandBar.test.tsx`'s own F-233 block proves the OTHER half -- a
   * sentence held while unsettled reruns and writes once the real row
   * lands -- since that half is `CommandBar.tsx`'s own `runCommand`, not
   * anything this hook does; no existing harness combines both at once
   * (BoardPage's real ctx-building, CommandBar's submit pipeline and these
   * real, React-Query-backed mutation hooks together), so this file proves
   * ITS half and that file proves the other, rather than a single giant
   * fixture standing in for `BoardPage` that nothing else here needs.
   */
  describe("F-233: a row the server has not answered for yet is never sent to it", () => {
    it("a held-back assignment create carries a placeholder id, and a drag started on it does nothing", async () => {
      const api = await import("@/lib/api");
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const key = boardKeys.window(
        "plant_1",
        WINDOW_START,
        new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
      );
      client.setQueryData(key, boardWindowFixture());

      // D61: `submitCreateDirect` probes capacity before it ever calls
      // `createAssignment` -- a plain `vi.fn()` with no implementation
      // returns `undefined`, not a promise, so this must resolve "fits"
      // for the create to reach the mutation this test actually holds back.
      vi.mocked(api.probeCapacity).mockResolvedValue({
        fits: true,
        cap: 1,
        peak: 0.5,
        overlapping: [],
      } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);

      let resolveCreate!: (v: unknown) => void;
      vi.mocked(api.createAssignment).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve as (v: unknown) => void;
          }),
      );

      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), {
        wrapper: wrapperWithClient(client),
      });

      // `onMutate` is async (it awaits `cancelQueries` first), so its own
      // `setQueryData` lands a microtask after `mutate` returns -- an
      // async `act` flushes that before this reads the cache back.
      await act(async () => {
        void result.current.submitCreateDirect(
          "cell-1",
          { startMin: 360, endMin: 420 },
          "op-1",
          { kind: "direct", productId: "prod-1" },
          100,
          undefined,
          undefined,
          false,
          undefined,
          false,
          undefined,
          { x: 0, y: 0 },
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // The optimistic row is in the cache, and its id is a placeholder --
      // `onMutate` (useAssignmentMutations.ts) built it with
      // `makePlaceholderId()`.
      const cached = client.getQueryData<BoardWindow>(key);
      expect(cached?.assignments).toHaveLength(1);
      const placeholderId = cached!.assignments[0].id;
      expect(isPlaceholderId(placeholderId)).toBe(true);

      // The second door: grab that exact row with the pointer. A fresh
      // IndexedAssignment carrying the SAME id (the shape a re-rendered
      // board would draw it with) -- `beginBlockDrag` must refuse it.
      const placeholderAssignment: IndexedAssignment = { ...crewFixture(), id: placeholderId };
      const drag2 = renderHook(
        () => useDragGesture(baseArgs(buildIndex([placeholderAssignment]))),
        { wrapper: wrapperWithClient(client) },
      );
      act(() => {
        drag2.result.current.beginBlockDrag(
          {
            nodeId: "cell-1",
            subject: { kind: "assignment", assignment: placeholderAssignment, homeRun: null },
            original: {
              startMin: placeholderAssignment.startMin,
              endMin: placeholderAssignment.endMin,
            },
            pxPerHour: 100,
            windowMinutes: WINDOW_MINUTES,
            template: null,
            dayCount: 1,
            dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
            zoomIndex: 1,
            handlePx: 8,
            blockWidthPx: 200,
            offsetXPx: 100,
            runsOnNode: [runFixture],
            crew: [],
          },
          fakePointerEvent(500, 300),
        );
      });
      expect(drag2.result.current.activeDrag).toBe(null);
      expect(drag2.result.current.popover).toBe(null);
      act(() => {
        drag2.result.current.updateBlockDrag(fakePointerEvent(560, 300));
        drag2.result.current.endBlockDrag(fakePointerEvent(560, 300));
      });
      expect(drag2.result.current.popover).toBe(null);
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      expect(api.deleteAssignment).not.toHaveBeenCalled();

      // Let the create land -- the mutation settles; nothing above ever
      // sent the placeholder id anywhere. F-233, third pass (S194-G3):
      // `submitCreateDirect` now reads the real row's own id off this
      // resolved value (`result.assignment.id`) to answer the bar's write
      // outcome with it -- a bare `{}` would throw reading `.id` of
      // `undefined`.
      await act(async () => {
        resolveCreate({ assignment: { id: "created-assignment-1" } });
      });
      await waitFor(() => expect(api.createAssignment).toHaveBeenCalledTimes(1));
      expect(api.updateAssignmentFields).not.toHaveBeenCalled();
      expect(api.deleteAssignment).not.toHaveBeenCalled();
    });

    it("the same for a job: a held-back run create carries a placeholder id, and a drag started on it does nothing", async () => {
      const api = await import("@/lib/api");
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const key = boardKeys.window(
        "plant_1",
        WINDOW_START,
        new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
      );
      client.setQueryData(key, boardWindowFixture());

      let resolveCreate!: (v: unknown) => void;
      vi.mocked(api.createRun).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve as (v: unknown) => void;
          }),
      );

      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), {
        wrapper: wrapperWithClient(client),
      });

      // 700-960, not 360-960: `buildIndex` always seats `runFixture`
      // (360-600) on "cell-1" regardless of the `crew` argument -- this
      // window starts after it ends, so the overlap check this hook runs
      // before ever calling `createRun` does not refuse the create.
      await act(async () => {
        void result.current.submitCreateRun(
          "cell-1",
          { startMin: 700, endMin: 960 },
          "prod-run",
          undefined,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      const cached = client.getQueryData<BoardWindow>(key);
      expect(cached?.runs).toHaveLength(1);
      const placeholderId = cached!.runs[0].id;
      expect(isPlaceholderId(placeholderId)).toBe(true);

      const placeholderRun: IndexedRun = { ...runFixture, id: placeholderId };
      const indexWithPlaceholderRun: BoardIndex = {
        ...buildIndex([]),
        runById: new Map([[placeholderId, placeholderRun]]),
        runsByNode: new Map([["cell-1", [placeholderRun]]]),
      };
      const drag2 = renderHook(() => useDragGesture(baseArgs(indexWithPlaceholderRun)), {
        wrapper: wrapperWithClient(client),
      });
      act(() => {
        drag2.result.current.beginBlockDrag(
          {
            nodeId: "cell-1",
            subject: { kind: "run", run: placeholderRun },
            original: { startMin: placeholderRun.startMin, endMin: placeholderRun.endMin },
            pxPerHour: 100,
            windowMinutes: WINDOW_MINUTES,
            template: null,
            dayCount: 1,
            dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
            zoomIndex: 1,
            handlePx: 8,
            blockWidthPx: 200,
            offsetXPx: 100,
            runsOnNode: [placeholderRun],
            crew: [],
          },
          fakePointerEvent(500, 300),
        );
      });
      expect(drag2.result.current.activeDrag).toBe(null);
      expect(drag2.result.current.popover).toBe(null);
      expect(api.updateRunFields).not.toHaveBeenCalled();
      expect(api.deleteRun).not.toHaveBeenCalled();

      // F-233, third pass (S194-G3): `submitCreateRun` now reads the real
      // row's own id off this resolved value (`result.run.id`) -- see the
      // assignment case's own identical comment above.
      await act(async () => {
        resolveCreate({ run: { id: "created-run-1" } });
      });
      await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));
      expect(api.updateRunFields).not.toHaveBeenCalled();
      expect(api.deleteRun).not.toHaveBeenCalled();
    });

    /**
     * S194-G3, proving item 2: `submitCreateDirect` answers the SERVER's OWN
     * id, read off `create_assignment`'s own resolved `assignment.id` --
     * never a placeholder, never invented -- so `CommandBar.tsx`'s own
     * `awaitingRowIdRef` waits for the id the ROW ACTUALLY HAS. Mutation-tested:
     * `return { kind: "written", id: result.assignment.id }` changed to a
     * literal/wrong id (`useDragGesture.ts`) turns this red.
     */
    it("submitCreateDirect answers the server's own real id, not a placeholder", async () => {
      const api = await import("@/lib/api");
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const key = boardKeys.window(
        "plant_1",
        WINDOW_START,
        new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
      );
      client.setQueryData(key, boardWindowFixture());
      vi.mocked(api.probeCapacity).mockResolvedValue({
        fits: true,
        cap: 1,
        peak: 0.5,
        overlapping: [],
      } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
      vi.mocked(api.createAssignment).mockResolvedValue({
        assignment: { ...crewFixture(), id: "server-assigned-id-42" },
        eligibility: { eligible: true, policy: "warn", missingSkills: [], expiringSkills: [] },
        absence: { absent: false, from: null, to: null, reason: null },
      });

      const index = buildIndex([]);
      const { result } = renderHook(() => useDragGesture(baseArgs(index)), {
        wrapper: wrapperWithClient(client),
      });

      let verdict: { kind: "written"; id: string } | "handed-off" | undefined;
      await act(async () => {
        verdict = await result.current.submitCreateDirect(
          "cell-1",
          { startMin: 360, endMin: 420 },
          "op-1",
          { kind: "direct", productId: "prod-1" },
          100,
          undefined,
          undefined,
          false,
          undefined,
          false,
          undefined,
          { x: 0, y: 0 },
        );
      });

      expect(verdict).toEqual({ kind: "written", id: "server-assigned-id-42" });
    });
  });
});

/**
 * S195-D (DEF-0054, R-434, R-431, R-459): every pop-up a typed sentence opens
 * answers the sentence back, exactly once -- Continue's write as `written` or
 * `refused`, Cancel (or closing it) as `cancelled` -- and the writer says NOW,
 * in one plain sentence built from the board's own facts, what is being asked.
 * The create pop-up and the split pop-up already had a reporter (F-167, S62-b);
 * the board's own Continue? / keep-or-scale / crew-outside questions had none.
 */
describe("S195-D: the board's own questions answer the sentence that opened them (DEF-0054)", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
  });

  /** An index that knows Sam Patel and Housing A by name, so the sentences the
   *  bar says are the real ones a person would read. */
  function namedIndex(crew: IndexedAssignment[]): BoardIndex {
    return {
      ...buildIndex(crew),
      operatorById: new Map([
        ["op-1", { id: "op-1", displayName: "Sam Patel" } as unknown as BoardOperator],
      ]),
      productById: new Map([["prod-1", { id: "prod-1", name: "Housing A" } as unknown as never]]),
    };
  }

  /** `endPanelDrag` opens only over a track row the index knows about. */
  function namedIndexWithNode(): BoardIndex {
    const node: BoardNode = {
      id: "cell-1",
      parentId: null,
      levelId: "cell",
      name: "Cell 1",
      path: "plant_1.line_1.cell_1",
      sortOrder: 0,
      active: true,
    };
    return { ...namedIndex([]), nodeById: new Map([["cell-1", node]]) };
  }

  function reporter() {
    const seen: { kind: string; message?: string; what?: string }[] = [];
    return { seen, report: (r: { kind: string }) => seen.push(r) };
  }

  it("P-1: the re-time that takes a person off their job says so in words, and Continue reports the write as written", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
    const a = crewFixture();
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    let answer: unknown;
    act(() => {
      answer = result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 }, // past the job's own end: leaves it
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });

    // The writer answers NOW (never through a promise the bar would show the
    // done-form readout while it waits for), with the sentence.
    expect(answer).toEqual({
      kind: "popup",
      waitingFor:
        "The board is asking whether to take Sam Patel off the Housing A job. Answer it on the board.",
    });
    expect(seen).toEqual([]);
    expect(api.updateAssignmentFields).not.toHaveBeenCalled();

    act(() => result.current.confirmYes());
    await waitFor(() => expect(seen).toEqual([{ kind: "written" }]));
    expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1);
  });

  it("P-2: Cancel on that question reports cancelled, writes nothing, and reports once", async () => {
    const api = await import("@/lib/api");
    const a = crewFixture();
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    act(() => result.current.confirmNo());
    act(() => result.current.confirmNo()); // Escape after the button: nothing more to say
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(seen).toEqual([{ kind: "cancelled" }]);
    expect(api.updateAssignmentFields).not.toHaveBeenCalled();
    expect(result.current.popover).toBeNull();
  });

  it("P-2b (S195 review): a pop-up opened BY HAND while the sentence's Continue? stands replaces it -- the sentence is told cancelled, once, and Continue reports nothing more", async () => {
    const api = await import("@/lib/api");
    const a = crewFixture();
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    expect(result.current.popover?.kind).toBe("confirm");
    // Enter on an empty track: the create pop-up takes the confirm's place.
    act(() => {
      result.current.handleTrackKeyDown(
        {
          key: "Enter",
          preventDefault: () => {},
          currentTarget: {
            getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, right: 0 }),
          },
        } as never,
        { nodeId: "cell-1", template: null, windowMinutes: 1440 },
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.popover?.kind).toBe("create");
    expect(seen).toEqual([{ kind: "cancelled" }]);
    expect(api.updateAssignmentFields).not.toHaveBeenCalled();
  });

  it("P-2c (S195 review): the same sentence's OWN next pop-up (keep-or-scale, then the attachment) is not a replacement -- nothing is reported until it is answered", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
    const a: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-target",
      productId: "prod-1",
      targetQty: 100,
      targetUnit: null,
    };
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });
    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    act(() => result.current.confirmChoose(0)); // Keep: the attachment question comes next
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.popover?.kind).toBe("confirm");
    expect(seen).toEqual([]);
    act(() => result.current.confirmNo());
    expect(seen).toEqual([{ kind: "cancelled" }]);
  });

  it("P-3: the server refusing the write after Continue reports refused, in the app's own words", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateAssignmentFields).mockRejectedValue({ kind: "WriteRefused" });
    const a = crewFixture();
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    act(() => result.current.confirmYes());

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({
      kind: "refused",
      message: "You don't have permission to change that.",
    });
  });

  it("P-4: the keep-or-scale question says what it asks; Scale reports written, Cancel reports cancelled", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
    const a: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-target",
      runId: null,
      productId: "prod-1",
      startMin: 360,
      endMin: 600,
      targetQty: 100,
      targetUnit: null,
    };
    const first = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    let answer: unknown;
    act(() => {
      answer = result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: first.report as never,
      });
    });
    expect(answer).toEqual({
      kind: "popup",
      waitingFor:
        "The board is asking what to do with the target for Sam Patel's block. Answer it on the board.",
    });
    act(() => result.current.confirmChoose(1)); // Scale
    await waitFor(() => expect(first.seen).toEqual([{ kind: "written" }]));

    const second = reporter();
    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: second.report as never,
      });
    });
    act(() => result.current.confirmNo());
    expect(second.seen).toEqual([{ kind: "cancelled" }]);
  });

  it("P-5: the crew-outside-the-job's-new-hours question says what it asks, and reports Continue and Cancel", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateRunFields).mockResolvedValue({} as never);
    const crew = crewFixture();
    const cont = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([crew]))), { wrapper });

    let answer: unknown;
    act(() => {
      answer = result.current.retimeRunFromCommand({
        runId: "run-1",
        range: { startMin: 480, endMin: 600 },
        anchor: { x: 10, y: 10 },
        onResult: cont.report as never,
      });
    });
    expect(answer).toEqual({
      kind: "popup",
      waitingFor:
        "The board is asking what to do with the people outside the job's new hours. Answer it on the board.",
    });
    act(() => result.current.confirmYes());
    await waitFor(() => expect(cont.seen).toEqual([{ kind: "written" }]));

    const cancel = reporter();
    act(() => {
      result.current.retimeRunFromCommand({
        runId: "run-1",
        range: { startMin: 480, endMin: 600 },
        anchor: { x: 10, y: 10 },
        onResult: cancel.report as never,
      });
    });
    act(() => result.current.confirmNo());
    expect(cancel.seen).toEqual([{ kind: "cancelled" }]);
    expect(api.updateRunFields).toHaveBeenCalledTimes(1);
  });

  it("P-6: the three create forms answer 'standing: false' -- the pop-up itself says when it is on screen", () => {
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([]))), { wrapper });
    const sentence = "The board has opened the details for this one. Finish it on the board.";
    const anchor = { x: 10, y: 10 };
    const range = { startMin: 360, endMin: 480 };

    let person: unknown;
    let job: unknown;
    let move: unknown;
    act(() => {
      person = result.current.openCreateFromCommand({
        nodeId: "cell-1",
        range,
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        anchor,
      });
    });
    act(() => {
      job = result.current.openCreateRunFromCommand({
        nodeId: "cell-1",
        range,
        productId: "prod-1",
        headcount: 2,
        anchor,
      });
    });
    act(() => {
      move = result.current.openMoveFromCommand({
        assignmentId: "asg-1",
        nodeId: "cell-1",
        range,
        operatorId: "op-1",
        productId: "prod-1",
        anchor,
      });
    });
    for (const answer of [person, job, move]) {
      expect(answer).toEqual({ kind: "popup", waitingFor: sentence, standing: false });
    }
  });

  it("P-7: a sentence that reaches the split pop-up is told, in the person's own name, what it waits on", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.probeCapacity).mockResolvedValue({
      fits: false,
      cap: 1,
      peak: 1.5,
      overlapping: [],
    } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([]))), { wrapper });

    act(() => {
      result.current.openCreateFromCommand({
        nodeId: "cell-1",
        range: { startMin: 360, endMin: 480 },
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    await act(async () => {
      await result.current.submitCreateDirect(
        "cell-1",
        { startMin: 360, endMin: 480 },
        "op-1",
        { kind: "direct", productId: "prod-1" },
        100,
        undefined,
        undefined,
        false,
        undefined,
        false,
        undefined,
        { x: 10, y: 10 },
      );
    });
    await waitFor(() => expect(result.current.popover?.kind).toBe("split"));

    expect(seen).toEqual([
      {
        kind: "handed_off",
        what: "Sam Patel is already booked then. The board is asking how to split the time. Answer it on the board.",
      },
    ]);
  });

  it("P-8: a drag's own pop-up carries no reporter, and a drag opened AFTER a sentence never answers that sentence", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.probeCapacity).mockResolvedValue({
      fits: false,
      cap: 1,
      peak: 1.5,
      overlapping: [],
    } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
    const { seen, report } = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndexWithNode())), {
      wrapper,
    });

    // A sentence opens a create pop-up, which is then replaced by a
    // drag-opened one (a panel drop) -- the sentence's reporter must not be
    // what the split pop-up of THAT drag answers.
    act(() => {
      result.current.openCreateFromCommand({
        nodeId: "cell-1",
        range: { startMin: 360, endMin: 480 },
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    act(() => {
      result.current.setDropRowResolver(() => ({ nodeId: "cell-1", isTrack: true, minute: 360 }));
    });
    act(() => {
      result.current.beginPanelDrag(
        {
          id: "op-1",
          homeNodeId: null,
          homeShiftId: null,
          displayName: "Sam Patel",
          employeeRef: null,
          active: true,
          siteNodeId: "plant-1",
          sitePath: "plant_1",
          skillIds: [],
          skillExpiries: [],
        },
        fakePointerEvent(100, 100),
      );
    });
    act(() => {
      result.current.endPanelDrag(fakePointerEvent(100, 100));
    });
    expect(result.current.popover?.kind).toBe("create");
    await act(async () => {
      await result.current.submitCreateDirect(
        "cell-1",
        { startMin: 360, endMin: 480 },
        "op-1",
        { kind: "direct", productId: "prod-1" },
        100,
        undefined,
        undefined,
        false,
        undefined,
        false,
        undefined,
        { x: 10, y: 10 },
      );
    });
    await waitFor(() => expect(result.current.popover?.kind).toBe("split"));
    act(() => result.current.cancelSplit());

    expect(seen).toEqual([]);
  });

  it("P-9: a new sentence that opens its own question ends the one standing -- reported cancelled, once", () => {
    const a = crewFixture();
    const old = reporter();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: old.report as never,
      });
    });
    expect(result.current.popover?.kind).toBe("confirm");

    // The next sentence opens the create pop-up; the confirm is gone.
    act(() => {
      result.current.openCreateFromCommand({
        nodeId: "cell-1",
        range: { startMin: 360, endMin: 480 },
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        anchor: { x: 10, y: 10 },
      });
    });
    expect(result.current.popover?.kind).toBe("create");
    expect(old.seen).toEqual([{ kind: "cancelled" }]);
  });

  it("P-10: the reporter of a confirm fires ONCE under StrictMode (F-128's shape) with no latch of its own", async () => {
    const a = crewFixture();
    const { seen, report } = reporter();
    const strictWrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, createElement(wrapper, null, children));
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), {
      wrapper: strictWrapper,
    });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
        onResult: report as never,
      });
    });
    act(() => result.current.confirmNo());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(seen).toEqual([{ kind: "cancelled" }]);
  });

  it("P-11: a drag's own re-time (no sentence) still asks and writes exactly as before -- Continue with no reporter", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.updateAssignmentFields).mockResolvedValue({} as never);
    const a = crewFixture();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    act(() => {
      result.current.retimeAssignmentFromCommand({
        assignmentId: a.id,
        range: { startMin: 360, endMin: 720 },
        anchor: { x: 10, y: 10 },
      });
    });
    act(() => result.current.confirmYes());
    await waitFor(() => expect(api.updateAssignmentFields).toHaveBeenCalledTimes(1));
    expect(result.current.popover).toBeNull();
  });

  it("P-12: a lot step that would open one of these questions is the lot's refused step in plain words, written nowhere, never a pop-up", async () => {
    const api = await import("@/lib/api");
    const a = crewFixture();
    const { result } = renderHook(() => useDragGesture(baseArgs(namedIndex([a]))), { wrapper });

    // The attachment question (a person leaving their job) ...
    let first: LotResult | undefined;
    await act(async () => {
      first = await result.current.runLot([
        {
          intent: "move",
          assignmentId: a.id,
          nodeId: "cell-1",
          operatorId: "op-1",
          productId: "prod-1",
          range: { startMin: 360, endMin: 720 },
          target: { kind: "retime" },
          readout: "Moving Sam Patel's block",
          attempted: "the step",
          notTried: "it stays.",
        },
      ]);
    });
    // ... and the crew question (a job's new hours strand its crew).
    let second: LotResult | undefined;
    await act(async () => {
      second = await result.current.runLot([
        {
          intent: "book",
          nodeId: "cell-1",
          range: { startMin: 480, endMin: 600 },
          target: { kind: "retime_run", runId: "run-1" },
          readout: "The Housing A job",
          attempted: "the step",
          notTried: "it stays.",
        } as unknown as ResolvedAny,
      ]);
    });

    const said = "That one needs an answer on the board; say it on its own.";
    expect(first).toEqual({ done: 0, error: said });
    expect(second).toEqual({ done: 0, error: said });
    expect(api.updateAssignmentFields).not.toHaveBeenCalled();
    expect(api.updateRunFields).not.toHaveBeenCalled();
    expect(result.current.popover).toBeNull(); // D127: never opened mid-lot
  });
});

/**
 * R-465 (S195-D, the maintainer, 30 Sept): a person busy on a place the caller
 * cannot read is refused in the place's words -- "Sam Patel is already on Cell 4
 * in Line 2 today from 6 am to 2 pm." -- never offered the split pop-up against
 * a block she cannot change, and every write that can meet the cap says the same
 * thing after the server refuses it. The probe is SCRIPTED here: the tester's
 * stack does not have migration 0085 yet, so no real probe returns an outside
 * row; the main session proves it in a browser once the stack is rebuilt.
 */
describe("S195-D: busy on a place the caller cannot read (R-465)", () => {
  // The plant's own "today" is the window's first day in these cases.
  const SAID = "Sam Patel is already on Cell 4 in Line 2 today from 6 am to 2 pm.";
  const TODAY_NOON = new Date("2026-08-24T12:00:00.000Z");

  /** The row `capacity_probe` returns for a block on a place she cannot read. */
  const OUTSIDE_ROW = {
    assignmentId: null,
    nodeId: null,
    nodeName: "Cell 4",
    parentName: "Line 2",
    productName: null,
    timerange: '["2026-08-24 06:00:00+00","2026-08-24 14:00:00+00")',
    efficiency: 1,
    outside: true,
  };
  const READABLE_ROW = {
    assignmentId: "asg-other",
    nodeId: "cell-2",
    nodeName: "Cell 2",
    parentName: "Line 1",
    productName: "Housing A",
    timerange: '["2026-08-24 06:00:00+00","2026-08-24 10:00:00+00")',
    efficiency: 1,
    outside: false,
  };
  const CAPACITY_REFUSAL = {
    kind: "CapacityExceeded",
    operatorId: "op-1",
    peak: 2,
    cap: 1,
    timerange: '["2026-08-24 08:00:00+00","2026-08-24 12:00:00+00")',
  };
  const TODAYS_WORDS =
    "Sam Patel would reach 200% (cap 100%). Someone else changed their load — try the split again.";

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY_NOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function named(crew: IndexedAssignment[]): BoardIndex {
    return {
      ...buildIndex(crew),
      operatorById: new Map([
        ["op-1", { id: "op-1", displayName: "Sam Patel" } as unknown as BoardOperator],
      ]),
      productById: new Map([["prod-1", { id: "prod-1", name: "Housing A" } as unknown as never]]),
    };
  }

  function toasts(): string[] {
    return useToastStore.getState().toasts.map((t) => t.message);
  }

  async function probeSays(rows: unknown[], fits = false) {
    const api = await import("@/lib/api");
    vi.mocked(api.probeCapacity).mockResolvedValue({
      fits,
      cap: 1,
      peak: 2,
      overlapping: rows,
    } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
    return api;
  }

  function submitCreate(result: { current: ReturnType<typeof useDragGesture> }) {
    return result.current.submitCreateDirect(
      "cell-1",
      { startMin: 480, endMin: 720 },
      "op-1",
      { kind: "direct", productId: "prod-1" },
      100,
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      { x: 10, y: 10 },
    );
  }

  it("R-465-1: the create path refuses in the place's words, opens NO split pop-up and sends NOTHING", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });

    let refusal: unknown;
    await act(async () => {
      refusal = await submitCreate(result).catch((e: unknown) => e);
    });

    // The refusal every reader of a capacity refusal says, the pop-up and the bar
    // included (`describeSchedulerError`), and the board's toast in the same words.
    expect(refusal).toMatchObject({
      kind: "CapacityExceeded",
      operatorId: "op-1",
      elsewhere: SAID,
    });
    expect(describeSchedulerError(refusal as never)).toBe(SAID);
    expect(toasts()).toEqual([SAID]);
    expect(result.current.popover).toBeNull();
    expect(api.createAssignment).not.toHaveBeenCalled();
    expect(api.applySplitCoverage).not.toHaveBeenCalled();
  });

  it("R-465-2: one readable block beside the outside one does not make it splittable -- she cannot change the other", async () => {
    const api = await probeSays([READABLE_ROW, OUTSIDE_ROW]);
    const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });

    let refusal: unknown;
    await act(async () => {
      refusal = await submitCreate(result).catch((e: unknown) => e);
    });

    expect(refusal).toMatchObject({ elsewhere: SAID }); // only the outside block, never Cell 2 / Housing A
    expect(result.current.popover).toBeNull();
    expect(api.createAssignment).not.toHaveBeenCalled();
  });

  it("R-465-3: a readable overlap alone still opens the split pop-up, exactly as before", async () => {
    await probeSays([READABLE_ROW]);
    const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });

    let verdict: unknown;
    await act(async () => {
      verdict = await submitCreate(result);
    });

    expect(verdict).toBe("handed-off");
    const p = result.current.popover;
    if (p?.kind !== "split") throw new Error("expected the split pop-up");
    expect(p.participants.map((row) => row.assignmentId)).toEqual(["asg-other", null]);
    expect(toasts()).toEqual([]);
  });

  it("R-465-4: a re-time the server refuses over the cap says the place, in the toast and to the bar; the probe is asked about the same person and hours, the block left out", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.updateAssignmentFields).mockRejectedValue(CAPACITY_REFUSAL);
    const a: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-direct",
      runId: null,
      productId: "prod-1",
      startMin: 480,
      endMin: 600,
    };
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.retimeAssignmentFromCommand({
        assignmentId: "asg-direct",
        range: { startMin: 480, endMin: 720 },
        anchor: { x: 10, y: 10 },
      });
    });

    expect(outcome).toEqual({ kind: "refused", message: SAID });
    expect(toasts()).toEqual([SAID]);
    expect(vi.mocked(api.probeCapacity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.probeCapacity).mock.calls[0][0]).toEqual({
      operatorId: "op-1",
      start: new Date("2026-08-24T08:00:00.000Z"),
      end: new Date("2026-08-24T12:00:00.000Z"),
      efficiencyPercent: 100,
      excludeAssignmentId: "asg-direct",
    });
  });

  it("R-465-5: the probe itself failing keeps today's words, in the toast and to the bar", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.probeCapacity).mockRejectedValue(new Error("network"));
    vi.mocked(api.updateAssignmentFields).mockRejectedValue(CAPACITY_REFUSAL);
    const a: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-direct",
      runId: null,
      productId: "prod-1",
      startMin: 480,
      endMin: 600,
    };
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.retimeAssignmentFromCommand({
        assignmentId: "asg-direct",
        range: { startMin: 480, endMin: 720 },
        anchor: { x: 10, y: 10 },
      });
    });

    expect(outcome).toEqual({ kind: "refused", message: TODAYS_WORDS });
    expect(toasts()).toEqual([`${TODAYS_WORDS} — reverted.`]);
  });

  it("R-465-6: a probe that finds nothing outside keeps today's words too (the block is one she can read)", async () => {
    const api = await probeSays([READABLE_ROW]);
    vi.mocked(api.updateAssignmentFields).mockRejectedValue(CAPACITY_REFUSAL);
    const a: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-direct",
      runId: null,
      productId: "prod-1",
      startMin: 480,
      endMin: 600,
    };
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.retimeAssignmentFromCommand({
        assignmentId: "asg-direct",
        range: { startMin: 480, endMin: 720 },
        anchor: { x: 10, y: 10 },
      });
    });

    expect(outcome).toEqual({ kind: "refused", message: TODAYS_WORDS });
  });

  it("R-465-7: a move the server refuses over the cap says the place (the bar's override path), the moved block left out of the probe", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.moveAssignment).mockRejectedValue(CAPACITY_REFUSAL);
    const a = crewFixture(); // op-1, 360-600
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.openMoveFromCommand({
        assignmentId: a.id,
        nodeId: "cell-1",
        range: { startMin: 480, endMin: 720 },
        operatorId: "op-1",
        productId: "prod-1",
        anchor: { x: 10, y: 10 },
        override: { reason: "Covering" },
      });
    });

    expect(outcome).toEqual({ kind: "refused", message: SAID });
    expect(toasts()).toEqual([SAID]);
    expect(vi.mocked(api.probeCapacity).mock.calls[0][0]).toMatchObject({
      operatorId: "op-1",
      excludeAssignmentId: a.id,
    });
  });

  it("R-465-8: the create pop-up's move door throws the refusal carrying the sentence, for the pop-up and the bar to say", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.moveAssignment).mockRejectedValue(CAPACITY_REFUSAL);
    const a = crewFixture();
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    let refusal: unknown;
    await act(async () => {
      refusal = await result.current
        .submitMove(
          "cell-1",
          { startMin: 480, endMin: 720 },
          a.id,
          false,
          undefined,
          false,
          undefined,
        )
        .catch((e: unknown) => e);
    });

    expect(refusal).toMatchObject({ kind: "CapacityExceeded", elsewhere: SAID });
    expect(describeSchedulerError(refusal as never)).toBe(SAID);
  });

  it("R-465-9: a lot's create step and its re-time step both stop with the place's words as their reason", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.createAssignment).mockRejectedValue(CAPACITY_REFUSAL);
    vi.mocked(api.updateAssignmentFields).mockRejectedValue(CAPACITY_REFUSAL);
    const direct: IndexedAssignment = {
      ...crewFixture(),
      id: "asg-direct",
      runId: null,
      productId: "prod-1",
      startMin: 480,
      endMin: 600,
    };
    const { result } = renderHook(() => useDragGesture(baseArgs(named([direct]))), { wrapper });

    let create: LotResult | undefined;
    await act(async () => {
      create = await result.current.runLot([
        {
          intent: "assign",
          nodeId: "cell-1",
          operatorId: "op-1",
          productId: "prod-1",
          target: { kind: "direct", productId: "prod-1" },
          range: { startMin: 480, endMin: 720 },
          readout: "Sam Patel on Cell 1",
          attempted: "the step",
          notTried: "it stays.",
        } as unknown as ResolvedAny,
      ]);
    });
    let retime: LotResult | undefined;
    await act(async () => {
      retime = await result.current.runLot([
        {
          intent: "assign",
          nodeId: "cell-1",
          operatorId: "op-1",
          productId: "prod-1",
          target: { kind: "retime", assignmentId: "asg-direct" },
          range: { startMin: 480, endMin: 720 },
          readout: "Sam Patel on Cell 1",
          attempted: "the step",
          notTried: "it stays.",
        } as unknown as ResolvedAny,
      ]);
    });

    expect(create).toEqual({ done: 0, error: SAID });
    expect(retime).toEqual({ done: 0, error: SAID });
  });

  it("R-465-10: a staffed run dragged over the cap names the crew member's other block by its place, in the toast", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.moveRun).mockRejectedValue(CAPACITY_REFUSAL);
    const crew = [crewFixture()];
    const { result } = renderHook(() => useDragGesture(baseArgs(named(crew))), { wrapper });

    act(() => {
      result.current.beginBlockDrag(runDescriptor([runFixture], []), fakePointerEvent(500, 300));
    });
    act(() => {
      result.current.updateBlockDrag(fakePointerEvent(560, 300));
    });
    act(() => {
      result.current.endBlockDrag(fakePointerEvent(560, 300));
    });

    await waitFor(() => expect(toasts()).toEqual([SAID]));
    expect(vi.mocked(api.probeCapacity).mock.calls[0][0]).toMatchObject({
      operatorId: "op-1",
      excludeAssignmentId: "asg-1",
    });
  });

  it("R-465-11: a new share from the assignment pop-up that the server refuses over the cap says the place, with the NEW share asked about", async () => {
    const api = await probeSays([OUTSIDE_ROW]);
    vi.mocked(api.updateAssignmentFields).mockRejectedValue(CAPACITY_REFUSAL);
    const a = crewFixture();
    const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });

    act(() => {
      result.current.saveAssignmentFields(a.id, 150, null, null);
    });

    await waitFor(() => expect(toasts()).toEqual([SAID]));
    expect(vi.mocked(api.probeCapacity).mock.calls[0][0]).toMatchObject({
      operatorId: "op-1",
      efficiencyPercent: 150,
      excludeAssignmentId: a.id,
    });
  });

  it("R-465-12: the race -- the probe said it fits, the write is refused, and the second probe finds the outside block -- says the place and throws it", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.probeCapacity)
      .mockResolvedValueOnce({
        fits: true,
        cap: 1,
        peak: 1,
        overlapping: [],
      } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>)
      .mockResolvedValueOnce({
        fits: false,
        cap: 1,
        peak: 2,
        overlapping: [OUTSIDE_ROW],
      } as unknown as Awaited<ReturnType<typeof api.probeCapacity>>);
    vi.mocked(api.createAssignment).mockRejectedValue(CAPACITY_REFUSAL);
    const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });

    let refusal: unknown;
    await act(async () => {
      refusal = await submitCreate(result).catch((e: unknown) => e);
    });

    expect(refusal).toMatchObject({ kind: "CapacityExceeded", elsewhere: SAID });
    expect(toasts()).toEqual([SAID]);
    expect(api.createAssignment).toHaveBeenCalledTimes(1);
  });

  // S196-A (DEF-0060, F-239, R-465, R-431): the command bar asks the same probe
  // BEFORE it says anything, through this one function. It is given the step the
  // bar resolved and answers the R-465 sentence or null; what it asks the probe
  // is what the write itself would ask -- the same person, hours and share, and
  // for an existing block, that block left out.
  describe("S196-A: precheckCommandStep -- the pre-check the bar runs before it speaks", () => {
    const step = (over: Record<string, unknown>) =>
      ({
        intent: "assign",
        nodeId: "cell-1",
        operatorId: "op-1",
        productId: "prod-1",
        target: { kind: "direct", productId: "prod-1" },
        range: { startMin: 480, endMin: 720 },
        readout: "",
        attempted: "",
        notTried: "",
        ...over,
      }) as never;

    it("PC-1: a create asks the probe for the person, the hours and the 100% share the write would send, and says the place when a block she cannot read is what makes them busy", async () => {
      const api = await probeSays([OUTSIDE_ROW]);
      const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });
      let said: string | null = null;
      await act(async () => {
        said = await result.current.precheckCommandStep(step({}));
      });
      expect(said).toBe(SAID);
      expect(api.probeCapacity).toHaveBeenCalledTimes(1);
      expect(api.probeCapacity).toHaveBeenCalledWith({
        operatorId: "op-1",
        start: new Date("2026-08-24T08:00:00.000Z"),
        end: new Date("2026-08-24T12:00:00.000Z"),
        efficiencyPercent: 100,
      });
      // Nothing was written or opened: this is a question, never a write.
      expect(api.createAssignment).not.toHaveBeenCalled();
      expect(result.current.popover).toBeNull();
    });

    it("PC-2: a re-time, and a move to another cell, ask about the EXISTING block: its person, the new hours, its own share, itself left out", async () => {
      const api = await probeSays([OUTSIDE_ROW]);
      const a = {
        ...crewFixture(),
        id: "asg-mine",
        runId: null,
        productId: "prod-1",
        efficiencyPercent: 50,
        efficiency: 0.5,
      };
      const { result } = renderHook(() => useDragGesture(baseArgs(named([a]))), { wrapper });
      for (const s of [
        step({ intent: "assign", target: { kind: "retime", assignmentId: "asg-mine" } }),
        step({ intent: "move", assignmentId: "asg-mine", target: { kind: "retime" } }),
        step({
          intent: "move",
          assignmentId: "asg-mine",
          nodeId: "cell-2",
          target: { kind: "move_cell" },
        }),
      ]) {
        vi.mocked(api.probeCapacity).mockClear();
        let said: string | null = null;
        await act(async () => {
          said = await result.current.precheckCommandStep(s);
        });
        expect(said).toBe(SAID);
        expect(api.probeCapacity).toHaveBeenCalledWith({
          operatorId: "op-1",
          start: new Date("2026-08-24T08:00:00.000Z"),
          end: new Date("2026-08-24T12:00:00.000Z"),
          efficiencyPercent: 50,
          excludeAssignmentId: "asg-mine",
        });
      }
    });

    it("PC-3: a person who fits, an overlap on blocks she CAN read only (the split pop-up is that answer), a probe that fails, and a block that is no longer on the board are all null -- the bar goes on as before", async () => {
      const api = await probeSays([], true);
      const { result } = renderHook(() => useDragGesture(baseArgs(named([]))), { wrapper });
      await act(async () => {
        expect(await result.current.precheckCommandStep(step({}))).toBeNull();
      });
      await probeSays([READABLE_ROW]);
      await act(async () => {
        expect(await result.current.precheckCommandStep(step({}))).toBeNull();
      });
      vi.mocked(api.probeCapacity).mockRejectedValue(new Error("network"));
      await act(async () => {
        expect(await result.current.precheckCommandStep(step({}))).toBeNull();
      });
      vi.mocked(api.probeCapacity).mockClear();
      await act(async () => {
        expect(
          await result.current.precheckCommandStep(
            step({ intent: "move", assignmentId: "gone", target: { kind: "retime" } }),
          ),
        ).toBeNull();
      });
      expect(api.probeCapacity).not.toHaveBeenCalled();
    });
  });
});
