import { describe, expect, it } from "vitest";
import type { BoardWindow } from "@/lib/api";
import { buildBoardIndex } from "@/features/board/lib/boardIndex";
import { DENSITIES } from "@/features/board/lib/geometry";
import { outsideAreaOperatorIds } from "@/features/board/lib/outsideArea";

/**
 * R-342 / S36 — who the board pickers mark "not from this area (override)".
 *
 * THE CASE THIS FILE EXISTS FOR IS "another plant", NOT "another area".
 * The maintainer, on the live app: *"I was assigning plant A, I was able to
 * select operators from any other plants for example plant B in the list and
 * it did not show any warning whatsoever in direct assignment tab."*
 *
 * The fixture is built the way `boardIndex.test.ts` builds one, with ONE
 * deliberate difference that is the whole point: `board_window` returns every
 * operator in the org (`FROM operators op WHERE op.org_id = v_org_id`, 0051)
 * but only the SELECTED PLANT'S nodes (`scoped_nodes`, `n.path <@ p_root_path`).
 * So `op-plant2` below is owned by a node that is NOT in `nodes` — exactly the
 * payload the browser gets — and the old implementation asked `offeredHere`,
 * which fails OPEN on an owner it cannot resolve and therefore answered
 * "belongs" for every person in the company.
 *
 * The server answers the same question with `app_owner_covers_in_org`:
 * `o.path @> n.path` over rows that must both exist in the org. A missing
 * owner row makes that EXISTS false, i.e. NOT covered, i.e. refused with
 * `not_offered_here` — which is what these cases are transcribed from.
 */

const CELL = "plant_1.assembly.line_1.cell_1";

function makeFixture(): BoardWindow {
  const levels = [
    { id: "lvl-plant", templateId: "tpl-a", position: 0, name: "Plant", isSchedulable: false },
    { id: "lvl-dept", templateId: "tpl-a", position: 1, name: "Department", isSchedulable: false },
    { id: "lvl-line", templateId: "tpl-a", position: 2, name: "Line", isSchedulable: false },
    { id: "lvl-cell", templateId: "tpl-a", position: 3, name: "Cell", isSchedulable: true },
  ];

  // Plant 1's subtree, and ONLY Plant 1's subtree — this is what a board
  // opened on Plant 1 holds in `index.nodeById`. Plant 2 exists in the
  // database; it is not here, and that absence is the fixture's subject.
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
      path: CELL,
      sortOrder: 0,
      active: true,
    },
    // ⚠️ A SIBLING WHOSE PATH IS A STRING PREFIX OF NOTHING BUT ITSELF, and a
    // second line whose slug extends `line_1`'s. `plant_1.assembly.line_1` is
    // a prefix of the STRING `plant_1.assembly.line_10` and is not an ancestor
    // of that NODE — `isAtOrBelow`, not `startsWith`.
    {
      id: "n-line10",
      parentId: "n-assembly",
      levelId: "lvl-line",
      name: "Line 10",
      path: "plant_1.assembly.line_10",
      sortOrder: 1,
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
  ];

  // ⭐ EVERY OPERATOR IN THE ORG, NOT EVERY OPERATOR IN THE PLANT. `op-plant2`
  // is owned by `n-p2-cell`, a node of Plant 2 that this window never sent.
  const operators = [
    op("op-cell", "At the cell", "n-cell1"),
    op("op-line", "On the line", "n-line1"),
    op("op-dept", "In Assembly", "n-assembly"),
    op("op-plant", "Plant-wide", "n-plant"),
    op("op-machining", "In Machining", "n-machining"),
    op("op-line10", "On Line 10", "n-line10"),
    op("op-plant2", "From Plant 2", "n-p2-cell"),
  ];

  return {
    org: { id: "org1", name: "Northwind", settings: {} },
    levels,
    nodes,
    runs: [],
    assignments: [],
    operators,
    products: [],
    skills: [],
    nodeSkillRequirements: [],
    shiftTemplates: [],
    nodeShiftMap: nodes.map((n) => ({ nodeId: n.id, templateId: null })),
    cycleTimes: [],
    nodePolicies: nodes.map((n) => ({ nodeId: n.id, eligibilityPolicy: "warn" })),
  } as unknown as BoardWindow;
}

function op(id: string, displayName: string, siteNodeId: string) {
  return {
    id,
    homeNodeId: null,
    displayName,
    employeeRef: null,
    active: true,
    siteNodeId,
    skillIds: [],
    skillExpiries: [],
  };
}

const windowStart = new Date("2026-09-07T00:00:00Z");
const windowEnd = new Date("2026-09-08T00:00:00Z");

function build() {
  const data = makeFixture();
  const index = buildBoardIndex(data, windowStart, windowEnd, DENSITIES[1]);
  return { operators: data.operators, index };
}

/** The marked names, so a failure reads as people rather than as ids. */
function markedAt(nodeId: string | null, useIndex = true) {
  const { operators, index } = build();
  const ids = outsideAreaOperatorIds(operators, nodeId, useIndex ? index : null);
  return operators.filter((o) => ids.has(o.id)).map((o) => o.displayName);
}

describe("outsideArea: who the picker marks at a cell", () => {
  /**
   * ⭐ THE DEFECT. Red before the fix and green after: the old body handed the
   * whole roster to `offeredHere`, whose `offeredAt` returns TRUE for an owner
   * it cannot find in the map, so the one person the server is certain to
   * refuse was the one person the picker said nothing about.
   */
  it("R-342: a person owned by ANOTHER PLANT is marked", () => {
    expect(markedAt("n-cell1")).toContain("From Plant 2");
  });

  it("a person from another area of the SAME plant is marked", () => {
    expect(markedAt("n-cell1")).toContain("In Machining");
  });

  /**
   * `plant_1.assembly.line_1` is a string prefix of `plant_1.assembly.line_10`.
   * A `startsWith` here would call Line 10's people locals of Line 1's cell.
   */
  it("a sibling line whose slug extends this one's is still outside", () => {
    expect(markedAt("n-cell1")).toContain("On Line 10");
  });

  /**
   * ⚠️ AT OR BELOW INCLUDES THE NODE ITSELF and every ancestor of it. These
   * three are the ones `app_owner_covers_in_org`'s `o.path @> n.path` accepts,
   * so marking any of them would be the screen refusing what the server takes.
   */
  it("the plant root, the department above, and the cell itself are NOT marked", () => {
    const marked = markedAt("n-cell1");
    expect(marked).not.toContain("Plant-wide");
    expect(marked).not.toContain("In Assembly");
    expect(marked).not.toContain("On the line");
    expect(marked).not.toContain("At the cell");
    // The whole answer, so a new fixture row cannot slip past the two lists.
    expect(marked.sort()).toEqual(["From Plant 2", "In Machining", "On Line 10"]);
  });

  /**
   * The one fail-open that survives: with no cell there is no question to ask,
   * and an empty set annotates nobody. A popover mid-open, and `emptyIndex`
   * before the board has loaded, both land here.
   */
  it("marks nobody when the cell cannot be resolved", () => {
    expect(markedAt(null)).toEqual([]);
    expect(markedAt("n-cell1", false)).toEqual([]);
    expect(markedAt("n-not-in-this-window")).toEqual([]);
  });
});
