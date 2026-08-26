import { useState } from "react";
import { describeSchedulerError, type BoardNode, type HierarchyLevel } from "@/lib/api";
import { useSaveHierarchyLevels } from "../hooks/useHierarchyMutations";
import {
  applyLevelAction,
  findLevelOrderProblems,
  invalidNameIndices,
  MAX_LEVELS,
} from "../lib/levelDraft";
import type { LevelDraft, LevelOrderProblem } from "../lib/levelDraft";
import { validateLevelDraft } from "../lib/hierarchy";
import { levelsForShape } from "../lib/shapePicker";
import styles from "./LevelEditor.module.css";

/**
 * The level vocabulary editor (brief P1-5d §7.2). An ordered list over
 * `LevelDraft[]` local state, one row per level -- name input, ↑/↓, a
 * radio for schedulable, `×` to remove; `+ add level` below. Visual
 * reference: the mockup's `#shiftModal` (local draft, inline `×`/`+ add`
 * rows, one error line, Cancel/Save).
 *
 * Save is disabled while `validateLevelDraft` (P1-5b, the authority on
 * WHETHER the draft is valid) is not ok; `invalidNameIndices` (this
 * brief's own pure module) says WHERE to put the error styling. Save can
 * still fail server-side on things no client check can see -- level_in_use,
 * schedulable_level_locked (§5) -- surfaced inline via `describeSchedulerError`
 * without discarding the draft.
 */

function toDraft(levels: readonly HierarchyLevel[]): LevelDraft[] {
  return levels.map((l) => ({ id: l.id, name: l.name, isSchedulable: l.isSchedulable }));
}

const PREVIEW_REASON_TEXT: Record<string, string> = {
  not_an_array: "Something went wrong with this form. Reload the page and try again.",
  empty: "There must be at least one level.",
  too_many: `There can be at most ${MAX_LEVELS} levels.`,
  schedulable_count: "Exactly one level must be marked schedulable — pick one below.",
  blank_name: "Every level needs a name.",
};

/**
 * D92's refusal, said in the editor instead of on the round trip (§19.30).
 * Every sentence describes the RESULT of saving this order, never a rule about
 * which row may move -- the arrows stay live precisely so a structure already
 * scrambled by a pre-0016 save can be dragged back into shape.
 */
function orderProblemText(problem: LevelOrderProblem): string {
  const many = problem.nodeCount !== 1;
  const count = many ? `${problem.nodeCount} nodes` : "1 node";
  const them = many ? "them" : "it";
  switch (problem.kind) {
    case "level_removed_with_nodes":
      return `Removing \u201C${problem.levelName}\u201D would leave ${count} with no level to sit on.`;
    case "root_below_first_level":
      return `${count} on \u201C${problem.levelName}\u201D ${many ? "have" : "has"} no parent, and this order would leave ${them} below the first level.`;
    case "child_not_directly_below_parent":
      return `${count} on \u201C${problem.levelName}\u201D would no longer sit directly under ${many ? "their" : "its"} parent.`;
    default: {
      const _exhaustive: never = problem.kind;
      return _exhaustive;
    }
  }
}

/**
 * D87 (brief P1-5f §7.4): which shape this editor edits is now the SHAPE
 * PICKER's decision, not something this component infers. `templateId` is
 * a required prop -- `null` means no shape is selected yet (an org with no
 * templates at all), and Save stays disabled while it is. This replaces
 * D86's `soleTemplateId` fail-closed guess, which is exactly the thing the
 * shape picker exists to remove: silently editing `levels[0]`'s template
 * was the same guess the RPC was deliberately built to reject.
 */
export function LevelEditor({
  levels,
  nodes,
  templateId,
}: {
  levels: HierarchyLevel[];
  /**
   * D92's client mirror needs to know where the existing nodes sit (§19.30).
   * This editor has no other use for them -- it does not render a single node --
   * but the question "would this order strand anything" cannot be answered
   * without them, and `AdminPage` already holds the list for the tree editor.
   * The COMPLETE org list, not filtered by template: `findLevelOrderProblems`
   * does its own template scoping, exactly as the RPC does.
   */
  nodes: BoardNode[];
  templateId: string | null;
}) {
  const [draft, setDraft] = useState<readonly LevelDraft[]>(() =>
    toDraft(levelsForShape(levels, templateId)),
  );
  const saveMutation = useSaveHierarchyLevels();

  // hierarchy.ts's `validateLevelDraft` predates this editor's readonly
  // state convention and takes a mutable `LevelDraft[]`; it never mutates
  // its argument (P1-5b), so this cast is safe -- same call-site-cast
  // shape as `createNode`/`moveNode`'s documented nullability casts.
  const validation = validateLevelDraft(draft as LevelDraft[]);
  const invalidIndices = new Set(invalidNameIndices(draft));
  // Mirrors what `save_hierarchy_levels` would say about this exact order
  // (migration 0016 + its older check 7). NOT a rule about which rows may move.
  const orderProblems = findLevelOrderProblems(draft, levels, nodes, templateId);

  function handleCancel() {
    setDraft(toDraft(levelsForShape(levels, templateId)));
    saveMutation.reset();
  }

  function handleSave() {
    if (templateId === null) return;
    saveMutation.mutate(
      {
        levels: draft.map((d) => ({ id: d.id, name: d.name, isSchedulable: d.isSchedulable })),
        templateId,
      },
      {
        // The RPC's own response is the new server truth -- resync the
        // draft from IT, not from a refetch of the `levels` prop, so an
        // unrelated invalidation elsewhere (e.g. the tree editor moving a
        // node) can never race this editor's own just-saved state.
        onSuccess: (saved) => setDraft(toDraft(saved)),
      },
    );
  }

  return (
    // D90b: no card chrome of its own — this renders inside the Site Structure
    // card (see ShapePicker's `children`), so a second border here would draw a
    // box inside a box and re-suggest the very independence the merge removes.
    <div className={styles.embedded}>
      <div className={styles.sectionLabel}>Levels in this structure</div>
      <ol className={styles.list}>
        {draft.map((level, index) => {
          const isInvalid = invalidIndices.has(index);
          return (
            <li key={level.id ?? `new-${index}`} className={styles.row}>
              <div className={styles.moveCol}>
                <button
                  type="button"
                  className={styles.moveBtn}
                  disabled={index === 0}
                  aria-label={`Move ${level.name || "level"} up`}
                  onClick={() => setDraft((d) => applyLevelAction(d, { kind: "moveUp", index }))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.moveBtn}
                  disabled={index === draft.length - 1}
                  aria-label={`Move ${level.name || "level"} down`}
                  onClick={() => setDraft((d) => applyLevelAction(d, { kind: "moveDown", index }))}
                >
                  ↓
                </button>
              </div>

              <input
                type="text"
                className={isInvalid ? styles.nameInputInvalid : styles.nameInput}
                value={level.name}
                placeholder="Level name"
                aria-invalid={isInvalid}
                onChange={(e) =>
                  setDraft((d) =>
                    applyLevelAction(d, { kind: "rename", index, name: e.target.value }),
                  )
                }
              />

              <label className={styles.radioLabel}>
                <input
                  type="radio"
                  name="admin-schedulable-level"
                  checked={level.isSchedulable}
                  onChange={() =>
                    setDraft((d) => applyLevelAction(d, { kind: "setSchedulable", index }))
                  }
                />
                Schedulable
              </label>

              <button
                type="button"
                className={styles.removeBtn}
                aria-label={`Remove ${level.name || "level"}`}
                disabled={draft.length <= 1}
                onClick={() => setDraft((d) => applyLevelAction(d, { kind: "remove", index }))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className={styles.addBtn}
        disabled={draft.length >= MAX_LEVELS}
        onClick={() => setDraft((d) => applyLevelAction(d, { kind: "add" }))}
      >
        + add level
      </button>

      {!validation.ok && (
        <p className={styles.errorLine} role="alert">
          {PREVIEW_REASON_TEXT[validation.reason] ?? "This level list isn't valid yet."}
        </p>
      )}
      {orderProblems.length > 0 && (
        <div role="alert">
          <p className={styles.errorLine}>
            This order doesn't fit the structure that already exists:
          </p>
          <ul className={styles.problemList}>
            {orderProblems.map((problem) => (
              <li className={styles.problemItem} key={`${problem.kind}:${problem.levelId}`}>
                {orderProblemText(problem)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {saveMutation.isError && (
        <p className={styles.errorLine} role="alert">
          {describeSchedulerError(saveMutation.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancelBtn}
          onClick={handleCancel}
          disabled={saveMutation.isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.saveBtn}
          onClick={handleSave}
          disabled={
            !validation.ok ||
            templateId === null ||
            orderProblems.length > 0 ||
            saveMutation.isPending
          }
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
