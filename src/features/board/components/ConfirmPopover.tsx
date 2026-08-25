import { BoardPopover } from "./BoardPopover";
import styles from "./ConfirmPopover.module.css";

/**
 * §9 debt 2: the crew-outside-the-run-window warning as an in-app confirm
 * step, replacing `window.confirm` — "it cannot be styled or tested
 * through the DOM as it stands" (brief §9 item 2). Built on the same
 * `BoardPopover` shell as every other popover in this feature, so it is a
 * real, focus-trapped, Escape-dismissible dialog rather than a blocking
 * browser one.
 */
export function ConfirmPopover({
  message,
  anchor,
  onConfirm,
  onCancel,
}: {
  message: string;
  anchor: { x: number; y: number };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title="Continue?">
      <div className={styles.body}>
        <p className={styles.message}>{message}</p>
        <div className={styles.row}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={styles.pri} onClick={onConfirm}>
            Continue
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}
