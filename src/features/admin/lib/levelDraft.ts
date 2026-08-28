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
  /**
   * P1-5i (design plan §19.35, §19.48) — a drag from one position to another,
   * as ONE action rather than a chain of adjacent swaps.
   *
   * `to` is the index the row should END UP AT in the resulting array, which
   * is what a caret between two rows means — and is NOT the same as "the row
   * it was dropped above" once the dragged row has been lifted out. The
   * reducer arm below carries the reason.
   *
   * The level list is the EASY half of this build: the array index IS the
   * stored position (D70), there is no illegal target, and P1-5j's Save gate
   * already refuses an order that would strand nodes. So a level drag is a
   * pure draft edit — no server call, no `canDropOn`.
   */
  | { kind: "moveTo"; from: number; to: number }
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

    case "moveTo": {
      // Both ends must be real positions. `to` may be at most
      // `draft.length - 1`: `moveTo` REPOSITIONS an existing row, so the array
      // never grows and "past the end" is not a destination.
      if (!inRange(draft, action.from) || !inRange(draft, action.to)) return draft;
      if (action.from === action.to) return draft;

      // ⭐ SPLICE OUT, THEN SPLICE IN — and the order is the whole subtlety.
      // Removing the row first shifts every later index down by one, so `to`
      // is interpreted against the SHORTENED array, which is exactly what a
      // caret means: "the row ends up here", counted without itself. Doing it
      // the other way round makes a downward drag land one short — the
      // classic off-by-one in every list-reorder implementation, and the
      // reason this is one action rather than a chain of adjacent swaps the
      // caller has to compose correctly. Case L12 pins the equivalence.
      const next = cloneRows(draft);
      const [row] = next.splice(action.from, 1);
      next.splice(action.to, 0, row);
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
  "level_removed_with_nodes" | "root_below_first_level" | "child_not_directly_below_parent";

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

/* ---------------------------------------------------------------------------
   P1-6e — WHERE A LEVEL DRAG LANDS, AND THE TWO SEAMS THAT PROMISE NOTHING.

   §19.50 closed exactly this on the NODE TREE, in `treeDrag.ts`'s
   `rowDropZones`. The level list has its own copy of the rule and never got
   the fix, because nobody could reach the gesture to notice: the drag shipped
   in P1-5l and its grab target was 21 px of 526.

   MEASURED once the grip made it reachable -- real markup, real stylesheet,
   real layout engine, the component's own handlers driven over it, and the
   result fed through the real `applyLevelAction`: on a four-row list,
   231 of 528 drop pixels (43.8%) drew a caret and changed nothing. Two dead
   seams per drag, on every drag, exactly as §19.50's second theorem says they
   must be -- the seam directly above the dragged row and the seam directly
   below it, which are the two places it already sits.

   ⭐ AND THE SAME MEASUREMENT PROVED THE ALGEBRA CORRECT: across all 528 drop
   pixels the caret's promise and `applyLevelAction`'s result agreed 528 times
   out of 528, in both directions. The off-by-one below is right; what was
   wrong was offering a move that is not a move.

   THE RULE, AND WHY IT IS NOT THE TREE'S RULE.
   §19.50 DROPS the dead zone and the row's surviving placement (adopt) takes
   the whole row. A level row has no second meaning to fall back on -- it is
   one seam per half and nothing else -- so dropping the zone would leave a
   dead half-row with no feedback at all. Instead the dead half COLLAPSES INTO
   THE LIVE ONE: the whole of the row above the dragged row means "land above
   it", the whole of the row below means "land below it". Same principle
   (§19.50's own words: "dropping it lets the surviving placement take the
   whole row"), different mechanics, because a flat list has no adopt.

   ⚠️ AND THE DRAGGED ROW IS NOT A SPECIAL CASE. Both of its halves are dead,
   so both candidates below are refused and this returns `null` -- no caret,
   which is what its 0.45 opacity is already saying. An explicit
   `overIndex === from` branch was written first and DELETED: it is a second
   copy of a check that always holds, which is gotcha 17 and cannot be
   mutation-tested. The general rule subsumes it, and case P12 pins that.
   --------------------------------------------------------------------------- */

/** What a live level drag is currently promising. */
export interface LevelDropTarget {
  /**
   * The seam the caret is drawn on, counted against the list AS DRAWN -- that
   * is, with the dragged row still in it. Seam `i` is the gap above row `i`.
   * ALWAYS `overIndex` or `overIndex + 1`, never anything else: the collapse
   * only ever flips a caret to the other edge of the SAME row, so one row and
   * only one row ever draws it. P13 asserts that as a property.
   */
  caretAt: number;
  /**
   * `moveTo`'s `to`, counted against the list with the dragged row already
   * REMOVED. Guaranteed never to equal `from`, so every target this function
   * returns is one that changes something.
   */
  landAt: number;
}

/**
 * @param from       index of the row being dragged
 * @param overIndex  index of the row under the pointer
 * @param above      pointer is in the top half of that row (`t < 0.5`)
 * @param count      number of rows in the draft
 */
export function levelDropTarget(
  from: number,
  overIndex: number,
  above: boolean,
  count: number,
): LevelDropTarget | null {
  if (!Number.isInteger(from) || !Number.isInteger(overIndex) || !Number.isInteger(count)) {
    return null;
  }
  if (from < 0 || from >= count) return null;
  if (overIndex < 0 || overIndex >= count) return null;

  // A placement that lands where the row already is: seam `from` (immediately
  // above it) and seam `from + 1` (immediately below it). They are the same
  // position approached from either side -- §19.50's companion theorem.
  const isNoop = (seam: number): boolean => seam === from || seam === from + 1;

  // Seam `i` is the gap ABOVE row `i`, so the top half of row `i` is seam `i`
  // and the bottom half is seam `i + 1` -- the same convention `resolveDropZone`
  // uses on the tree, including that the midpoint belongs to the lower zone.
  // The half the pointer is actually in is tried FIRST; the other edge of the
  // same row is the collapse target.
  const wanted = above ? overIndex : overIndex + 1;
  const other = above ? overIndex + 1 : overIndex;
  const caretAt = !isNoop(wanted) ? wanted : !isNoop(other) ? other : null;
  if (caretAt === null) return null;

  // ⭐ THE OFF-BY-ONE, AND IT NOW LIVES SOMEWHERE A TEST CAN REACH IT. It used
  // to be `landingIndex` inside `LevelEditor.tsx`: documented at length and
  // guarded by nothing. `moveTo`'s `to` is read against the list with the
  // dragged row already spliced out, so every seam BELOW that row shifts down
  // by one and every seam above it does not.
  //
  // ⚠️ `<`, not `<=`, and the two are INDISTINGUISHABLE HERE -- mutation W5,
  // executed and measured INERT against all 25 cases. `caretAt` can never BE
  // `from`, because `isNoop` refuses that seam. The inertness is a consequence
  // of the collapse above, not of this line, so case P25 pins `caretAt !== from`
  // directly: delete the collapse and P25 goes red in the same run that makes
  // W5 live again.
  return { caretAt, landAt: from < caretAt ? caretAt - 1 : caretAt };
}
