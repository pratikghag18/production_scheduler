/**
 * adminView.ts — the admin screen's own view state. Today that is one thing:
 * which plant the reader is looking at.
 *
 * ---------------------------------------------------------------------------
 * ⭐ MODELLED ON `features/board/store/boardView.ts`, WITH ONE DELIBERATE
 * DIFFERENCE, AND THE DIFFERENCE IS THE POINT.
 *
 * `boardView.selectedRootPath` is explicitly **a HINT that does not survive**:
 * its own comment says a remembered choice outlives the identity that made it,
 * so `resolveRootPath` drops it whenever the server's list stops containing it.
 * This store keeps that discipline — `resolvePlantChoice` does the same job —
 * but it ALSO **persists**, which nothing in `src/` did before.
 *
 * ⚠️ That is a decision, not drift. The two answer different questions:
 *
 *   `selectedRootPath`   WHERE AM I WORKING RIGHT NOW.  A working position.
 *                        Resetting it costs one click and orients you.
 *   `plantChoice`        WHAT IS MINE TO LOOK AT.       A standing preference.
 *                        Resetting it puts three plants back in front of
 *                        somebody who told us they only care about one.
 *
 * The maintainer chose persistence explicitly (31 Aug), and chose it together
 * with the always-visible header chip — see `../lib/plantFilter`. **Neither
 * half is optional**: a filter that persists without saying so is the failure
 * `SiteAccessPanel`'s own header records, *"Where is Plant 1?"*, reported from
 * the running app when one tab's selection silently scoped another.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ HYDRATION IS THE PAGE'S JOB, NOT THIS FILE'S, and not a panel's.
 * `loadPlantChoice` needs an org id, which lives behind `useSession()` — and
 * `useSession` is already called in five components, a known cost recorded
 * against P1-6b. `AdminPage` calls it once and hydrates; every panel reads
 * `plantChoice` straight off this store and never touches the session.
 */
import { create } from "zustand";
import { loadPlantChoice, savePlantChoice, type PlantChoice } from "../lib/plantFilter";

interface AdminViewState {
  /**
   * The chosen plant, or `null` for "All plants".
   *
   * ⚠️ RAW, AND NOT YET CHECKED AGAINST WHAT THE READER CAN SEE. A stored id
   * can name a plant whose grant was revoked between two visits. Everything
   * that renders runs it through `resolvePlantChoice` first; nothing should
   * read this field directly except that resolution.
   */
  plantChoice: PlantChoice;
  /**
   * The org `plantChoice` was loaded for, or `null` before any load.
   *
   * ⭐ `user_profiles` is unique on `(org_id, user_id)`, so one person can be
   * in two orgs and a node id remembered in one is meaningless in the other.
   * Holding the org here is what lets `AdminPage` notice an identity change
   * and re-hydrate, rather than carrying the wrong org's choice across.
   */
  hydratedOrgId: string | null;

  /** Read the remembered choice for this org. Idempotent per org. */
  hydratePlantChoice: (orgId: string) => void;
  /** Choose, and remember. `null` means All plants and forgets the key. */
  setPlantChoice: (orgId: string | null, choice: PlantChoice) => void;
}

export const useAdminViewStore = create<AdminViewState>((set) => ({
  plantChoice: null,
  hydratedOrgId: null,

  hydratePlantChoice: (orgId) => set({ plantChoice: loadPlantChoice(orgId), hydratedOrgId: orgId }),

  /**
   * ⭐ WRITES THROUGH ON THE WAY PAST, rather than in an effect watching the
   * value. An effect would also fire for the hydration that just read the
   * value back, writing what it had only this moment loaded — harmless today
   * and exactly the shape that stops being harmless when a second writer
   * appears.
   */
  setPlantChoice: (orgId, choice) => {
    savePlantChoice(orgId, choice);
    set({ plantChoice: choice });
  },
}));
