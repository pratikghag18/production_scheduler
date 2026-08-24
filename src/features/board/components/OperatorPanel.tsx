import { useMemo } from "react";
import type { BoardOperator, Skill, BoardNode } from "@/lib/api";
import type { IndexedAssignment } from "../lib/boardIndex";
import { isFullyAllocated } from "../lib/geometry";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import styles from "./OperatorPanel.module.css";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Left operator panel, read-only half (brief §8). Ported from the mockup's
 * `renderPanel`, with real-data substitutions: `isFullyAllocated` now
 * compares against the *loaded* window and `capacityCap` (a fraction)
 * instead of the mockup's hardcoded Tue 06:00-22:00 test window and `100`.
 * No drag from this panel in P1-4a.
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
        <button
          type="button"
          className={styles.toggle}
          onClick={onToggleOpen}
          title={open ? "Collapse panel" : "Expand panel"}
        >
          {open ? "«" : "»"}
        </button>
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
            <div key={o.id} className={`${styles.chip} ${full ? styles.full : ""}`} title={title}>
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
