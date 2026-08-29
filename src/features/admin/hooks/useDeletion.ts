/**
 * React Query hooks over `src/lib/api/deletion.ts` (migration 0029, D110).
 *
 * ⭐ ONE HOOK PAIR FOR ALL FOUR PANELS, not one per section. The products,
 * operators and shifts panels each own their own list and their own keys, but
 * the question "what would deleting this take with it" has exactly one answer
 * shape and exactly one dialog, so a per-panel copy would be three places for
 * the same two calls to drift.
 *
 * ⚠️ AND THE INVALIDATION IS DELIBERATELY THE WIDEST ONE IN THE CODEBASE.
 * Every other write here invalidates its own section's key, because it changes
 * one list. A delete can remove runs and assignments on cells the person
 * deleting it has never opened, can drop a training off several people at
 * once, and can change which pattern a cell resolves to — so `productKeys.all`
 * would leave the BOARD showing jobs that no longer exist. `invalidateQueries()`
 * with no filter is the honest answer for the one operation in this app whose
 * blast radius is not knowable from its own arguments.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteOwnedRow,
  previewDeletion,
  type DeletableKind,
  type DeletionPreview,
  type SchedulerError,
} from "@/lib/api";

export const deletionKeys = {
  preview: (kind: DeletableKind, id: string) => ["deletion-preview", kind, id] as const,
};

/**
 * What deleting this row would do.
 *
 * `enabled` is REQUIRED, as everywhere else in this folder — the query fires
 * when a confirmation opens and not before. It is a read, so re-opening the
 * dialog re-asks rather than showing a cached answer from five minutes ago:
 * `staleTime: 0` is the default and is left alone on purpose, because a count
 * that is quietly out of date is the one thing this dialog must not show.
 */
export function useDeletionPreview(kind: DeletableKind, id: string | null) {
  return useQuery<DeletionPreview, SchedulerError>({
    queryKey: deletionKeys.preview(kind, id ?? ""),
    queryFn: () => previewDeletion(kind, id as string),
    enabled: id !== null,
  });
}

/**
 * Do it.
 *
 * Resolves to the counts that ACTUALLY happened — the panel reports from this,
 * never from the preview that preceded it (see `deleteOwnedRow`'s header).
 */
export function useDeleteOwnedRow() {
  const queryClient = useQueryClient();

  return useMutation<DeletionPreview, SchedulerError, { kind: DeletableKind; id: string }>({
    mutationFn: ({ kind, id }) => deleteOwnedRow(kind, id),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}
