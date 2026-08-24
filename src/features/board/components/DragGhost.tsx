import { minutesToPx, BAND_TOP } from "../lib/geometry";
import { formatClock, addMinutes } from "../lib/time";
import styles from "./DragGhost.module.css";

/**
 * The mockup's `.ghost` — a create-drag's live preview, rendered inside the
 * track it started in (never fixed/portal: it must scroll and zoom with
 * the track exactly like a real block would). `TrackRow` mounts this only
 * for the one row whose `nodeId` matches the active create-drag (§5.2).
 */
export function DragGhost({
  candidate,
  windowStart,
  pxPerHour,
}: {
  candidate: { startMin: number; endMin: number } | null;
  windowStart: Date;
  pxPerHour: number;
}) {
  if (!candidate) return null;
  const left = minutesToPx(candidate.startMin, pxPerHour);
  const width = Math.max(2, minutesToPx(candidate.endMin, pxPerHour) - left);
  const hasRange = candidate.endMin > candidate.startMin;

  return (
    <div className={styles.ghost} style={{ left, width, top: BAND_TOP }}>
      {hasRange
        ? `${formatClock(addMinutes(windowStart, candidate.startMin))}–${formatClock(addMinutes(windowStart, candidate.endMin))}`
        : ""}
    </div>
  );
}
