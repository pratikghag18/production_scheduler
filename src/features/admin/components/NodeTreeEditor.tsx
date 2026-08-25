import { useState } from "react";
import { describeSchedulerError, type BoardNode, type HierarchyLevel } from "@/lib/api";
import {
  useCreateNode,
  useDeleteNode,
  useMoveNode,
  useRenameNode,
} from "../hooks/useHierarchyMutations";
import { buildTreeRows, legalParentsFor } from "../lib/treeView";
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
}: {
  nodes: BoardNode[];
  levels: HierarchyLevel[];
}) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [addRootOpen, setAddRootOpen] = useState(false);
  const [addRootName, setAddRootName] = useState("");

  const renameMutation = useRenameNode();
  const createMutation = useCreateNode();
  const moveMutation = useMoveNode();
  const deleteMutation = useDeleteNode();

  const rows = buildTreeRows(nodes, levels, collapsedIds);
  const byId = new Map(nodes.map((n) => [n.id, n]));

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
    <section className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.h2}>Nodes</h2>
        <button
          type="button"
          className={styles.addRootBtn}
          onClick={() => setAddRootOpen((v) => !v)}
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
            createMutation.mutate(
              { parentId: null, name: addRootName },
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
          <button type="submit" disabled={createMutation.isPending}>
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

      <ul className={styles.tree}>
        {rows.map((row) => (
          <li key={row.node.id} className={styles.row} style={{ paddingLeft: row.depth * 18 }}>
            {row.hasChildren ? (
              <button
                type="button"
                className={styles.disclosure}
                aria-label={row.collapsed ? `Expand ${row.node.name}` : `Collapse ${row.node.name}`}
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
