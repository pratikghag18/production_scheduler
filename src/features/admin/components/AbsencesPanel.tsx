/* ---------------------------------------------------------------------------
   AbsencesPanel — record and remove absences, whole-day or part-day, for the
   people the reader can see in the chosen plant (R-357, R-359).

   TAKES NO PROPS. Like every admin panel it reads the plant filter off
   `usePlantFilter` and shows every person that filter admits in the absences
   TABLE — reading is wider than writing, by design, and the table narrows
   nothing.

   ⭐⭐ DEF-0035 / R-431 — THE PERSON LIST ON THE CREATE FORM IS THE SERVER'S
   OWN ANSWER. This panel used to offer every visible person, on the theory
   that the server's refusal was guard enough; the tester found a Line 1
   supervisor offered five of Plant A's six and refused `not_permitted` on
   four (`set_absence` / `remove_absence` gate on
   `app_can_edit_node(coalesce(home_node_id, site_node_id))`, the person's
   PLACE). Session 182 then mirrored that gate on the client with
   `canEditNode` over the person's home node, and the tester REOPENED it the
   same day: she can READ the people owned at the plant above her, but not
   the cells on other lines they are homed at, so the client held no path for
   four of six and the preview failed open, as its own rule says it must. A
   gate on a node the caller cannot see is not one a client can transcribe.

   So the form asks: `fetchRecordableAbsencePeople()` is migration 0084's
   `absence_recordable_people()`, SECURITY DEFINER, running the SAME
   expression `set_absence` gates on and returning the ids the writer would
   accept; the Person `<select>` offers `visiblePeople` intersected with that
   set, and nothing else (R-431, CLAUDE.md section 4's "the server's rule,
   transcribed" — here, the server's rule, ASKED). 88_absences_test.sql AB35
   holds the function to `set_absence` person by person.

   ⚠️ NO FAIL-OPEN HERE, BECAUSE THERE IS NOTHING TO GUESS. While the read is
   pending the whole panel says Loading (this file's own header above: reading
   is wider than writing, but there is nothing yet to read either). If it
   FAILS, though, reading is still wider than writing — the table of absences
   the caller can already see is not this query's business, so it stays; only
   the create form (which needs the server's answer to know who it may offer)
   is withheld, in its own slot, with the error in words there. A row's Remove
   is gated on `recordableIds`, below, which is empty whenever this query has
   no data (pending or failed) — fail closed either way, never a guess. A
   refusal the server still raises after the click (an overlap, a grant
   changed since the read) is worded by the form's own `addMutation.onError`
   — see `AbsenceForm.tsx` — or, for Remove, by this file's own
   `removeErrorMessage` below.

   ⚠️ THE DATES ARE SHOWN IN THE CHOSEN PLANT'S FORMAT (R-333), via
   `useDateFormat(plant.choice)` — a plant root resolves its own override, All
   plants shows the company default. Fields are the shared field skin
   (Field.module.css, R-318); this module's CSS is layout only.

   ⭐ R-359 — A PART-DAY WINDOW IS CONVERTED IN THE PERSON'S OWN PLANT ZONE, NOT
   THE READER'S PLANT FILTER (decision 4). Recording one resolves the CHOSEN
   PERSON's zone (`AbsenceForm.tsx`, off the `siteNodeId` this panel carries on
   every `recordablePeople` entry) and converts with `zonedTimeToInstant`; the
   table, which can show several people's rows from different plants at once,
   resolves each PART-DAY row's own person's zone the same way (`useQueries`,
   one query per distinct place actually needed — a whole-day row needs no
   zone at all). Neither path infers a zone from the plant filter, because two
   different people's hours would silently read as the wrong plant's the day
   this screen shows more than one.

   ⭐⭐ S70-a / R-360 amended, R-449 — THE CREATE FORM ITSELF IS `AbsenceForm.tsx`,
   mounted here AND on the person's own record in the Operators tab
   (`OperatorAbsences.tsx`, the person fixed) — one component, two entry
   points, so a form fix or a field change lands on both screens at once. This
   panel keeps the recordable read, its Loading gate and its error alert (this
   file, above) because `DEF-0035-reopen.test.ts` greps THIS file's own source
   for `fetchRecordableAbsencePeople` and `recordableIds.has(p.id)` — moving
   that read into the form would have made the pin blind to a regression here.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchAbsences,
  fetchNodeSetting,
  fetchRecordableAbsencePeople,
  removeAbsence,
  type SchedulerError,
} from "@/lib/api";
import { formatCalendarDay } from "@/lib/format/dates";
import { coerceTimezone } from "@/lib/format/timezones";
import { formatClock } from "@/features/board/lib/time";
import fieldStyles from "@/components/Field.module.css";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useOperatorsAdmin } from "../hooks/useOperators";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { useDateFormat } from "../hooks/useOrgSettings";
import { rowsInPlant } from "../lib/plantFilter";
import { scopeIndex } from "../lib/scope";
import { absenceKeys } from "./AbsencesImport";
import { AbsenceForm } from "./AbsenceForm";
import styles from "./AbsencesPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const ABSENCES_PANEL_READY = true;

// DEF-0037 / R-431, R-449: the same rule OperatorAbsences.tsx keeps (its own
// copy of this function) — a refusal the server still raises on Remove (a
// stale page; the button below is hidden once a row's person is known not
// recordable, so this only fires on a race) is worded for THIS screen, not
// with describeSchedulerError's NotPermitted sentence ("You do not have edit
// rights on this cell."), which names a cell this screen has none of.
function removeErrorMessage(err: SchedulerError): string {
  if (err.kind === "NotPermitted") {
    return "You cannot remove an absence for this person from here.";
  }
  return describeSchedulerError(err);
}

export function AbsencesPanel() {
  const { session, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const queryClient = useQueryClient();

  const operatorsQuery = useOperatorsAdmin(canQuery);
  const absencesQuery = useQuery({
    queryKey: [...absenceKeys.all, "admin"],
    queryFn: fetchAbsences,
    enabled: canQuery,
  });
  // DEF-0035 / R-431: the people `set_absence` would accept, BY THE SERVER'S
  // ANSWER (0084). Under `absenceKeys.all` so every write's `invalidate`
  // refreshes it with the rows.
  const recordableQuery = useQuery<string[], SchedulerError>({
    queryKey: [...absenceKeys.all, "recordable"],
    queryFn: fetchRecordableAbsencePeople,
    enabled: canQuery,
  });

  const nodes = useMemo(() => operatorsQuery.data?.nodes ?? [], [operatorsQuery.data]);
  const operators = useMemo(() => operatorsQuery.data?.operators ?? [], [operatorsQuery.data]);
  const absences = useMemo(() => absencesQuery.data?.absences ?? [], [absencesQuery.data]);
  const plant = usePlantFilter(nodes);
  const dateFormat = useDateFormat(canQuery, plant.choice);

  const nodesById = useMemo(() => scopeIndex(nodes), [nodes]);
  const visiblePeople = useMemo(
    () => rowsInPlant(operators, plant.choice, plant.plants, nodesById),
    [operators, plant.choice, plant.plants, nodesById],
  );
  // DEF-0035 / R-431: the create form's Person list is `visiblePeople`
  // intersected with the server's own answer — no client predicate. The
  // absences TABLE keeps reading `visiblePeople` untouched; only the form
  // narrows.
  const recordableIds = useMemo(() => new Set(recordableQuery.data ?? []), [recordableQuery.data]);
  const recordablePeople = useMemo(
    () => visiblePeople.filter((p) => recordableIds.has(p.id)),
    [visiblePeople, recordableIds],
  );
  const nameById = useMemo(
    () => new Map(operators.map((o) => [o.id, o.displayName] as const)),
    [operators],
  );
  const visibleIds = useMemo(() => new Set(visiblePeople.map((p) => p.id)), [visiblePeople]);

  // Absences for the people in view, earliest first.
  const rows = useMemo(
    () =>
      absences
        .filter((a) => visibleIds.has(a.operatorId))
        .slice()
        .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0)),
    [absences, visibleIds],
  );

  // R-359: each PART-DAY row's own person's zone, resolved per distinct place
  // actually needed (a whole-day row needs none) — never the plant filter,
  // because two people's rows can belong to two different plants at once.
  const siteNodeIdByOperator = useMemo(
    () => new Map(operators.map((o) => [o.id, o.siteNodeId] as const)),
    [operators],
  );
  const partDayNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of rows) {
      if (a.startsAt === undefined) continue;
      const nodeId = siteNodeIdByOperator.get(a.operatorId);
      if (nodeId !== undefined) set.add(nodeId);
    }
    return [...set];
  }, [rows, siteNodeIdByOperator]);
  const rowZoneQueries = useQueries({
    queries: partDayNodeIds.map((nodeId) => ({
      queryKey: ["node-setting", nodeId, "timezone"],
      queryFn: () => fetchNodeSetting(nodeId, "timezone"),
      enabled: canQuery,
    })),
  });
  const zoneByNodeId = useMemo(() => {
    const m = new Map<string, string>();
    partDayNodeIds.forEach((nodeId, i) => {
      m.set(nodeId, coerceTimezone(rowZoneQueries[i]?.data ?? undefined));
    });
    return m;
  }, [partDayNodeIds, rowZoneQueries]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: absenceKeys.all });

  const removeMutation = useMutation<void, SchedulerError, string>({
    mutationFn: (id) => removeAbsence(id),
    retry: false,
    onSuccess: invalidate,
  });
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  function remove(id: string) {
    setRowError(null);
    removeMutation.mutate(id, {
      onError: (err) => setRowError({ id, message: removeErrorMessage(err) }),
    });
  }

  if (
    !canQuery ||
    operatorsQuery.isLoading ||
    absencesQuery.isLoading ||
    recordableQuery.isLoading
  ) {
    return <p className={styles.muted}>Loading…</p>;
  }
  if (operatorsQuery.isError) {
    return (
      <p className={styles.error} role="alert">
        {describeSchedulerError(operatorsQuery.error as SchedulerError)}
      </p>
    );
  }

  return (
    <div className={styles.panel}>
      {plant.visible && (
        <p className={styles.scope}>
          Showing <strong>{plant.label}</strong>.
        </p>
      )}

      {/* DEF-0037 (reviewer, S194-A follow-up): the table below is a READ,
          and reading is wider than writing (this file's own header) — a
          failed `recordableQuery` says nothing about who may be SEEN, only
          who may be recorded for or removed, so it withholds only the form,
          in its own slot, exactly as `OperatorAbsences.tsx` already does for
          its fixed-person form. The table keeps rendering below either way. */}
      {recordableQuery.isError ? (
        <p className={styles.error} role="alert">
          {describeSchedulerError(recordableQuery.error)}
        </p>
      ) : (
        /* S70-a / R-360 amended, R-449: the one absence form, shared with
           OperatorAbsences.tsx's fixed-person mount — see AbsenceForm.tsx's
           header. `recordablePeople` is DEF-0035's server-answer intersection,
           computed above; this component adds no predicate of its own. */
        <AbsenceForm ariaLabel="Record an absence" people={recordablePeople} canQuery={canQuery} />
      )}

      {rows.length === 0 ? (
        <p className={styles.muted}>No absences recorded for the people in view.</p>
      ) : (
        /* ⭐ FROZEN HEADER (docs/conventions.md "Frozen table headers", R-372).
           The list of absences can run long; it scrolls WITHIN this bounded box
           so the column header (`.th`, sticky) stays put instead of leaving
           with the page. Same standard as Activity, which this panel — with no
           `.card` of its own — otherwise matches most closely. */
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Person</th>
                <th className={styles.th}>From</th>
                <th className={styles.th}>To</th>
                <th className={styles.th}>Hours</th>
                <th className={styles.th}>Reason</th>
                <th className={styles.th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                // R-359: a part-day row's own person's zone — never the plant
                // filter (decision 4) — resolved above per distinct place needed.
                const zone =
                  a.startsAt !== undefined
                    ? (zoneByNodeId.get(siteNodeIdByOperator.get(a.operatorId) ?? "") ?? null)
                    : null;
                return (
                  <tr key={a.id}>
                    <td>{nameById.get(a.operatorId) ?? "—"}</td>
                    <td>{formatCalendarDay(a.from, dateFormat)}</td>
                    <td>{formatCalendarDay(a.to, dateFormat)}</td>
                    <td>
                      {a.startsAt !== undefined && a.endsAt !== undefined && zone !== null
                        ? `${formatClock(new Date(a.startsAt), zone)}–${formatClock(new Date(a.endsAt), zone)} (${zone})`
                        : "—"}
                    </td>
                    <td>{a.reason}</td>
                    <td className={styles.actions}>
                      {/* DEF-0037 / R-431, R-449: `remove_absence` refuses
                          the same set `set_absence` does — `recordableIds`,
                          the server's own answer, already computed above for
                          the create form's Person list. This table is not
                          gated by that set (reading stays wider than writing,
                          by design, per this file's header); only Remove is.
                          The Actions column's width is set by the widest row
                          (R-447): a row with no Remove does not narrow it, as
                          long as some row keeps one. */}
                      {recordableIds.has(a.operatorId) && (
                        <button
                          className={fieldStyles.btn}
                          type="button"
                          onClick={() => remove(a.id)}
                          disabled={removeMutation.isPending}
                        >
                          Remove
                        </button>
                      )}
                      {rowError !== null && rowError.id === a.id && (
                        <span className={styles.error} role="alert">
                          {rowError.message}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
