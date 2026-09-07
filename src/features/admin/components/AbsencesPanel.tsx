/* ---------------------------------------------------------------------------
   AbsencesPanel — record and remove absences, for the people the reader can see
   in the chosen plant (R-357).

   TAKES NO PROPS and DECIDES NO PERMISSION. Like every admin panel it reads the
   plant filter off `usePlantFilter` and shows the people that filter admits; who
   may actually record or remove an absence is the SERVER's call (`set_absence` /
   `remove_absence`, gated on the person's place), and a refusal is shown here in
   words rather than pre-guessed. That is CLAUDE.md section 4's rule: a screen
   that offers what the server allows, and surfaces what it refuses.

   ⚠️ THE DATES ARE SHOWN IN THE CHOSEN PLANT'S FORMAT (R-333), via
   `useDateFormat(plant.choice)` — a plant root resolves its own override, All
   plants shows the company default. Fields are the shared field skin
   (Field.module.css, R-318); this module's CSS is layout only.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchAbsences,
  removeAbsence,
  setAbsence,
  type AbsenceRecord,
  type SchedulerError,
  type SetAbsenceInput,
} from "@/lib/api";
import { formatCalendarDay } from "@/lib/format/dates";
import fieldStyles from "@/components/Field.module.css";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useOperatorsAdmin } from "../hooks/useOperators";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { useDateFormat } from "../hooks/useOrgSettings";
import { rowsInPlant } from "../lib/plantFilter";
import { scopeIndex } from "../lib/scope";
import { absenceKeys } from "./AbsencesImport";
import styles from "./AbsencesPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const ABSENCES_PANEL_READY = true;

interface DraftState {
  operatorId: string;
  from: string;
  to: string;
  reason: string;
}

const EMPTY_DRAFT: DraftState = { operatorId: "", from: "", to: "", reason: "" };

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

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: absenceKeys.all });

  const addMutation = useMutation<AbsenceRecord, SchedulerError, SetAbsenceInput>({
    mutationFn: (input) => setAbsence(input),
    retry: false,
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      setFormError(null);
      invalidate();
    },
    onError: (err) => setFormError(describeSchedulerError(err)),
  });

  const removeMutation = useMutation<void, SchedulerError, string>({
    mutationFn: (id) => removeAbsence(id),
    retry: false,
    onSuccess: invalidate,
  });
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (draft.operatorId === "") return setFormError("Choose a person.");
    if (draft.from === "" || draft.to === "") return setFormError("Give a start and an end date.");
    if (draft.to < draft.from) return setFormError("The end date is before the start date.");
    if (draft.reason.trim() === "") return setFormError("Give a reason.");
    addMutation.mutate({
      operatorId: draft.operatorId,
      from: draft.from,
      to: draft.to,
      reason: draft.reason.trim(),
    });
  }

  function remove(id: string) {
    setRowError(null);
    removeMutation.mutate(id, {
      onError: (err) => setRowError({ id, message: describeSchedulerError(err) }),
    });
  }

  if (!canQuery || operatorsQuery.isLoading || absencesQuery.isLoading) {
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

      <form className={styles.addRow} onSubmit={submit} aria-label="Record an absence">
        <select
          className={fieldStyles.select}
          aria-label="Person"
          value={draft.operatorId}
          onChange={(e) => setDraft((d) => ({ ...d, operatorId: e.target.value }))}
        >
          <option value="">Choose a person…</option>
          {visiblePeople.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <input
          className={fieldStyles.field}
          type="date"
          aria-label="From"
          value={draft.from}
          onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
        />
        <input
          className={fieldStyles.field}
          type="date"
          aria-label="To"
          value={draft.to}
          onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
        />
        <input
          className={fieldStyles.field}
          type="text"
          aria-label="Reason"
          placeholder="Reason (e.g. Sick, Annual leave)"
          value={draft.reason}
          onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
        />
        <button className={fieldStyles.primaryBtn} type="submit" disabled={addMutation.isPending}>
          {addMutation.isPending ? "Recording…" : "Record absence"}
        </button>
      </form>
      {formError !== null && (
        <p className={styles.error} role="alert">
          {formError}
        </p>
      )}

      {rows.length === 0 ? (
        <p className={styles.muted}>No absences recorded for the people in view.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Person</th>
              <th>From</th>
              <th>To</th>
              <th>Reason</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{nameById.get(a.operatorId) ?? "—"}</td>
                <td>{formatCalendarDay(a.from, dateFormat)}</td>
                <td>{formatCalendarDay(a.to, dateFormat)}</td>
                <td>{a.reason}</td>
                <td className={styles.actions}>
                  <button
                    className={fieldStyles.btn}
                    type="button"
                    onClick={() => remove(a.id)}
                    disabled={removeMutation.isPending}
                  >
                    Remove
                  </button>
                  {rowError !== null && rowError.id === a.id && (
                    <span className={styles.error} role="alert">
                      {rowError.message}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
