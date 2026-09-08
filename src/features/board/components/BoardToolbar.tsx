import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCanPlaceInPlant, fetchIsAdminFor, isSchedulerError, type Product } from "@/lib/api";
import { productColorCss } from "@/lib/productColor";
import { ZOOMS, type ZoomIndex } from "../lib/geometry";
import { formatDayLabel, addMinutes, zonedTimeToInstant, MINUTES_PER_DAY } from "../lib/time";
import { shouldOfferRootPicker, type BoardRoot } from "../lib/rootSelection";
import { boardKeys } from "../hooks/useBoardWindow";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import { Chevron } from "@/components/icons";
import { CopyWeekDialog } from "./CopyWeekDialog";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import styles from "./BoardToolbar.module.css";

/** 92-day cap: `board_window` raises `invalid_argument` past it (T6, docs/api.md §2). */
const MAX_WINDOW_DAYS = 92;

/**
 * The one key for "does the caller administer this plant", keyed by plant id
 * the way `boardKeys.window` is keyed by what it loads, so nothing hand-builds
 * it and a grant change can invalidate it by prefix.
 */
export const copyWeekKeys = {
  adminFor: (plantId: string) => ["copy-week", "admin-for", plantId] as const,
  // R-356: whether the caller may place on this plant (admin, or a supervisor
  // whose grant overlaps it) — the predicate for saving/applying a template.
  canPlace: (plantId: string) => ["copy-week", "can-place", plantId] as const,
};

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
  dateFormat = DEFAULT_DATE_FORMAT,
  zone,
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
  dateFormat?: DateFormat;
  zone?: string;
}) {
  const startInputValue = windowStartDate.toISOString().slice(0, 10);

  // D88a (R-353): the displayed range must read the PLANT's days, the same ones
  // the board axis draws. `windowStartDate` is the store's UTC-midnight "which
  // day" marker; formatting it directly in a western zone would print the
  // PREVIOUS day (UTC midnight is the evening before, locally). So reinterpret
  // its calendar day as that day's LOCAL midnight in `zone` — exactly what
  // `buildBoardIndex` does for the axis origin — and label from there. For a UTC
  // zone this is `windowStartDate` unchanged.
  const localStart = zonedTimeToInstant(
    zone ?? "UTC",
    windowStartDate.getUTCFullYear(),
    windowStartDate.getUTCMonth() + 1,
    windowStartDate.getUTCDate(),
    0,
    0,
  );
  const localLastDay = zonedTimeToInstant(
    zone ?? "UTC",
    windowStartDate.getUTCFullYear(),
    windowStartDate.getUTCMonth() + 1,
    windowStartDate.getUTCDate() + windowDayCount - 1,
    0,
    0,
  );

  // R-339 / S35: Copy Week. The plant is the board's chosen root; the dialog
  // is anchored under the button that opened it, like every other popover.
  //
  // ⚠️ THE PREDICATE IS THE SERVER'S. `copy_week_plan` refuses anyone who is
  // not `app_is_admin_for(plant)`, so the button is offered on that exact
  // answer, asked for THIS plant, and on nothing the session carries: a site
  // admin of one plant who can only view another has `adminAnywhere` and no
  // right to copy here, and a company admin gets `true` from the server
  // anyway. CLAUDE.md section 4: whatever a client offers is decided by the
  // same test the server runs. Nothing is offered while the answer is loading
  // or after the ask failed -- "we could not ask" is not "yes".
  const queryClient = useQueryClient();
  // R-358: one anchor carries which button opened it, so the same dialog can
  // start on the week source (Copy week) or the template source (Apply a
  // template) without a second piece of state to keep in step.
  const [copyWeekAnchor, setCopyWeekAnchor] = useState<{
    x: number;
    y: number;
    source: "week" | "template";
  } | null>(null);
  const [saveAnchor, setSaveAnchor] = useState<{ x: number; y: number } | null>(null);
  const plant = roots.find((r) => r.path === rootPath) ?? null;
  const adminFor = useQuery({
    queryKey: copyWeekKeys.adminFor(plant?.id ?? ""),
    queryFn: () => fetchIsAdminFor(plant?.id ?? ""),
    enabled: plant !== null,
    staleTime: 30_000,
    // A typed refusal is an answer, not a flake (the board's own retry rule).
    retry: (count, err) => !isSchedulerError(err) && count < 1,
  });
  // R-356: a supervisor who can place on this plant may save a week as a
  // template and apply one, though only an admin may copy from another WEEK.
  const canPlace = useQuery({
    queryKey: copyWeekKeys.canPlace(plant?.id ?? ""),
    queryFn: () => fetchCanPlaceInPlant(plant?.id ?? ""),
    enabled: plant !== null,
    staleTime: 30_000,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
  });
  const isAdmin = adminFor.data === true;
  const canPlaceHere = canPlace.data === true;
  // "Copy week" stays ADMIN-ONLY (S35): only an admin copies from another week.
  // "Apply a template" is offered to EVERYONE who may place, admins included
  // (R-358: the maintainer's only route to a saved template was a <select>
  // inside a dialog named after the other thing it does). Both open the same
  // dialog at the same anchor, switched to the source their own button means.
  const offerCopyWeek = plant !== null && isAdmin;
  const offerApplyTemplate = plant !== null && canPlaceHere;
  const offerSaveTemplate = plant !== null && canPlaceHere;

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
        {formatDayLabel(localStart, dateFormat, zone)} –{" "}
        {formatDayLabel(localLastDay, dateFormat, zone)}
      </span>

      {/* Day navigation, ported from the mockup's `.daynav`. Without it the
          only way to move the window is to retype the date, which is exactly
          the friction the mockup's buttons existed to remove. "Today" also
          re-scrolls the current instant into view, not just the date. */}
      <div className={styles.daynav}>
        <button type="button" onClick={() => onShiftWindowByDays(-1)} title="Back one day">
          <Chevron direction="left" /> Prev day
        </button>
        <button type="button" onClick={onGoToToday} title="Jump to today and scroll to now">
          Today
        </button>
        <button type="button" onClick={() => onShiftWindowByDays(1)} title="Forward one day">
          Next day <Chevron direction="right" />
        </button>
      </div>

      {(offerCopyWeek || offerApplyTemplate || offerSaveTemplate) && (
        <div className={styles.copyWeek}>
          {offerCopyWeek && (
            <button
              type="button"
              title="Copy this week's plan into another week, deciding every clash yourself"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setCopyWeekAnchor({ x: r.left, y: r.bottom + 4, source: "week" });
              }}
            >
              Copy week
            </button>
          )}
          {offerApplyTemplate && (
            <button
              type="button"
              title="Apply a saved template to a week, deciding every clash yourself"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setCopyWeekAnchor({ x: r.left, y: r.bottom + 4, source: "template" });
              }}
            >
              Apply a template
            </button>
          )}
          {offerSaveTemplate && (
            <button
              type="button"
              title="Save this week's runs and people as a named template"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setSaveAnchor({ x: r.left, y: r.bottom + 4 });
              }}
            >
              Save this week as a template
            </button>
          )}
        </div>
      )}
      {copyWeekAnchor !== null && plant !== null && (
        <CopyWeekDialog
          plantId={plant.id}
          plantName={plant.name}
          windowStart={windowStartDate}
          anchor={copyWeekAnchor}
          dateFormat={dateFormat}
          zone={zone}
          isAdmin={isAdmin}
          initialSource={copyWeekAnchor.source}
          onClose={() => setCopyWeekAnchor(null)}
          onApplied={() => {
            // The same refresh every writer on the board triggers: invalidate
            // the loaded window's key (useRunMutations / useAssignmentMutations).
            const to = addMinutes(windowStartDate, windowDayCount * MINUTES_PER_DAY);
            void queryClient.invalidateQueries({
              queryKey: boardKeys.window(plant.path, windowStartDate, to),
            });
          }}
        />
      )}
      {saveAnchor !== null && plant !== null && (
        <SaveTemplateDialog
          plantId={plant.id}
          plantName={plant.name}
          windowStart={windowStartDate}
          anchor={saveAnchor}
          onClose={() => setSaveAnchor(null)}
        />
      )}

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
            <span className={styles.swatch} style={{ background: productColorCss(p.colorToken) }} />
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

      {/* DENSITY CONTROL REMOVED (the maintainer, Aug 25). Fit is automatic and the
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
