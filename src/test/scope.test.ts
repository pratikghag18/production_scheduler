/**
 * Acceptance suite for `src/features/admin/lib/scope.ts` — D103, migration 0025.
 *
 * ⭐⭐ THIS MODULE MIRRORS A SERVER RULE, so half of what matters is that it
 * AGREES with `52_scope_and_colour_test.sql`. Cases X1–X6 are the same
 * arithmetic as SQL case S9, and X9–X11 are SQL case S10/S11 — deliberately, so
 * that a change to one side that the other does not follow makes two files red
 * instead of one screen wrong.
 *
 * ⚠️ THE FIXTURE HAS `line1` AND `line10` IN IT ON PURPOSE. A prefix test
 * written with `startsWith` is correct on every other fixture anyone would
 * think to build, and wrong on exactly this one. Ten lines is not an exotic
 * plant.
 */
import { describe, expect, it } from "vitest";
import {
  indentedLabel,
  isAtOrBelow,
  offeredAt,
  offeredHere,
  ownedInScope,
  productsOfferedAtNode,
  scopeIndex,
  scopeLabel,
  scopeOptions,
  scopePathLabel,
  type ScopeNode,
} from "@/features/admin/lib/scope";

const PLANT: ScopeNode = { id: "n-plant", name: "Plant 1", parentId: null, path: "plant1" };
const ASSY: ScopeNode = {
  id: "n-assy",
  name: "Assembly",
  parentId: "n-plant",
  path: "plant1.assembly",
};
const LINE1: ScopeNode = {
  id: "n-l1",
  name: "Line 1",
  parentId: "n-assy",
  path: "plant1.assembly.line1",
};
/** ⚠️ The trap. `plant1.assembly.line1` is a STRING prefix of this. */
const LINE10: ScopeNode = {
  id: "n-l10",
  name: "Line 10",
  parentId: "n-assy",
  path: "plant1.assembly.line10",
};
const CELL1: ScopeNode = {
  id: "n-c1",
  name: "Cell 1",
  parentId: "n-l1",
  path: "plant1.assembly.line1.cell1",
};
const CELL10: ScopeNode = {
  id: "n-c10",
  name: "Cell 10",
  parentId: "n-l10",
  path: "plant1.assembly.line10.cell10",
};
/** A second site, so "outside the scope" is not the same fixture as "another tenant". */
const PLANT2: ScopeNode = { id: "n-p2", name: "Plant 2", parentId: null, path: "plant2" };

const NODES: readonly ScopeNode[] = [PLANT, ASSY, LINE1, LINE10, CELL1, CELL10, PLANT2];
const BY_ID = scopeIndex(NODES);

describe("scope: is a node at or below another", () => {
  it("X1: a node is at or below ITSELF — the rule is reflexive, as `<@` is", () => {
    // Pinned separately because a strict-descent implementation agrees with
    // this module everywhere except the one node the user actually picked.
    expect(isAtOrBelow(LINE1.path, LINE1.path)).toBe(true);
  });

  it("X2: a cell is below its line", () => {
    expect(isAtOrBelow(CELL1.path, LINE1.path)).toBe(true);
  });

  it("X3: a cell is below its department, two rungs up", () => {
    expect(isAtOrBelow(CELL1.path, ASSY.path)).toBe(true);
  });

  it("X4: a line is NOT below its own child", () => {
    expect(isAtOrBelow(LINE1.path, CELL1.path)).toBe(false);
  });

  it("X5: a sibling line is not below its sibling", () => {
    expect(isAtOrBelow(LINE10.path, LINE1.path)).toBe(false);
  });

  it("X6: `line1` is not an ancestor of `line10` — labels, not characters", () => {
    // The whole reason `isAtOrBelow` exists rather than a bare `startsWith`.
    expect(LINE10.path.startsWith(LINE1.path)).toBe(true);
    expect(isAtOrBelow(LINE10.path, LINE1.path)).toBe(false);
    expect(isAtOrBelow(CELL10.path, LINE1.path)).toBe(false);
  });

  it("X7: and nothing under one site is below another", () => {
    expect(isAtOrBelow(CELL1.path, PLANT2.path)).toBe(false);
  });
});

describe("scope: what is offered where", () => {
  it("X8 ⭐ (rewritten by 0028): a PLANT-scoped thing is offered everywhere inside that plant, and nowhere in the other", () => {
    // This case used to read "a company-wide thing is offered everywhere" and
    // passed `null`. D108 removed the state; the widest scope that still
    // exists is a plant root, and the second expectation is the half the old
    // case could not make — `null` was offered in Plant 2 as well.
    expect(offeredAt(PLANT.id, CELL1.path, BY_ID)).toBe(true);
    expect(offeredAt(PLANT.id, PLANT2.path, BY_ID)).toBe(false);
  });

  it("X9: every covering scope applies — this is a UNION, not nearest-ancestor-wins", () => {
    // ⭐ The same assertion as SQL case S10. A node runs ONE shift pattern and
    // offers MANY products; anyone reusing `resolve_shift_template`'s
    // ORDER BY / LIMIT 1 shape here offers one of these three.
    const items = [
      { siteNodeId: LINE1.id, sku: "SLA" },
      { siteNodeId: ASSY.id, sku: "SDP" },
      { siteNodeId: PLANT.id, sku: "SCW" },
    ];
    expect(offeredHere(items, CELL1.path, BY_ID).map((i) => i.sku)).toEqual(["SLA", "SDP", "SCW"]);
  });

  it("X10: and the cell on the other line gets two of the three", () => {
    // The half X9 cannot see: a predicate that returned `true` for everything
    // passes X9 and fails here.
    const items = [
      { siteNodeId: LINE1.id, sku: "SLA" },
      { siteNodeId: ASSY.id, sku: "SDP" },
      { siteNodeId: PLANT.id, sku: "SCW" },
    ];
    expect(offeredHere(items, CELL10.path, BY_ID).map((i) => i.sku)).toEqual(["SDP", "SCW"]);
  });

  it("X11: a scope this client cannot read FAILS OPEN — offered, not hidden", () => {
    // ⚠️ The direction matters and it is the opposite of `canEditProduct`'s.
    // Hiding is invisible and permanent; offering lands on the write-error
    // contract, which is loud and recoverable.
    expect(offeredAt("n-nobody-can-see-this", CELL1.path, BY_ID)).toBe(true);
  });

  it("X12: offeredHere preserves the order it was given", () => {
    const items = [
      { siteNodeId: ASSY.id, sku: "B" },
      { siteNodeId: PLANT.id, sku: "A" },
    ];
    expect(offeredHere(items, CELL1.path, BY_ID).map((i) => i.sku)).toEqual(["B", "A"]);
  });
});

describe("scope: the board pool is membership in the scoped nodes (ownedInScope)", () => {
  const PEOPLE = [
    { siteNodeId: PLANT.id, name: "B at the plant root" },
    { siteNodeId: LINE1.id, name: "B at a line" },
    { siteNodeId: CELL1.id, name: "B at a cell" },
    { siteNodeId: PLANT2.id, name: "another plant" },
    { siteNodeId: "n-hidden", name: "owner not in this board's nodes" },
  ];
  // board_window's `nodes` are the selected root's subtree — Plant 1 here.
  const plant1Scope = new Set([PLANT.id, ASSY.id, LINE1.id, LINE10.id, CELL1.id, CELL10.id]);

  it("XO1: keeps everyone owned by a scoped node, drops another plant", () => {
    // The reported bug: a system admin on Plant 1 must stop seeing Plant 2's B.
    expect(ownedInScope(PEOPLE, plant1Scope).map((p) => p.name)).toEqual([
      "B at the plant root",
      "B at a line",
      "B at a cell",
    ]);
  });

  it("XO2: ⚠️ an owner NOT in the scoped set is dropped, NOT fail-open — this is the exact bug the path version shipped", () => {
    // The old path-resolve failed open when it could not find the owner node, so
    // every out-of-plant owner (never in the scoped map) was kept. Membership
    // treats "not in scope" as the real answer: not this plant.
    const names = ownedInScope(PEOPLE, plant1Scope).map((p) => p.name);
    expect(names).not.toContain("another plant");
    expect(names).not.toContain("owner not in this board's nodes");
  });

  it("XO3: a narrower scope keeps fewer", () => {
    const line1Scope = new Set([LINE1.id, CELL1.id]);
    expect(ownedInScope(PEOPLE, line1Scope).map((p) => p.name)).toEqual([
      "B at a line",
      "B at a cell",
    ]);
  });

  it("XO4: preserves the order it was given", () => {
    expect(ownedInScope(PEOPLE, plant1Scope).map((p) => p.name)).toEqual([
      "B at the plant root",
      "B at a line",
      "B at a cell",
    ]);
  });
});

/**
 * THE PRODUCT PICKER, AFTER THE DECISION MOVED TO THE SERVER (DEF-0005).
 *
 * ⭐⭐ THIS BLOCK REPLACED TWO OTHERS, AND WHAT IT DROPPED IS THE POINT. It used
 * to test `productOfferedAt(siteNodeIds, targetPath, nodesById)` — the product's
 * places, resolved in the board's node map, compared with `isAtOrBelow`. Nine
 * cases of path logic, all of them asking the right RULE of the wrong MATERIAL:
 * `site_node_ids` is RLS-filtered, so for a supervisor granted a LINE a
 * plant-wide part arrives with NO places, and every one of those cases said
 * "offered nowhere" — correctly, for a list that had been emptied on the way.
 *
 * ⚠️ ONE OF THEM WAS GREEN WHILE ASSERTING THE OPPOSITE OF WHAT THE SERVER SAYS.
 * XP9 was called "a board rooted BELOW a plant still offers its own parts —
 * nothing legitimately offerable disappears" and ended with
 * `expect(offered).not.toContain("Housing A")`, with a comment explaining that
 * such a part "was already offered nowhere ... this change does not move it".
 * True, and beside the point: it was already WRONG, and the case wrote the
 * wrongness down as expected. CLAUDE.md §4's "a green case can be pinning the
 * bug", in its literal form.
 *
 * So the client no longer derives an offer at all. `board_window` sends
 * `offered_node_ids` per product (migration 0042) — the nodes in this window
 * where the server would ACCEPT a run, from the same predicate the write guard
 * runs — and the only client-side question left is membership. These cases are
 * fewer and duller than the ones they replace, which is the right direction: the
 * interesting half is now a SQL test (`supabase/tests/65_offered_in_window_test
 * .sql`), where the authority is.
 */
describe("scope: the picker offers what the server says it may (DEF-0005)", () => {
  /**
   * ⭐ THE FIXTURE IS ANA'S BOARD, off the wire. She is a supervisor granted
   * Line 1: `site_node_ids` comes back EMPTY for the three parts made at the
   * plant above her, because she cannot read that plant, and `offered_node_ids`
   * carries her own two cells and her line for all four — which is what the
   * server answers when asked about her cells directly.
   */
  const CELL_1 = "n-cell-1";
  const CELL_2 = "n-cell-2";
  const OTHER_LINE_CELL = "n-cell-10";

  const ANAS_BOARD = [
    { sku: "Housing A", siteNodeIds: [], offeredNodeIds: [CELL_1, CELL_2] },
    { sku: "Bracket A", siteNodeIds: [], offeredNodeIds: [CELL_1, CELL_2] },
    { sku: "Line 1 Sub A", siteNodeIds: ["n-line-1"], offeredNodeIds: [CELL_1, CELL_2] },
    { sku: "Common Fastener", siteNodeIds: [], offeredNodeIds: [CELL_1, CELL_2] },
  ];

  const skus = (items: readonly { sku: string }[]) => items.map((i) => i.sku);

  it("XP1 ⭐ the filed defect: a part whose places were filtered away is still offered", () => {
    // Ana was offered ONE part of the four on her own legend, and the server
    // accepted all four. Three of them have NO readable places at all — the
    // exact state the old predicate read as "made nowhere".
    expect(skus(productsOfferedAtNode(ANAS_BOARD, CELL_1))).toEqual([
      "Housing A",
      "Bracket A",
      "Line 1 Sub A",
      "Common Fastener",
    ]);
  });

  it("XP2 ⚠ an empty places list is NOT the question any more", () => {
    // Said on its own, because it is the assumption the whole defect rested on:
    // `siteNodeIds: []` no longer decides anything. Only the server's answer does.
    const hidden = [{ sku: "Housing A", siteNodeIds: [], offeredNodeIds: [CELL_1] }];
    expect(skus(productsOfferedAtNode(hidden, CELL_1))).toEqual(["Housing A"]);
  });

  it("XP3 ⭐ an empty OFFERED list is offered nowhere — the honest zero, now an answer", () => {
    // A part assigned to no plant, and `history.ts`'s synthesised deleted
    // product, both arrive this way. Before, an empty list was a filtered list
    // that might mean anything; now it is the server saying "nowhere here".
    const nowhere = [{ sku: "Orphan", siteNodeIds: [], offeredNodeIds: [] }];
    expect(productsOfferedAtNode(nowhere, CELL_1)).toEqual([]);
  });

  it("XP4 ⭐ (promoted from DEF-0002's pin) a part made only at another plant is absent", () => {
    // The first defect this picker produced, kept as a case now that its pin is
    // verified and deleted. On Plant A's board the dropdown listed twelve parts,
    // eight of them made in Plant B and Plant C, and Create returned HTTP 409
    // `not_offered_here` on every one. It cannot recur through this path: a part
    // the server does not offer here carries none of this window's nodes.
    const withStranger = [
      ...ANAS_BOARD,
      { sku: "Housing B", siteNodeIds: ["n-plant-2"], offeredNodeIds: [] },
    ];
    expect(skus(productsOfferedAtNode(withStranger, CELL_1))).not.toContain("Housing B");
  });

  it("XP5 ⚠ a part made at this plant but on ANOTHER line is still absent", () => {
    // The half that was already right and must stay right. Line 10's cell is in
    // this window, so a test that asked "is this part offered ANYWHERE in the
    // window?" would list it at a Line 1 cell. The question is per node.
    const lineTen = [{ sku: "Line 10 Frame", siteNodeIds: [], offeredNodeIds: [OTHER_LINE_CELL] }];
    expect(productsOfferedAtNode(lineTen, CELL_1)).toEqual([]);
    expect(skus(productsOfferedAtNode(lineTen, OTHER_LINE_CELL))).toEqual(["Line 10 Frame"]);
  });

  it("XP6: the answer is per node, not per board", () => {
    const oneCellOnly = [{ sku: "Cell 2 only", siteNodeIds: [], offeredNodeIds: [CELL_2] }];
    expect(productsOfferedAtNode(oneCellOnly, CELL_1)).toEqual([]);
    expect(skus(productsOfferedAtNode(oneCellOnly, CELL_2))).toEqual(["Cell 2 only"]);
  });

  it("XP7: order is preserved, because the picker shows it in the order it was given", () => {
    expect(skus(productsOfferedAtNode(ANAS_BOARD, CELL_2))).toEqual([
      "Housing A",
      "Bracket A",
      "Line 1 Sub A",
      "Common Fastener",
    ]);
  });
});

describe("scope: the picker", () => {
  it("X13 ⭐ (inverted by 0028): there is NO company-wide option — the list is exactly the nodes", () => {
    // It used to assert the opposite: a `null`-valued entry first, and
    // `NODES.length + 1` options. D108 removed the entry, and the length is
    // asserted alongside so "no null in the list" cannot pass on an empty one.
    const opts = scopeOptions(NODES);
    expect(opts.length).toBe(NODES.length);
    expect(opts.some((o) => (o.value as unknown) === null)).toBe(false);
  });

  it("X14: nodes come back in TREE order — a parent immediately before its children", () => {
    // Sorting by path IS tree order. Asserted as a literal list rather than by
    // re-deriving it from `path`, which would be deriving the expected value
    // from the thing under test.
    // ⭐ 0028: the first entry used to be "Everywhere (company-wide)". D108
    // deleted it; the tree order this case exists to pin is unchanged.
    expect(scopeOptions(NODES).map((o) => o.name)).toEqual([
      "Plant 1",
      "Assembly",
      "Line 1",
      "Cell 1",
      "Line 10",
      "Cell 10",
      "Plant 2",
    ]);
  });

  it("X15: depth comes from the path, so the indent is right without a tree walk", () => {
    const byName = new Map(scopeOptions(NODES).map((o) => [o.name, o.depth]));
    expect([byName.get("Plant 1"), byName.get("Assembly"), byName.get("Cell 1")]).toEqual([
      0, 1, 3,
    ]);
  });

  it("X16 ⭐: every node handed in is offered — narrowing is the CALLER's job, not this one's", () => {
    // ⚠⚠ THIS CASE USED TO ASSERT THE OPPOSITE, and it went with the parameter.
    // `scopeOptions(nodes, canEdit?)` took a permission set and dropped
    // everything outside it. That parameter was DEAD — no caller ever passed it
    // — and its doc comment argued for a narrowing that had already been tried
    // and reverted: `ProductsPanel` measured that `adminSiteIds` is derived from
    // STRUCTURE ownership and is not the question the insert policy asks, so a
    // site admin whose root had no claimed structure was offered nothing at all.
    //
    // ⚠️ There is no honest set to pass today: the server exposes
    // `editable_shape_ids()` (structures) and `app_is_admin_anywhere()` (a
    // boolean), and nothing that returns the NODES a caller may administer.
    // So this offers what it is given and the write error is the answer
    // (§19.63's contract exists for exactly that).
    //
    // ⭐ The plant filter narrows the ARRAY before it arrives, which is a view
    // choice the reader made and can undo — a different kind of thing entirely,
    // and the distinction §19.77 is about.
    // Membership, not order — the list is sorted by PATH (tree order), which is
    // X14's job to pin, not this one's.
    expect(
      scopeOptions(NODES)
        .map((o) => o.value)
        .sort(),
    ).toEqual(NODES.map((n) => n.id).sort());
  });

  it("X17: a node whose parent is unreadable is still offered, at its own depth", () => {
    // ⚠️ A department admin who cannot read the plant above them must still be
    // able to scope things to their own department. A recursive walk would drop
    // this node entirely.
    const opts = scopeOptions([LINE1, CELL1]);
    expect(opts.map((o) => [o.name, o.depth])).toEqual([
      ["Line 1", 2],
      ["Cell 1", 3],
    ]);
  });

  it("X18: the indent is drawn with a character <option> will not collapse", () => {
    const line1 = scopeOptions(NODES).find((o) => o.name === "Line 1");
    expect(indentedLabel(line1!)).toBe("    Line 1");
  });

  it("X19 ⭐ (rewritten by 0028): a root is never indented", () => {
    // Was "company-wide is never indented", on the entry D108 deleted. A depth
    // of 0 is now only ever a root, and the assertion is the same shape.
    expect(indentedLabel({ value: PLANT.id, name: "Plant 1", depth: 0 })).toBe("Plant 1");
  });
});

describe("scope: what a row says about where it belongs", () => {
  it('X20 ⭐ (rewritten by 0028): a scope this client cannot read says so — and never says "Company-wide"', () => {
    // `scopeLabel(null, ...)` returned "Company-wide" until D108 removed the
    // state. The remaining answer is the one that mattered: an unreadable
    // owner must read as somewhere else, never as everyone's.
    expect(scopeLabel("n-nobody-can-see-this", BY_ID)).toBe("Somewhere else");
  });

  it("X21: a readable scope reads as its node's name", () => {
    expect(scopeLabel(LINE1.id, BY_ID)).toBe("Line 1");
  });

  it("X22: an UNREADABLE scope reads as 'Somewhere else', never as company-wide", () => {
    // ⚠️ The two answers a reader must never confuse: one means everyone can
    // use it, the other means this person cannot see where it lives.
    expect(scopeLabel("n-hidden", BY_ID)).toBe("Somewhere else");
  });

  it("X23: the full path names every rung, top down", () => {
    expect(scopePathLabel(CELL1.id, BY_ID)).toBe("Plant 1 › Assembly › Line 1 › Cell 1");
  });

  it("X24: a chain that runs out marks itself truncated rather than lying", () => {
    const partial = scopeIndex([LINE1, CELL1]);
    expect(scopePathLabel(CELL1.id, partial)).toBe("… › Line 1 › Cell 1");
  });

  it("X25: a chain that LOOPS is truncated, not hung", () => {
    // The guard `operators.ts` needed for the same reason. A malformed tree
    // must not spin.
    const a: ScopeNode = { id: "a", name: "A", parentId: "b", path: "a" };
    const b: ScopeNode = { id: "b", name: "B", parentId: "a", path: "b" };
    expect(scopePathLabel("a", scopeIndex([a, b])).startsWith("… › ")).toBe(true);
  });

  it("X26: an unreadable scope has no path to show", () => {
    expect(scopePathLabel("n-hidden", BY_ID)).toBe("Somewhere else");
  });
});
