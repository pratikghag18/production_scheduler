import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolvePopoverPlacement } from "@/lib/placement";
import styles from "./Popover.module.css";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
 *     width used to outrank the CSS so the popover never scaled.
 *   - `useLayoutEffect` + `getBoundingClientRect()` measures the RENDERED box and
 *     feeds one `{width,height}` into `resolvePopoverPlacement` (no probe).
 *   - The viewport is STATE behind a `window` resize listener, not a
 *     `ResizeObserver` alone: `--chrome-scale` is pinned flat at 1.0 for
 *     viewports <=1440px, so the observer never fires there and a captured
 *     `innerWidth` would go stale.
 *   - Both effects carry a change-guard or they re-render forever (§19.6).
 */
export function Popover({
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
