import { useQuery } from "@tanstack/react-query";
import { fetchAbsences, isSchedulerError, type AbsenceRecord } from "@/lib/api";

/**
 * R-357 — the board's own read of who is on leave, the sibling of
 * `useBoardWindow`.
 *
 * ⭐ A SECOND QUERY, NOT A NEW PAYLOAD KEY, AND THAT IS A DELIBERATE CALL (see
 * the lane report and `absence.ts`). `board_window` is SECURITY INVOKER and its
 * operator list is scoped by `operators_select` — `(org = current_org AND
 * app_can_read_in_plant(site_node_id))`. `absences_select` gates on
 * `app_can_read_operator`, whose body is EXACTLY that predicate. So the set of
 * people this read returns absences for is, byte for byte, the set the board
 * drew: there is no person visible on the board whose leave this misses, and
 * none it can see that the board cannot — the DEF-0016/0017 gap (a client
 * walking UP the tree to an ancestor it cannot read) does not arise, because a
 * person's absence hangs off the person, resolved by the same server predicate
 * that already let them onto the board. Reading it beside `board_window` in the
 * same page keeps one loading state; no ancestry walk happens in the browser.
 *
 * `fetchAbsences` is RLS-scoped and paged; `absenceGaps` narrows per operator
 * and per window at the point of use, so this carries every visible absence and
 * the filtering lives with the predicate.
 */
export const absenceKeys = {
  all: () => ["absences", "all"] as const,
};

export function useAbsences(enabled: boolean) {
  return useQuery({
    queryKey: absenceKeys.all(),
    queryFn: async (): Promise<AbsenceRecord[]> => {
      const { absences } = await fetchAbsences();
      return absences;
    },
    staleTime: 30_000,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
    // Same gate and same reasoning as `useBoardWindow`: a read that fires before
    // the session resolves is one the server MUST refuse. Required, never a
    // permissive default.
    enabled,
  });
}
