/**
 * DEF-0040 (proved live by the tester, pinned here at the resolver level):
 * "clear Cell 4 in Line 2 2026-10-12" when a run and a crew block both span
 * Sun 11 Oct 22:00 -> Mon 12 Oct 06:00 (a job that crosses midnight INTO the
 * cleared day). `expandEveryoneUnassign` (src/lib/command/resolve.ts) builds
 * TWO commands that contradict each other:
 *
 *   1. Priya's block only partly overlaps the Monday window (it starts the
 *      day before), so the per-block loop (~3763) reads it as an EDGE
 *      ADJUST -- a `move` with `adjust: { edge: "end", at: midnight }` --
 *      meaning the block SURVIVES, trimmed to keep its Sunday 22:00-24:00
 *      portion. This is the live bar's own readout 1: "Priya Shah's block on
 *      Cell 4 now ends midnight; it was 6 am."
 *   2. The SAME run (whose own timerange also crosses into the window) gets
 *      a `remove_run` (~3812-3871). `delete_run`'s cascade mode deletes
 *      EVERY assignment with that run_id, unconditional on timerange (the
 *      comment at ~3819-3830 says so directly) -- which deletes Priya's row
 *      WHOLE, including the Sunday portion step 1 just said survives.
 *
 * The inner "already in commands above" skip (~3843) only checks whether
 * the block OVERLAPS the window -- it does, so the crew-block loop correctly
 * does not ALSO list Priya as a plain removal -- but it has no idea step 1
 * chose "trim" rather than "remove", so nothing stops the run from being
 * deleted out from under the trim. Live result: 2 things reported done, 0
 * rows survive.
 */
import { describe, it, expect } from "vitest";
import {
  expandCommand,
  type ResolveContext,
  type BoardDay,
  type ContextAssignment,
  type ContextRun,
} from "@/lib/command/resolve";
import type { UnassignCommand, MoveCommand, SingleCommand } from "@/lib/command/parse";

const days: BoardDay[] = [
  { index: 0, iso: "2026-10-11", weekday: 0 }, // Sun
  { index: 1, iso: "2026-10-12", weekday: 1 }, // Mon
];

const line2 = { id: "line2", name: "Line 2", path: "line2" };
const cell4 = { id: "cell4", name: "Cell 4", path: "line2.cell4" };

const priyaBlk: ContextAssignment = {
  id: "priyaBlk",
  nodeId: "cell4",
  operatorId: "priya",
  productId: "wx",
  startMin: 0 * 1440 + 22 * 60, // Sun 22:00
  endMin: 1 * 1440 + 6 * 60, // Mon 06:00
  label: "10 pm to 6 am",
  productName: "Housing A",
  runId: "run1",
};

const housingRun: ContextRun = {
  id: "run1",
  nodeId: "cell4",
  productId: "wx",
  startMin: 0 * 1440 + 22 * 60,
  endMin: 1 * 1440 + 6 * 60,
  label: "Housing A 10 pm to 6 am",
  span: "10 pm to 6 am",
  productName: "Housing A",
  headcount: 1,
};

function ctx(): ResolveContext {
  return {
    cells: [cell4],
    nodeById: new Map([
      ["line2", line2],
      ["cell4", cell4],
    ]),
    operators: [{ id: "priya", displayName: "Priya Shah", employeeRef: null, active: true }],
    products: [{ id: "wx", sku: "WX", name: "Housing A" }],
    offeredAt: () => [{ id: "wx" }],
    days,
    todayIndex: 0,
    todayIso: "2026-10-11",
    wallToOffset: (d, m) => d * 1440 + m,
    runs: [housingRun],
    fitsRun: () => true,
    minDurationMinutes: 15,
    assignments: [priyaBlk],
    overlaps: (a, b) => a.startMin < b.endMin && b.startMin < a.endMin,
    findRunOverlap: () => null,
    shiftsAt: () => [],
    nowMinuteOfDay: null,
    wallOf: (m) => ({ dayIndex: Math.floor(m / 1440), minuteOfDay: m % 1440 }),
    certificateGaps: () => [],
    eligibilityPolicy: () => "warn",
    settled: true,
  } as ResolveContext;
}

describe("DEF-0040: a midnight-crossing job's run removal must not delete a block the lot just trimmed to survive", () => {
  it("'clear Cell 4 in Line 2 2026-10-12' never both keeps Priya's Sunday remnant AND deletes her run", () => {
    const command: UnassignCommand = {
      intent: "unassign",
      operator: "everyone",
      place: ["Cell 4", "Line 2"],
      day: { kind: "date", iso: "2026-10-12" },
      span: null,
      existing: null,
      shift: null,
      until: null,
    };
    // REWRITTEN by the tester, 30 Sept (session 195t), for R-461: the clear of
    // a day a night shift crosses asks first, so the pin answers the question
    // both ways and holds the invariant under each answer. The two shape
    // assertions of the defective build (one trim AND one run removal in the
    // same lot) are gone; the invariant they led to is what stays.
    const asked = expandCommand(command, ctx());
    expect(asked.ok, "a clear across a night shift asks before it builds a lot").toBe(false);

    for (const answer of ["keep", "clear"] as const) {
      const res = expandCommand(command, ctx(), { previousDayPart: answer });
      expect(res.ok, `answered ${answer}: a lot`).toBe(true);
      if (!res.ok) return;

      const flat = (
        res.command.intent === "several" ? res.command.commands : [res.command]
      ) as readonly SingleCommand[];
      const survivingMoveAssignmentIds = new Set(
        flat
          .filter((c): c is MoveCommand => c.intent === "move" && c.existing?.kind === "move")
          .map((c) => (c.existing as { kind: "move"; assignmentId: string }).assignmentId),
      );
      const deletedRunIds = new Set((res.runRemovals ?? []).map((r) => r.runId));

      // The invariant, either direction: no block the lot says survives (a
      // trim/move) may belong to a run the SAME lot deletes. priyaBlk belongs
      // to run1 by construction (the fixture above).
      const contradiction = survivingMoveAssignmentIds.has("priyaBlk") && deletedRunIds.has("run1");
      expect(contradiction, `answered ${answer}`).toBe(false);

      if (answer === "keep") {
        // No: Sunday's part stays, for the person and for the job alike.
        expect(survivingMoveAssignmentIds.has("priyaBlk")).toBe(true);
        expect(deletedRunIds.has("run1")).toBe(false);
        const trim = (res.runTrims ?? []).find((r) => r.runId === "run1");
        expect(trim?.range).toEqual({ startMin: 22 * 60, endMin: 1440 });
      } else {
        // Yes: the whole shift goes, and the removal's readout keeps the
        // job's real, full-crossing span -- never narrowed to the cleared day.
        expect(survivingMoveAssignmentIds.has("priyaBlk")).toBe(false);
        const runRemoval = (res.runRemovals ?? []).find((r) => r.runId === "run1");
        expect(runRemoval?.readout).toContain("10 pm to 6 am");
        expect((res.runTrims ?? []).some((r) => r.runId === "run1")).toBe(false);
      }
    }
  });
});
