/**
 * React Query over the two grant-path RPCs, folded into the one predicate
 * `../lib/editRights.ts` exposes.
 *
 * ⭐ ONE QUERY, NOT TWO, FOR THE SAME REASON `useOperatorsAdmin` IS ONE. Two
 * queries would give the panel two unresolved windows to fold into one answer,
 * and D91 is the standing reminder that folding those is easy to get silently
 * wrong. `Promise.all` inside one `queryFn` gives one `isLoading` covering
 * both — the shape `fetchOperatorsAdmin` already uses for six reads.
 *
 * ⭐ IT NO LONGER TALKS TO `@/lib/supabase` DIRECTLY. It did when it was the
 * only caller, with a note saying the wrapper should move once a second screen
 * needed it; Operators is that screen, so `fetchGrantPaths` now lives in
 * `@/lib/api/access.ts` with every other read. Left here as a record that the
 * deviation was temporary and was actually undone.
 *
 * ⚠️ (was) IT TALKS TO `@/lib/supabase` DIRECTLY RATHER THAN THROUGH `@/lib/api`,
 * which is a deviation from the feature-import rule and is recorded rather than
 * quiet. `useSession.ts` does the same for the profile read and gives the same
 * reason: this is one read that belongs to one screen's permission PREVIEW, not
 * to the RPC surface features share. ⚠️ IF A SECOND SCREEN NEEDS IT — and
 * `OperatorsPanel` has the identical defect, since `app_can_edit_operator` is
 * `app_can_edit_node` on the person's owning node — the wrapper should move to
 * `src/lib/api/access.ts` beside `fetchAdminAnywhere`, which is where it would
 * have gone if it had had two callers on the day it was written.
 *
 * AUTHOR-ONLY — imports React Query and `@/lib/supabase`. Not runnable under
 * `node --experimental-strip-types`; the logic worth testing is in the pure
 * module.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchGrantPaths, type GrantPaths, type SchedulerError } from "@/lib/api";
import { canEditNode, type EditRights } from "../lib/editRights";

export const editRightsKeys = {
  all: ["edit-rights"] as const,
};

export interface UseEditRightsResult {
  /** The three arms' inputs, plus whether the read landed. */
  rights: EditRights;
  /**
   * `canEdit(ownerPath)` — the owning node's ltree path, or `null` when the
   * client cannot resolve it. Curried so a row never has to hold the rights
   * object, and memoised so it is a stable identity between reads.
   */
  canEdit: (path: string | null) => boolean;
}

/**
 * @param enabled the panel's own `canQueryAsUser(...)`, so this asks nothing
 *                before there is somebody to ask about.
 * @param role    `profile.role` — the ORG-WIDE role, already on the session
 *                profile, so arms (1) and (3a) need no second read.
 *
 * ⚠️⚠️ THE D91 GATE IS `!enabled || isLoading`, NEVER `isLoading` ALONE.
 * `enabled: false` leaves `isLoading` FALSE, so gating on it alone would report
 * a disabled query as a landed answer of "no grants anywhere" — which is the
 * fail-CLOSED direction, and would strip every control off every row for
 * anybody the query had not been switched on for yet.
 *
 * ⭐ `known` ALSO REQUIRES `data !== undefined`, which is belt and braces on
 * purpose: React Query serves a cached `data` while refetching, and the three
 * flags above are not, between them, a proof that there is a value to read.
 */
export function useEditRights(enabled: boolean, role: string | null): UseEditRightsResult {
  const { data, isLoading, isError } = useQuery<GrantPaths, SchedulerError>({
    queryKey: [...editRightsKeys.all],
    queryFn: () => fetchGrantPaths(),
    enabled,
  });

  const pending = !enabled || isLoading;
  const rights = useMemo<EditRights>(
    () => ({
      role,
      adminPaths: data?.adminPaths ?? [],
      writablePaths: data?.writablePaths ?? [],
      known: !pending && !isError && data !== undefined,
    }),
    [role, data, pending, isError],
  );

  const canEdit = useMemo(() => (path: string | null) => canEditNode(path, rights), [rights]);

  return { rights, canEdit };
}
