/**
 * Pin for DEF-0002 — the board's create popover offers products made only in
 * OTHER plants, and the server refuses every one of them.
 *
 * R-272: "The create popover offers only products that belong at the cell."
 *
 * WHY THIS IS THE FIXTURE. `BoardPage.offeredProducts` calls
 * `productsOfferedHere(active, path, index.nodeById)`, and `index.nodeById`
 * holds ONLY the selected root's subtree — `board_window` scopes it, and
 * `operatorPool` twenty lines below says so in as many words. So a part whose
 * place is a node in ANOTHER plant is never resolvable in that map, and
 * `productOfferedAt`'s per-place fail-open ("cannot tell -> offer it") turns
 * "belongs to a different plant" into "offer it". That is the same mistake
 * `ownedInScope` was written to fix for operators (R-310, session 32); the
 * product half was not changed with it.
 *
 * The map below therefore contains PLANT A ONLY, exactly as the board's does
 * while Plant A is selected. Both kinds of part are present so the case can
 * tell "reads the place" from "offers everything": PN-1001 is made at Plant A
 * and must be offered, PN-2001 is made at Plant B and must not be.
 */
import { describe, it, expect } from "vitest";
import { productsOfferedHere, scopeIndex, type ScopeNode } from "@/features/admin/lib/scope";

/** Plant A's subtree — all `board_window` returns while Plant A is selected. */
const PLANT_A_NODES: ScopeNode[] = [
  { id: "n-plant-a", name: "Plant A", parentId: null, path: "plant_a" },
  { id: "n-area-1", name: "Area 1", parentId: "n-plant-a", path: "plant_a.area_1" },
  { id: "n-line-1", name: "Line 1", parentId: "n-area-1", path: "plant_a.area_1.line_1" },
  { id: "n-cell-1", name: "Cell 1", parentId: "n-line-1", path: "plant_a.area_1.line_1.cell_1" },
];

const CELL_1_PATH = "plant_a.area_1.line_1.cell_1";

interface TestProduct {
  id: string;
  sku: string;
  siteNodeIds: readonly string[];
}

/** `n-plant-b` is a real node in the org; it is simply not in the board's map. */
const PRODUCTS: TestProduct[] = [
  { id: "p-1001", sku: "PN-1001", siteNodeIds: ["n-plant-a"] },
  { id: "p-2001", sku: "PN-2001", siteNodeIds: ["n-plant-b"] },
];

describe("DEF-0002: the board's product picker is scoped to the plant it is showing", () => {
  it("offers a part made at this plant", () => {
    const offered = productsOfferedHere(PRODUCTS, CELL_1_PATH, scopeIndex(PLANT_A_NODES));
    expect(offered.map((p) => p.sku)).toContain("PN-1001");
  });

  it("does NOT offer a part made only at another plant", () => {
    // Reproduced in the browser as the company admin on Plant A / Cell 1: the
    // picker listed Housing B, Bracket B, Line 1 Subassembly B, Area 2 Frame B,
    // Housing C, Bracket C, Line 1 Subassembly C and Area 2 Frame C. Choosing
    // one and pressing Create returned
    //   HTTP 409 PT409 not_offered_here
    //   "That product does not belong to this part of the structure."
    // so every one of those entries is a guaranteed refusal.
    const offered = productsOfferedHere(PRODUCTS, CELL_1_PATH, scopeIndex(PLANT_A_NODES));
    expect(offered.map((p) => p.sku)).not.toContain("PN-2001");
  });
});
