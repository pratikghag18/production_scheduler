/* ---------------------------------------------------------------------------
   TrainingsImport — the trainings-catalogue lane of the import wizard.

   Thin by design, exactly like `OperatorsImport`: it fetches what a training row
   is matched against (the existing trainings, `useOperatorsAdmin().skills`) and
   resolved against (the plants), and hands the generic `ImportWizard` the
   trainings plan builder, the trainings apply mutation, and the trainings
   template. All the judgement lives in `../lib/trainingImport.ts`.

   ⚠️ THE ADMIN GATE IS SITE-OR-COMPANY ADMIN, NOT COMPANY-ADMIN-ONLY. Creating a
   training is `skills_insert = app_is_admin() OR app_is_admin_for(owner)`, so a
   SITE admin may import trainings for their own plant. The gate therefore lets a
   company admin (`role === "admin"`) OR anyone who is an admin somewhere
   (`adminAnywhere === true`) in; per-row RLS still refuses a training whose plant
   is outside the reader's scope, surfaced as a failed row.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHierarchyTree, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useOperatorsAdmin } from "../hooks/useOperators";
import { useTrainingImport } from "../hooks/useTrainingImport";
import type { CsvTable } from "../lib/csv";
import {
  detectColumns,
  planTrainingImport,
  trainingPlanToView,
  TRAINING_FIELDS,
  TRAINING_TEMPLATE,
  type ColumnMap,
} from "../lib/trainingImport";
import { readablePlants } from "../lib/plantFilter";
import { ImportWizard } from "./ImportWizard";

// ⚠️ THE ONE CAST, A TS INDEX-SIGNATURE LIMITATION, NOT A LIE — same seam as
// OperatorsImport. The wizard speaks the generic `Record<string, string | null>`;
// `ColumnMap` is the trainings-specific shape with the SAME string|null values.
const asGeneric = (c: ColumnMap): Record<string, string | null> =>
  c as unknown as Record<string, string | null>;
const asColumnMap = (c: Record<string, string | null>): ColumnMap => c as unknown as ColumnMap;

export function TrainingsImport() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const operatorsQuery = useOperatorsAdmin(canQuery);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const importMutation = useTrainingImport();

  // Memoised so the callbacks below stay stable — see OperatorsImport.
  const existing = useMemo(() => operatorsQuery.data?.skills ?? [], [operatorsQuery.data]);
  const plants = useMemo(
    () => readablePlants(treeQuery.data?.nodes ?? []).map((p) => ({ id: p.id, name: p.name })),
    [treeQuery.data?.nodes],
  );
  // A site admin may import trainings for their own plant (skills_insert allows
  // app_is_admin_for(owner)), so the gate is company-admin OR admin-anywhere.
  const canImport = profile?.role === "admin" || profile?.adminAnywhere === true;

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      trainingPlanToView(planTrainingImport(table, existing, asColumnMap(columns), plants)),
    [existing, plants],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>, source: string) => {
      if (profile === null) return;
      const plan = planTrainingImport(table, existing, asColumnMap(columns), plants);
      importMutation.mutate({ plan, ctx: { orgId: profile.orgId, source } });
    },
    [existing, plants, profile, importMutation],
  );

  return (
    <ImportWizard
      entityPlural="trainings"
      entityNoun="training"
      fields={TRAINING_FIELDS}
      template={TRAINING_TEMPLATE}
      templateFileName="trainings-import-template.csv"
      detect={(keys) => asGeneric(detectColumns(keys))}
      buildView={buildView}
      canImport={canImport}
      onApply={onApply}
      applyState={{
        isPending: importMutation.isPending,
        isSuccess: importMutation.isSuccess,
        isError: importMutation.isError,
        error: (importMutation.error as SchedulerError | null) ?? null,
      }}
      applyResult={importMutation.data ?? null}
      onResetApply={() => importMutation.reset()}
      dataLoading={!canQuery || operatorsQuery.isLoading || treeQuery.isLoading}
      dataError={
        operatorsQuery.isError ? ((operatorsQuery.error as SchedulerError | null) ?? null) : null
      }
    />
  );
}
