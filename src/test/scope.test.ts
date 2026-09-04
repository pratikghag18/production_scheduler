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
  productOfferedAt,
  productsOfferedHere,
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

describe("scope: a product is offered from a LIST of places (D115)", () => {
  it("XP1: offered where ANY of its places covers the cell", () => {
    // Made on Line 1 and in Plant 2. Offered at a Line 1 cell (Line 1 covers it)
    // and at Plant 2 (Plant 2 covers itself), and NOT at the Line 10 cell, which
    // neither place covers. This is the union — the whole point of D115.
    const places = [LINE1.id, PLANT2.id];
    expect(productOfferedAt(places, CELL1.path, BY_ID)).toBe(true);
    expect(productOfferedAt(places, PLANT2.path, BY_ID)).toBe(true);
    expect(productOfferedAt(places, CELL10.path, BY_ID)).toBe(false);
  });

  it("XP2: ⭐ an EMPTY list is offered NOWHERE — the honest zero", () => {
    // A part assigned to no plant is a legitimate state and must be offered at no
    // cell. `some` over `[]` is false, which is exactly right. (This used to be
    // written as the contrast with an unreadable place, which "failed open"; that
    // half is gone — see XP4 — and emptiness is simply still known, not unknown.)
    expect(productOfferedAt([], CELL1.path, BY_ID)).toBe(false);
    expect(productOfferedAt([], PLANT.path, BY_ID)).toBe(false);
  });

  it("XP3: one covering place is enough even among several that do not", () => {
    // Line 10 and Cell 1 and Plant 1: at the Line 1 cell only Plant 1 covers, and
    // that is sufficient. A predicate needing ALL places to cover fails here.
    expect(productOfferedAt([LINE10.id, PLANT.id], CELL1.path, BY_ID)).toBe(true);
  });

  it("XP4: ⚠ (inverted by DEF-0002) a place NOT IN THE MAP is NOT offered — it fails CLOSED", () => {
    // ⭐ THIS CASE USED TO ASSERT THE OPPOSITE, AND IT WAS PINNING THE BUG. It
    // read `productOfferedAt(["n-hidden"], CELL1.path, BY_ID)).toBe(true)` on
    // `offeredAt`'s reasoning: an unresolvable owner means "I cannot tell", so
    // offer it and let the server refuse. That reasoning is about a map narrowed
    // by PERMISSION. The only caller of this function is the board's create
    // popover, whose map is `board_window`'s nodes — the plant the reader PICKED
    // — so "not in the map" there means "made in another plant", which is an
    // answer and not an absence of one. The contract changed; the old case was
    // not describing a behaviour anyone wanted, it was describing the defect.
    expect(productOfferedAt(["n-hidden"], CELL1.path, BY_ID)).toBe(false);
    // A resolvable place that does not cover is unchanged: still not offered.
    expect(productOfferedAt([PLANT2.id], CELL1.path, BY_ID)).toBe(false);
    // And one unresolvable place does not spoil a good one beside it.
    expect(productOfferedAt(["n-hidden", LINE1.id], CELL1.path, BY_ID)).toBe(true);
  });

  it("XP5: productsOfferedHere filters the catalogue and preserves order", () => {
    const items = [
      { sku: "A", siteNodeIds: [LINE1.id] }, // covers CELL1
      { sku: "B", siteNodeIds: [PLANT2.id] }, // does not
      { sku: "C", siteNodeIds: [PLANT.id, LINE10.id] }, // covers via Plant 1
      { sku: "D", siteNodeIds: [] }, // offered nowhere
    ];
    expect(productsOfferedHere(items, CELL1.path, BY_ID).map((i) => i.sku)).toEqual(["A", "C"]);
  });
});

/**
 * DEF-0002 — the board's picker asks this question against ONE PLANT'S MAP.
 *
 * ⭐⭐ THE MAP BELOW IS THE POINT OF THIS WHOLE BLOCK. Everything above uses
 * `BY_ID`, which holds the entire org including Plant 2 — the shape an ADMIN
 * screen has. The board does not: `board_window` returns `nodes` scoped to the
 * selected root, so while Plant 1 is picked the map holds Plant 1's subtree and
 * nothing else. Asked against that map, "I could not resolve this place" does
 * not mean "I cannot tell", it means "another plant" — and the version that
 * offered it anyway put eight parts belonging to Plant B and Plant C into Plant
 * A's Product dropdown, each of which the database refused with
 * `not_offered_here` the moment Create was pressed.
 *
 * The assertions are written as what a person sees in that dropdown, because
 * that is where the defect was reported from.
 */
describe("scope: the board's product picker is scoped to the plant on screen (DEF-0002)", () => {
  /** Exactly what `board_window` returns while Plant 1 is the selected root. */
  const PLANT1_BOARD = scopeIndex([PLANT, ASSY, LINE1, LINE10, CELL1, CELL10]);

  const CATALOGUE = [
    { sku: "Housing A", siteNodeIds: [PLANT.id] },
    { sku: "Line 1 Sub A", siteNodeIds: [LINE1.id] },
    { sku: "Line 10 Frame A", siteNodeIds: [LINE10.id] },
    { sku: "Housing B", siteNodeIds: [PLANT2.id] },
    { sku: "Common Fastener", siteNodeIds: [PLANT.id, PLANT2.id] },
  ];

  const dropdownAtCell1 = () =>
    productsOfferedHere(CATALOGUE, CELL1.path, PLANT1_BOARD).map((i) => i.sku);

  it("XP6 ⭐ a part made only at ANOTHER plant is not in the dropdown", () => {
    // The filed reproduction: on Plant A's board, Cell 1, the picker listed
    // Housing B among twelve entries and Create returned HTTP 409
    // `not_offered_here`. Plant 2's node is not in this map at all, which is the
    // whole reason the old code offered it.
    expect(dropdownAtCell1()).not.toContain("Housing B");
  });

  it("XP7 ⭐ a part made at THIS plant is still in the dropdown — the fix cuts, it does not empty", () => {
    // Both the plant-root part and the line part must survive, or the fix has
    // traded a picker full of refusals for a picker with nothing in it. A part
    // made in several plants, one of which is this one, stays too: the union
    // still holds, and Common Fastener is the part the tester saw correctly
    // listed on every plant's board.
    expect(dropdownAtCell1()).toContain("Housing A");
    expect(dropdownAtCell1()).toContain("Line 1 Sub A");
    expect(dropdownAtCell1()).toContain("Common Fastener");
  });

  it("XP8 ⚠ a part made at this plant but on ANOTHER line is still correctly absent", () => {
    // ⭐ THE HALF THAT MEMBERSHIP ALONE WOULD GET WRONG. Line 10 IS in this
    // board's map, so a test that only asked "is the place one of my nodes?"
    // would offer Line 10's part at a Line 1 cell. The tester recorded that this
    // half was already right — "Area 2 Frame A" was correctly absent from Plant
    // A's list — and it must stay right: the predicate is membership AND the
    // path compare, never one of them.
    expect(dropdownAtCell1()).not.toContain("Line 10 Frame A");
    // Said the other way round, so the case cannot pass on an empty dropdown:
    expect(dropdownAtCell1()).toEqual(["Housing A", "Line 1 Sub A", "Common Fastener"]);
  });

  it("XP9 ⚠ a board rooted BELOW a plant still offers its own parts — nothing legitimately offerable disappears", () => {
    // ⭐ THE QUESTION TO ANSWER BEFORE TURNING A FAIL-OPEN INTO A FAIL-CLOSED:
    // is there a part the server WOULD accept that now vanishes? A supervisor's
    // board opens on their department, not a plant (`visible_board_roots` is
    // "every node you can read whose parent you cannot"), so their map is the
    // department's subtree and the plant ABOVE it is missing — missing for a
    // PERMISSION reason, the one case the file header's fail-open was written
    // for. It still cannot bite here: the place rows above a reader's grant are
    // dropped by `product_sites_select` (`app_can_read_node`, downward only)
    // before they reach this client, so such a part arrives with an EMPTY places
    // list and was already offered nowhere (XP2) — this change does not move it.
    // What must keep working is the department's own parts, and they do.
    const ASSY_BOARD = scopeIndex([ASSY, LINE1, LINE10, CELL1, CELL10]);
    const offered = productsOfferedHere(CATALOGUE, CELL1.path, ASSY_BOARD).map((i) => i.sku);
    expect(offered).toContain("Line 1 Sub A");
    expect(offered).not.toContain("Housing B");
    // The plant-owned parts are the ones whose place sits above this root. They
    // read as absent HERE because this fixture hands over a place the client
    // could not have read; the app never sees that pair, per the note above.
    expect(offered).not.toContain("Housing A");
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
