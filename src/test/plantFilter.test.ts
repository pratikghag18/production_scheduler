/**
 * Acceptance suite for `src/features/admin/lib/plantFilter.ts` — the one
 * "which plant am I looking at" rule the whole admin screen reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS DEFENDING. Unlike `operators.test.ts`, none of this
 * mirrors a server rule: the database has no notion of "the same plant" at
 * all. **So the invariant is not "never show what the server refuses" — it is
 * "never HIDE something without the reader being able to tell".** Every case
 * below that matters is a way the screen could quietly show less than it has:
 * a stored choice that no longer resolves, a row whose owner cannot be read, a
 * control that vanished while its filter stayed applied.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE — three plants, shaped like `dev_demo.sql`'s, drawn once:
 *
 *   Plant A   a                     root
 *   ├─ Area 1   a.ar1
 *   │   ├─ Line 1    a.ar1.l1
 *   │   └─ Line 10   a.ar1.l10       ⭐ the label-boundary trap, deliberately
 *   └─ Area 2   a.ar2
 *   Plant B   b                     root
 *   └─ Line 1   b.l1
 *   Plant C   c                     root
 *   Orphan Line   zz.l9             parent NOT in the array
 *
 * ⭐ "Line 10" exists so a `startsWith` implementation fails PF9 rather than
 * passing everything. `plant1.line1` is a prefix of the STRING `plant1.line10`
 * and is not an ancestor of that NODE; six lines is enough for it to bite, and
 * the failure is silent.
 *
 * ⭐ The ORPHAN is the other half of rule 3g here: a fixture whose only
 * parentless nodes are genuine roots cannot tell "reads `parentId`" from
 * "reads whatever is topmost".
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  loadPlantChoice,
  nodesInPlant,
  plantChipLabel,
  plantControlVisible,
  readablePlants,
  resolvePlantChoice,
  rowsInPlant,
  savePlantChoice,
  type PlantOption,
} from "../features/admin/lib/plantFilter.ts";
import { scopeIndex, type ScopeNode } from "../features/admin/lib/scope.ts";

const A = "20000000-0000-0000-0000-00000000000a";
const A_AR1 = "20000000-0000-0000-0000-00000000000b";
const A_L1 = "20000000-0000-0000-0000-00000000000c";
const A_L10 = "20000000-0000-0000-0000-00000000000d";
const A_AR2 = "20000000-0000-0000-0000-00000000000e";
const B = "20000000-0000-0000-0000-0000000000b0";
const B_L1 = "20000000-0000-0000-0000-0000000000b1";
const C = "20000000-0000-0000-0000-0000000000c0";
const ORPHAN = "20000000-0000-0000-0000-0000000000f0";
const NOWHERE = "20000000-0000-0000-0000-0000000000ff";

const NODES: readonly ScopeNode[] = [
  { id: A, name: "Plant A", parentId: null, path: "a" },
  { id: A_AR1, name: "Area 1", parentId: A, path: "a.ar1" },
  { id: A_L1, name: "Line 1", parentId: A_AR1, path: "a.ar1.l1" },
  { id: A_L10, name: "Line 10", parentId: A_AR1, path: "a.ar1.l10" },
  { id: A_AR2, name: "Area 2", parentId: A, path: "a.ar2" },
  { id: B, name: "Plant B", parentId: null, path: "b" },
  { id: B_L1, name: "Line 1", parentId: B, path: "b.l1" },
  { id: C, name: "Plant C", parentId: null, path: "c" },
  // A node whose parent this reader cannot see. It is topmost in the array and
  // is NOT a root — `parentId` is the column, not a guess.
  { id: ORPHAN, name: "Orphan Line", parentId: NOWHERE, path: "zz.l9" },
];

const BY_ID = scopeIndex(NODES);
const PLANTS = readablePlants(NODES);
const ONE_PLANT: readonly PlantOption[] = [{ id: A, name: "Plant A", path: "a" }];

interface Row {
  id: string;
  siteNodeId: string;
}
const ROWS: readonly Row[] = [
  { id: "r-a-plant", siteNodeId: A },
  { id: "r-a-line1", siteNodeId: A_L1 },
  { id: "r-a-line10", siteNodeId: A_L10 },
  { id: "r-b-plant", siteNodeId: B },
  { id: "r-b-line1", siteNodeId: B_L1 },
  { id: "r-unreadable", siteNodeId: NOWHERE },
];

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

/* ===========================================================================
 * readablePlants — what the control offers.
 * =========================================================================== */

it("PF1: the plants are the nodes with no parent, and nothing else", () => {
  expect(ids(PLANTS)).toEqual([A, B, C]);
});

it("PF2 ⭐: a node whose PARENT is unreadable is not promoted to a plant", () => {
  // The orphan is topmost in what this reader can see. `parentId` is not null,
  // so it is not a root — putting "Orphan Line" in a list of plant names is
  // exactly the confusion this case exists to prevent.
  expect(ids(PLANTS)).not.toContain(ORPHAN);
});

it("PF3: they come back in tree order, the same order every other list uses", () => {
  const paths = PLANTS.map((p) => p.path);
  expect(paths).toEqual([...paths].sort());
});

it("PF4: an empty tree offers nothing rather than throwing", () => {
  expect(readablePlants([])).toEqual([]);
});

/* ===========================================================================
 * plantControlVisible — decision 2.
 * =========================================================================== */

it("PF5 ⭐: one readable plant means NO control — there is nothing to choose", () => {
  expect(plantControlVisible(ONE_PLANT)).toBe(false);
  expect(plantControlVisible([])).toBe(false);
});

it("PF6: two or more means the control appears", () => {
  expect(plantControlVisible(PLANTS)).toBe(true);
});

/* ===========================================================================
 * resolvePlantChoice — the remembered choice, met with today's grants.
 * =========================================================================== */

it("PF7: a readable stored choice is kept", () => {
  expect(resolvePlantChoice(B, PLANTS)).toBe(B);
});

it("PF8 ⭐⭐: a stored choice that is no longer readable falls back to ALL PLANTS", () => {
  // A grant revoked or a plant deleted between two visits. Keeping the dead id
  // would filter every section down to nothing and look like an emptied org;
  // widening is at worst noisy, and the reader can see what they have.
  expect(resolvePlantChoice(NOWHERE, PLANTS)).toBe(null);
});

it("PF9: 'All plants' resolves to itself — it is a real answer, not an absent one", () => {
  expect(resolvePlantChoice(null, PLANTS)).toBe(null);
});

it("PF10 ⭐: a reader down to one plant is not left filtered by an invisible control", () => {
  // Decision 2 hides the row at one root. If the stored choice survived, the
  // screen would stay filtered with nothing on it able to say so.
  expect(resolvePlantChoice(A, ONE_PLANT)).toBe(null);
});

/* ===========================================================================
 * plantChipLabel — decision 1's other half, and not optional.
 * =========================================================================== */

it("PF11: the chip names the chosen plant", () => {
  expect(plantChipLabel(B, PLANTS)).toBe("Plant B");
});

it("PF12 ⭐: and it spells out 'All plants' rather than going blank", () => {
  // A blank chip is a filter with no visible state, which is the whole failure
  // remembering the choice would otherwise introduce.
  expect(plantChipLabel(null, PLANTS)).toBe("All plants");
});

it("PF13: an unresolvable choice reads as All plants, matching what is shown", () => {
  expect(plantChipLabel(NOWHERE, PLANTS)).toBe("All plants");
});

/* ===========================================================================
 * nodesInPlant — the tree half.
 * =========================================================================== */

it("PF14: All plants keeps everything, including the unreachable orphan", () => {
  expect(nodesInPlant(NODES, null, PLANTS)).toHaveLength(NODES.length);
});

it("PF15: choosing a plant keeps its subtree AND the plant itself (`<@` is reflexive)", () => {
  const kept = ids(nodesInPlant(NODES, A, PLANTS));
  expect(kept).toEqual([A, A_AR1, A_L1, A_L10, A_AR2]);
});

it("PF16 ⭐: the prefix test is on LABELS — 'a.ar1.l1' does not swallow 'a.ar1.l10'", () => {
  // The node is Line 1; Line 10 is its sibling, not its descendant. A
  // `startsWith` implementation keeps both and nothing on screen looks wrong.
  const kept = ids(nodesInPlant(NODES, A_L1, [{ id: A_L1, name: "Line 1", path: "a.ar1.l1" }]));
  expect(kept).toEqual([A_L1]);
});

it("PF17: a choice naming a plant that is not in the list keeps everything", () => {
  expect(nodesInPlant(NODES, NOWHERE, PLANTS)).toHaveLength(NODES.length);
});

it("PF18: the orphan is dropped by a real choice — its path is under no plant", () => {
  expect(ids(nodesInPlant(NODES, A, PLANTS))).not.toContain(ORPHAN);
});

/* ===========================================================================
 * rowsInPlant — the owned-rows half.
 * =========================================================================== */

it("PF19: All plants keeps every row", () => {
  expect(rowsInPlant(ROWS, null, PLANTS, BY_ID)).toHaveLength(ROWS.length);
});

it("PF20: a row owned anywhere under the chosen plant is kept, at any depth", () => {
  const kept = ids(rowsInPlant(ROWS, A, PLANTS, BY_ID));
  expect(kept).toContain("r-a-plant");
  expect(kept).toContain("r-a-line1");
  expect(kept).toContain("r-a-line10");
});

it("PF21: and a row owned by another plant is not", () => {
  const kept = ids(rowsInPlant(ROWS, A, PLANTS, BY_ID));
  expect(kept).not.toContain("r-b-plant");
  expect(kept).not.toContain("r-b-line1");
});

it("PF22 ⭐: a row whose OWNER cannot be read is KEPT — 'cannot tell' is not 'hide'", () => {
  // `offeredAt` fails open for the same reason (scope.ts's header): hiding is
  // invisible and permanent, and offering is loud and recoverable.
  expect(ids(rowsInPlant(ROWS, A, PLANTS, BY_ID))).toContain("r-unreadable");
});

it("PF23: order is preserved — filtering must not reshuffle a sorted list", () => {
  const kept = ids(rowsInPlant(ROWS, A, PLANTS, BY_ID));
  expect(kept).toEqual(ids(ROWS).filter((id) => kept.includes(id)));
});

/* ===========================================================================
 * Remembering the choice.
 * =========================================================================== */

const ORG = "10000000-0000-0000-0000-000000000001";
const ORG_2 = "10000000-0000-0000-0000-000000000002";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("PF24: a saved choice comes back", () => {
  savePlantChoice(ORG, B);
  expect(loadPlantChoice(ORG)).toBe(B);
});

it("PF25 ⭐: 'All plants' REMOVES the key rather than storing a sentinel", () => {
  // Two representations of "everything" would be two things to keep in step.
  savePlantChoice(ORG, B);
  savePlantChoice(ORG, null);
  expect(loadPlantChoice(ORG)).toBe(null);
  expect(window.localStorage.length).toBe(0);
});

it("PF26 ⭐: the key is scoped per ORG — `user_profiles` is unique on (org_id, user_id)", () => {
  // One person can be in two orgs, and a node id from one is meaningless in
  // the other. Without the org in the key this leaks across them.
  savePlantChoice(ORG, B);
  expect(loadPlantChoice(ORG_2)).toBe(null);
});

it("PF27: no org yet (the profile has not loaded) reads and writes nothing", () => {
  savePlantChoice(null, B);
  expect(loadPlantChoice(null)).toBe(null);
  expect(window.localStorage.length).toBe(0);
});

it("PF28 ⭐⭐: a localStorage that THROWS degrades the feature, it does not take the screen down", () => {
  // Reading localStorage throws — not returns null — in a browser set to block
  // site data. An unguarded read takes the whole admin screen down for a reader
  // whose only crime is a privacy setting.
  vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
    throw new Error("SecurityError: access is denied for this document");
  });
  vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
    throw new Error("SecurityError: access is denied for this document");
  });
  expect(loadPlantChoice(ORG)).toBe(null);
  expect(() => savePlantChoice(ORG, B)).not.toThrow();
});
