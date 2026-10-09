/**
 * F-233 (S194-G): the ONE place a row's id is built with, or checked
 * against, the "optimistic-" placeholder prefix. `useCreateAssignment` and
 * `useApplySplitCoverage` (useAssignmentMutations.ts) and `useCreateRun`
 * (useRunMutations.ts) each stamp a brand-new row with `makePlaceholderId()`
 * while the server has not yet answered for it; `onSettled`'s invalidated
 * refetch replaces it once the real row lands. Nothing else the board reads
 * -- the resolver's own view of the window (`commandAssignments.ts`,
 * `BoardPage.tsx`'s own `runs` list), the drag/keyboard gesture layer
 * (`useDragGesture.ts`), or the "is this window settled" flag
 * (`BoardPage.tsx`'s own `ctx.settled`) -- compares an id against the raw
 * string a second time; every one of them calls `isPlaceholderId` from here.
 *
 * The fault this fixes (found running the R-463 walk, S194-F): a sentence
 * said the instant after a create ("clear Cell 1") read the board, found
 * the still-optimistic row, and sent ITS id to the server --
 * `invalid input syntax for type uuid: "optimistic-<uuid>"`, four of nine
 * lot items in. R-431 (nothing offered the server refuses) and CLAUDE.md §4
 * ("a write that reports success can have changed nothing; read the row
 * back") both name this: a row with no real id cannot be acted on at all.
 */

import type { UseMutationResult } from "@tanstack/react-query";

const PLACEHOLDER_PREFIX = "optimistic-";

/** A fresh placeholder id for a row the server has not answered for yet. */
export function makePlaceholderId(): string {
  return `${PLACEHOLDER_PREFIX}${crypto.randomUUID()}`;
}

/** True for any id `makePlaceholderId` could have produced -- a row still
 *  waiting on its own create/split-coverage write to settle. */
export function isPlaceholderId(id: string): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * True when ANY assignment or run in the window is still a placeholder --
 * `BoardPage.tsx`'s own `hasPendingCreate` prop (kept deliberately separate
 * from `ctx.settled`, which CB-showday-12 already holds to a narrower
 * meaning) reads this alongside `pendingCreateSnapshot` below, so a create
 * counts as pending both while its placeholder sits in the query cache AND
 * in the SHORT window before that (F-233, second pass -- see that flag's
 * own doc). A plain function over the two id lists a caller already has,
 * not a `BoardIndex` method, so it is independently testable with no board
 * fixture at all.
 */
export function hasPendingPlaceholder(
  assignmentIds: Iterable<string>,
  runIds: Iterable<string>,
): boolean {
  for (const id of assignmentIds) {
    if (isPlaceholderId(id)) return true;
  }
  for (const id of runIds) {
    if (isPlaceholderId(id)) return true;
  }
  return false;
}

/**
 * F-233, second pass (S194-G2): closes the cache-derived signal's own FIRST
 * gap. `hasPendingPlaceholder` above only sees a create once its own
 * `onMutate` has actually written the placeholder row into the query cache
 * -- and `onMutate` is async (it awaits `cancelQueries` first), so between
 * a mutation hook's `mutate`/`mutateAsync` being CALLED and the placeholder
 * actually landing there is a real gap. A DRAG-initiated create started in
 * that gap, followed at once by a typed sentence, would see
 * `hasPendingPlaceholder` still false and a board with neither the
 * placeholder (not yet written) nor the real row (not yet answered) --
 * exactly this lane's own fault, one door over.
 *
 * `beginPendingCreate`/`endPendingCreate` close it: counted up the MOMENT
 * `mutate`/`mutateAsync` is called (wrapped in `useCreateAssignment`,
 * `useApplySplitCoverage` and `useCreateRun`, before any await), counted
 * down once `onSettled`'s own invalidated refetch has actually landed --
 * spanning strictly more than `isPending` would (that flips false the
 * instant the mutation itself settles, before `onSettled`'s own awaited
 * refetch finishes). A tiny external store (module-level count plus a
 * listener set), not React state -- the count is written from inside a
 * mutation hook's callbacks, which own no component of their own to hold
 * `useState` in, and read reactively via `useSyncExternalStore`
 * (`BoardPage.tsx`) so a change re-renders without any extra plumbing.
 *
 * This is the FALLBACK signal only -- a create the BAR itself calls is
 * covered exactly, synchronously, by `CommandBar.tsx`'s own write counter
 * (never derived from the cache at all); this module's counter is what
 * still catches a create a DRAG or a manually-opened pop-up started, which
 * the bar has no way to know about on its own.
 */
let pendingCreateCount = 0;
type PendingCreateListener = () => void;
const pendingCreateListeners = new Set<PendingCreateListener>();

function notifyPendingCreateListeners(): void {
  for (const listener of pendingCreateListeners) listener();
}

/** Call synchronously, before any `await`, at the same moment a create
 *  mutation's own `mutate`/`mutateAsync` is called. */
export function beginPendingCreate(): void {
  pendingCreateCount += 1;
  notifyPendingCreateListeners();
}

/** Call once that same mutation's `onSettled` has finished awaiting its own
 *  invalidated refetch -- never before, and always paired one-for-one with
 *  a `beginPendingCreate`, success or failure alike. */
export function endPendingCreate(): void {
  pendingCreateCount = Math.max(0, pendingCreateCount - 1);
  notifyPendingCreateListeners();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribePendingCreate(listener: PendingCreateListener): () => void {
  pendingCreateListeners.add(listener);
  return () => {
    pendingCreateListeners.delete(listener);
  };
}

/** `useSyncExternalStore`'s snapshot half -- true while any create mutation
 *  is between its own call and its post-settle refetch landing. */
export function pendingCreateSnapshot(): boolean {
  return pendingCreateCount > 0;
}

/**
 * Wraps a create mutation's own `mutate`/`mutateAsync` so `beginPendingCreate`
 * runs synchronously the moment either is called -- the shared shape
 * `useCreateAssignment`/`useCreateRun` (useAssignmentMutations.ts/
 * useRunMutations.ts) both need, one helper rather than two copies of the
 * same two-line wrapper. The mutation's own `onSettled` is where
 * `endPendingCreate` belongs (after its own awaited `invalidateQueries`),
 * which stays with the hook itself -- this only wraps the CALL side.
 */
export function withPendingCreateCounting<TData, TError, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  return {
    ...mutation,
    mutate: (...args: Parameters<typeof mutation.mutate>) => {
      beginPendingCreate();
      return mutation.mutate(...args);
    },
    mutateAsync: (...args: Parameters<typeof mutation.mutateAsync>) => {
      beginPendingCreate();
      return mutation.mutateAsync(...args);
    },
  };
}
