/* ---------------------------------------------------------------------------
   OperatorsImport — the people lane of the import wizard.

   Thin by design, exactly like `ProductsImport`: it fetches what a people row is
   matched against (the existing operators) and resolved against (the plants), and
   hands the generic `ImportWizard` the operators plan builder, the operators apply
   mutation, and the operators template. All the judgement lives in
   `../lib/operatorImport.ts`.

   ⚠️ THE ADMIN GATE IS COMPANY-ADMIN, FOR PARITY WITH PRODUCTS. The operators
   insert policy is company-admin OR site-admin (0023), so a site admin's insert
   would be refused server-side; the wizard keeps the gate at company-admin so a
   site admin sees the "only a company admin can import people" note rather than
   pressing Apply and getting a wall of `WriteRefused` rows.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHierarchyTree, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useOperatorsAdmin } from "../hooks/useOperators";
import { useOperatorImport } from "../hooks/useOperatorImport";
import type { CsvTable } from "../lib/csv";
import {
  detectColumns,
  planOperatorImport,
  operatorPlanToView,
  OPERATOR_FIELDS,
  OPERATOR_TEMPLATE,
  type ColumnMap,
} from "../lib/operatorImport";
import { readablePlants } from "../lib/plantFilter";
import { ImportWizard } from "./ImportWizard";

// ⚠️ THE ONE CAST, AND IT IS A TS INDEX-SIGNATURE LIMITATION, NOT A LIE. The
// wizard speaks the generic `Record<string, string | null>` (it serves every
// entity); `ColumnMap` is the operators-specific shape with the SAME string|null
// values. The two are identical at runtime; TS just will not implicitly convert
// a fixed-key object to an index-signature type, so the seam casts once.
const asGeneric = (c: ColumnMap): Record<string, string | null> =>
  c as unknown as Record<string, string | null>;
const asColumnMap = (c: Record<string, string | null>): ColumnMap => c as unknown as ColumnMap;

export function OperatorsImport() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const operatorsQuery = useOperatorsAdmin(canQuery);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const importMutation = useOperatorImport();

  // Memoised so the callbacks below stay stable — see ProductsImport.
  const existing = useMemo(() => operatorsQuery.data?.operators ?? [], [operatorsQuery.data]);
  const plants = useMemo(
    () => readablePlants(treeQuery.data?.nodes ?? []).map((p) => ({ id: p.id, name: p.name })),
    [treeQuery.data?.nodes],
  );
  const isCompanyAdmin = profile?.role === "admin";

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      operatorPlanToView(planOperatorImport(table, existing, asColumnMap(columns), plants)),
    [existing, plants],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>, source: string) => {
      if (profile === null) return;
      const plan = planOperatorImport(table, existing, asColumnMap(columns), plants);
      importMutation.mutate({ plan, ctx: { orgId: profile.orgId, source } });
    },
    [existing, plants, profile, importMutation],
  );

  return (
    <ImportWizard
      entityPlural="people"
      entityNoun="person"
      fields={OPERATOR_FIELDS}
      template={OPERATOR_TEMPLATE}
      templateFileName="people-import-template.csv"
      detect={(keys) => asGeneric(detectColumns(keys))}
      buildView={buildView}
      canImport={isCompanyAdmin}
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
