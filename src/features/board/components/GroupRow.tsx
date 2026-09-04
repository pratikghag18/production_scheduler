import { useMemo } from "react";
import type { HierarchyLevel } from "@/lib/api";
import type { BoardRow } from "../lib/boardIndex";
import type { ShiftTemplate } from "@/lib/api";
import { minutesToPx, shiftBoundaries, shiftInstances, ZOOMS, intersects } from "../lib/geometry";
import { Chevron } from "@/components/icons";
import styles from "./GroupRow.module.css";

/**
 * A collapsible group row (brief §7 "Group row", §8's D18 — a non-schedulable
 * node). Renders its own resolved shift template's boundary strip for
 * *every* group row that resolves one (the mockup only did this for
 * "line" rows; brief §7 explicitly widens that to every group row).
 */
export function GroupRow({
  row,
  level,
  template,
  dayCount,
  zoomIndex,
  trackWidth,
  railWidth,
  collapsed,
  onToggle,
  visibleMinRange,
}: {
  row: BoardRow;
  level: HierarchyLevel | undefined;
  template: ShiftTemplate | null;
  dayCount: number;
  zoomIndex: 0 | 1 | 2;
  trackWidth: number;
  railWidth: number;
  collapsed: boolean;
  onToggle: () => void;
  visibleMinRange: [number, number];
}) {
  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const compact = ZOOMS[zoomIndex].name === "Compact";
  const [visStart, visEnd] = visibleMinRange;

  const boundaries = useMemo(() => {
    if (!template) return [];
    return shiftBoundaries(template, dayCount).filter((m) => m >= visStart - 1 && m <= visEnd + 1);
  }, [template, dayCount, visStart, visEnd]);

  const labels = useMemo(() => {
    if (!template || !compact) return [];
    return shiftInstances(template, dayCount)
      .filter(
        (inst) =>
          inst.rawStartMin === inst.startMin &&
          intersects(inst.startMin, inst.endMin, visStart, visEnd),
      )
      .map((inst) => ({
        key: `${inst.shift.id}-${inst.startMin}`,
        left: minutesToPx(inst.startMin, pxPerHour) + 4,
        name: inst.shift.name,
      }));
  }, [template, compact, dayCount, pxPerHour, visStart, visEnd]);

  return (
    <div className={styles.grpRow} style={{ height: row.height }}>
      <div
        className={styles.grpCell}
        style={{ width: railWidth, paddingLeft: 10 + row.depth * 12 }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
      >
        <span className={styles.caret}>
          <Chevron direction={collapsed ? "right" : "down"} />
        </span>
        <span>{row.node.name}</span>
        <span className={styles.lvl}>{level?.name ?? ""}</span>
      </div>
      <div className={styles.grpFill} style={{ width: trackWidth }}>
        {boundaries.map((m) => (
          <div key={m} className={styles.shiftbound} style={{ left: minutesToPx(m, pxPerHour) }} />
        ))}
        {labels.map((l) => (
          <div key={l.key} className={styles.shiftLbl} style={{ left: l.left }}>
            {l.name}
          </div>
        ))}
      </div>
    </div>
  );
}
