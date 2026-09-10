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
  title = "Continue?",
  choices,
  onChoose,
}: {
  message: string;
  anchor: { x: number; y: number };
  onConfirm: () => void;
  onCancel: () => void;
  /** R-031: the heading; the crew and attachment prompts keep "Continue?". */
  title?: string;
  /**
   * R-031: when given, these buttons stand where Continue would, one each,
   * none of them primary — "keep or scale?" has no default answer, so no
   * button is dressed as the expected one. Cancel is always first.
   */
  choices?: readonly { label: string }[];
  onChoose?: (index: number) => void;
}) {
  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title={title}>
      <div className={styles.body}>
        <p className={styles.message}>{message}</p>
        <div className={styles.row}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          {choices === undefined ? (
            <button type="button" className={styles.pri} onClick={onConfirm}>
              Continue
            </button>
          ) : (
            choices.map((c, i) => (
              <button key={c.label} type="button" onClick={() => onChoose?.(i)}>
                {c.label}
              </button>
            ))
          )}
        </div>
      </div>
    </BoardPopover>
  );
}
