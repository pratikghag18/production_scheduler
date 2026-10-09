import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCanPlaceInPlant, fetchIsAdminFor, isSchedulerError, type Product } from "@/lib/api";
import { productColorCss } from "@/lib/productColor";
import { ZOOMS, type ZoomIndex } from "../lib/geometry";
import { formatDayLabel, addMinutes, zonedTimeToInstant, MINUTES_PER_DAY } from "../lib/time";
import { shouldOfferRootPicker, type BoardRoot } from "../lib/rootSelection";
import { boardKeys } from "../hooks/useBoardWindow";
import {
  DEFAULT_DATE_FORMAT,
  dayMarker,
  isoOfDayMarker,
  type DateFormat,
} from "@/lib/format/dates";
import { Chevron } from "@/components/icons";
import { CopyWeekDialog } from "./CopyWeekDialog";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import styles from "./BoardToolbar.module.css";

/** 92-day cap: `board_window` raises `invalid_argument` past it (T6, docs/api.md §2). */
const MAX_WINDOW_DAYS = 92;

/** S67 (R-445): one toolbar per board, so a static id is enough for
 *  `aria-controls` -- there is never a second `BoardToolbar` on screen to
 *  collide with. */
const MORE_BAND_ID = "board-toolbar-more";

/** S67-b (R-445 CORRECTED 18 Sept): the date range's own pop-over, same
 *  one-toolbar-per-board reasoning as `MORE_BAND_ID` above. */
const RANGE_POPOVER_ID = "board-toolbar-range";

/**
 * S67 (R-445): whether the "Show more" band is open, remembered per person
 * per board -- the same `historyKey` shape `panelSize.ts` and
 * `commandConversation.ts`'s `historyStorageKey` already use, but a bare
 * boolean does not fit `PanelSize`'s `{width, height}` shape, so this is the
 * "two-line helper beside it" the brief allows rather than a forced reuse.
 * Same best-effort contract as both of those: a private window, a full
 * quota, or storage blocked entirely must never break the toggle, only cost
 * it the memory (never thrown, never repaired).
 */
function readShowMore(key: string | null): boolean {
  if (key === null) return false;
  try {
    return window.localStorage.getItem(`boardToolbar.showMore.${key}`) === "1";
  } catch {
    return false;
  }
}

function writeShowMore(key: string | null, value: boolean): void {
  if (key === null) return;
  try {
    window.localStorage.setItem(`boardToolbar.showMore.${key}`, value ? "1" : "0");
  } catch {
    // Best effort -- see the doc above.
  }
}

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
 * S67-b (R-445 CORRECTED 18 Sept): the maintainer's mock, not the 17 Sept
 * build's own reading of the row's words. ONE ROW -- "Board", the plant, a
 * prev/Today/next segmented control, the date range as ONE dropdown control
 * (a button naming the range, opening a small pop-over with the From/Days
 * fields that used to sit directly in the row), the three zoom levels, and
 * "Show more"/"Show less" last, a LAYER over the board (never a row
 * that pushes it down, so `.header`'s own box height, and the
 * `computeFitScale` input measured from it, are identical open and closed)
 * holding the rest as TWO COLUMNS: "Week plan" (Copy week / Apply a
 * template / Save this week as a template, each still gated on its own
 * existing rights check, moved here unchanged, as a plain row of buttons
 * with no bordered strip around them) and "Key" (the WHOLE readable
 * catalogue with its count in the heading -- the 17 Sept filter to products
 * with a run in the shown window is withdrawn, since it left the key empty
 * on a week with no runs). TR-4 (reviewer, 18 Sept): the mock's plain "More" word,
 * with the state carried only in `aria-label`, is WITHDRAWN -- the
 * maintainer, seeing this lane's own build, called it meaningless; the
 * toggle's VISIBLE text and its ACCESSIBLE name are one string again
 * ("Show more" closed, "Show less" open), with a `Chevron` (never a glyph
 * in text) pointing down closed and up open beside it.
 * T5: the loaded window is exactly what the range control requests --
 * scrolling never extends it, so the end-of-window note names that limit
 * instead of letting it read as a bug, but only while the person is
 * actually scrolled to that edge (F-170: it used to render on every board,
 * unconditionally).
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
  atWindowEnd = false,
  isFetching,
  dateFormat = DEFAULT_DATE_FORMAT,
  zone,
  historyKey = null,
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
  /** S67-b (R-445 CORRECTED 18 Sept): the Key lists this WHOLE readable
   *  catalogue, sorted by name, with its count in the heading -- the 17
   *  Sept build's `productIdsInWindow` filter is withdrawn (the maintainer:
   *  "the product keys are missing from show more"), so there is only ever
   *  one list of products handed to this component now. */
  products: Product[];
  /** F-170: whether the person is actually scrolled to the loaded window's
   *  right edge -- the end-of-window note renders only then. */
  atWindowEnd?: boolean;
  isFetching: boolean;
  dateFormat?: DateFormat;
  zone?: string;
  /** S67 (R-445): this person, THIS BOARD -- same key `BoardPage` hands
   *  `CommandLauncher` (`historyStorageKey`), reused here with its own
   *  storage prefix (`readShowMore`/`writeShowMore` above) so "Show more"
   *  remembers how it was left without colliding with the launcher's own
   *  history or S63's panel size under the same key. `null` until the board
   *  knows both the person and the plant, same as the launcher's own prop --
   *  the band still works for the session, it is simply not persisted. */
  historyKey?: string | null;
}) {
  // The store holds a WHICH-DAY MARKER, not an instant; the seam owns both
  // directions of that encoding (R-426), so the input never re-derives it.
  const startInputValue = isoOfDayMarker(windowStartDate);

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
  // R-445: a group with no control the current person may use is not
  // rendered at all -- "Week plan" is the only group gated on rights today,
  // "Key" always has the two status swatches even with no product in the
  // window, so it never disappears.
  const offerWeekPlanGroup = offerCopyWeek || offerApplyTemplate || offerSaveTemplate;

  // S67 (R-445): "Show more" -- closed on a fresh board, remembered per
  // person per board thereafter. `useState`'s initializer only runs once
  // (on mount), so a `historyKey` that arrives or changes AFTER that first
  // render (the board does not know the person and the plant at once until
  // the session and the root have both resolved) needs the effect below to
  // pick up what that key actually holds -- otherwise a person's second
  // board in one sitting would silently inherit the first board's read.
  const [expanded, setExpandedState] = useState(() => readShowMore(historyKey));
  useEffect(() => {
    setExpandedState(readShowMore(historyKey));
  }, [historyKey]);
  const toggleExpanded = () => {
    setExpandedState((prev) => {
      const next = !prev;
      writeShowMore(historyKey, next);
      return next;
    });
  };
  // TR-2 (reviewer, S67-a review): Escape used to close the band but leave
  // focus wherever it was -- fine when that was the toggle itself (a click
  // never moves focus off the button it landed on), but a keyboard user who
  // had tabbed to "Copy week" or into the Key and pressed Escape there lost
  // focus outright: the band, and everything inside it, unmounts on the
  // same render, and nothing in the DOM was ever told to take its place, so
  // focus falls back to `<body>` -- the same failure mode `CommandLauncher`'s
  // own module doc calls out and fixes for its own panel ("`close` always
  // returns focus to the launcher button now"). This band is the same
  // shape (a toggle revealing a layer, closed by its own button or Escape
  // from anywhere inside), so it gets the same rule.
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeBand = () => {
    setExpandedState(false);
    writeShowMore(historyKey, false);
    moreButtonRef.current?.focus();
  };

  // S67-b (R-445 CORRECTED 18 Sept): the date range folded into ONE
  // dropdown control -- a button naming the range, opening a small
  // pop-over with the From/Days fields that used to sit directly in the
  // row. No persistence (unlike "Show more" above): the mock does not ask
  // for this to remember how it was left, and closed-by-default is the
  // safer read of "a dropdown", the same as a native `<select>`.
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeRange = () => {
    setRangeOpen(false);
    rangeButtonRef.current?.focus();
  };
  // A dropdown, unlike the "Show more" band above, closes on an outside
  // click as well as Escape -- the band is deliberately a LAYER that only
  // its own button or Escape dismiss (R-445), but nothing in the brief asks
  // the range control to share that behaviour, and a control that reads
  // "Thu Sep 17 – Sat Sep 19 ▾" is a dropdown in every other sense.
  useEffect(() => {
    if (!rangeOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (rangeButtonRef.current?.contains(target)) return;
      const pop = document.getElementById(RANGE_POPOVER_ID);
      if (pop?.contains(target)) return;
      setRangeOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [rangeOpen]);

  // S67-b (R-445 CORRECTED 18 Sept): the WHOLE readable catalogue, sorted
  // the way a person reads a list -- locale-aware, not code-point order
  // (`sort()`'s default), so an accented name still lands where a person
  // scanning the key expects it. The 17 Sept build filtered this to
  // products with a run in the shown window; withdrawn per the maintainer's
  // 18 Sept correction ("the product keys are missing from show more" --
  // the filter left the key empty on a week with no runs).
  const keyProducts = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name)),
    [products],
  );

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

      {/* S67 (R-445): the Week plan buttons, and the dialogs they anchor,
          moved into the "Show more" band's "Week plan" group below --
          `getBoundingClientRect()` on the button still anchors the dialog
          correctly from inside the band, so the two stayed together rather
          than splitting the button from its own dialog across the file. */}

      {/* S67-b (R-445 CORRECTED 18 Sept): the date range as ONE dropdown
          control, the way the mock draws it -- a button naming the range
          (never a raw glyph for its own chevron, per the icon standard),
          opening a small pop-over that holds the From/Days fields that used
          to sit directly in the row. Closed by default; no persistence, the
          same as a native `<select>`. `.rangeGroup` is the positioning
          context for `.rangePopover` below, the same `position: relative` /
          `position: absolute` pairing `.header`/`.moreBand` already use. */}
      <div className={styles.rangeGroup}>
        <button
          ref={rangeButtonRef}
          type="button"
          className={styles.rangeButton}
          aria-expanded={rangeOpen}
          aria-controls={RANGE_POPOVER_ID}
          onClick={() => setRangeOpen((v) => !v)}
        >
          {formatDayLabel(localStart, dateFormat, zone)} –{" "}
          {formatDayLabel(localLastDay, dateFormat, zone)}
          <Chevron direction={rangeOpen ? "up" : "down"} />
        </button>
        {rangeOpen && (
          <div
            id={RANGE_POPOVER_ID}
            className={styles.rangePopover}
            // TB-10: Escape closes the pop-over and returns focus to the
            // button that opened it, the same rule `closeBand` already
            // gives the "Show more" band (TR-2) -- scoped to this pop-over,
            // not a document-wide listener, so it never fights another
            // layer's own Escape handling.
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeRange();
              }
            }}
          >
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
                const next = dayMarker(v);
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
        )}
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

      {/* F-170: the snap value this used to name here ("snap: 30 min
          (P1-4b)") was a developer's note to itself about a future drag
          behaviour that has since shipped, carrying a brief id no one on the
          floor can act on -- removed rather than reworded, the default the
          finding itself calls for. */}

      {/* S67-b (R-445 CORRECTED 18 Sept): "Nothing else is in the row"
          beyond the mock's six controls; the two quiet, non-interactive
          notes below are the mock's own named exception ("'refreshing…' may
          stay as a quiet text at the row's end") and F-170's edge note,
          which is the same shape -- neither is a control a person acts on,
          so both stay at the row's end rather than moving behind "Show
          more". */}
      {isFetching && (
        <span className={styles.refreshing} title="Refreshing in the background">
          refreshing…
        </span>
      )}

      {/* F-170: this used to render on every board, always, with a title
          naming a brief id ("Scrolling never extends the loaded window in
          P1-4a"). It names a real limit -- scrolling truly does not load
          more days -- so it stays, but only while it is actually true for
          what is on screen: the person has scrolled the grid to the loaded
          window's right edge. `atWindowEnd` is `BoardGrid`'s own scroll
          position compared against its own max scroll left, bubbled up to
          `BoardPage` the same way `onFitScaleChange` already bubbles the fit
          scale, and handed down here -- never re-derived from the window's
          dates, which would be true even while scrolled to the far left. */}
      {atWindowEnd && (
        <span className={styles.scrollNote} title="Scrolling does not load more days">
          window ends at edge — widen “Days” to see more
        </span>
      )}

      {/* TR-4 (reviewer, S67-b review, 18 Sept): the mock's plain "More" word is
          WITHDRAWN. The maintainer, reviewing this lane's own build same day:
          "The unexpanded view should show the Show More button and expanded
          view should show the Show Less button. Just more button is
          meaningless." So the VISIBLE text goes back to naming the state
          ("Show more" closed, "Show less" open) and the ACCESSIBLE name is
          the same string again -- no `aria-label` split. The lane's own
          TB-12 (a constant visible word, state carried only in `aria-label`)
          is the thing withdrawn here, not a bug in how it was built: it
          matched the brief as written, and the maintainer's live look at the
          shipped band overruled the brief. `e2e/toolbarShowMore.ts` already
          reads `aria-expanded` rather than the text, so it needs no change.
          `aria-controls` still points at the band below regardless of
          whether it is currently mounted -- a stable id, not a ref, since
          the id must exist in the attribute before React has necessarily
          committed the band's own DOM node on the same render that opens
          it. The chevron stays (down closed, up open), same convention as
          the range control above (never a raw glyph in text -- `icons.tsx`),
          since the maintainer's objection was to the word alone. */}
      <button
        ref={moreButtonRef}
        type="button"
        className={styles.moreButton}
        aria-expanded={expanded}
        aria-controls={MORE_BAND_ID}
        onClick={toggleExpanded}
      >
        {expanded ? "Show less" : "Show more"}
        <Chevron direction={expanded ? "up" : "down"} />
      </button>

      {expanded && (
        <div
          id={MORE_BAND_ID}
          className={styles.moreBand}
          // R-445: a click on the board does not close this (it is a layer,
          // like S63's panel) -- only the button above and Escape do, so no
          // outside-click listener exists here at all. Escape is scoped to
          // the band itself (not a document-wide listener) so it never
          // fights another layer's own Escape handling (a dialog opened from
          // inside the band, for one).
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closeBand();
            }
          }}
        >
          {/* S67-b (R-445 CORRECTED 18 Sept): TWO COLUMNS, per the mock --
              "Week plan" left (its own intrinsic width, a plain row of
              buttons with no bordered strip around them) and "Key" right,
              taking the remaining width (`.weekPlanColumn`/`.keyColumn`
              below, a flex row with the Key column `flex: 1 1 auto` so it
              alone fills the band's width when "Week plan" is absent --
              TB-11: a viewer, who has no Week plan, gets the key alone
              across the full width, with nothing else to change here.) */}
          {offerWeekPlanGroup && (
            <div className={styles.weekPlanColumn}>
              <h2 className={styles.moreGroupTitle}>Week plan</h2>
              <div className={styles.weekPlanButtons}>
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
            </div>
          )}

          {/* R-445: "Key" always renders -- the two status swatches
              (understaffed, break) are not gated on any rights check, so
              this group is never empty the way "Week plan" can be.
              S67-b (R-445 CORRECTED 18 Sept): the heading now carries the
              WHOLE catalogue's count ("KEY — N PRODUCTS" in the mock; the
              uppercase look comes from `.moreGroupTitle`'s own
              `text-transform`, same as "Week plan" beside it, so the text
              here stays sentence case and the two headings keep sharing one
              rule). A thin divider, then the status marks, separate the
              per-product swatches from the two fixed ones below. */}
          <div className={styles.keyColumn}>
            <h2 className={styles.moreGroupTitle}>
              Key — {keyProducts.length} {keyProducts.length === 1 ? "product" : "products"}
            </h2>
            <div className={styles.keyGrid}>
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
                  import from, rather than matching three copies.
                  R-445 CORRECTED 18 Sept: `keyProducts` (above) is the WHOLE
                  `products` catalogue, sorted by name -- the 17 Sept build's
                  filter to what is actually on the board in the shown window
                  is withdrawn (it left the key empty on a week with no runs). */}
              {keyProducts.map((p) => (
                <span key={p.id} className={styles.key}>
                  <span
                    className={styles.swatch}
                    style={{ background: productColorCss(p.colorToken) }}
                  />
                  {p.name}
                </span>
              ))}
            </div>
            <div className={styles.keyDivider} />
            <div className={styles.keyGrid}>
              <span className={styles.key}>
                <span
                  className={styles.swatchStatus}
                  style={{ background: "var(--signal-warn)" }}
                />
                understaffed
              </span>
              <span className={styles.key}>
                <span className={styles.breakSwatch} />
                break
              </span>
            </div>
          </div>
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
    </header>
  );
}
