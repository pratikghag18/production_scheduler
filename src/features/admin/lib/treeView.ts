/**
 * Pure tree rows + legal parents (brief P1-5d §4.2).
 *
 * Builds on P1-5b's `src/features/admin/lib/hierarchy.ts` and must not
 * duplicate it: `buildHierarchyTree` assembles the nested shape from a flat
 * node list, and `canDropOn` is the ONE implementation of "is this a legal
 * parent" -- it will shortly have three consumers (this picker, P1-5e's
 * drag preview, and the server). `legalParentsFor` only asks it questions.
 *
 * Type-only imports for the types; `canDropOn`/`buildHierarchyTree` as real
 * value imports via a relative `./hierarchy.ts` path, which
 * `node --experimental-strip-types` resolves because it is relative with an
 * explicit extension.
 */
import type { LevelRow, NodeRow, TreeNode } from "./hierarchy.ts";
import { buildHierarchyTree, canDropOn } from "./hierarchy.ts";

export interface TreeRow {
  node: NodeRow;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

export interface ParentChoice {
  id: string | null;
  label: string;
}

export const ROOT_LABEL = "(root)";

/**
 * Depth-first flatten that skips the descendants of a collapsed node. A
 * flat list is what makes the tree keyboard-navigable (up/down is index
 * ±1). `collapsedIds` is a Set: an unknown id means "expanded" -- there is
 * no lookup table to keep in sync with the node list, which is what stops
 * a stale collapse state from hiding rows after a refetch.
 */
export function flattenTree(
  tree: readonly TreeNode[],
  collapsedIds: ReadonlySet<string>,
): TreeRow[] {
  const out: TreeRow[] = [];

  function walk(nodes: readonly TreeNode[]) {
    for (const n of nodes) {
      const hasChildren = n.children.length > 0;
      const collapsed = collapsedIds.has(n.node.id);
      out.push({ node: n.node, depth: n.depth, hasChildren, collapsed });
      if (hasChildren && !collapsed) {
        walk(n.children);
      }
    }
  }

  walk(tree);
  return out;
}

/**
 * Every legal parent for `nodeId`, built by asking `canDropOn` about every
 * candidate (root, plus every other node) -- never reimplementing the
 * rules. A `noop` result (dropping onto the current parent) is excluded:
 * it is accepted by the server and does nothing, so offering "move to
 * where it already is" is noise, not an error.
 *
 * `(root)` needs no special-casing and cannot have any: a root move
 * requires the node's level position to be 0, and a move under a node
 * requires the target's position to be exactly one LESS than the node's
 * (i.e. -1), which no level has. So `(root)` is either the only entry or
 * absent -- §8's P8 proves it. An earlier draft sorted `(root)` explicitly
 * to the front; that branch was unreachable for any list longer than one
 * (an unreachable branch is one no mutation can catch), so it is not here.
 *
 * Sorted by label so the picker is stable between renders. §10 trap 2: a
 * result set of 0 or 1 entries makes a sort untestable -- P12 is the one
 * fixture built with candidates in a non-sorted insertion order.
 */
export function legalParentsFor(
  nodeId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): ParentChoice[] {
  // §6.3 debt 2: always pass canDropOn the COMPLETE level array. A partial
  // one makes the client reject a move the server would accept -- the
  // forbidden direction of §5's invariant. `levels` here is exactly what
  // the caller gave us, unfiltered.
  const nodesArr = nodes as NodeRow[];
  const levelsArr = levels as LevelRow[];

  const choices: ParentChoice[] = [];

  const rootResult = canDropOn(nodeId, null, nodesArr, levelsArr);
  if (rootResult.ok && !rootResult.noop) {
    choices.push({ id: null, label: ROOT_LABEL });
  }

  for (const candidate of nodes) {
    if (candidate.id === nodeId) continue;
    const result = canDropOn(nodeId, candidate.id, nodesArr, levelsArr);
    if (result.ok && !result.noop) {
      // The PATH, not the name. `nodes` is `unique (org_id, parent_id, name)`,
      // so names are unique among SIBLINGS ONLY -- three departments may each
      // hold a "Line 1", and all three are legal parents for a cell. Labelling
      // by name then renders two or more IDENTICAL rows with nothing to tell
      // them apart, and the user picks one at random. Measured, not supposed:
      // see the duplicate-label case in src/test/treeView.test.ts. `path` is
      // unique per `(org_id, path)`, so it cannot collide.
      choices.push({ id: candidate.id, label: candidate.path });
    }
  }

  choices.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return choices;
}

/** `buildHierarchyTree` + `flattenTree`, the shape `NodeTreeEditor` renders. */
export function buildTreeRows(
  nodes: NodeRow[],
  levels: LevelRow[],
  collapsedIds: ReadonlySet<string>,
): TreeRow[] {
  const tree = buildHierarchyTree(nodes, levels);
  return flattenTree(tree, collapsedIds);
}
