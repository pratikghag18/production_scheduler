/**
 * React Query hooks over `src/lib/api/cycleTimes.ts` (R-315, migration 0040),
 * for `CycleTimesPanel`.
 *
 * Modelled on `useProducts.ts` exactly: a `useMutation<TResult, SchedulerError,
 * TVars>` per write, `onSuccess` invalidates, and deliberately NO optimistic
 * updates — reproducing the server's answer client-side is the duplicated logic
 * `useHierarchyMutations.ts`'s header forbids, and here the server may refuse a
 * write silently (an RLS-filtered UPDATE changes nothing and raises nothing),
 * so an optimistic row could show a number that was never stored.
 *
 * ⭐ EVERY WRITE ALSO INVALIDATES `["board"]`. A cycle time is not admin
 * bookkeeping: it is what the board derives every unset target from (R-316), so
 * measuring a cell changes what the schedule reads immediately. Leaving the
 * board's cache alone would show yesterday's targets until it happened to
 * refetch — the same reason a product's places invalidate both.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteCycleTime,
  fetchCycleTimes,
  setNodeSumsChildren,
  upsertCycleTime,
  type AdminCycleTime,
  type CycleTimeInput,
  type RemoveCycleTimeInput,
  type SchedulerError,
  type SetSumsChildrenInput,
} from "@/lib/api";
import { hierarchyKeys } from "./useHierarchyMutations";

export const cycleTimeKeys = {
  all: ["admin-cycle-times"] as const,
};

/**
 * Every cycle time the caller can read.
 *
 * `enabled` is REQUIRED, not defaulted — the same rule `useAdminProducts` and
 * `useHierarchyTree` follow: a read fired before the session resolves can only
 * be a 401.
 *
 * Resolves with the nulls INTACT, so the panel can say how many rows it could
 * not read rather than silently showing fewer.
 */
export function useCycleTimes(enabled: boolean) {
  return useQuery<ReadonlyArray<AdminCycleTime | null>, SchedulerError>({
    queryKey: cycleTimeKeys.all,
    queryFn: fetchCycleTimes,
    enabled,
  });
}

/** Sets (or replaces) the standard for one part at one cell. */
export function useSetCycleTime() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, CycleTimeInput>({
    mutationFn: (input) => upsertCycleTime(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cycleTimeKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
}

/**
 * R-319: choose whether a node adds up its children's cycle times.
 *
 * Invalidates the HIERARCHY tree, not the cycle-time list: the setting lives on
 * `nodes` and the tree read is what carries it. The board is deliberately left
 * alone — a roll-up is display only and no derived target reads it (R-316), so
 * refetching the whole board here would be work for nothing.
 */
export function useSetNodeRollup() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, SetSumsChildrenInput>({
    mutationFn: (input) => setNodeSumsChildren(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    },
  });
}

/** Clears the standard for one part at one cell. */
export function useClearCycleTime() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, RemoveCycleTimeInput>({
    mutationFn: (input) => deleteCycleTime(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: cycleTimeKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
}
