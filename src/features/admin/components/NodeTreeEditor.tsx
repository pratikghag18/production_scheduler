import { useEffect, useRef, useState } from "react";
import { DRAG_THRESHOLD_PX } from "@/lib/interaction";
import { describeSchedulerError, type BoardNode, type HierarchyLevel } from "@/lib/api";
import {
  useCreateNode,
  useDeleteNode,
  useMoveNode,
  usePlaceNode,
  useRenameNode,
} from "../hooks/useHierarchyMutations";
import { buildTreeRows, groupRowsByShape, legalParentsFor } from "../lib/treeView";
import type { ShapeSummary } from "../lib/shapePicker";
import {
  describeDrop,
  dropRailIndex,
  eligibleTargetIds,
  groupDropState,
  resolveDropZone,
  rowDropZones,
  type DropVerdict,
  type DropZone,
} from "../lib/treeDrag";
import { offsetInRow, passedThreshold, rowIsDragSource } from "../lib/dragPointer";
import { AdminPopover } from "./AdminPopover";
import styles from "./NodeTreeEditor.module.css";

/**
 * The node tree editor (brief P1-5d §7.3/§6.2). Rows from `buildTreeRows`;
 * a disclosure triangle where `hasChildren`, indent by `depth`. Every row
 * gets a `⋮` menu -- Rename, Add child, Move to…, Delete -- each opening
 * an `AdminPopover` anchored at the button that opened it.
 *
 * Collapse state is component state keyed by node id, a `Set<string>`
 * (§4.2): no lookup table to keep in sync with the node list, so a stale
 * collapse id after a refetch just means "expanded", never "hides a row
 * that still exists".
 *
 * "Move to…" lists exactly `legalParentsFor`'s result -- illegal targets
 * never appear, so there is nothing to grey out and nothing to explain.
 * §6.3 debt 2: `levels` is always passed through WHOLE, never filtered.
 *
 * No optimistic updates (§12): every mutation here just calls its RPC
 * wrapper and lets `useHierarchyMutations`'s invalidation + refetch redraw
 * the tree; a move re-paths a whole subtree server-side.
 */

type PopoverState =
  | { mode: "menu"; nodeId: string; anchor: { x: number; y: number } }
  | { mode: "rename"; nodeId: string; anchor: { x: number; y: number } }
  | { mode: "addChild"; nodeId: string; anchor: { x: number; y: number } }
  | { mode: "move"; nodeId: string; anchor: { x: number; y: number } }
  | { mode: "delete"; nodeId: string; anchor: { x: number; y: number } };

export function NodeTreeEditor({
  nodes,
  levels,
  shapeSummaries,
  selectedTemplateId,
}: {
  nodes: BoardNode[];
  levels: HierarchyLevel[];
  /** D87 (brief P1-5f §7.5): every shape in the org, for the add-root picker. */
  shapeSummaries: readonly ShapeSummary[];
  /** The shape currently selected in `ShapePicker`, used as the add-root default. */
  selectedTemplateId: string | null;
}) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [addRootOpen, setAddRootOpen] = useState(false);
  const [addRootName, setAddRootName] = useState("");
  // D87: which shape a new root lands in. Only consulted when there is more
  // than one shape to choose among (§7.5) -- with one shape, or none, this
  // stays unused and templateId is omitted from the create_node call
  // entirely, so the RPC's own single-template inference is what runs.
  const [addRootTemplateId, setAddRootTemplateId] = useState<string | null>(selectedTemplateId);
  const requiresShapeChoice = shapeSummaries.length > 1;

  const renameMutation = useRenameNode();
  const createMutation = useCreateNode();
  const moveMutation = useMoveNode();
  const placeMutation = usePlaceNode();
  const deleteMutation = useDeleteNode();

  // ---------------------------------------------------------------------------
  // Drag pointer mechanics (brief P1-5g §7.1) -- KEPT SELF-CONTAINED. This
  // region owns "a drag started on element X / the pointer is now over
  // element Y / it was dropped / it was cancelled" and touches none of this
  // component's OTHER state (collapse, popovers). P1-5i will put the same
  // pointer mechanics into `LevelEditor` to drag the level list; keeping
  // this physically isolated is what keeps that future lift mechanical
  // instead of archaeological. No shared hook (`useDragHandle` or similar)
  // is extracted in this brief (§11) -- LevelEditor is two other pieces of
  // work away, and a hook built for a caller that far off is speculative.
  // ---------------------------------------------------------------------------
  // The flattened rows, hoisted above the drag block because `rowDropZones`
  // needs them: sibling ORDER comes from the rows the admin is actually looking
  // at, never from re-sorting `nodes`, so the index handed to `place_node`
  // means the same thing they just saw.
  const rows = buildTreeRows(nodes, levels, collapsedIds);

  type DragLive = {
    /** computed ONCE at drag start -- legalParentsFor is O(n) in canDropOn calls */
    eligible: ReadonlySet<string>;
    hoverId: string | null;
    /** Which zone of the hovered row the pointer is in; null when it refuses. */
    zone: DropZone | null;
    /**
     * Set ONLY when the hovered row offers no zone at all. `rowDropZones`
     * returning `[]` is a SILENT refusal -- there is no sentence inside an empty
     * array -- so the explanation still comes from `describeDrop`, exactly as it
     * did in P1-5g. Used for the MESSAGE only; the drop decision is the zone's.
     * The brief does not mention this; without it a Work Cell dragged over a
     * Site row goes from "A Work Cell can only sit under a Line." to nothing at
     * all, which is a regression the reorder work has no reason to cause.
     */
    refusal: DropVerdict | null;
    pointer: { x: number; y: number };
  };

  type DragState = {
    draggedId: string;
    pointerId: number;
    /** Where the pointer went DOWN. A drag has not started at this point. */
    origin: { x: number; y: number };
    source: "row" | "handle";
    /** null until `passedThreshold` says this is a drag and not a click. */
    live: DragLive | null;
  };

  const [drag, setDrag] = useState<DragState | null>(null);

  // ⭐ A REF BESIDE THE STATE, and it is not a micro-optimisation.
  //
  // Every transition below reads the CURRENT drag synchronously and writes both
  // halves at once. The alternative -- doing the work inside a `setDrag(prev =>
  // ...)` updater, which is what P1-5g did -- puts `document.elementFromPoint`
  // and `mutation.mutate()` inside a function React is allowed to call twice.
  // `main.tsx` renders under `<StrictMode>`, which DOES call updaters twice in
  // development, so P1-5g's drop fired its `move_node` twice on every dev drop.
  // A ref makes each transition a plain, once-only event handler.
  const dragRef = useRef<DragState | null>(null);

  function commitDrag(next: DragState | null) {
    dragRef.current = next;
    setDrag(next);
  }

  /**
   * ⭐ THE COST D95a NAMES, AND IT IS DELIBERATE (brief §5.1).
   *
   * P1-5g could say "a pointerdown on the handle is unambiguously a drag start,
   * and no threshold logic exists to get wrong". Dragging from the WHOLE ROW
   * makes that sentence false: every click on a row is a zero-length drag
   * unless something gates it. `passedThreshold` is that gate, and the
   * threshold is the PRICE of the affordance, not an optimisation.
   *
   * So `onPointerDown` records only an ORIGIN. `onPointerMove` is what starts
   * the drag, the first time the pointer has travelled `DRAG_THRESHOLD_PX`
   * (D32, now `src/lib/interaction.ts` so admin and board share the one number).
   */
  function beginPointer(
    nodeId: string,
    e: React.PointerEvent,
    rowEl: HTMLElement,
    source: "row" | "handle",
  ) {
    // Capture on the ROW, even when the gesture started on the handle, so
    // `currentTarget` in every later handler IS the capturing element and
    // `releasePointerCapture` below always has the right one.
    rowEl.setPointerCapture(e.pointerId);
    commitDrag({
      draggedId: nodeId,
      pointerId: e.pointerId,
      origin: { x: e.clientX, y: e.clientY },
      source,
      live: null,
    });
  }

  function handleRowPointerDown(nodeId: string, e: React.PointerEvent<HTMLLIElement>) {
    // GUARD THE CONTROLS. The disclosure triangle, the `⋮` menu and the drag
    // handle all live inside the row and must keep working as buttons; the
    // handle has its own `onPointerDown` below, and this is what stops the row
    // from also claiming the same pointerdown.
    if (e.target instanceof Element && e.target.closest("button") !== null) return;
    // D95a: mouse and pen drag from anywhere on the row; touch keeps the handle,
    // because `touch-action: none` on the whole row would leave nowhere on the
    // tree for a finger to scroll from.
    if (!rowIsDragSource(e.pointerType)) return;
    beginPointer(nodeId, e, e.currentTarget, "row");
  }

  function handleHandlePointerDown(nodeId: string, e: React.PointerEvent<HTMLButtonElement>) {
    // The handle keeps its own start (§5.1) -- it is the TOUCH path, and it is
    // the only one on a touch device. `preventDefault` here and not on the row:
    // the handle is a button whose default action we never want, while a plain
    // click on a row must still behave like a click.
    e.preventDefault();
    const rowEl = e.currentTarget.closest("[data-node-id]");
    if (!(rowEl instanceof HTMLElement)) return;
    beginPointer(nodeId, e, rowEl, "handle");
  }

  function handleRowPointerMove(e: React.PointerEvent<HTMLLIElement>) {
    const prev = dragRef.current;
    if (!prev || prev.pointerId !== e.pointerId) return;

    // Not a drag yet, and not far enough to become one: leave the origin alone.
    if (
      prev.live === null &&
      !passedThreshold(prev.origin, e.clientX, e.clientY, DRAG_THRESHOLD_PX)
    ) {
      return;
    }

    const eligible = prev.live?.eligible ?? eligibleTargetIds(prev.draggedId, nodes, levels);

    // `elementFromPoint`, NOT `e.target` -- `setPointerCapture` routes every
    // subsequent event to the capturing row, so `e.target` is always that one
    // row and a naive version reports a single unchanging hover target.
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]") ?? null;
    const hoverId = hit === null ? null : hit.getAttribute("data-node-id");

    let zone: DropZone | null = null;
    let refusal: DropVerdict | null = null;
    if (hit !== null && hoverId !== null) {
      const zones = rowDropZones(prev.draggedId, hoverId, rows, nodes, levels, shapeSummaries);
      // `rect.height`, never a hard-coded row height: the row scales with
      // `--chrome-scale` (D84) and a literal would silently stop matching at 4K.
      const rect = hit.getBoundingClientRect();
      zone = resolveDropZone(zones, offsetInRow(e.clientY, rect.top), rect.height);
      if (zones.length === 0) {
        refusal = describeDrop(prev.draggedId, hoverId, nodes, levels, shapeSummaries);
      }
    }

    commitDrag({
      ...prev,
      live: { eligible, hoverId, zone, refusal, pointer: { x: e.clientX, y: e.clientY } },
    });
  }

  function releaseCapture(e: React.PointerEvent<HTMLLIElement>) {
    // ⭐ P1-5g NEVER CALLED THIS. Its independent review found
    // `DragState.pointerId` was written and never read, and dead state is the
    // fingerprint of a dropped requirement. Released on BOTH up and cancel.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleRowPointerUp(e: React.PointerEvent<HTMLLIElement>) {
    releaseCapture(e);
    const prev = dragRef.current;
    if (!prev || prev.pointerId !== e.pointerId) return;
    commitDrag(null);

    const live = prev.live;
    // No `live` at all means the pointer never crossed the threshold: this was
    // a click, and a click commits nothing.
    if (live === null || live.hoverId === null) return;

    const zone = live.zone;
    if (zone === null) return;

    if (zone.kind === "adopt") {
      // Unchanged from P1-5g: adoption still requires `ok`, because there
      // `noop` really does mean "already a child of this row".
      if (zone.verdict.kind === "ok" && zone.parentId !== null) {
        moveMutation.mutate({ nodeId: prev.draggedId, newParentId: zone.parentId });
      }
      return;
    }

    // `before` / `after` -- a PLACEMENT, which is `place_node`, not `move_node`.
    // The index is `rowDropZones`' own, counted among the destination parent's
    // children with the dragged node removed, which is the list `place_node`
    // splices into.
    if (zone.index !== null) {
      placeMutation.mutate({
        nodeId: prev.draggedId,
        newParentId: zone.parentId,
        index: zone.index,
      });
    }
  }

  function handleRowPointerCancel(e: React.PointerEvent<HTMLLIElement>) {
    releaseCapture(e);
    if (dragRef.current !== null) commitDrag(null);
  }

  // ⭐ KEYED ON `dragActive`, NOT ON `drag`. The same review found P1-5g's
  // Escape listener keyed on `[drag]` -- a new object on every single
  // `pointermove` -- so the listener was torn down and re-added on every frame
  // of every drag. A boolean changes twice per drag, which is the real number
  // of times this listener needs to exist.
  const dragActive = drag !== null;

  useEffect(() => {
    if (!dragActive) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dragRef.current = null;
        setDrag(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dragActive]);

  // `shapeSummaries` is structurally a `HierarchyTemplateRef[]` (id + name),
  // so the picker's own model is reused rather than threading a second list
  // down. One source for "what structures exist", shared by the picker and
  // the tree, which is the disagreement D90 exists to remove.
  const groups = groupRowsByShape(rows, levels, shapeSummaries);
  const showShapeHeadings = groups.length > 1;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ⭐ EVERYTHING BELOW READS `drag.live`, NEVER `drag`. A `drag` with a null
  // `live` is a pointer that went down and has not travelled 4px yet -- which
  // is what a CLICK looks like -- and it must paint nothing at all.
  const live = drag?.live ?? null;

  // Drag chip presentation (§7.1). `flip` reads `window.innerWidth`, which is
  // only ever consulted while a drag is live, so it is safe outside an effect.
  const draggedName = drag ? (byId.get(drag.draggedId)?.name ?? "This node") : "";
  // The sentence the chip and the live region both say: the chosen zone's own
  // wording when there is a zone, and `describeDrop`'s refusal when the row
  // offered none.
  const dragVerdict: DropVerdict | null = live?.zone?.verdict ?? live?.refusal ?? null;
  const verdictBlocked = dragVerdict?.kind === "blocked";
  const flip = live ? live.pointer.x > window.innerWidth * 0.72 : false;

  // Row classes (§7.1 table, extended by §5 of this brief). Conditions
  // accumulate rather than exclude: an eligible row that is also the hovered,
  // legal drop target carries BOTH `.eligible` and `.dropOk` -- the stylesheet
  // relies on `.dropOk` coming after `.eligible` in source order to suppress
  // the dashed hint on the chosen target.
  //
  // ⭐ THE TICK AND THE CARET ARE MUTUALLY EXCLUSIVE HERE BECAUSE THEY ARE
  // MUTUALLY EXCLUSIVE IN `rowDropZones`: a row offers `before`+`after` or it
  // offers `adopt`, never both (the theorem above `resolveDropZone`). Nothing
  // in this function has to arbitrate between them.
  function rowClassName(nodeId: string): string {
    if (!live) return styles.row;
    const classes = [styles.row];
    if (nodeId === drag?.draggedId) classes.push(styles.rowDragging);
    if (live.eligible.has(nodeId)) classes.push(styles.eligible);
    if (live.hoverId === nodeId) {
      const zone = live.zone;
      if (zone === null) {
        // The row offered no zone. Only a genuine refusal gets a treatment;
        // "noop" still gets none at all (§7.1), unchanged from P1-5g.
        if (live.refusal?.kind === "blocked") classes.push(styles.dropBlocked);
      } else if (zone.kind === "adopt") {
        classes.push(styles.dropOk, styles.dropTick);
      } else if (zone.kind === "before") {
        classes.push(styles.caretBefore);
      } else {
        classes.push(styles.caretAfter);
      }
    }
    return classes.join(" ");
  }

  function rowStyle(row: { node: { id: string }; depth: number }): React.CSSProperties | undefined {
    if (!live || live.hoverId !== row.node.id) return undefined;
    const zone = live.zone;
    if (zone === null) return undefined;
    // The adopt tick sits at a CHILD's elbow -- one rail in from this row.
    if (zone.kind === "adopt") {
      return { "--drop-rails": dropRailIndex(row.depth) } as React.CSSProperties;
    }
    // The caret sits at the DRAGGED node's depth, and for a sibling placement
    // that is this reference row's own depth. `row.depth`, not `row.depth + 1`:
    // a caret one rail too far in reads as a placement inside this row.
    return { "--caret-rails": row.depth } as React.CSSProperties;
  }

  function toggleCollapsed(nodeId: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function openMenu(nodeId: string, e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover({ mode: "menu", nodeId, anchor: { x: rect.left, y: rect.bottom } });
  }

  function closePopover() {
    setPopover(null);
  }

  return (
    <section className={live ? `${styles.card} ${styles.dragging}` : styles.card}>
      <div className={styles.header}>
        <h2 className={styles.h2}>Nodes</h2>
        <button
          type="button"
          className={styles.addRootBtn}
          onClick={() => {
            if (!addRootOpen) setAddRootTemplateId(selectedTemplateId);
            setAddRootOpen((v) => !v);
          }}
        >
          + add root node
        </button>
      </div>

      {addRootOpen && (
        <form
          className={styles.addRootForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (addRootName.trim() === "") return;
            if (requiresShapeChoice && addRootTemplateId === null) return;
            createMutation.mutate(
              {
                parentId: null,
                name: addRootName,
                // One shape (or none) in the org -> omit the key entirely,
                // so the RPC's own single-template inference runs (§7.5).
                templateId: requiresShapeChoice ? (addRootTemplateId ?? undefined) : undefined,
              },
              {
                onSuccess: () => {
                  setAddRootName("");
                  setAddRootOpen(false);
                },
              },
            );
          }}
        >
          <input
            autoFocus
            type="text"
            value={addRootName}
            placeholder="Root node name"
            onChange={(e) => setAddRootName(e.target.value)}
          />
          {requiresShapeChoice && (
            <select
              aria-label="Site structure for the new root node"
              value={addRootTemplateId ?? ""}
              onChange={(e) => setAddRootTemplateId(e.target.value === "" ? null : e.target.value)}
            >
              <option value="" disabled>
                Choose a structure…
              </option>
              {shapeSummaries.map((s) => (
                // A shape with no levels yet has no position-0 level for a
                // root to land on -- offered so the admin can see it exists,
                // disabled so they cannot pick it and get level_mismatch
                // back with no warning (§7.5).
                <option key={s.id} value={s.id} disabled={s.levelCount === 0}>
                  {s.name}
                  {s.levelCount === 0 ? " (no levels yet)" : ""}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={createMutation.isPending || (requiresShapeChoice && addRootTemplateId === null)}
          >
            Add
          </button>
          <button type="button" onClick={() => setAddRootOpen(false)}>
            Cancel
          </button>
        </form>
      )}
      {createMutation.isError && !popover && (
        <p className={styles.errorLine} role="alert">
          {describeSchedulerError(createMutation.error)}
        </p>
      )}

      {/*
        D90 (design plan §19.24, option B). Grouped by SITE STRUCTURE, and every
        row states its own level.

        Before D86 this was unnecessary — one vocabulary per org meant
        indentation depth WAS the level. Per-site shapes made that false: a root
        on a two-level structure sits at the same indent as one on a four-level
        structure, and its children are Lines where the other's are Departments.
        On the two-level shape a Line is SCHEDULABLE, so two rows at equal
        indent can differ in whether work can be booked on them at all.

        The heading appears only when the org holds more than one structure: for
        the single-plant case it would be a label on the only thing there is.
      */}
      {groups.map((group) => {
        const isForeignGroup =
          drag !== null &&
          live !== null &&
          groupDropState(drag.draggedId, group.templateId, nodes, levels) === "foreign";
        return (
        <div
          key={group.templateId ?? "__unresolved__"}
          className={isForeignGroup ? `${styles.group} ${styles.groupForeign}` : styles.group}
        >
          {showShapeHeadings && (
            <div className={styles.shapeHead}>
              <b className={styles.shapeName}>{group.templateName ?? "Unknown structure"}</b>
              {group.levelPath.length > 0 && (
                <span className={styles.shapePath}>{group.levelPath.join(" › ")}</span>
              )}
              {isForeignGroup && (
                <span className={styles.foreignNote}>different structure — not a destination</span>
              )}
            </div>
          )}
          <ul className={styles.tree}>
            {group.rows.map((row) => (
              <li
                key={row.node.id}
                data-node-id={row.node.id}
                className={rowClassName(row.node.id)}
                style={rowStyle(row)}
                onPointerDown={(e) => handleRowPointerDown(row.node.id, e)}
                onPointerMove={handleRowPointerMove}
                onPointerUp={handleRowPointerUp}
                onPointerCancel={handleRowPointerCancel}
              >
                {/*
                  Tree guides, drawn from `row.guides` (D90). One fixed-width
                  rail per ancestor depth: it carries a vertical line when that
                  ancestor still has siblings below, and nothing when it does
                  not — which is what makes a last child's line stop instead of
                  running on into empty space.

                  These rails ALSO provide the indent, replacing an inline
                  `paddingLeft: row.depth * 18`. That was raw px in a `style`
                  prop, invisible to `scaleAudit` (which reads CSS files), so it
                  silently did not scale and nothing could have caught it — the
                  D89 blind spot, one component over.
                */}
                {row.depth > 0 && (
                  // One flex container for the whole rail block, with NO gap
                  // inside it, so each level is exactly one rail wide. The
                  // row's own `gap` would otherwise widen every indent step
                  // and make the arithmetic depend on a spacing token.
                  <span className={styles.guides} aria-hidden="true">
                    {row.guides.map((continues, i) => (
                      <span key={i} className={continues ? styles.guideOn : styles.guideOff} />
                    ))}
                    <span className={row.isLastSibling ? styles.elbowLast : styles.elbow} />
                  </span>
                )}

                {row.hasChildren ? (
                  <button
                    type="button"
                    className={styles.disclosure}
                    aria-label={
                      row.collapsed ? `Expand ${row.node.name}` : `Collapse ${row.node.name}`
                    }
                    onClick={() => toggleCollapsed(row.node.id)}
                  >
                    {row.collapsed ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className={styles.disclosureSpacer} />
                )}

                <span className={row.node.active ? styles.name : styles.nameInactive}>
                  {row.node.name}
                </span>

                {row.levelName !== null && (
                  <span className={styles.levelChip}>{row.levelName}</span>
                )}

                {/*
                  The handle keeps its own `onPointerDown` and NOTHING ELSE. It
                  captures on the ROW, so every later pointer event targets the
                  row and is handled exactly once by the row's own handlers --
                  putting move/up/cancel here as well would run them twice for a
                  handle-started drag, since those events bubble from the handle
                  up through the row.
                */}
                <button
                  type="button"
                  className={styles.dragHandle}
                  aria-label={`Drag ${row.node.name}`}
                  onPointerDown={(e) => handleHandlePointerDown(row.node.id, e)}
                >
                  ⠿
                </button>

                <button
                  type="button"
                  className={styles.menuBtn}
                  aria-label={`Actions for ${row.node.name}`}
                  onClick={(e) => openMenu(row.node.id, e)}
                >
                  ⋮
                </button>
              </li>
            ))}
          </ul>
        </div>
        );
      })}

      {live && (
        <div
          className={`${styles.dragChip}${verdictBlocked ? " " + styles.dragChipBlocked : ""}${flip ? " " + styles.dragChipFlip : ""}`}
          style={{ left: live.pointer.x, top: live.pointer.y }}
          aria-hidden="true"
        >
          <span className={styles.dragChipName}>{draggedName}</span>
          {dragVerdict && <span className={styles.dragChipMsg}>{dragVerdict.message}</span>}
        </div>
      )}
      <p className={styles.srOnly} aria-live="polite">
        {dragVerdict?.message ?? ""}
      </p>

      {popover && (
        <NodePopoverContent
          popover={popover}
          node={byId.get(popover.nodeId) ?? null}
          nodes={nodes}
          levels={levels}
          onClose={closePopover}
          onSwitchMode={(mode) => setPopover((p) => (p ? { ...p, mode } : p))}
          renameMutation={renameMutation}
          createMutation={createMutation}
          moveMutation={moveMutation}
          deleteMutation={deleteMutation}
        />
      )}
    </section>
  );
}

/**
 * The popover's content -- switches on `popover.mode`. Split out of the
 * main list so the row list above stays a plain, readable table and the
 * (fairly involved) menu/rename/add-child/move/delete branching lives in
 * one place.
 */
function NodePopoverContent({
  popover,
  node,
  nodes,
  levels,
  onClose,
  onSwitchMode,
  renameMutation,
  createMutation,
  moveMutation,
  deleteMutation,
}: {
  popover: PopoverState;
  node: BoardNode | null;
  nodes: BoardNode[];
  levels: HierarchyLevel[];
  onClose: () => void;
  onSwitchMode: (mode: PopoverState["mode"]) => void;
  renameMutation: ReturnType<typeof useRenameNode>;
  createMutation: ReturnType<typeof useCreateNode>;
  moveMutation: ReturnType<typeof useMoveNode>;
  deleteMutation: ReturnType<typeof useDeleteNode>;
}) {
  const [text, setText] = useState(node?.name ?? "");
  const [deleteMode, setDeleteMode] = useState<"deactivate" | "delete">("deactivate");

  if (!node) return null;

  const title =
    popover.mode === "menu"
      ? node.name
      : popover.mode === "rename"
        ? `Rename "${node.name}"`
        : popover.mode === "addChild"
          ? `Add child of "${node.name}"`
          : popover.mode === "move"
            ? `Move "${node.name}"`
            : `Delete "${node.name}"`;

  return (
    <AdminPopover anchor={popover.anchor} onClose={onClose} title={title}>
      {popover.mode === "menu" && (
        <div className={styles.menuList}>
          <button type="button" onClick={() => onSwitchMode("rename")}>
            Rename
          </button>
          <button type="button" onClick={() => onSwitchMode("addChild")}>
            Add child
          </button>
          <button type="button" onClick={() => onSwitchMode("move")}>
            Move to…
          </button>
          <button type="button" onClick={() => onSwitchMode("delete")}>
            Delete
          </button>
        </div>
      )}

      {(popover.mode === "rename" || popover.mode === "addChild") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() === "") return;
            if (popover.mode === "rename") {
              renameMutation.mutate({ nodeId: node.id, name: text }, { onSuccess: onClose });
            } else {
              createMutation.mutate({ parentId: node.id, name: text }, { onSuccess: onClose });
            }
          }}
        >
          <input autoFocus type="text" value={text} onChange={(e) => setText(e.target.value)} />
          <div className={styles.popActions}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={renameMutation.isPending || createMutation.isPending}>
              {popover.mode === "rename" ? "Rename" : "Add"}
            </button>
          </div>
          {renameMutation.isError && popover.mode === "rename" && (
            <p className={styles.errorLine} role="alert">
              {describeSchedulerError(renameMutation.error)}
            </p>
          )}
          {createMutation.isError && popover.mode === "addChild" && (
            <p className={styles.errorLine} role="alert">
              {describeSchedulerError(createMutation.error)}
            </p>
          )}
        </form>
      )}

      {popover.mode === "move" && (
        <MoveToList
          nodeId={node.id}
          nodes={nodes}
          levels={levels}
          onPick={(newParentId) =>
            moveMutation.mutate({ nodeId: node.id, newParentId }, { onSuccess: onClose })
          }
          isPending={moveMutation.isPending}
          error={moveMutation.isError ? describeSchedulerError(moveMutation.error) : null}
          onCancel={onClose}
        />
      )}

      {popover.mode === "delete" && (
        <div className={styles.deleteConfirm}>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="delete-mode"
              checked={deleteMode === "deactivate"}
              onChange={() => setDeleteMode("deactivate")}
            />
            <span>
              <strong>Deactivate</strong> — hides this node and its whole subtree. Reversible.
              (default)
            </span>
          </label>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="delete-mode"
              checked={deleteMode === "delete"}
              onChange={() => setDeleteMode("delete")}
            />
            <span>
              <strong>Delete</strong> — removes this node permanently. Refused if it still has
              children, runs, or assignments.
            </span>
          </label>
          <div className={styles.popActions}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteMutation.mutate({ nodeId: node.id, mode: deleteMode }, { onSuccess: onClose })
              }
            >
              {deleteMode === "deactivate" ? "Deactivate" : "Delete"}
            </button>
          </div>
          {deleteMutation.isError && (
            <p className={styles.errorLine} role="alert">
              {describeSchedulerError(deleteMutation.error)}
            </p>
          )}
        </div>
      )}
    </AdminPopover>
  );
}

function MoveToList({
  nodeId,
  nodes,
  levels,
  onPick,
  isPending,
  error,
  onCancel,
}: {
  nodeId: string;
  nodes: BoardNode[];
  levels: HierarchyLevel[];
  onPick: (newParentId: string | null) => void;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  // §6.3 debt 2: `levels` here is exactly the whole array this component
  // was handed -- never filtered -- so a legal server move is never
  // rejected client-side.
  const choices = legalParentsFor(nodeId, nodes, levels);

  if (choices.length === 0) {
    return (
      <div>
        <p className={styles.emptyChoices}>No legal destination for this node.</p>
        <div className={styles.popActions}>
          <button type="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ul className={styles.moveList}>
        {choices.map((choice) => (
          <li key={choice.id ?? "__root__"}>
            <button type="button" disabled={isPending} onClick={() => onPick(choice.id)}>
              {choice.label}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className={styles.errorLine} role="alert">
          {error}
        </p>
      )}
      <div className={styles.popActions}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
