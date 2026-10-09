/* ---------------------------------------------------------------------------
   AbsencesImport — the absences lane of the import wizard (R-357).

   Thin, exactly like `OperatorsImport` and `CertificationsImport`: it fetches
   what a row is resolved against (the people, and the absences already recorded,
   to preview insert vs update) and hands the generic `ImportWizard` the absences
   plan builder, the apply mutation, and the absences template. All the judgement
   lives in `../lib/absenceImport.ts`; the writing is `import_absences`
   (`importAbsences` in `@/lib/api`), which gates each row on the person's place.

   ⭐⭐ R-359 — THE TIME COLUMNS, AND WHOSE CLOCK THEY ARE READ IN. The sheet may
   carry "From time"/"To time" for an absence that is only part of a day. A
   wall-clock reading is not a time until you know whose clock it is, and the
   answer is the ABSENT PERSON'S OWN PLANT (decision 4) — not the reader's plant
   filter, and not one zone for the whole file, because a sheet from HR routinely
   mixes plants and reading Ana's 09:00 on somebody else's clock shifts her
   absence by the offset between them.

   So this fetches the timezone of every plant its people are homed at, up front
   (a handful of tiny per-node settings reads, the same `fetchNodeSetting` the
   by-hand panel uses), and hands the planner a `zoneFor` that answers per
   person. A plant whose zone has not arrived yet answers null, and the planner
   turns THAT row into an error rather than guessing — see its own header.

   ⚠️ AND THE SCREEN SAYS WHICH CLOCK, because a mapping control cannot. The note
   under the column mapping names the zone when every person's plant agrees, and
   says "each person's own plant" when they do not.

   ⚠️ NO COMPANY-ADMIN GATE. Unlike products/people, an absence may be recorded by
   a SUPERVISOR of the person's place, and `import_absences` gates each row on
   exactly that. So the wizard is offered to everyone who reaches this section and
   the server refuses the rows a given person may not touch, per row, into the
   `failed` list — rather than a blanket note.
   --------------------------------------------------------------------------- */
import { useCallback, useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAbsences,
  fetchNodeSetting,
  importAbsences,
  type AbsenceImportResult,
  type OperatorRecord,
  type SchedulerError,
} from "@/lib/api";
import { coerceTimezone, timezoneLabel } from "@/lib/format/timezones";
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

  // R-359. The distinct plants these people are homed at -- a handful, however
  // many people the sheet names, because a zone is a property of the PLANT.
  const siteNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of operators) if (o.siteNodeId !== null) set.add(o.siteNodeId);
    return [...set].sort();
  }, [operators]);

  const zoneQueries = useQueries({
    queries: siteNodeIds.map((nodeId) => ({
      // The same key the panel uses, so the two share one cache entry per plant
      // rather than each fetching its own copy.
      queryKey: ["node-setting", nodeId, "timezone"],
      queryFn: () => fetchNodeSetting(nodeId, "timezone"),
      enabled: canQuery,
    })),
  });

  /** Plant -> its IANA zone, only once that plant's read has landed. */
  const zoneByNodeId = useMemo(() => {
    const m = new Map<string, string>();
    siteNodeIds.forEach((nodeId, i) => {
      const q = zoneQueries[i];
      // ⛔ ONLY A SETTLED SUCCESS COUNTS. `coerceTimezone(undefined)` answers the
      // default zone, so treating a still-loading read as an answer would place
      // every part-day row at UTC and look entirely normal. A plant that has not
      // answered is ABSENT from this map, and an absent plant makes its rows
      // errors rather than silently-wrong absences.
      if (q?.isSuccess === true) m.set(nodeId, coerceTimezone(q.data ?? undefined));
    });
    return m;
  }, [siteNodeIds, zoneQueries]);

  const zoneFor = useCallback(
    (op: OperatorRecord): string | null =>
      op.siteNodeId === null ? null : (zoneByNodeId.get(op.siteNodeId) ?? null),
    [zoneByNodeId],
  );

  /** What the screen says the time columns are read in. */
  const mappingNote = useMemo(() => {
    const distinct = [...new Set(zoneByNodeId.values())];
    if (distinct.length === 0) return null;
    const where =
      distinct.length === 1
        ? timezoneLabel(distinct[0])
        : "each person's own plant, so the same time can mean different moments on different rows";
    return `Times in “From time” and “To time” are read on the clock of ${where}. Leave both blank to record a whole day.`;
  }, [zoneByNodeId]);

  const buildView = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) =>
      absencePlanToView(
        planAbsenceImport(table, operators, absences, asColumnMap(columns), zoneFor),
      ),
    [operators, absences, zoneFor],
  );

  const onApply = useCallback(
    (table: CsvTable, columns: Record<string, string | null>) => {
      const plan = planAbsenceImport(table, operators, absences, asColumnMap(columns), zoneFor);
      importMutation.mutate(planToImportRows(plan));
    },
    [operators, absences, zoneFor, importMutation],
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
      mappingNote={mappingNote}
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
