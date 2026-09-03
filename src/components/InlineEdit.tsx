import { useRef, useState, type ReactNode } from "react";
import styles from "./Field.module.css";

/**
 * THE ONE EDIT-IN-PLACE CONTROL (R-318).
 *
 * The maintainer, 3 Sept, on the cycle-times grid, in three parts:
 *   *"instead of showing dashes, what if show editable boxes?"*
 *   *"do they have indentations because only they can be edited? Doesn't
 *    visibly look good."*
 *   *"if I open a box to enter a value and don't want to enter it anymore,
 *    there is no way to close the box."*
 *
 * All three are answered here rather than in one screen's stylesheet, because
 * the fourth thing they said was *"we should make the editable boxes a standard
 * for the app"* — and a standard that lives in the screen that prompted it is
 * not a standard. This is the same move as `Popover.tsx` (R-313), one layer
 * down: there the shared thing was the pop-up shell, here it is the field.
 *
 * ⭐ A RESTING CELL IS A BOX, NOT A DASH. An empty editable cell renders as an
 * empty box, so it reads as somewhere to type. A dash reads as missing data,
 * and worse, it read as DIFFERENT data from the dash in the read-only cell
 * beside it while looking identical.
 *
 * ⭐ THE RESTING BOX AND THE OPEN BOX ARE THE SAME SIZE. Both compose `.field`,
 * so a cell does not jump when it opens and a column of editable cells does not
 * sit indented against read-only ones. That indentation was real: the old code
 * gave the editable cell a padded button and the read-only cell a bare span.
 *
 * ⭐ THERE IS ALWAYS A WAY OUT, AND IT IS VISIBLE. Escape works, but Escape is
 * not an affordance — nothing on screen said so. Cancel is a button, next to
 * Save, always. Clicking away deliberately does NOT commit or close: with an
 * adornment beside the input (a unit select, say) a blur-to-close would fire on
 * the way to the very control the user was reaching for.
 */
export function InlineEdit({
  value,
  editValue,
  ariaLabel,
  placeholder = "",
  emptyLabel = "",
  disabled = false,
  title,
  inputMode = "decimal",
  adornment,
  error = null,
  onOpen,
  onSave,
  onCancel,
}: {
  /** The resting text. `""` means empty, and renders as an inviting box. */
  value: string;
  /**
   * What the box contains when opened, when that differs from what it shows at
   * rest. Defaults to `value`.
   *
   * ⚠️ THEY DIFFER WHENEVER THE RESTING TEXT CARRIES A UNIT. A cell reading
   * "1.5 min" beside a unit select already showing "min" must open with "1.5"
   * in the box, not "1.5 min" — otherwise the unit is stated twice, and the
   * obvious edit (clear it, type a number) silently reinterprets the number in
   * whatever the select happens to say.
   */
  editValue?: string;
  ariaLabel: string;
  placeholder?: string;
  /**
   * What an empty resting box says. Empty by default, and that is deliberate:
   * across a grid of mostly-unset cells, a word repeated in every box reads as
   * clutter, while an empty box reads as somewhere to type. The accessible name
   * comes from `ariaLabel` either way, so a blank box is never a nameless one.
   */
  emptyLabel?: string;
  disabled?: boolean;
  title?: string;
  inputMode?: "decimal" | "numeric" | "text";
  /** Rendered between the input and the buttons — e.g. a unit select. Its own
   *  state belongs to the caller, which is why this is a node and not a prop
   *  bag: the editor does not need to know what a unit is. */
  adornment?: ReactNode;
  /** Shown under the editor. The caller owns it, since only the caller knows
   *  whether the last save was refused. */
  error?: string | null;
  /** Fired as the editor opens, so the caller can seed any adornment state
   *  (the unit a stored value is best displayed in, for instance). */
  onOpen?: () => void;
  onSave: (draft: string) => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function begin() {
    setDraft(editValue ?? value);
    setOpen(true);
    onOpen?.();
  }

  function cancel() {
    setOpen(false);
    setDraft("");
    onCancel?.();
  }

  function save() {
    setOpen(false);
    onSave(draft);
  }

  if (!open) {
    return (
      <>
        <button
          type="button"
          className={`${styles.resting} ${value === "" ? styles.restingEmpty : ""}`}
          disabled={disabled}
          title={title}
          aria-label={ariaLabel}
          onClick={begin}
        >
          {value === "" ? emptyLabel : value}
        </button>
        {error !== null && <p className={styles.error}>{error}</p>}
      </>
    );
  }

  return (
    <>
      <div className={styles.editor}>
        <input
          ref={inputRef}
          className={styles.editorInput}
          type="text"
          inputMode={inputMode}
          autoFocus
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
        {adornment}
        <button type="button" className={styles.primaryBtn} onClick={save}>
          Save
        </button>
        {/* Always present. Escape does the same thing, but a keystroke nobody
            can see is not a way out — which is what was reported. */}
        <button type="button" className={styles.btn} onClick={cancel}>
          Cancel
        </button>
      </div>
      {error !== null && <p className={styles.error}>{error}</p>}
    </>
  );
}
