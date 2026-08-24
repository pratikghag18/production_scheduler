import type { Product } from "@/lib/api";
import { ZOOMS, type ZoomIndex } from "../lib/geometry";
import { formatDayLabel, addMinutes } from "../lib/time";
import styles from "./BoardToolbar.module.css";

/** 92-day cap: `board_window` raises `invalid_argument` past it (T6, docs/api.md §2). */
const MAX_WINDOW_DAYS = 92;

/**
 * Zoom buttons, date-range control, snap note, legend (brief §7/§10). T5:
 * the loaded window is exactly what this control requests — scrolling never
 * extends it, so an end-of-window marker names that limit instead of
 * letting it read as a bug.
 */
export function BoardToolbar({
  zoomIndex,
  onZoomChange,
  windowStartDate,
  windowDayCount,
  onWindowChange,
  onShiftWindowByDays,
  onGoToToday,
  products,
  isFetching,
}: {
  zoomIndex: ZoomIndex;
  onZoomChange: (index: ZoomIndex) => void;
  windowStartDate: Date;
  windowDayCount: number;
  onWindowChange: (startDate: Date, dayCount: number) => void;
  onShiftWindowByDays: (delta: number) => void;
  onGoToToday: () => void;
  products: Product[];
  isFetching: boolean;
}) {
  const startInputValue = windowStartDate.toISOString().slice(0, 10);
  const windowEnd = addMinutes(windowStartDate, windowDayCount * 1440);

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>Board</h1>
      <span className={styles.date}>
        {formatDayLabel(windowStartDate)} – {formatDayLabel(addMinutes(windowEnd, -1440))}
      </span>

      {/* Day navigation, ported from the mockup's `.daynav`. Without it the
          only way to move the window is to retype the date, which is exactly
          the friction the mockup's buttons existed to remove. "Today" also
          re-scrolls the current instant into view, not just the date. */}
      <div className={styles.daynav}>
        <button type="button" onClick={() => onShiftWindowByDays(-1)} title="Back one day">
          ◀ Prev day
        </button>
        <button type="button" onClick={onGoToToday} title="Jump to today and scroll to now">
          Today
        </button>
        <button type="button" onClick={() => onShiftWindowByDays(1)} title="Forward one day">
          Next day ▶
        </button>
      </div>

      <div className={styles.range}>
        <label htmlFor="board-window-start" className={styles.rangeLabel}>
          From:
        </label>
        <input
          id="board-window-start"
          type="date"
          className={styles.rangeInput}
          value={startInputValue}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const next = new Date(`${v}T00:00:00.000Z`);
            if (!Number.isNaN(next.getTime())) onWindowChange(next, windowDayCount);
          }}
        />
        <label htmlFor="board-window-days" className={styles.rangeLabel}>
          Days:
        </label>
        <input
          id="board-window-days"
          type="number"
          min={1}
          max={MAX_WINDOW_DAYS}
          className={styles.rangeInputNarrow}
          value={windowDayCount}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (!Number.isFinite(raw)) return;
            const clamped = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(raw)));
            onWindowChange(windowStartDate, clamped);
          }}
        />
        {windowDayCount >= MAX_WINDOW_DAYS && (
          <span
            className={styles.endMarker}
            title="board_window raises invalid_argument past 92 days"
          >
            max window
          </span>
        )}
      </div>

      {isFetching && (
        <span className={styles.refreshing} title="Refreshing in the background">
          refreshing…
        </span>
      )}

      <div className={styles.legend}>
        {products.map((p, i) => (
          <span key={p.id} className={styles.key}>
            <span
              className={styles.swatch}
              style={{ background: `var(--product-${(i % 4) + 1})` }}
            />
            {p.name}
          </span>
        ))}
        <span className={styles.key}>
          <span className={styles.swatchStatus} style={{ background: "var(--signal-warn)" }} />
          understaffed
        </span>
        <span className={styles.key}>
          <span className={styles.breakSwatch} />
          break
        </span>
      </div>

      <div className={styles.zoom}>
        {ZOOMS.map((z, i) => (
          <button
            key={z.name}
            type="button"
            className={i === zoomIndex ? styles.zoomOn : ""}
            onClick={() => onZoomChange(i as ZoomIndex)}
          >
            {z.name}
          </button>
        ))}
      </div>
      <span className={styles.snapNote}>
        {/* No drag in P1-4a, so this names the future snap behaviour rather than an active one. */}
        snap:{" "}
        {ZOOMS[zoomIndex].name === "Compact" ? "shift" : `${ZOOMS[zoomIndex].snapMinutes} min`}{" "}
        (P1-4b)
      </span>
      <span
        className={styles.scrollNote}
        title="Scrolling never extends the loaded window in P1-4a"
      >
        window ends at edge — widen “Days” to see more
      </span>
    </header>
  );
}
