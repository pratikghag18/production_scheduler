/**
 * React Query over the operators section's api layer
 * (`src/lib/api/operators.ts`), for `OperatorsPanel`.
 *
 * Modelled on `useSiteAccess.ts` exactly: one `useQuery`, one
 * `useMutation<TResult, SchedulerError, TVars>` per write, `onSuccess`
 * invalidates the whole `operatorKeys.all` prefix, and deliberately NO
 * optimistic updates.
 *
 * ⭐ NO OPTIMISTIC UPDATES, AND HERE THAT IS MORE THAN A CONVENTION. Granting
 * ONE ticket changes the yes/no answer for every place under every node that
 * requires it — a fan-out this client would have to recompute to fake, and
 * `src/features/admin/lib/operators.ts` is explicitly a MIRROR of
 * `check_eligibility`, not a substitute for it. Painting a tick before the
 * server has been asked is exactly the false promise that module's header
 * forbids. Invalidate; let the refetch redraw.
 *
 * ⚠️ AND THE SILENT-REFUSAL CASE IS WHY `onSuccess` CAN BE TRUSTED AT ALL. A
 * policy's `USING` clause filters rather than raising, so a refused UPDATE or
 * DELETE resolves successfully having changed nothing. Every wrapper in the
 * api layer ends `.select()` + `requireWritten(...)`, which turns that into a
 * thrown `{kind:"WriteRefused"}` — so `onSuccess` here means the row really
 * moved, and the invalidation it fires is not redrawing a lie.
 *
 * AUTHOR-ONLY — imports React Query and, transitively through `@/lib/api`,
 * the Supabase client. Not runnable under `node --experimental-strip-types`;
 * the logic worth testing is in the pure module.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createOperator,
  createSkill,
  deleteOperator,
  deleteSkill,
  fetchOperatorsAdmin,
  grantSkill,
  renameSkill,
  revokeSkill,
  setOperatorActive,
  updateOperator,
  updateSkillExpiry,
  type CreateOperatorInput,
  type CreateSkillInput,
  type GrantSkillInput,
  type OperatorRecord,
  type OperatorSkillRecord,
  type OperatorsAdminData,
  type SchedulerError,
  type SkillRecord,
  type UpdateOperatorInput,
} from "@/lib/api";

export const operatorKeys = {
  all: ["operators"] as const,
};

function useInvalidateOperators() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: operatorKeys.all });
  };
}

/**
 * The section's ONE read: operators, skills, tickets, requirements, nodes and
 * levels in a single `Promise.all` (see `fetchOperatorsAdmin`). One query
 * means one `isLoading` to fold into the panel's state, which D91 is the
 * standing reminder to get right — `enabled: false` leaves `isLoading` FALSE,
 * so the panel gates on `!enabled || isLoading` and never on `isLoading`
 * alone.
 */
export function useOperatorsAdmin(enabled: boolean) {
  return useQuery<OperatorsAdminData, SchedulerError>({
    queryKey: [...operatorKeys.all, "admin"],
    queryFn: () => fetchOperatorsAdmin(),
    enabled,
  });
}

export function useCreateOperator() {
  const invalidate = useInvalidateOperators();
  return useMutation<OperatorRecord, SchedulerError, CreateOperatorInput>({
    mutationFn: (input) => createOperator(input),
    onSuccess: invalidate,
  });
}

export function useUpdateOperator() {
  const invalidate = useInvalidateOperators();
  return useMutation<OperatorRecord, SchedulerError, UpdateOperatorInput>({
    mutationFn: (input) => updateOperator(input),
    onSuccess: invalidate,
  });
}

/** The main action for taking someone off the board (the maintainer's decision). */
export function useSetOperatorActive() {
  const invalidate = useInvalidateOperators();
  return useMutation<OperatorRecord, SchedulerError, { id: string; active: boolean }>({
    mutationFn: (input) => setOperatorActive(input),
    onSuccess: invalidate,
  });
}

/** Secondary. Raises `{kind:"StillInUse", usedBy}` for anyone ever scheduled or certified. */
export function useDeleteOperator() {
  const invalidate = useInvalidateOperators();
  return useMutation<void, SchedulerError, { id: string }>({
    mutationFn: (input) => deleteOperator(input.id),
    onSuccess: invalidate,
  });
}

export function useCreateSkill() {
  const invalidate = useInvalidateOperators();
  return useMutation<SkillRecord, SchedulerError, CreateSkillInput>({
    mutationFn: (input) => createSkill(input),
    onSuccess: invalidate,
  });
}

export function useRenameSkill() {
  const invalidate = useInvalidateOperators();
  return useMutation<SkillRecord, SchedulerError, { id: string; name: string }>({
    mutationFn: (input) => renameSkill(input),
    onSuccess: invalidate,
  });
}

export function useDeleteSkill() {
  const invalidate = useInvalidateOperators();
  return useMutation<void, SchedulerError, { id: string }>({
    mutationFn: (input) => deleteSkill(input.id),
    onSuccess: invalidate,
  });
}

/** One row in; several crosses turn green. Invalidating is what redraws them. */
export function useGrantSkill() {
  const invalidate = useInvalidateOperators();
  return useMutation<OperatorSkillRecord, SchedulerError, GrantSkillInput>({
    mutationFn: (input) => grantSkill(input),
    onSuccess: invalidate,
  });
}

export function useUpdateSkillExpiry() {
  const invalidate = useInvalidateOperators();
  return useMutation<
    OperatorSkillRecord,
    SchedulerError,
    { operatorId: string; skillId: string; expiresAt: string | null }
  >({
    mutationFn: (input) => updateSkillExpiry(input),
    onSuccess: invalidate,
  });
}

export function useRevokeSkill() {
  const invalidate = useInvalidateOperators();
  return useMutation<void, SchedulerError, { operatorId: string; skillId: string }>({
    mutationFn: (input) => revokeSkill(input),
    onSuccess: invalidate,
  });
}
