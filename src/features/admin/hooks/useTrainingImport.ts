/**
 * React Query hook over `applyTrainingImport` (`src/lib/api/imports.ts`), for the
 * import wizard's TRAININGS lane. Modelled on `useOperatorImport.ts`.
 *
 * ⭐ NO OPTIMISTIC UPDATE, and no retry. An import writes many rows and its
 * result is a per-row summary the wizard shows; replaying half of it on a
 * transient failure would double the trainings that had already landed. The
 * refetch `onSuccess` triggers is the honest source of the new trainings list.
 *
 * ⚠️ IT INVALIDATES `operatorKeys.all`, NOT `["board"]`. Trainings are read as
 * part of the operators-admin bundle (`fetchOperatorsAdmin` returns `.skills`),
 * so that is the key to refresh; adding a training type schedules nobody, so
 * there is no board cell to redraw.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyTrainingImport,
  type ImportContext,
  type ImportResult,
  type SchedulerError,
} from "@/lib/api";
import type { ImportPlan } from "../lib/trainingImport";
import { operatorKeys } from "./useOperators";

export interface TrainingImportVars {
  plan: ImportPlan;
  ctx: ImportContext;
}

export function useTrainingImport() {
  const queryClient = useQueryClient();

  return useMutation<ImportResult, SchedulerError, TrainingImportVars>({
    mutationFn: ({ plan, ctx }) => applyTrainingImport(plan, ctx),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operatorKeys.all });
    },
  });
}
