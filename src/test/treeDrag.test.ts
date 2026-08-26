/**
 * Acceptance for `src/features/admin/lib/treeDrag.ts` (brief P1-5g §8).
 *
 * 43 plain `it()` cases — no `it.each`, no dynamic registration — so the
 * count vitest reports is exactly the number of `it(` lines below.
 */
import { describe, expect, it } from "vitest";
import type { LevelRow, NodeRow } from "../features/admin/lib/hierarchy.ts";
import { canDropOn } from "../features/admin/lib/hierarchy.ts";
import type { HierarchyTemplateRef } from "../features/admin/lib/shapePicker.ts";
import { buildTreeRows, groupRowsByShape, legalParentsFor } from "../features/admin/lib/treeView.ts";
import {
  describeDrop,
  dropRailIndex,
  eligibleTargetIds,
  groupDropState,
  resolveDropZone,
  rowDropZones,
} from "../features/admin/lib/treeDrag.ts";

const TPL_S = "tpl1"; // "Standard Plant" — Site > Department > Line > Work Cell
const TPL_C = "tpl2"; // "Compact Site"   — Site > Line

const TEMPLATES: HierarchyTemplateRef[] = [
  { id: TPL_S, name: "Standard Plant" },
  { id: TPL_C, name: "Compact Site" },
];

// Deliberately NOT in position order, and Compact's position-1 level comes
// FIRST — see the header note on the template-blind lookup.
const LEVELS: LevelRow[] = [
  { id: "lv2", templateId: TPL_C, position: 0, name: "Site", isSchedulable: false },
  { id: "lv5", templateId: TPL_C, position: 1, name: "Line", isSchedulable: true },
  { id: "lv1", templateId: TPL_S, position: 0, name: "Site", isSchedulable: false },
  { id: "lv3", templateId: TPL_S, position: 1, name: "Department", isSchedulable: false },
  { id: "lv6", templateId: TPL_S, position: 3, name: "Work Cell", isSchedulable: true },
  { id: "lv4", templateId: TPL_S, position: 2, name: "Line", isSchedulable: false },
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

const NODES: NodeRow[] = [
  node("n5", "Plant 1", "plant_1", null, "lv1", 0),
  node("n2", "Assembly", "plant_1.assembly", "n5", "lv3", 0),
  node("n8", "Packing", "plant_1.packing", "n5", "lv3", 1),
  node("n1", "Line 1", "plant_1.assembly.line_1", "n2", "lv4", 0),
  node("n7", "Line 2", "plant_1.assembly.line_2", "n2", "lv4", 1),
  node("n3", "Line 1", "plant_1.packing.line_1", "n8", "lv4", 0),
  node("n6", "Cell 1", "plant_1.assembly.line_1.cell_1", "n1", "lv6", 0),
  node("n9", "Plant 2", "plant_2", null, "lv2", 2),
  node("n4", "Line A", "plant_2.line_a", "n9", "lv5", 0),
  node("n10", "Orphan", "orphan", null, "lv_missing", 3),
  // A SECOND Standard root. Two roots in one group is the case D90's guide
  // fixture needed and the only way to reach "a position-0 node dropped on a
  // same-structure node that is not its own descendant" — every other
  // Standard node is beneath Plant 1, so V9 without this row measures a
  // node_cycle and silently stops testing what its name claims.
  node("n11", "Plant 3", "plant_3", null, "lv1", 4),
];

const drop = (d: string, t: string) => describeDrop(d, t, NODES, LEVELS, TEMPLATES);

// Compared as SORTED ARRAYS, not as Sets — see §8.3: `JSON.stringify` cannot
// see into a `Set`, so a stringify-based comparison would pass vacuously.
const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

const okTargets = (draggedId: string): Set<string> => {
  const out = new Set<string>();
  for (const n of NODES) if (drop(draggedId, n.id).kind === "ok") out.add(n.id);
  return out;
};

const ROWS = buildTreeRows(NODES, LEVELS, new Set<string>());
const GROUPS = groupRowsByShape(ROWS, LEVELS, TEMPLATES);
const allRows = GROUPS.flatMap((g) => g.rows);
const rowOf = (id: string) => allRows.find((r) => r.node.id === id);

describe("treeDrag", () => {
  // -- R — no root drop zone (3) --------------------------------------------

  it("R1: canDropOn(n5, null) is legal but always a no-op", () => {
    const result = canDropOn("n5", null, NODES, LEVELS);
    expect(result).toEqual({ ok: true, noop: true });
  });

  it("R2: legalParentsFor(n5) contains no id === null", () => {
    const choices = legalParentsFor("n5", NODES, LEVELS);
    expect(choices.some((c) => c.id === null)).toBe(false);
  });

  it("R3: legalParentsFor(n1) contains no id === null either", () => {
    const choices = legalParentsFor("n1", NODES, LEVELS);
    expect(choices.some((c) => c.id === null)).toBe(false);
  });

  // -- V — describeDrop verdicts and wording (14) ---------------------------

  it("V1: n7 -> n8 is ok", () => {
    const v = drop("n7", "n8");
    expect(v.kind).toBe("ok");
    expect(v.reason).toBeNull();
    expect(v.message).toBe("Move Line 2 into Packing.");
  });

  it("V2: n1 -> n2 is a noop", () => {
    const v = drop("n1", "n2");
    expect(v.kind).toBe("noop");
    expect(v.message).toBe("Line 1 is already in Assembly.");
  });

  it("V3: n1 -> n1 is a self-drop", () => {
    const v = drop("n1", "n1");
    expect(v.kind).toBe("blocked");
    expect(v.reason).toBe("node_cycle");
    expect(v.message).toBe("You can't drop Line 1 onto itself.");
  });

  it("V4: n2 -> n6 is a subtree cycle, not level_mismatch", () => {
    const v = drop("n2", "n6");
    expect(v.reason).toBe("node_cycle");
    expect(v.message).toBe("You can't move Assembly into its own subtree.");
  });

  it("V5: n1 -> n8 is a path collision", () => {
    const v = drop("n1", "n8");
    expect(v.reason).toBe("path_collision");
    expect(v.message).toBe("Packing already has a child called Line 1.");
  });

  it("V6: n1 -> n4 is refused by 6b alone, position-legal", () => {
    const v = drop("n1", "n4");
    expect(v.reason).toBe("level_mismatch");
    expect(v.message).toBe("Line 1 belongs to the Standard Plant structure, not Compact Site.");
  });

  it("V7: n1 -> n9 has the same message regardless of which canDropOn step fired", () => {
    const v = drop("n1", "n9");
    expect(v.message).toBe("Line 1 belongs to the Standard Plant structure, not Compact Site.");
  });

  it("V8: n6 -> n5 names the correct parent level", () => {
    const v = drop("n6", "n5");
    expect(v.reason).toBe("level_mismatch");
    expect(v.message).toBe("A Work Cell can only sit under a Line.");
  });

  it("V9: n5 -> n11 is a position-0 node dropped cross-tree, same structure", () => {
    const v = drop("n5", "n11");
    expect(v.message).toBe("A Site is always a top-level node.");
  });

  it("V10: n1 -> n10 blames the unresolvable TARGET's structure", () => {
    const v = drop("n1", "n10");
    expect(v.message).toBe("We can't tell which site structure Orphan belongs to.");
  });

  it("V11: n10 -> n5 is invalid_argument, dragged node's own level is unresolvable", () => {
    const v = drop("n10", "n5");
    expect(v.reason).toBe("invalid_argument");
    expect(v.message).toBe("Orphan can't be moved right now.");
  });

  it("V12: an unknown dragged id falls back to 'This node'", () => {
    const v = drop("nope", "n2");
    expect(v.kind).toBe("blocked");
    expect(v.reason).toBe("invalid_argument");
    expect(v.message).toBe("This node can't be moved right now.");
  });

  it("V13: n1 -> n4 with no templates known falls back to the generic message", () => {
    const v = describeDrop("n1", "n4", NODES, LEVELS, []);
    expect(v.message).toBe("Line 1 belongs to a different site structure.");
  });

  it("V14: n9 -> n5, a position-0 node dropped cross-structure, structure dominates", () => {
    const v = drop("n9", "n5");
    expect(v.reason).toBe("level_mismatch");
    expect(v.message).toBe("Plant 2 belongs to the Compact Site structure, not Standard Plant.");
  });

  // -- E — the level-above lookup is template-scoped (2) --------------------

  it("E1: n1 -> n5 names the Department, never the Compact Line", () => {
    const v = drop("n1", "n5");
    expect(v.message).toBe("A Line can only sit under a Department.");
    expect(v.message).not.toContain("under a Line");
  });

  it("E2: with lv3 filtered out, n1 -> n5 says there is no level above it", () => {
    const levels = LEVELS.filter((l) => l.id !== "lv3");
    const v = describeDrop("n1", "n5", NODES, levels, TEMPLATES);
    expect(v.message).toBe("A Line has no level above it in this structure.");
  });

  // -- L — eligibleTargetIds ≡ describeDrop (7) ------------------------------

  it("L1: eligibleTargetIds(n7) equals okTargets(n7)", () => {
    expect(sorted(eligibleTargetIds("n7", NODES, LEVELS))).toEqual(sorted(okTargets("n7")));
  });

  it("L2: eligibleTargetIds(n1) equals okTargets(n1)", () => {
    expect(sorted(eligibleTargetIds("n1", NODES, LEVELS))).toEqual(sorted(okTargets("n1")));
  });

  it("L3: eligibleTargetIds(n6) equals okTargets(n6)", () => {
    expect(sorted(eligibleTargetIds("n6", NODES, LEVELS))).toEqual(sorted(okTargets("n6")));
  });

  it("L4: eligibleTargetIds(n9) equals okTargets(n9), and both are empty", () => {
    const eligible = eligibleTargetIds("n9", NODES, LEVELS);
    const ok = okTargets("n9");
    expect(sorted(eligible)).toEqual(sorted(ok));
    expect(eligible.size).toBe(0);
  });

  it("L5: eligibleTargetIds(n7) is non-empty and contains n8", () => {
    const eligible = eligibleTargetIds("n7", NODES, LEVELS);
    expect(eligible.size).toBeGreaterThan(0);
    expect(eligible.has("n8")).toBe(true);
  });

  it("L6: eligibleTargetIds(n1) contains neither n9 nor n4", () => {
    const eligible = eligibleTargetIds("n1", NODES, LEVELS);
    expect(eligible.has("n9")).toBe(false);
    expect(eligible.has("n4")).toBe(false);
  });

  it("L7: an unknown dragged id yields an empty set without throwing", () => {
    expect(() => {
      const eligible = eligibleTargetIds("nope", NODES, LEVELS);
      expect(eligible.size).toBe(0);
    }).not.toThrow();
  });

  // -- F — groupDropState (7) -------------------------------------------------

  it("F1: (n1, TPL_S) is candidate", () => {
    expect(groupDropState("n1", TPL_S, NODES, LEVELS)).toBe("candidate");
  });

  it("F2: (n1, TPL_C) is foreign", () => {
    expect(groupDropState("n1", TPL_C, NODES, LEVELS)).toBe("foreign");
  });

  it("F3: every foreign group holds no ok row for the dragged node", () => {
    let examined = 0;
    for (const dragged of NODES) {
      for (const group of GROUPS) {
        if (groupDropState(dragged.id, group.templateId, NODES, LEVELS) !== "foreign") continue;
        for (const row of group.rows) {
          examined += 1;
          expect(drop(dragged.id, row.node.id).kind).not.toBe("ok");
        }
      }
    }
    expect(examined).toBeGreaterThan(0);
  });

  it("F4: (n1, null) is foreign", () => {
    expect(groupDropState("n1", null, NODES, LEVELS)).toBe("foreign");
  });

  it("F5: (n10, TPL_S) and (n10, TPL_C) are both foreign", () => {
    expect(groupDropState("n10", TPL_S, NODES, LEVELS)).toBe("foreign");
    expect(groupDropState("n10", TPL_C, NODES, LEVELS)).toBe("foreign");
  });

  it("F6: (nope, TPL_S) is foreign", () => {
    expect(groupDropState("nope", TPL_S, NODES, LEVELS)).toBe("foreign");
  });

  it("F7: a candidate group still holds illegal rows", () => {
    expect(groupDropState("n1", TPL_S, NODES, LEVELS)).toBe("candidate");
    expect(drop("n1", "n5").kind).toBe("blocked");
  });

  // -- X — dropRailIndex, composed (4) --------------------------------------

  it("X1: dropRailIndex(0) === 1", () => {
    expect(dropRailIndex(0)).toBe(1);
  });

  it("X2: dropRailIndex(2) === 3", () => {
    expect(dropRailIndex(2)).toBe(3);
  });

  it("X3: a target's elbow rail lines up with its existing child's guides", () => {
    const target = rowOf("n2");
    const child = rowOf("n1");
    expect(target?.depth).toBe(1);
    expect(dropRailIndex(target!.depth)).toBe(child?.guides.length);
  });

  it("X4: at depth 0 the target renders no rails and the elbow still lines up", () => {
    const target = rowOf("n5");
    const child = rowOf("n2");
    expect(target?.depth).toBe(0);
    expect(target?.guides.length).toBe(0);
    expect(dropRailIndex(0)).toBe(child?.guides.length);
  });

  // -- N — malformed arguments (6) -------------------------------------------

  it("N1: empty nodes/levels/templates is blocked, invalid_argument, no throw", () => {
    expect(() => {
      const v = describeDrop("n1", "n2", [], [], []);
      expect(v.kind).toBe("blocked");
      expect(v.reason).toBe("invalid_argument");
    }).not.toThrow();
  });

  it("N2: nodes present, levels empty is invalid_argument", () => {
    const v = describeDrop("n1", "n2", NODES, [], TEMPLATES);
    expect(v.reason).toBe("invalid_argument");
  });

  it("N3: n1 -> an unknown target id is invalid_argument", () => {
    const v = drop("n1", "nope");
    expect(v.reason).toBe("invalid_argument");
    expect(v.message).toBe("Line 1 can't be moved right now.");
  });

  it("N4: eligibleTargetIds(n1, [], []) is empty", () => {
    expect(eligibleTargetIds("n1", [], []).size).toBe(0);
  });

  it("N5: groupDropState(n1, TPL_S, [], []) is foreign", () => {
    expect(groupDropState("n1", TPL_S, [], [])).toBe("foreign");
  });

  it("N6: dropRailIndex(-1) === 0, recorded, not clamped", () => {
    expect(dropRailIndex(-1)).toBe(0);
  });
});

/* ===========================================================================
 * Group R — `rowDropZones` / `resolveDropZone` (P1-5l, design plan §19.48).
 *
 * ⭐ WHY THIS GROUP EXISTS. The first gesture Pratik tried was the one P1-5g
 * excluded: *"I tried moving cell 3 between cell 1 and cell 2, but it turned
 * red."* Those are siblings, so it is a REORDER, and P1-5g only ever offered
 * re-parenting. The drag did what the brief said; the brief was wrong (D94).
 *
 * ⭐ AND THE HEADLINE FINDING, WHICH IS R15/R16: A ROW CAN NEVER OFFER ALL
 * THREE ZONES. Adoption wants the dragged node one rung BELOW the reference
 * row; a sibling slot wants it on the SAME rung. Both cannot hold, so §19.34's
 * planned three-band row does not exist and its band fractions never needed
 * settling. R15 proves it by exhaustion rather than repeating the argument.
 * ======================================================================== */

const zones = (d: string, r: string) => rowDropZones(d, r, ROWS, NODES, LEVELS, TEMPLATES);
/** Compact, order-preserving shape of a row's zones: `kind@index`. */
const shape = (d: string, r: string): string =>
  zones(d, r)
    .map((z) => `${z.kind}@${z.index ?? "-"}`)
    .join(",");
/**
 * Never INDEXES into a possibly-empty array. A probe that throws scores
 * CRASHED where a named failure belongs, and the first run of these cases did
 * exactly that — a cleanly-caught mutation looked like a broken one for a
 * minute (verification rule 6, instrument #17).
 */
const msg = (d: string, r: string, i: number): string =>
  zones(d, r)[i]?.verdict.message ?? "(no such zone)";

describe("treeDrag.ts: rowDropZones", () => {
  // ⭐ R1 IS THE GESTURE. Line 2 dropped on its own sibling Line 1.
  // `canDropOn(n7, n2)` returns `noop`, and the whole point is that `noop` is
  // LEGAL here — it is returned exactly when the dragged node already has
  // that parent, which is the definition of a pure reorder.
  it("R1: a peer row offers before/after — the reorder D94 was about", () => {
    expect(shape("n7", "n1")).toBe("before@0,after@1");
  });

  it("R2: a peer row offers no adoption — a Line cannot hold a Line", () => {
    expect(zones("n7", "n1").some((z) => z.kind === "adopt")).toBe(false);
  });

  // Line 2 (under Assembly) onto Packing's Line 1: a legal sibling slot under
  // Packing, and not adoptable. The first draft of this case dragged Line 1
  // instead and got NOTHING — `plant_1.packing.line_1` already exists, so it
  // measured a path_collision while claiming to measure a level rule (rule 3b).
  it("R3: a peer row under a DIFFERENT parent still offers before/after", () => {
    expect(shape("n7", "n3")).toBe("before@0,after@1");
  });

  it("R4: a row that can be a parent offers adoption alone", () => {
    expect(shape("n6", "n7")).toBe("adopt@-");
  });

  // Sibling slot would be a Cell under a Department (mismatch); adoption is a
  // noop, because the Cell is already there. Adopt keeps requiring `ok`.
  it("R5: a node's own parent row offers nothing", () => {
    expect(shape("n6", "n1")).toBe("");
  });

  it("R6: a row never hosts a drop of itself", () => {
    expect(shape("n1", "n1")).toBe("");
  });

  it("R7: two rungs apart offers neither zone", () => {
    expect(shape("n6", "n2")).toBe("");
  });

  it("R8: a name collision at the destination blocks the sibling slot", () => {
    expect(shape("n1", "n3")).toBe("");
  });

  // ⭐ R9 — ROOTS ARE SIBLINGS OF EACH OTHER, and their parent is `null`,
  // which `describeDrop` cannot express at all (it takes a `string`).
  // `rowDropZones` calls `canDropOn` directly for exactly this reason.
  it("R9: roots are peers of each other", () => {
    expect(shape("n11", "n5")).toBe("before@0,after@1");
  });

  it("R10: a root's index counts the other roots in display order", () => {
    expect(shape("n11", "n10")).toBe("before@2,after@3");
  });

  it("R11: a non-root over a root offers nothing — it cannot become a root", () => {
    expect(shape("n1", "n9")).toBe("");
  });

  it("R12: a row in another site structure offers nothing", () => {
    expect(shape("n1", "n4")).toBe("");
  });

  it("R13: a node dragged onto its own descendant offers nothing", () => {
    expect(shape("n2", "n1")).toBe("");
  });

  // Assembly(0) and Packing(1) are the only Departments; dropping Assembly
  // AFTER Packing is index 1, not 2, because `place_node` splices into the
  // sibling list with the moved node already removed.
  it("R14: the index excludes the dragged node", () => {
    expect(shape("n2", "n8")).toBe("before@0,after@1");
  });

  // ⭐ R15/R16 — proved by exhaustion over every pair, not argued.
  it("R15: no pair anywhere offers three zones", () => {
    let threes = 0;
    for (const d of NODES) for (const r of NODES) if (zones(d.id, r.id).length >= 3) threes += 1;
    expect(threes).toBe(0);
  });

  it("R16: the widest row offers exactly two", () => {
    let widest = 0;
    for (const d of NODES) for (const r of NODES) {
      widest = Math.max(widest, zones(d.id, r.id).length);
    }
    expect(widest).toBe(2);
  });

  it("R17: an unknown dragged id offers nothing", () => {
    expect(shape("nope", "n1")).toBe("");
  });

  it("R18: an unknown reference id offers nothing", () => {
    expect(shape("n1", "nope")).toBe("");
  });

  it("R19: a node whose level is missing offers nothing", () => {
    expect(shape("n10", "n5")).toBe("");
  });

  it("R20: the before message says ABOVE, not 'into'", () => {
    expect(msg("n7", "n1", 0)).toBe("Place Line 2 above Line 1.");
  });

  it("R21: the after message says BELOW", () => {
    expect(msg("n7", "n1", 1)).toBe("Place Line 2 below Line 1.");
  });

  it("R22: adoption keeps describeDrop's own sentence", () => {
    expect(msg("n6", "n7", 0)).toBe("Move Cell 1 into Line 2.");
  });

  // Collapsing hides DESCENDANTS, never siblings, so a visible row's peers
  // are all still in the flattened list the index is counted from.
  it("R23: a collapsed tree yields the same indices", () => {
    const collapsed = buildTreeRows(NODES, LEVELS, new Set(["n2", "n8"]));
    const z = rowDropZones("n2", "n8", collapsed, NODES, LEVELS, TEMPLATES);
    expect(z.map((x) => `${x.kind}@${x.index}`).join(",")).toBe("before@0,after@1");
  });
});

describe("treeDrag.ts: resolveDropZone", () => {
  const two = rowDropZones("n7", "n3", ROWS, NODES, LEVELS, TEMPLATES);
  const one = rowDropZones("n6", "n7", ROWS, NODES, LEVELS, TEMPLATES);

  it("R24: two zones, the top half is 'before'", () => {
    expect(resolveDropZone(two, 10, 32)?.kind).toBe("before");
  });

  it("R25: two zones, the bottom half is 'after'", () => {
    expect(resolveDropZone(two, 20, 32)?.kind).toBe("after");
  });

  // A boundary belongs to the band it opens.
  it("R26: the midpoint belongs to the lower band", () => {
    expect(resolveDropZone(two, 16, 32)?.kind).toBe("after");
  });

  it("R27: one zone takes the whole row, at the top", () => {
    expect(resolveDropZone(one, 0, 32)?.kind).toBe("adopt");
  });

  it("R28: one zone takes the whole row, at the bottom", () => {
    expect(resolveDropZone(one, 31, 32)?.kind).toBe("adopt");
  });

  it("R29: no zones resolves to null", () => {
    expect(resolveDropZone([], 10, 32)).toBeNull();
  });

  // ⭐ R30/R31 — the offset is deliberately NOT clamped. Against a single 0.5
  // boundary a negative offset is already below it and an over-long one
  // already above it, so a clamp changes no answer — measured, not argued: the
  // clamp was written, came back NOT CAUGHT by every case, and was removed.
  it("R30: an offset above the row still resolves to the top band", () => {
    expect(resolveDropZone(two, -50, 32)?.kind).toBe("before");
  });

  it("R31: an offset below the row still resolves to the bottom band", () => {
    expect(resolveDropZone(two, 999, 32)?.kind).toBe("after");
  });

  // A zero or negative height would make every boundary 0 and hand back the
  // last zone for any offset. The first is what a clamped offset of 0 gives.
  it("R32: a zero row height falls back to the first zone", () => {
    expect(resolveDropZone(two, 10, 0)?.kind).toBe("before");
  });

  it("R33: a negative row height falls back to the first zone", () => {
    expect(resolveDropZone(two, 10, -32)?.kind).toBe("before");
  });

  it("R34: a NaN offset falls back to the first zone", () => {
    expect(resolveDropZone(two, NaN, 32)?.kind).toBe("before");
  });

  it("R35: a NaN row height falls back to the first zone", () => {
    expect(resolveDropZone(two, 10, NaN)?.kind).toBe("before");
  });

  it("R36: an infinite row height falls back to the first zone", () => {
    expect(resolveDropZone(two, 10, Infinity)?.kind).toBe("before");
  });
});
