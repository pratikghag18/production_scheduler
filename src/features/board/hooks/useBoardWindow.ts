import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchBlocksElsewhere, fetchBoardWindow, isSchedulerError } from "@/lib/api";

/**
 * One query-key convention, exported so nothing hand-builds a key (brief
 * P1-3b §6). `useRunMutations`/`useAssignmentMutations` import this to
 * cancel/snapshot/invalidate the same key their optimistic updates touch.
 */
export const boardKeys = {
  window: (rootPath: string, from: Date, to: Date) =>
    ["board", "window", rootPath, from.toISOString(), to.toISOString()] as const,
  /**
   * R-465: the blocks of people on places the caller cannot read, for the SAME
   * window. The key EXTENDS the window's own key on purpose: every write that
   * invalidates, cancels or snapshots `boardKeys.window(...)` (a prefix match)
   * and every `["board"]` invalidation in the admin hooks reaches this read
   * too, so it goes stale exactly when the board's own data does.
   */
  elsewhere: (rootPath: string, from: Date, to: Date) =>
    [...boardKeys.window(rootPath, from, to), "elsewhere"] as const,
};

/**
 * `useQuery` over `board_window`. `staleTime: 30_000` per brief §6. Retry
 * policy: never retry a typed `SchedulerError` — a capacity rejection (or
 * any other typed failure) is an answer, not a flake; only an
 * unrecognised/network-shaped failure gets React Query's normal one retry.
 *
 * R-424 (the bar keeps its conversation): `queryKey` carries `from`/`to`, so
 * every window move (a drag of the date picker, "Show that day") is a BRAND
 * NEW key to React Query — without `placeholderData`, `data` goes back to
 * `undefined` the instant that key changes, exactly like the very first
 * load, and every consumer gated on "the board has data" (`hasData`,
 * `index`, `commandCtx`, the `canPlace` derived from `boardQuery.data`)
 * unmounts along with it. That is what actually vanished the command bar
 * twice on 16 Sept: the whole `{hasData && index && boardQuery.data && (...)}
 * ` block in `BoardPage.tsx` — the bar included — dropped out of the tree for
 * the gap between the window moving and the new window's fetch landing, and
 * a real unmount destroys every ref and every piece of `useState` the bar
 * was holding. `placeholderData: keepPreviousData` keeps the LAST window's
 * data in `data` (marked `isPlaceholderData`, `isFetching` still true) for
 * any key change, including one triggered by a same-window write's own
 * `invalidateQueries` — so `hasData`/`index`/`commandCtx`/`canPlace` stay
 * true across every refetch once the FIRST one has ever landed, and nothing
 * downstream unmounts to lose state it never needed to lose.
 */
export function useBoardWindow(rootPath: string, from: Date, to: Date, enabled: boolean) {
  return useQuery({
    queryKey: boardKeys.window(rootPath, from, to),
    queryFn: () => fetchBoardWindow(rootPath, from, to),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
    // Every read here is RLS-scoped to the caller, so firing before the
    // session resolves is a request the server MUST refuse. `enabled` is
    // REQUIRED, not optional with a `true` default: a default would let a new
    // caller reintroduce the 401 silently, which is the whole failure being
    // removed. Callers derive it from `canQueryAsUser` (features/auth/session).
    enabled,
  });
}

/**
 * R-465 (DEF-0053): `operator_blocks_elsewhere` over the board's own fetch
 * window, with the board's own life: same `staleTime`, same retry rule, same
 * `enabled` gate, refetched by the same invalidations (see
 * `boardKeys.elsewhere`). NO `placeholderData`: when the window moves the old
 * window's rows are not this window's, so the rail says what it said before
 * this read existed until the new answer lands -- it never says "booked" on a
 * guess and never hides a person.
 */
export function useBlocksElsewhere(rootPath: string, from: Date, to: Date, enabled: boolean) {
  return useQuery({
    queryKey: boardKeys.elsewhere(rootPath, from, to),
    queryFn: () => fetchBlocksElsewhere(from, to),
    staleTime: 30_000,
    retry: (count, err) => !isSchedulerError(err) && count < 1,
    enabled,
  });
}
