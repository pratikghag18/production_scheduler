import type { Product, BoardOperator, ShiftTemplate } from "@/lib/api";
import type { IndexedAssignment, IndexedRun } from "../lib/boardIndex";
import { minutesToPx, type Density } from "../lib/geometry";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { targetDisplay } from "../lib/standardTarget";
import type { ActiveDrag, BlockDragDescriptor } from "../hooks/useDragGesture";
import styles from "./AssignmentChip.module.css";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/** D38: 7px handle on a chip, per the mockup's `.achip .h` spans. */
const HANDLE_PX = 7;

/**
 * A run-attached staffing chip (brief §7 "AssignmentChip", mockup's `.achip`
 * / `chipEl`). Draggable within its own run's bounds (P1-4b — see the
 * agent report's note on `boundsFor` in `useDragGesture.ts`).
 */
export function AssignmentChip({
  assignment,
  density,
  operator,
  product,
  productColorVar,
  windowStart,
  pxPerHour,
  windowMinutes,
  homeRun,
  template,
  dayCount,
  zoomIndex,
  activeDrag,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
}: {
  assignment: IndexedAssignment;
  /** P1-4c D44/D49: `density.laneTopOffset`/`density.laneHeight` replace
   *  the removed `LANE_TOP_OFFSET`/`LANE_HEIGHT` constants. */
  density: Density;
  operator: BoardOperator | undefined;
  product: Product | undefined;
  productColorVar: string;
  windowStart: Date;
  pxPerHour: number;
  windowMinutes: number;
  homeRun: IndexedRun | null;
  template: ShiftTemplate | null;
  dayCount: number;
  zoomIndex: 0 | 1 | 2;
  activeDrag: ActiveDrag | null;
  onPointerDown: (descriptor: BlockDragDescriptor, e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onKeyDown: (
    e: React.KeyboardEvent,
    descriptor: Omit<BlockDragDescriptor, "handlePx" | "blockWidthPx" | "offsetXPx">,
  ) => void;
  onKeyUp: (e: React.KeyboardEvent) => void;
}) {
  const dragging = activeDrag !== null;
  const range =
    dragging && activeDrag.candidate
      ? activeDrag.candidate
      : { startMin: assignment.startMin, endMin: assignment.endMin };

  const name = operator?.displayName ?? "(unknown operator)";
  const productName = product?.name ?? "(unknown product)";
  const left = minutesToPx(range.startMin, pxPerHour);
  const width = Math.max(46, minutesToPx(range.endMin, pxPerHour) - left);
  const effSfx = assignment.efficiencyPercent !== 100 ? ` · ${assignment.efficiencyPercent}%` : "";
  // R-316: one shared reading for both block shapes — a typed target, else the
  // cell's standard, else NA. See `targetDisplay` for why this is not inlined.
  const { suffix: tgtSfx, tip: tgtTip } = targetDisplay(assignment);

  const title =
    `${name} · ${productName} · ${formatFull(addMinutes(windowStart, range.startMin))}` +
    `–${formatClock(addMinutes(windowStart, range.endMin))}${effSfx}${tgtTip}` +
    (assignment.eligibilityOverride ? " · certification override" : "");

  const descriptorBase = {
    nodeId: assignment.nodeId,
    subject: { kind: "assignment" as const, assignment, homeRun },
    original: { startMin: assignment.startMin, endMin: assignment.endMin },
    pxPerHour,
    windowMinutes,
    template,
    dayCount,
    zoomIndex,
    runsOnNode: [],
    crew: [],
  };

  return (
    <div
      className={`${styles.achip} ${assignment.eligibilityOverride ? styles.override : ""} ${dragging ? styles.dragging : ""}`}
      style={{
        left,
        width,
        top: density.laneTopOffset + assignment.lane * density.laneHeight,
        ["--pc" as string]: productColorVar,
      }}
      title={title}
      tabIndex={0}
      role="button"
      aria-label={`${name} on ${productName}, ${formatClock(addMinutes(windowStart, range.startMin))} to ${formatClock(addMinutes(windowStart, range.endMin))}`}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onPointerDown(
          {
            ...descriptorBase,
            handlePx: HANDLE_PX,
            blockWidthPx: rect.width,
            offsetXPx: e.clientX - rect.left,
          },
          e,
        );
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => onKeyDown(e, descriptorBase)}
      onKeyUp={onKeyUp}
    >
      <span className={styles.h} style={{ left: 0, width: HANDLE_PX }} aria-hidden="true" />
      <span className={styles.avatar}>{initials(name)}</span>
      <span className={styles.who}>
        {name}
        {tgtSfx}
      </span>
      <span className={styles.tm}>
        {formatClock(addMinutes(windowStart, range.startMin))}–
        {formatClock(addMinutes(windowStart, range.endMin))}
        {effSfx}
      </span>
      <span
        className={styles.h}
        style={{ right: 0, left: "auto", width: HANDLE_PX }}
        aria-hidden="true"
      />
    </div>
  );
}
