import { useMemo } from "react";
import type { BoardOperator, Skill, BoardNode } from "@/lib/api";
import type { IndexedAssignment } from "../lib/boardIndex";
import { isFullyAllocated } from "../lib/geometry";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { PanelToggle } from "@/components/PanelToggle";
import styles from "./OperatorPanel.module.css";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Left operator panel, read-only half (brief §8). Ported from the mockup's
 * `renderPanel`, with real-data substitutions: `isFullyAllocated` now
 * compares against the *loaded* window and `capacityCap` (a fraction)
 * instead of the mockup's hardcoded Tue 06:00-22:00 test window and `100`.
 *
 * P1-4e D65: each chip is now also a drag SOURCE — `onPointerDown` starts a
 * "panel" drag via `dragApi.beginPanelDrag`, exactly like every other
 * draggable element on the board routes through the one shared gesture
 * state machine (D29); this file never tracks pointer state itself. Uses
 * `setPointerCapture`-backed handlers, so `onPointerMove`/`onPointerUp` are
 * wired on the chip itself (D33: capture always routes back to the
 * originating element regardless of what's visually under the pointer).
 */
export function OperatorPanel({
  operators,
  skillById,
  nodeById,
  assignmentsByOperator,
  windowStart,
  windowMinutes,
  capacityCap,
  open,
  onToggleOpen,
  draggingOperatorId,
  dragApi,
}: {
  operators: BoardOperator[];
  skillById: Map<string, Skill>;
  nodeById: Map<string, BoardNode>;
  assignmentsByOperator: Map<string, IndexedAssignment[]>;
  windowStart: Date;
  windowMinutes: number;
  capacityCap: number;
  open: boolean;
  onToggleOpen: () => void;
  /** P1-4e D65: the operator id of the in-flight panel drag, if any — its
   *  own source chip dims (mockup's `.chip.drag-src`) while `BoardPage`
   *  renders the pointer-following ghost. `null`/`undefined` outside a
   *  panel drag. */
  draggingOperatorId?: string | null;
  dragApi: {
    beginPanelDrag: (operator: BoardOperator, e: React.PointerEvent) => void;
    updatePanelDrag: (e: React.PointerEvent) => void;
    endPanelDrag: (e: React.PointerEvent) => void;
    cancelDrag: (e?: React.PointerEvent) => void;
  };
}) {
  const visible = useMemo(
    () =>
      operators.filter((o) => o.active).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [operators],
  );

  return (
    <aside className={`${styles.panel} ${open ? "" : styles.collapsed}`}>
      <div className={styles.panelHd}>
        <span className={styles.lbl}>OPERATORS</span>
        <PanelToggle
          collapsed={!open}
          onToggle={onToggleOpen}
          label="operators"
          className={styles.toggle}
        />
      </div>
      <div className={styles.list}>
        {visible.map((o) => {
          const mine = assignmentsByOperator.get(o.id) ?? [];
          const full = isFullyAllocated(mine, windowMinutes, capacityCap);
          const title = mine.length
            ? mine
                .map((a) => {
                  const nodeName = nodeById.get(a.nodeId)?.name ?? a.nodeId;
                  return `${nodeName} · ${formatFull(addMinutes(windowStart, a.startMin))}–${formatClock(addMinutes(windowStart, a.endMin))} · ${a.efficiencyPercent}%`;
                })
                .join("\n")
            : undefined;
          return (
            <div
              key={o.id}
              className={`${styles.chip} ${full ? styles.full : ""} ${draggingOperatorId === o.id ? styles.dragSrc : ""}`}
              title={title}
              style={{ touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => dragApi.beginPanelDrag(o, e)}
              onPointerMove={dragApi.updatePanelDrag}
              onPointerUp={dragApi.endPanelDrag}
              onPointerCancel={dragApi.cancelDrag}
            >
              <span className={styles.avatar}>{initials(o.displayName)}</span>
              <span className={styles.nm}>{o.displayName}</span>
              {o.skillIds.map((sid) => {
                const skill = skillById.get(sid);
                return skill ? (
                  <span key={sid} className={styles.sk}>
                    {skill.name}
                  </span>
                ) : null;
              })}
              {mine.length > 0 && <span className={styles.pill}>{mine.length}</span>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
