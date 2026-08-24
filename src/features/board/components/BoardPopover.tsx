import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
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
 */
export function BoardPopover({
  anchor,
  onClose,
  title,
  children,
  width = 272,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
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

  // Clamp on-screen, mirroring the mockup's `placePop`.
  const hMax = 420;
  const left =
    typeof window === "undefined" ? anchor.x : Math.min(anchor.x, window.innerWidth - width - 10);
  const top =
    typeof window === "undefined"
      ? anchor.y + 8
      : Math.min(anchor.y + 8, window.innerHeight - hMax);

  const node = (
    <div
      ref={ref}
      className={styles.pop}
      style={{ left, top, width }}
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
