/* ---------------------------------------------------------------------------
   AbsencesPanel — record and remove absences, whole-day or part-day, for the
   people the reader can see in the chosen plant (R-357, R-359).

   TAKES NO PROPS. Like every admin panel it reads the plant filter off
   `usePlantFilter` and shows every person that filter admits in the absences
   TABLE — reading is wider than writing, by design, and the table narrows
   nothing.

   ⭐⭐ DEF-0035 / R-431 — THE PERSON LIST ON THE CREATE FORM IS DECIDED BY THE
   SAME PREDICATE `set_absence` RUNS, NOT A GUESS. This panel used to offer
   every visible person, on the theory that the server's own refusal was
   enough of a guard (CLAUDE.md section 4's other half — "surfaces what it
   refuses"). The tester found the gap the theory missed: `set_absence` /
   `remove_absence` gate on `app_can_edit_node(coalesce(home_node_id,
   site_node_id))` — a supervisor or admin OF THE PERSON'S PLACE — and a Line 1
   supervisor was offered five of Plant A's six people only to be refused
   `not_permitted` on four of them. R-431 is the standing rule this breaks:
   "nothing offered that the server refuses". The fix filters rather than
   guesses: `useEditRights(canQuery, profile?.role ?? null)` gives `canEdit`,
   the same `canEditNode` preview `TrainingsPanel` mirrors the server with, and
   the Person `<select>` offers only `visiblePeople` for whom
   `canEdit(nodesById.get(person.homeNodeId ?? person.siteNodeId)?.path ??
   null)` — the SAME coalesce order `set_absence` uses.

   ⚠️ IT STILL FAILS OPEN, AND A REFUSAL IS STILL SHOWN IN WORDS. `canEditNode`
   answers TRUE whenever the grant read has not landed, has failed, or the
   owner cannot be resolved to a path (`editRights.ts`'s header) — this is a
   PREVIEW, not the authority, and the database is right if the two ever
   disagree. So the fail-open case still offers a person the server may go on
   to refuse, and `addMutation.onError -> setFormError` still surfaces that
   refusal exactly as before; this narrows what is OFFERED, it does not retire
   the sentence that answers for what is REFUSED.

   ⚠️ THE DATES ARE SHOWN IN THE CHOSEN PLANT'S FORMAT (R-333), via
   `useDateFormat(plant.choice)` — a plant root resolves its own override, All
   plants shows the company default. Fields are the shared field skin
   (Field.module.css, R-318); this module's CSS is layout only.

   ⭐ R-359 — A PART-DAY WINDOW IS CONVERTED IN THE PERSON'S OWN PLANT ZONE, NOT
   THE READER'S PLANT FILTER (decision 4). Recording one resolves the CHOSEN
   PERSON's zone (`fetchNodeSetting(operator.siteNodeId, "timezone")`) and
   converts with `zonedTimeToInstant`; the table, which can show several
   people's rows from different plants at once, resolves each PART-DAY row's
   own person's zone the same way (`useQueries`, one query per distinct place
   actually needed — a whole-day row needs no zone at all). Neither path infers
   a zone from the plant filter, because two different people's hours would
   silently read as the wrong plant's the day this screen shows more than one.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchAbsences,
  fetchNodeSetting,
  removeAbsence,
  setAbsence,
  type AbsenceRecord,
  type SchedulerError,
  type SetAbsenceInput,
} from "@/lib/api";
import { formatCalendarDay } from "@/lib/format/dates";
import { coerceTimezone } from "@/lib/format/timezones";
import { formatClock, zonedTimeToInstant } from "@/features/board/lib/time";
import fieldStyles from "@/components/Field.module.css";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useEditRights } from "../hooks/useEditRights";
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
  /** R-359: "Part of a day" — swaps the two date inputs for one date plus a
   *  start and an end clock time. Whole-day (`false`) is the default. */
  partOfDay: boolean;
  startTime: string;
  endTime: string;
}

const EMPTY_DRAFT: DraftState = {
  operatorId: "",
  from: "",
  to: "",
  reason: "",
  partOfDay: false,
  startTime: "",
  endTime: "",
};

/** `"YYYY-MM-DD"` -> its three numbers, or `null` — never a naive `Date` parse. */
function parseYmd(s: string): { y: number; mo: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m === null ? null : { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/** `<input type="time">`'s `"HH:MM"` -> its two numbers, or `null`. */
function parseHm(s: string): { h: number; mi: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return m === null ? null : { h: Number(m[1]), mi: Number(m[2]) };
}

export function AbsencesPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const queryClient = useQueryClient();

  // DEF-0035 / R-431: the same preview `TrainingsPanel` uses, so the Person
  // list below can be filtered by the SAME predicate `set_absence` runs.
  const { canEdit } = useEditRights(canQuery, profile?.role ?? null);

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
  // DEF-0035 / R-431: the create form's Person list, narrowed from
  // `visiblePeople` to the people `set_absence` would actually accept.
  // `person.homeNodeId ?? person.siteNodeId` is the SAME coalesce order the
  // server's own `coalesce(home_node_id, site_node_id)` uses — never the
  // owner alone and never re-ordered. The absences TABLE keeps reading
  // `visiblePeople` untouched; only the create form narrows.
  const recordablePeople = useMemo(
    () =>
      visiblePeople.filter((p) =>
        canEdit(nodesById.get(p.homeNodeId ?? p.siteNodeId)?.path ?? null),
      ),
    [visiblePeople, nodesById, canEdit],
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

  // R-359: the chosen person's OWN plant zone (decision 4, not the plant
  // filter) — resolved only while the checkbox is on and somebody is chosen,
  // so a whole-day entry never fires this query at all.
  const draftOperator = useMemo(
    () => operators.find((o) => o.id === draft.operatorId) ?? null,
    [operators, draft.operatorId],
  );
  const draftZoneQuery = useQuery({
    queryKey: ["node-setting", draftOperator?.siteNodeId ?? null, "timezone"],
    queryFn: () =>
      fetchNodeSetting((draftOperator as { siteNodeId: string }).siteNodeId, "timezone"),
    enabled: canQuery && draft.partOfDay && draftOperator !== null,
  });
  const draftZone = coerceTimezone(draftZoneQuery.data ?? undefined);

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
    if (draft.reason.trim() === "") return setFormError("Give a reason.");

    if (draft.partOfDay) {
      if (draft.from === "" || draft.startTime === "" || draft.endTime === "") {
        return setFormError("Give a date and a start and end time.");
      }
      if (draft.endTime <= draft.startTime) {
        return setFormError("The end time is not after the start time.");
      }
      if (draftZoneQuery.isLoading) {
        return setFormError("Still finding this person's time zone — try again in a moment.");
      }
      const ymd = parseYmd(draft.from);
      const st = parseHm(draft.startTime);
      const et = parseHm(draft.endTime);
      if (ymd === null || st === null || et === null) {
        return setFormError("Give a valid date and times.");
      }
      const startsAt = zonedTimeToInstant(
        draftZone,
        ymd.y,
        ymd.mo,
        ymd.d,
        st.h,
        st.mi,
      ).toISOString();
      const endsAt = zonedTimeToInstant(draftZone, ymd.y, ymd.mo, ymd.d, et.h, et.mi).toISOString();
      addMutation.mutate({
        operatorId: draft.operatorId,
        from: draft.from,
        to: draft.from,
        reason: draft.reason.trim(),
        startsAt,
        endsAt,
      });
      return;
    }

    if (draft.from === "" || draft.to === "") return setFormError("Give a start and an end date.");
    if (draft.to < draft.from) return setFormError("The end date is before the start date.");
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
          {recordablePeople.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <label className={styles.partOfDayCheck}>
          <input
            type="checkbox"
            checked={draft.partOfDay}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                partOfDay: e.target.checked,
                // Whole-day's `to` follows `from` when switching in, so a
                // stray earlier "To" can never silently outlive the switch.
                to: e.target.checked ? d.from : d.to,
              }))
            }
          />
          Part of a day
        </label>
        {draft.partOfDay ? (
          <>
            <input
              className={fieldStyles.field}
              type="date"
              aria-label="Date"
              value={draft.from}
              onChange={(e) =>
                setDraft((d) => ({ ...d, from: e.target.value, to: e.target.value }))
              }
            />
            <input
              className={fieldStyles.field}
              type="time"
              aria-label="Start time"
              value={draft.startTime}
              onChange={(e) => setDraft((d) => ({ ...d, startTime: e.target.value }))}
            />
            <input
              className={fieldStyles.field}
              type="time"
              aria-label="End time"
              value={draft.endTime}
              onChange={(e) => setDraft((d) => ({ ...d, endTime: e.target.value }))}
            />
          </>
        ) : (
          <>
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
          </>
        )}
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
      {/* ⚠️ 09:00 MEANS NOTHING WITHOUT THE ZONE (R-359): named here, once the
          checkbox and a person make it resolvable, rather than left implicit. */}
      {draft.partOfDay && draftOperator !== null && (
        <p className={styles.zoneNote}>
          {draftZoneQuery.isLoading ? "Finding their time zone…" : `Times are in ${draftZone}.`}
        </p>
      )}
      {formError !== null && (
        <p className={styles.error} role="alert">
          {formError}
        </p>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
