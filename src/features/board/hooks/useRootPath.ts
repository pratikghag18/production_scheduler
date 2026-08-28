import { useQuery } from "@tanstack/react-query";
import { fetchVisibleBoardRoots } from "@/lib/api";
import { hierarchyKeys } from "@/features/admin/hooks/useHierarchyMutations";
import { resolveRootPath, type BoardRoot } from "../lib/rootSelection";
import { useBoardViewStore } from "../store/boardView";

/**
 * WHERE THIS BOARD OPENS, AND FOR WHOM.
 *
 * ⭐ THIS FILE USED TO BE FOUR LINES AND A CONSTANT:
 *
 *   const ORG_ROOT_PATH = "plant_1";
 *   export function useRootPath(): string { return ORG_ROOT_PATH; }
 *
 * Every user, every session, since P1-4a — whose own brief said to keep the
 * inherited constant and flag it, and whose comment here said plainly that it
 * was "not derived from the session/profile in any way yet". It was harmless
 * while there was one plant. Migration 0026 turned it from invisible into
 * merely wrong: the Plant 2 admin's board now asks for Plant 1 and the server
 * correctly refuses, so she gets an EMPTY board rather than SOMEBODY ELSE'S.
 *
 * The rule itself is pure and lives in `../lib/rootSelection`; this hook is
 * the wiring. It shares the `hierarchyKeys` prefix so that renaming, moving or
 * deleting a node invalidates it along with everything else about the tree —
 * a plant that has just been renamed must not keep its old name in the picker.
 */
export function useRootPath(): {
  rootPath: string | null;
  roots: BoardRoot[];
  isLoading: boolean;
  isError: boolean;
  selectRootPath: (path: string) => void;
} {
  const selected = useBoardViewStore((s) => s.selectedRootPath);
  const selectRootPath = useBoardViewStore((s) => s.setSelectedRootPath);

  const rootsQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "board-roots"],
    queryFn: fetchVisibleBoardRoots,
  });

  const roots = rootsQuery.data ?? [];

  // ⚠️ NEVER FALL BACK TO A PATH WHILE THE ANSWER IS STILL LOADING. Returning
  // a guess here and correcting it on arrival would fire a `board_window` for
  // the wrong place first — which is the old constant with extra steps, and on
  // a slow connection it is the version the person actually sees.
  return {
    rootPath: rootsQuery.isSuccess ? resolveRootPath(selected, roots) : null,
    roots,
    isLoading: rootsQuery.isLoading,
    isError: rootsQuery.isError,
    selectRootPath,
  };
}
