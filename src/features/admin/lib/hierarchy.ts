/**
 * Pure hierarchy-admin logic (brief P1-5b §4).
 *
 * Dependency-free: no imports, `import type` or otherwise. Every rule that
 * mirrors a database RPC (migration 20260825000010_hierarchy_admin.sql) is
 * a CLIENT-SIDE COPY ONLY — the RPC's own answer always wins (brief §5,
 * "the authority rule"). Nothing here writes anything; it only previews
 * what a write would do, so the UI can grey out an illegal drop target or
 * show inline validation before a round trip.
 */

// ---------------------------------------------------------------------------
// Types (brief §4)
// ---------------------------------------------------------------------------

export interface LevelRow {
  id: string;
  /**
   * D86: a level belongs to a hierarchy TEMPLATE, not to the org. One org may
   * hold several shapes, so `position` is unique only within a template and
   * two levels in the same org can both sit at position 1.
   */
  templateId: string;
  position: number;
  name: string;
  isSchedulable: boolean;
}

export interface NodeRow {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  levelId: string;
  sortOrder: number;
  active: boolean;
}

export interface TreeNode {
  node: NodeRow;
  depth: number;
  children: TreeNode[];
}

export interface LevelDraft {
  id: string | null;
  name: string;
  isSchedulable: boolean;
}

export type CanDropResult = { ok: true; noop: boolean } | { ok: false; reason: string };

export type ValidateLevelDraftResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// slugify — §6. The corpus IS the contract; mirrors the SQL `slugify()` in
// migration 20260821000001_extensions_and_core.sql exactly:
//
//   select case
//     when base = '' then 'n_'
//     when base ~ '^[0-9]' then 'n_' || base
//     else base
//   end
//   from (
//     select trim(both '_' from regexp_replace(lower(input), '[^a-z0-9]+', '_', 'g')) as base
//   ) s;
//
// Postgres does NOT transliterate accents — lower() on 'À' yields 'à', an
// accented lowercase letter, which still falls outside [a-z0-9] and gets
// collapsed. `.normalize("NFD")` is the wrong instinct here (§6, §10.2):
// it would strip 'À' down to a plain 'a', which the SQL never does.
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  const collapsed = input.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const base = collapsed.replace(/^_+/, "").replace(/_+$/, "");
  if (base === "") return "n_";
  if (/^[0-9]/.test(base)) return "n_" + base;
  return base;
}

// ---------------------------------------------------------------------------
// pathDepth / prospectivePath
// ---------------------------------------------------------------------------

/** Label count: `""` -> 0, `"a"` -> 1, `"a.b.c"` -> 3. */
export function pathDepth(path: string): number {
  return path === "" ? 0 : path.split(".").length;
}

/**
 * The path a node would get. A `null` OR EMPTY parent path (§4: "gets
 * passed `""` as well as `null` for a root parent, depending on the
 * caller" — §10 trap 5) yields the bare slug.
 */
export function prospectivePath(parentPath: string | null, name: string): string {
  const slug = slugify(name);
  if (parentPath === null || parentPath === "") return slug;
  return `${parentPath}.${slug}`;
}

/** The path one dot-level up from `path`, or `""` if `path` has one label. */
function pathParent(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * True when `maybeDescendantPath` is `ancestorPath` itself or beneath it,
 * on a dot boundary (§10 trap 3 / brief D16: `line_10` is NOT beneath
 * `line_1` — a bare `startsWith` without the separator would wrongly say
 * it is).
 */
function isSelfOrDescendantPath(ancestorPath: string, maybeDescendantPath: string): boolean {
  return maybeDescendantPath === ancestorPath || maybeDescendantPath.startsWith(ancestorPath + ".");
}

// ---------------------------------------------------------------------------
// buildHierarchyTree — §4
// ---------------------------------------------------------------------------

/** Total order for siblings: sortOrder, then name, then id (§10 trap 4). */
function compareSiblings(a: NodeRow, b: NodeRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Nested tree, roots first. Parent linkage comes from `path`, NEVER from
 * `parentId` (§4) — a node whose path-parent is absent from the input
 * becomes a root, which is what makes a mid-tree slice render correctly.
 * `depth` is `pathDepth(path) - 1`. `levels` is accepted for signature
 * symmetry with `canDropOn` (both take the same two collections) and for
 * any future depth/level cross-check; the tree-shape and ordering rules
 * specified by the brief depend only on `nodes` — see the deviations note
 * in the delivery report.
 */
export function buildHierarchyTree(nodes: NodeRow[], levels: LevelRow[]): TreeNode[] {
  void levels;

  const byPath = new Map<string, NodeRow>();
  for (const n of nodes) byPath.set(n.path, n);

  const childrenByParentPath = new Map<string, NodeRow[]>();
  const roots: NodeRow[] = [];

  for (const n of nodes) {
    const parentPath = pathParent(n.path);
    if (parentPath !== "" && byPath.has(parentPath)) {
      const list = childrenByParentPath.get(parentPath);
      if (list) {
        list.push(n);
      } else {
        childrenByParentPath.set(parentPath, [n]);
      }
    } else {
      roots.push(n);
    }
  }

  function build(n: NodeRow): TreeNode {
    const kids = (childrenByParentPath.get(n.path) ?? []).slice().sort(compareSiblings);
    return {
      node: n,
      depth: pathDepth(n.path) - 1,
      children: kids.map(build),
    };
  }

  return roots.slice().sort(compareSiblings).map(build);
}

// ---------------------------------------------------------------------------
// canDropOn — §4. Mirrors `move_node`'s checks IN THE SAME ORDER (migration
// 20260825000010_hierarchy_admin.sql §6.4) so the reason previewed here is
// the reason the server would give. Step numbers in the comments match the
// brief's own numbered list.
// ---------------------------------------------------------------------------

export function canDropOn(
  draggedId: string,
  targetParentId: string | null,
  nodes: NodeRow[],
  levels: LevelRow[],
): CanDropResult {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const levelsById = new Map(levels.map((l) => [l.id, l]));

  const dragged = nodesById.get(draggedId);
  const draggedLevel = dragged ? levelsById.get(dragged.levelId) : undefined;

  // 1. dragged node unknown, or its level id absent from `levels`.
  if (!dragged || !draggedLevel) {
    return { ok: false, reason: "invalid_argument" };
  }

  if (targetParentId === null) {
    // 2. NULL parent allowed only when the node's level position is 0;
    // then still check collision (falls through below).
    if (draggedLevel.position !== 0) {
      return { ok: false, reason: "level_mismatch" };
    }
    const prospective = prospectivePath(null, dragged.name);
    const collides = nodes.some((n) => n.id !== dragged.id && n.path === prospective);
    if (collides) return { ok: false, reason: "path_collision" };
    return { ok: true, noop: dragged.parentId === null };
  }

  // 3. self-parent.
  if (targetParentId === draggedId) {
    return { ok: false, reason: "node_cycle" };
  }

  const target = nodesById.get(targetParentId);

  // 4. unknown target.
  if (!target) {
    return { ok: false, reason: "invalid_argument" };
  }

  // 5. target is the node or one of its descendants. MUST precede 6 — every
  // move beneath one's own descendant also skips a level, so checking level
  // adjacency first would misreport a genuine cycle as level_mismatch
  // (design-plan §19.6 / P1-5a brief §6.4).
  if (isSelfOrDescendantPath(dragged.path, target.path)) {
    return { ok: false, reason: "node_cycle" };
  }

  // 6. node's level position must be exactly one below target's.
  const targetLevel = levelsById.get(target.levelId);
  if (!targetLevel || draggedLevel.position !== targetLevel.position + 1) {
    return { ok: false, reason: "level_mismatch" };
  }

  // 6b. D86: and both levels must belong to the SAME template. Position
  // arithmetic alone is not enough once an org holds more than one shape --
  // a Line at position 2 of shape A and a Department at position 1 of shape
  // B satisfy `2 === 1 + 1` and have nothing to do with each other.
  //
  // ORDER IS THE CONTRACT, as everywhere else in this function: the server's
  // `nodes_check_level_adjacency` (migration 0014) tests POSITION first and
  // TEMPLATE second, and raises `level_mismatch` for both. Reordering these
  // two would make this preview disagree with the server about WHICH rule a
  // drop broke, which is the one thing this mirror exists to get right.
  if (draggedLevel.templateId !== targetLevel.templateId) {
    return { ok: false, reason: "level_mismatch" };
  }

  // 7. path collision (excludes the dragged node itself — §10 / M10 trap).
  const prospective = prospectivePath(target.path, dragged.name);
  const collides = nodes.some((n) => n.id !== dragged.id && n.path === prospective);
  if (collides) return { ok: false, reason: "path_collision" };

  return { ok: true, noop: dragged.parentId === targetParentId };
}

// ---------------------------------------------------------------------------
// validateLevelDraft — §4. Mirrors `save_hierarchy_levels`' order for the
// checks it duplicates. §5's prose says "four of eight"; the brief's own §4
// list names FIVE reason codes and the server has nine checks — the prose is
// the error (confirmed against migration 0010, design-plan §19.12).
//
// The `?.` and `String(... ?? "")` guards are NOT defensive padding: they are
// server parity. Postgres reads a missing or null name as blank
// (`trim(coalesce(e->>'name','')) = ''`) and a null array element as
// non-schedulable, and returns a typed error for both. Without the guards this
// function THREW on all three, which is worse than a wrong answer — a
// validator the admin form calls on every keystroke must never throw
// (verification-standard rule 4; design-plan §19.12).
// ---------------------------------------------------------------------------

export function validateLevelDraft(draft: LevelDraft[]): ValidateLevelDraftResult {
  if (!Array.isArray(draft)) {
    return { ok: false, reason: "not_an_array" };
  }
  if (draft.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (draft.length > 64) {
    return { ok: false, reason: "too_many" };
  }
  const schedulableCount = draft.filter((d) => d?.isSchedulable === true).length;
  if (schedulableCount !== 1) {
    return { ok: false, reason: "schedulable_count" };
  }
  if (draft.some((d) => String(d?.name ?? "").trim() === "")) {
    return { ok: false, reason: "blank_name" };
  }
  return { ok: true };
}
