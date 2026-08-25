import { useState, type ReactNode } from "react";
import { describeSchedulerError } from "@/lib/api";
import {
  useCreateHierarchyTemplate,
  useDeleteHierarchyTemplate,
  useRenameHierarchyTemplate,
} from "../hooks/useHierarchyMutations";
import { validateShapeName, type ShapeSummary } from "../lib/shapePicker";
import { AdminPopover } from "./AdminPopover";
import styles from "./ShapePicker.module.css";

/**
 * The shape picker (D87 / brief P1-5f §7.3). A card above `LevelEditor`
 * that lets an admin choose which hierarchy shape they are editing,
 * create/rename/delete shapes, and (via `onSelect`) tell `AdminPage` which
 * shape is selected -- `AdminPage` is the one place that owns the
 * selection and resolves it through `resolveSelectedShape` (§7.6), so this
 * component only ever reports a choice, it never invents a fallback.
 *
 * `summaries` is `buildShapeSummaries`'s own output (`../lib/shapePicker`,
 * Part A(ii)) -- computed once in `AdminPage` and passed down here, to
 * `LevelEditor` and to `NodeTreeEditor`, so the three screens can never
 * compute three different answers to "what does shape X look like".
 *
 * Every VALIDATION shown here (blank/duplicate name, hasNodes) is a
 * PREVIEW -- `validateShapeName` and `ShapeSummary.hasNodes` never enforce
 * anything themselves (`shapePicker.ts`'s own file header). Every actual
 * server failure is rendered through `describeSchedulerError` -- this file
 * does not define a second error-message map (P1-5d's `errorText.ts`
 * duplicated `describeSchedulerError` for all six D74 codes and shipped
 * with no live caller; the fix here is to not repeat that).
 */
export function ShapePicker({
  summaries,
  selectedId,
  onSelect,
  children,
}: {
  summaries: readonly ShapeSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * D90b (design plan §19.24): the level editor renders INSIDE this card.
   *
   * The two were laid out as peer cards while being parent and child — the
   * level list only ever edits whichever structure is selected here, and
   * nothing on screen said so. Passing it as a child makes the coupling
   * structural instead of something an admin has to infer by clicking.
   *
   * NOTE the file is still `ShapePicker.tsx` while the section now reads
   * "Site Structure": renaming a file needs a delete this session cannot
   * perform, and a stray dead module is worse than a stale filename. Recorded
   * here rather than left as a surprise.
   */
  children?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamePopover, setRenamePopover] = useState<{ anchor: { x: number; y: number } } | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");

  const createMutation = useCreateHierarchyTemplate();
  const renameMutation = useRenameHierarchyTemplate();
  const deleteMutation = useDeleteHierarchyTemplate();

  const selected = summaries.find((s) => s.id === selectedId) ?? null;

  const createValidation = validateShapeName(newName, summaries, null);
  const renameValidation = validateShapeName(renameValue, summaries, selectedId);

  function summaryLine(s: ShapeSummary): string {
    return s.levelCount === 0 ? "no levels yet" : s.levelNames.join(" › ");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createValidation.ok) return;
    createMutation.mutate(newName, {
      // Land the admin in the empty editor they now need to fill (§7.3).
      onSuccess: (created) => {
        setNewName("");
        setCreating(false);
        onSelect(created.id);
      },
    });
  }

  function openRename(e: React.MouseEvent<HTMLButtonElement>) {
    if (!selected) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setRenameValue(selected.name);
    renameMutation.reset();
    setRenamePopover({ anchor: { x: rect.left, y: rect.bottom } });
  }

  function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !renameValidation.ok) return;
    renameMutation.mutate(
      { templateId: selected.id, name: renameValue },
      { onSuccess: () => setRenamePopover(null) },
    );
  }

  function handleDelete() {
    if (!selected || selected.hasNodes || deleteMutation.isPending) return;
    deleteMutation.mutate(selected.id);
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.h2}>Site Structure</h2>

      {summaries.length === 0 && <p className={styles.emptyLine}>No site structures yet.</p>}

      {summaries.length > 2 ? (
        <select
          className={styles.select}
          aria-label="Site structure"
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value)}
        >
          {summaries.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {summaryLine(s)}
            </option>
          ))}
        </select>
      ) : (
        summaries.length > 0 && (
          <div className={styles.radioGroup} role="radiogroup" aria-label="Site structure">
            {summaries.map((s) => (
              <label key={s.id} className={styles.radioRow}>
                <input
                  type="radio"
                  name="shape-picker"
                  checked={s.id === selectedId}
                  onChange={() => onSelect(s.id)}
                />
                <span>
                  <strong>{s.name}</strong>
                  <span className={styles.secondary}> — {summaryLine(s)}</span>
                </span>
              </label>
            ))}
          </div>
        )
      )}

      <div className={styles.actions}>
        {selected && (
          <button type="button" className={styles.smallBtn} onClick={openRename}>
            Rename
          </button>
        )}
        {selected && (
          <button
            type="button"
            className={styles.smallBtn}
            disabled={selected.hasNodes || deleteMutation.isPending}
            title={selected.hasNodes ? "This structure still has nodes on it." : undefined}
            onClick={handleDelete}
          >
            Delete
          </button>
        )}
        <button type="button" className={styles.smallBtn} onClick={() => setCreating((v) => !v)}>
          + new structure
        </button>
      </div>

      {creating && (
        <form className={styles.createForm} onSubmit={handleCreate}>
          <input
            autoFocus
            type="text"
            value={newName}
            placeholder="Structure name"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!createValidation.ok || createMutation.isPending}>
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
          {!createValidation.ok && newName !== "" && (
            <p className={styles.errorLine} role="alert">
              {createValidation.reason === "blank_name"
                ? "Name can't be blank."
                : "A structure with this name already exists."}
            </p>
          )}
          {createMutation.isError && (
            <p className={styles.errorLine} role="alert">
              {describeSchedulerError(createMutation.error)}
            </p>
          )}
        </form>
      )}

      {deleteMutation.isError && (
        <p className={styles.errorLine} role="alert">
          {describeSchedulerError(deleteMutation.error)}
        </p>
      )}

      {renamePopover && selected && (
        <AdminPopover
          anchor={renamePopover.anchor}
          onClose={() => setRenamePopover(null)}
          title={`Rename "${selected.name}"`}
        >
          <form onSubmit={handleRenameSubmit}>
            <input
              autoFocus
              type="text"
              className={styles.popInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            <div className={styles.popActions}>
              <button type="button" onClick={() => setRenamePopover(null)}>
                Cancel
              </button>
              <button type="submit" disabled={!renameValidation.ok || renameMutation.isPending}>
                Rename
              </button>
            </div>
            {!renameValidation.ok && (
              <p className={styles.errorLine} role="alert">
                {renameValidation.reason === "blank_name"
                  ? "Name can't be blank."
                  : "A structure with this name already exists."}
              </p>
            )}
            {renameMutation.isError && (
              <p className={styles.errorLine} role="alert">
                {describeSchedulerError(renameMutation.error)}
              </p>
            )}
          </form>
        </AdminPopover>
      )}
      {children !== undefined && <div className={styles.embedded}>{children}</div>}
    </section>
  );
}
