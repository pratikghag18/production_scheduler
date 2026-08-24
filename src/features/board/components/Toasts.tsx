import { useDismissToast, useToasts } from "../hooks/useSchedulerToast";
import styles from "./Toasts.module.css";

/**
 * Port of the mockup's `#toasts` stack. One instance, mounted once by
 * `BoardPage` — every `useSchedulerToast()` call site anywhere in the
 * feature pushes into the same store (see the hook's file header).
 */
export function Toasts() {
  const toasts = useToasts();
  const dismiss = useDismissToast();

  if (toasts.length === 0) return null;

  return (
    <div className={styles.toasts} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.kind === "warn" ? styles.warn : ""} ${t.kind === "crit" ? styles.crit : ""}`}
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
