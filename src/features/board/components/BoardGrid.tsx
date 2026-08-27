import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HierarchyLevel, Product, BoardOperator } from "@/lib/api";
import type { BoardIndex, BoardRow } from "../lib/boardIndex";
import {
  ZOOMS,
  DENSITIES,
  minutesToPx,
  pxToMinutes,
  buildRowOffsets,
  visibleRowRange,
  visibleMinuteRange,
  trackRowHeight,
  computeFitScale,
} from "../lib/geometry";
import { resolveDropRow } from "../lib/interaction";
import { MS_PER_MINUTE } from "../lib/time";
import { BoardHeader } from "./BoardHeader";
import { GroupRow } from "./GroupRow";
import { TrackRow, type TrackRowDragApi } from "./TrackRow";
import styles from "./BoardGrid.module.css";

const OVERSCAN_ROWS = 4;
const OVERSCAN_MINUTES = 240;
/**
 * P1-4d D51: the sticky header track's rendered height, subtracted from the
 * measured container height to get the available height for ROWS. Unlike
 * `--rail-w` (P1-4c D47), this is safe to hardcode rather than measure via a
 * probe: `BoardHeader.module.css`'s `.hdrTrack { height: 64px }` is a plain
 * constant, not a `calc()` driven by `--ui-scale` — there is no runtime
 * value it could resolve to other than 64 — the header scales with
 * `--chrome-scale` (viewport-only), never with `--ui-scale` (fit-driven),
 * precisely so this stays a constant instead of a circular measurement. THIS NUMBER IS DUPLICATED in
 * `BoardHeader.module.css` and the two must be changed together — it was
 * already missed once, when the day strip was enlarged from 54 to 62 and
 * the fit calculation kept subtracting 54, under-measuring the available
 * height by 8px. If `.hdrTrack`'s height ever
 * becomes `--ui-scale`-dependent, this constant must move to a measured
 * probe the same way rail width did.
 */
const HEADER_HEIGHT_PX = 64;
/** Where "now" sits across the visible track when we scroll to it: a quarter
 *  in from the left, so there is a little recent context behind it and most
 *  of the screen is the schedule ahead. */
const NOW_LEAD_FRACTION = 0.25;

interface Anchor {
  nodeId: string;
  path: string;
  offsetWithinViewport: number;
}

function findAnchor(rows: BoardRow[], offsets: number[], scrollTop: number): Anchor | null {
  if (rows.length === 0) return null;
  // last row whose offset <= scrollTop
  let idx = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= scrollTop) idx = i;
    else break;
  }
  return {
    nodeId: rows[idx].node.id,
    path: rows[idx].node.path,
    offsetWithinViewport: scrollTop - offsets[idx],
  };
}

/** T1's ancestor fallback: walk the anchor's old path up until a still-present row is found. */
function resolveAnchorRowIndex(
  anchor: Anchor,
  rows: BoardRow[],
  rowIndexByNodeId: Map<string, number>,
): number | null {
  const direct = rowIndexByNodeId.get(anchor.nodeId);
  if (direct !== undefined) return direct;
  const segments = anchor.path.split(".");
  for (let i = segments.length - 1; i >= 1; i--) {
    const ancestorPath = segments.slice(0, i).join(".");
    const row = rows.find((r) => r.node.path === ancestorPath);
    if (row) return rowIndexByNodeId.get(row.node.id) ?? null;
  }
  return null;
}

/**
 * The scroll container + hand-rolled two-axis virtualization (brief §6).
 * Owns T1 (scroll-anchor-by-node-id across a refetch — P1-4c D45/T17 routes
 * a density change through this exact same path, since a density change
 * produces a new `index` with a new `rows` identity, same as a refetch),
 * T2 (zoom preserves the horizontal centre instant), T7 (collapse toggle
 * keeps the first visible row in place, or scrolls to the collapsed group
 * if it was inside it), T9 (viewportHeight === 0 before the first
 * ResizeObserver callback yields an empty visible range, never a crash),
 * and P1-4c T19 (rail-width changes from a `--ui-scale` resize clamp
 * `scrollLeft` so the board cannot end up scrolled past its own content).
 */
export function BoardGrid({
  index,
  levelById,
  collapsedNodeIds,
  onToggleCollapsed,
  zoomIndex,
  productById,
  operatorById,
  scrollToNowNonce,
  dragApi,
  setDropRowResolver,
  onFitScaleChange,
}: {
  index: BoardIndex;
  levelById: Map<string, HierarchyLevel>;
  collapsedNodeIds: Set<string>;
  onToggleCollapsed: (nodeId: string) => void;
  zoomIndex: 0 | 1 | 2;
  productById: Map<string, Product>;
  operatorById: Map<string, BoardOperator>;
  /** Bumped by the store to request that "now" be scrolled into view. */
  scrollToNowNonce: number;
  /** P1-4b: the single `useDragGesture` instance, threaded down to every
   *  `TrackRow`. */
  dragApi: TrackRowDragApi;
  /**
   * P1-4e D58: `useDragGesture` cannot do its own row hit-testing — it owns
   * no DOM geometry (D58 explicitly forbids `elementFromPoint`, §3 item
   * "no second virtualization scheme either") — so `BoardGrid`, which
   * already owns the scroll container, the row offsets, and the
   * collapse-filtered row list, registers a resolver function back into
   * the hook instead. Called from a `useEffect` below on every render
   * where the underlying geometry actually changes; the resolver itself
   * reads live scroll position off `scrollRef` (never a value captured at
   * registration time — T22's "always current" requirement, restated for
   * row resolution instead of overlap).
   */
  setDropRowResolver: (
    fn:
      | ((
          clientX: number,
          clientY: number,
        ) => { nodeId: string; isTrack: boolean; minute: number } | null)
      | null,
  ) => void;
  /**
   * P1-4d D51/D55: reports the fit scale computed from THIS render's
   * natural (Standard, unscaled) row heights and measured available
   * height. Always computed and reported, regardless of `densityMode` —
   * `BoardGrid` does not know or care whether Fit is actually selected;
   * `BoardPage` decides whether to use the reported number. Fired from a
   * `useEffect` (not during render) so the resulting `setState` in the
   * parent is a normal post-render update, not a render-phase one.
   */
  onFitScaleChange: (scale: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // P1-4c D47: `--rail-w` is now `calc(232px * var(--ui-scale))` in
  // tokens.css, so it can no longer be a hardcoded `232` in TS (self-review
  // item 2). `railProbeRef` is a zero-height, hidden element whose CSS
  // `width` is `var(--rail-w)` (BoardGrid.module.css `.railProbe`) — reading
  // ITS computed `width` (a typed, resolved CSS property) is how an
  // unregistered custom property's calc() gets resolved to an actual px
  // number; `getComputedStyle(el).getPropertyValue('--rail-w')` would
  // return the literal unresolved `calc(...)` token stream instead. Starts
  // at 0, the same convention T9 already uses for `viewport` before the
  // first measurement.
  const railProbeRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [railWidth, setRailWidth] = useState(0);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;

  // --- product colour: THE PRODUCT'S OWN, NOT ITS POSITION (D102) ---------
  //
  // ⭐ THIS USED TO BE `var(--product-${(i % 4) + 1})` OVER A MAP BUILT BY
  // ITERATION ORDER, AND THAT WAS A COLOUR THAT DID NOT BELONG TO ANYTHING.
  // `board_window` emits products `ORDER BY p.sku` org-wide, so a product's
  // colour was its alphabetical position among ALL the company's products:
  // adding "Gadget Z" re-coloured Widget X and Widget Y, and two sites shared
  // one 4-wide cycle. Migration 0023 §3 gave every product a `color_token` of
  // its own, chosen once at insert and never re-picked; nothing in `src/` read
  // it until now, which would have made the admin section's colour column a
  // lie the moment it shipped.
  //
  // `productColorVar` in `src/features/admin/lib/products.ts` is the same
  // function for the admin screen. It is NOT imported here: a feature may not
  // import from another feature (docs/conventions.md), and the shared thing is
  // the DATABASE column, not this three-line lookup.
  const productColorVar = useCallback(
    (productId: string | null) => {
      if (!productId) return "var(--muted)";
      const token = productById.get(productId)?.colorToken;
      // `tokens.css` defines `--product-1` .. `--product-4` and nothing else.
      // A token outside that set -- absent, or a `product-5` from a widened
      // palette (0023 §3 records that exact ship) -- resolves to NO COLOUR AT
      // ALL, which reads as a design choice rather than as a bug. Fall back to
      // the first palette entry instead. ⚠️ Widening the palette is
      // `tokens.css`, `app_product_palette()`, `PRODUCT_PALETTE` in
      // `src/features/admin/lib/products.ts` and this regex, in one commit.
      return token !== undefined && /^product-[1-4]$/.test(token)
        ? `var(--${token})`
        : "var(--product-1)";
    },
    [productById],
  );

  // --- collapse filtering: a row is hidden if any ancestor node id is
  // collapsed. One pass over the ordered rows array (§9). ------------------
  const visibleRows = useMemo(() => {
    if (collapsedNodeIds.size === 0) return index.rows;
    const collapsedPaths = new Set<string>();
    for (const id of collapsedNodeIds) {
      const node = index.nodeById.get(id);
      if (node) collapsedPaths.add(node.path);
    }
    if (collapsedPaths.size === 0) return index.rows;
    const out: BoardRow[] = [];
    for (const row of index.rows) {
      let hidden = false;
      for (const p of collapsedPaths) {
        if (row.node.path !== p && row.node.path.startsWith(`${p}.`)) {
          hidden = true;
          break;
        }
      }
      if (!hidden) out.push(row);
    }
    return out;
  }, [index.rows, index.nodeById, collapsedNodeIds]);

  // --- P1-4d D51/D55: the fit scale. `naturalHeights` is deliberately NOT
  // `visibleRows.map(r => r.height)` — `row.height` reflects whatever
  // density `index` actually happens to have been built at (which, under
  // Fit, is itself derived from a PREVIOUS fitScale), and feeding that back
  // in would be exactly the circularity the brief warns against (§3 item
  // 3, mutation M5). `row.laneCount`/`row.isTrack` are density-INVARIANT
  // (lane packing runs on raw start/end times in `boardIndex.ts`, never on
  // pixel geometry), so recomputing the Standard-density height from them
  // here is what makes this a single pass instead of a feedback loop, no
  // matter which density `index` was actually built with. -----------------
  const naturalHeights = useMemo(
    () =>
      visibleRows.map((r) =>
        r.isTrack ? trackRowHeight(r.laneCount, DENSITIES[1]) : DENSITIES[1].groupRowHeight,
      ),
    [visibleRows],
  );
  const availableHeight = Math.max(0, viewport.height - HEADER_HEIGHT_PX);
  const fitScale = useMemo(
    () => computeFitScale(naturalHeights, availableHeight),
    [naturalHeights, availableHeight],
  );
  // Report upward on every render where the computed scale actually
  // changes (D55: "recompute on every input that changes either term").
  // Effect, not inline during render, so the parent's resulting setState is
  // a normal post-render update (see the prop doc above).
  useEffect(() => {
    onFitScaleChange(fitScale);
  }, [fitScale, onFitScaleChange]);

  const heights = useMemo(() => visibleRows.map((r) => r.height), [visibleRows]);
  const { offsets, total: totalRowsHeight } = useMemo(() => buildRowOffsets(heights), [heights]);
  const rowIndexByNodeId = useMemo(() => {
    const m = new Map<string, number>();
    visibleRows.forEach((r, i) => m.set(r.node.id, i));
    return m;
  }, [visibleRows]);

  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const trackWidth = minutesToPx(index.windowMinutes, pxPerHour);

  // --- D58: register the drop-row resolver. `resolveDropRow` (pure,
  // harness-tested §10) does the binary search; everything geometry-
  // specific — content-coordinate conversion, live scroll, the rail-width
  // subtraction that turns a viewport x into a track-relative minute — is
  // supplied here, the one place that already owns all of it. Live scroll
  // is read off `scrollRef` (declared above, kept current every frame),
  // never captured at registration time, so a resolver registered before a
  // scroll still answers correctly after one (T22's requirement, restated
  // for row/minute resolution instead of run overlap). Re-registered
  // whenever the underlying geometry changes. -----------------------------
  useEffect(() => {
    setDropRowResolver((clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const contentY = clientY - rect.top + scrollRef.current.top;
      const rowIdx = resolveDropRow(offsets, heights, contentY);
      if (rowIdx === null) return null;
      const row = visibleRows[rowIdx];
      if (!row) return null;
      const contentX = clientX - rect.left + scrollRef.current.left;
      const trackX = Math.max(0, contentX - railWidth);
      const minute = pxToMinutes(trackX, pxPerHour);
      return { nodeId: row.node.id, isTrack: row.isTrack, minute };
    });
    return () => setDropRowResolver(null);
  }, [offsets, heights, visibleRows, railWidth, pxPerHour, setDropRowResolver]);
  // Read inside the ResizeObserver callback below without re-subscribing
  // the observer on every render (brief D47: "do not add a second
  // observer" — this keeps trackWidth current for T19's clamp without one).
  const trackWidthRef = useRef(trackWidth);
  trackWidthRef.current = trackWidth;

  // --- ResizeObserver: viewport dimensions AND (P1-4c) the measured rail
  // width, in the SAME callback (D47). T9: until the first observation,
  // height/width/railWidth stay 0 -> empty visible ranges, no crash. P1-4c
  // T19: a resize that shrinks available width also re-measures the rail
  // (since `--rail-w` depends on `--ui-scale`, which depends on `100vw`)
  // and clamps `scrollLeft` so the board cannot end up scrolled past its
  // own right edge. ---------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newViewport = { width: entry.contentRect.width, height: entry.contentRect.height };
      setViewport(newViewport);

      const probe = railProbeRef.current;
      const measured = probe ? parseFloat(getComputedStyle(probe).width) : NaN;
      const newRailWidth = Number.isFinite(measured) ? measured : 0;
      setRailWidth(newRailWidth);

      // T19: clamp scrollLeft after any rail/viewport width change.
      const maxScrollLeft = Math.max(0, newRailWidth + trackWidthRef.current - newViewport.width);
      if (el.scrollLeft > maxScrollLeft) {
        el.scrollLeft = maxScrollLeft;
        setScroll((s) => ({ ...s, left: maxScrollLeft }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- scroll handler, coalesced with requestAnimationFrame: one state
  // update per frame, cancel any pending frame on the next event, cancel on
  // unmount. -----------------------------------------------------------------
  const rafRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      setScroll({ top: el.scrollTop, left: el.scrollLeft });
    });
  }, []);
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // --- T1: scroll anchoring by node id across a data change. P1-4c T17: a
  // density change produces a new `index` (BoardPage's `buildBoardIndex`
  // call includes `density` in its deps) and therefore a new `visibleRows`
  // identity, so it goes through this exact same anchor-preserving path —
  // there is no separate density-specific scroll logic anywhere in this
  // file. -------------------------------------------------------------------
  const prevIndexRef = useRef<BoardIndex | null>(null);
  const prevRowsRef = useRef<BoardRow[]>(visibleRows);
  const prevOffsetsRef = useRef<number[]>(offsets);
  const pendingAnchorOverrideRef = useRef<Anchor | null>(null); // set by T7's toggle handler

  useLayoutEffect(() => {
    const el = containerRef.current;
    const isFirstRun = prevIndexRef.current === null;
    // Anything that changed prevRowsRef (a data refetch changing `index`, a
    // density change changing `index` (T17), OR a collapse toggle
    // re-filtering `visibleRows`) needs anchor preservation — not just an
    // index change. T7 is otherwise silently broken for the common case
    // (anchor NOT inside the collapsed group, but shifted by rows above it
    // collapsing).
    const rowsChanged = prevRowsRef.current !== visibleRows;

    if (el && !isFirstRun && rowsChanged) {
      let anchor: Anchor | null = pendingAnchorOverrideRef.current;
      pendingAnchorOverrideRef.current = null;

      if (!anchor) {
        anchor = findAnchor(prevRowsRef.current, prevOffsetsRef.current, scrollRef.current.top);
      }

      if (anchor) {
        const rowIdx = resolveAnchorRowIndex(anchor, visibleRows, rowIndexByNodeId);
        if (rowIdx !== null) {
          const newTop = Math.max(0, offsets[rowIdx] + anchor.offsetWithinViewport);
          el.scrollTop = newTop;
          setScroll((s) => ({ ...s, top: newTop }));
        } else {
          const clamped = Math.min(
            scrollRef.current.top,
            Math.max(0, totalRowsHeight - viewport.height),
          );
          el.scrollTop = clamped;
          setScroll((s) => ({ ...s, top: clamped }));
        }
      }
    }

    prevIndexRef.current = index;
    prevRowsRef.current = visibleRows;
    prevOffsetsRef.current = offsets;
  }, [index, visibleRows, offsets, rowIndexByNodeId, totalRowsHeight, viewport.height]);

  // --- T2: zoom preserves the instant under the viewport's horizontal
  // centre. ------------------------------------------------------------------
  const prevZoomRef = useRef(zoomIndex);
  const prevPxPerHourRef = useRef(pxPerHour);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && prevZoomRef.current !== zoomIndex) {
      const oldPxPerHour = prevPxPerHourRef.current;
      // The rail is `position: sticky; left: 0`, so it OVERLAYS the first
      // railWidth px of the viewport and the track is only visible in the
      // remainder. The instant the user is looking at therefore sits at the
      // centre of (viewport.width - railWidth), not of viewport.width.
      // Using the full width biases the centre by railWidth/2 px, and
      // because that bias converts to a DIFFERENT number of minutes at each
      // zoom (116px is ~109 min at Compact but ~41 min at Fine), the view
      // drifted later on every zoom-in instead of holding still.
      const trackViewport = Math.max(0, viewport.width - railWidth);
      const centreMin = pxToMinutes(scrollRef.current.left + trackViewport / 2, oldPxPerHour);
      let newLeft = minutesToPx(centreMin, pxPerHour) - trackViewport / 2;
      // Max scrollLeft is contentWidth - clientWidth, and the content is the
      // rail PLUS the track — not the track alone.
      const maxScrollLeft = Math.max(0, railWidth + trackWidth - viewport.width);
      newLeft = Math.max(0, Math.min(newLeft, maxScrollLeft));
      el.scrollLeft = newLeft;
      setScroll((s) => ({ ...s, left: newLeft }));
    }
    prevZoomRef.current = zoomIndex;
    prevPxPerHourRef.current = pxPerHour;
    // Deliberately narrow: only re-run when zoomIndex itself changes, not on
    // every viewport/railWidth/trackWidth render — those are read fresh
    // from this render's closure when zoom actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomIndex]);

  // --- Scroll the current instant into view. Runs on first mount and
  // whenever the store bumps the nonce (the toolbar's "Today"). Deliberately
  // NOT on every window change: Prev/Next day should leave the horizontal
  // scroll where the user put it. -------------------------------------------
  const lastNowNonceRef = useRef(-1);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Wait for the first ResizeObserver callback — with a zero width there is
    // no viewport to centre anything in, and consuming the nonce here would
    // mean the initial scroll silently never happens (T9).
    if (viewport.width <= 0) return;
    if (lastNowNonceRef.current === scrollToNowNonce) return;
    lastNowNonceRef.current = scrollToNowNonce;

    const nowMin = (Date.now() - index.windowStart.getTime()) / MS_PER_MINUTE;
    // "now" outside the loaded window is normal (the user paged to another
    // week) — leave their scroll position alone rather than jumping to an edge.
    if (nowMin < 0 || nowMin > index.windowMinutes) return;

    const trackViewport = Math.max(0, viewport.width - railWidth);
    const target = minutesToPx(nowMin, pxPerHour) - trackViewport * NOW_LEAD_FRACTION;
    const maxScrollLeft = Math.max(0, railWidth + trackWidth - viewport.width);
    const next = Math.max(0, Math.min(target, maxScrollLeft));
    el.scrollLeft = next;
    setScroll((s) => ({ ...s, left: next }));
  }, [
    scrollToNowNonce,
    viewport.width,
    railWidth,
    pxPerHour,
    trackWidth,
    index.windowStart,
    index.windowMinutes,
  ]);

  // --- T7: a collapse toggle while scrolled below the collapsed group. ---
  const handleToggle = useCallback(
    (nodeId: string) => {
      const isCurrentlyCollapsed = collapsedNodeIds.has(nodeId);
      if (!isCurrentlyCollapsed) {
        // About to collapse: if the current anchor is this node or a
        // descendant of it, scroll to the group's own row instead of
        // trying to preserve a row that is about to disappear.
        const currentAnchor = findAnchor(visibleRows, offsets, scrollRef.current.top);
        const collapsingNode = index.nodeById.get(nodeId);
        if (currentAnchor && collapsingNode) {
          const anchorIsInside =
            currentAnchor.path === collapsingNode.path ||
            currentAnchor.path.startsWith(`${collapsingNode.path}.`);
          if (anchorIsInside) {
            pendingAnchorOverrideRef.current = {
              nodeId,
              path: collapsingNode.path,
              offsetWithinViewport: 0,
            };
          }
        }
        // T15 (P1-4b): a collapse that removes the currently-dragged row
        // cancels the drag — the block's own row is about to unmount.
        const dragged = dragApi.activeDrag;
        if (dragged && collapsingNode) {
          const draggedNode = index.nodeById.get(dragged.nodeId);
          const draggedIsInside =
            draggedNode &&
            (draggedNode.path === collapsingNode.path ||
              draggedNode.path.startsWith(`${collapsingNode.path}.`));
          if (draggedIsInside) dragApi.cancelDrag();
        }
      }
      onToggleCollapsed(nodeId);
    },
    [collapsedNodeIds, visibleRows, offsets, index.nodeById, onToggleCollapsed, dragApi],
  );

  // --- visible slices (T9: empty when viewport not yet observed). --------
  const [firstRow, lastRow] = useMemo(
    () => visibleRowRange(offsets, totalRowsHeight, scroll.top, viewport.height, OVERSCAN_ROWS),
    [offsets, totalRowsHeight, scroll.top, viewport.height],
  );
  const visibleMinRange = useMemo(
    () =>
      visibleMinuteRange(
        scroll.left,
        viewport.width,
        pxPerHour,
        index.windowMinutes,
        OVERSCAN_MINUTES,
      ),
    [scroll.left, viewport.width, pxPerHour, index.windowMinutes],
  );

  const renderedRows = visibleRows.slice(firstRow, lastRow);

  return (
    <div ref={containerRef} className={styles.board} onScroll={handleScroll}>
      {/* P1-4c D47: invisible probe — its resolved `width` is how railWidth
          gets measured from `--rail-w`. See the comment on railProbeRef. */}
      <div ref={railProbeRef} className={styles.railProbe} aria-hidden="true" />
      <div className={styles.canvas} style={{ width: railWidth + trackWidth }}>
        <BoardHeader
          windowStart={index.windowStart}
          dayCount={index.dayCount}
          windowMinutes={index.windowMinutes}
          zoomIndex={zoomIndex}
          railWidth={railWidth}
          visibleMinRange={visibleMinRange}
        />
        <div
          className={styles.spacer}
          style={{ height: totalRowsHeight, width: railWidth + trackWidth }}
        >
          {renderedRows.map((row, i) => {
            const rowIndex = firstRow + i;
            const top = offsets[rowIndex];
            if (row.isTrack) {
              return (
                <div key={row.node.id} className={styles.rowAbs} style={{ top }}>
                  <TrackRow
                    row={row}
                    density={index.density}
                    template={index.templateForNode.get(row.node.id) ?? null}
                    skills={index.skillsForNode.get(row.node.id) ?? []}
                    runs={index.runsByNode.get(row.node.id) ?? []}
                    assignments={index.assignmentsByNode.get(row.node.id) ?? []}
                    assignmentsByRun={index.assignmentsByRun}
                    productById={productById}
                    operatorById={operatorById}
                    productColorVar={productColorVar}
                    windowStart={index.windowStart}
                    windowMinutes={index.windowMinutes}
                    dayCount={index.dayCount}
                    zoomIndex={zoomIndex}
                    railWidth={railWidth}
                    trackWidth={trackWidth}
                    visibleMinRange={visibleMinRange}
                    dragApi={dragApi}
                  />
                </div>
              );
            }
            return (
              <div key={row.node.id} className={styles.rowAbs} style={{ top }}>
                <GroupRow
                  row={row}
                  level={levelById.get(row.node.levelId)}
                  template={index.templateForNode.get(row.node.id) ?? null}
                  dayCount={index.dayCount}
                  zoomIndex={zoomIndex}
                  trackWidth={trackWidth}
                  railWidth={railWidth}
                  collapsed={collapsedNodeIds.has(row.node.id)}
                  onToggle={() => handleToggle(row.node.id)}
                  visibleMinRange={visibleMinRange}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
