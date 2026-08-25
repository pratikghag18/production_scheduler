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
import type { HierarchyTemplateRef } from "./shapePicker.ts";
import { buildHierarchyTree, canDropOn } from "./hierarchy.ts";

export interface TreeRow {
  node: NodeRow;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /**
   * D90 — the ancestry trail that lets a FLAT row list draw tree guides.
   *
   * `guides[i]` is true when the ancestor at depth `i` has a further sibling
   * below this row, i.e. the vertical line at that indent must continue past
   * this row. Length is always `depth`.
   *
   * This exists because `flattenTree` deliberately produces a flat list — that
   * is what makes the tree keyboard-navigable, since up/down is index ±1 — and
   * a flat list has no containers whose borders could draw the guides for
   * free. Nesting `<ul>`s would give the lines for nothing and cost the
   * navigability, which is the wrong trade.
   */
  guides: readonly boolean[];
  /** True when this row is the last of its siblings — its elbow stops here. */
  isLastSibling: boolean;
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

  function walk(nodes: readonly TreeNode[], trail: readonly boolean[]) {
    nodes.forEach((n, i) => {
      const hasChildren = n.children.length > 0;
      const collapsed = collapsedIds.has(n.node.id);
      const isLastSibling = i === nodes.length - 1;
      out.push({
        node: n.node,
        depth: n.depth,
        hasChildren,
        collapsed,
        guides: trail,
        isLastSibling,
      });
      if (hasChildren && !collapsed) {
        // The line at THIS row's indent continues below only if this row has a
        // sibling after it — that is what makes a last child's guide stop
        // rather than running on into empty space.
        walk(n.children, [...trail, !isLastSibling]);
      }
    });
  }

  walk(tree, []);
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

// ---------------------------------------------------------------------------
// D90 — grouping the tree by site structure (design plan §19.24, option B)
// ---------------------------------------------------------------------------

/**
 * A tree row that also knows what its level is CALLED.
 *
 * Before D86 this was unnecessary: one vocabulary per org meant indentation
 * depth WAS the level, so an indent-only tree encoded everything. Per-site
 * shapes made that false — `Plant 2` sits at the same indent as `Plant 1`
 * while its children are Lines and `Plant 1`'s are Departments, and on a
 * two-level shape a Line is SCHEDULABLE, so two rows at equal indent can
 * differ in whether work can be booked on them at all.
 *
 * `levelName` is `null` only when the row's `levelId` is absent from `levels`,
 * which is not a state the server can produce (`nodes.level_id` is a composite
 * FK). It is representable here because a caller can pass a partial `levels`
 * array, and it must render as "unknown" rather than throw or vanish.
 */
export interface TreeRowWithLevel extends TreeRow {
  levelName: string | null;
}

/**
 * One site structure's slice of the tree.
 *
 * `templateId` is `null` for the trailing group of rows whose level — and so
 * whose structure — could not be resolved. That group exists so that a row can
 * never DISAPPEAR from a tree editor, which is the worst failure this function
 * could have: a node you cannot see is a node you cannot fix.
 */
export interface ShapeGroup {
  templateId: string | null;
  templateName: string | null;
  /** Level names in ascending position order — the heading's "Site › Line". */
  levelPath: readonly string[];
  rows: readonly TreeRowWithLevel[];
}

/**
 * Group flattened tree rows by the site structure each belongs to.
 *
 * A node's structure is its level's template (D86: `nodes` carries no template
 * column, deliberately — a node's template is its level's, and the adjacency
 * trigger requires a node and its parent to share one). So every row in a
 * subtree shares its root's structure, and grouping never splits a subtree.
 *
 * Row order WITHIN a group is the input order, untouched: that order is the
 * depth-first flatten, and re-sorting it would scramble the tree.
 *
 * Groups are ordered by template name using plain code-unit comparison with
 * `id` as the tie-break — NOT `localeCompare`, which is locale-dependent and
 * has already produced two different answers on two machines in this project.
 * The unresolved group, if any, always sorts last.
 *
 * A template with no nodes yields NO group: an empty heading in the tree would
 * be noise, and the Site Structure card is where an empty structure belongs.
 */
export function groupRowsByShape(
  rows: readonly TreeRow[],
  levels: readonly LevelRow[],
  templates: readonly HierarchyTemplateRef[],
): ShapeGroup[] {
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const templateName = new Map(templates.map((t) => [t.id, t.name]));

  const levelPathFor = (templateId: string): string[] =>
    levels
      .filter((l) => l.templateId === templateId)
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((l) => l.name);

  const byTemplate = new Map<string, TreeRowWithLevel[]>();
  const unresolved: TreeRowWithLevel[] = [];

  for (const row of rows) {
    const level = levelById.get(row.node.levelId);
    if (level === undefined) {
      unresolved.push({ ...row, levelName: null });
      continue;
    }
    const withLevel: TreeRowWithLevel = { ...row, levelName: level.name };
    const bucket = byTemplate.get(level.templateId);
    if (bucket === undefined) byTemplate.set(level.templateId, [withLevel]);
    else bucket.push(withLevel);
  }

  const groups: ShapeGroup[] = [...byTemplate.entries()].map(([templateId, groupRows]) => ({
    templateId,
    templateName: templateName.get(templateId) ?? null,
    levelPath: levelPathFor(templateId),
    rows: reseatRootGuides(groupRows),
  }));

  groups.sort((a, b) => {
    const an = a.templateName ?? "";
    const bn = b.templateName ?? "";
    if (an !== bn) return an < bn ? -1 : 1;
    const ai = a.templateId ?? "";
    const bi = b.templateId ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  if (unresolved.length > 0) {
    groups.push({
      templateId: null,
      templateName: null,
      levelPath: [],
      rows: reseatRootGuides(unresolved),
    });
  }
  return groups;
}

/**
 * Re-seat the depth-0 guide rail against the GROUP's roots, not the org's.
 *
 * `flattenTree` computes `guides` and `isLastSibling` over the whole tree,
 * where the sibling set at depth 0 is every root in the org. Grouping then
 * splits those roots across blocks — so a root that is not last overall can be
 * last *within its block*, and its descendants would otherwise keep drawing a
 * depth-0 rail that continues down to a sibling rendered in a different group.
 *
 * FOUND BY RENDERING IT, not by a test: all 45 `treeView` cases passed, because
 * each function is correct in isolation and the defect lives in their
 * COMPOSITION. A vertical line ran the full height of one group pointing at a
 * root that was above it, in the other.
 *
 * Only index 0 is re-seated. Every deeper rail is about siblings inside one
 * subtree, and grouping never splits a subtree (a node's structure is its
 * level's template, and adjacency forces a node and its parent to share one).
 */
function reseatRootGuides(rows: readonly TreeRowWithLevel[]): TreeRowWithLevel[] {
  let lastRootIndex = -1;
  rows.forEach((r, i) => {
    if (r.depth === 0) lastRootIndex = i;
  });
  if (lastRootIndex === -1) return [...rows];

  return rows.map((r, i) => {
    if (r.depth === 0) {
      return { ...r, isLastSibling: i === lastRootIndex };
    }
    const descendsFromLastRoot = i > lastRootIndex;
    if (r.guides.length === 0) return r;
    const guides = [...r.guides];
    guides[0] = !descendsFromLastRoot;
    return { ...r, guides };
  });
}
