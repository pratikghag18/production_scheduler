import { useMemo } from "react";
import { ZOOMS } from "../lib/geometry";
import { minutesToPx } from "../lib/geometry";
import { formatClock, formatDayLabel, addMinutes } from "../lib/time";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import styles from "./BoardHeader.module.css";

/**
 * Sticky day strip + hour ticks + day-boundary rules (brief §7 "Header").
 * `railWidth` is passed in so the sticky corner cell and the rail column of
 * every row line up exactly.
 */
export function BoardHeader({
  windowStart,
  dayCount,
  windowMinutes,
  zoomIndex,
  railWidth,
  visibleMinRange,
  dateFormat = DEFAULT_DATE_FORMAT,
}: {
  windowStart: Date;
  dayCount: number;
  windowMinutes: number;
  zoomIndex: 0 | 1 | 2;
  railWidth: number;
  visibleMinRange: [number, number];
  dateFormat?: DateFormat;
}) {
  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const compact = ZOOMS[zoomIndex].name === "Compact";
  const trackWidth = minutesToPx(windowMinutes, pxPerHour);

  const dayBoxes = useMemo(() => {
    const boxes: { key: number; left: number; width: number; label: string }[] = [];
    for (let day = 0; day < dayCount; day++) {
      const left = minutesToPx(day * 1440, pxPerHour);
      const width = minutesToPx((day + 1) * 1440, pxPerHour) - left;
      const label = formatDayLabel(addMinutes(windowStart, day * 1440), dateFormat);
      boxes.push({ key: day, left, width, label });
    }
    return boxes;
  }, [dayCount, pxPerHour, windowStart, dateFormat]);

  const dayBoundaries = useMemo(() => {
    const out: number[] = [];
    for (let day = 1; day < dayCount; day++) out.push(day * 1440);
    return out;
  }, [dayCount]);

  const hourTicks = useMemo(() => {
    const [visStart, visEnd] = visibleMinRange;
    const ticks: { key: number; left: number; label: string }[] = [];
    for (let day = 0; day < dayCount; day++) {
      for (let hr = 0; hr < 24; hr++) {
        if (compact && hr % 2 !== 0) continue;
        const m = day * 1440 + hr * 60;
        if (m < visStart - 60 || m > visEnd + 60) continue;
        ticks.push({
          key: m,
          left: minutesToPx(m, pxPerHour),
          label: formatClock(addMinutes(windowStart, m)),
        });
      }
    }
    return ticks;
  }, [dayCount, compact, pxPerHour, visibleMinRange, windowStart]);

  return (
    <div className={styles.hdrRow}>
      <div className={styles.hdrCorner} style={{ width: railWidth }}>
        Work cells &middot; time &rarr;
      </div>
      <div className={styles.hdrTrack} style={{ width: trackWidth }}>
        <div className={styles.dayStrip}>
          {dayBoxes.map((b) => (
            <div key={b.key} className={styles.dayBox} style={{ width: b.width }}>
              {/* Two labels per day, and the leading one is sticky. At Fine
                  zoom a single day is ~4000px wide, so scrolling into the
                  middle of one left no date on screen at all. The sticky
                  label rides along with whichever day you are inside (clipped
                  to that day's own box, so it hands over cleanly at the
                  boundary rather than overlapping the next one); the trailing
                  label gives you the date at the day's end as it approaches
                  from the right. */}
              <span className={styles.dayLabelStart} style={{ left: railWidth }}>
                {b.label}
              </span>
              <span className={styles.dayLabelEnd}>{b.label}</span>
            </div>
          ))}
        </div>
        {dayBoundaries.map((m) => (
          <div
            key={m}
            className={styles.daybound}
            style={{ left: minutesToPx(m, pxPerHour) - 1 }}
          />
        ))}
        {hourTicks.map((t) => (
          <span key={t.key} className={styles.hourTick} style={{ left: t.left }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
