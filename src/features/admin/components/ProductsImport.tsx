/* ---------------------------------------------------------------------------
   ProductsImport — the products lane of the import wizard.

   Thin by design: it fetches what a products row is matched against (the
   catalogue) and resolved against (the plants), and hands the generic
   `ImportWizard` the products plan builder, the products apply mutation, and the
   products template. All the judgement lives in `../lib/productImport.ts`.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHierarchyTree, type AdminProduct, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useAdminProducts } from "../hooks/useProducts";
import { useProductImport } from "../hooks/useProductImport";
import type { CsvTable } from "../lib/csv";
import {
  detectColumns,
  planProductImport,
  productPlanToView,
  PRODUCT_FIELDS,
  PRODUCT_TEMPLATE,
  type ColumnMap,
} from "../lib/productImport";
import { readablePlants } from "../lib/plantFilter";
import { ImportWizard } from "./ImportWizard";

// ⚠️ THE ONE CAST, AND IT IS A TS INDEX-SIGNATURE LIMITATION, NOT A LIE. The
// wizard speaks the generic `Record<string, string | null>` (it serves every
// entity); `ColumnMap` is the products-specific shape with the SAME string|null
// values. The two are identical at runtime; TS just will not implicitly convert
// a fixed-key object to an index-signature type, so the seam casts once.
const asGeneric = (c: ColumnMap): Record<string, string | null> =>
  c as unknown as Record<string, string | null>;
const asColumnMap = (c: Record<string, string | null>): ColumnMap => c as unknown as ColumnMap;

export function ProductsImport() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const productsQuery = useAdminProducts(canQuery);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const importMutation = useProductImport();

  // Memoised so the `buildView`/`onApply` callbacks below are stable — otherwise
  // a fresh array every render defeats the wizard's preview memoisation.
  const existing = useMemo(
    () => (productsQuery.data ?? []).filter((p): p is AdminProduct => p !== null),
    [productsQuery.data],
  );
  const plants = useMemo(
    () => readablePlants(treeQuery.data?.nodes ?? []).map((p) => ({ id: p.id, name: p.name })),
    [treeQuery.data?.nodes],
  );
  const isCompanyAdmin = profile?.role === "admin";

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      productPlanToView(planProductImport(table, existing, asColumnMap(columns), plants)),
    [existing, plants],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>, source: string) => {
      if (profile === null) return;
      const plan = planProductImport(table, existing, asColumnMap(columns), plants);
      importMutation.mutate({ plan, ctx: { orgId: profile.orgId, source } });
    },
    [existing, plants, profile, importMutation],
  );

  return (
    <ImportWizard
      entityPlural="products"
      entityNoun="part"
      fields={PRODUCT_FIELDS}
      template={PRODUCT_TEMPLATE}
      templateFileName="products-import-template.csv"
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
      dataLoading={!canQuery || productsQuery.isLoading || treeQuery.isLoading}
      dataError={
        productsQuery.isError ? ((productsQuery.error as SchedulerError | null) ?? null) : null
      }
    />
  );
}
