import type { Product, ShiftTemplate } from "@/lib/api";
import type { IndexedRun, IndexedAssignment } from "../lib/boardIndex";
import { minutesToPx, effectiveHeadcount, isUnderstaffed, type Density } from "../lib/geometry";
import { formatClock, formatFull, formatNumber, addMinutes } from "../lib/time";
import type { ActiveDrag, BlockDragDescriptor } from "../hooks/useDragGesture";
import styles from "./RunBand.module.css";

/** D38: 8px handle on a band, per the mockup's `.band .h` spans. */
const HANDLE_PX = 8;

export function RunBand({
  run,
  density,
  assignments,
  product,
  productColorVar,
  windowStart,
  pxPerHour,
  windowMinutes,
  template,
  dayCount,
  zoomIndex,
  runsOnNode,
  activeDrag,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
}: {
  run: IndexedRun;
  /** P1-4c D44/D49: `density.bandTop` replaces the removed `BAND_TOP` constant. */
  density: Density;
  assignments: IndexedAssignment[];
  product: Product | undefined;
  productColorVar: string;
  windowStart: Date;
  pxPerHour: number;
  windowMinutes: number;
  template: ShiftTemplate | null;
  dayCount: number;
  zoomIndex: 0 | 1 | 2;
  runsOnNode: IndexedRun[];
  /** Non-null while THIS run is the one being dragged (D34: render from
   *  `activeDrag.candidate`, not from `run`, while it is non-null). */
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
      : { startMin: run.startMin, endMin: run.endMin };

  const effHc = effectiveHeadcount(assignments);
  const under = isUnderstaffed(effHc, run.plannedHeadcount);
  const left = minutesToPx(range.startMin, pxPerHour);
  const width = minutesToPx(range.endMin, pxPerHour) - left;
  const productName = product?.name ?? "(unknown product)";

  const title =
    `${productName} · ${formatFull(addMinutes(windowStart, range.startMin))}` +
    `–${formatClock(addMinutes(windowStart, range.endMin))}` +
    (run.plannedHeadcount != null
      ? ` · staffed ${formatNumber(effHc)}/${run.plannedHeadcount}${under ? " · UNDERSTAFFED" : ""}`
      : ` · staffed ${formatNumber(effHc)}`);

  const descriptorBase = {
    nodeId: run.nodeId,
    subject: { kind: "run" as const, run },
    original: { startMin: run.startMin, endMin: run.endMin },
    pxPerHour,
    windowMinutes,
    template,
    dayCount,
    zoomIndex,
    runsOnNode,
    crew: assignments,
  };

  return (
    <div
      className={`${styles.band} ${under ? styles.under : ""} ${dragging ? styles.dragging : ""}`}
      style={{ left, width, top: density.bandTop, ["--pc" as string]: productColorVar }}
      title={title}
      tabIndex={0}
      role="button"
      aria-label={`${productName} run, ${formatClock(addMinutes(windowStart, range.startMin))} to ${formatClock(addMinutes(windowStart, range.endMin))}`}
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
      <span className={styles.pn}>{productName}</span>
      <span className={styles.tm}>
        {formatClock(addMinutes(windowStart, range.startMin))}–
        {formatClock(addMinutes(windowStart, range.endMin))}
      </span>
      <span className={styles.hc}>
        {under ? "⚠ " : ""}
        {formatNumber(effHc)}
        {run.plannedHeadcount != null ? `/${run.plannedHeadcount}` : ""}
      </span>
      <span
        className={styles.h}
        style={{ right: 0, left: "auto", width: HANDLE_PX }}
        aria-hidden="true"
      />
    </div>
  );
}
