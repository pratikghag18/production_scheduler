import type { Product } from "@/lib/api";
import { productColorCss } from "@/lib/productColor";
import { ZOOMS, type ZoomIndex } from "../lib/geometry";
import { formatDayLabel, addMinutes } from "../lib/time";
import { shouldOfferRootPicker, type BoardRoot } from "../lib/rootSelection";
import styles from "./BoardToolbar.module.css";

/** 92-day cap: `board_window` raises `invalid_argument` past it (T6, docs/api.md §2). */
const MAX_WINDOW_DAYS = 92;

/**
 * Zoom buttons, density buttons, date-range control, snap note, legend
 * (brief §7/§10, P1-4c §5 for density). T5: the loaded window is exactly
 * what this control requests — scrolling never extends it, so an
 * end-of-window marker names that limit instead of letting it read as a
 * bug.
 */
export function BoardToolbar({
  roots,
  rootPath,
  onRootChange,
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
  roots: BoardRoot[];
  rootPath: string | null;
  onRootChange: (path: string) => void;
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

      {/* ⭐ WHICH PLACE THIS IS. The board showed the word "Board" and nothing
          else for as long as it opened on a hardcoded `plant_1` — there was
          only ever one answer, so naming it would have been noise. Now that it
          follows who you are, "which plant am I looking at" is a real question
          and the header is where it gets answered.

          ⚠️ A PICKER ONLY WHEN THERE IS A CHOICE. One place is not a choice,
          and a permanently-disabled control is worse than none — so a person
          who administers one site reads a label and everyone else gets a
          select. `shouldOfferRootPicker` owns that rule so it is testable
          without rendering anything. */}
      {shouldOfferRootPicker(roots) ? (
        <select
          className={styles.rootPicker}
          aria-label="Which place to show"
          value={rootPath ?? ""}
          onChange={(e) => onRootChange(e.target.value)}
        >
          {roots.map((r) => (
            <option key={r.id} value={r.path}>
              {r.name}
            </option>
          ))}
        </select>
      ) : (
        roots.length === 1 && <span className={styles.rootName}>{roots[0].name}</span>
      )}
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
        {/* ⭐ THE PRODUCT'S OWN COLOUR, NOT ITS POSITION IN THIS LIST (D102).
            This read `var(--product-${(i % 4) + 1})`, so the legend agreed with
            the grid only because the grid made the same mistake: `board_window`
            emits products `ORDER BY p.sku` org-wide, so adding or renaming any
            product in the company re-coloured the others. Migration 0023 §3
            gives every product a `color_token` chosen once at insert.
            ⭐ THE RULE ITSELF LIVES IN `src/lib/productColor.ts` NOW. It used
            to be written out here, in `BoardGrid.tsx` and in the admin lib,
            with a comment saying the three were kept in step by hand -- and
            0025 §2 then added a hex arm to it. That is D100's defect, and the
            fix is the same one: move the rule somewhere every feature may
            import from, rather than matching three copies. */}
        {products.map((p) => (
          <span key={p.id} className={styles.key}>
            <span
              className={styles.swatch}
              style={{ background: productColorCss(p.colorToken) }}
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

      {/* DENSITY CONTROL REMOVED (Pratik, Aug 25). Fit is automatic and the
          three manual densities earned their toolbar space back: Fit already
          shrinks toward Compact when there are many rows and grows toward
          Comfortable when there are few, so the override only mattered for
          taste, and four buttons is a lot of chrome for taste.

          The MECHANISM is intact and unreferenced by the UI on purpose, not
          by oversight: `densityMode` still exists in the store (default
          "fit"), `BoardPage` still branches on it, and `DENSITIES` /
          `scaleDensity` are what Fit itself is built from. Restoring the
          control is re-adding this button group and nothing else. */}
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
