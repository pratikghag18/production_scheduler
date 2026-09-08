/* ---------------------------------------------------------------------------
   OperatorAbsences — the selected person's OWN absences, on their record in the
   Operators tab (R-360).

   The maintainer, 7 Sept: "The absence tab is good, I think we should show it
   under individual operators in the operators tab as well to help the
   supervisor plan stuff out. It would be a good data point to see everything
   related to that operator in one place." So this sits below "Where X can
   work" and lists THAT person's absences, soonest first, past ones behind a
   "show past" toggle, and records and removes one in place.

   ⭐ THE SAME READ, THE SAME `absenceKeys` KEY AS THE ABSENCES TAB
   (`AbsencesPanel.tsx`) — `[...absenceKeys.all, "admin"]`, `fetchAbsences` —
   so the two share ONE cache entry and one invalidation refreshes both. It
   filters to this person client-side; RLS has already scoped the read to
   whoever the caller may see.

   ⭐ R-359/R-360 — THE ZONE IS THIS PERSON'S OWN PLANT ZONE, RESOLVED HERE.
   `homeNodeId` (the operator's `site_node_id`) need not be a plant root
   (D109), so this asks the server (`fetchNodeSetting`, `app_resolve_node_
   setting`, SECURITY DEFINER) rather than reading a root's own override the
   way `usePlantOverrides` does — a client-side ancestry walk off a partial
   `nodes` list is exactly DEF-0016/DEF-0017's shape, and this is the "add the
   query inside your own component" the brief calls for instead. The query
   lives HERE, not in `OperatorsPanel.tsx`, which gets a single, otherwise
   untouched insertion (see the file's own header).

   DECIDES NO PERMISSION AND PRE-GUESSES NO REFUSAL, same rule as
   `AbsencesPanel.tsx`: `set_absence` / `remove_absence` are the authority and a
   refusal is shown here in words.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { formatCalendarDay, coerceDateFormat, DEFAULT_DATE_FORMAT } from "@/lib/format/dates";
import { coerceTimezone } from "@/lib/format/timezones";
import { formatClock, zonedTimeToInstant } from "@/features/board/lib/time";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import fieldStyles from "@/components/Field.module.css";
import { absenceKeys } from "./AbsencesImport";
import styles from "./OperatorAbsences.module.css";

interface Props {
  operatorId: string;
  displayName: string;
  /** The person's own place — `operators.site_node_id` — resolved for its
   *  zone and date format ON THE SERVER, never walked here (see header). */
  homeNodeId: string;
}

interface DraftState {
  from: string;
  to: string;
  reason: string;
  partOfDay: boolean;
  startTime: string;
  endTime: string;
}

const EMPTY_DRAFT: DraftState = {
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

/** Today, as the UTC `YYYY-MM-DD` the rest of the absence machinery compares
 *  days in (absence.ts's header) — used only to sort past from upcoming. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Soonest first: by effective day, then whole-day before part-day on a tied
 *  day — the same order `absenceGaps` sorts by (src/lib/absence.ts). */
function byWhenSoonestFirst(a: AbsenceRecord, b: AbsenceRecord): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  const aPart = a.startsAt !== undefined;
  const bPart = b.startsAt !== undefined;
  if (aPart !== bPart) return aPart ? 1 : -1;
  if (!aPart) return 0;
  const as = a.startsAt as string;
  const bs = b.startsAt as string;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function OperatorAbsences({ operatorId, displayName, homeNodeId }: Props) {
  const { session, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const queryClient = useQueryClient();

  // The same cache entry AbsencesPanel.tsx reads: one invalidation refreshes both.
  const absencesQuery = useQuery({
    queryKey: [...absenceKeys.all, "admin"],
    queryFn: fetchAbsences,
    enabled: canQuery,
  });

  const zoneQuery = useQuery({
    queryKey: ["node-setting", homeNodeId, "timezone"],
    queryFn: () => fetchNodeSetting(homeNodeId, "timezone"),
    enabled: canQuery,
  });
  const zone = coerceTimezone(zoneQuery.data ?? undefined);

  const dateFormatQuery = useQuery({
    queryKey: ["node-setting", homeNodeId, "date_format"],
    queryFn: () => fetchNodeSetting(homeNodeId, "date_format"),
    enabled: canQuery,
  });
  const dateFormat = coerceDateFormat(dateFormatQuery.data ?? DEFAULT_DATE_FORMAT);

  const mine = useMemo(
    () =>
      (absencesQuery.data?.absences ?? [])
        .filter((a) => a.operatorId === operatorId)
        .slice()
        .sort(byWhenSoonestFirst),
    [absencesQuery.data, operatorId],
  );

  const [showPast, setShowPast] = useState(false);
  const today = todayUtc();
  const upcoming = useMemo(() => mine.filter((a) => a.to >= today), [mine, today]);
  const past = useMemo(() => mine.filter((a) => a.to < today), [mine, today]);
  const shown = showPast ? mine : upcoming;

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (draft.reason.trim() === "") return setFormError("Give a reason.");

    if (draft.partOfDay) {
      if (draft.from === "" || draft.startTime === "" || draft.endTime === "") {
        return setFormError("Give a date and a start and end time.");
      }
      if (draft.endTime <= draft.startTime) {
        return setFormError("The end time is not after the start time.");
      }
      if (zoneQuery.isLoading) {
        return setFormError("Still finding their time zone — try again in a moment.");
      }
      const ymd = parseYmd(draft.from);
      const st = parseHm(draft.startTime);
      const et = parseHm(draft.endTime);
      if (ymd === null || st === null || et === null) {
        return setFormError("Give a valid date and times.");
      }
      const startsAt = zonedTimeToInstant(zone, ymd.y, ymd.mo, ymd.d, st.h, st.mi).toISOString();
      const endsAt = zonedTimeToInstant(zone, ymd.y, ymd.mo, ymd.d, et.h, et.mi).toISOString();
      addMutation.mutate({
        operatorId,
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
    addMutation.mutate({ operatorId, from: draft.from, to: draft.to, reason: draft.reason.trim() });
  }

  function remove(id: string) {
    setRowError(null);
    removeMutation.mutate(id, {
      onError: (err) => setRowError({ id, message: describeSchedulerError(err) }),
    });
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{displayName}&rsquo;s absences</h3>

      {absencesQuery.isLoading ? (
        <p className={styles.muted}>Loading…</p>
      ) : (
        <>
          {mine.length === 0 ? (
            <p className={styles.muted}>{displayName} has no absences recorded.</p>
          ) : shown.length === 0 ? (
            <p className={styles.muted}>Nothing upcoming for {displayName}.</p>
          ) : (
            <ul className={styles.list}>
              {shown.map((a) => (
                <li key={a.id} className={styles.row}>
                  <span className={styles.when}>
                    {formatCalendarDay(a.from, dateFormat)}
                    {a.from !== a.to && ` – ${formatCalendarDay(a.to, dateFormat)}`}
                    {a.startsAt !== undefined && a.endsAt !== undefined && (
                      <>
                        {" "}
                        {formatClock(new Date(a.startsAt), zone)}–{formatClock(new Date(a.endsAt), zone)}
                      </>
                    )}
                  </span>
                  <span className={styles.reason}>{a.reason}</span>
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
                </li>
              ))}
            </ul>
          )}
          {past.length > 0 && (
            <button
              className={styles.showPastBtn}
              type="button"
              onClick={() => setShowPast((v) => !v)}
            >
              {showPast ? "Hide past" : `Show past (${past.length})`}
            </button>
          )}
        </>
      )}

      <form className={styles.addRow} onSubmit={submit} aria-label={`Record an absence for ${displayName}`}>
        <label className={styles.partOfDayCheck}>
          <input
            type="checkbox"
            checked={draft.partOfDay}
            onChange={(e) =>
              setDraft((d) => ({ ...d, partOfDay: e.target.checked, to: e.target.checked ? d.from : d.to }))
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
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value, to: e.target.value }))}
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
      {/* ⚠️ 09:00 means nothing without the zone (R-359). */}
      {draft.partOfDay && (
        <p className={styles.zoneNote}>
          {zoneQuery.isLoading ? "Finding their time zone…" : `Times are in ${zone}.`}
        </p>
      )}
      {formError !== null && (
        <p className={styles.error} role="alert">
          {formError}
        </p>
      )}
    </section>
  );
}
