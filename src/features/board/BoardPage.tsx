import { useMemo } from "react";
import type { HierarchyLevel } from "@/lib/api";
import { describeSchedulerError, isSchedulerError } from "@/lib/api";
import { DevProfileSwitcher } from "@/features/auth/DevProfileSwitcher";
import { useSession } from "@/features/auth/useSession";
import { useBoardWindow } from "./hooks/useBoardWindow";
import { useRootPath } from "./hooks/useRootPath";
import { useBoardViewStore } from "./store/boardView";
import { useDragGesture } from "./hooks/useDragGesture";
import { buildBoardIndex, type BoardIndex } from "./lib/boardIndex";
import { addMinutes, MINUTES_PER_DAY } from "./lib/time";
import { BoardToolbar } from "./components/BoardToolbar";
import { BoardGrid } from "./components/BoardGrid";
import { OperatorPanel } from "./components/OperatorPanel";
import { BoardEmptyState } from "./components/BoardEmptyState";
import { Toasts } from "./components/Toasts";
import { CreatePopover } from "./components/CreatePopover";
import { RunPopover } from "./components/RunPopover";
import { AssignmentPopover } from "./components/AssignmentPopover";
import styles from "./BoardPage.module.css";

/**
 * The board (brief P1-4a read-only + P1-4b interactions). Composes
 * `BoardToolbar` + `OperatorPanel` + `BoardGrid` + `Toasts` + the active
 * popover, calls `useBoardWindow`, builds the index with `buildBoardIndex`,
 * and owns the single `useDragGesture` instance (D29) that every draggable
 * block/track reads through `BoardGrid`'s `dragApi` prop. The only data
 * call in this file (or anywhere in the feature) is `useBoardWindow` — every
 * mutation goes through `useDragGesture`'s wrapped hooks (§2).
 */
export default function BoardPage() {
  const { session, profile, loading: sessionLoading } = useSession();
  const rootPath = useRootPath();

  const zoomIndex = useBoardViewStore((s) => s.zoomIndex);
  const setZoomIndex = useBoardViewStore((s) => s.setZoomIndex);
  const windowStartDate = useBoardViewStore((s) => s.windowStartDate);
  const windowDayCount = useBoardViewStore((s) => s.windowDayCount);
  const setWindowStartDate = useBoardViewStore((s) => s.setWindowStartDate);
  const setWindowDayCount = useBoardViewStore((s) => s.setWindowDayCount);
  const collapsedNodeIds = useBoardViewStore((s) => s.collapsedNodeIds);
  const toggleCollapsed = useBoardViewStore((s) => s.toggleCollapsed);
  const shiftWindowByDays = useBoardViewStore((s) => s.shiftWindowByDays);
  const goToToday = useBoardViewStore((s) => s.goToToday);
  const scrollToNowNonce = useBoardViewStore((s) => s.scrollToNowNonce);
  const operatorPanelOpen = useBoardViewStore((s) => s.operatorPanelOpen);
  const setOperatorPanelOpen = useBoardViewStore((s) => s.setOperatorPanelOpen);

  // D14: the board window is always whole UTC days — from = 00:00:00.000Z
  // of the start date, to = 00:00:00.000Z of the day after the end date.
  const from = windowStartDate;
  const to = useMemo(
    () => addMinutes(windowStartDate, windowDayCount * MINUTES_PER_DAY),
    [windowStartDate, windowDayCount],
  );

  const boardQuery = useBoardWindow(rootPath, from, to);

  // T4: spinner only on "pending" with no cached data; keep rendering
  // stale data during a background refetch (isFetching), with a subtle
  // indicator in the toolbar instead of blanking the board every 30s.
  const hasData = boardQuery.data !== undefined;

  const index = useMemo(() => {
    if (!boardQuery.data) return null;
    return buildBoardIndex(boardQuery.data, from, to);
  }, [boardQuery.data, from, to]);

  const levelById = useMemo<Map<string, HierarchyLevel>>(() => {
    if (!boardQuery.data) return new Map();
    return new Map(boardQuery.data.levels.map((l) => [l.id, l] as const));
  }, [boardQuery.data]);

  // D35: profile.defaultCreateMode is a plain string on the wire (no DB
  // check constraint the client can rely on) — narrowed here, once, rather
  // than trusting it as "run" | "direct" everywhere downstream.
  const defaultCreateMode: "run" | "direct" =
    profile?.defaultCreateMode === "direct" ? "direct" : "run";

  // D29: one drag/gesture controller for the whole page. `index` is only
  // ever non-null once `hasData` is true, so this is called with a
  // placeholder empty index before data loads (the hook itself never
  // dereferences it before a drag begins, and no block exists to start one
  // against). Hooks must run unconditionally, so this call cannot be
  // skipped behind `hasData`.
  const emptyIndex = useMemo<BoardIndex>(
    () =>
      index ?? {
        windowStart: from,
        windowMinutes: (to.getTime() - from.getTime()) / 60_000,
        dayCount: windowDayCount,
        rows: [],
        runsByNode: new Map(),
        assignmentsByNode: new Map(),
        assignmentsByRun: new Map(),
        assignmentsByOperator: new Map(),
        templateForNode: new Map(),
        skillsForNode: new Map(),
        productById: new Map(),
        operatorById: new Map(),
        skillById: new Map(),
        nodeById: new Map(),
        capacityCap: 1,
        droppedRanges: 0,
      },
    [index, from, to, windowDayCount],
  );

  const dragApi = useDragGesture({
    rootPath,
    from,
    to,
    index: emptyIndex,
    defaultCreateMode,
    sessionUserId: session?.user.id ?? null,
  });

  if (sessionLoading) {
    return <p>Loading session…</p>;
  }

  if (!session) {
    return (
      <div className={styles.panel}>
        <h1>Board</h1>
        <p>Sign in with a dev profile to see schedule data.</p>
        <DevProfileSwitcher />
      </div>
    );
  }

  const popover = dragApi.popover;

  return (
    <div className={styles.page}>
      {/* Dev-only identity switcher. MUST stay reachable WHILE SIGNED IN, not
          only on the signed-out screen: acceptance items 6-7 (switch Admin ->
          Ana -> Marco and watch for stale rows) are untestable otherwise, and
          T3 is specifically about that switch. Self-gates on
          `import.meta.env.DEV`. This was lost once when the file was rebuilt
          from a stale copy — if it disappears again, look here first. */}
      <DevProfileSwitcher />

      <BoardToolbar
        zoomIndex={zoomIndex}
        onZoomChange={setZoomIndex}
        windowStartDate={windowStartDate}
        windowDayCount={windowDayCount}
        onWindowChange={(start, days) => {
          setWindowStartDate(start);
          setWindowDayCount(days);
        }}
        onShiftWindowByDays={shiftWindowByDays}
        onGoToToday={goToToday}
        products={boardQuery.data?.products ?? []}
        isFetching={boardQuery.isFetching && hasData}
      />

      {boardQuery.status === "pending" && !hasData && (
        <p className={styles.status}>Loading board window…</p>
      )}

      {boardQuery.status === "error" && (
        <p className={styles.error}>
          {isSchedulerError(boardQuery.error)
            ? describeSchedulerError(boardQuery.error)
            : "Something went wrong loading the board."}
        </p>
      )}

      {hasData && index && boardQuery.data && (
        <>
          {import.meta.env.DEV && index.droppedRanges > 0 && (
            <p className={styles.devWarning}>
              dev warning: {index.droppedRanges} row(s) had an unparseable time range and were
              dropped from the board.
            </p>
          )}
          {boardQuery.data.nodes.length === 0 ? (
            <BoardEmptyState />
          ) : (
            <div className={styles.body}>
              <OperatorPanel
                operators={boardQuery.data.operators}
                skillById={index.skillById}
                nodeById={index.nodeById}
                assignmentsByOperator={index.assignmentsByOperator}
                windowStart={index.windowStart}
                windowMinutes={index.windowMinutes}
                capacityCap={index.capacityCap}
                open={operatorPanelOpen}
                onToggleOpen={() => setOperatorPanelOpen(!operatorPanelOpen)}
              />
              <BoardGrid
                index={index}
                levelById={levelById}
                collapsedNodeIds={collapsedNodeIds}
                onToggleCollapsed={toggleCollapsed}
                zoomIndex={zoomIndex}
                productById={index.productById}
                operatorById={index.operatorById}
                scrollToNowNonce={scrollToNowNonce}
                dragApi={dragApi}
              />
            </div>
          )}
        </>
      )}

      <Toasts />

      {popover?.kind === "create" && (
        <CreatePopover
          nodeId={popover.nodeId}
          anchor={popover.anchor}
          initialRange={popover.range}
          shiftChips={popover.shiftChips}
          defaultCreateMode={defaultCreateMode}
          products={boardQuery.data?.products ?? []}
          operators={boardQuery.data?.operators ?? []}
          windowStart={index?.windowStart ?? from}
          onCancel={dragApi.closePopover}
          onSubmitRun={dragApi.submitCreateRun}
          onSubmitDirect={dragApi.submitCreateDirect}
        />
      )}

      {popover?.kind === "run" && (
        <RunPopover
          run={popover.run}
          crew={popover.crew}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          products={boardQuery.data?.products ?? []}
          onCancel={dragApi.closePopover}
          onSave={dragApi.saveRunFields}
          onDelete={dragApi.deleteRunWithMode}
        />
      )}

      {popover?.kind === "assignment" && (
        <AssignmentPopover
          assignment={popover.assignment}
          homeRun={popover.homeRun}
          operator={index?.operatorById.get(popover.assignment.operatorId)}
          products={boardQuery.data?.products ?? []}
          anchor={popover.anchor}
          windowStart={index?.windowStart ?? from}
          onCancel={dragApi.closePopover}
          onSave={dragApi.saveAssignmentFields}
          onDelete={dragApi.removeAssignment}
        />
      )}
    </div>
  );
}
