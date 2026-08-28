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

/* ===========================================================================
 * P1-5l — DROP ZONES: reorder as well as re-parent (design plan §19.34, D94).
 *
 * ⭐ WHY THIS EXISTS. The first gesture the maintainer tried was the one P1-5g
 * excluded: *"I tried moving cell 3 between cell 1 and cell 2, but it turned
 * red."* Cells 1/2/3 are siblings, so that is a REORDER — and P1-5g only ever
 * offered re-parenting, so the pointer landed on a Work Cell row and
 * `canDropOn` correctly refused a re-parent he never attempted. The drag did
 * what the brief said; the brief was wrong.
 *
 * A row now offers up to THREE zones instead of one:
 *
 *     ┌──────────────── before ── place above this row, same parent
 *     │──────────────── adopt  ── become a child of this row  (P1-5g)
 *     └──────────────── after  ── place below this row, same parent
 *
 * ⭐ AND THE `noop` VERDICT IS WHAT MAKES A REORDER LEGAL, NOT ILLEGAL.
 * `canDropOn(dragged, referenceRow.parentId)` returns `noop` precisely when
 * the dragged node ALREADY has that parent — which is the definition of a
 * pure reorder. Treating `noop` as a refusal is the single mistake this whole
 * section exists to avoid, and it is the mistake the old code made by
 * omission. Adopt is the opposite: there, `noop` means "already a child of
 * this row", which really does nothing, so adopt keeps requiring `ok`.
 * ======================================================================== */

export type DropZoneKind = "before" | "adopt" | "after";

export interface DropZone {
  kind: DropZoneKind;
  /** The parent the dragged node ends up under if this zone is used. */
  parentId: string | null;
  /**
   * For `before`/`after`: the index to pass to `place_node`, counted among
   * the destination parent's children WITH THE DRAGGED NODE REMOVED — which
   * is exactly the list `place_node` splices into (it excludes `p_node_id`
   * before renumbering). `null` for `adopt`, which calls `move_node`.
   */
  index: number | null;
  verdict: DropVerdict;
}

/**
 * Sibling order comes from the ALREADY-FLATTENED rows, not from re-sorting
 * `nodes`. The index handed to the server has to mean the same thing the
 * admin just saw, and `flattenTree`'s output IS what they saw — re-deriving
 * the order here would be a second implementation of `compareSiblings` free
 * to drift from the one that painted the screen.
 *
 * Collapsing hides DESCENDANTS, never siblings, so a visible row's siblings
 * are all present in `rows` even when parts of the tree are collapsed.
 */
function siblingIndex(
  referenceId: string,
  parentId: string | null,
  excludeId: string | null,
  rows: readonly { node: NodeRow }[],
): number {
  let i = 0;
  for (const r of rows) {
    if (r.node.parentId !== parentId) continue;
    if (excludeId !== null && r.node.id === excludeId) continue;
    if (r.node.id === referenceId) return i;
    i += 1;
  }
  return i;
}

/**
 * Every zone this row legitimately offers, in top-to-bottom order.
 *
 * An EMPTY array means the row refuses the drag outright — which is a real
 * and common state (a Work Cell dragged over a Site row offers neither a
 * sibling slot nor an adoption) and is why the caller must handle zero.
 */
export function rowDropZones(
  draggedId: string,
  referenceId: string,
  rows: readonly { node: NodeRow }[],
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
  templates: readonly HierarchyTemplateRef[],
): DropZone[] {
  // A row cannot host a drop of itself: "above me" and "below me" are not
  // positions when the thing being placed IS me, and adopting yourself is
  // `node_cycle`. Handled here rather than left to canDropOn so that the row
  // reports NOTHING rather than a refusal message about itself.
  if (referenceId === draggedId) return [];

  const reference = findNode(referenceId, nodes);
  if (!reference) return [];

  const out: DropZone[] = [];

  // --- the sibling zones, which stand or fall together -------------------
  // Both ask ONE question -- "may the dragged node be a child of the
  // reference row's parent" -- so they are never individually legal.
  //
  // `canDropOn` directly, NOT `describeDrop`: the reference row may be a
  // ROOT, whose parent is `null`, and that is a legitimate destination --
  // reordering plants is a real (company-admin) operation and `place_node`
  // handles it. `describeDrop` takes a `string`, so routing a root through it
  // would mean inventing a sentinel id and asking about a node that does not
  // exist. `canDropOn` already takes `string | null` and already refuses a
  // null parent for anything not at level position 0.
  //
  // None of describeDrop's sentences are used here anyway: they are all about
  // adoption ("Move X into Y") and would be an actively wrong description of
  // a reorder.
  const sibling = canDropOn(
    draggedId,
    reference.parentId,
    nodes as NodeRow[],
    levels as LevelRow[],
  );
  // ⭐ `noop` COUNTS AS LEGAL. It is returned exactly when the dragged node
  // already has this parent -- which is the definition of a pure reorder, and
  // the case D94 was about.
  const siblingLegal = sibling.ok;

  if (siblingLegal) {
    const idx = siblingIndex(referenceId, reference.parentId, draggedId, rows);

    // ⭐ A PLACEMENT THAT LANDS WHERE THE NODE ALREADY IS OFFERS NOTHING, and
    // without this every drag drew one caret that promised a move and then did
    // nothing. `place_node` splices the dragged node into its siblings with
    // itself removed, so the result is unchanged exactly when the destination
    // parent is the node's CURRENT parent and the index equals the node's own
    // position in the full sibling list.
    //
    // It shows up twice, symmetrically: `after` on the row directly ABOVE the
    // dragged node, and `before` on the row directly BELOW it. Both are the
    // same seam — the one the node is already sitting on.
    //
    // The zone is DROPPED rather than flagged, so a row never has a dead half.
    // Where only one placement survives it takes the whole row, which is
    // already how an adopt-only row behaves.
    const currentIndex = siblingIndex(draggedId, reference.parentId, null, rows);
    const isNoop = (i: number): boolean =>
      reference.parentId === (findNode(draggedId, nodes)?.parentId ?? null) && i === currentIndex;

    const draggedName = nodeName(draggedId, nodes, "This node");
    const referenceName = nodeName(referenceId, nodes, "that node");
    if (!isNoop(idx)) {
      out.push({
        kind: "before",
        parentId: reference.parentId,
        index: idx,
        verdict: {
          kind: "ok",
          reason: null,
          message: `Place ${draggedName} above ${referenceName}.`,
        },
      });
    }
    if (!isNoop(idx + 1)) {
      out.push({
        kind: "after",
        parentId: reference.parentId,
        index: idx + 1,
        verdict: {
          kind: "ok",
          reason: null,
          message: `Place ${draggedName} below ${referenceName}.`,
        },
      });
    }
  }

  // --- the adopt zone, unchanged from P1-5g ------------------------------
  const adopt = describeDrop(draggedId, referenceId, nodes, levels, templates);
  if (adopt.kind === "ok") {
    out.push({ kind: "adopt", parentId: referenceId, index: null, verdict: adopt });
  }

  // NO SORT. `before`/`after` are pushed together and `adopt` after them, so
  // an ordering pass would only matter if a row could offer a sibling slot
  // AND an adoption at once -- which the theorem below `resolveDropZone`
  // rules out. A sort here was written, mutation-tested, and deleted: no case
  // could distinguish removing it from keeping it, and gotcha 17 says the
  // honest answer to an unfalsifiable line is to remove it.
  return out;
}

/**
 * ⭐ A ROW CAN NEVER OFFER ALL THREE ZONES, AND THAT IS A THEOREM, NOT AN
 * ACCIDENT OF THE FIXTURE.
 *
 * Adoption needs the dragged node to sit ONE RUNG BELOW the reference row.
 * A sibling slot needs it to sit one rung below the reference row's PARENT —
 * that is, on the SAME rung as the reference row. Every node in this schema
 * sits exactly one rung below its parent (the adjacency trigger enforces it),
 * so those two demands are contradictory: a row is either a peer of the
 * dragged node or a possible home for it, never both.
 *
 * So the band arithmetic this section was expected to need — a 25/50/25 or
 * 30/40/30 split, and an argument about how many pixels the sibling slots
 * deserve — does not exist. **The question answered itself.** There are only
 * ever two zones or one, and two zones split the row in half.
 *
 * Case P7 proves it by exhaustion over every (dragged, reference) pair in the
 * fixture rather than by repeating the argument above, because an argument is
 * not a measurement and a schema change could falsify this one silently.
 *
 * `offsetY` is measured from the row's top edge and is deliberately NOT
 * clamped — see the note in the body. A pointer a fraction of a pixel outside
 * the row, which happens constantly at the seam between two rows, still
 * resolves to the nearer half.
 *
 * The midpoint belongs to the LOWER zone (`t < 0.5` is "before"), matching
 * the convention that a boundary belongs to the band it opens.
 */
export function resolveDropZone(
  zones: readonly DropZone[],
  offsetY: number,
  rowHeight: number,
): DropZone | null {
  if (zones.length === 0) return null;
  if (zones.length === 1) return zones[0];

  // A zero, negative or non-finite height would make every boundary 0 and
  // hand back the last zone for any offset; the first is the safer answer and
  // is what a clamped offset of 0 would give anyway.
  if (!(rowHeight > 0)) return zones[0];
  if (!Number.isFinite(offsetY)) return zones[0];

  // NOT CLAMPED, for the same reason. Against a single 0.5 boundary a
  // negative offset is already below it and an over-long one already above
  // it, so clamping changes no answer -- proved by mutation, not argued. It
  // would only earn its keep with three or more bands.
  const t = offsetY / rowHeight;
  return t < 0.5 ? zones[0] : zones[1];
}
