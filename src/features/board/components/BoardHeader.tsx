import { useMemo } from "react";
import { ZOOMS } from "../lib/geometry";
import { minutesToPx } from "../lib/geometry";
import { formatClock, formatDayLabel, addMinutes, type DayAxis } from "../lib/time";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import styles from "./BoardHeader.module.css";

/**
 * Sticky day strip + hour ticks + day-boundary rules (brief §7 "Header").
 * `railWidth` is passed in so the sticky corner cell and the rail column of
 * every row line up exactly.
 *
 * ⭐ D88a — EVERY x-POSITION COMES FROM THE DAY AXIS, not `day * 1440`. Under a
 * plant-local axis a day is 1380 or 1500 real minutes twice a year, so the day
 * boxes have UNEQUAL widths on a changeover day and the hour ticks are placed at
 * each wall-hour's REAL-minute offset (`dayAxis.wallToOffset`) — which is why the
 * clock labels on the spring-forward day jump 01:00 → 03:00 with no 02:00 box,
 * exactly as the wall clock does. For a UTC axis every offset is `day*1440 + m`,
 * so this is pixel-identical to the pre-D88 header.
 */
export function BoardHeader({
  dayAxis,
  zone,
  zoomIndex,
  railWidth,
  visibleMinRange,
  dateFormat = DEFAULT_DATE_FORMAT,
}: {
  dayAxis: DayAxis;
  zone?: string;
  zoomIndex: 0 | 1 | 2;
  railWidth: number;
  visibleMinRange: [number, number];
  dateFormat?: DateFormat;
}) {
  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const compact = ZOOMS[zoomIndex].name === "Compact";
  const windowStart = dayAxis.windowStart;
  const dayCount = dayAxis.dayCount;
  const trackWidth = minutesToPx(dayAxis.windowMinutes, pxPerHour);

  const dayBoxes = useMemo(() => {
    const boxes: { key: number; left: number; width: number; label: string }[] = [];
    for (let day = 0; day < dayCount; day++) {
      const left = minutesToPx(dayAxis.dayOffsets[day], pxPerHour);
      const right = minutesToPx(dayAxis.dayOffsets[day + 1], pxPerHour);
      const label = formatDayLabel(dayAxis.dayStarts[day], dateFormat, zone);
      boxes.push({ key: day, left, width: right - left, label });
    }
    return boxes;
  }, [dayAxis, dayCount, pxPerHour, dateFormat, zone]);

  const dayBoundaries = useMemo(() => {
    const out: number[] = [];
    for (let day = 1; day < dayCount; day++) out.push(dayAxis.dayOffsets[day]);
    return out;
  }, [dayAxis, dayCount]);

  const hourTicks = useMemo(() => {
    const [visStart, visEnd] = visibleMinRange;
    const ticks: { key: number; left: number; label: string }[] = [];
    for (let day = 0; day < dayCount; day++) {
      for (let hr = 0; hr < 24; hr++) {
        if (compact && hr % 2 !== 0) continue;
        // D88a: the wall-hour's REAL-minute offset in the plant zone. On a
        // changeover day this is not `day*1440 + hr*60`, and the skipped hour
        // resolves to the same offset as the hour that replaced it (deduped
        // by `key`, which is the offset).
        const m = dayAxis.wallToOffset(day, hr * 60);
        if (m < visStart - 60 || m > visEnd + 60) continue;
        ticks.push({
          key: m,
          left: minutesToPx(m, pxPerHour),
          label: formatClock(addMinutes(windowStart, m), zone),
        });
      }
    }
    return ticks;
  }, [dayAxis, dayCount, compact, pxPerHour, visibleMinRange, windowStart, zone]);

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
