/**
 * Pure level-draft reducer (brief P1-5d §4.1).
 *
 * `save_hierarchy_levels` takes the whole ordered array and the array index
 * IS the position (D70), so "positions must be contiguous" is not a rule
 * this editor enforces -- a payload cannot express a gap. Every action here
 * is an array edit, never a partial patch.
 *
 * Never mutates the input (clones row OBJECTS too, not just the array --
 * §9's M5). An inapplicable action returns the SAME array reference so a
 * caller can detect a no-op cheaply and React bails out via Object.is.
 */

export interface LevelDraft {
  id: string | null;
  name: string;
  isSchedulable: boolean;
}

export type LevelAction =
  | { kind: "rename"; index: number; name: string }
  | { kind: "moveUp"; index: number }
  | { kind: "moveDown"; index: number }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "setSchedulable"; index: number };

export const MAX_LEVELS = 64;

/** Integer, in range for `draft`. Non-integer indices are always no-ops (L18). */
function inRange(draft: readonly LevelDraft[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < draft.length;
}

/** Shallow-clone every row object, not just the array (§9's M5 / L15). */
function cloneRows(draft: readonly LevelDraft[]): LevelDraft[] {
  return draft.map((row) => ({ ...row }));
}

export function applyLevelAction(
  draft: readonly LevelDraft[],
  action: LevelAction,
): readonly LevelDraft[] {
  switch (action.kind) {
    case "rename": {
      if (!inRange(draft, action.index)) return draft;
      if (draft[action.index].name === action.name) return draft;
      const next = cloneRows(draft);
      next[action.index] = { ...next[action.index], name: action.name };
      return next;
    }

    case "moveUp": {
      if (!inRange(draft, action.index) || action.index === 0) return draft;
      const next = cloneRows(draft);
      const i = action.index;
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    }

    case "moveDown": {
      if (!inRange(draft, action.index) || action.index === draft.length - 1) return draft;
      const next = cloneRows(draft);
      const i = action.index;
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    }

    case "add": {
      // The cap is checked with `>`, not `>=` (L12/L13/M1): a draft at
      // length 63 (63 + 1 = 64, not > 64) may still add a 64th row; a draft
      // at length 64 (64 + 1 = 65 > 64) may not add a 65th.
      if (draft.length + 1 > MAX_LEVELS) return draft;
      const next = cloneRows(draft);
      next.push({ id: null, name: "", isSchedulable: false });
      return next;
    }

    case "remove": {
      if (!inRange(draft, action.index)) return draft;
      // remove refuses to empty the list (L9/M2): save_hierarchy_levels
      // rejects an empty array, so an editor that let you empty it could
      // only offer a Save that always fails.
      if (draft.length <= 1) return draft;
      const next = cloneRows(draft);
      next.splice(action.index, 1);
      // Removing the schedulable level leaves NONE, deliberately (L8/M3).
      // Do NOT auto-promote another row -- silently choosing where all
      // scheduled work lives is not this editor's decision to make.
      return next;
    }

    case "setSchedulable": {
      if (!inRange(draft, action.index)) return draft;
      const already = draft[action.index].isSchedulable;
      const onlyOneSchedulable = already && draft.filter((r) => r.isSchedulable).length === 1;
      // setSchedulable on the row that is already the only schedulable one
      // is a no-op.
      if (onlyOneSchedulable) return draft;
      const next = cloneRows(draft);
      for (let i = 0; i < next.length; i++) {
        next[i] = { ...next[i], isSchedulable: i === action.index };
      }
      return next;
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Where to put error styling. `validateLevelDraft` (P1-5b) remains the
 * authority on WHETHER the draft is valid; this must tolerate a malformed
 * row rather than throw (L20).
 */
export function invalidNameIndices(draft: readonly LevelDraft[]): number[] {
  if (!Array.isArray(draft)) return [];
  const out: number[] = [];
  for (let i = 0; i < draft.length; i++) {
    const row = draft[i];
    const name =
      row === null || row === undefined ? "" : String((row as { name?: unknown }).name ?? "");
    if (name.trim() === "") out.push(i);
  }
  return out;
}

/* ===========================================================================
 * D92's CLIENT MIRROR — what this save would do to the nodes that already
 * exist. Design plan §19.30; server side is migration
 * 20260826000016_level_reorder_guard.sql.
 * ======================================================================== */

/**
 * THE AUTHORITY IS THE DATABASE. `save_hierarchy_levels` asks three questions
 * about existing nodes, and every one of them raises `level_in_use`:
 *
 *   check 7   a level being REMOVED still has nodes             (before the write)
 *   D92 #1    a root sits on a level whose position is not 0    (after the write)
 *   D92 #2    a child's level is not exactly one below its parent's  (after)
 *
 * `findLevelOrderProblems` is a PREVIEW of those three, so Save is not where
 * the admin first finds out. The invariant is one-way, as everywhere else here:
 * anything the client refuses, the server must also refuse — never the converse.
 *
 * ⭐ IT MIRRORS THE OUTCOME, NOT THE ACTION — and that is the whole point.
 * The obvious client rule, "grey out the arrows on any level that has nodes",
 * was this project's first written answer and it is WRONG. 0016 deliberately
 * refuses *an order whose RESULT strands a node*, not *a move of a level that
 * has nodes*, so that a database already scrambled by a pre-0016 save can be
 * dragged back into shape. Case L15 in `supabase/tests/70_hierarchy_test.sql`
 * IS that repair and it SUCCEEDS. A client that disabled those arrows would
 * forbid exactly the repair the server permits — the client stricter than the
 * server, the one direction this project forbids. So the arrows stay live, the
 * admin arranges freely, and SAVE is what goes dark, with the reason.
 *
 * Positions come from the DRAFT: the RPC takes the whole ordered array and the
 * array index IS the position (D70). A row with `id: null` is a level that does
 * not exist yet, so no node can be sitting on it.
 *
 * NEVER THROWS (verification-standard rule 4). A malformed draft row, an
 * unknown level id, a node whose parent is not in the list — each is skipped.
 */

/** Structurally satisfied by `HierarchyLevel` from `@/lib/api`. */
export interface LevelOrderLevel {
  id: string;
  templateId: string;
  position: number;
  name: string;
}

/** Structurally satisfied by `BoardNode` from `@/lib/api`. */
export interface LevelOrderNode {
  id: string;
  parentId: string | null;
  levelId: string;
}

export type LevelOrderProblemKind =
  | "level_removed_with_nodes"
  | "root_below_first_level"
  | "child_not_directly_below_parent";

export interface LevelOrderProblem {
  kind: LevelOrderProblemKind;
  levelId: string;
  /** the DRAFT's name while the level survives; its stored name once removed */
  levelName: string;
  /** how many existing nodes this problem covers */
  nodeCount: number;
}

const KIND_RANK: Record<LevelOrderProblemKind, number> = {
  level_removed_with_nodes: 0,
  root_below_first_level: 1,
  child_not_directly_below_parent: 2,
};

export function findLevelOrderProblems(
  draft: readonly LevelDraft[],
  levels: readonly LevelOrderLevel[],
  nodes: readonly LevelOrderNode[],
  templateId: string | null,
): LevelOrderProblem[] {
  if (templateId === null) return [];
  if (!Array.isArray(draft) || !Array.isArray(levels) || !Array.isArray(nodes)) return [];

  const draftIndexById = new Map<string, number>();
  const draftNameById = new Map<string, string>();
  for (let i = 0; i < draft.length; i++) {
    const row = draft[i] as LevelDraft | null | undefined;
    if (row === null || row === undefined) continue;
    if (typeof row.id !== "string") continue;
    draftIndexById.set(row.id, i);
    draftNameById.set(row.id, typeof row.name === "string" ? row.name : "");
  }

  const levelById = new Map<string, LevelOrderLevel>();
  for (const level of levels) {
    if (level === null || level === undefined) continue;
    if (typeof level.id !== "string") continue;
    levelById.set(level.id, level);
  }

  /**
   * Where a level sits once this save lands. A level of ANOTHER template keeps
   * the position it already has — every write in this RPC is scoped to
   * `template_id` (0014's single most consequential line), so this save does
   * not touch it.
   */
  function fateOf(levelId: string): number | "removed" | "unknown" {
    const idx = draftIndexById.get(levelId);
    if (idx !== undefined) return idx;
    const level = levelById.get(levelId);
    if (level === undefined) return "unknown";
    if (level.templateId !== templateId) return level.position;
    return "removed";
  }

  const nodeById = new Map<string, LevelOrderNode>();
  for (const node of nodes) {
    if (node === null || node === undefined) continue;
    if (typeof node.id !== "string") continue;
    nodeById.set(node.id, node);
  }

  const tally = new Map<string, LevelOrderProblem>();
  function count(kind: LevelOrderProblemKind, levelId: string): void {
    const key = kind + " " + levelId;
    const seen = tally.get(key);
    if (seen !== undefined) {
      seen.nodeCount += 1;
      return;
    }
    const drafted = (draftNameById.get(levelId) ?? "").trim();
    const stored = (levelById.get(levelId)?.name ?? "").trim();
    tally.set(key, {
      kind,
      levelId,
      levelName: drafted !== "" ? drafted : stored !== "" ? stored : "this level",
      nodeCount: 1,
    });
  }

  for (const node of nodes) {
    if (node === null || node === undefined) continue;
    if (typeof node.levelId !== "string") continue;
    const own = levelById.get(node.levelId);
    // Scope: exactly the server's `nl.template_id = v_template_id` and
    // `cl.template_id = v_template_id` — the template of the level the node
    // ITSELF sits on, never its parent's.
    if (own === undefined || own.templateId !== templateId) continue;

    const at = fateOf(node.levelId);
    if (typeof at !== "number") {
      // "unknown" cannot occur here: `own` was just found in the same map
      // `fateOf` consults. The branch exists for the narrowing that makes
      // `at` a number below, and is reported executed-and-inert.
      if (at === "removed") count("level_removed_with_nodes", node.levelId);
      continue;
    }

    if (node.parentId === null || node.parentId === undefined) {
      if (at !== 0) count("root_below_first_level", node.levelId);
      continue;
    }

    const parent = nodeById.get(node.parentId);
    if (parent === undefined) continue; // the server can see it; this list cannot
    const parentAt = fateOf(parent.levelId);
    // The parent's own level is being removed: check 7 refuses on THAT level
    // and the D92 pass never runs, so there is nothing to say about this row.
    if (typeof parentAt !== "number") continue;
    if (at !== parentAt + 1) count("child_not_directly_below_parent", node.levelId);
  }

  function orderKey(problem: LevelOrderProblem): number {
    const at = fateOf(problem.levelId);
    if (typeof at === "number") return at;
    return levelById.get(problem.levelId)?.position ?? 0;
  }

  return [...tally.values()].sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    const oa = orderKey(a);
    const ob = orderKey(b);
    if (oa !== ob) return oa - ob;
    if (a.levelId < b.levelId) return -1;
    if (a.levelId > b.levelId) return 1;
    return 0;
  });
}
