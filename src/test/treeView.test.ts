import { describe, expect, it } from "vitest";
import { buildHierarchyTree } from "@/features/admin/lib/hierarchy";
import type { LevelRow, NodeRow } from "@/features/admin/lib/hierarchy";
import {
  buildTreeRows,
  flattenTree,
  legalParentsFor,
  ROOT_LABEL,
} from "@/features/admin/lib/treeView";

/**
 * Brief P1-5d §8 groups T (10) and P (11) for `flattenTree` /
 * `legalParentsFor` / `buildTreeRows`.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed and mutation-tested against all 5 of the
 * brief's §9 mutations (M9-M13) before this file was written; every one
 * broke its named case, and M9's and M11's collateral failures matched the
 * brief's table almost exactly (M11 also broke one extra case here, P5,
 * covered in the agent report).
 *
 * `legalParentsFor` never reimplements the tree rules -- it only asks
 * `canDropOn` (P1-5b, `src/features/admin/lib/hierarchy.ts`) about every
 * candidate, so this file's fixtures exercise the ASKING, not the rules
 * themselves (those are `hierarchy.test.ts`'s job).
 */

// D86: one shape, so every case here behaves exactly as it did pre-0014.
const TPL = "tpl-a";

const LEVELS: LevelRow[] = [
  { id: "L0", templateId: TPL, position: 0, name: "Site", isSchedulable: false },
  { id: "L1", templateId: TPL, position: 1, name: "Department", isSchedulable: false },
  { id: "L2", templateId: TPL, position: 2, name: "Line", isSchedulable: true },
  { id: "L3", templateId: TPL, position: 3, name: "Work Cell", isSchedulable: false },
];

function node(
  id: string,
  name: string,
  path: string,
  parentId: string | null,
  levelId: string,
  sortOrder = 0,
): NodeRow {
  return { id, name, path, parentId, levelId, sortOrder, active: true };
}

// Fixture paths are slug-consistent with their names (§10 trap 4 / D1-5b's
// M10 near-miss): a hand-written path that disagrees with what the name
// would actually slugify to makes a collision check silently untestable.
const NODES: NodeRow[] = [
  node("n_plant", "Plant 1", "plant_1", null, "L0"),
  node("n_assembly", "Assembly", "plant_1.assembly", "n_plant", "L1", 0),
  node("n_line1", "Line 1", "plant_1.assembly.line_1", "n_assembly", "L2", 0),
  node("n_line2", "Line 2", "plant_1.assembly.line_2", "n_assembly", "L2", 1),
  node("n_cell1", "Cell 1", "plant_1.assembly.line_1.cell_1", "n_line1", "L3", 0),
  node("n_cell2", "Cell 2", "plant_1.assembly.line_1.cell_2", "n_line1", "L3", 1),
];

const TREE = buildHierarchyTree(NODES, LEVELS);
const NONE_COLLAPSED: ReadonlySet<string> = new Set();

describe("treeView.ts: flattenTree", () => {
  it("T1: depth-first order matches sibling order", () => {
    const rows = flattenTree(TREE, NONE_COLLAPSED);
    expect(rows.map((r) => r.node.id)).toEqual([
      "n_plant",
      "n_assembly",
      "n_line1",
      "n_cell1",
      "n_cell2",
      "n_line2",
    ]);
  });

  it("T2: depths are computed correctly", () => {
    const rows = flattenTree(TREE, NONE_COLLAPSED);
    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r.depth]));
    expect(byId).toEqual({
      n_plant: 0,
      n_assembly: 1,
      n_line1: 2,
      n_cell1: 3,
      n_cell2: 3,
      n_line2: 2,
    });
  });

  it("T3: hasChildren is true only for rows with children", () => {
    const rows = flattenTree(TREE, NONE_COLLAPSED);
    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r.hasChildren]));
    expect(byId).toEqual({
      n_plant: true,
      n_assembly: true,
      n_line1: true,
      n_cell1: false,
      n_cell2: false,
      n_line2: false,
    });
  });

  it("T4: collapsing a node hides its whole subtree", () => {
    const rows = flattenTree(TREE, new Set(["n_line1"]));
    expect(rows.map((r) => r.node.id)).toEqual(["n_plant", "n_assembly", "n_line1", "n_line2"]);
  });

  it("T5: the collapsed flag is set on the collapsed row itself", () => {
    const rows = flattenTree(TREE, new Set(["n_line1"]));
    const line1 = rows.find((r) => r.node.id === "n_line1");
    expect(line1?.collapsed).toBe(true);
  });

  it("T6: collapsing a leaf changes nothing about the flattened rows", () => {
    const collapsed = flattenTree(TREE, new Set(["n_cell1"])).map((r) => r.node.id);
    const open = flattenTree(TREE, NONE_COLLAPSED).map((r) => r.node.id);
    expect(collapsed).toEqual(open);
  });

  it("T7: an unknown collapsed id is ignored -- no lookup table to keep in sync", () => {
    const rows = flattenTree(TREE, new Set(["does-not-exist"]));
    expect(rows.length).toBe(NODES.length);
  });

  it("T8: collapsing the root leaves just the root", () => {
    const rows = flattenTree(TREE, new Set(["n_plant"]));
    expect(rows.map((r) => r.node.id)).toEqual(["n_plant"]);
  });

  it("T9: an empty tree flattens to an empty array", () => {
    expect(flattenTree([], NONE_COLLAPSED)).toEqual([]);
  });

  it("T10 PROPERTY: flattenTree does not mutate its inputs", () => {
    const before = JSON.parse(JSON.stringify(TREE));
    flattenTree(TREE, new Set(["n_line1"]));
    expect(TREE).toEqual(before);
  });
});

describe("treeView.ts: legalParentsFor", () => {
  it("P2: a Work Cell's legal parents exclude its current parent (noop) and include the sibling line", () => {
    const choices = legalParentsFor("n_cell1", NODES, LEVELS);
    expect(choices).toEqual([{ id: "n_line2", label: "plant_1.assembly.line_2" }]);
  });

  it("P3: a Line may move under the other Department", () => {
    const nodes2: NodeRow[] = [
      ...NODES,
      node("n_dept2", "Dept 2", "plant_1.dept2", "n_plant", "L1", 1),
    ];
    const choices = legalParentsFor("n_line2", nodes2, LEVELS);
    expect(choices).toEqual([{ id: "n_dept2", label: "plant_1.dept2" }]);
  });

  it("P4: a Department with no other Department has an empty result", () => {
    expect(legalParentsFor("n_assembly", NODES, LEVELS)).toEqual([]);
  });

  it("P5: the root node has an empty result -- nowhere legal to go", () => {
    expect(legalParentsFor("n_plant", NODES, LEVELS)).toEqual([]);
  });

  it("P6: an unknown node id yields an empty result", () => {
    expect(legalParentsFor("does-not-exist", NODES, LEVELS)).toEqual([]);
  });

  it("P7: a second candidate appears once a second sibling exists at the right level", () => {
    const nodes2: NodeRow[] = [
      ...NODES,
      node("n_line3", "Line 3", "plant_1.assembly.line_3", "n_assembly", "L2", 2),
    ];
    const choices = legalParentsFor("n_cell1", nodes2, LEVELS);
    expect(choices).toEqual([
      { id: "n_line2", label: "plant_1.assembly.line_2" },
      { id: "n_line3", label: "plant_1.assembly.line_3" },
    ]);
  });

  // PROPERTY: (root) never co-occurs with node-parent choices, for any
  // node in the fixture. A root move requires level position 0; a move
  // under a node requires the target's position to be exactly ONE LESS
  // than the node's own -- no level has position -1 -- so (root) is either
  // the only entry or absent.
  it("P8 PROPERTY: (root) never co-occurs with node-parent choices, at any level", () => {
    for (const n of NODES) {
      const choices = legalParentsFor(n.id, NODES, LEVELS);
      const hasRoot = choices.some((c) => c.id === null);
      const hasNodeParents = choices.some((c) => c.id !== null);
      expect(hasRoot && hasNodeParents).toBe(false);
    }
  });

  // A position-0 node with a non-null parentId cannot occur through this
  // brief's own RPCs (D69 enforces it server-side), but `canDropOn` itself
  // does not enforce D69 -- it is asked a hypothetical, not consulted as a
  // gatekeeper of stored data -- so this fixture is the honest way to
  // exercise "a level-0 node CAN move to (root)" without contradicting the
  // schema.
  it("P9: a level-0 node not currently at root CAN move to (root)", () => {
    const weird = node("n_weird_root", "Weird Root", "weird_root", "n_plant", "L0", 9);
    const choices = legalParentsFor("n_weird_root", [...NODES, weird], LEVELS);
    expect(choices).toEqual([{ id: null, label: ROOT_LABEL }]);
  });

  it("P10: choices carry the id, not just the label", () => {
    const choices = legalParentsFor("n_cell1", NODES, LEVELS);
    expect(choices[0]).toEqual({ id: "n_line2", label: "plant_1.assembly.line_2" });
  });

  it("P11 PROPERTY: legalParentsFor does not mutate its inputs", () => {
    const beforeNodes = JSON.parse(JSON.stringify(NODES));
    const beforeLevels = JSON.parse(JSON.stringify(LEVELS));
    legalParentsFor("n_cell1", NODES, LEVELS);
    expect(NODES).toEqual(beforeNodes);
    expect(LEVELS).toEqual(beforeLevels);
  });

  // P12 is not decoration: every other P case yields 0 or 1 entries, so
  // without a two-choice fixture inserted in non-sorted order, the sort is
  // untestable and deleting it breaks nothing (§9's M13 exists to prove
  // that in reverse).
  it("P12: two legal parents come back SORTED (fixture inserted out of sorted order)", () => {
    const nodesOOO: NodeRow[] = [
      node("n_p", "Plant", "p", null, "L0"),
      node("n_dep", "Dep", "p.dep", "n_p", "L1"),
      node("n_zeta", "Zeta Line", "p.dep.zeta", "n_dep", "L2", 0),
      node("n_alpha", "Alpha Line", "p.dep.alpha", "n_dep", "L2", 1),
      node("n_current", "Current Line", "p.dep.current", "n_dep", "L2", 2),
      node("n_cell", "Cell", "p.dep.current.cell", "n_current", "L3", 0),
    ];
    const choices = legalParentsFor("n_cell", nodesOOO, LEVELS);
    expect(choices).toEqual([
      { id: "n_alpha", label: "p.dep.alpha" },
      { id: "n_zeta", label: "p.dep.zeta" },
    ]);
  });
});

describe("treeView.ts: buildTreeRows", () => {
  it("composes buildHierarchyTree + flattenTree -- one row per node when nothing is collapsed", () => {
    const rows = buildTreeRows(NODES, LEVELS, NONE_COLLAPSED);
    expect(rows.length).toBe(NODES.length);
  });
});

/**
 * Design-session verification, P1-5d review.
 *
 * `legalParentsFor` originally labelled each choice with the node's NAME.
 * `nodes` is `unique (org_id, parent_id, name)` — names are unique among
 * SIBLINGS ONLY — so three departments may each hold a "Line 1", all three are
 * legal parents for a cell, and the picker rendered two IDENTICAL rows with
 * nothing to tell them apart. The user picks one at random and silently
 * re-parents into the wrong subtree.
 *
 * The brief declared `label: string` and never said what went in it, so this
 * is a gap in the brief rather than a mistake by the build. Labels are now
 * paths, which are unique per `(org_id, path)` and cannot collide.
 */
describe("legalParentsFor — labels must be unambiguous", () => {
  const AMBIGUOUS: NodeRow[] = [
    {
      id: "p",
      name: "Plant 1",
      path: "plant_1",
      parentId: null,
      levelId: "L0",
      sortOrder: 0,
      active: true,
    },
    {
      id: "a",
      name: "Assembly",
      path: "plant_1.assembly",
      parentId: "p",
      levelId: "L1",
      sortOrder: 0,
      active: true,
    },
    {
      id: "m",
      name: "Machining",
      path: "plant_1.machining",
      parentId: "p",
      levelId: "L1",
      sortOrder: 1,
      active: true,
    },
    {
      id: "w",
      name: "Welding",
      path: "plant_1.welding",
      parentId: "p",
      levelId: "L1",
      sortOrder: 2,
      active: true,
    },
    // Three sibling departments, each with a "Line 1". All legal, all distinct.
    {
      id: "la",
      name: "Line 1",
      path: "plant_1.assembly.line_1",
      parentId: "a",
      levelId: "L2",
      sortOrder: 0,
      active: true,
    },
    {
      id: "lm",
      name: "Line 1",
      path: "plant_1.machining.line_1",
      parentId: "m",
      levelId: "L2",
      sortOrder: 0,
      active: true,
    },
    {
      id: "lw",
      name: "Line 1",
      path: "plant_1.welding.line_1",
      parentId: "w",
      levelId: "L2",
      sortOrder: 0,
      active: true,
    },
    {
      id: "c",
      name: "Cell 1",
      path: "plant_1.assembly.line_1.cell_1",
      parentId: "la",
      levelId: "L3",
      sortOrder: 0,
      active: true,
    },
  ];

  /**
   * FIXTURE INTEGRITY, and not padding. This block was committed with level
   * ids `l0..l3` while `LEVELS` above declares `L0..L3`, so `canDropOn`
   * rejected every candidate at its FIRST check ("dragged node's level id
   * absent from `levels`") and `legalParentsFor` returned `[]`.
   *
   * `[]` is a legitimate answer from this function -- it is what a node with
   * no legal parent anywhere returns. So a typo in a fixture id is
   * indistinguishable from the behaviour under test unless something asserts
   * the fixture is well-formed. The two cases below happen to catch it because
   * both assert a POSITIVE count; a case phrased only as "all labels are
   * distinct" would have passed on the empty list.
   */
  it("every fixture node references a level that exists in LEVELS", () => {
    const known = new Set(LEVELS.map((l) => l.id));
    expect(AMBIGUOUS.filter((n) => !known.has(n.levelId)).map((n) => n.id)).toEqual([]);
  });

  it("two same-named legal parents produce DISTINCT labels", () => {
    const labels = legalParentsFor("c", AMBIGUOUS, LEVELS).map((c) => c.label);
    expect(labels.length).toBe(2);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the label is the path, which is unique per (org_id, path)", () => {
    expect(legalParentsFor("c", AMBIGUOUS, LEVELS).map((c) => c.label)).toEqual([
      "plant_1.machining.line_1",
      "plant_1.welding.line_1",
    ]);
  });
});
