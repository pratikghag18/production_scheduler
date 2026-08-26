/**
 * Pure drag-and-drop logic for the node tree (brief P1-5g §6).
 *
 * Dependency-free apart from two REAL value imports. `canDropOn` decides
 * legality; nothing in this file re-derives it. Every function here either
 * forwards `canDropOn`'s answer or asks a question about how to WORD it.
 *
 * `import type` only for the shared row/level/template shapes; `canDropOn`
 * and `legalParentsFor` are real value imports via relative `./x.ts` paths,
 * which `node --experimental-strip-types` resolves.
 */
import type { LevelRow, NodeRow } from "./hierarchy.ts";
import type { HierarchyTemplateRef } from "./shapePicker.ts";
import { canDropOn } from "./hierarchy.ts";
import { legalParentsFor } from "./treeView.ts";

export interface DropVerdict {
  kind: "ok" | "noop" | "blocked";
  /** canDropOn's own reason string, verbatim; null when the drop is legal. */
  reason: string | null;
  message: string;
}

function findNode(id: string, nodes: readonly NodeRow[]): NodeRow | undefined {
  return nodes.find((n) => n.id === id);
}

function nodeName(id: string, nodes: readonly NodeRow[], fallback: string): string {
  return findNode(id, nodes)?.name ?? fallback;
}

/**
 * `message` is chosen from the same `nodes`/`levels`/`templates` `canDropOn`
 * was given, and never changes `kind` — it only explains the `kind`/`reason`
 * `describeDrop` already computed. §6.3's table is a contract: every string
 * below must match it character for character.
 */
function buildMessage(
  kind: "ok" | "noop" | "blocked",
  reason: string | null,
  draggedId: string,
  targetParentId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
  templates: readonly HierarchyTemplateRef[],
): string {
  const draggedName = nodeName(draggedId, nodes, "This node");
  const targetName = nodeName(targetParentId, nodes, "that node");

  if (kind === "ok") {
    return `Move ${draggedName} into ${targetName}.`;
  }
  if (kind === "noop") {
    return `${draggedName} is already in ${targetName}.`;
  }

  // kind === "blocked"
  if (reason === "invalid_argument") {
    return `${draggedName} can't be moved right now.`;
  }
  if (reason === "node_cycle") {
    if (targetParentId === draggedId) {
      return `You can't drop ${draggedName} onto itself.`;
    }
    return `You can't move ${draggedName} into its own subtree.`;
  }
  if (reason === "path_collision") {
    return `${targetName} already has a child called ${draggedName}.`;
  }
  if (reason === "level_mismatch") {
    const dragged = findNode(draggedId, nodes);
    const draggedLevel = dragged ? levels.find((l) => l.id === dragged.levelId) : undefined;

    // Unreachable at runtime: canDropOn already returns `invalid_argument`
    // whenever the dragged node's level is missing, so `level_mismatch` can
    // never see this state. Kept anyway — it is load-bearing for narrowing,
    // since `draggedLevel` is looked up independently here and
    // `LevelRow | undefined` will not typecheck below without it. §9.3 (N1)
    // records this as executed-and-inert; do not delete it as dead code.
    if (!draggedLevel) {
      return `${draggedName} can't be moved right now.`;
    }

    const target = findNode(targetParentId, nodes);
    const targetLevel = target ? levels.find((l) => l.id === target.levelId) : undefined;

    // "Can we even name the structure" is asked before "is it the wrong
    // depth", because a message claiming "different structure" when the
    // truth is "we could not resolve the level at all" is a wrong
    // explanation, not a vaguer one.
    if (!targetLevel) {
      return `We can't tell which site structure ${targetName} belongs to.`;
    }

    // The structure branch precedes the depth branch (deliberately reversed
    // from canDropOn's own position-then-template order): when a drop is
    // BOTH cross-structure and wrong-depth, the structure is the dominant
    // fact. (V14.)
    if (draggedLevel.templateId !== targetLevel.templateId) {
      const draggedTemplate = templates.find((t) => t.id === draggedLevel.templateId);
      const targetTemplate = templates.find((t) => t.id === targetLevel.templateId);
      if (draggedTemplate && targetTemplate) {
        return `${draggedName} belongs to the ${draggedTemplate.name} structure, not ${targetTemplate.name}.`;
      }
      return `${draggedName} belongs to a different site structure.`;
    }

    // Same template from here on.
    if (draggedLevel.position === 0) {
      return `A ${draggedLevel.name} is always a top-level node.`;
    }

    // Scoped to the DRAGGED node's own template — a template-blind
    // `levels.find(l => l.position === p - 1)` can return a real row from
    // the OTHER structure and produce a confident wrong sentence. (E1.)
    const parentLevel = levels.find(
      (l) => l.templateId === draggedLevel.templateId && l.position === draggedLevel.position - 1,
    );
    if (!parentLevel) {
      return `A ${draggedLevel.name} has no level above it in this structure.`;
    }
    return `A ${draggedLevel.name} can only sit under a ${parentLevel.name}.`;
  }

  return `${draggedName} can't be moved right now.`;
}

export function describeDrop(
  draggedId: string,
  targetParentId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
  templates: readonly HierarchyTemplateRef[],
): DropVerdict {
  const result = canDropOn(draggedId, targetParentId, nodes as NodeRow[], levels as LevelRow[]);

  // Checked as `if (!result.ok)` FIRST, not as a compound `result.ok && ...`
  // condition — TypeScript's control-flow narrowing only follows the simple
  // discriminant check, so `result.reason` below needs this shape to
  // typecheck at all (`CanDropResult`'s `ok:false` arm is the only one that
  // carries `reason`).
  if (!result.ok) {
    return {
      kind: "blocked",
      reason: result.reason,
      message: buildMessage(
        "blocked",
        result.reason,
        draggedId,
        targetParentId,
        nodes,
        levels,
        templates,
      ),
    };
  }
  if (result.noop) {
    return {
      kind: "noop",
      reason: null,
      message: buildMessage("noop", null, draggedId, targetParentId, nodes, levels, templates),
    };
  }
  return {
    kind: "ok",
    reason: null,
    message: buildMessage("ok", null, draggedId, targetParentId, nodes, levels, templates),
  };
}

/**
 * `eligibleTargetIds` IS `legalParentsFor` — the menu's own list — with the
 * `(root)` entry dropped. Reusing it is the point: the rows highlighted
 * during a drag and the entries in "Move to…" are provably the same set,
 * because they are the same call.
 */
export function eligibleTargetIds(
  draggedId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): Set<string> {
  const out = new Set<string>();
  for (const choice of legalParentsFor(draggedId, nodes, levels)) {
    if (choice.id !== null) out.add(choice.id);
  }
  return out;
}

export type GroupDropState = "candidate" | "foreign";

/**
 * `"candidate"` only when `groupTemplateId` is non-null and equal to the
 * dragged node's level's template id; everything else — including a `null`
 * group id, an unknown dragged id, and a dragged node whose level is
 * unresolvable — is `"foreign"`.
 *
 * `"candidate"` is a DELIBERATELY WEAK claim: the block is not ruled out
 * wholesale, not that any particular row in it is legal. Only `"foreign"` is
 * strong — every row in a foreign block is refused by canDropOn's step 6b.
 */
export function groupDropState(
  draggedId: string,
  groupTemplateId: string | null,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): GroupDropState {
  if (groupTemplateId === null) return "foreign";

  const dragged = findNode(draggedId, nodes);
  if (!dragged) return "foreign";

  const draggedLevel = levels.find((l) => l.id === dragged.levelId);
  if (!draggedLevel) return "foreign";

  return draggedLevel.templateId === groupTemplateId ? "candidate" : "foreign";
}

/**
 * A row at depth `d` renders `d` guide rails (`guides.length === d`) plus one
 * elbow rail, so its elbow is rail index `d`. A new CHILD of that row sits at
 * depth `d + 1`, and its elbow is rail index `d + 1` — which is where the
 * adopt tick belongs, so it lines up with the elbows of the children the
 * target already has.
 *
 * Returned as a UNITLESS COUNT, never a pixel value — the rem arithmetic
 * stays in the stylesheet, where `scaleAudit` can read it.
 */
export function dropRailIndex(targetDepth: number): number {
  return targetDepth + 1;
}
