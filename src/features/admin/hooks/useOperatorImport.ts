/**
 * React Query hook over `applyOperatorImport` (`src/lib/api/imports.ts`), for the
 * import wizard's people lane. Modelled on `useProductImport.ts`.
 *
 * ⭐ NO OPTIMISTIC UPDATE, and no retry. An import writes many rows and its
 * result is a per-row summary the wizard shows; replaying half of it on a
 * transient failure would double the people that had already landed. The refetch
 * `onSuccess` triggers is the honest source of the new people list.
 *
 * ⚠️ IT INVALIDATES `operatorKeys.all`, NOT `["board"]`. A product import
 * assigns plants, which changes where a part is offered on the board; importing
 * a person adds or renames them but schedules nobody, so there is no board cell
 * to redraw — only the operators list.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyOperatorImport,
  type ImportContext,
  type ImportResult,
  type SchedulerError,
} from "@/lib/api";
import type { ImportPlan } from "../lib/operatorImport";
import { operatorKeys } from "./useOperators";

export interface OperatorImportVars {
  plan: ImportPlan;
  ctx: ImportContext;
}

export function useOperatorImport() {
  const queryClient = useQueryClient();

  return useMutation<ImportResult, SchedulerError, OperatorImportVars>({
    mutationFn: ({ plan, ctx }) => applyOperatorImport(plan, ctx),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operatorKeys.all });
    },
  });
}
