import { useEffect, useState } from "react";
import { describeSchedulerError, type BoardNode, type HierarchyLevel } from "@/lib/api";
import {
  useCreateNode,
  useDeleteNode,
  useMoveNode,
  useRenameNode,
} from "../hooks/useHierarchyMutations";
import { buildTreeRows, groupRowsByShape, legalParentsFor } from "../lib/treeView";
import type { ShapeSummary } from "../lib/shapePicker";
import {
  describeDrop,
  dropRailIndex,
  eligibleTargetIds,
  groupDropState,
  type DropVerdict,
} from "../lib/treeDrag";
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
  type DragState = {
    draggedId: string;
    pointerId: number;
    /** computed ONCE at drag start -- legalParentsFor is O(n) in canDropOn calls */
    eligible: ReadonlySet<string>;
    hoverId: string | null;
    verdict: DropVerdict | null;
    pointer: { x: number; y: number };
  };

  const [drag, setDrag] = useState<DragState | null>(null);

  function handleDragPointerDown(nodeId: string, e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      draggedId: nodeId,
      pointerId: e.pointerId,
      eligible: eligibleTargetIds(nodeId, nodes, levels),
      hoverId: null,
      verdict: null,
      pointer: { x: e.clientX, y: e.clientY },
    });
  }

  function handleDragPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    setDrag((prev) => {
      if (!prev) return prev;
      // `elementFromPoint`, not `e.target` -- `setPointerCapture` routes
      // every subsequent event to the handle, so `e.target` is always the
      // handle and a naive implementation reports one unchanging hover row.
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node-id]");
      const hoverId = hit ? hit.getAttribute("data-node-id") : null;
      if (hoverId === prev.hoverId) {
        return { ...prev, pointer: { x: e.clientX, y: e.clientY } };
      }
      const verdict = hoverId ? describeDrop(prev.draggedId, hoverId, nodes, levels, shapeSummaries) : null;
      return { ...prev, pointer: { x: e.clientX, y: e.clientY }, hoverId, verdict };
    });
  }

  function handleDragPointerUp() {
    setDrag((prev) => {
      // A `noop` verdict commits nothing -- dropping a node on the parent it
      // already has is not an error and not a write.
      if (prev && prev.verdict?.kind === "ok" && prev.hoverId) {
        moveMutation.mutate({ nodeId: prev.draggedId, newParentId: prev.hoverId });
      }
      return null;
    });
  }

  function handleDragPointerCancel() {
    setDrag(null);
  }

  useEffect(() => {
    if (!drag) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setDrag(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drag]);

  const rows = buildTreeRows(nodes, levels, collapsedIds);
  // `shapeSummaries` is structurally a `HierarchyTemplateRef[]` (id + name),
  // so the picker's own model is reused rather than threading a second list
  // down. One source for "what structures exist", shared by the picker and
  // the tree, which is the disagreement D90 exists to remove.
  const groups = groupRowsByShape(rows, levels, shapeSummaries);
  const showShapeHeadings = groups.length > 1;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Drag chip presentation (§7.1). `flip` reads `window.innerWidth`, which is
  // only ever consulted while a drag is live, so it is safe outside an effect.
  const draggedName = drag ? (byId.get(drag.draggedId)?.name ?? "This node") : "";
  const verdictBlocked = drag?.verdict?.kind === "blocked";
  const flip = drag ? drag.pointer.x > window.innerWidth * 0.72 : false;

  // Row classes (§7.1 table). Conditions accumulate rather than exclude: an
  // eligible row that is also the hovered, legal drop target carries BOTH
  // `.eligible` and `.dropOk` -- the stylesheet relies on `.dropOk` coming
  // after `.eligible` in source order to suppress the dashed hint on the
  // chosen target.
  function rowClassName(nodeId: string): string {
    if (!drag) return styles.row;
    const classes = [styles.row];
    if (nodeId === drag.draggedId) classes.push(styles.rowDragging);
    if (drag.eligible.has(nodeId)) classes.push(styles.eligible);
    if (drag.hoverId === nodeId) {
      if (drag.verdict?.kind === "ok") classes.push(styles.dropOk, styles.dropTick);
      else if (drag.verdict?.kind === "blocked") classes.push(styles.dropBlocked);
      // "noop" gets no row treatment at all (§7.1) -- not styled here.
    }
    return classes.join(" ");
  }

  function rowStyle(row: { node: { id: string }; depth: number }): React.CSSProperties | undefined {
    if (!drag || drag.hoverId !== row.node.id || drag.verdict?.kind !== "ok") return undefined;
    return { "--drop-rails": dropRailIndex(row.depth) } as React.CSSProperties;
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
    <section className={drag ? `${styles.card} ${styles.dragging}` : styles.card}>
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
          drag !== null && groupDropState(drag.draggedId, group.templateId, nodes, levels) === "foreign";
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
              <li key={row.node.id} data-node-id={row.node.id} className={rowClassName(row.node.id)} style={rowStyle(row)}>
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

                <button
                  type="button"
                  className={styles.dragHandle}
                  aria-label={`Drag ${row.node.name}`}
                  onPointerDown={(e) => handleDragPointerDown(row.node.id, e)}
                  onPointerMove={handleDragPointerMove}
                  onPointerUp={handleDragPointerUp}
                  onPointerCancel={handleDragPointerCancel}
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

      {drag && (
        <div
          className={`${styles.dragChip}${verdictBlocked ? " " + styles.dragChipBlocked : ""}${flip ? " " + styles.dragChipFlip : ""}`}
          style={{ left: drag.pointer.x, top: drag.pointer.y }}
          aria-hidden="true"
        >
          <span className={styles.dragChipName}>{draggedName}</span>
          {drag.verdict && <span className={styles.dragChipMsg}>{drag.verdict.message}</span>}
        </div>
      )}
      <p className={styles.srOnly} aria-live="polite">
        {drag?.verdict?.message ?? ""}
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
