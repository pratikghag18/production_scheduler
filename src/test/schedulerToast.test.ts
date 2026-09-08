import { describe, expect, it } from "vitest";
import {
  buildSchedulerErrorToast,
  type ToastResolveCtx,
} from "@/features/board/hooks/useSchedulerToast";
import type { SchedulerError } from "@/lib/api";

/**
 * R-D37: "Capacity, eligibility and run-overlap errors already name the
 * operator or cell and go through the one error path" — proves
 * buildSchedulerErrorToast (D37's "one true path") names correctly for
 * each of the three typed errors the claim names. The claim's other
 * clause ("every other error gets the block label prefixed") is a
 * call-site convention in useDragGesture.ts's toast.reverted(`${label}:
 * ...`) calls, not exercised here — no test mounts the drag flow far
 * enough to observe it, so this row's claim is narrowed to the part this
 * file actually proves.
 */
describe("buildSchedulerErrorToast (R-D37)", () => {
  const ctx: ToastResolveCtx = {
    operatorById: new Map([["op1", { displayName: "Sam Torres" }]]),
    nodeById: new Map([["node1", { name: "Cell 3" }]]),
    productById: new Map([["prod1", { name: "Widget X" }]]),
    runById: new Map([
      ["run1", { productId: "prod1", nodeId: "node1", startMin: 360, endMin: 480 }],
    ]),
    formatRange: (s, e) => `${s}-${e}`,
  };

  it("D37a: CapacityExceeded names the operator and both percentages", () => {
    const err: SchedulerError = {
      kind: "CapacityExceeded",
      operatorId: "op1",
      peak: 1.1,
      cap: 1.0,
    } as SchedulerError;
    const t = buildSchedulerErrorToast(err, ctx);
    expect(t.message).toContain("Sam Torres");
    expect(t.message).toContain("110%");
    expect(t.message).toContain("cap 100%");
    expect(t.kind).toBe("crit");
  });

  it("D37b: NotEligible names the operator and the cell, listing missing skills", () => {
    const err: SchedulerError = {
      kind: "NotEligible",
      operatorId: "op1",
      nodeId: "node1",
      missingSkills: [{ id: "skill1", name: "Forklift" }],
      expiringSkills: [],
      policy: "block",
    } as SchedulerError;
    const t = buildSchedulerErrorToast(err, ctx);
    expect(t.message).toContain("Sam Torres");
    expect(t.message).toContain("Cell 3");
    expect(t.message).toContain("Forklift");
    expect(t.kind).toBe("warn");
  });

  it("D37c: RunOverlap with a resolvable conflicting run names the cell, product and range", () => {
    const err: SchedulerError = {
      kind: "RunOverlap",
      nodeId: "node1",
      conflictingRunId: "run1",
      timerange: "fallback",
    } as SchedulerError;
    const t = buildSchedulerErrorToast(err, ctx);
    expect(t.message).toBe("Cell 3 already runs Widget X 360-480 — reverted.");
    expect(t.kind).toBe("crit");
  });

  it("D37d: RunOverlap falls back to a still-accurate sentence when runById can't resolve the conflict", () => {
    const err: SchedulerError = {
      kind: "RunOverlap",
      nodeId: "node1",
      conflictingRunId: "unknown-run",
      timerange: "fallback",
    } as SchedulerError;
    const t = buildSchedulerErrorToast(err, {});
    expect(t.message).toBe("node1 already has an overlapping run — reverted.");
  });

  it("D37e: every named-path message ends '— reverted.', matching the claim's toast shape", () => {
    const capacity = buildSchedulerErrorToast(
      { kind: "CapacityExceeded", operatorId: "op1", peak: 1.1, cap: 1.0 } as SchedulerError,
      ctx,
    );
    const eligible = buildSchedulerErrorToast(
      {
        kind: "NotEligible",
        operatorId: "op1",
        nodeId: "node1",
        missingSkills: [],
        expiringSkills: [],
        policy: "block",
      } as SchedulerError,
      ctx,
    );
    expect(capacity.message).toContain("— reverted.");
    expect(eligible.message).toContain("— reverted.");
  });
});
