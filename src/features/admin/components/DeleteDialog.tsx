/**
 * The delete confirmation, shared by every admin list (migration 0029, D110).
 *
 * The maintainer, 28 August: *"we give a warning to the user that all the corresponding
 * data will be deleted and encourage them deactivate to retain the data
 * instead. This will be handled by site admin so it their call in the end."*
 *
 * Three things that are decisions and not styling:
 *
 * ⭐ 1. IT ASKS THE SERVER BEFORE IT ASKS THE PERSON. The counts come from
 * `deletion_preview`, so the dialog cannot be confidently wrong about what is
 * at stake. Until the answer arrives it says so and BOTH destructive buttons
 * stay disabled — a confirmation that can be clicked through before it knows
 * what it is confirming is worse than no confirmation, because it looks like
 * one.
 *
 * ⭐ 2. "DEACTIVATE INSTEAD" IS THE PRIMARY ACTION ONLY WHEN SOMETHING IS
 * ACTUALLY AT RISK (`summariseDeletion`'s three stakes). Pushing it every time
 * — including for a part nothing has ever been scheduled against — is how a
 * warning becomes something people learn to click past, and then the one that
 * matters gets clicked past too.
 *
 * ⭐ 3. THE CONFIRM BUTTON NAMES WHAT IT DESTROYS (D106). The screen this
 * replaces said "Delete for good?" whether the answer was "nothing happens" or
 * "eleven jobs disappear". A control may not be named after less than it does.
 *
 * ⚠️ AND IT REPORTS FROM THE RESULT, NOT FROM THE PREVIEW. `delete_owned_row`
 * returns what actually happened; between the preview and the press somebody
 * may have scheduled a job. `describeDeletionResult` is fed the answer, never
 * the prediction.
 */
import {
  confirmLabel,
  describeDeletionResult,
  kindLabel,
  summariseDeletion,
} from "../lib/deletion";
import { useDeleteOwnedRow, useDeletionPreview } from "../hooks/useDeletion";
import { describeSchedulerError, type DeletableKind, type SchedulerError } from "@/lib/api";
import styles from "./DeleteDialog.module.css";

export interface DeleteDialogProps {
  kind: DeletableKind;
  /** The row being deleted. The dialog re-asks the server for its own copy. */
  id: string;
  /** Shown while the counts are still loading, so the box is never anonymous. */
  name: string;
  /** Omit to hide the Deactivate button — for a kind with no such control yet. */
  onDeactivate?: () => void;
  /** Already inactive: "Deactivate instead" is not on offer, it is done. */
  alreadyInactive?: boolean;
  onCancel: () => void;
  /** Called with a plain-language sentence built from what actually happened. */
  onDeleted: (message: string) => void;
  onFailed: (message: string) => void;
}

export function DeleteDialog({
  kind,
  id,
  name,
  onDeactivate,
  alreadyInactive = false,
  onCancel,
  onDeleted,
  onFailed,
}: DeleteDialogProps) {
  const preview = useDeletionPreview(kind, id);
  const mutation = useDeleteOwnedRow();
  const label = kindLabel(kind);

  const summary = preview.data === undefined ? null : summariseDeletion(preview.data);
  const busy = preview.isPending || mutation.isPending;

  function doDelete() {
    mutation.mutate(
      { kind, id },
      {
        onSuccess: (result) => onDeleted(describeDeletionResult(result)),
        onError: (err: SchedulerError) => onFailed(describeSchedulerError(err)),
      },
    );
  }

  return (
    <div className={styles.box} role="group" aria-label={`Delete ${name}`}>
      <p className={styles.headline}>
        {summary === null
          ? `Checking what deleting ${label.article} would affect…`
          : summary.headline}
      </p>

      {preview.isError && (
        <p className={styles.error} role="alert">
          {describeSchedulerError(preview.error)} Nothing has been deleted.
        </p>
      )}

      {summary !== null && summary.removed.length > 0 && (
        <div className={styles.list}>
          <p className={styles.listHead}>Gone for good:</p>
          <ul>
            {summary.removed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {summary !== null && summary.kept.length > 0 && (
        <div className={styles.list}>
          {/* Work that has already started keeps its record of this row, under
              the code and name it has right now — which is the whole of D110
              and the sentence most people will actually read. */}
          <p className={styles.listHead}>Already started, and staying on the board:</p>
          <ul>
            {summary.kept.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.actions}>
        {onDeactivate !== undefined && !alreadyInactive && (
          <button
            type="button"
            className={summary?.preferDeactivate === true ? styles.primary : styles.quiet}
            onClick={onDeactivate}
            disabled={mutation.isPending}
          >
            Deactivate instead
          </button>
        )}
        <button
          type="button"
          className={styles.danger}
          onClick={doDelete}
          // Disabled until the server has answered: see note 1 in the header.
          disabled={busy || summary === null}
        >
          {summary === null ? "Delete" : confirmLabel(summary)}
        </button>
        <button
          type="button"
          className={styles.quiet}
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export const DELETE_DIALOG_READY = true;
