import { useMemo } from "react";
import type { Product, BoardOperator, ShiftTemplate, Skill } from "@/lib/api";
import type { BoardRow, IndexedRun, IndexedAssignment } from "../lib/boardIndex";
import { ZOOMS, minutesToPx, intersects } from "../lib/geometry";
import type { ActiveDrag, BlockDragDescriptor } from "../hooks/useDragGesture";
import { ShiftLayer } from "./ShiftLayer";
import { RunBand } from "./RunBand";
import { AssignmentChip } from "./AssignmentChip";
import { DirectBlock } from "./DirectBlock";
import { DragGhost } from "./DragGhost";
import styles from "./TrackRow.module.css";

export interface TrackRowDragApi {
  activeDrag: ActiveDrag | null;
  beginBlockDrag: (descriptor: BlockDragDescriptor, e: React.PointerEvent) => void;
  updateBlockDrag: (e: React.PointerEvent) => void;
  endBlockDrag: (e: React.PointerEvent) => void;
  cancelDrag: (e?: React.PointerEvent) => void;
  beginTrackCreateDrag: (
    descriptor: {
      nodeId: string;
      pxPerHour: number;
      windowMinutes: number;
      template: ShiftTemplate | null;
      dayCount: number;
      zoomIndex: 0 | 1 | 2;
      trackLeftPx: number;
      offsetXPx: number;
    },
    e: React.PointerEvent,
  ) => void;
  updateTrackCreateDrag: (e: React.PointerEvent) => void;
  endTrackCreateDrag: (e: React.PointerEvent, template: ShiftTemplate | null) => void;
  handleBlockKeyDown: (
    e: React.KeyboardEvent,
    descriptor: Omit<BlockDragDescriptor, "handlePx" | "blockWidthPx" | "offsetXPx">,
  ) => void;
  handleBlockKeyUp: (e: React.KeyboardEvent) => void;
  handleTrackKeyDown: (
    e: React.KeyboardEvent,
    d: { nodeId: string; template: ShiftTemplate | null; windowMinutes: number },
  ) => void;
}

/**
 * A schedulable node's row: rail label (name + skill badges), the time
 * track (`ShiftLayer` behind, run bands, then chips/blocks on top) — brief
 * §7 "Track row". Every per-row renderer filters to the horizontal visible
 * range (§6); lane assignment itself is computed over the whole window in
 * `boardIndex.ts`, never here, so a block never changes lanes as you scroll.
 *
 * P1-4b addendum: drag-to-create on empty track (§5.1/§5.2), and threads
 * `dragApi`'s pointer/keyboard handlers down to each run/assignment block.
 * D34: a block renders from `dragApi.activeDrag.candidate` only while ITS
 * own id matches the active drag — every other block on this and every
 * other row renders from the index as before.
 */
export function TrackRow({
  row,
  template,
  skills,
  runs,
  assignments,
  assignmentsByRun,
  productById,
  operatorById,
  productColorVar,
  windowStart,
  windowMinutes,
  dayCount,
  zoomIndex,
  railWidth,
  trackWidth,
  visibleMinRange,
  dragApi,
}: {
  row: BoardRow;
  template: ShiftTemplate | null;
  skills: Skill[];
  runs: IndexedRun[];
  assignments: IndexedAssignment[];
  assignmentsByRun: Map<string, IndexedAssignment[]>;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  productColorVar: (productId: string | null) => string;
  windowStart: Date;
  windowMinutes: number;
  dayCount: number;
  zoomIndex: 0 | 1 | 2;
  railWidth: number;
  trackWidth: number;
  visibleMinRange: [number, number];
  dragApi: TrackRowDragApi;
}) {
  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const [visStart, visEnd] = visibleMinRange;

  const visibleRuns = useMemo(
    () => runs.filter((r) => intersects(r.startMin, r.endMin, visStart, visEnd)),
    [runs, visStart, visEnd],
  );
  const visibleAssignments = useMemo(
    () => assignments.filter((a) => intersects(a.startMin, a.endMin, visStart, visEnd)),
    [assignments, visStart, visEnd],
  );
  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r] as const)), [runs]);

  const dayBoundaries = useMemo(() => {
    const out: number[] = [];
    for (let day = 1; day < dayCount; day++) {
      if (day * 1440 >= visStart - 1 && day * 1440 <= visEnd + 1) out.push(day * 1440);
    }
    return out;
  }, [dayCount, visStart, visEnd]);

  const { activeDrag } = dragApi;
  const nodeId = row.node.id;
  const rowHasActiveDrag = activeDrag !== null && activeDrag.nodeId === nodeId;
  const createDragHere = rowHasActiveDrag && activeDrag!.mode === "create";

  function activeDragForRun(runId: string): ActiveDrag | null {
    if (!rowHasActiveDrag) return null;
    const s = activeDrag!.subject;
    return s.kind === "run" && s.run.id === runId ? activeDrag : null;
  }
  function activeDragForAssignment(assignmentId: string): ActiveDrag | null {
    if (!rowHasActiveDrag) return null;
    const s = activeDrag!.subject;
    return s.kind === "assignment" && s.assignment.id === assignmentId ? activeDrag : null;
  }

  return (
    <div className={styles.cellRow} style={{ height: row.height }}>
      <div
        className={styles.cellLabel}
        style={{ width: railWidth, minHeight: row.height, paddingLeft: 10 + row.depth * 12 + 4 }}
      >
        <span className={styles.nm}>{row.node.name}</span>
        {skills.map((s) => (
          <span key={s.id} className={styles.reqBadge}>
            {s.name}
          </span>
        ))}
      </div>
      <div
        className={styles.track}
        style={{ width: trackWidth, height: row.height, ["--hour-px" as string]: `${pxPerHour}px` }}
        // Focusable but deliberately no `role="button"`: the track CONTAINS
        // other focusable, `role="button"` blocks (run bands, chips), and
        // ARIA disallows nesting one interactive-role element inside
        // another. `aria-label` alone still gives it an accessible name for
        // §8's "focused empty track" keyboard path.
        tabIndex={0}
        aria-label={`${row.node.name} track — press Enter to create`}
        onPointerDown={(e) => {
          // Mockup: `tr.addEventListener("pointerdown", e => { if (e.target
          // === tr) startCreateGeneric(...) })` — only a pointerdown that
          // lands on the bare track (not bubbled from a run band/chip/
          // block, which stop propagation themselves) starts a create-drag.
          if (e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          dragApi.beginTrackCreateDrag(
            {
              nodeId,
              pxPerHour,
              windowMinutes,
              template,
              dayCount,
              zoomIndex,
              trackLeftPx: rect.left,
              offsetXPx: e.clientX - rect.left,
            },
            e,
          );
        }}
        onPointerMove={dragApi.updateTrackCreateDrag}
        onPointerUp={(e) => dragApi.endTrackCreateDrag(e, template)}
        onPointerCancel={dragApi.cancelDrag}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          dragApi.handleTrackKeyDown(e, { nodeId, template, windowMinutes });
        }}
      >
        <ShiftLayer
          template={template}
          dayCount={dayCount}
          windowStart={windowStart}
          pxPerHour={pxPerHour}
          visibleMinRange={visibleMinRange}
        />
        {dayBoundaries.map((m) => (
          <div
            key={m}
            className={styles.daybound}
            style={{ left: minutesToPx(m, pxPerHour) - 1 }}
          />
        ))}
        {visibleRuns.map((r) => (
          <RunBand
            key={r.id}
            run={r}
            assignments={assignmentsByRun.get(r.id) ?? []}
            product={productById.get(r.productId)}
            productColorVar={productColorVar(r.productId)}
            windowStart={windowStart}
            pxPerHour={pxPerHour}
            windowMinutes={windowMinutes}
            template={template}
            dayCount={dayCount}
            zoomIndex={zoomIndex}
            runsOnNode={runs}
            activeDrag={activeDragForRun(r.id)}
            onPointerDown={dragApi.beginBlockDrag}
            onPointerMove={dragApi.updateBlockDrag}
            onPointerUp={dragApi.endBlockDrag}
            onPointerCancel={dragApi.cancelDrag}
            onKeyDown={dragApi.handleBlockKeyDown}
            onKeyUp={dragApi.handleBlockKeyUp}
          />
        ))}
        {visibleAssignments.map((a) =>
          a.runId ? (
            <AssignmentChip
              key={a.id}
              assignment={a}
              operator={operatorById.get(a.operatorId)}
              product={productById.get(a.productId ?? runById.get(a.runId ?? "")?.productId ?? "")}
              productColorVar={productColorVar(
                a.productId ?? runById.get(a.runId ?? "")?.productId ?? null,
              )}
              windowStart={windowStart}
              pxPerHour={pxPerHour}
              windowMinutes={windowMinutes}
              homeRun={runById.get(a.runId) ?? null}
              template={template}
              dayCount={dayCount}
              zoomIndex={zoomIndex}
              activeDrag={activeDragForAssignment(a.id)}
              onPointerDown={dragApi.beginBlockDrag}
              onPointerMove={dragApi.updateBlockDrag}
              onPointerUp={dragApi.endBlockDrag}
              onPointerCancel={dragApi.cancelDrag}
              onKeyDown={dragApi.handleBlockKeyDown}
              onKeyUp={dragApi.handleBlockKeyUp}
            />
          ) : (
            <DirectBlock
              key={a.id}
              assignment={a}
              operator={operatorById.get(a.operatorId)}
              product={a.productId ? productById.get(a.productId) : undefined}
              productColorVar={productColorVar(a.productId)}
              windowStart={windowStart}
              pxPerHour={pxPerHour}
              windowMinutes={windowMinutes}
              template={template}
              dayCount={dayCount}
              zoomIndex={zoomIndex}
              activeDrag={activeDragForAssignment(a.id)}
              onPointerDown={dragApi.beginBlockDrag}
              onPointerMove={dragApi.updateBlockDrag}
              onPointerUp={dragApi.endBlockDrag}
              onPointerCancel={dragApi.cancelDrag}
              onKeyDown={dragApi.handleBlockKeyDown}
              onKeyUp={dragApi.handleBlockKeyUp}
            />
          ),
        )}
        {createDragHere && (
          <DragGhost
            candidate={activeDrag!.candidate}
            windowStart={windowStart}
            pxPerHour={pxPerHour}
          />
        )}
      </div>
    </div>
  );
}
