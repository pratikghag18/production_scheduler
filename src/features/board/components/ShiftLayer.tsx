import { useMemo } from "react";
import type { ShiftTemplate } from "@/lib/api";
import {
  minutesToPx,
  offShiftGaps,
  breakInstances,
  shiftBoundaries,
  intersects,
} from "../lib/geometry";
import { formatClock, addMinutes } from "../lib/time";
import styles from "./ShiftLayer.module.css";

/**
 * Off-shift wash, hatched break bands, dashed shift-boundary lines — behind
 * the assignment layer on a track row (brief §7 "Track row", §16.2 of the
 * design plan). Ported from the mockup's `shiftLayerHTML`.
 */
export function ShiftLayer({
  template,
  dayCount,
  windowStart,
  pxPerHour,
  visibleMinRange,
}: {
  template: ShiftTemplate | null;
  dayCount: number;
  windowStart: Date;
  pxPerHour: number;
  visibleMinRange: [number, number];
}) {
  const [visStart, visEnd] = visibleMinRange;

  const gaps = useMemo(() => {
    if (!template) return [];
    return offShiftGaps(template, dayCount).filter(([s, e]) => intersects(s, e, visStart, visEnd));
  }, [template, dayCount, visStart, visEnd]);

  const breaks = useMemo(() => {
    if (!template) return [];
    return breakInstances(template, dayCount).filter((b) =>
      intersects(b.startMin, b.endMin, visStart, visEnd),
    );
  }, [template, dayCount, visStart, visEnd]);

  const boundaries = useMemo(() => {
    if (!template) return [];
    return shiftBoundaries(template, dayCount).filter((m) => m >= visStart - 1 && m <= visEnd + 1);
  }, [template, dayCount, visStart, visEnd]);

  if (!template) return null;

  return (
    <>
      {gaps.map(([s, e]) => (
        <div
          key={`gap-${s}`}
          className={styles.offShift}
          style={{
            left: minutesToPx(s, pxPerHour),
            width: minutesToPx(e, pxPerHour) - minutesToPx(s, pxPerHour),
          }}
        />
      ))}
      {breaks.map((b, i) => {
        const label = `${b.shiftBreak.name} · ${formatClock(addMinutes(windowStart, b.startMin))}–${formatClock(addMinutes(windowStart, b.endMin))}`;
        return (
          <div
            key={`brk-${b.shiftBreak.id}-${i}`}
            className={styles.shiftBreak}
            title={label}
            style={{
              left: minutesToPx(b.startMin, pxPerHour),
              width: minutesToPx(b.endMin, pxPerHour) - minutesToPx(b.startMin, pxPerHour),
            }}
          />
        );
      })}
      {boundaries.map((m) => (
        <div
          key={`b-${m}`}
          className={styles.shiftbound}
          style={{ left: minutesToPx(m, pxPerHour) }}
        />
      ))}
    </>
  );
}
