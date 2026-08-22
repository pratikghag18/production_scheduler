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
export function useBoardWindow(rootPath: string, from: Date, to: Date) {
  return useQuery({
    queryKey: boardKeys.window(rootPath, from, to),
    queryFn: () => fetchBoardWindow(rootPath, from, to),
    staleTime: 30_000,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
  });
}
