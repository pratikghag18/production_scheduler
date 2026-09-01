/**
 * React Query hook over `applyProductImport` (`src/lib/api/imports.ts`), for the
 * import wizard. Modelled on `useProducts.ts`.
 *
 * ⭐ NO OPTIMISTIC UPDATE, and no retry. An import writes many rows and its
 * result is a per-row summary the wizard shows; replaying half of it on a
 * transient failure would double the rows that had already landed. The refetch
 * `onSuccess` triggers is the honest source of the new catalogue, and the board
 * is invalidated too because assigning a plant changes where a part is offered.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  applyProductImport,
  type ImportContext,
  type ImportResult,
  type SchedulerError,
} from "@/lib/api";
import type { ImportPlan } from "../lib/productImport";
import { productKeys } from "./useProducts";

export interface ProductImportVars {
  plan: ImportPlan;
  ctx: ImportContext;
}

export function useProductImport() {
  const queryClient = useQueryClient();

  return useMutation<ImportResult, SchedulerError, ProductImportVars>({
    mutationFn: ({ plan, ctx }) => applyProductImport(plan, ctx),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
}
