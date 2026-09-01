/* ---------------------------------------------------------------------------
   CertificationsImport — the training-records lane of the import wizard.

   A JOIN import: each row names a PERSON (by employee ref) and a TRAINING (by
   name) and records that the person holds it. So this container fetches the
   whole training world — operators, trainings, and who already holds what — plus
   the node tree (to check a training is on the person's own branch, the server's
   comparability rule). All the judgement is in `../lib/certificationImport.ts`.

   ⚠️ THE ADMIN GATE IS admin-anywhere, NOT company-admin-only. Recording that a
   person holds a training is an admin act on the PERSON'S branch (grantSkill /
   updateSkillRecord ask `app_is_admin_for_operator`), so a site admin may import
   their own people's certifications; per-row RLS refuses ones outside their
   scope, and those come back in the failures list.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHierarchyTree, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useOperatorsAdmin } from "../hooks/useOperators";
import { useCertificationImport } from "../hooks/useCertificationImport";
import type { CsvTable } from "../lib/csv";
import { scopeIndex } from "../lib/scope";
import {
  detectColumns,
  planCertificationImport,
  certificationPlanToView,
  CERTIFICATION_FIELDS,
  CERTIFICATION_TEMPLATE,
  type ColumnMap,
} from "../lib/certificationImport";
import { ImportWizard } from "./ImportWizard";

const asGeneric = (c: ColumnMap): Record<string, string | null> =>
  c as unknown as Record<string, string | null>;
const asColumnMap = (c: Record<string, string | null>): ColumnMap => c as unknown as ColumnMap;

export function CertificationsImport() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const operatorsQuery = useOperatorsAdmin(canQuery);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const importMutation = useCertificationImport();

  const data = useMemo(
    () => ({
      operators: operatorsQuery.data?.operators ?? [],
      skills: operatorsQuery.data?.skills ?? [],
      operatorSkills: operatorsQuery.data?.operatorSkills ?? [],
    }),
    [operatorsQuery.data],
  );
  // The node index carries `path`, which the comparability check needs.
  const nodesById = useMemo(() => scopeIndex(treeQuery.data?.nodes ?? []), [treeQuery.data?.nodes]);
  const canImport = profile?.role === "admin" || profile?.adminAnywhere === true;

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      certificationPlanToView(
        planCertificationImport(table, data, nodesById, asColumnMap(columns)),
      ),
    [data, nodesById],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>, source: string) => {
      if (profile === null) return;
      const plan = planCertificationImport(table, data, nodesById, asColumnMap(columns));
      importMutation.mutate({ plan, ctx: { orgId: profile.orgId, source } });
    },
    [data, nodesById, profile, importMutation],
  );

  return (
    <ImportWizard
      entityPlural="certifications"
      entityNoun="certification"
      fields={CERTIFICATION_FIELDS}
      template={CERTIFICATION_TEMPLATE}
      templateFileName="certifications-import-template.csv"
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
