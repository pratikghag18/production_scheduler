/* ---------------------------------------------------------------------------
   AbsencesImport — the absences lane of the import wizard (R-357).

   Thin, exactly like `OperatorsImport` and `CertificationsImport`: it fetches
   what a row is resolved against (the people, and the absences already recorded,
   to preview insert vs update) and hands the generic `ImportWizard` the absences
   plan builder, the apply mutation, and the absences template. All the judgement
   lives in `../lib/absenceImport.ts`; the writing is `import_absences`
   (`importAbsences` in `@/lib/api`), which gates each row on the person's place.

   ⚠️ NO COMPANY-ADMIN GATE. Unlike products/people, an absence may be recorded by
   a SUPERVISOR of the person's place, and `import_absences` gates each row on
   exactly that. So the wizard is offered to everyone who reaches this section and
   the server refuses the rows a given person may not touch, per row, into the
   `failed` list — rather than a blanket note.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAbsences,
  importAbsences,
  type AbsenceImportResult,
  type SchedulerError,
} from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useOperatorsAdmin } from "../hooks/useOperators";
import type { CsvTable } from "../lib/csv";
import {
  detectColumns,
  planAbsenceImport,
  planToImportRows,
  absencePlanToView,
  ABSENCE_FIELDS,
  ABSENCE_TEMPLATE,
  type ColumnMap,
} from "../lib/absenceImport";
import { ImportWizard } from "./ImportWizard";

const asGeneric = (c: ColumnMap): Record<string, string | null> =>
  c as unknown as Record<string, string | null>;
const asColumnMap = (c: Record<string, string | null>): ColumnMap => c as unknown as ColumnMap;

export const absenceKeys = { all: ["absences"] as const };

export function AbsencesImport() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const queryClient = useQueryClient();

  const operatorsQuery = useOperatorsAdmin(canQuery);
  const absencesQuery = useQuery({
    queryKey: [...absenceKeys.all, "admin"],
    queryFn: fetchAbsences,
    enabled: canQuery,
  });

  const importMutation = useMutation<
    AbsenceImportResult,
    SchedulerError,
    ReturnType<typeof planToImportRows>
  >({
    mutationFn: (rows) => importAbsences(rows),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: absenceKeys.all });
    },
  });

  const operators = useMemo(() => operatorsQuery.data?.operators ?? [], [operatorsQuery.data]);
  const absences = useMemo(() => absencesQuery.data?.absences ?? [], [absencesQuery.data]);

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      absencePlanToView(planAbsenceImport(table, operators, absences, asColumnMap(columns))),
    [operators, absences],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) => {
      const plan = planAbsenceImport(table, operators, absences, asColumnMap(columns));
      importMutation.mutate(planToImportRows(plan));
    },
    [operators, absences, importMutation],
  );

  return (
    <ImportWizard
      entityPlural="absences"
      entityNoun="absence"
      fields={ABSENCE_FIELDS}
      template={ABSENCE_TEMPLATE}
      templateFileName="absences-import-template.csv"
      detect={(keys) => asGeneric(detectColumns(keys))}
      buildView={buildView}
      canImport={profile !== null}
      onApply={onApply}
      applyState={{
        isPending: importMutation.isPending,
        isSuccess: importMutation.isSuccess,
        isError: importMutation.isError,
        error: (importMutation.error as SchedulerError | null) ?? null,
      }}
      applyResult={importMutation.data ?? null}
      onResetApply={() => importMutation.reset()}
      dataLoading={!canQuery || operatorsQuery.isLoading || absencesQuery.isLoading}
      dataError={
        operatorsQuery.isError ? ((operatorsQuery.error as SchedulerError | null) ?? null) : null
      }
    />
  );
}
