/**
 * React Query hook over `applyCertificationImport` (`src/lib/api/imports.ts`),
 * for the certifications import lane. Mirrors `useOperatorImport`: no retry, no
 * optimistic update — an import writes many rows and its result is a per-row
 * summary, so replaying half of it would double the grants that already landed.
 * Invalidates the operators world (operators + skills + operator_skills) so the
 * new certifications appear on the Operators and Trainings screens.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyCertificationImport, type ImportContext, type ImportResult } from "@/lib/api";
import type { SchedulerError } from "@/lib/api";
import type { ImportPlan } from "../lib/certificationImport";
import { operatorKeys } from "./useOperators";

export interface CertificationImportVars {
  plan: ImportPlan;
  ctx: ImportContext;
}

export function useCertificationImport() {
  const queryClient = useQueryClient();

  return useMutation<ImportResult, SchedulerError, CertificationImportVars>({
    mutationFn: ({ plan, ctx }) => applyCertificationImport(plan, ctx),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operatorKeys.all });
    },
  });
}
