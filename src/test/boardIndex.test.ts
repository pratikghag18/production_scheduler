import { describe, expect, it } from "vitest";
import type { BoardWindow } from "@/lib/api";
import { buildBoardIndex } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";

/**
 * §12 cases 14-19, ported to Vitest. Fixture mirrors supabase/seed.sql's
 * shape (brief §12's instruction); no real UUIDs needed. Authored, not run
 * in this container (no npm) — the /tmp/harness copy of this exact
 * boardIndex.ts + an equivalent fixture was executed (see the agent
 * report).
 *
 * P1-4c addendum: `buildBoardIndex` now takes a `density` 4th argument —
 * every call below passes `DENSITIES[1]` (Standard), which reproduces the
 * pre-P1-4c hardcoded row-geometry constants exactly (brief §3/§8 case 1),
 * so every existing expected number here is unchanged from before this
 * brief.
 */

const t38 = {
  id: "t38",
  name: "3 x 8h",
  shifts: [
    { id: "s1", name: "Shift 1", startMin: 360, endMin: 840, breaks: [] },
    { id: "s2", name: "Shift 2", startMin: 840, endMin: 1320, breaks: [] },
    { id: "s3", name: "Shift 3", startMin: 1320, endMin: 1800, breaks: [] },
  ],
};
const t210 = {
  id: "t210",
  name: "2 x 10h",
  shifts: [
    { id: "d", name: "Days", startMin: 360, endMin: 960, breaks: [] },
    { id: "n", name: "Nights", startMin: 960, endMin: 1560, breaks: [] },
  ],
};

function makeFixture(): BoardWindow {
  const levels = [
    { id: "lvl-plant", templateId: "tpl-a", position: 0, name: "Plant", isSchedulable: false },
    { id: "lvl-dept", templateId: "tpl-a", position: 1, name: "Department", isSchedulable: false },
    { id: "lvl-line", templateId: "tpl-a", position: 2, name: "Line", isSchedulable: false },
    { id: "lvl-cell", templateId: "tpl-a", position: 3, name: "Cell", isSchedulable: true },
  ];

  const nodes = [
    {
      id: "n-plant",
      parentId: null,
      levelId: "lvl-plant",
      name: "Plant 1",
      path: "plant_1",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-assembly",
      parentId: "n-plant",
      levelId: "lvl-dept",
      name: "Assembly",
      path: "plant_1.assembly",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-line1",
      parentId: "n-assembly",
      levelId: "lvl-line",
      name: "Line 1",
      path: "plant_1.assembly.line_1",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-cell1",
      parentId: "n-line1",
      levelId: "lvl-cell",
      name: "Cell 1",
      path: "plant_1.assembly.line_1.cell_1",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-machining",
      parentId: "n-plant",
      levelId: "lvl-dept",
      name: "Machining",
      path: "plant_1.machining",
      sortOrder: 1,
      active: true,
    },
    {
      id: "n-cncline",
      parentId: "n-machining",
      levelId: "lvl-line",
      name: "CNC Line",
      path: "plant_1.machining.cnc_line",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-cell6",
      parentId: "n-cncline",
      levelId: "lvl-cell",
      name: "Cell 6",
      path: "plant_1.machining.cnc_line.cell_6",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-other",
      parentId: "n-plant",
      levelId: "lvl-dept",
      name: "Other",
      path: "plant_1.other",
      sortOrder: 2,
      active: true,
    },
    {
      id: "n-otherline",
      parentId: "n-other",
      levelId: "lvl-line",
      name: "Other Line",
      path: "plant_1.other.other_line",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-otherx",
      parentId: "n-otherline",
      levelId: "lvl-cell",
      name: "Other X",
      path: "plant_1.other.other_line.other_x",
      sortOrder: 0,
      active: true,
    },
    {
      id: "n-unknownlevel",
      parentId: "n-plant",
      levelId: "lvl-does-not-exist",
      name: "Mystery",
      path: "plant_1.mystery",
      sortOrder: 3,
      active: true,
    },
  ];

  const runs = [
    {
      id: "r1",
      orgId: "org1",
      nodeId: "n-cell1",
      productId: "p1",
      timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
      plannedHeadcount: 2,
      notes: null,
      status: "planned",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
    {
      id: "r-cancelled",
      orgId: "org1",
      nodeId: "n-cell1",
      productId: "p1",
      timerange: '["2026-08-19 06:00:00+00","2026-08-19 14:00:00+00")',
      plannedHeadcount: 1,
      notes: null,
      status: "cancelled",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
  ];

  const assignments = [
    // case 16: run-attached, nodeId differs from the run's own node -- must index under its OWN nodeId
    {
      id: "a1",
      orgId: "org1",
      nodeId: "n-cell6",
      operatorId: "op1",
      runId: "r1",
      productId: null,
      timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
      efficiency: 0.5,
      eligibilityOverride: false,
      overrideReason: null,
      targetQty: null,
      targetUnit: null,
      status: "active",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
    // case 17: cancelled -- excluded from every map
    {
      id: "a-cancelled",
      orgId: "org1",
      nodeId: "n-cell1",
      operatorId: "op1",
      runId: "r1",
      productId: null,
      timerange: '["2026-08-18 06:00:00+00","2026-08-18 14:00:00+00")',
      efficiency: 0.5,
      eligibilityOverride: false,
      overrideReason: null,
      targetQty: null,
      targetUnit: null,
      status: "cancelled",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
    // case 18: malformed timerange -- dropped, droppedRanges += 1, no throw
    {
      id: "a-bad",
      orgId: "org1",
      nodeId: "n-cell1",
      operatorId: "op2",
      runId: null,
      productId: "p1",
      timerange: "not-a-range",
      efficiency: 1.0,
      eligibilityOverride: false,
      overrideReason: null,
      targetQty: null,
      targetUnit: null,
      status: "active",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
    // proves the rest of the payload still indexes after the bad row
    {
      id: "a-ok",
      orgId: "org1",
      nodeId: "n-otherx",
      operatorId: "op2",
      runId: null,
      productId: "p1",
      timerange: '["2026-08-18 06:00:00+00","2026-08-18 10:00:00+00")',
      efficiency: 1.0,
      eligibilityOverride: false,
      overrideReason: null,
      targetQty: null,
      targetUnit: null,
      status: "active",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    },
  ];

  const operators = [
    {
      id: "op1",
      homeNodeId: "n-assembly",
      displayName: "Maria",
      employeeRef: null,
      active: true,
      skillIds: [],
    },
    {
      id: "op2",
      homeNodeId: "n-other",
      displayName: "Raj",
      employeeRef: null,
      active: true,
      skillIds: [],
    },
  ];
  const products = [{ id: "p1", sku: "WX", name: "Widget X", active: true }];
  const skills = [
    { id: "sk-cnc", name: "CNC" },
    { id: "sk-forklift", name: "Forklift" },
  ];

  // case 15: requirement attached at the CNC LINE (ancestor) unions onto cell_6 (descendant),
  // plus a duplicate direct attachment on cell_6 itself to prove dedupe.
  const nodeSkillRequirements = [
    { nodeId: "n-cncline", skillId: "sk-cnc" },
    { nodeId: "n-cell6", skillId: "sk-cnc" },
    { nodeId: "n-cell6", skillId: "sk-forklift" },
  ];

  const shiftTemplates = [t38, t210];

  // case 14: template at plant_1.assembly resolves for line_1.cell_1;
  // cnc_line (nearer) overrides machining (the department, also set).
  const nodeShiftMap = [
    { nodeId: "n-assembly", templateId: "t38" },
    { nodeId: "n-line1", templateId: null },
    { nodeId: "n-cell1", templateId: null },
    { nodeId: "n-machining", templateId: "t38" },
    { nodeId: "n-cncline", templateId: "t210" },
    { nodeId: "n-cell6", templateId: null },
    { nodeId: "n-other", templateId: null },
    { nodeId: "n-otherline", templateId: null },
    { nodeId: "n-otherx", templateId: null },
    { nodeId: "n-plant", templateId: null },
    { nodeId: "n-unknownlevel", templateId: null },
  ];

  return {
    org: { id: "org1", name: "Northwind", settings: { capacity_cap: 1.2 } },
    levels,
    nodes,
    runs,
    assignments,
    operators,
    products,
    skills,
    nodeSkillRequirements,
    shiftTemplates,
    nodeShiftMap,
  } as unknown as BoardWindow;
}

const windowStart = new Date("2026-08-17T00:00:00Z");
const windowEnd = new Date("2026-08-20T00:00:00Z"); // 3 days
const STANDARD = DENSITIES[1];

describe("boardIndex.ts", () => {
  it("nearest-ancestor template resolution (case 14)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    expect(idx.templateForNode.get("n-cell1")?.id).toBe("t38");
    expect(idx.templateForNode.get("n-cell6")?.id).toBe("t210"); // line overrides department
    expect(idx.templateForNode.get("n-otherx")).toBeNull();
  });

  it("skillsForNode unions ancestor + own requirement, deduped (case 15)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    const names = (idx.skillsForNode.get("n-cell6") ?? []).map((s) => s.name).sort();
    expect(names).toEqual(["CNC", "Forklift"]);
  });

  it("a run-attached assignment lands under its OWN nodeId, not its run's (case 16)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    expect((idx.assignmentsByNode.get("n-cell6") ?? []).some((a) => a.id === "a1")).toBe(true);
    expect((idx.assignmentsByNode.get("n-cell1") ?? []).some((a) => a.id === "a1")).toBe(false);
  });

  it("cancelled rows are excluded from every map (case 17)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    const anyCancelledRun = [...idx.runsByNode.values()].flat().some((r) => r.id === "r-cancelled");
    const anyCancelledAssignment = [...idx.assignmentsByNode.values()]
      .flat()
      .some((a) => a.id === "a-cancelled");
    expect(anyCancelledRun).toBe(false);
    expect(anyCancelledAssignment).toBe(false);
  });

  it("a malformed timerange drops that row, counts it, and does not throw (case 18)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    expect(idx.droppedRanges).toBe(1);
    expect((idx.assignmentsByNode.get("n-otherx") ?? []).some((a) => a.id === "a-ok")).toBe(true);
  });

  it("capacityCap reads org.settings, falls back to 1.0 (case 19)", () => {
    const fixture = makeFixture();
    expect(buildBoardIndex(fixture, windowStart, windowEnd, STANDARD).capacityCap).toBe(1.2);

    const empty = { ...fixture, org: { ...fixture.org, settings: {} } };
    expect(buildBoardIndex(empty, windowStart, windowEnd, STANDARD).capacityCap).toBe(1.0);

    const nullSettings = { ...fixture, org: { ...fixture.org, settings: null } };
    expect(buildBoardIndex(nullSettings, windowStart, windowEnd, STANDARD).capacityCap).toBe(1.0);

    const badCap = { ...fixture, org: { ...fixture.org, settings: { capacity_cap: "lots" } } };
    expect(buildBoardIndex(badCap, windowStart, windowEnd, STANDARD).capacityCap).toBe(1.0);
  });

  /**
   * ADDED BY THE DESIGN SESSION'S VERIFICATION PASS (not in brief §12).
   *
   * `buildBoardIndex` sorts by (startMin, endMin) before calling
   * `packLanes`, because greedy first-fit is order-sensitive. Nothing in
   * §12 could see that sort disappear: every prescribed fixture happens to
   * pack identically sorted or not, so deleting the sort line passed the
   * whole suite silently. This is the case that fails when it is deleted.
   *
   * A(00:00-01:40) B(01:40-03:20) C(03:20-05:00) are three back-to-back
   * blocks -- one lane when sorted, two when fed in the order A, C, B.
   */
  it("sorts before packing: out-of-order back-to-back blocks still take ONE lane", () => {
    const data = makeFixture();
    const mk = (id: string, start: string, end: string) => ({
      id,
      orgId: "org1",
      nodeId: "n-otherx",
      operatorId: "op2",
      runId: null,
      productId: "p1",
      timerange: `["${start}","${end}")`,
      efficiency: 1.0,
      eligibilityOverride: false,
      overrideReason: null,
      targetQty: null,
      targetUnit: null,
      status: "active",
      createdBy: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    // Deliberately A, C, B -- NOT chronological.
    data.assignments = [
      mk("j-a", "2026-08-17 00:00:00+00", "2026-08-17 01:40:00+00"),
      mk("j-c", "2026-08-17 03:20:00+00", "2026-08-17 05:00:00+00"),
      mk("j-b", "2026-08-17 01:40:00+00", "2026-08-17 03:20:00+00"),
    ] as unknown as BoardWindow["assignments"];

    const ix = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    const row = ix.rows.find((r) => r.node.id === "n-otherx")!;
    expect(row.laneCount).toBe(1);
    expect(row.height).toBe(36 + 1 * 28 + 4);
    for (const a of ix.assignmentsByNode.get("n-otherx") ?? []) {
      expect(a.lane).toBe(0);
    }
  });

  it("a node whose level id is missing from levels is a group row, no throw (T8)", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    const row = idx.rows.find((r) => r.node.id === "n-unknownlevel");
    expect(row?.isTrack).toBe(false);
  });

  it("P1-4c: BoardIndex.density round-trips the density it was given", () => {
    for (const d of DENSITIES) {
      const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, d);
      expect(idx.density).toBe(d);
    }
  });
});
