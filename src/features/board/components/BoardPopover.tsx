import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolvePopoverPlacement } from "@/lib/placement";
import styles from "./BoardPopover.module.css";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Generic popover shell (brief §5.4): the mockup's `#pop`, ported as a
 * positioned, portal-rendered dialog — a portal (not a child of the
 * virtualized/scrolling track) so it is never clipped by an ancestor's
 * `overflow` and never scrolls away with the row that opened it, matching
 * the mockup's `#pop` being a body-level fixed element. Dismissed on
 * outside-click and Escape, focus-trapped, `role="dialog"`, first field
 * autofocused (§5.4/§8).
 *
 * Design plan §19.11 / brief P1-5c §4-§5: there is ONE source of truth for
 * this box's size — the rendered element itself, read back with
 * `getBoundingClientRect()`. No `width` prop (it used to default to 272 and
 * win over the CSS via an inline style that outranked it, so the popover
 * never actually scaled); no probe element (unlike `BoardGrid`'s
 * `railProbeRef`, the popover element already IS the thing with the width,
 * so a second element measuring a second token would just be a second
 * source of truth that could disagree with what's on screen).
 */
export function BoardPopover({
  anchor,
  onClose,
  title,
  children,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  title: string;
  children: React.ReactNode;
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

  // The one measured number, read from the box itself. Starts at {0, 0} --
  // the same "unmeasured" convention placement.ts's sanitizeSize already
  // treats as 0 (§4.1 rule 3), so the very first layout pass (before this
  // effect ever runs) clamps to the far edge rather than computing from a
  // width the box does not have yet.
  const [size, setSize] = useState({ width: 0, height: 0 });

  // useLayoutEffect (not useEffect): runs after DOM mutation and BEFORE
  // paint, so a corrected position from a freshly-measured size is never
  // painted wrong -- the popover cannot flash at the old position first.
  //
  // A ResizeObserver on the popover element itself -- not a window `resize`
  // listener -- is enough to catch BOTH its own content changing AND a
  // `--chrome-scale` change: `--chrome-scale` is a pure `clamp(...)` of
  // `100vw` (src/styles/global.css), so a viewport resize changes the
  // browser-computed value of `.pop`'s own `width: calc(272px *
  // var(--chrome-scale, 1))` -- which IS a resize of the observed element,
  // so the observer fires on its own -- but ONLY above 1440px, where the
  // clamp is not pinned. A separate `window` `resize` listener IS wired up
  // below, and the comment there explains why the observer is not enough.
  //
  // Trap (brief §10.1): this is the same family of bug as §19.6's fit-loop
  // oscillation -- an unconditional setState here on every observed frame
  // would re-render forever. The setter only replaces state when the
  // measured numbers actually differ (returning the previous object
  // otherwise, so React bails out via Object.is).
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

  // The viewport has to be STATE, not a value read during render.
  //
  // The original reasoning here was that a ResizeObserver on `.pop` alone
  // catches a viewport change, because `--chrome-scale` is a clamp() of
  // `100vw` and so a resize changes the box's own computed width. That is
  // true of the token's DEFINITION and false across the range this app
  // actually runs in: `clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35)` is
  // pinned FLAT AT 1.0 for every viewport <= 1440px. On any ordinary laptop,
  // resizing the window changes the popover's width by exactly nothing, the
  // observer never fires, and `window.innerWidth` captured at the last render
  // goes stale -- so a popover open near the right edge stays where it was
  // and ends up off screen. That is the precise failure this component was
  // just fixed to prevent. Verified by evaluating the clamp across
  // 800-3840px, not by reading it. Design-session verification, P1-5c.
  //
  // Same change-guard as `measure()` above, for the same reason.
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

  const { left, top } = resolvePopoverPlacement({
    anchorX: anchor.x,
    anchorY: anchor.y,
    width: size.width,
    height: size.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });

  const node = (
    <div
      ref={ref}
      className={styles.pop}
      style={{ left, top }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <h3 className={styles.h3}>{title}</h3>
      {children}
    </div>
  );

  return createPortal(node, document.body);
}
