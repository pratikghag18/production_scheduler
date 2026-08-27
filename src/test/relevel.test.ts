/* ---------------------------------------------------------------------------
   P1-5k client half — `src/features/admin/lib/relevel.ts`. Group K, 36 cases.

   ONE PLAIN `it()` PER CASE, no `it.each`: the vitest count is then literally
   the number of `it(` lines in this file, which is what makes the predicted
   suite total arithmetic rather than a guess.

   Every case asserts a decision this module makes ABOUT AN AFFORDANCE. None of
   them asserts a server rule -- the server's rules are covered by
   `76_relevel_contract_test.sql` and `75_node_mobility_test.sql`, and the point
   of this module is only that the menu does not offer moves that cannot work.
   --------------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";
import type { LevelRow, NodeRow } from "@/features/admin/lib/hierarchy";
import {
  demoteTargets,
  destinationLevel,
  promoteVerdict,
  subtreeIds,
} from "@/features/admin/lib/relevel";

// ---------------------------------------------------------------------------
// Fixture. Two structures, because a single-template fixture cannot tell
// "same level" from "same position" -- two templates both have a position 1
// (rule 3: when two fields could each explain the same output, make them
// disagree). And two Lines share the NAME "Line 1" under different parents,
// which is legal and is what forces path labels.
// ---------------------------------------------------------------------------
const TPL_A = "tpl-a";
const TPL_B = "tpl-b";

const LEVELS: LevelRow[] = [
  { id: "a0", templateId: TPL_A, position: 0, name: "Site", isSchedulable: false },
  { id: "a1", templateId: TPL_A, position: 1, name: "Department", isSchedulable: false },
  { id: "a2", templateId: TPL_A, position: 2, name: "Line", isSchedulable: false },
  { id: "a3", templateId: TPL_A, position: 3, name: "Work Cell", isSchedulable: true },
  { id: "b0", templateId: TPL_B, position: 0, name: "Site", isSchedulable: false },
  { id: "b1", templateId: TPL_B, position: 1, name: "Bay", isSchedulable: true },
  { id: "b2", templateId: TPL_B, position: 2, name: "Station", isSchedulable: false },
];

function node(
  id: string,
  name: string,
  path: string,
  parentId: string | null,
  levelId: string,
): NodeRow {
  return { id, name, path, parentId, levelId, sortOrder: 0, active: true };
}

//  plant_1                      (Site, a0)
//    assembly                   (Department, a1)
//      line_1      "Line 1"     (Line, a2)
//        cell_1    "Cell 1"     (Work Cell, a3)
//        cell_2    "Cell 2"     (Work Cell, a3)
//      cell_1      "Cell 1"     (Line, a2)   <- collides with the cell's promote
//    machining                  (Department, a1)
//      line_1      "Line 1"     (Line, a2)   <- same NAME, different path
//  plant_2                      (Site, b0)
//    bay_1                      (Bay, b1)
const NODES: NodeRow[] = [
  node("p1", "Plant 1", "plant_1", null, "a0"),
  node("d1", "Assembly", "plant_1.assembly", "p1", "a1"),
  node("d2", "Machining", "plant_1.machining", "p1", "a1"),
  node("ln1", "Line 1", "plant_1.assembly.line_1", "d1", "a2"),
  node("ln2", "Line 1", "plant_1.machining.line_1", "d2", "a2"),
  node("c1", "Cell 1", "plant_1.assembly.line_1.cell_1", "ln1", "a3"),
  node("c2", "Cell 2", "plant_1.assembly.line_1.cell_2", "ln1", "a3"),
  node("clash", "Cell 1", "plant_1.assembly.cell_1", "d1", "a2"),
  node("p2", "Plant 2", "plant_2", null, "b0"),
  node("bay", "Bay 1", "plant_2.bay_1", "p2", "b1"),
];

const labels = (v: ReturnType<typeof demoteTargets>): string[] =>
  v.ok ? v.targets.map((t) => t.label) : [];

describe("relevel — subtreeIds", () => {
  it("K1: a subtree is the node itself plus every descendant", () => {
    expect([...subtreeIds("ln1", NODES)].sort()).toEqual(["c1", "c2", "ln1"]);
  });

  it("K2: a leaf's subtree is just itself", () => {
    expect([...subtreeIds("c1", NODES)]).toEqual(["c1"]);
  });

  it("K3: an id that is not in the array yields just that id", () => {
    expect([...subtreeIds("nope", NODES)]).toEqual(["nope"]);
  });

  it("K4: a sibling's subtree is not swept in", () => {
    expect(subtreeIds("ln1", NODES).has("ln2")).toBe(false);
  });

  it("K5: a cyclic array terminates instead of hanging", () => {
    // Impossible through the server (`nodes_before_cycle`), representable here.
    const cyclic: NodeRow[] = [
      node("x", "X", "x", "y", "a1"),
      node("y", "Y", "y", "x", "a1"),
    ];
    expect([...subtreeIds("x", cyclic)].sort()).toEqual(["x", "y"]);
  });
});

describe("relevel — destinationLevel", () => {
  it("K32: one rung up is the level the org actually calls that rung", () => {
    expect(destinationLevel("ln1", NODES, LEVELS, -1)?.name).toBe("Department");
  });

  it("K33: one rung down likewise", () => {
    expect(destinationLevel("ln1", NODES, LEVELS, 1)?.name).toBe("Work Cell");
  });

  it("K34: it stays inside the node's own structure, where positions repeat", () => {
    // Position 1 exists in BOTH templates. A lookup by position alone returns
    // whichever came first in the array, which is the bug this pins.
    expect(destinationLevel("bay", NODES, LEVELS, -1)?.id).toBe("b0");
  });

  it("K35: there is no rung above the top or below the bottom", () => {
    expect(destinationLevel("p1", NODES, LEVELS, -1)).toBe(null);
    expect(destinationLevel("c1", NODES, LEVELS, 1)).toBe(null);
  });

  it("K36: an unresolvable node reports null rather than throwing", () => {
    expect(destinationLevel("ghost", NODES, LEVELS, -1)).toBe(null);
  });
});

describe("relevel — promoteVerdict", () => {
  it("K6: a top-level node has no rung above it", () => {
    const v = promoteVerdict("p1", NODES);
    expect(v.ok === false && v.block.kind).toBe("root");
  });

  it("K7: a node with a clear destination is offered", () => {
    expect(promoteVerdict("c2", NODES).ok).toBe(true);
  });

  it("K8: a name already used at the destination blocks it, and names the row", () => {
    const v = promoteVerdict("c1", NODES);
    expect(v.ok === false && v.block.kind === "name-taken" && v.block.existingId).toBe("clash");
  });

  it("K9: the node's own PARENT counts as the clash when they share a name", () => {
    // Promoting `inner` puts it beside its parent, under `plant_1` -- where a
    // node called "Assembly" already sits. That parent is the colliding row.
    const withTwin = [...NODES, node("inner", "Assembly", "plant_1.assembly.assembly", "d1", "a2")];
    const v = promoteVerdict("inner", withTwin);
    expect(v.ok === false && v.block.kind === "name-taken" && v.block.existingId).toBe("d1");
  });

  it("K10: the block carries the destination's path, so the message can name it", () => {
    const v = promoteVerdict("c1", NODES);
    expect(v.ok === false && v.block.kind === "name-taken" && v.block.underLabel).toBe(
      "plant_1.assembly",
    );
  });

  it("K11: a destination of the TOP level reports an empty label, not a crash", () => {
    // `d1` promoted becomes a root; another root is already called "Assembly".
    const withRoot = [...NODES, node("r2", "Assembly", "assembly", null, "a0")];
    const v = promoteVerdict("d1", withRoot);
    expect(v.ok === false && v.block.kind === "name-taken" && v.block.underLabel).toBe("");
  });

  it("K12: an unknown node is OFFERED, not refused -- the mirror fails open", () => {
    expect(promoteVerdict("ghost", NODES).ok).toBe(true);
  });

  it("K13: a parent missing from a partial array is OFFERED, not refused", () => {
    const partial = NODES.filter((n) => n.id !== "ln1");
    expect(promoteVerdict("c1", partial).ok).toBe(true);
  });

  it("K14: a same name under a DIFFERENT parent is not a clash", () => {
    // "Line 1" exists twice, under `d1` and under `d2`. Promoting `ln2` puts it
    // under `p1`, where no "Line 1" sits.
    expect(promoteVerdict("ln2", NODES).ok).toBe(true);
  });

  it("K15: it does not mutate the array it is given", () => {
    const copy = NODES.map((n) => ({ ...n }));
    promoteVerdict("c1", NODES);
    expect(NODES).toEqual(copy);
  });
});

describe("relevel — demoteTargets", () => {
  it("K16: the node itself is never one of its own targets", () => {
    // Written first as "itself or anything beneath it", against `d1` -- and it
    // failed, twice over. `d1`'s subtree reaches the Work Cells, so it is
    // blocked by K17's rule before any list is built; and a DESCENDANT can
    // never be a candidate anyway, because it is always at a deeper rung than
    // the level filter allows. The only live half of the subtree exclusion, on
    // any tree the server can produce, is the node itself. K31 covers the other
    // half on data the server cannot produce but this array can.
    const v = demoteTargets("ln2", NODES, LEVELS);
    expect(labels(v)).toEqual(["plant_1.assembly.cell_1", "plant_1.assembly.line_1"]);
  });

  it("K17: the deepest level in the SUBTREE is what blocks it, not the node's own", () => {
    // `ln1` is a Line and Work Cell exists below it -- but its children are
    // already Work Cells, and there is no rung below those. §19.33 §4's
    // half-succeeding demote is exactly this shape.
    const v = demoteTargets("ln1", NODES, LEVELS);
    expect(v.ok === false && v.block.kind).toBe("no-rung-below");
  });

  it("K18: a childless node at the same depth IS demotable, so K17 is about the subtree", () => {
    const v = demoteTargets("clash", NODES, LEVELS);
    expect(v.ok && v.targets.length > 0).toBe(true);
  });

  it("K19: a node on the deepest rung has nowhere below to go", () => {
    const v = demoteTargets("c2", NODES, LEVELS);
    expect(v.ok === false && v.block.kind).toBe("no-rung-below");
  });

  it("K20: candidates in another structure are not offered", () => {
    // `d1` sits at position 1 of tpl-a; `bay` sits at position 1 of tpl-b.
    const v = demoteTargets("d1", NODES, LEVELS);
    expect(labels(v).includes("plant_2.bay_1")).toBe(false);
  });

  it("K21: candidates at a different rung of the SAME structure are not offered", () => {
    const v = demoteTargets("d1", NODES, LEVELS);
    expect(labels(v).some((l) => l.startsWith("plant_1.assembly."))).toBe(false);
  });

  it("K22: a target whose children already use this name is listed, but blocked", () => {
    // `ln2` ("Line 1" under Machining) demoted under `ln1` would collide with
    // nothing; demoted under `clash` -- which has no children -- likewise. So
    // the fixture gets a child of `ln1` named "Line 1" to make one target dirty.
    const nodes = [
      ...NODES,
      node("twin", "Line 1", "plant_1.assembly.line_1.line_1", "ln1", "a3"),
    ];
    const v = demoteTargets("clash", nodes, LEVELS);
    const dirty = v.ok ? v.targets.find((t) => t.id === "ln1") : undefined;
    expect(dirty?.blocked).toBe("name-taken");
  });

  it("K23: a clean target in the same list is not blocked", () => {
    const nodes = [
      ...NODES,
      node("twin", "Line 1", "plant_1.assembly.line_1.line_1", "ln1", "a3"),
    ];
    const v = demoteTargets("clash", nodes, LEVELS);
    const clean = v.ok ? v.targets.find((t) => t.id === "ln2") : undefined;
    expect(clean?.blocked).toBe(null);
  });

  it("K24: targets are labelled by PATH, so two same-named candidates differ", () => {
    const v = demoteTargets("clash", NODES, LEVELS);
    expect(labels(v)).toEqual(["plant_1.assembly.line_1", "plant_1.machining.line_1"]);
  });

  it("K25: targets are sorted by label, from an unsorted array", () => {
    const shuffled = [...NODES].reverse();
    expect(labels(demoteTargets("clash", shuffled, LEVELS))).toEqual([
      "plant_1.assembly.line_1",
      "plant_1.machining.line_1",
    ]);
  });

  it("K26: a node with a rung below but no company at its own rung reports no targets", () => {
    // `bay` is the only node at position 1 of tpl-b, and tpl-b has a position 2
    // -- so the rung check passes and the list is genuinely empty. Written
    // against `p2` first, which reports `no-rung-below` instead: its subtree
    // reaches the bottom of its own structure, so that case was never about
    // having no company at all.
    const v = demoteTargets("bay", NODES, LEVELS);
    expect(v.ok === false && v.block.kind).toBe("no-targets");
  });

  it("K27: an unknown node reports no targets rather than throwing", () => {
    const v = demoteTargets("ghost", NODES, LEVELS);
    expect(v.ok === false && v.block.kind).toBe("no-targets");
  });

  it("K28: a node whose level is absent from `levels` reports no targets", () => {
    const v = demoteTargets("c1", NODES, LEVELS.filter((l) => l.id !== "a3"));
    expect(v.ok === false && v.block.kind).toBe("no-targets");
  });

  it("K29: a CANDIDATE whose level is absent is skipped, not crashed on", () => {
    const orphan = [...NODES, node("weird", "Weird", "weird", null, "gone")];
    expect(labels(demoteTargets("clash", orphan, LEVELS))).toEqual([
      "plant_1.assembly.line_1",
      "plant_1.machining.line_1",
    ]);
  });

  it("K31: a descendant sitting at the node's OWN level is still excluded", () => {
    // The server cannot produce this -- `nodes_before_level` forces a child to
    // sit exactly one rung below its parent -- but this array can, and the
    // subtree exclusion is what refuses it. Without that line the node would be
    // offered a target inside its own subtree, which is `node_cycle`.
    const corrupt = [...NODES, node("bad", "Bad", "plant_1.machining.bad", "ln2", "a2")];
    expect(labels(demoteTargets("ln2", corrupt, LEVELS))).toEqual([
      "plant_1.assembly.cell_1",
      "plant_1.assembly.line_1",
    ]);
  });

  it("K30: it does not mutate the arrays it is given", () => {
    const copy = NODES.map((n) => ({ ...n }));
    demoteTargets("clash", NODES, LEVELS);
    expect(NODES).toEqual(copy);
  });
});
