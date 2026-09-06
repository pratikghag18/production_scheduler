import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_MARGIN, resolvePopoverPlacement } from "@/lib/placement";
import styles from "./Popover.module.css";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One axis of the dragged position: the placed coordinate plus the dragged
 * delta, held inside the viewport margins.
 *
 * The rule matches `clampAxis` in `@/lib/placement` deliberately -- the drag
 * must not be allowed to put the box somewhere the placement would have
 * refused. An unknown viewport (not yet measured, or SSR) is the placement
 * module's UNCLAMPED path, so it is here too; a box that has not been measured
 * counts as zero-sized and pins to the far edge rather than past it.
 */
function clampDraggedAxis(placed: number, delta: number, size: number, viewport: number): number {
  if (!Number.isFinite(viewport) || viewport <= 0) return placed + delta;
  const extent = Number.isFinite(size) && size > 0 ? size : 0;
  const max = viewport - extent - DEFAULT_MARGIN;
  if (max <= DEFAULT_MARGIN) return DEFAULT_MARGIN;
  return Math.min(Math.max(placed + delta, DEFAULT_MARGIN), max);
}

/**
 * THE ONE POP-UP SHELL — every popover/dialog in the app renders through this.
 *
 * The maintainer, repeatedly: pop-ups keep drifting because each surface built
 * its own. There used to be THREE floating-panel implementations — the board's
 * `BoardPopover`, a line-for-line clone `AdminPopover`, and a hand-rolled
 * `RecordPopover` that quietly lacked a focus trap and Escape-to-close. This is
 * their single successor: a portal-rendered `role="dialog"` that is
 * focus-trapped, dismissed on Escape and outside-pointerdown, positioned by
 * `resolvePopoverPlacement`, and measured from its own rendered box. It lives in
 * `src/components/` (the shared home, beside `icons.tsx`/`PanelToggle.tsx`) so
 * both features use ONE implementation and ONE stylesheet; `BoardPopover` and
 * `AdminPopover` are now thin aliases of it. `src/test/popoverStandard.test.ts`
 * fails the build if any component hand-rolls a floating dialog instead of using
 * this, so a fourth one can't appear.
 *
 * The measurement/placement mechanics below are the hard-won board version
 * (design plan §19.10/§19.11), carried verbatim:
 *   - CSS owns the width (`.pop` in the module); no `width` prop — an inline
 *     width used to outrank the CSS so the popover never scaled. The one
 *     variant, `variant="wide"`, is a second class in the same module (`.wide`),
 *     for a dialog that lays two candidates side by side (Copy Week, R-339);
 *     the width still lives in CSS and still scales through the root size.
 *   - `useLayoutEffect` + `getBoundingClientRect()` measures the RENDERED box and
 *     feeds one `{width,height}` into `resolvePopoverPlacement` (no probe).
 *   - The viewport is STATE behind a `window` resize listener, not a
 *     `ResizeObserver` alone: `--chrome-scale` is pinned flat at 1.0 for
 *     viewports <=1440px, so the observer never fires there and a captured
 *     `innerWidth` would go stale.
 *   - Both effects carry a change-guard or they re-render forever (§19.6).
 *
 * DRAGGING (R-344). The maintainer: "The pop window cannot be moved across the
 * screen to see what's underneath, can we be able to move stuff?" A pop-up
 * covers the very cells the person needs to read while answering it, so the
 * title is now a drag handle: pointerdown on the h3 captures the pointer,
 * pointermove adds the travelled delta, pointerup/pointercancel release. Since
 * every pop-up in the app IS this shell, that one handle moves all of them.
 *
 * What is kept is an OFFSET from the computed placement, never an absolute
 * position, and that is the whole trick:
 *   - the placement above still decides where a pop-up opens, so a new pop-up
 *     appears where its anchor says and not where the last one was left. The
 *     offset is zeroed whenever the anchor moves.
 *   - the offset is re-clamped against the measured box and the viewport state
 *     on every render, by the same margin rule `resolvePopoverPlacement` uses,
 *     so a drag cannot push the box off screen and a resize cannot strand it
 *     there afterwards.
 *   - a press with no movement adds a delta of zero, so a click on the title
 *     changes nothing. Only the h3 is the handle, so no control inside the
 *     pop-up is ever mistaken for it, and Escape / the focus trap / the
 *     outside-pointerdown dismissal are untouched (the handle is inside the
 *     box, so the outside listener never sees it).
 */
export function Popover({
  anchor,
  onClose,
  title,
  children,
  variant,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** `"wide"` for a dialog that sets two things side by side; default is the one 17rem shell. */
  variant?: "wide";
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    function onPointerDown(e: PointerEvent) {
      if (el && !el.contains(e.target as Node)) onClose();
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    function measure() {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
    }

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    function onResize() {
      setViewport((prev) =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight },
      );
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** How far the person has dragged the box from where the placement put it. */
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  // A new anchor is a new pop-up (or the same one re-aimed): it opens where the
  // anchor says, never where the last one was dragged. Change-guarded like the
  // effects above, or a no-op reset re-renders forever.
  useEffect(() => {
    dragRef.current = null;
    setDragging(false);
    setDragOffset((prev) => (prev.x === 0 && prev.y === 0 ? prev : { x: 0, y: 0 }));
  }, [anchor.x, anchor.y]);

  const placed = resolvePopoverPlacement({
    anchorX: anchor.x,
    anchorY: anchor.y,
    width: size.width,
    height: size.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });

  function onHandlePointerDown(e: React.PointerEvent<HTMLHeadingElement>) {
    // Left button only for a mouse; a touch or a pen reports button 0 anyway.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: dragOffset.x,
      baseY: dragOffset.y,
    };
    setDragging(true);
    // Capture so the drag survives the pointer leaving the small title strip.
    // jsdom has no pointer capture, hence the guard rather than a bare call.
    const handle = e.currentTarget;
    if (typeof handle.setPointerCapture === "function") handle.setPointerCapture(e.pointerId);
  }

  function onHandlePointerMove(e: React.PointerEvent<HTMLHeadingElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // The STORED offset is clamped, not only the drawn one. The first draft
    // stored the raw travel and clamped at render, so a box shoved 900px past
    // the left edge sat at the margin holding -900, and dragging it back did
    // nothing until the overshoot had been dragged back through (the
    // reviewer's finding, session 77). Clamping here keeps offset and box
    // together: the next move starts from where the box actually is.
    const next = {
      x:
        clampDraggedAxis(
          placed.left,
          drag.baseX + (e.clientX - drag.startX),
          size.width,
          viewport.width,
        ) - placed.left,
      y:
        clampDraggedAxis(
          placed.top,
          drag.baseY + (e.clientY - drag.startY),
          size.height,
          viewport.height,
        ) - placed.top,
    };
    setDragOffset((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  }

  function onHandlePointerUp(e: React.PointerEvent<HTMLHeadingElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const handle = e.currentTarget;
    if (
      typeof handle.hasPointerCapture === "function" &&
      handle.hasPointerCapture(e.pointerId) &&
      typeof handle.releasePointerCapture === "function"
    ) {
      handle.releasePointerCapture(e.pointerId);
    }
  }

  const left = clampDraggedAxis(placed.left, dragOffset.x, size.width, viewport.width);
  const top = clampDraggedAxis(placed.top, dragOffset.y, size.height, viewport.height);

  const node = (
    <div
      ref={ref}
      className={variant === "wide" ? `${styles.pop} ${styles.wide}` : styles.pop}
      style={{ left, top }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <h3
        className={dragging ? `${styles.h3} ${styles.dragging}` : styles.h3}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
      >
        {title}
      </h3>
      {children}
    </div>
  );

  return createPortal(node, document.body);
}
