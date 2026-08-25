import { useQuery } from "@tanstack/react-query";
import { fetchBoardWindow, isSchedulerError } from "@/lib/api";

/**
 * One query-key convention, exported so nothing hand-builds a key (brief
 * P1-3b §6). `useRunMutations`/`useAssignmentMutations` import this to
 * cancel/snapshot/invalidate the same key their optimistic updates touch.
 */
export const boardKeys = {
  window: (rootPath: string, from: Date, to: Date) =>
    ["board", "window", rootPath, from.toISOString(), to.toISOString()] as const,
};

/**
 * `useQuery` over `board_window`. `staleTime: 30_000` per brief §6. Retry
 * policy: never retry a typed `SchedulerError` — a capacity rejection (or
 * any other typed failure) is an answer, not a flake; only an
 * unrecognised/network-shaped failure gets React Query's normal one retry.
 */
export function useBoardWindow(rootPath: string, from: Date, to: Date, enabled: boolean) {
  return useQuery({
    queryKey: boardKeys.window(rootPath, from, to),
    queryFn: () => fetchBoardWindow(rootPath, from, to),
    staleTime: 30_000,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
    // Every read here is RLS-scoped to the caller, so firing before the
    // session resolves is a request the server MUST refuse. `enabled` is
    // REQUIRED, not optional with a `true` default: a default would let a new
    // caller reintroduce the 401 silently, which is the whole failure being
    // removed. Callers derive it from `canQueryAsUser` (features/auth/session).
    enabled,
  });
}
