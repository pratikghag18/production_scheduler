/**
 * usePlantFilter — what every admin panel reads to know which plant it is
 * showing. Modelled on `features/board/hooks/useRootPath`.
 *
 * ---------------------------------------------------------------------------
 * ⭐ READ-ONLY, AND THAT IS WHY IT TAKES NO SESSION. Choosing and remembering
 * belong to `AdminPage`, which already calls `useSession()`; a panel only ever
 * asks "which plant am I showing". Panels documenting that they take NO PROPS
 * (`ShiftsPanel`, `OperatorsPanel`, `ProductsPanel`) keep that invariant by
 * calling this instead of growing a prop — the same move `useRootPath` makes
 * for the board toolbar.
 *
 * ⚠️ EACH PANEL PASSES ITS OWN NODES, AND THEY COME FROM THREE DIFFERENT READS
 * — `["hierarchy","tree"]` (AdminPage and ProductsPanel share it),
 * `["operators","admin"]` and `["shift-patterns"]`. That is exactly why the
 * shared value is a NODE ID and not a resolved subtree: an id is the only thing
 * all three can apply to their own arrays without a fourth round trip.
 *
 * ⚠️ AND WHY IT COMPARES `path`, NOT `parentId`. `ShiftsPanel`'s nodes lose
 * their parent inside `patternRows` (`shiftDraft.ts`, which fabricates
 * `parentId: null`), so a parent-walking filter cannot run there at all. Every
 * admin read keeps `path`. See `../lib/plantFilter`.
 *
 * ---------------------------------------------------------------------------
 * ⭐ WHILE THE NODES ARE STILL LOADING THIS ANSWERS "All plants", and that is
 * safe HERE for the reason it would not be in `useRootPath`. There, a guessed
 * root fires a `board_window` for the wrong place and the person sees the wrong
 * data first. Here the panel is rendering its own loading state and has no rows
 * to filter yet, so the only thing an empty answer reaches is nothing.
 */
import { useMemo } from "react";
import {
  plantChipLabel,
  plantControlVisible,
  readablePlants,
  resolvePlantChoice,
  type PlantChoice,
  type PlantOption,
} from "../lib/plantFilter";
import { type ScopeNode } from "../lib/scope";
import { useAdminViewStore } from "../store/adminView";

export interface PlantFilter {
  /** Resolved against what this reader can see now. `null` is All plants. */
  choice: PlantChoice;
  /** The roots on offer, in tree order. */
  plants: PlantOption[];
  /** Whether there is a choice to make at all — fewer than two roots means no. */
  visible: boolean;
  /** What the header says, `"All plants"` included. Never blank. */
  label: string;
}

/**
 * @param nodes this panel's own node array. Anything carrying `id`, `name`,
 *   `parentId` and `path` — `BoardNode` satisfies it.
 */
export function usePlantFilter(nodes: readonly ScopeNode[]): PlantFilter {
  const stored = useAdminViewStore((s) => s.plantChoice);

  return useMemo(() => {
    const plants = readablePlants(nodes);
    const choice = resolvePlantChoice(stored, plants);
    return {
      choice,
      plants,
      visible: plantControlVisible(plants),
      label: plantChipLabel(choice, plants),
    };
  }, [nodes, stored]);
}
