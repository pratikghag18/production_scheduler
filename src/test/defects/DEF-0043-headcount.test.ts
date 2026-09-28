/**
 * DEF-0043-headcount (R-459, the plain-sentence standard): the run-removal readout in
 * `expandEveryoneUnassign` (src/lib/command/resolve.ts ~3818) hardcodes
 * `, for ${run.headcount} people` -- a run with headcount 1 reads "for 1
 * people" instead of "for 1 person". Same fixture as LANE-A-3 (headcount 1
 * on the Housing A run), isolated to this one wording clause.
 */
import { describe, it, expect } from "vitest";
import {
  expandCommand,
  type ResolveContext,
  type BoardDay,
  type ContextAssignment,
  type ContextRun,
} from "@/lib/command/resolve";
import type { UnassignCommand } from "@/lib/command/parse";

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
  startMin: 0 * 1440 + 22 * 60,
  endMin: 1 * 1440 + 6 * 60,
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

describe("DEF-0043-headcount: a headcount of 1 reads '1 person', never '1 people' (R-459)", () => {
  it("the run removal's readout says 'for 1 person', not 'for 1 people'", () => {
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
    const res = expandCommand(command, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const runRemoval = (res.runRemovals ?? []).find((r) => r.runId === "run1");
    expect(runRemoval?.readout).toContain("for 1 person");
    expect(runRemoval?.readout).not.toContain("for 1 people");
  });
});
