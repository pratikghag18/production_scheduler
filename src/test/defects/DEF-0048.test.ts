/**
 * DEF-0048 -- "Priya Shah is off today" asks which of her two blocks to remove, where R-409
 * says an absence takes all of them with one yes.
 *
 * Live as Ana (28 Sept): "Sam Patel is off tomorrow" -> "Sam Patel has 2 blocks Tue Sep 29.
 * Remove which?" with one button per block. parseCommand gives the absence sentence the exact
 * shape of "remove Sam Patel tomorrow" (unassign, no place, until null), so nothing downstream
 * can tell an absence from a single removal; commandResolve.test.ts's AB1-AB3 cover only the
 * "until" form. Green when the one-day absence expands to one removal per block.
 */
import { describe, it, expect } from "vitest";
import {
  expandCommand,
  type ResolveContext,
  type BoardDay,
  type ContextAssignment,
  type ContextRun,
} from "@/lib/command/resolve";
import { parseCommand } from "@/lib/command/parse";

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
    assignments: [
      {
        ...priyaBlk,
        id: "early",
        runId: null,
        startMin: 8 * 60,
        endMin: 12 * 60,
        label: "8 am to noon",
      },
      {
        ...priyaBlk,
        id: "late",
        runId: null,
        startMin: 13 * 60,
        endMin: 17 * 60,
        label: "1 pm to 5 pm",
      },
    ],
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

describe("DEF-0048: a one-day absence takes every block that day with one yes (R-409)", () => {
  it("'Priya Shah is off today' with two blocks today expands to two removals, not a which-block question", () => {
    const parsed = parseCommand("Priya Shah is off today");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const res = expandCommand(parsed.command, ctx());
    expect(res.ok, JSON.stringify(res).slice(0, 300)).toBe(true);
    if (!res.ok) return;
    const steps = res.command.intent === "several" ? res.command.commands : [res.command];
    expect(steps).toHaveLength(2);
  });
});
