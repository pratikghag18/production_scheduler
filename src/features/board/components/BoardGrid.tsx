import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HierarchyLevel, Product, BoardOperator } from "@/lib/api";
import type { BoardIndex, BoardRow } from "../lib/boardIndex";
import {
  ZOOMS,
  minutesToPx,
  pxToMinutes,
  buildRowOffsets,
  visibleRowRange,
  visibleMinuteRange,
} from "../lib/geometry";
import { MS_PER_MINUTE } from "../lib/time";
import { BoardHeader } from "./BoardHeader";
import { GroupRow } from "./GroupRow";
import { TrackRow, type TrackRowDragApi } from "./TrackRow";
import styles from "./BoardGrid.module.css";

const RAIL_WIDTH = 232;
const OVERSCAN_ROWS = 4;
const OVERSCAN_MINUTES = 240;
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
 * Owns T1 (scroll-anchor-by-node-id across a refetch), T2 (zoom preserves
 * the horizontal centre instant), T7 (collapse toggle keeps the first
 * visible row in place, or scrolls to the collapsed group if it was inside
 * it), and T9 (viewportHeight === 0 before the first ResizeObserver
 * callback yields an empty visible range, never a crash).
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
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;

  // --- product color cycling (mockup hardcodes 4; cycle by modulo for a
  // larger catalogue) -----------------------------------------------------
  const productIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const p of productById.values()) map.set(p.id, i++);
    return map;
  }, [productById]);
  const productColorVar = useCallback(
    (productId: string | null) => {
      if (!productId) return "var(--muted)";
      const i = productIndexById.get(productId) ?? 0;
      return `var(--product-${(i % 4) + 1})`;
    },
    [productIndexById],
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

  const heights = useMemo(() => visibleRows.map((r) => r.height), [visibleRows]);
  const { offsets, total: totalRowsHeight } = useMemo(() => buildRowOffsets(heights), [heights]);
  const rowIndexByNodeId = useMemo(() => {
    const m = new Map<string, number>();
    visibleRows.forEach((r, i) => m.set(r.node.id, i));
    return m;
  }, [visibleRows]);

  const pxPerHour = ZOOMS[zoomIndex].pxPerHour;
  const trackWidth = minutesToPx(index.windowMinutes, pxPerHour);

  // --- ResizeObserver: viewport dimensions. T9: until the first
  // observation, height/width stay 0 -> empty visible ranges, no crash. ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
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

  // --- T1: scroll anchoring by node id across a data change. -------------
  const prevIndexRef = useRef<BoardIndex | null>(null);
  const prevRowsRef = useRef<BoardRow[]>(visibleRows);
  const prevOffsetsRef = useRef<number[]>(offsets);
  const pendingAnchorOverrideRef = useRef<Anchor | null>(null); // set by T7's toggle handler

  useLayoutEffect(() => {
    const el = containerRef.current;
    const isFirstRun = prevIndexRef.current === null;
    // Anything that changed prevRowsRef (a data refetch changing `index`,
    // OR a collapse toggle re-filtering `visibleRows`) needs anchor
    // preservation — not just an index change. T7 is otherwise silently
    // broken for the common case (anchor NOT inside the collapsed group,
    // but shifted by rows above it collapsing).
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
      // RAIL_WIDTH px of the viewport and the track is only visible in the
      // remainder. The instant the user is looking at therefore sits at the
      // centre of (viewport.width - RAIL_WIDTH), not of viewport.width.
      // Using the full width biases the centre by RAIL_WIDTH/2 px, and
      // because that bias converts to a DIFFERENT number of minutes at each
      // zoom (116px is ~109 min at Compact but ~41 min at Fine), the view
      // drifted later on every zoom-in instead of holding still.
      const trackViewport = Math.max(0, viewport.width - RAIL_WIDTH);
      const centreMin = pxToMinutes(scrollRef.current.left + trackViewport / 2, oldPxPerHour);
      let newLeft = minutesToPx(centreMin, pxPerHour) - trackViewport / 2;
      // Max scrollLeft is contentWidth - clientWidth, and the content is the
      // rail PLUS the track — not the track alone.
      const maxScrollLeft = Math.max(0, RAIL_WIDTH + trackWidth - viewport.width);
      newLeft = Math.max(0, Math.min(newLeft, maxScrollLeft));
      el.scrollLeft = newLeft;
      setScroll((s) => ({ ...s, left: newLeft }));
    }
    prevZoomRef.current = zoomIndex;
    prevPxPerHourRef.current = pxPerHour;
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

    const trackViewport = Math.max(0, viewport.width - RAIL_WIDTH);
    const target = minutesToPx(nowMin, pxPerHour) - trackViewport * NOW_LEAD_FRACTION;
    const maxScrollLeft = Math.max(0, RAIL_WIDTH + trackWidth - viewport.width);
    const next = Math.max(0, Math.min(target, maxScrollLeft));
    el.scrollLeft = next;
    setScroll((s) => ({ ...s, left: next }));
  }, [
    scrollToNowNonce,
    viewport.width,
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
      <div className={styles.canvas} style={{ width: RAIL_WIDTH + trackWidth }}>
        <BoardHeader
          windowStart={index.windowStart}
          dayCount={index.dayCount}
          windowMinutes={index.windowMinutes}
          zoomIndex={zoomIndex}
          railWidth={RAIL_WIDTH}
          visibleMinRange={visibleMinRange}
        />
        <div
          className={styles.spacer}
          style={{ height: totalRowsHeight, width: RAIL_WIDTH + trackWidth }}
        >
          {renderedRows.map((row, i) => {
            const rowIndex = firstRow + i;
            const top = offsets[rowIndex];
            if (row.isTrack) {
              return (
                <div key={row.node.id} className={styles.rowAbs} style={{ top }}>
                  <TrackRow
                    row={row}
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
                    railWidth={RAIL_WIDTH}
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
                  railWidth={RAIL_WIDTH}
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
