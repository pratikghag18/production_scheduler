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

   ⭐⭐ S70-a / R-360 amended, R-449 — RECORDS THROUGH THE SAME FORM THE ABSENCES
   TAB MOUNTS, `AbsenceForm.tsx`, with this person fixed rather than a
   dropdown (one control, two entry points — the D100 shape the skills
   pop-over already used). This block no longer codes its own `<form>`. It
   still needs DEF-0035's recordable answer, because R-431 holds here too: a
   supervisor who can read this person's record is not necessarily one
   `set_absence` will accept a write for (their home cell can sit on a line
   this reader cannot edit). The query is `fetchRecordableAbsencePeople`
   under the SAME key `AbsencesPanel.tsx` uses (`[...absenceKeys.all,
   "recordable"]`), so react-query shares one request between the two
   screens rather than asking twice.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchAbsences,
  fetchNodeSetting,
  fetchRecordableAbsencePeople,
  removeAbsence,
  type AbsenceRecord,
  type SchedulerError,
} from "@/lib/api";
import { formatCalendarDay, coerceDateFormat, DEFAULT_DATE_FORMAT } from "@/lib/format/dates";
import { coerceTimezone, todayIsoInZone } from "@/lib/format/timezones";
import { formatClock } from "@/features/board/lib/time";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import fieldStyles from "@/components/Field.module.css";
import { absenceKeys } from "./AbsencesImport";
import { AbsenceForm } from "./AbsenceForm";
import styles from "./OperatorAbsences.module.css";

interface Props {
  operatorId: string;
  displayName: string;
  /** The person's own place — `operators.site_node_id` — resolved for its
   *  zone and date format ON THE SERVER, never walked here (see header). */
  homeNodeId: string;
}

// R-426: `todayUtc()` used to sit here. The UTC day is already TOMORROW through
// the evening west of Greenwich (F-159), which filed a whole-day absence for
// today under "Past" for anyone looking after 19:00 Chicago. "Today" is now
// asked of the person's own plant zone — `todayIsoInZone(zone)`, below, where
// that zone is already resolved.

/** Soonest first: by effective day, then whole-day before part-day on a tied
 *  day — the same order `absenceGaps` sorts by (src/lib/absence.ts). */
// DEF-0037 / R-431, R-449: the same rule the record half already keeps
// (AbsenceForm.tsx's header) — a refusal the server still raises (a stale
// page; the Remove button below is hidden once `isRecordable` is known
// false, so this only fires on a race) is worded for THIS screen, not with
// describeSchedulerError's NotPermitted sentence ("You do not have edit
// rights on this cell."), which names a cell this screen has none of.
function removeErrorMessage(err: SchedulerError): string {
  if (err.kind === "NotPermitted") {
    return "You cannot remove an absence for this person from here.";
  }
  return describeSchedulerError(err);
}

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

  // DEF-0035 / R-431, shared with AbsencesPanel.tsx: the SAME query key, so
  // react-query shares one request between the two screens rather than
  // asking the server twice. A supervisor who can READ this person is not
  // necessarily one `set_absence` will accept a write for.
  const recordableQuery = useQuery<string[], SchedulerError>({
    queryKey: [...absenceKeys.all, "recordable"],
    queryFn: fetchRecordableAbsencePeople,
    enabled: canQuery,
  });
  const isRecordable = recordableQuery.isLoading
    ? null
    : (recordableQuery.data ?? []).includes(operatorId);

  const mine = useMemo(
    () =>
      (absencesQuery.data?.absences ?? [])
        .filter((a) => a.operatorId === operatorId)
        .slice()
        .sort(byWhenSoonestFirst),
    [absencesQuery.data, operatorId],
  );

  const [showPast, setShowPast] = useState(false);
  const today = todayIsoInZone(zone);
  const upcoming = useMemo(() => mine.filter((a) => a.to >= today), [mine, today]);
  const past = useMemo(() => mine.filter((a) => a.to < today), [mine, today]);
  const shown = showPast ? mine : upcoming;

  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: absenceKeys.all });

  const removeMutation = useMutation<void, SchedulerError, string>({
    mutationFn: (id) => removeAbsence(id),
    retry: false,
    onSuccess: invalidate,
  });

  function remove(id: string) {
    setRowError(null);
    removeMutation.mutate(id, {
      onError: (err) => setRowError({ id, message: removeErrorMessage(err) }),
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
                        {formatClock(new Date(a.startsAt), zone)}–
                        {formatClock(new Date(a.endsAt), zone)}
                      </>
                    )}
                  </span>
                  <span className={styles.reason}>{a.reason}</span>
                  {/* DEF-0037 / R-431, R-449: `remove_absence` refuses the
                      same set `set_absence` does (the server's own
                      `absence_recordable_people()`, already asked above for
                      the form's gate) — one person on this screen, so the
                      same `isRecordable` answer gates both halves. `null`
                      (still loading) offers no Remove, same as `false`: fail
                      closed, never guess which way a pending answer lands.
                      The row stays listed either way (reading is allowed). */}
                  {isRecordable === true && (
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

      {/* S70-a / R-360 amended, R-449: the one absence form, shared with
          AbsencesPanel.tsx's dropdown mount — see AbsenceForm.tsx's header.
          The person is fixed; DEF-0035's recordable answer still gates it
          (R-431), because reading this person's record does not by itself
          mean `set_absence` accepts a write for them. */}
      {recordableQuery.isError ? (
        <p className={styles.error} role="alert">
          {describeSchedulerError(recordableQuery.error)}
        </p>
      ) : (
        <AbsenceForm
          ariaLabel={`Record an absence for ${displayName}`}
          people={[]}
          fixedPerson={{ id: operatorId, displayName, siteNodeId: homeNodeId }}
          fixedPersonRecordable={isRecordable}
          canQuery={canQuery}
        />
      )}
    </section>
  );
}
