import { useEffect, useRef, useState } from "react";
import { DRAG_THRESHOLD_PX } from "@/lib/interaction";
import { describeSchedulerError, type BoardNode, type HierarchyLevel } from "@/lib/api";
import { useSaveHierarchyLevels } from "../hooks/useHierarchyMutations";
import {
  applyLevelAction,
  findLevelOrderProblems,
  invalidNameIndices,
  levelDropTarget,
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
    /**
     * null until `passedThreshold`, AND null whenever the pointer is over a
     * row that has nothing to promise -- which since P1-6e includes the
     * dragged row itself. `levelDropTarget` decides; this only carries the
     * answer.
     */
    live: {
      /** The row under the pointer -- the one row that draws the caret. */
      overIndex: number;
      /** The seam the caret sits on, always `overIndex` or `overIndex + 1`. */
      caretAt: number;
      /** The `to` for `moveTo`, against the list with the dragged row removed. */
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
   * ⭐ THE OFF-BY-ONE AND THE NO-OP RULE BOTH MOVED OUT (P1-6e).
   *
   * This component used to carry `landingIndex` -- the seam-to-`to` conversion
   * -- inline, with a long comment and no test able to reach it. It now lives
   * in `levelDropTarget` beside `applyLevelAction`, which is the function it
   * has to agree with, along with the rule that suppresses a caret promising a
   * move the list will not make. 25 committed cases and 11 mutations.
   *
   * `resolveDropZone` is still deliberately NOT called here: it consumes
   * `DropZone[]`, and a `DropZone` carries a `parentId` and a `DropVerdict` --
   * a parent and a legality this list does not have and §5.4 explicitly says it
   * must not invent. What is shared is the RULE, not the call.
   */

  function handleLevelPointerDown(index: number, e: React.PointerEvent<HTMLLIElement>) {
    // Guard the controls. Unlike the tree, a level row holds a TEXT INPUT and a
    // radio as well as buttons: a pointerdown inside the name field must start
    // a text selection, not a drag.
    if (e.target instanceof Element && e.target.closest("button, input, label") !== null) return;
    // D95a: mouse and pen drag from anywhere on the row; touch does not, because
    // `touch-action: none` on a whole row would leave a finger nowhere to scroll
    // from. Touch gets the `⠿` handle (P1-6e) and the ↑/↓ arrows, which stay
    // precisely because they are the non-pointer path.
    //
    // ⚠️ THIS COMMENT USED TO SAY "there is no `⠿` handle on this surface".
    // That was true and it was the whole defect: the row was draggable for a
    // mouse and said so nowhere, so 21 px of 526 on its centre line -- three
    // 7 px gutters between the controls -- were the only place a drag could be
    // started, and nothing pointed at them.
    if (!rowIsDragSource(e.pointerType)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    commitLevelDrag({
      from: index,
      pointerId: e.pointerId,
      origin: { x: e.clientX, y: e.clientY },
      live: null,
    });
  }

  /**
   * P1-6e — THE GRIP'S OWN START. Mirrors `NodeTreeEditor`'s
   * `handleHandlePointerDown`, and it is not optional decoration:
   *
   * 1. `handleLevelPointerDown` refuses any pointerdown inside a `button`, so
   *    without this handler the grip would be the ONE part of the row that
   *    cannot start a drag -- the same inversion the row already had, where the
   *    only cursor that changed was `pointer`, over the four controls that are
   *    precisely NOT draggable.
   * 2. It is the TOUCH path. The row block refuses touch (`rowIsDragSource`,
   *    D95a) because `touch-action: none` on a whole row leaves a finger
   *    nowhere to scroll from; the handle carries that declaration alone, so a
   *    finger can now drag a level as well as tap the arrows. That closes the
   *    level half of the "no touch path for either drag" item, and it is a
   *    consequence of matching the tree, not a separate feature.
   */
  function handleLevelHandlePointerDown(index: number, e: React.PointerEvent<HTMLButtonElement>) {
    // The handle is a button whose default action we never want. `preventDefault`
    // belongs here and NOT on the row, because a plain click on a row must still
    // behave like a click (the same split the tree draws).
    e.preventDefault();
    const rowEl = e.currentTarget.closest("[data-level-index]");
    if (!(rowEl instanceof HTMLElement)) return;
    // Capture on the ROW, never on the button. `onPointerMove`/`onPointerUp`
    // live on the `<li>`; `releaseLevelCapture` reads `e.currentTarget`, which
    // for those events IS the `<li>`, so capturing anywhere else leaves the
    // release asking the wrong element whether it holds the pointer.
    rowEl.setPointerCapture(e.pointerId);
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
    // The geometry is this component's job; every DECISION about the geometry
    // is not. A null means "nothing to promise here" -- the dragged row's own
    // two halves, and nothing else on a well-formed list.
    const target = levelDropTarget(prev.from, overIndex, above, draft.length);
    if (target === null) {
      commitLevelDrag({ ...prev, live: null });
      return;
    }
    commitLevelDrag({
      ...prev,
      live: { overIndex, caretAt: target.caretAt, landAt: target.landAt },
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
    // ONE row draws the caret -- the one under the pointer -- and which of its
    // two edges is decided by the SEAM, not by which half the pointer is in.
    // Since P1-6e those two can differ: a dead half collapses into the row's
    // live edge, so the pointer can be in the top half of a row whose caret is
    // drawn along its bottom.
    if (levelLive.overIndex === index) {
      classes.push(levelLive.caretAt === index ? styles.caretBefore : styles.caretAfter);
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
                  {/* U+FE0E forces TEXT presentation. Without it Windows falls
                      through to an emoji font and renders these two glyphs
                      BLUE — the one colour on the level row that matches
                      nothing else in the product, and immune to the
                      `color: var(--ink-2)` above because an emoji glyph carries
                      its own. Seen in the maintainer's screenshot, not in any render
                      here, because the container's font stack has no emoji
                      face to fall through to. */}
                  {"\u2191\uFE0E"}
                </button>
                <button
                  type="button"
                  className={styles.moveBtn}
                  disabled={index === draft.length - 1}
                  aria-label={`Move ${level.name || "level"} down`}
                  onClick={() => setDraft((d) => applyLevelAction(d, { kind: "moveDown", index }))}
                >
                  {"\u2193\uFE0E"}
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

              {/* ⭐ D100 — THE GRIP SITS WHERE THE NODE TREE'S SITS: last but one,
                  immediately before this row's own menu-equivalent (`×`), exactly
                  as the tree puts `⠿` immediately before `⋮`.

                  It shipped at the LEFT edge for one day and the maintainer's first
                  reaction was that it looked wrong: *"The drag is also present
                  right next to arrows which seems weird."* He is right twice
                  over. It put two ways of moving the same row side by side, so
                  the pair read as one control with a broken half; and it made
                  the two admin drag surfaces disagree about where a grip lives,
                  which is the same reinvention D100 exists to stop. Left-edge is
                  the more common convention in the abstract; matching the
                  surface next to it wins, because these two screens are looked
                  at together.

                  It is a real button so it takes focus and carries a label; the
                  row handler's `closest("button, input, label")` guard is what
                  stops the same pointerdown being claimed twice. */}
              <button
                type="button"
                className={styles.dragHandle}
                aria-label={`Drag ${level.name || "level"} to reorder`}
                onPointerDown={(e) => handleLevelHandlePointerDown(index, e)}
              >
                ⠿
              </button>

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
