import { describe, expect, it } from "vitest";
import {
  applyLevelAction,
  findLevelOrderProblems,
  invalidNameIndices,
  levelDropTarget,
  MAX_LEVELS,
} from "@/features/admin/lib/levelDraft";
import type {
  LevelAction,
  LevelDraft,
  LevelOrderLevel,
  LevelOrderNode,
} from "@/features/admin/lib/levelDraft";

/**
 * Brief P1-5d §8 group L (20 assertions) for `applyLevelAction` /
 * `invalidNameIndices`.
 *
 * Authored, not run in this container (no npm) -- the /tmp harness copy of
 * this exact module was executed and mutation-tested against all 8 of the
 * brief's §9 mutations (M1-M8) before this file was written; see the agent
 * report for the full run, including the one mutation (M1) whose named
 * failing case did not match the brief's table -- L12/L13 test the same two
 * boundary conditions this suite does, just apparently numbered the other
 * way around in the reference implementation.
 *
 * `save_hierarchy_levels` takes the whole ordered array and the array index
 * IS the position (D70), so every case here is an array edit, never a
 * partial patch, and "positions must be contiguous" never appears as a rule
 * to test -- a payload cannot express a gap.
 */

function row(id: string | null, name: string, isSchedulable = false): LevelDraft {
  return { id, name, isSchedulable };
}

const BASE: LevelDraft[] = [
  row("s1", "Site", true),
  row("d1", "Department"),
  row("l1", "Line"),
  row("c1", "Work Cell"),
];

describe("levelDraft.ts: applyLevelAction", () => {
  it("L1: rename changes only the named row", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 1, name: "Dept" });
    expect(next.map((r) => r.name)).toEqual(["Site", "Dept", "Line", "Work Cell"]);
  });

  it("L2: moveUp swaps with the previous row", () => {
    const next = applyLevelAction(BASE, { kind: "moveUp", index: 1 });
    expect(next.map((r) => r.id)).toEqual(["d1", "s1", "l1", "c1"]);
  });

  it("L3: moveDown swaps with the next row", () => {
    const next = applyLevelAction(BASE, { kind: "moveDown", index: 1 });
    expect(next.map((r) => r.id)).toEqual(["s1", "l1", "d1", "c1"]);
  });

  // L4/L5: reference identity (`toBe`, not `toEqual`) is the point -- the
  // no-op contract is what lets the editor skip a re-render. A version that
  // returns a fresh, deep-equal array passes a deep-equality check and
  // fails the actual contract.
  it("L4: moveUp at index 0 is a no-op -- returns the SAME reference", () => {
    const next = applyLevelAction(BASE, { kind: "moveUp", index: 0 });
    expect(next).toBe(BASE);
  });

  it("L5: moveDown at the last index is a no-op -- returns the SAME reference", () => {
    const next = applyLevelAction(BASE, { kind: "moveDown", index: BASE.length - 1 });
    expect(next).toBe(BASE);
  });

  it("L6: add appends a blank, non-schedulable row", () => {
    const next = applyLevelAction(BASE, { kind: "add" });
    expect(next.length).toBe(5);
    expect(next[4]).toEqual({ id: null, name: "", isSchedulable: false });
  });

  it("L7: remove drops the named row and closes the gap", () => {
    const next = applyLevelAction(BASE, { kind: "remove", index: 2 });
    expect(next.map((r) => r.id)).toEqual(["s1", "d1", "c1"]);
  });

  // D72's most consequential rule: removing the schedulable row leaves
  // NONE schedulable. No auto-promotion -- silently choosing where all
  // scheduled work lives is not this editor's decision.
  it("L8: removing the schedulable level leaves NONE schedulable", () => {
    const next = applyLevelAction(BASE, { kind: "remove", index: 0 });
    expect(next.every((r) => !r.isSchedulable)).toBe(true);
  });

  it("L9: remove refuses to empty the list -- same reference at length 1", () => {
    const one: LevelDraft[] = [row("s1", "Site", true)];
    const next = applyLevelAction(one, { kind: "remove", index: 0 });
    expect(next).toBe(one);
  });

  it("L10: setSchedulable is radio semantics -- sets one, clears every other", () => {
    const next = applyLevelAction(BASE, { kind: "setSchedulable", index: 2 });
    expect(next.map((r) => r.isSchedulable)).toEqual([false, false, true, false]);
  });

  it("L11: setSchedulable still enforces radio semantics against a malformed multi-flag draft", () => {
    const mixed: LevelDraft[] = [row("a", "A", true), row("b", "B", true), row("c", "C")];
    const next = applyLevelAction(mixed, { kind: "setSchedulable", index: 2 });
    expect(next.map((r) => r.isSchedulable)).toEqual([false, false, true]);
  });

  // L12/L13: the cap is checked with `>`, not `>=` (§8) -- a draft AT
  // MAX_LEVELS may not add a (MAX_LEVELS+1)th row, but a draft one below
  // the cap still may.
  it("L12: at MAX_LEVELS - 1 entries, add succeeds", () => {
    const at63: LevelDraft[] = Array.from({ length: MAX_LEVELS - 1 }, (_, i) =>
      row(`id${i}`, `L${i}`),
    );
    const next = applyLevelAction(at63, { kind: "add" });
    expect(next.length).toBe(MAX_LEVELS);
  });

  it("L13: at MAX_LEVELS entries, add is a no-op -- same reference", () => {
    const at64: LevelDraft[] = Array.from({ length: MAX_LEVELS }, (_, i) => row(`id${i}`, `L${i}`));
    const next = applyLevelAction(at64, { kind: "add" });
    expect(next).toBe(at64);
  });

  it("L14 PROPERTY: the input array (and its rows) are never mutated", () => {
    const original: LevelDraft[] = [row("s1", "Site", true), row("d1", "Department")];
    const snapshot = JSON.parse(JSON.stringify(original));
    const actions: LevelAction[] = [
      { kind: "rename", index: 0, name: "Plant" },
      { kind: "moveDown", index: 0 },
      { kind: "add" },
      { kind: "remove", index: 0 },
      { kind: "setSchedulable", index: 1 },
    ];
    for (const action of actions) applyLevelAction(original, action);
    expect(original).toEqual(snapshot);
  });

  it("L15 PROPERTY: row objects are cloned, not shared, across the whole array", () => {
    const original: LevelDraft[] = [row("s1", "Site", true), row("d1", "Department")];
    const next = applyLevelAction(original, { kind: "rename", index: 1, name: "Dept" });
    // The row that WASN'T touched must still be a fresh object reference
    // (a shallow `[...draft]` clone would leave it shared) while remaining
    // value-equal.
    expect(next[0]).not.toBe(original[0]);
    expect(next[0]).toEqual(original[0]);
  });

  it("L16: rename to the current value is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 0, name: "Site" });
    expect(next).toBe(BASE);
  });

  it("L17: an out-of-range index is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 99, name: "X" });
    expect(next).toBe(BASE);
  });

  it("L18: a non-integer index is a no-op -- same reference", () => {
    const next = applyLevelAction(BASE, { kind: "rename", index: 1.5, name: "X" });
    expect(next).toBe(BASE);
  });
});

describe("levelDraft.ts: invalidNameIndices", () => {
  it("L19: flags blank and whitespace-only names, by index", () => {
    const draft: LevelDraft[] = [row("a", "Site"), row("b", "   "), row("c", ""), row("d", "Ok")];
    expect(invalidNameIndices(draft)).toEqual([1, 2]);
  });

  // `validateLevelDraft` (P1-5b) remains the authority on WHETHER the draft
  // is valid; this only says WHERE to draw the error styling, and it must
  // tolerate a malformed row rather than throw -- a validator the admin
  // form calls on every keystroke must never throw.
  it("L20: tolerates a malformed row (null / missing name) without throwing", () => {
    const draft = [
      row("a", "Site"),
      null,
      { id: "c" },
      undefined,
      row("d", "Ok"),
    ] as unknown as LevelDraft[];
    expect(() => invalidNameIndices(draft)).not.toThrow();
    expect(invalidNameIndices(draft)).toEqual([1, 2, 3]);
  });
});

/* ===========================================================================
 * Group S — `findLevelOrderProblems`, D92's client mirror (design plan §19.30).
 *
 * The server is the authority: migration 0016's two OUTCOME checks plus
 * `save_hierarchy_levels`'s older check 7. These cases mirror what that
 * function refuses, over the DRAFT order.
 *
 * THE FIXTURE IS LOAD-BEARING, one piece at a time:
 *  - TWO templates in the SAME org. A second template in another ORG could not
 *    tell org-scoping from template-scoping — D92's L16 needed three attempts
 *    to learn that.
 *  - Template U is STORED SCRAMBLED (its root's level at position 1, its
 *    child's at 0). So a mirror that forgot to scope by template reports U's
 *    two violations while editing T, and S1 fails.
 *  - Template T has FIVE levels, the last of which is EMPTY, so "remove a level
 *    that has nodes" (S9) and "remove one that does not" (S10) are both
 *    reachable from one fixture.
 *  - T has TWO roots, so `nodeCount` aggregation is testable (S2).
 *  - T is three generations deep, so a swap can strand a child WITHOUT
 *    stranding its own child (S2's Work Cell stays sound) — an aggregate
 *    "is anything wrong" answer cannot pass S2.
 * ======================================================================== */

const T = "tpl-t";
const U = "tpl-u";

function lvl(id: string, templateId: string, position: number, name: string): LevelOrderLevel {
  return { id, templateId, position, name };
}

function nd(id: string, parentId: string | null, levelId: string): LevelOrderNode {
  return { id, parentId, levelId };
}

const T_LEVELS: LevelOrderLevel[] = [
  lvl("t0", T, 0, "Site"),
  lvl("t1", T, 1, "Department"),
  lvl("t2", T, 2, "Line"),
  lvl("t3", T, 3, "Work Cell"),
  lvl("t4", T, 4, "Station"),
];

const U_LEVELS: LevelOrderLevel[] = [lvl("u0", U, 1, "Plant"), lvl("u1", U, 0, "Cell")];

const LEVELS: LevelOrderLevel[] = [...T_LEVELS, ...U_LEVELS];

const NODES: LevelOrderNode[] = [
  nd("n1", null, "t0"),
  nd("n2", null, "t0"),
  nd("n3", "n1", "t1"),
  nd("n4", "n3", "t2"),
  nd("n5", "n4", "t3"),
  nd("m1", null, "u0"),
  nd("m2", "m1", "u1"),
];

/**
 * A draft from a list of level ids, `null` for a brand-new row. Deliberately
 * does NOT use `find(...)!` — a helper that throws scores a crash where a named
 * failure belongs (verification-standard rule 6 #17).
 */
function draftOf(...ids: readonly (string | null)[]): LevelDraft[] {
  return ids.map((id) => {
    if (id === null) return { id: null, name: "New level", isSchedulable: false };
    const known = LEVELS.find((l) => l.id === id);
    return { id, name: known === undefined ? id : known.name, isSchedulable: false };
  });
}

describe("levelDraft.ts: findLevelOrderProblems", () => {
  it("S1: the stored order over a sound structure has no problems", () => {
    expect(findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3", "t4"), LEVELS, NODES, T)).toEqual(
      [],
    );
  });

  it("S2: swapping the top two levels strands the roots and two generations of children", () => {
    expect(findLevelOrderProblems(draftOf("t1", "t0", "t2", "t3", "t4"), LEVELS, NODES, T)).toEqual([
      { kind: "root_below_first_level", levelId: "t0", levelName: "Site", nodeCount: 2 },
      {
        kind: "child_not_directly_below_parent",
        levelId: "t1",
        levelName: "Department",
        nodeCount: 1,
      },
      { kind: "child_not_directly_below_parent", levelId: "t2", levelName: "Line", nodeCount: 1 },
    ]);
  });

  // S3 is the half a parent join cannot see (0016's case T34): a structure with
  // one root and NO children has no parent/child pair at all, so a mirror that
  // implemented only the adjacency clause scores zero violations here while the
  // root sits off position 0.
  it("S3: a structure with one root and no children still reports the stranded root", () => {
    const levels = [lvl("a0", "A", 0, "Site"), lvl("a1", "A", 1, "Area")];
    const nodes = [nd("r1", null, "a0")];
    const draft: LevelDraft[] = [
      { id: "a1", name: "Area", isSchedulable: false },
      { id: "a0", name: "Site", isSchedulable: true },
    ];
    expect(findLevelOrderProblems(draft, levels, nodes, "A")).toEqual([
      { kind: "root_below_first_level", levelId: "a0", levelName: "Site", nodeCount: 1 },
    ]);
  });

  // The mirror image of S3: the roots are untouched, so ONLY the adjacency
  // clause fires. The expected ORDER is the point as much as the contents —
  // "Line, Department, Work Cell" is neither the fixture's order nor
  // alphabetical, so a sort by name or by input position fails here.
  it("S4: swapping two middle levels leaves the roots alone and strands three children", () => {
    expect(findLevelOrderProblems(draftOf("t0", "t2", "t1", "t3", "t4"), LEVELS, NODES, T)).toEqual([
      { kind: "child_not_directly_below_parent", levelId: "t2", levelName: "Line", nodeCount: 1 },
      {
        kind: "child_not_directly_below_parent",
        levelId: "t1",
        levelName: "Department",
        nodeCount: 1,
      },
      {
        kind: "child_not_directly_below_parent",
        levelId: "t3",
        levelName: "Work Cell",
        nodeCount: 1,
      },
    ]);
  });

  // ⭐ S5 IS THE CASE THIS WHOLE DESIGN EXISTS FOR — the client twin of the
  // server's L15. The STORED positions are scrambled (Site at 1, Department at
  // 0) and the draft drags them back into shape. The server permits this
  // repair; a client that greyed out the populated rows would forbid it. It
  // also pins that positions are read from the DRAFT INDEX and never from
  // `level.position`: a mirror that read the stored positions reports two
  // violations here.
  it("S5: a scrambled stored order dragged back into shape has no problems (the repair)", () => {
    const scrambled: LevelOrderLevel[] = [
      lvl("t0", T, 1, "Site"),
      lvl("t1", T, 0, "Department"),
      lvl("t2", T, 2, "Line"),
      lvl("t3", T, 3, "Work Cell"),
      lvl("t4", T, 4, "Station"),
      ...U_LEVELS,
    ];
    expect(
      findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3", "t4"), scrambled, NODES, T),
    ).toEqual([]);
  });

  it("S6: adding a level at the bottom moves nothing and has no problems", () => {
    expect(
      findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3", "t4", null), LEVELS, NODES, T),
    ).toEqual([]);
  });

  // S7 and S8 are the two halves of "insert a level mid-hierarchy", the thing
  // P1-5k will unlock. At the TOP every parent/child pair still lines up and
  // only the root clause fires; ONE RUNG DOWN the roots are fine and only the
  // adjacency clause fires, on exactly one level.
  it("S7: inserting a level above the roots reports only the roots", () => {
    expect(
      findLevelOrderProblems(draftOf(null, "t0", "t1", "t2", "t3", "t4"), LEVELS, NODES, T),
    ).toEqual([{ kind: "root_below_first_level", levelId: "t0", levelName: "Site", nodeCount: 2 }]);
  });

  it("S8: inserting a level below the roots reports only the level that lost its parent", () => {
    expect(
      findLevelOrderProblems(draftOf("t0", null, "t1", "t2", "t3", "t4"), LEVELS, NODES, T),
    ).toEqual([
      {
        kind: "child_not_directly_below_parent",
        levelId: "t1",
        levelName: "Department",
        nodeCount: 1,
      },
    ]);
  });

  it("S9: removing a level that still has nodes is reported, under its stored name", () => {
    expect(findLevelOrderProblems(draftOf("t0", "t1", "t2", "t4"), LEVELS, NODES, T)).toEqual([
      {
        kind: "level_removed_with_nodes",
        levelId: "t3",
        levelName: "Work Cell",
        nodeCount: 1,
      },
    ]);
  });

  it("S10: removing a level that has no nodes has no problems", () => {
    expect(findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3"), LEVELS, NODES, T)).toEqual([]);
  });

  // The other direction of S1's scope claim, on the SAME fixture: template U is
  // stored scrambled, and editing U in its stored order reports exactly its two
  // violations. S1 (sound draft for T, U untouched and broken) and S11 together
  // say the scope is the template, not the org.
  it("S11: editing the other template reports that template's own problems", () => {
    expect(findLevelOrderProblems(draftOf("u1", "u0"), LEVELS, NODES, U)).toEqual([
      { kind: "root_below_first_level", levelId: "u0", levelName: "Plant", nodeCount: 1 },
      { kind: "child_not_directly_below_parent", levelId: "u1", levelName: "Cell", nodeCount: 1 },
    ]);
  });

  it("S12: a null templateId has no problems to report", () => {
    expect(findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3", "t4"), LEVELS, NODES, null)).toEqual(
      [],
    );
  });

  // The admin has to be able to connect the message to a row on screen, so a
  // level renamed in the draft is named by its DRAFT name, not the stored one.
  it("S13: a level renamed in the draft is reported under the new name", () => {
    const draft: LevelDraft[] = [
      { id: "t1", name: "Department", isSchedulable: false },
      { id: "t0", name: "Facility", isSchedulable: true },
      { id: "t2", name: "Line", isSchedulable: false },
      { id: "t3", name: "Work Cell", isSchedulable: false },
      { id: "t4", name: "Station", isSchedulable: false },
    ];
    expect(findLevelOrderProblems(draft, LEVELS, NODES, T)[0]).toEqual({
      kind: "root_below_first_level",
      levelId: "t0",
      levelName: "Facility",
      nodeCount: 2,
    });
  });

  it("S14: a level whose draft name is blank falls back to its stored name", () => {
    const draft: LevelDraft[] = [
      { id: "t1", name: "Department", isSchedulable: false },
      { id: "t0", name: "   ", isSchedulable: true },
      { id: "t2", name: "Line", isSchedulable: false },
      { id: "t3", name: "Work Cell", isSchedulable: false },
      { id: "t4", name: "Station", isSchedulable: false },
    ];
    expect(findLevelOrderProblems(draft, LEVELS, NODES, T)[0].levelName).toBe("Site");
  });

  // Verification-standard rule 4: a suite that only ever passes well-formed
  // arguments tests the happy path of the error handling. `validateLevelDraft`
  // shipped THROWING on a null name and nobody noticed for two briefs.
  it("S15: a non-array draft, levels or nodes returns [] rather than throwing", () => {
    const bad = null as unknown as LevelDraft[];
    expect(findLevelOrderProblems(bad, LEVELS, NODES, T)).toEqual([]);
    expect(findLevelOrderProblems(draftOf("t0"), bad as unknown as LevelOrderLevel[], NODES, T)).toEqual([]);
    expect(findLevelOrderProblems(draftOf("t0"), LEVELS, bad as unknown as LevelOrderNode[], T)).toEqual([]);
  });

  it("S16: null, undefined and wrong-typed entries inside the arrays do not throw", () => {
    const draft = [null, undefined, { id: 7, name: 3, isSchedulable: "yes" }, ...draftOf("t0")];
    const levels = [null, undefined, { id: 7 }, ...LEVELS];
    const nodes = [null, undefined, { id: 7, parentId: NaN, levelId: 7 }, ...NODES];
    expect(() =>
      findLevelOrderProblems(
        draft as unknown as LevelDraft[],
        levels as unknown as LevelOrderLevel[],
        nodes as unknown as LevelOrderNode[],
        T,
      ),
    ).not.toThrow();
  });

  // A node whose parent is not in the list, and a node on a level that is not
  // in the list, are both skipped: the server can see rows this client read
  // cannot, and guessing at them is how a client ends up stricter than the
  // server. `n7` also drives the one path where the PARENT's level is unknown.
  it("S17: nodes with an unreachable parent or an unknown level are skipped", () => {
    const nodes = [...NODES, nd("n8", null, "t9"), nd("n7", "n8", "t2"), nd("n6", "ghost", "t2")];
    expect(findLevelOrderProblems(draftOf("t0", "t1", "t2", "t3", "t4"), LEVELS, nodes, T)).toEqual(
      [],
    );
  });

  // S18 was written because a mutation found the hole, not because the design
  // predicted it: keying the tally on the level alone instead of on (kind,
  // level) passed every case above. ONE LEVEL CAN CARRY TWO DIFFERENT KINDS OF
  // PROBLEM, and a database scrambled by a pre-0016 save is exactly where that
  // happens -- roots stay where they were while `create_node` puts new children
  // one rung under a parent that has since moved. Here "Mid" holds a stranded
  // ROOT and a stranded CHILD at the same time, and both have to be said.
  it("S18: one level can carry both a stranded root and a stranded child", () => {
    const levels = [
      lvl("b0", "B", 0, "Top"),
      lvl("b1", "B", 1, "Mid"),
      lvl("b2", "B", 2, "Deep"),
    ];
    const nodes = [
      nd("x1", null, "b1"),
      nd("x2", null, "b0"),
      nd("x4", "x2", "b2"),
      nd("x3", "x4", "b1"),
    ];
    const draft: LevelDraft[] = [
      { id: "b0", name: "Top", isSchedulable: false },
      { id: "b1", name: "Mid", isSchedulable: false },
      { id: "b2", name: "Deep", isSchedulable: true },
    ];
    expect(findLevelOrderProblems(draft, levels, nodes, "B")).toEqual([
      { kind: "root_below_first_level", levelId: "b1", levelName: "Mid", nodeCount: 1 },
      { kind: "child_not_directly_below_parent", levelId: "b1", levelName: "Mid", nodeCount: 1 },
      { kind: "child_not_directly_below_parent", levelId: "b2", levelName: "Deep", nodeCount: 1 },
    ]);
  });
});

/* ===========================================================================
 * Group M — `moveTo` (P1-5i, design plan §19.48).
 *
 * The level list is the EASY half of the drag build: the array index IS the
 * stored position (D70), there is no illegal target, and P1-5j's Save gate
 * already refuses an order that would strand nodes. So this is a pure draft
 * edit with no server call.
 *
 * ⭐ THE ONE SUBTLETY IS THE OFF-BY-ONE. `to` is where the row ENDS UP, read
 * against the array with the row already lifted out — which is what a caret
 * between two rows means. Insert-then-remove makes a downward drag land one
 * short; M1 and M11 are what catch it.
 * ======================================================================== */

describe("levelDraft.ts: moveTo", () => {
  const M = (...names: string[]): LevelDraft[] =>
    names.map((n, i) => ({ id: `m${i}`, name: n, isSchedulable: n === "Cell" }));
  const BASE = M("Site", "Dept", "Line", "Cell");
  const names = (d: readonly LevelDraft[]): string => d.map((r) => r.name).join(",");
  const moveTo = (from: number, to: number): string =>
    names(applyLevelAction(BASE, { kind: "moveTo", from, to }));

  it("M1: a downward drag lands AT the target index, not one short", () => {
    expect(moveTo(0, 2)).toBe("Dept,Line,Site,Cell");
  });

  it("M2: a downward drag of one is a single swap", () => {
    expect(moveTo(0, 1)).toBe("Dept,Site,Line,Cell");
  });

  it("M3: an upward drag of two", () => {
    expect(moveTo(3, 1)).toBe("Site,Cell,Dept,Line");
  });

  it("M4: an upward drag of one is a single swap", () => {
    expect(moveTo(1, 0)).toBe("Dept,Site,Line,Cell");
  });

  it("M5: first to last", () => {
    expect(moveTo(0, 3)).toBe("Dept,Line,Cell,Site");
  });

  it("M6: last to first", () => {
    expect(moveTo(3, 0)).toBe("Cell,Site,Dept,Line");
  });

  it("M7: a move to the same index changes nothing", () => {
    expect(moveTo(2, 2)).toBe("Site,Dept,Line,Cell");
  });

  // Identity returns the SAME REFERENCE, so React does not re-render and Save
  // does not light up for a gesture that changed nothing.
  it("M8: a move to the same index returns the original array", () => {
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 2, to: 2 })).toBe(BASE);
  });

  it("M9: every out-of-range index is a no-op", () => {
    expect(applyLevelAction(BASE, { kind: "moveTo", from: -1, to: 2 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 2, to: -1 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 4, to: 0 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 0, to: 4 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 1.5, to: 0 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 0, to: 1.5 })).toBe(BASE);
  });

  it("M10: NaN at either end is a no-op", () => {
    expect(applyLevelAction(BASE, { kind: "moveTo", from: NaN, to: 0 })).toBe(BASE);
    expect(applyLevelAction(BASE, { kind: "moveTo", from: 0, to: NaN })).toBe(BASE);
  });

  // ⭐ M11/M12 — asserted against the ADJACENT SWAPS this action replaces,
  // not against a second hand-written expectation. "Same result, one step" is
  // the claim; comparing to a hand-written string would only re-assert M1.
  it("M11: one downward moveTo equals the swap chain it replaces", () => {
    let viaSwaps: readonly LevelDraft[] = BASE;
    for (let i = 0; i < 2; i += 1) {
      viaSwaps = applyLevelAction(viaSwaps, { kind: "moveDown", index: i });
    }
    expect(names(viaSwaps)).toBe(moveTo(0, 2));
  });

  it("M12: one upward moveTo equals the swap chain it replaces", () => {
    let viaSwaps: readonly LevelDraft[] = BASE;
    for (let i = 3; i > 1; i -= 1) {
      viaSwaps = applyLevelAction(viaSwaps, { kind: "moveUp", index: i });
    }
    expect(names(viaSwaps)).toBe(moveTo(3, 1));
  });

  it("M13: the schedulable flag travels with its row, not with the position", () => {
    const moved = applyLevelAction(BASE, { kind: "moveTo", from: 3, to: 0 });
    expect(moved.map((r) => r.isSchedulable)).toEqual([true, false, false, false]);
  });

  // ⭐ M14/M15 exist because a mutation proved nothing else could tell. A
  // reposition mutates no row, so `draft.slice()` gives an identical-looking
  // answer while aliasing the caller's row objects — and the day someone adds
  // a field edit to this arm it would start writing through into their state.
  // Every other arm of this reducer clones; these pin that this one does too.
  it("M14: the moved row is a copy, not the caller's object", () => {
    const moved = applyLevelAction(BASE, { kind: "moveTo", from: 3, to: 0 });
    expect(moved[0]).not.toBe(BASE[3]);
  });

  it("M15: rows that did not move are copies too", () => {
    const moved = applyLevelAction(BASE, { kind: "moveTo", from: 3, to: 0 });
    expect(moved[1]).not.toBe(BASE[0]);
  });

  it("M16: the caller's array is left untouched", () => {
    const before = names(BASE);
    applyLevelAction(BASE, { kind: "moveTo", from: 0, to: 3 });
    expect(names(BASE)).toBe(before);
  });
});

/**
 * P1-6e group P (25 cases) for `levelDropTarget` -- the seam a level drag
 * lands on, and the two seams that promise nothing.
 *
 * Written and mutation-tested BEFORE this file was touched: 25 cases green
 * cold, 11 mutations, 10 CAUGHT and 1 (W5) executed and measured INERT with
 * the reason pinned by P25. The list itself came out of a measurement rather
 * than a reading -- the real markup and stylesheet rendered in headless
 * Chromium, the component's own handlers driven over that geometry, and the
 * result fed through the real `applyLevelAction`: 528 of 528 drop pixels
 * agreed with the caret, and 231 of them drew a caret that changed nothing.
 */
describe("levelDraft.ts: levelDropTarget", () => {
  const NAMES = ["Site", "Department", "Line", "Work Cell"];
  const ROWS: LevelDraft[] = NAMES.map((n, i) => ({
    id: `l${i}`,
    name: n,
    isSchedulable: i === 3,
  }));
  const order = (rows: readonly LevelDraft[]): string => rows.map((r) => r.name).join(",");

  // --- the plain seams, both directions ------------------------------------
  it("P1: top half of a row well above the dragged one lands before it", () => {
    expect(levelDropTarget(3, 0, true, 4)).toEqual({ caretAt: 0, landAt: 0 });
  });

  it("P2: bottom half of a row well above lands after it", () => {
    expect(levelDropTarget(3, 0, false, 4)).toEqual({ caretAt: 1, landAt: 1 });
  });

  it("P3: top half of a row well below lands before it, shifted by the splice", () => {
    expect(levelDropTarget(0, 3, true, 4)).toEqual({ caretAt: 3, landAt: 2 });
  });

  it("P4: bottom half of a row well below lands after it", () => {
    expect(levelDropTarget(0, 3, false, 4)).toEqual({ caretAt: 4, landAt: 3 });
  });

  it("P5: the downward off-by-one is real -- caretAt 4 is landAt 3, not 4", () => {
    const t = levelDropTarget(0, 3, false, 4);
    expect(t && t.caretAt - t.landAt).toBe(1);
  });

  it("P6: the upward direction takes NO subtraction", () => {
    const t = levelDropTarget(3, 1, true, 4);
    expect(t && t.caretAt === t.landAt).toBe(true);
  });

  // --- the collapse ---------------------------------------------------------
  // Dragging row 2: row 1's BOTTOM half is seam 2, which is where row 2 already
  // is. Before P1-6e that half drew a caret and did nothing.
  it("P7: bottom half of the row ABOVE the dragged one is dead, so it collapses up", () => {
    expect(levelDropTarget(2, 1, false, 4)).toEqual({ caretAt: 1, landAt: 1 });
  });

  // Dragging row 1: row 2's TOP half is seam 2 == from + 1, the same position
  // approached from the other side.
  it("P8: top half of the row BELOW the dragged one is dead, so it collapses down", () => {
    expect(levelDropTarget(1, 2, true, 4)).toEqual({ caretAt: 3, landAt: 2 });
  });

  it("P9: after the collapse the whole row above means one thing", () => {
    expect(levelDropTarget(2, 1, true, 4)?.landAt).toBe(levelDropTarget(2, 1, false, 4)?.landAt);
  });

  it("P10: after the collapse the whole row below means one thing", () => {
    expect(levelDropTarget(1, 2, true, 4)?.landAt).toBe(levelDropTarget(1, 2, false, 4)?.landAt);
  });

  it("P11: a row two away keeps BOTH of its halves -- the collapse is local", () => {
    expect(levelDropTarget(0, 2, true, 4)?.landAt).not.toBe(
      levelDropTarget(0, 2, false, 4)?.landAt,
    );
  });

  // --- properties, swept over every input ----------------------------------
  const sweep = (): Array<{
    from: number;
    over: number;
    above: boolean;
    count: number;
    t: ReturnType<typeof levelDropTarget>;
  }> => {
    const out = [];
    for (let count = 2; count <= 6; count++) {
      for (let from = 0; from < count; from++) {
        for (let over = 0; over < count; over++) {
          for (const above of [true, false]) {
            out.push({ from, over, above, count, t: levelDropTarget(from, over, above, count) });
          }
        }
      }
    }
    return out;
  };

  it("P12: the dragged row itself promises nothing, from either half", () => {
    expect([levelDropTarget(2, 2, true, 4), levelDropTarget(2, 2, false, 4)]).toEqual([null, null]);
  });

  it("P13: caretAt is always overIndex or overIndex+1, over every input", () => {
    const bad = sweep().filter(
      (s) => s.t !== null && s.t.caretAt !== s.over && s.t.caretAt !== s.over + 1,
    );
    expect(bad).toEqual([]);
  });

  it("P14: no target this function returns is a no-op, over every input", () => {
    expect(sweep().filter((s) => s.t !== null && s.t.landAt === s.from)).toEqual([]);
  });

  it("P15: every returned landAt is a real position in the list", () => {
    expect(
      sweep().filter((s) => s.t !== null && (s.t.landAt < 0 || s.t.landAt >= s.count)),
    ).toEqual([]);
  });

  // --- agreement with the reducer, which is the whole point ----------------
  // ⭐ The expected order is derived from the CARET -- from `caretAt` against
  // the list as DRAWN -- never from `landAt`. Deriving it from `landAt` would
  // be the formula testing itself (verification-standard rule 3).
  const promisedOrder = (from: number, caretAt: number): string =>
    [
      ...NAMES.slice(0, caretAt).filter((_, i) => i !== from),
      NAMES[from],
      ...NAMES.slice(caretAt).filter((_, i) => i + caretAt !== from),
    ].join(",");

  it("P16: the caret's promise is what applyLevelAction delivers, everywhere", () => {
    const disagreements: string[] = [];
    for (let from = 0; from < 4; from++) {
      for (let over = 0; over < 4; over++) {
        for (const above of [true, false]) {
          const t = levelDropTarget(from, over, above, 4);
          if (t === null) continue;
          const got = order(applyLevelAction(ROWS, { kind: "moveTo", from, to: t.landAt }));
          const want = promisedOrder(from, t.caretAt);
          if (got !== want) disagreements.push(`${from}/${over}/${above}: ${got} != ${want}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("P17: every returned target actually changes the order", () => {
    const inert: string[] = [];
    for (let from = 0; from < 4; from++) {
      for (let over = 0; over < 4; over++) {
        for (const above of [true, false]) {
          const t = levelDropTarget(from, over, above, 4);
          if (t === null) continue;
          if (order(applyLevelAction(ROWS, { kind: "moveTo", from, to: t.landAt })) === NAMES.join(","))
            inert.push(`${from}/${over}/${above}`);
        }
      }
    }
    expect(inert).toEqual([]);
  });

  it("P18: dragging the top row to the bottom row's lower half puts it last", () => {
    const t = levelDropTarget(0, 3, false, 4);
    expect(order(applyLevelAction(ROWS, { kind: "moveTo", from: 0, to: t?.landAt ?? -1 }))).toBe(
      "Department,Line,Work Cell,Site",
    );
  });

  // --- malformed arguments (verification-standard rule 4) ------------------
  it("P19: an out-of-range overIndex promises nothing", () => {
    expect([levelDropTarget(0, 4, true, 4), levelDropTarget(0, -1, true, 4)]).toEqual([null, null]);
  });

  it("P20: an out-of-range from promises nothing", () => {
    expect([levelDropTarget(4, 1, true, 4), levelDropTarget(-1, 1, true, 4)]).toEqual([null, null]);
  });

  it("P21: a non-integer argument promises nothing", () => {
    expect([
      levelDropTarget(1.5, 2, true, 4),
      levelDropTarget(1, 2.5, true, 4),
      levelDropTarget(1, 2, true, 4.5),
    ]).toEqual([null, null, null]);
  });

  it("P22: NaN and Infinity promise nothing", () => {
    expect([
      levelDropTarget(NaN, 1, true, 4),
      levelDropTarget(1, NaN, true, 4),
      levelDropTarget(1, 2, true, NaN),
      levelDropTarget(Infinity, 1, true, 4),
    ]).toEqual([null, null, null, null]);
  });

  it("P23: a one-row list has nowhere to go", () => {
    expect([levelDropTarget(0, 0, true, 1), levelDropTarget(0, 0, false, 1)]).toEqual([null, null]);
  });

  it("P24: a two-row list can still swap, both ways", () => {
    expect([levelDropTarget(0, 1, true, 2)?.landAt, levelDropTarget(1, 0, false, 2)?.landAt]).toEqual(
      [1, 0],
    );
  });

  // ⭐ P25 pins why mutation W5 is INERT. The splice shift is `from < caretAt`;
  // `from <= caretAt` is a different expression with identical output, and no
  // case can tell them apart -- because a returned `caretAt` is NEVER `from`.
  // That is not luck, it is `isNoop`. Deleting the collapse turns W5 live and
  // this case red in the same run, instead of quietly reopening the boundary.
  it("P25: a returned caretAt is never a seam the dragged row already sits on", () => {
    expect(
      sweep().filter((s) => s.t !== null && (s.t.caretAt === s.from || s.t.caretAt === s.from + 1)),
    ).toEqual([]);
  });
});
