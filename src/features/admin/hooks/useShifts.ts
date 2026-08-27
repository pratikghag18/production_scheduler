/**
 * React Query over `src/lib/api/shifts.ts` — one read, one mutation per write.
 *
 * Same shape as `useSiteAccess.ts` and `useHierarchyMutations.ts`, and for the
 * same reasons: a `useMutation<TResult, SchedulerError, TVars>` per write,
 * `onSuccess` invalidates, and deliberately NO OPTIMISTIC UPDATES.
 *
 * That last one is not caution, it is correctness. Three of these writes have
 * outcomes the client cannot predict:
 *   - a shift insert can be refused by `shifts_no_overlap_within_template`,
 *     and the row that "appeared" would have to be un-appeared;
 *   - deleting a pattern CASCADES to its shifts and their breaks;
 *   - attaching a pattern to a node changes which pattern every DESCENDANT
 *     resolves to (`resolve_shift_template`, nearest ancestor wins), a subtree
 *     recomputation that has no business being reimplemented here.
 * Invalidate, refetch, redraw.
 *
 * ⚠️ `["board"]` IS INVALIDATED TOO, on the writes that change what a board
 * actually draws. `board_window` carries the resolved shift template for the
 * loaded subtree, so renaming a shift or re-attaching a pattern leaves a board
 * open in another tab showing yesterday's answer. The prefix is written out
 * rather than imported from `useBoardWindow`'s `boardKeys` because that helper
 * builds a FULL key (root path, window bounds) and this needs to match every
 * one of them.
 *
 * AUTHOR-ONLY — imports React Query and, through `@/lib/api`, the Supabase
 * client; not runnable under `node --experimental-strip-types`. The logic
 * worth testing is in `../lib/shiftDraft.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  attachPattern,
  createBreak,
  createPattern,
  createShift,
  deleteBreak,
  deletePattern,
  deleteShift,
  detachPattern,
  fetchShiftPatterns,
  renamePattern,
  updateBreak,
  updateShift,
  type CreateBreakInput,
  type CreatePatternInput,
  type CreateShiftInput,
  type AttachPatternInput,
  type NodeShiftTemplateRow,
  type SchedulerError,
  type ShiftBreakRow,
  type ShiftPatternsPayload,
  type ShiftRow,
  type ShiftTemplateRow,
  type UpdateBreakInput,
  type UpdateShiftInput,
} from "@/lib/api";

export const shiftKeys = {
  all: ["shift-patterns"] as const,
};

/** Every board window, whatever root and dates it was opened on. */
const BOARD_PREFIX = ["board"] as const;

/**
 * The one read. `enabled` is REQUIRED, never defaulted: every table behind
 * `fetchShiftPatterns` is RLS-scoped to the caller, so firing it before the
 * session resolves can only be a 401. Callers pass
 * `canQueryAsUser(session?.user.id ?? null, sessionLoading)` (D91).
 */
export function useShiftPatterns(enabled: boolean) {
  return useQuery<ShiftPatternsPayload, SchedulerError>({
    queryKey: shiftKeys.all,
    queryFn: fetchShiftPatterns,
    enabled,
  });
}

function useShiftWrite<TResult, TVars>(
  mutationFn: (vars: TVars) => Promise<TResult>,
  alsoBoard: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, SchedulerError, TVars>({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shiftKeys.all });
      if (alsoBoard) void queryClient.invalidateQueries({ queryKey: BOARD_PREFIX });
    },
  });
}

/* --- the pattern itself: needs OWNERSHIP (company admin, or the site's) --- */

export function useCreatePattern() {
  return useShiftWrite<ShiftTemplateRow, CreatePatternInput>(
    (input) => createPattern(input),
    false,
  );
}

export function useRenamePattern() {
  return useShiftWrite<ShiftTemplateRow, { templateId: string; name: string }>(
    (v) => renamePattern(v.templateId, v.name),
    true,
  );
}

/** Refused with `{kind:"StillInUse"}` while any node is attached (no `ON DELETE`). */
export function useDeletePattern() {
  return useShiftWrite<{ id: string }, { templateId: string }>(
    (v) => deletePattern(v.templateId),
    true,
  );
}

/* --- the inside of a pattern: `app_is_admin_for_shift_template` --- */

export function useCreateShift() {
  return useShiftWrite<ShiftRow, CreateShiftInput>((input) => createShift(input), true);
}

export function useUpdateShift() {
  return useShiftWrite<ShiftRow, UpdateShiftInput>((input) => updateShift(input), true);
}

export function useDeleteShift() {
  return useShiftWrite<{ id: string }, { shiftId: string }>(
    (v) => deleteShift(v.shiftId),
    true,
  );
}

/* --- breaks: `app_is_admin_for_shift`, and display-only in v1 --- */

export function useCreateBreak() {
  return useShiftWrite<ShiftBreakRow, CreateBreakInput>((input) => createBreak(input), true);
}

export function useUpdateBreak() {
  return useShiftWrite<ShiftBreakRow, UpdateBreakInput>((input) => updateBreak(input), true);
}

export function useDeleteBreak() {
  return useShiftWrite<{ id: string }, { breakId: string }>(
    (v) => deleteBreak(v.breakId),
    true,
  );
}

/* --- attachment: a DIFFERENT permission, `app_is_admin_for(node_id)` --- */

export function useAttachPattern() {
  return useShiftWrite<NodeShiftTemplateRow, AttachPatternInput>(
    (input) => attachPattern(input),
    true,
  );
}

export function useDetachPattern() {
  return useShiftWrite<{ nodeId: string }, { nodeId: string }>(
    (v) => detachPattern(v.nodeId),
    true,
  );
}
