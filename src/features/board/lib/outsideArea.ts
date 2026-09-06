import type { BoardOperator } from "@/lib/api";
import { offeredHere } from "@/features/admin/lib/scope";
import type { BoardIndex } from "./boardIndex";

/**
 * D113: the people who do NOT belong at a cell -- the set the pickers annotate
 * "not from this area (override)" and ask a reason for.
 *
 * Extracted from `BoardPage` in session 76 so that the create pop-up and the
 * assignment pop-up (R-343, the person picker) decide it in ONE place. The
 * body is the page's, unchanged: it is the subject of R-342 (a person owned by
 * another plant is offered on this plant's board with no mark), and that fix
 * lands here, with its own test file beside it.
 *
 * Fails open on an unresolvable node for the same reason `offeredHere` does:
 * an empty set annotates nobody, and the server still decides.
 */
export function outsideAreaOperatorIds(
  operators: readonly BoardOperator[],
  nodeId: string | null,
  index: BoardIndex | null,
): Set<string> {
  const out = new Set<string>();
  if (nodeId === null || index === null) return out;
  const path = index.nodeById.get(nodeId)?.path;
  if (path === undefined) return out;
  const belongs = new Set(offeredHere(operators, path, index.nodeById).map((o) => o.id));
  for (const o of operators) if (!belongs.has(o.id)) out.add(o.id);
  return out;
}
