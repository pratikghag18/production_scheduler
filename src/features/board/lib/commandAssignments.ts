import type { BoardIndex } from "./boardIndex";
import type { ContextAssignment } from "@/lib/command/resolve";
import { addMinutes, formatClock } from "./time";

/**
 * R-385 / S41-b: the command bar's view of the window's blocks. The
 * effective part of a run-attached block is its run's product; a departed
 * person's block (D110, operatorId null) is carried with null and never
 * matches. The label is the same `formatClock` pair the run label in
 * `BoardPage` is built from. `productName` (S41-b, brief §3) is looked up
 * from `index.productById` the same way `productId` above it is — one step
 * further, off the same id — and is null when that id is null or unknown.
 */
export function commandAssignments(
  index: Pick<BoardIndex, "assignmentById" | "runById" | "productById" | "windowStart" | "zone">,
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
      productName: productId !== null ? (index.productById.get(productId)?.name ?? null) : null,
    });
  }
  return out;
}
