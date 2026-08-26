/**
 * React Query hooks over the three site-membership RPC wrappers
 * (`src/lib/api/access.ts`, migration `20260826000021_site_membership.sql`),
 * for `SiteAccessPanel` (brief P1-6a §5).
 *
 * Same shape as `useHierarchyMutations.ts`, followed exactly per §5: a
 * `useMutation<TResult, SchedulerError, TVars>` per write, `onSuccess`
 * invalidates, and deliberately NO optimistic updates -- that file's header
 * explains why (a write here changes exactly one row and the server's next
 * read is the source of truth for the new role/removal; reproducing that
 * client-side would be the duplicated logic its header forbids) and it
 * applies here verbatim.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSitePeople,
  removeSiteMember,
  setSiteMember,
  type RemoveSiteMemberInput,
  type SchedulerError,
  type SetSiteMemberInput,
} from "@/lib/api";

export const siteAccessKeys = {
  all: ["site-access"] as const,
};

/**
 * `enabled: enabled && nodeId !== null` -- but `enabled` does NOT narrow
 * `nodeId`'s type for `queryFn` below: TypeScript has no way to know the
 * query cannot run with `nodeId === null`, since the two are independent
 * expressions from its point of view. Narrowed and thrown on INSIDE
 * `queryFn` instead of widening `fetchSitePeople` to accept `null` (brief
 * §5's explicit instruction -- that would make an unasked question look
 * like a legitimate call) or asserting with `!` (an unreachable throw is
 * honest where a lie is not).
 */
export function useSitePeople(nodeId: string | null, enabled: boolean) {
  return useQuery<unknown, SchedulerError>({
    queryKey: [...siteAccessKeys.all, nodeId],
    queryFn: () => {
      if (nodeId === null) {
        throw new Error("useSitePeople: queryFn ran with nodeId === null");
      }
      return fetchSitePeople(nodeId);
    },
    enabled: enabled && nodeId !== null,
  });
}

/** `set_site_member`. Adds a person or changes the role they already hold. */
export function useSetSiteMember() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, SetSiteMemberInput>({
    mutationFn: (input) => setSiteMember(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: siteAccessKeys.all });
    },
  });
}

/** `remove_site_member`. Removes the grant sitting on this exact node. */
export function useRemoveSiteMember() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, RemoveSiteMemberInput>({
    mutationFn: (input) => removeSiteMember(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: siteAccessKeys.all });
    },
  });
}
