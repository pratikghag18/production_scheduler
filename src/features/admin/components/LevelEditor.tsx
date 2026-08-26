import { useEffect, useRef, useState } from "react";
import { DRAG_THRESHOLD_PX } from "@/lib/interaction";
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
import { offsetInRow, passedThreshold, rowIsDragSource } from "../lib/dragPointer";
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

  // ---------------------------------------------------------------------------
  // P1-5i — DRAG TO REORDER, over a flat list (brief P1-5l §5.4).
  //
  // The SAME pointer block as the node tree, which is the whole reason D95b put
  // `dragPointer.ts` in `lib/` and the reason these two surfaces ship in one
  // build: written apart, this gets written twice and then reconciled.
  //
  // ⭐ AND THEN EVERYTHING THE TREE NEEDS ON TOP OF IT IS ABSENT HERE. No
  // `canDropOn`, no zones, no verdicts, no refusals: a level list has no
  // illegal target, because every ordering of a level vocabulary is a
  // structurally legal ordering. What makes a given order UNSAVEABLE is
  // `findLevelOrderProblems` (D92) and P1-5j's Save gate, which run on the
  // draft afterwards and are unchanged by this. A drag that produces a bad
  // order is allowed to happen and is refused at Save, with a sentence -- which
  // is the same trade the arrows already make.
  //
  // A drop dispatches ONE `{ kind: "moveTo" }` action. Not a chain of adjacent
  // swaps: `moveTo` splices out and then splices in, so `to` is read against
  // the list WITH THE DRAGGED ROW REMOVED, and that off-by-one is exactly what
  // a caller composing swaps gets wrong.
  // ---------------------------------------------------------------------------
  type LevelDragState = {
    from: number;
    pointerId: number;
    origin: { x: number; y: number };
    /** null until `passedThreshold`: before that this is still a click. */
    live: {
      /** The row under the pointer. */
      overIndex: number;
      /** Top half of that row, i.e. the caret is above it rather than below. */
      above: boolean;
      /** The `to` for `moveTo` -- see `landingIndex`. */
      landAt: number;
    } | null;
  };

  const [levelDrag, setLevelDrag] = useState<LevelDragState | null>(null);
  // Same reason as the node tree's: every transition reads the current drag
  // synchronously, so no DOM read and no dispatch ever happens inside a state
  // updater React is free to call twice under `<StrictMode>`.
  const levelDragRef = useRef<LevelDragState | null>(null);

  function commitLevelDrag(next: LevelDragState | null) {
    levelDragRef.current = next;
    setLevelDrag(next);
  }

  /**
   * ⭐ THE OFF-BY-ONE, WRITTEN DOWN ONCE.
   *
   * `caretAt` is the SEAM the caret sits on, counted against the list as it is
   * drawn: seam `i` is the gap above row `i`, so the top half of row `i` is
   * seam `i` and the bottom half is seam `i + 1`. That is the same half-split
   * `resolveDropZone` applies to a tree row, with the same convention that the
   * midpoint belongs to the lower zone (`t < 0.5` is "above").
   *
   * `moveTo`'s `to`, though, is read against the list WITH THE DRAGGED ROW
   * ALREADY REMOVED. Every seam BELOW the dragged row therefore shifts down by
   * one; every seam above it does not. Hence the single `from < caretAt`
   * subtraction, and hence dropping a row back onto its own two seams resolves
   * to `to === from`, which `applyLevelAction` returns unchanged.
   *
   * `resolveDropZone` itself is deliberately NOT called here: it consumes
   * `DropZone[]`, and a `DropZone` carries a `parentId` and a `DropVerdict` --
   * a parent and a legality this list does not have and §5.4 explicitly says it
   * must not invent. What is shared is the RULE, not the call. See the report.
   */
  function landingIndex(from: number, caretAt: number): number {
    return from < caretAt ? caretAt - 1 : caretAt;
  }

  function handleLevelPointerDown(index: number, e: React.PointerEvent<HTMLLIElement>) {
    // Guard the controls. Unlike the tree, a level row holds a TEXT INPUT and a
    // radio as well as buttons: a pointerdown inside the name field must start
    // a text selection, not a drag.
    if (e.target instanceof Element && e.target.closest("button, input, label") !== null) return;
    // D95a, and there is no `⠿` handle on this surface: a finger gets the ↑/↓
    // arrows, which stay precisely because they are the non-pointer path.
    if (!rowIsDragSource(e.pointerType)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    commitLevelDrag({
      from: index,
      pointerId: e.pointerId,
      origin: { x: e.clientX, y: e.clientY },
      live: null,
    });
  }

  function handleLevelPointerMove(e: React.PointerEvent<HTMLLIElement>) {
    const prev = levelDragRef.current;
    if (!prev || prev.pointerId !== e.pointerId) return;
    if (
      prev.live === null &&
      !passedThreshold(prev.origin, e.clientX, e.clientY, DRAG_THRESHOLD_PX)
    ) {
      return;
    }

    // `elementFromPoint`, not `e.target`: the row has pointer capture, so
    // `e.target` is that one row for the rest of the gesture.
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-level-index]");
    if (!(hit instanceof HTMLElement)) {
      commitLevelDrag({ ...prev, live: null });
      return;
    }
    const overIndex = Number(hit.getAttribute("data-level-index"));
    if (!Number.isInteger(overIndex)) {
      commitLevelDrag({ ...prev, live: null });
      return;
    }

    const rect = hit.getBoundingClientRect();
    // `rect.height`, never a hard-coded row height -- the row scales with
    // `--chrome-scale` (D84) and a literal would stop matching at 4K.
    const t = rect.height > 0 ? offsetInRow(e.clientY, rect.top) / rect.height : 0;
    const above = !Number.isFinite(t) || t < 0.5;
    const caretAt = above ? overIndex : overIndex + 1;
    commitLevelDrag({
      ...prev,
      live: { overIndex, above, landAt: landingIndex(prev.from, caretAt) },
    });
  }

  function releaseLevelCapture(e: React.PointerEvent<HTMLLIElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleLevelPointerUp(e: React.PointerEvent<HTMLLIElement>) {
    releaseLevelCapture(e);
    const prev = levelDragRef.current;
    if (!prev || prev.pointerId !== e.pointerId) return;
    commitLevelDrag(null);
    if (prev.live === null) return; // never crossed the threshold: a click
    const to = prev.live.landAt;
    setDraft((d) => applyLevelAction(d, { kind: "moveTo", from: prev.from, to }));
  }

  function handleLevelPointerCancel(e: React.PointerEvent<HTMLLIElement>) {
    releaseLevelCapture(e);
    if (levelDragRef.current !== null) commitLevelDrag(null);
  }

  const levelDragActive = levelDrag !== null;

  useEffect(() => {
    if (!levelDragActive) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        levelDragRef.current = null;
        setLevelDrag(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [levelDragActive]);

  const levelLive = levelDrag?.live ?? null;

  function levelRowClassName(index: number): string {
    if (!levelLive || !levelDrag) return styles.row;
    const classes = [styles.row];
    if (index === levelDrag.from) classes.push(styles.rowDragging);
    if (levelLive.overIndex === index) {
      classes.push(levelLive.above ? styles.caretBefore : styles.caretAfter);
    }
    return classes.join(" ");
  }

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
    <div className={levelLive ? `${styles.embedded} ${styles.dragging}` : styles.embedded}>
      <div className={styles.sectionLabel}>Levels in this structure</div>
      <ol className={styles.list}>
        {draft.map((level, index) => {
          const isInvalid = invalidIndices.has(index);
          return (
            <li
              key={level.id ?? `new-${index}`}
              data-level-index={index}
              className={levelRowClassName(index)}
              onPointerDown={(e) => handleLevelPointerDown(index, e)}
              onPointerMove={handleLevelPointerMove}
              onPointerUp={handleLevelPointerUp}
              onPointerCancel={handleLevelPointerCancel}
            >
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
