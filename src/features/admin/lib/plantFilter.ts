/**
 * plantFilter.ts — "which plant am I looking at", for the whole admin screen.
 *
 * ---------------------------------------------------------------------------
 * THE MAINTAINER, 31 August, immediately after §19.77 landed:
 *
 *     "for the system admin, may be we need a filter for plants in all the
 *      sub tabs."
 *
 * A system admin can read every node in the org, so every admin section shows
 * three plants' worth of everything: eighteen people, twelve products, three
 * trees. A plant-scoped admin sees exactly one and needs no control at all.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THIS IS THE GENERAL CASE OF §19.77, AND IT IS A DIFFERENT KIND OF RULE.
 *
 * §19.77's `placesUnderSameRoot` derives its cut from the ROW being looked at
 * — this person's own root, no user input and no state. **This one is a CHOICE
 * the reader makes**, and it has to survive switching sections, or the Operators
 * tab and the Products tab disagree about what the reader is looking at.
 *
 * ⚠️ So the state lives ONCE, on `AdminPage`, and every section reads it. Six
 * per-panel filters would be six controls that drift apart, and a reader who
 * set one would have no way to know the other five were still wide open.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE THREE DECISIONS, ASKED ONE AT A TIME AND ANSWERED (31 August):
 *
 *  1. **The default is THEIR LAST CHOICE**, remembered across visits — not
 *     "All plants". ⚠️⚠️ **What makes that safe is `plantChipLabel`**: the
 *     chosen plant is spelled out in the header on every tab, always. A
 *     remembered filter with no visible chip is `scope.ts`'s silent-hiding
 *     failure with a preference attached — a list that quietly shrank looks
 *     exactly like a list of things nobody created. **The persistence and the
 *     chip are ONE decision. Neither ships without the other.**
 *  2. **One readable root means NO CONTROL AND NO HEADER ROW AT ALL.** Not a
 *     disabled dropdown: a greyed control reads as "you lack permission"
 *     rather than "there is only one", which is D106's shape. ⚠️ The test is
 *     `readablePlants(...).length`, **never the role** — a company admin of a
 *     one-plant org correctly gets no control either.
 *  3. **The filter narrows the FORMS too**, not only the lists. What you see is
 *     what you can create in. The alternative lets somebody create a row into a
 *     plant they have filtered away and then watch it not appear, which is
 *     silent hiding in a new costume.
 *
 * ⚠️⚠️ AND THE PICKERS THEREFORE TAKE TWO NARROWINGS OF DIFFERENT KINDS.
 * The filter is a VIEW CHOICE and reversible; `scopeOptions`' `canEdit` is a
 * PERMISSION and is not. **Neither may be implemented in terms of the other.**
 * Collapsing them would make a reversible preference look like a permission,
 * and the day somebody widens the filter they would silently widen what the
 * form claims they may write. That is §19.77's own lesson — the reason
 * `placesUnderSameRoot` sits outside `workPlacesFor` — arriving one screen up.
 *
 * ---------------------------------------------------------------------------
 * ⭐ EVERYTHING HERE COMPARES `path`, NOT `parentId`, AND THAT IS DELIBERATE.
 * `nodes.path` is the ltree the server itself compares, and `isAtOrBelow`
 * already implements `<@` label by label (a prefix test cannot loop, and
 * `plant1.line1` is not an ancestor of `plant1.line10`). `operators.ts` walks
 * `parentId` because it is a dependency-free module that is never handed a
 * path; **this file must not become a second implementation of ancestry that
 * can disagree with the first.** Every admin read selects `path` — verified in
 * `src/lib/api/operators.ts:223` and `parseBoardNode` in `hierarchy.ts` — so
 * there is no shape here that forces the choice.
 */
import { isAtOrBelow, type ScopeNode } from "./scope";

/**
 * The reader's choice. `null` is **"All plants"** and is a real answer, not an
 * absent one — it is what a reader picks to widen back out, and what an
 * unreadable stored choice falls back to.
 */
export type PlantChoice = string | null;

/** A root the reader can see. `ScopeNode` satisfies it. */
export interface PlantOption {
  id: string;
  name: string;
  path: string;
}

/* ===========================================================================
 * What the control offers.
 * =========================================================================== */

/**
 * The roots among `nodes`, in tree order.
 *
 * ⭐ A ROOT IS `parentId === null`, and that is a statement about what this
 * READER CAN SEE rather than about the tree. RLS hands back only the nodes the
 * caller may read, so a supervisor granted one line gets a set whose topmost
 * visible node may be a line — and `scopeOptions` already documents that a node
 * whose parent is unreadable is listed at the depth its own path implies rather
 * than dropped. ⚠️ Such a node is NOT a root here: `parentId` is the column, not
 * a guess, and treating an orphaned line as a plant would put "Line 1" in a
 * control labelled with plant names.
 *
 * ⚠️ Sorted by `path`, which is tree order, so the control's order matches every
 * other list on these screens (`scopeOptions` sorts the same way and says why).
 */
export function readablePlants(nodes: readonly ScopeNode[]): PlantOption[] {
  return nodes
    .filter((n) => n.parentId === null)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((n) => ({ id: n.id, name: n.name, path: n.path }));
}

/**
 * Should the header row exist at all?
 *
 * ⭐ Decision 2. **Fewer than two roots means no control and no row** — there is
 * nothing to choose, and a control that cannot change anything is a control
 * named after less than it does (D106). This is most people: a plant admin, or
 * a supervisor granted a single line, whose readable tree has one root.
 */
export function plantControlVisible(plants: readonly PlantOption[]): boolean {
  return plants.length > 1;
}

/**
 * Reconcile a remembered choice with what the reader can see *now*.
 *
 * ⚠️⚠️ A STORED ID THAT IS NO LONGER READABLE FALLS BACK TO "ALL PLANTS", NEVER
 * TO AN EMPTY SCREEN. A grant can be revoked and a plant can be deleted between
 * two visits, and the stored id then names a node that is not in the list. The
 * two ways to be wrong here are not symmetrical: widening shows the reader
 * everything they may see, which is at worst noisy; keeping the dead id filters
 * every section down to nothing and looks exactly like an org somebody emptied.
 *
 * ⚠️ It also collapses to `null` when there is nothing to choose, so a reader
 * whose second plant was taken away is not left filtered by an invisible
 * control (decision 2 hides the row at one root).
 */
export function resolvePlantChoice(
  stored: PlantChoice,
  plants: readonly PlantOption[],
): PlantChoice {
  if (stored === null) return null;
  if (!plantControlVisible(plants)) return null;
  return plants.some((p) => p.id === stored) ? stored : null;
}

/**
 * What the header says. ⭐ This is decision 1's other half and is not optional
 * — see the file header. `null` is spelled out too, so the row never goes blank
 * and "All plants" is visibly a state somebody chose.
 */
export function plantChipLabel(choice: PlantChoice, plants: readonly PlantOption[]): string {
  if (choice === null) return "All plants";
  return plants.find((p) => p.id === choice)?.name ?? "All plants";
}

/* ===========================================================================
 * What the choice does to what is on screen.
 * =========================================================================== */

/**
 * The nodes at or below the chosen plant. `null` returns everything.
 *
 * Generic over the node shape so each panel can pass its own — every admin
 * read carries `path`, and nothing else about a node is needed here.
 */
export function nodesInPlant<T extends { path: string }>(
  nodes: readonly T[],
  choice: PlantChoice,
  plants: readonly PlantOption[],
): T[] {
  const root = choice === null ? undefined : plants.find((p) => p.id === choice);
  if (root === undefined) return [...nodes];
  return nodes.filter((n) => isAtOrBelow(n.path, root.path));
}

/**
 * The rows owned at or below the chosen plant — operators, products, trainings,
 * shift patterns: everything carrying a `site_node_id`.
 *
 * ⚠️ FAILS OPEN ON A ROW WHOSE OWNER THIS READER CANNOT RESOLVE, exactly as
 * `offeredAt` does and for the same reason (`scope.ts`'s header): "I cannot
 * tell" must not become "hidden". Under 0028 a row you can read is owned by a
 * node on one of your own branches, so this should be unreachable — and it is
 * kept because "unreachable" is a claim about the server, and this function is
 * what the user sees on the day it stops being true.
 */
export function rowsInPlant<T extends { siteNodeId: string }>(
  rows: readonly T[],
  choice: PlantChoice,
  plants: readonly PlantOption[],
  nodesById: ReadonlyMap<string, ScopeNode>,
): T[] {
  const root = choice === null ? undefined : plants.find((p) => p.id === choice);
  if (root === undefined) return [...rows];
  return rows.filter((r) => {
    const owner = nodesById.get(r.siteNodeId);
    if (owner === undefined) return true; // cannot tell -> show it
    return isAtOrBelow(owner.path, root.path);
  });
}

/**
 * The products made at or below the chosen plant — D115's list-shaped twin of
 * `rowsInPlant`.
 *
 * ⭐ A product is IN the plant when ANY of its places is at or below the chosen
 * root. A single-owner row (operators, trainings, shift patterns) uses
 * `rowsInPlant`; a product is made in one, several or all plants, so it belongs
 * to the filtered view if even one of its places does. Fails open per place, for
 * the same reason `rowsInPlant` does: an owner this reader cannot resolve is
 * "cannot tell" -> show it.
 *
 * ⚠️ AN EMPTY LIST FALLS OUT OF A NARROWED VIEW, deliberately. A part assigned
 * to no plant is not made in the chosen plant, so it is hidden while a plant is
 * selected — and shown again on "All plants" (the `root === undefined` early
 * return), where every part the reader can see belongs.
 */
export function productRowsInPlant<T extends { siteNodeIds: readonly string[] }>(
  rows: readonly T[],
  choice: PlantChoice,
  plants: readonly PlantOption[],
  nodesById: ReadonlyMap<string, ScopeNode>,
): T[] {
  const root = choice === null ? undefined : plants.find((p) => p.id === choice);
  if (root === undefined) return [...rows];
  return rows.filter((r) =>
    r.siteNodeIds.some((placeId) => {
      const owner = nodesById.get(placeId);
      if (owner === undefined) return true; // cannot tell -> show it
      return isAtOrBelow(owner.path, root.path);
    }),
  );
}

/* ===========================================================================
 * Remembering the choice.
 *
 * ⭐ THE FIRST PERSISTED PREFERENCE IN THIS PROJECT. Nothing in `src/` touched
 * `localStorage` before this, so the convention is set here rather than
 * borrowed: one key, one module, a guarded read and a guarded write, and a
 * value that is only ever a node id or absent.
 *
 * ⚠️ EVERY ACCESS IS WRAPPED, AND NOT DEFENSIVELY-FOR-THE-SAKE-OF-IT. Reading
 * `localStorage` THROWS — not returns null — in a browser set to block site
 * data, and in some embedded webviews. An unguarded read at module scope takes
 * the whole admin screen down for a reader whose only crime is a privacy
 * setting, and the feature it would be taking down is a convenience.
 *
 * ⚠️ IT IS SCOPED PER ORG. `user_profiles` is unique on `(org_id, user_id)`, so
 * one person can be in two orgs, and a node id remembered in one is meaningless
 * in the other. Without the org in the key, switching orgs would restore a
 * choice that `resolvePlantChoice` then has to throw away every time.
 * =========================================================================== */

const KEY_PREFIX = "ps.admin.plant.";

/** The stored choice for this org, or `null` if there is none or it cannot be read. */
export function loadPlantChoice(orgId: string | null): PlantChoice {
  if (orgId === null) return null;
  try {
    return window.localStorage.getItem(KEY_PREFIX + orgId);
  } catch {
    return null; // blocked or unavailable: the feature degrades, the screen does not
  }
}

/**
 * Remember the choice, or forget it when the reader widens back to All plants.
 *
 * ⭐ "All plants" REMOVES THE KEY rather than storing a sentinel. The absence of
 * a key and an explicit "everything" mean the same thing to `loadPlantChoice`,
 * and one representation cannot drift from the other.
 */
export function savePlantChoice(orgId: string | null, choice: PlantChoice): void {
  if (orgId === null) return;
  try {
    if (choice === null) window.localStorage.removeItem(KEY_PREFIX + orgId);
    else window.localStorage.setItem(KEY_PREFIX + orgId, choice);
  } catch {
    // Nothing to do and nothing to say: the choice still applies to this
    // session, it simply will not outlive it.
  }
}
