import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// DELIBERATE CONVENTION BREACH -- see agent report §11 item 6 and the
// header comment below for the full reasoning; §7.4 names this collision
// on purpose and asks for a recorded decision, not a silent workaround.
import { resolvePopoverPlacement } from "@/lib/placement";
import styles from "./AdminPopover.module.css";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The admin feature's own popover shell (brief P1-5d §7.4): the Move-to
 * picker, the delete confirm, and the rename field all render inside this.
 *
 * `docs/conventions.md` forbids cross-feature imports (only
 * `src/features/auth/` is a named exception), so this is a NEW component,
 * not an import of `src/features/board/components/BoardPopover.tsx` --
 * "reuse the mechanism, not the file" (brief §7.4, explicit). Every effect
 * below is that mechanism, carried over line for line from `BoardPopover`
 * because the fix it encodes is non-obvious and was hard-won (design plan
 * §19.10/§19.11):
 *   - CSS owns the width (`.pop` in the module below); no `width` prop --
 *     an inline style used to default to 272 and outrank the CSS, so the
 *     popover never actually scaled with `--chrome-scale`.
 *   - `useLayoutEffect` + `getBoundingClientRect()` measures the RENDERED
 *     box itself and feeds that one measured `{width, height}` into
 *     `resolvePopoverPlacement` -- no second "probe" element, since this
 *     element already IS the thing with the width.
 *   - The viewport is STATE behind a `window` `resize` listener, not a
 *     `ResizeObserver` alone: `--chrome-scale` is
 *     `clamp(1, 0.75 + 0.25 * (100vw / 1440px), 1.35)` (src/styles/global.css)
 *     and is PINNED FLAT AT 1.0 for every viewport <=1440px, so on an
 *     ordinary laptop a `ResizeObserver` on this element never fires and
 *     `window.innerWidth` read at the last render goes stale.
 *   - Both effects carry a change-guard (`setState` only when the measured
 *     numbers actually differ) or they re-render forever -- the same
 *     family of bug as design-plan §19.6's fit-loop oscillation.
 *
 * THE ONE PIECE NOT DUPLICATED: `resolvePopoverPlacement` itself (pure
 * geometry, `src/lib/placement.ts`) is imported directly
 * from `board/lib`, breaching the no-cross-feature-import convention on
 * purpose. The alternative -- copying the function's ~30 lines here -- was
 * rejected: `placement.ts` had one non-obvious, previously-shipped bug
 * (design plan §19.11's NaN-anchor fix) already found by exactly the kind
 * of mutation testing this brief also runs, and a duplicate copy is a
 * second place that fix silently does not apply to the next time it needs
 * one. §5's own ethos -- "one implementation ... and it will shortly have
 * three consumers" -- runs the same direction: an import is one line, is
 * trivially greppable, and is the honest signal that a `src/lib/`
 * promotion (the brief's own suggested third option) is now overdue. That
 * promotion is NOT done here: §12's scope fence forbids any change to
 * `src/features/board/`, and moving the file out of it is exactly such a
 * change (`device_bash` also cannot move/delete files, which would make it
 * impossible even without the fence). Flagged for a future brief.
 */
export function AdminPopover({
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
