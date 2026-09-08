import { useState } from "react";
import { saveWeekTemplate, describeSchedulerError, isSchedulerError } from "@/lib/api";
import fieldStyles from "@/components/Field.module.css";
import { useSchedulerToast } from "../hooks/useSchedulerToast";
import { BoardPopover } from "./BoardPopover";
import styles from "./SaveTemplateDialog.module.css";

/**
 * "Save this week as a template" (R-356). A name, and the board's current
 * window start as the week to snapshot. The server (`save_week_template`)
 * snapshots the week through the SAME reads Copy Week uses, so a template can
 * never disagree with the week it was saved from; it is gated on placing, the
 * same right the toolbar offered this control on.
 *
 * ⚠️ No error is swallowed: a refusal (a duplicate name, a plant the caller
 * cannot place on) shows in the dialog, and it stays open to try again.
 */
export function SaveTemplateDialog({
  plantId,
  plantName,
  windowStart,
  anchor,
  onClose,
}: {
  plantId: string;
  plantName: string;
  /** The board window's first day, midnight UTC: the week saved. */
  windowStart: Date;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const toast = useSchedulerToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveWeekTemplate({ plantId, sourceStart: windowStart, name: trimmed });
      toast.info(
        `Saved “${saved.name}” — ${saved.runs} ${saved.runs === 1 ? "run" : "runs"} and ${
          saved.assignments
        } ${
          saved.assignments === 1 ? "assignment" : "assignments"
        }. It is on this plant's template list now, applied from this toolbar with “Apply a template”.`,
      );
      onClose();
    } catch (err) {
      setError(describeSaveError(err));
      setSaving(false);
    }
  }

  return (
    <BoardPopover anchor={anchor} onClose={onClose} title="Save this week as a template">
      <div className={styles.body}>
        <p className={styles.plant}>{plantName}</p>
        <label htmlFor="st-name" className={styles.label}>
          Template name
        </label>
        <input
          id="st-name"
          type="text"
          className={fieldStyles.field}
          value={name}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.row}>
          <button type="button" className={fieldStyles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={fieldStyles.primaryBtn}
            disabled={name.trim() === "" || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}

/** A refusal, in the words of what was asked. */
export function describeSaveError(err: unknown): string {
  if (!isSchedulerError(err)) return "Something went wrong. Please try again.";
  if (err.kind === "InvalidArgument") {
    switch (err.reason) {
      case "duplicate_name":
        return "A template with that name already exists for this plant. Please pick another name.";
      case "blank_name":
        return "A template needs a name.";
      case "not_a_plant":
        return "A template is saved for a whole plant, and the board is not showing one.";
      default:
        return describeSchedulerError(err);
    }
  }
  if (err.kind === "NotPermitted") {
    return "You cannot save a template for this plant.";
  }
  return describeSchedulerError(err);
}
