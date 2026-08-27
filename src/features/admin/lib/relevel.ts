/* ---------------------------------------------------------------------------
   P1-5k, CLIENT HALF — WHEN IS "MOVE THIS UP A RUNG" WORTH OFFERING?

   The SQL half shipped in migration 0017 and has been applied and tested since.
   This module is the part that decides what the `⋮` menu SHOWS, and it exists
   for one reason: a menu entry that is always enabled and usually refused is
   worse than no menu entry. Everything here mirrors a rule that
   `app_relevel_subtree` already enforces; NOTHING here is the authority.

   ⭐ WHICH DIRECTION EACH MIRROR FAILS, BECAUSE THEY ARE NOT THE SAME
   (verification-standard rule 8b). This module decides only what a menu
   OFFERS, so every mirror here fails OPEN: when a fact cannot be resolved from
   the arrays it was handed -- a level missing from `levels`, a parent missing
   from `nodes` -- it OFFERS the action and lets the server refuse. The
   forbidden direction is refusing client-side something the server would
   accept, because that is invisible: the user simply never sees the option.

   ⚠️ WHAT IT DELIBERATELY CANNOT SEE, AND SO NEVER PREDICTS: scheduled work.
   `app_relevel_subtree`'s most important refusal is that the move would leave
   runs or assignments on a node that has just left the schedulable rung, and
   the admin tree has no run or assignment counts in it at all. Predicting that
   from here would mean loading the whole schedule to draw a menu. So the offer
   is made, the server refuses, and migration 0024 is what makes that refusal
   arrive as `schedulable_level_locked` with a `blocking_rows` count instead of
   an undecodable payload that rendered as "Something went wrong."

   ⚠️ AND WHY `canDropOn` IS NOT REUSED HERE, WHICH LOOKS LIKE THE OBVIOUS MOVE.
   `canDropOn` answers "may this node become a child of that one AT ITS CURRENT
   LEVEL" -- target position must be exactly one ABOVE the node's. A demote
   changes the node's level as part of the same operation, so its target sits at
   the node's OWN position, which `canDropOn` refuses by construction. They are
   different questions about the same tree, not two copies of one question, and
   `demoteTargets` below states its rule once.
   --------------------------------------------------------------------------- */

import type { LevelRow, NodeRow } from "./hierarchy.ts";

/** Why a promote is not on offer. */
export type PromoteBlock =
  /** A top-level node has no rung above it. `promote_node` raises `level_mismatch`. */
  | { kind: "root" }
  /**
   * The destination parent already has a child with this exact name, so the
   * move would raise `path_collision` (migration 0024). `underLabel` is the
   * destination's path, or `""` when the destination is the top level.
   */
  | { kind: "name-taken"; existingId: string; underLabel: string };

export type PromoteVerdict = { ok: true } | { ok: false; block: PromoteBlock };

/** Why no demote is possible at all, whatever the target. */
export type DemoteBlock =
  /**
   * Some level in this subtree has no rung beneath it in its own structure.
   * The server checks this UP FRONT for a measured reason: before that guard
   * existed a demote off the bottom of a template half-succeeded and left the
   * tree corrupt (§19.33 §4).
   */
  | { kind: "no-rung-below" }
  /** There is nowhere to put it: no other node sits at this node's own level. */
  | { kind: "no-targets" };

export interface DemoteTarget {
  id: string;
  /**
   * The PATH, not the name -- the same choice `legalParentsFor` makes and for
   * the same measured reason: names are unique among SIBLINGS only, so three
   * departments may each hold a "Line 1" and a name-labelled list renders
   * identical rows the user picks between at random.
   */
  label: string;
  /**
   * Non-null when this target would be refused for a reason visible from here.
   * The target is still LISTED: "you cannot put it there, and here is why" is
   * more use than a shorter list with no explanation.
   */
  blocked: "name-taken" | null;
}

export type DemoteVerdict =
  | { ok: true; targets: DemoteTarget[] }
  | { ok: false; block: DemoteBlock };

// ---------------------------------------------------------------------------
// Shared helpers. One implementation of "what is in this subtree", used by
// both the rung check and the target filter, so the two cannot disagree about
// what the subtree is.
// ---------------------------------------------------------------------------

/**
 * Every id in `nodeId`'s subtree, including `nodeId` itself.
 *
 * Walked through `parentId`, NOT through `path` string prefixes. `path` would
 * work -- it is what the server uses -- but it would make this module depend on
 * how `slugify` renders a name, and on `.` never appearing inside a label.
 * Walking the links assumes nothing.
 *
 * Termination does not depend on the tree being acyclic: the visited set is
 * checked before descending, so a cycle in a corrupt array is walked once and
 * stops. An explicit iteration guard was written here first and DELETED -- it
 * was a branch nothing could ever reach, and an unreachable branch is one no
 * mutation can catch (verification-standard rule 7d). K5 pins the termination.
 */
export function subtreeIds(nodeId: string, nodes: readonly NodeRow[]): Set<string> {
  const byParent = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const bucket = byParent.get(n.parentId);
    if (bucket) bucket.push(n);
    else byParent.set(n.parentId, [n]);
  }
  const out = new Set<string>();
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byParent.get(id) ?? []) queue.push(child.id);
  }
  return out;
}

function levelOf(node: NodeRow | undefined, levels: readonly LevelRow[]): LevelRow | undefined {
  if (node === undefined) return undefined;
  return levels.find((l) => l.id === node.levelId);
}

function nodeById(id: string | null, nodes: readonly NodeRow[]): NodeRow | undefined {
  if (id === null) return undefined;
  return nodes.find((n) => n.id === id);
}

/**
 * Does a name already exist among the children of `parentId`? `null` means the
 * top level.
 *
 * `nodes` is `unique (org_id, parent_id, name)`, so this is the client's view
 * of the constraint migration 0024 pre-checks server-side. Comparison is exact,
 * NOT case-folded or trimmed: the constraint is on the stored name, and
 * `app_trim_ws` has already run on every stored name (0011).
 *
 * ⚠️ IT DOES NOT EXCLUDE THE MOVING SUBTREE, AND THAT IS NOT AN OVERSIGHT. A
 * first draft took the moving ids and filtered them out; that filter could
 * never fire, because the destination is never a node inside the subtree being
 * moved -- promote's destination is the grandparent, and `demoteTargets` skips
 * every candidate the subtree contains. A branch nothing can reach is a branch
 * no test can catch (rule 7d), so it was deleted rather than written and
 * excused. K16 pins the demote half of that guarantee directly.
 *
 * The node's own PARENT is a legitimate match and is deliberately kept: a node
 * named the same as its parent, promoted, really would collide with it, and
 * the server really does refuse it. K9.
 */
function nameTakenUnder(
  parentId: string | null,
  name: string,
  nodes: readonly NodeRow[],
): NodeRow | undefined {
  return nodes.find((n) => n.parentId === parentId && n.name === name);
}

/**
 * The level a node would END UP ON, one rung up (`delta` -1) or down (+1).
 *
 * This exists so the menu can say "Make this a Department" instead of "Promote"
 * — the levels already have the org's own words for its rungs (D90: the UI
 * speaks the customer's vocabulary), and a menu entry naming the destination is
 * the difference between a control a plant manager reads and one they guess at.
 *
 * `null` when there is no such rung, or when the node or its level cannot be
 * resolved. A caller with `null` should fall back to generic wording rather
 * than hide the control — whether the action is OFFERED is `promoteVerdict`'s
 * and `demoteTargets`' decision, not this function's.
 */
export function destinationLevel(
  nodeId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
  delta: -1 | 1,
): LevelRow | null {
  const own = levelOf(nodeById(nodeId, nodes), levels);
  if (own === undefined) return null;
  return (
    levels.find((l) => l.templateId === own.templateId && l.position === own.position + delta) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Promote
// ---------------------------------------------------------------------------

/**
 * `promote_node` takes ONLY a node id and derives the destination itself (the
 * grandparent, or the top level). This function deliberately returns no
 * destination for the caller to pass on -- there is one derivation of that and
 * it lives in the database. The grandparent is resolved here only to answer the
 * name question, and if it cannot be resolved the answer is "offer it".
 */
export function promoteVerdict(nodeId: string, nodes: readonly NodeRow[]): PromoteVerdict {
  const node = nodeById(nodeId, nodes);
  if (node === undefined) return { ok: true }; // unknown node: let the server say so
  if (node.parentId === null) return { ok: false, block: { kind: "root" } };

  const parent = nodeById(node.parentId, nodes);
  if (parent === undefined) return { ok: true }; // partial tree: fail OPEN

  const destinationId = parent.parentId; // null means the node becomes a root
  const clash = nameTakenUnder(destinationId, node.name, nodes);
  if (clash !== undefined) {
    const destination = nodeById(destinationId, nodes);
    return {
      ok: false,
      block: { kind: "name-taken", existingId: clash.id, underLabel: destination?.path ?? "" },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Demote
// ---------------------------------------------------------------------------

/**
 * Every node this one could be demoted under: same structure, the node's OWN
 * level, outside its own subtree.
 *
 * The rung check comes first and is expressed exactly as the server expresses
 * it -- EVERY DISTINCT LEVEL in the subtree needs a rung beneath it, not just
 * the deepest one. The two statements happen to coincide on any tree the
 * adjacency trigger allows; writing the weaker one would still be a different
 * rule from the server's, and the point of a mirror is that it cannot drift.
 */
export function demoteTargets(
  nodeId: string,
  nodes: readonly NodeRow[],
  levels: readonly LevelRow[],
): DemoteVerdict {
  const node = nodeById(nodeId, nodes);
  const ownLevel = levelOf(node, levels);
  // ⚠️ THE ONE PLACE THE FAIL-OPEN RULE ABOVE DOES NOT APPLY, AND IT IS NOT A
  // LOOPHOLE: a demote REQUIRES a target the user picks, so when the node or
  // its level cannot be resolved there is no list to draw. "Nothing to offer"
  // is the only representable answer, not a refusal this module invented.
  if (node === undefined || ownLevel === undefined) {
    return { ok: false, block: { kind: "no-targets" } };
  }

  const moving = subtreeIds(nodeId, nodes);

  const subtreeLevels: LevelRow[] = [];
  for (const n of nodes) {
    if (!moving.has(n.id)) continue;
    const l = levelOf(n, levels);
    if (l !== undefined && !subtreeLevels.some((s) => s.id === l.id)) subtreeLevels.push(l);
  }
  const hasRungBelow = (l: LevelRow): boolean =>
    levels.some((c) => c.templateId === l.templateId && c.position === l.position + 1);
  if (!subtreeLevels.every(hasRungBelow)) {
    return { ok: false, block: { kind: "no-rung-below" } };
  }

  const targets: DemoteTarget[] = [];
  for (const candidate of nodes) {
    if (moving.has(candidate.id)) continue; // itself, and anything beneath it
    const candidateLevel = levelOf(candidate, levels);
    if (candidateLevel === undefined) continue;
    if (candidateLevel.templateId !== ownLevel.templateId) continue;
    if (candidateLevel.position !== ownLevel.position) continue;
    const clash = nameTakenUnder(candidate.id, node.name, nodes);
    targets.push({
      id: candidate.id,
      label: candidate.path,
      blocked: clash === undefined ? null : "name-taken",
    });
  }

  if (targets.length === 0) return { ok: false, block: { kind: "no-targets" } };
  targets.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { ok: true, targets };
}
