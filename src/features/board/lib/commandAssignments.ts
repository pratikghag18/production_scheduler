import type { BoardIndex } from "./boardIndex";
import type { ContextAssignment } from "@/lib/command/resolve";
import { addMinutes, formatClock } from "./time";

/**
 * R-385: the command bar's view of the window's blocks. The effective part of a
 * run-attached block is its run's product; a departed person's block (D110,
 * operatorId null) is carried with null and never matches. The label is the same
 * `formatClock` pair the run label in `BoardPage` is built from.
 */
export function commandAssignments(
  index: Pick<BoardIndex, "assignmentById" | "runById" | "windowStart" | "zone">,
): ContextAssignment[] {
  const out: ContextAssignment[] = [];
  for (const a of index.assignmentById.values()) {
    const productId =
      a.productId ?? (a.runId ? (index.runById.get(a.runId)?.productId ?? null) : null);
    out.push({
      id: a.id,
      nodeId: a.nodeId,
      operatorId: a.operatorId,
      productId,
      startMin: a.startMin,
      endMin: a.endMin,
      label: `${formatClock(addMinutes(index.windowStart, a.startMin), index.zone)}–${formatClock(addMinutes(index.windowStart, a.endMin), index.zone)}`,
    });
  }
  return out;
}
