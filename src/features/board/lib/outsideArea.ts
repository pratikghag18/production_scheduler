import type { BoardOperator } from "@/lib/api";
import { isAtOrBelow } from "@/features/admin/lib/scope";
import type { BoardIndex } from "./boardIndex";

/**
 * D113: the people who do NOT belong at a cell -- the set the pickers annotate
 * "not from this area (override)" and ask a reason for.
 *
 * Extracted from `BoardPage` in session 76 so that the create pop-up and the
 * assignment pop-up (R-343, the person picker) decide it in ONE place.
 *
 * ---------------------------------------------------------------------------
 * R-342: THIS USED TO CALL `offeredHere` AND IT WAVED THROUGH THE ONE PERSON
 * THE SERVER IS CERTAIN TO REFUSE.
 *
 * The maintainer, on the live app: "I was assigning plant A, I was able to
 * select operators from any other plants for example plant B in the list and
 * it did not show any warning whatsoever in direct assignment tab."
 *
 * The old body asked `offeredHere(operators, path, index.nodeById)`, and
 * `offeredAt` under it FAILS OPEN on an owner it cannot resolve -- correctly,
 * for a map narrowed by PERMISSION, which is the case its header argues about.
 * This map is not that. `board_window` sends every operator in the org
 * (`FROM operators op WHERE op.org_id = v_org_id`) and only the selected
 * plant's nodes (`scoped_nodes`, `n.path <@ p_root_path`), so a person owned by
 * Plant B arrives with an owner id that is not in `nodeById` at all -- and the
 * fail-open read that absence as "cannot tell" and answered "belongs". Every
 * out-of-plant person was therefore unmarked, and `create_assignment` refused
 * them on Save with `not_offered_here` against a form that had asked for
 * nothing. That is the same mistake, in the same map, that `ownedInScope`'s
 * header records paying for once already.
 *
 * ⭐ SO THE RULE HERE IS NOW THE SERVER'S, TRANSCRIBED. `app_owner_covers_in_org`
 * (0028 §3, the predicate `app_guard_assignment_scope` calls) is
 *
 *     EXISTS (SELECT 1 FROM nodes o, nodes n
 *              WHERE o.id = owner AND n.id = cell AND o.path @> n.path)
 *
 * -- the owner must EXIST and be an ancestor-or-self of the cell. An owner row
 * that is not there makes that EXISTS false, which is a refusal, not a shrug.
 * `isAtOrBelow` is the same test on the same ltree paths (`@>` is reflexive, so
 * the cell's own owner and every ancestor above it belong).
 *
 * ⚠️ THE ONE FAIL-OPEN LEFT IS THE CELL, and it is a different question. If we
 * cannot resolve the CELL there is nothing to compare anybody against, so the
 * honest answer is an empty set, which annotates nobody and leaves the server
 * to decide -- the not-yet-loaded board (`emptyIndex`) and a popover whose node
 * is not in this window both land there.
 *
 * ⚠️ THE COST, STATED: a supervisor granted a LINE reads a board whose
 * `nodeById` starts at that line, so a person owned by the PLANT above it --
 * whom the server accepts -- is marked here and asked for a reason. That is the
 * side CLAUDE.md section 4 names as the acceptable one: a screen that refuses
 * what the server allows, loudly and with a way through (the override is a
 * reason, not a wall, and 0030's trigger normalises the flag back off when the
 * row did not need it), rather than a screen that offers what the server will
 * refuse.
 */
export function outsideAreaOperatorIds(
  operators: readonly BoardOperator[],
  nodeId: string | null,
  index: BoardIndex | null,
): Set<string> {
  const out = new Set<string>();
  if (nodeId === null || index === null) return out;
  const cellPath = index.nodeById.get(nodeId)?.path;
  if (cellPath === undefined) return out;
  for (const o of operators) {
    const owner = index.nodeById.get(o.siteNodeId);
    // No owner node on this board -> it cannot be an ancestor of a cell on this
    // board -> outside. This branch IS R-342.
    if (owner === undefined || !isAtOrBelow(cellPath, owner.path)) out.add(o.id);
  }
  return out;
}
