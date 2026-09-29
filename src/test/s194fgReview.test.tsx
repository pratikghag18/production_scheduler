/**
 * Independent review of S194-F (R-463, committed 4cde4cc) and S194-G
 * (F-233, working tree) -- docs/agent-briefs/s194-fg-review-brief.md.
 *
 * This file is the reviewer's own, kept separate from the lane's test
 * files on purpose (the brief: "New cases in ONE new file"). Fixtures here
 * are deliberately trimmed, independent copies of the shapes
 * `commandBar.test.tsx`/`dragGesture.test.ts` already build (their own
 * helpers are not exported) -- just enough to drive the real, unmocked
 * `CommandBar` and `useDragGesture` against the two doubts this file
 * exists to settle: what a person sees during S194-G's hold, and whether
 * the keyboard door onto a placeholder row is actually shut.
 */
import { createElement, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CommandBar,
  type LotResult,
  type WriteOutcome,
} from "@/features/board/components/CommandBar";
import type {
  ResolveContext,
  ContextAssignment,
  ContextRun,
  BoardDay,
} from "@/lib/command/resolve";
import { useDragGesture, type UseDragGestureArgs } from "@/features/board/hooks/useDragGesture";
import { useCreateAssignment } from "@/features/board/hooks/useAssignmentMutations";
import { useCreateRun } from "@/features/board/hooks/useRunMutations";
import { boardKeys } from "@/features/board/hooks/useBoardWindow";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { buildDayAxis } from "@/features/board/lib/time";
import { isPlaceholderId, makePlaceholderId } from "@/features/board/lib/optimisticId";
import type { BoardWindow } from "@/lib/api";
import type { Reader, Reading } from "@/lib/voice/readSentence";

// `useAssignmentMutations`/`useRunMutations` call `@/lib/api`'s writers
// directly -- mocked so this file's onError case can make them reject on
// purpose, without a network layer. `CommandBar.tsx` itself imports nothing
// from `@/lib/api` (grepped), so this mock is inert for the CommandBar
// describe blocks below.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createAssignment: vi.fn(),
    createRun: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Part 1 -- CommandBar's own hold (doubts 1, 2, 3): a trimmed, independent
// copy of commandBar.test.tsx's `buildCtx`/`BLK1`/`renderBar` fixtures, only
// as much as UNASSIGN_SENTENCE/P1_SENTENCE need to resolve.
// ---------------------------------------------------------------------------

const DAYS: BoardDay[] = [
  { index: 0, iso: "2026-08-31", weekday: 1 },
  { index: 1, iso: "2026-09-01", weekday: 2 },
  { index: 2, iso: "2026-09-02", weekday: 3 },
  { index: 3, iso: "2026-09-03", weekday: 4 },
  { index: 4, iso: "2026-09-04", weekday: 5 },
  { index: 5, iso: "2026-09-05", weekday: 6 },
  { index: 6, iso: "2026-09-06", weekday: 0 },
];

function findRunOverlap(
  range: { startMin: number; endMin: number },
  runs: ContextRun[],
  excludeRunId: string | null,
): ContextRun | null {
  for (const r of runs) {
    if (excludeRunId !== null && r.id === excludeRunId) continue;
    if (range.startMin < r.endMin && r.startMin < range.endMin) return r;
  }
  return null;
}

function wallOf(m: number): { dayIndex: number; minuteOfDay: number } {
  const lastIndex = DAYS.length - 1;
  const raw = Math.floor(m / 1440);
  const dayIndex = raw < 0 ? 0 : raw > lastIndex ? lastIndex : raw;
  return { dayIndex, minuteOfDay: ((m % 1440) + 1440) % 1440 };
}

function buildCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const nodes = [
    { id: "p1", name: "Plant 1", path: "plant_1" },
    { id: "asm", name: "Assembly", path: "plant_1.assembly" },
    { id: "l1", name: "Line 1", path: "plant_1.assembly.line_1" },
    { id: "c1a", name: "Cell 1", path: "plant_1.assembly.line_1.cell_1" },
  ];
  return {
    cells: [nodes[3]],
    nodeById: new Map(nodes.map((n) => [n.id, n] as const)),
    operators: [{ id: "op1", displayName: "Operator 1", employeeRef: "E100", active: true }],
    products: [{ id: "ha", sku: "HA-1", name: "Housing A" }],
    offeredAt: () => [{ id: "ha" }],
    days: DAYS,
    todayIndex: 3,
    todayIso: "2026-09-03",
    wallToOffset: (d: number, m: number) => d * 1440 + m,
    runs: [],
    fitsRun: (a, r) => a.startMin >= r.startMin && a.endMin <= r.endMin,
    minDurationMinutes: 1,
    assignments: [],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf,
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
    ...over,
  };
}

const BLK1: ContextAssignment = {
  id: "blk1",
  nodeId: "c1a",
  operatorId: "op1",
  productId: "ha",
  productName: "Housing A",
  startMin: 3 * 1440 + 600,
  endMin: 3 * 1440 + 840,
  label: "10:00-14:00",
  runId: null,
};

const UNASSIGN_SENTENCE = "Unassign Operator 1 from Cell 1 in Line 1 from 10 to 2";
const P1_SENTENCE = "Assign Operator 1 to Housing A on Cell 1 in Line 1 from 3 to 4";

const WRITTEN: WriteOutcome = { kind: "written" };

function renderBar(over: Partial<ResolveContext>, hasPendingCreate: boolean) {
  const onOpen = vi.fn().mockReturnValue(WRITTEN);
  const onUnassign = vi.fn().mockReturnValue(WRITTEN);
  const onBook = vi.fn().mockReturnValue(WRITTEN);
  const onRetime = vi.fn().mockReturnValue(WRITTEN);
  const onRetimeRun = vi.fn().mockReturnValue(WRITTEN);
  const onMove = vi.fn().mockReturnValue(WRITTEN);
  const onSetHeadcount = vi.fn().mockReturnValue(WRITTEN);
  const onHighlight = vi.fn();
  const onShowDay = vi.fn();
  const onRunLot = vi.fn(() => new Promise<LotResult>(() => {}));

  const element = (ctxOver: Partial<ResolveContext>, pending: boolean) => (
    <CommandBar
      ctx={buildCtx(ctxOver)}
      hasPendingCreate={pending}
      dateFormat="d_mon_yyyy"
      zone="UTC"
      reader={null}
      recognizer={null}
      micRequest={0}
      onOpen={onOpen}
      onRetime={onRetime}
      onBook={onBook}
      onRetimeRun={onRetimeRun}
      onUnassign={onUnassign}
      onMove={onMove}
      onSetHeadcount={onSetHeadcount}
      onRunLot={onRunLot}
      onHighlight={onHighlight}
      onShowDay={onShowDay}
    />
  );
  const { rerender } = render(element(over, hasPendingCreate));
  const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;
  return {
    input,
    onOpen,
    onUnassign,
    rerenderPendingCreate: (nextOver: Partial<ResolveContext>, next: boolean) =>
      rerender(element(nextOver, next)),
  };
}

function threadText(): string {
  return document.querySelector('[class*="threadBody"]')?.textContent ?? "";
}

function candidateButtons(): HTMLElement[] {
  const strip = document.querySelector('[class*="candidates"]');
  return strip ? Array.from(strip.querySelectorAll("button")) : [];
}

describe("S194-G doubt 1/3: what a person sees during the hold", () => {
  beforeEach(() => cleanup());

  // Review, second pass (S194-G2, finding 4): REWRITTEN, not deleted (the
  // brief's own rule). This test used to assert the OPPOSITE of what
  // follows -- that a held sentence showed NO status text at all, so a
  // person could not tell "held, will run in a moment" from "heard and
  // silently dropped". The maintainer's brief made that the defect: a held
  // sentence now shows the SAME "Working…" text an in-flight write already
  // uses (`holdSentence`'s own `setStatus({ kind: "reading", message:
  // "Working…" })`, `CommandBar.tsx`), posted the instant the hold begins,
  // never a silent wait.
  it("shows the same 'Working…' status an in-flight write already uses while held, not silence", () => {
    const { input, onUnassign } = renderBar({ assignments: [BLK1] }, true);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // R-437: the box empties regardless.
    expect(input.value).toBe("");
    // The sentence IS shown -- not literally invisible.
    expect(screen.getByText(`You said: ${UNASSIGN_SENTENCE}`)).toBeTruthy();
    // The hold shows itself: the same "Working…" text used elsewhere for a
    // write already in flight, not a new word, and not silence.
    expect(screen.getByText("Working…")).toBeTruthy();
    // Nothing else has happened yet: no question stands, nothing was
    // written.
    expect(candidateButtons()).toHaveLength(0);
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("reruns once hasPendingCreate turns false, and only then reaches the board", () => {
    const { input, onUnassign, rerenderPendingCreate } = renderBar({ assignments: [BLK1] }, true);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUnassign).not.toHaveBeenCalled();

    rerenderPendingCreate({ assignments: [BLK1] }, false);

    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
  });
});

describe("S194-G doubt 2: a second sentence arriving while the first is held", () => {
  beforeEach(() => cleanup());

  // Review, second pass (S194-G2, finding 2): REWRITTEN, not deleted. This
  // test used to prove the ORIGINAL defect -- a single ref
  // (`pendingUnsettledRef`) held at most one sentence, so a second held
  // sentence silently overwrote the first, whose own write then never ran
  // at all. The brief's fix is a QUEUE (`heldQueueRef`, `CommandBar.tsx`):
  // every held sentence runs, in the order it was heard, each to its own
  // outcome, each with its own trace entry closed -- proved here by
  // running BOTH sentences' writers, in order, once the board catches up.
  it("keeps BOTH sentences and runs them in order, one at a time, as the board catches up", () => {
    const { input, onUnassign, onOpen, rerenderPendingCreate } = renderBar(
      { assignments: [BLK1] },
      true,
    );

    // First sentence: held (create still pending).
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Second sentence arrives before the first has ever resolved --
    // `hasPendingCreate` is STILL true (no rerender yet), so this one is
    // also held. The queue now holds both, oldest first.
    fireEvent.change(input, { target: { value: P1_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The placeholder now clears. The FIRST sentence (UNASSIGN_SENTENCE)
    // drains first and reaches its own question -- a lot/drain never runs
    // two sentences in the same pass past a standing question (F-162,
    // unchanged) -- so the second is still waiting, not yet reached.
    rerenderPendingCreate({ assignments: [BLK1] }, false);
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();

    // Answering the first sentence's question runs its own write, closes
    // its own trace entry, and -- once the board has caught up with THAT
    // write too (a fresh `ctx`) -- lets the queue continue to the second.
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    expect(onUnassign).toHaveBeenCalledTimes(1);
    rerenderPendingCreate({ assignments: [BLK1] }, false);

    // P1_SENTENCE ("assign ... from 3 to 4") is a write straight through
    // (no candidate strip): `onOpen` is the create-side writer it reaches.
    // Both ran, in the order they were heard.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onUnassign.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]);

    // R-434: both sentences are turns in the thread, neither with a blank
    // (`outcome: null`) result -- the first sentence's own row is
    // corrected in place once its write lands (`drainHeldQueue`'s own
    // `filedTurnAt` marking, `CommandBar.tsx`), never left as the
    // "heard, then nothing" row this test used to prove.
    expect(threadText()).toContain(UNASSIGN_SENTENCE);
    expect(threadText()).toContain(P1_SENTENCE);
    const turns = Array.from(document.querySelectorAll('[class*="turn_"]'));
    const firstTurnText = turns[0]?.textContent ?? "";
    expect(firstTurnText).toMatch(/Written:.*is off Cell 1/);
  });
});

describe("S194-G doubt 1: Escape cancels a held sentence", () => {
  beforeEach(() => cleanup());

  // Review, second pass (S194-G2, finding 3): REWRITTEN, not deleted. This
  // test used to prove the ORIGINAL defect -- Escape never touched the ref
  // that remembered a held sentence, so it ran anyway once the board
  // caught up, exactly as if Escape had never been pressed. The brief's
  // fix (`dropHeldQueueAsCancelled`, `CommandBar.tsx`) makes Escape drop
  // every held sentence outright: nothing is written, ever, for one
  // dropped this way, and its own trace entry closes `cancelled` -- the
  // same outcome `cancelStanding`'s own Escape already uses for a standing
  // question.
  it("drops the held sentence outright -- nothing runs, its own turn closes cancelled", () => {
    const { input, onUnassign, rerenderPendingCreate } = renderBar({ assignments: [BLK1] }, true);
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Nothing visibly "stands" (no question, no candidates) in the OLD
    // sense -- CLAUDE.md's own R-434/R-437 vocabulary has no name for this
    // state. Escape is pressed exactly as a person would who wants to take
    // the held sentence back.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(threadText()).toContain("Cancelled");

    // Even once the board catches up, the dropped sentence never runs --
    // it is gone, not merely delayed.
    rerenderPendingCreate({ assignments: [BLK1] }, false);
    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(onUnassign).not.toHaveBeenCalled();
  });
});

/**
 * S194-G3 (docs/agent-briefs/s194-g3-the-hold-regressed-brief.md): "the
 * sentence dropped by a second Enter -- prove it, do not fix it." A `Reader`
 * that never resolves for the FIRST sentence, aborted by the SECOND
 * sentence's own `startReading` call (`readingAbortRef.current?.abort()`,
 * `CommandBar.tsx`) -- the first sentence never becomes a `Command`, never
 * reaches `runCommand`, and so never reaches this lane's own hold gate at
 * all (that gate lives inside `runCommandBody`, only reachable once a
 * reading has already resolved). This is upstream of F-233 entirely; the
 * maintainer has the question of whether the bar SHOULD do this, so this
 * case only records what is actually left behind, exactly as the brief
 * asks, and changes nothing about `startReading` itself.
 */
describe("S194-G3: a second Enter aborts the first sentence's own reading -- proved, not fixed", () => {
  beforeEach(() => cleanup());

  it("the first sentence's own reading is silently dropped: filed with no outcome, never a Command, never a write", async () => {
    const onOpen = vi.fn().mockReturnValue(WRITTEN);
    const reader = vi.fn<Reader>((text: string, _signal: AbortSignal): Promise<Reading> => {
      if (text === UNASSIGN_SENTENCE) {
        // Deliberately never settles -- the abort this test proves is what
        // stops the FIRST sentence, not a rejection this file would have to
        // fabricate to look like a real one.
        return new Promise<Reading>(() => {});
      }
      // The second sentence resolves normally, through the SAME grammar
      // rules path every other sentence in this file uses -- `parseCommand`
      // itself, not a second copy of the resolver's own answer.
      return Promise.resolve({ ok: false, reason: "no-service" });
    });

    const element = () => (
      <CommandBar
        ctx={buildCtx({ assignments: [BLK1] })}
        hasPendingCreate={false}
        dateFormat="d_mon_yyyy"
        zone="UTC"
        reader={reader}
        recognizer={null}
        micRequest={0}
        onOpen={onOpen}
        onRetime={vi.fn().mockReturnValue(WRITTEN)}
        onBook={vi.fn().mockReturnValue(WRITTEN)}
        onRetimeRun={vi.fn().mockReturnValue(WRITTEN)}
        onUnassign={vi.fn().mockReturnValue(WRITTEN)}
        onMove={vi.fn().mockReturnValue(WRITTEN)}
        onSetHeadcount={vi.fn().mockReturnValue(WRITTEN)}
        onRunLot={vi.fn(() => new Promise<LotResult>(() => {}))}
        onHighlight={vi.fn()}
        onShowDay={vi.fn()}
      />
    );
    render(element());
    const input = screen.getByRole("textbox", { name: "Tell the board" }) as HTMLInputElement;

    // The first sentence: starts reading, "Reading…" shows, never resolves.
    fireEvent.change(input, { target: { value: UNASSIGN_SENTENCE } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`You said: ${UNASSIGN_SENTENCE}`)).toBeTruthy();

    // The second sentence, said before the first has ever resolved --
    // `startReading`'s own `readingAbortRef.current?.abort()` fires against
    // the FIRST reading's own controller.
    await act(async () => {
      fireEvent.change(input, { target: { value: "clear cell 1" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reader).toHaveBeenCalledTimes(2);
    const [, firstSignal] = reader.mock.calls[0] as [string, AbortSignal];
    expect(firstSignal.aborted).toBe(true);

    // What is left: the FIRST sentence's own turn is filed into the thread
    // (superseded by the second's own `startTrace` -> `finishTrace`), but
    // with NO outcome at all -- it never wrote, never refused, never asked
    // anything, because it never became a Command in the first place. R-434
    // ("anything the bar hears ... is a trace entry and a turn in the
    // thread") is satisfied only by half: there IS a turn, but its own
    // result line is blank, exactly as indistinguishable from "heard and
    // silently dropped" as the sentence actually was.
    expect(threadText()).toContain(UNASSIGN_SENTENCE);
    const turns = Array.from(document.querySelectorAll('[class*="turn_"]'));
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const firstTurnResult = turns[0]?.querySelector('[class*="turnResult"]');
    expect(firstTurnResult === null || firstTurnResult.textContent === "").toBe(true);

    // Never a write, and never a Command reaching `runCommand` at all --
    // this lane's own hold gate (F-233) never had a chance to see it.
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part 2 -- the drag/keyboard door onto a placeholder row (doubt 7's own
// keyboard half -- the brief: "the lane wrote no case for it").
// ---------------------------------------------------------------------------

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

function placeholderAssignmentFixture(): IndexedAssignment {
  return {
    id: makePlaceholderId(),
    orgId: "org-1",
    nodeId: "cell-1",
    operatorId: "op-1",
    operatorDisplayName: null,
    runId: null,
    productId: "prod-1",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-24 06:00:00+00,2026-08-24 06:05:00+00)",
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
    endMin: 365,
    efficiencyPercent: 100,
    lane: 0,
    defaultTargetQty: null,
  };
}

function buildIndex(crew: IndexedAssignment[]): BoardIndex {
  return {
    windowStart: WINDOW_START,
    windowMinutes: WINDOW_MINUTES,
    dayCount: 1,
    zone: "UTC",
    dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
    rows: [],
    runsByNode: new Map([["cell-1", [runFixture]]]),
    assignmentsByNode: new Map([["cell-1", crew]]),
    assignmentsByRun: new Map(),
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
    density: DENSITIES[1],
    runById: new Map([["run-1", runFixture]]),
    assignmentById: new Map(crew.map((a) => [a.id, a] as const)),
    eligibilityPolicy: "warn",
    eligibilityPolicyByNode: new Map(),
  };
}

function baseArgs(index: BoardIndex): UseDragGestureArgs {
  return {
    rootPath: "plant_1",
    from: WINDOW_START,
    to: new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000),
    index,
    defaultCreateMode: "run",
    zoomIndex: 1,
    sessionUserId: "user-1",
    canPlace: true,
    dateFormat: "d_mon_yyyy",
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function fakeKeyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) },
  } as unknown as ReactKeyboardEvent<Element>;
}

describe("S194-G doubt 7 (keyboard door): a placeholder row cannot be nudged or opened by keyboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ArrowRight on a placeholder assignment does not start or change a drag candidate", () => {
    const placeholder = placeholderAssignmentFixture();
    const index = buildIndex([placeholder]);
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.handleBlockKeyDown(fakeKeyboardEvent("ArrowRight"), {
        nodeId: "cell-1",
        subject: { kind: "assignment", assignment: placeholder, homeRun: null },
        original: { startMin: placeholder.startMin, endMin: placeholder.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1,
        runsOnNode: [],
        crew: [],
      });
    });

    expect(result.current.activeDrag).toBe(null);
  });

  it("Enter on a placeholder assignment does not open the edit pop-up", () => {
    const placeholder = placeholderAssignmentFixture();
    const index = buildIndex([placeholder]);
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.handleBlockKeyDown(fakeKeyboardEvent("Enter"), {
        nodeId: "cell-1",
        subject: { kind: "assignment", assignment: placeholder, homeRun: null },
        original: { startMin: placeholder.startMin, endMin: placeholder.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1,
        runsOnNode: [],
        crew: [],
      });
    });

    expect(result.current.popover).toBe(null);
  });

  it("the same guard, for a placeholder RUN (Enter opens no pop-up, ArrowRight starts no drag)", () => {
    const placeholderRun: IndexedRun = { ...runFixture, id: makePlaceholderId() };
    const index: BoardIndex = {
      ...buildIndex([]),
      runById: new Map([[placeholderRun.id, placeholderRun]]),
      runsByNode: new Map([["cell-1", [placeholderRun]]]),
    };
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.handleBlockKeyDown(fakeKeyboardEvent("Enter"), {
        nodeId: "cell-1",
        subject: { kind: "run", run: placeholderRun },
        original: { startMin: placeholderRun.startMin, endMin: placeholderRun.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1,
        runsOnNode: [placeholderRun],
        crew: [],
      });
    });
    expect(result.current.popover).toBe(null);

    act(() => {
      result.current.handleBlockKeyDown(fakeKeyboardEvent("ArrowRight"), {
        nodeId: "cell-1",
        subject: { kind: "run", run: placeholderRun },
        original: { startMin: placeholderRun.startMin, endMin: placeholderRun.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1,
        runsOnNode: [placeholderRun],
        crew: [],
      });
    });
    expect(result.current.activeDrag).toBe(null);
  });
});

describe("S194-G doubt 7 (remaining half): a keyboard RESIZE nudge floors at the zoom's own snap step, not the bare 1-minute floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Shift+ArrowLeft resizing a block's end toward its own start stops at one snap step, never a 1-minute sliver", () => {
    // Standard zoom (zoomIndex 1) snaps to 30 minutes. A block 360-390
    // (30 minutes, already exactly one snap step) resized smaller by one
    // nudge must land on a real grid point relative to its own fixed
    // start -- `handleBlockKeyDown`'s own R-463 comment says this floor is
    // `base.snap.snapMinutes`, the same reasoning as the pointer resize's
    // own `dragFloorMinutes` (`useDragGesture.ts`'s own R-463 comment,
    // proven for the POINTER path by the committed `dragGesture.test.ts`
    // -- this is that same proof for the KEYBOARD path, which the lane's
    // own suite has no case for at all).
    const a: IndexedAssignment = { ...placeholderAssignmentFixture(), id: "asg-real", endMin: 390 };
    const index = buildIndex([a]);
    const { result } = renderHook(() => useDragGesture(baseArgs(index)), { wrapper });

    act(() => {
      result.current.handleBlockKeyDown(fakeKeyboardEvent("ArrowLeft", true), {
        nodeId: "cell-1",
        subject: { kind: "assignment", assignment: a, homeRun: null },
        original: { startMin: a.startMin, endMin: a.endMin },
        pxPerHour: 100,
        windowMinutes: WINDOW_MINUTES,
        template: null,
        dayCount: 1,
        dayAxis: buildDayAxis(WINDOW_START, 1, "UTC"),
        zoomIndex: 1,
        runsOnNode: [],
        crew: [],
      });
    });

    // A single Shift+ArrowLeft nudge, one snap step (30 min) toward the
    // fixed start (360): the floor keeps `endMin` at least one snap step
    // above `startMin` -- 390, one step, never lands below 390 (the
    // block's own length is already exactly one step), so `endMin` stays
    // 390, not 361 (the bare 1-minute floor's own answer).
    expect(result.current.activeDrag?.candidate).toEqual({ startMin: 360, endMin: 390 });
  });
});

// ---------------------------------------------------------------------------
// Part 3 -- doubt 4: does a FAILED create clear the placeholder (and so
// `hasPendingCreate`), on every path?
// ---------------------------------------------------------------------------

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

function wrapperWithClient(client: QueryClient) {
  return function ({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("S194-G doubt 4: a create that FAILS clears its own placeholder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("useCreateAssignment: onError restores the snapshot without the placeholder row", async () => {
    const api = await import("@/lib/api");
    let rejectCreate!: (err: unknown) => void;
    vi.mocked(api.createAssignment).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const from = WINDOW_START;
    const to = new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000);
    const key = boardKeys.window("plant_1", from, to);
    client.setQueryData(key, boardWindowFixture());

    const { result } = renderHook(() => useCreateAssignment("plant_1", from, to), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      result.current.mutate({
        nodeId: "cell-1",
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        start: WINDOW_START,
        end: new Date(WINDOW_START.getTime() + 5 * 60_000),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // While held back, the placeholder IS in the cache.
    const midFlight = client.getQueryData<BoardWindow>(key);
    expect(midFlight?.assignments.some((a) => isPlaceholderId(a.id))).toBe(true);

    // Once the mutation has settled (rejected), the rolled-back snapshot
    // must carry NO placeholder row -- a flag/derived-state that stuck
    // `true` here would hold every later sentence for the rest of the
    // session (CLAUDE.md §4: a write that reports success can have changed
    // nothing; the same is true in reverse -- a write that FAILED must not
    // look, forever after, as if one were still running).
    await act(async () => {
      rejectCreate(new Error("capacity_exceeded"));
      await Promise.resolve().catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const settled = client.getQueryData<BoardWindow>(key);
    expect(settled?.assignments.some((a) => isPlaceholderId(a.id))).toBe(false);
  });

  it("useCreateRun: onError restores the snapshot without the placeholder row", async () => {
    const api = await import("@/lib/api");
    let rejectCreate!: (err: unknown) => void;
    vi.mocked(api.createRun).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const from = WINDOW_START;
    const to = new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000);
    const key = boardKeys.window("plant_1", from, to);
    client.setQueryData(key, boardWindowFixture());

    const { result } = renderHook(() => useCreateRun("plant_1", from, to), {
      wrapper: wrapperWithClient(client),
    });

    await act(async () => {
      result.current.mutate({
        nodeId: "cell-1",
        productId: "prod-1",
        start: WINDOW_START,
        end: new Date(WINDOW_START.getTime() + 5 * 60_000),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const midFlight = client.getQueryData<BoardWindow>(key);
    expect(midFlight?.runs.some((r) => isPlaceholderId(r.id))).toBe(true);

    await act(async () => {
      rejectCreate(new Error("run_overlap"));
      await Promise.resolve().catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const settled = client.getQueryData<BoardWindow>(key);
    expect(settled?.runs.some((r) => isPlaceholderId(r.id))).toBe(false);
  });

  /**
   * S194-G3, proving item 1: `onSettled` RETURNS `invalidateQueries`'s own
   * promise now (`useAssignmentMutations.ts`) instead of firing it and
   * forgetting -- React Query keeps a mutation `isPending` until whatever
   * `onSettled` itself returns has settled, so this is what makes "a create
   * mutation is pending" mean "the board's own data still holds only the
   * placeholder, never yet the real row" for the mutation's WHOLE life.
   * Proved by spying on the query client's own `invalidateQueries` (held
   * back by hand) rather than a real observed refetch, which needs an
   * actively mounted `useBoardWindow` this file's own fixtures do not carry
   * -- the spy is the exact call `onSettled` makes, so it proves the same
   * thing the real refetch would. Mutation-tested: `onSettled: () => {
   * queryClient.invalidateQueries(...); }` (fired, not returned) turns this
   * red.
   */
  it("the create mutation stays isPending until the invalidated refetch has actually landed", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.createAssignment).mockResolvedValue({
      assignment: {
        id: "created-1",
        orgId: "org-1",
        nodeId: "cell-1",
        operatorId: "op-1",
        operatorDisplayName: null,
        runId: null,
        productId: "prod-1",
        productSku: null,
        productName: null,
        productColorToken: null,
        areaOverride: false,
        areaOverrideReason: null,
        timerange: "[2026-08-24 00:00:00+00,2026-08-24 00:05:00+00)",
        efficiency: 1,
        eligibilityOverride: false,
        overrideReason: null,
        targetQty: null,
        targetUnit: null,
        createdBy: null,
        createdAt: WINDOW_START.toISOString(),
        updatedAt: WINDOW_START.toISOString(),
      },
      eligibility: { eligible: true, policy: "warn", missingSkills: [], expiringSkills: [] },
      absence: { absent: false, from: null, to: null, reason: null },
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const from = WINDOW_START;
    const to = new Date(WINDOW_START.getTime() + WINDOW_MINUTES * 60_000);
    const key = boardKeys.window("plant_1", from, to);
    client.setQueryData(key, boardWindowFixture());

    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(client, "invalidateQueries")
      .mockImplementation(() => new Promise<void>((resolve) => (resolveInvalidate = resolve)));

    const { result } = renderHook(() => useCreateAssignment("plant_1", from, to), {
      wrapper: wrapperWithClient(client),
    });

    act(() => {
      result.current.mutate({
        nodeId: "cell-1",
        operatorId: "op-1",
        target: { kind: "direct", productId: "prod-1" },
        start: WINDOW_START,
        end: new Date(WINDOW_START.getTime() + 5 * 60_000),
      });
    });

    // The server has already answered (`createAssignment` resolved) and
    // `invalidateQueries` has been called -- but its own promise is still
    // held back by hand. The mutation must still read as pending.
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
    expect(result.current.isPending).toBe(true);

    act(() => {
      resolveInvalidate();
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// Part 4 -- doubt 6: the one helper's own edge cases.
// ---------------------------------------------------------------------------

describe("S194-G doubt 6: isPlaceholderId's own edges", () => {
  it("is false for an empty string and for an ordinary uuid", () => {
    expect(isPlaceholderId("")).toBe(false);
    expect(isPlaceholderId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(false);
  });

  it("a real server uuid can never collide with the prefix (not hex)", () => {
    // A uuid's first group is 8 lowercase hex digits (`toSchedulerError`'s
    // own callers never see anything else from Postgres); "optimistic-" is
    // not a valid hex run, so `isPlaceholderId` can never be fooled by a
    // real row's own id, in either direction.
    expect(/^[0-9a-f]{8}$/.test("optimist")).toBe(false);
  });
});
