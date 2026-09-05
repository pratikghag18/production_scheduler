import { describe, expect, it } from "vitest";
import type { BoardWindow } from "@/lib/api";
import { buildBoardIndex, policyForNode } from "@/features/board/lib/boardIndex";
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
    // ⚠️ THE `r-cancelled` FIXTURE IS GONE (R-324), not renamed. A cancelled run
    // is a state the server can no longer produce — the column does not exist,
    // and it never could reach that state anyway, since runs are hard-deleted.
    // The row that stood here was the only reason this file needed a status.
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
    // ⚠️ THE `a-cancelled` ASSIGNMENT FIXTURE IS GONE (R-323), not moved. A
    // cancelled assignment is a state the server can no longer produce — the
    // column does not exist — so a fixture carrying one would be testing this
    // client against a payload it will never receive, which is worse than no
    // fixture at all. The cancelled RUN above stays; runs kept their status.
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
      skillExpiries: [],
    },
    {
      id: "op2",
      homeNodeId: "n-other",
      displayName: "Raj",
      employeeRef: null,
      active: true,
      skillIds: [],
      skillExpiries: [],
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

  // R-315/R-316: cell_6 makes p1 in 90 seconds, otherx in 120. Neither template
  // above carries breaks, so a derived target here is the whole assigned span.
  const cycleTimes = [
    { nodeId: "n-cell6", productId: "p1", secondsPerUnit: 90 },
    { nodeId: "n-otherx", productId: "p1", secondsPerUnit: 120 },
  ];

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

  // R-331: the server's ALREADY-RESOLVED answer for each node — the plant is
  // strict, Machining under it was relaxed, and `n-unknownlevel` is deliberately
  // LEFT OUT so a case can measure what an unanswered node falls back to.
  const nodePolicies = [
    { nodeId: "n-plant", eligibilityPolicy: "block" },
    { nodeId: "n-assembly", eligibilityPolicy: "block" },
    { nodeId: "n-line1", eligibilityPolicy: "block" },
    { nodeId: "n-cell1", eligibilityPolicy: "block" },
    { nodeId: "n-machining", eligibilityPolicy: "warn" },
    { nodeId: "n-cncline", eligibilityPolicy: "warn" },
    { nodeId: "n-cell6", eligibilityPolicy: "warn" },
    { nodeId: "n-other", eligibilityPolicy: "block" },
    { nodeId: "n-otherline", eligibilityPolicy: "block" },
    { nodeId: "n-otherx", eligibilityPolicy: "block" },
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
    cycleTimes,
    nodePolicies,
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

  /**
   * ⚠️ CASE 17 IS GONE ENTIRELY, IN TWO STEPS, AND THE CONTRACT CHANGED BOTH
   * TIMES RATHER THAN THE CASES BEING WRONG. It asserted that a cancelled RUN
   * and a cancelled ASSIGNMENT were dropped from every map. R-323 removed the
   * assignment half; R-324 removed the run half. Neither table has a status now
   * — a deleted row is deleted — so the states those assertions described can no
   * longer exist, and a fixture carrying one would be testing this client
   * against a payload the server cannot produce.
   *
   * ⭐ WHAT REPLACES IT IS THE OPPOSITE ASSERTION, and it has to be positive:
   * "nothing is filtered" is invisible if you only delete a case. So the two
   * below say that every run and every assignment in the window reaches a map.
   */
  it("every run in the window reaches a map — nothing is filtered out", () => {
    const fixture = makeFixture();
    const idx = buildBoardIndex(fixture, windowStart, windowEnd, STANDARD);
    const shown = new Set([...idx.runsByNode.values()].flat().map((r) => r.id));
    for (const r of fixture.runs) expect(shown.has(r.id)).toBe(true);
  });

  it("every assignment in the window reaches a map — nothing is filtered out", () => {
    const fixture = makeFixture();
    const idx = buildBoardIndex(fixture, windowStart, windowEnd, STANDARD);
    const shown = new Set([...idx.assignmentsByNode.values()].flat().map((a) => a.id));
    // Everything except the row case 18 drops for an unparseable timerange.
    const expected = fixture.assignments.filter((a) => a.id !== "a-bad").map((a) => a.id);
    for (const id of expected) expect(shown.has(id)).toBe(true);
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

/**
 * R-316: the derived default target, as the board index computes it. The
 * arithmetic itself is pinned in `standardTarget.test.ts`; these cases pin the
 * WIRING — which product a chip is measured against, which cell's cycle time is
 * read, and that an explicit target never disturbs it.
 */
describe("R-316: an assignment carries the target its cell's cycle time implies", () => {
  it("B-CT1: a direct assignment is measured by its own product at its own cell", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    const a = idx.assignmentById.get("a-ok");
    // 06:00-10:00 is 240 minutes, no breaks in this template, 120 s a unit.
    expect(a?.defaultTargetQty).toBe(120);
  });

  it("B-CT2: a run-attached chip carries no product of its own and takes the run's", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    const a = idx.assignmentById.get("a1");
    expect(a?.productId).toBeNull();
    // 480 minutes at 50% efficiency, 90 s a unit for the run's p1 at cell_6.
    expect(a?.defaultTargetQty).toBe(160);
  });

  it("B-CT3: an explicit target does not disturb the derived one", () => {
    const data = makeFixture();
    const explicit = data.assignments.find((a) => a.id === "a-ok");
    if (explicit) explicit.targetQty = 500;
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    const a = idx.assignmentById.get("a-ok");
    // Both are present: the chip prefers targetQty, and clearing the field
    // falls straight back to the standard without a refetch.
    expect(a?.targetQty).toBe(500);
    expect(a?.defaultTargetQty).toBe(120);
  });

  it("B-CT4: no cycle time anywhere means no derived target anywhere", () => {
    const data = makeFixture();
    data.cycleTimes = [];
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    expect(idx.assignmentById.get("a-ok")?.defaultTargetQty).toBeNull();
    expect(idx.assignmentById.get("a1")?.defaultTargetQty).toBeNull();
    expect(idx.cycleTimeByKey.size).toBe(0);
  });

  it("B-CT5: the cycle time of a DIFFERENT cell is never borrowed", () => {
    const data = makeFixture();
    // Only cell_6 is measured; otherx makes the same part and is not.
    data.cycleTimes = [{ nodeId: "n-cell6", productId: "p1", secondsPerUnit: 90 }];
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    expect(idx.assignmentById.get("a1")?.defaultTargetQty).toBe(160);
    expect(idx.assignmentById.get("a-ok")?.defaultTargetQty).toBeNull();
  });
});

/**
 * ⭐ THE HEADLINE IS B-EP1: two cells on the SAME board, in the same company,
 * answering differently. That is the case the old company-wide scalar could not
 * express however it was read, and it is the whole reason `board_window` now
 * sends a map rather than one value.
 *
 * ⛔ AND THE REST ARE ABOUT WHAT HAPPENS WHEN THE MAP CANNOT ANSWER. An unknown
 * node fails SAFE (`block`), never open: guessing the company's `warn` draws an
 * override tick the server may then refuse — the dead end this work removes.
 */
describe("R-331: the eligibility rule is the CELL's, not the company's", () => {
  it("⭐ B-EP1: two cells on ONE board carry two different policies", () => {
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    expect(policyForNode(idx, "n-cell1")).toBe("block");
    expect(policyForNode(idx, "n-cell6")).toBe("warn");
    // ...and the company's own value is still there, unread by the popover.
    expect(idx.eligibilityPolicy).toBe("warn");
  });

  it("⛔ B-EP2: a node the payload did not answer for falls back to BLOCK, not to the company", () => {
    // `n-unknownlevel` is in `nodes` and absent from `node_policies`. Guessing
    // the company's "warn" here would draw an override tick the server may then
    // refuse — the dead end this work exists to remove. Refusing something the
    // server might have allowed is the survivable half of that pair.
    const idx = buildBoardIndex(makeFixture(), windowStart, windowEnd, STANDARD);
    expect(idx.eligibilityPolicy).toBe("warn");
    expect(policyForNode(idx, "n-unknownlevel")).toBe("block");
    expect(policyForNode(idx, "n-not-on-this-board-at-all")).toBe("block");
  });

  it("B-EP3: an EMPTY map is the not-yet-loaded board, and reads the company's answer", () => {
    // The one state in which the company's value IS every node's value: there
    // are no per-node answers to have missed. `emptyIndex` in BoardPage.
    const data = makeFixture();
    data.nodePolicies = [];
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    expect(idx.eligibilityPolicyByNode.size).toBe(0);
    expect(policyForNode(idx, "n-cell1")).toBe("warn");
  });

  it("B-EP4: an unrecognised policy string is DROPPED, so that node fails safe", () => {
    // Not coerced, not trusted. A third value from a future migration must
    // arrive as "we do not know this cell's rule", which is `block`.
    const data = makeFixture();
    data.nodePolicies = [
      { nodeId: "n-cell1", eligibilityPolicy: "refuse-politely" },
      { nodeId: "n-cell6", eligibilityPolicy: "warn" },
    ];
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    expect(idx.eligibilityPolicyByNode.has("n-cell1")).toBe(false);
    expect(policyForNode(idx, "n-cell1")).toBe("block");
    expect(policyForNode(idx, "n-cell6")).toBe("warn");
  });

  it("B-EP5: the company's value is read defensively and defaults to warn", () => {
    const data = makeFixture();
    (data.org as { settings: unknown }).settings = { eligibility_policy: "nonsense" };
    data.nodePolicies = [];
    const idx = buildBoardIndex(data, windowStart, windowEnd, STANDARD);
    expect(policyForNode(idx, "n-cell1")).toBe("warn");
  });

  it("B-EP6: no index at all is BLOCK — the popover cannot be opened, and this is the safe answer", () => {
    expect(policyForNode(null, "n-cell1")).toBe("block");
    expect(policyForNode(undefined, "n-cell1")).toBe("block");
  });
});
