import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  buildSchedulerErrorToast,
  useSchedulerToast,
  useToastStore,
  type ToastResolveCtx,
} from "@/features/board/hooks/useSchedulerToast";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";

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
    expect(t.message).toBe("Cell 3 already runs Widget X 360-480.");
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
    expect(t.message).toBe("node1 already has an overlapping run.");
  });

  /**
   * F-154 review fix (S61-a, the several-lot's own trace read, 16 Sept):
   * THE CONTRACT CHANGED, this test did not merely pin a bug -- this used to
   * assert every named-path message ends "— reverted.", baked in here. That
   * was true for a real drag (which really does revert its own optimistic
   * move) but FALSE for `runLot`'s catch (`useDragGesture.ts`), which
   * writes each lot step for real and simply stops at the first failure --
   * "swap Lena Novak and Tom Baker today" wrote three of four and the bar
   * still said "reverted", reading as the whole lot undone when nothing
   * was. `buildSchedulerErrorToast` now hands back the plain fact; a
   * genuine revert is the CALLER's own `toast.reverted(message, kind)`
   * call (`failWith`, `openMoveFromCommand`'s override branch), not
   * something baked into every message regardless of whether anything was
   * actually rolled back.
   */
  it("D37e: a named-path message never bakes in '— reverted.' -- that is a caller's own toast.reverted, not this function's job", () => {
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
    expect(capacity.message).not.toContain("reverted");
    expect(eligible.message).not.toContain("reverted");
  });

  /*
   * R-357/R-359. `Absent` had no branch here at all: it fell through to
   * `describeSchedulerError`, which is DELIBERATELY raw -- the contract layer
   * has no operator list, no date format and no zone. On a toast that read
   * "Operator 4f3c...-9a21 is on leave 2026-06-10 - 2026-06-10." for someone
   * away only 09:00-13:00: a uuid nobody can look up, and a day that is not the
   * whole story. This branch has all three things the fallback lacks.
   */
  describe("an absent refusal names the person and, when it is part-day, the hours", () => {
    const wholeDay: SchedulerError = {
      kind: "Absent",
      nodeId: "node1",
      policy: "block",
      operators: [{ operatorId: "op1", from: "2026-06-10", to: "2026-06-12", reason: "sick" }],
    } as SchedulerError;

    const partDay: SchedulerError = {
      kind: "Absent",
      nodeId: "node1",
      policy: "block",
      operators: [
        {
          operatorId: "op1",
          from: "2026-06-10",
          to: "2026-06-10",
          reason: "appointment",
          startsAt: "2026-06-10T09:00:00.000Z",
          endsAt: "2026-06-10T13:00:00.000Z",
        },
      ],
    } as SchedulerError;

    const zoned: ToastResolveCtx = { ...ctx, dateFormat: "d_mon_yyyy", zone: "UTC" };

    it("names the person rather than the raw operator id", () => {
      const t = buildSchedulerErrorToast(wholeDay, zoned);
      expect(t.message).toContain("Sam Torres");
      expect(t.message).not.toContain("op1");
      expect(t.kind).toBe("warn");
    });

    it("a part-day absence names the hours", () => {
      const t = buildSchedulerErrorToast(partDay, zoned);
      expect(t.message).toContain("09:00");
      expect(t.message).toContain("13:00");
      expect(t.message).toContain("Sam Torres");
      // F-154 review fix: no longer bakes in "reverted" -- see D37e's own
      // comment above.
      expect(t.message).not.toContain("reverted");
    });

    it("a whole-day absence invents no hours", () => {
      const t = buildSchedulerErrorToast(wholeDay, zoned);
      expect(t.message).not.toMatch(/\d\d:\d\d/);
      expect(t.message).toContain("sick");
    });

    it("reads the hours in the ctx's zone, not always UTC", () => {
      const utc = buildSchedulerErrorToast(partDay, zoned);
      const chicago = buildSchedulerErrorToast(partDay, { ...zoned, zone: "America/Chicago" });
      expect(utc.message).not.toBe(chicago.message);
      expect(chicago.message).toContain("04:00");
    });

    it("a crew refusal names every absent person, not a bare count", () => {
      const crew: SchedulerError = {
        kind: "Absent",
        nodeId: "node1",
        policy: "block",
        operators: [
          { operatorId: "op1", from: "2026-06-10", to: "2026-06-10", reason: "sick" },
          { operatorId: "op2", from: "2026-06-10", to: "2026-06-10", reason: "training" },
        ],
      } as SchedulerError;
      const t = buildSchedulerErrorToast(crew, {
        ...zoned,
        operatorById: new Map([
          ["op1", { displayName: "Sam Torres" }],
          ["op2", { displayName: "Ana Reyes" }],
        ]),
      });
      expect(t.message).toContain("Sam Torres");
      expect(t.message).toContain("Ana Reyes");
      expect(t.message).toContain("are on leave");
    });

    it("with no dateFormat or zone in ctx it still says something true", () => {
      // Every existing call site passed neither before this landed.
      const t = buildSchedulerErrorToast(partDay, ctx);
      expect(t.message).toContain("Sam Torres");
      expect(t.message).toContain("on leave");
    });
  });
});

describe("R-465 (S195-D): a capacity refusal for a block she cannot read says the place, in every reader", () => {
  const SAID = "Sam Torres is already on Cell 4 in Line 2 today from 6 am to 2 pm.";
  const err: SchedulerError = {
    kind: "CapacityExceeded",
    operatorId: "op1",
    peak: 2,
    cap: 1,
    timerange: "",
    elsewhere: SAID,
  };
  const ctx: ToastResolveCtx = { operatorById: new Map([["op1", { displayName: "Sam Torres" }]]) };

  it("ST-1: the toast's own message is the sentence -- no numbers, no 'try the split' (there is nothing to split)", () => {
    const t = buildSchedulerErrorToast(err, ctx);
    expect(t).toEqual({ message: SAID, kind: "crit" });
    expect(t.message).not.toMatch(/%|split/);
  });

  it("ST-2: describeSchedulerError says it too, for every reader that has no operator list (the pop-ups, the bar's report)", () => {
    expect(describeSchedulerError(err)).toBe(SAID);
    // Without it, today's words are untouched.
    const { elsewhere: _elsewhere, ...plain } = err as SchedulerError & { elsewhere?: string };
    expect(describeSchedulerError(plain as SchedulerError)).toBe(
      "Operator op1 would reach 200% of capacity (limit 100%).",
    );
  });

  it("ST-3: `refused` pushes the message exactly as said -- no ' — reverted.' after a plain fact", () => {
    useToastStore.setState({ toasts: [] });
    const { result } = renderHook(() => useSchedulerToast());
    act(() => result.current.refused(SAID));
    expect(useToastStore.getState().toasts.map((x) => x.message)).toEqual([SAID]);
    act(() => result.current.reverted("A block"));
    expect(useToastStore.getState().toasts.map((x) => x.message)).toEqual([
      SAID,
      "A block — reverted.",
    ]);
  });
});
