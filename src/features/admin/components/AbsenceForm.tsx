/* ---------------------------------------------------------------------------
   AbsenceForm — the ONE absence-recording form (R-360 amended, R-449). Mounted
   on the Absences tab (`AbsencesPanel.tsx`, the plant-wide list, a dropdown of
   people) and on a person's own record in the Operators tab
   (`OperatorAbsences.tsx`, the person fixed). The maintainer, 22 Sept: "I want
   option A, but why can't we reuse the form on the same page itself?" — this
   file is that reuse. The two screens differ only in what person(s) they hand
   this component; validating, converting to instants and writing is the same
   code either way, where before it was two near-identical copies (the S70-a
   hit of the R-449 one-place audit).

   ⭐⭐ DEF-0035 / R-431 STILL HOLDS, BY CONSTRUCTION. This component never asks
   who may be recorded for and never runs a `canEdit`-shaped preview — it only
   renders the answer it is GIVEN. `people` is the dropdown's whole offering,
   already the visible people intersected with the server's own
   `absence_recordable_people()` answer (computed by the caller — see
   `AbsencesPanel.tsx`'s header); the fixed-person case is told the answer
   directly, as `fixedPersonRecordable`. When that is `false`, the form
   renders no Record button at all — nothing offered the server would refuse
   — and says so in words of its own, NOT `describeSchedulerError`'s
   `NotPermitted` sentence ("You do not have edit rights on this cell."):
   that sentence was written for the board's cell-shaped grid and names a
   cell, which this screen has none of (a person's own record, or a row in a
   plant-wide list). `set_absence`'s own `not_permitted` raise ("you cannot
   record an absence for someone at that place") never reaches the client —
   the closed-set contract (`errors.ts`) parses `not_permitted`'s detail into
   `{ nodeId }` only; the Postgres exception text itself is not carried
   through `SchedulerError`, so there is nothing of the server's own wording
   to reuse here. This is therefore the person-wide sentence in the app's own
   register, pinned in `absenceForm.test.tsx`. When `fixedPersonRecordable`
   is `null` (the caller's own recordable read is still pending), the form
   says so and offers nothing either, the same "no guessing" rule
   `AbsencesPanel.tsx` already keeps for its own Loading state.

   ⭐ R-359 — A PART-DAY WINDOW IS CONVERTED IN THE CHOSEN PERSON'S OWN PLANT
   ZONE. Each offered/fixed person carries the `siteNodeId` both screens
   already resolved this off (`fetchNodeSetting`, SECURITY DEFINER); the query
   key is `["node-setting", nodeId, "timezone"]`, the same key
   `OperatorAbsences.tsx`'s own display-side zone query already used, so the
   two share one cache entry rather than asking twice.

   The add mutation (`setAbsence`) and its invalidation live HERE now, not in
   either screen: both screens ran the identical mutation before this
   extraction, so there was nothing screen-specific to leave behind.
   --------------------------------------------------------------------------- */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchNodeSetting,
  setAbsence,
  type AbsenceRecord,
  type SchedulerError,
  type SetAbsenceInput,
} from "@/lib/api";
import { coerceTimezone } from "@/lib/format/timezones";
import { zonedTimeToInstant } from "@/features/board/lib/time";
import fieldStyles from "@/components/Field.module.css";
import { absenceKeys } from "./AbsencesImport";
import styles from "./AbsenceForm.module.css";

/** The one shape both screens offer this form a person as — a dropdown
 *  option or the fixed person, same fields either way. */
export interface AbsenceFormPerson {
  id: string;
  displayName: string;
  /** Resolved for the R-359 zone query when "Part of a day" is on. */
  siteNodeId: string;
}

export interface AbsenceFormProps {
  /** The form's own `aria-label` — the two screens read differently
   *  ("Record an absence" / "Record an absence for X"), since only the
   *  fixed-person one already names who it is for. */
  ariaLabel: string;
  /** Offerable people for the dropdown — ignored when `fixedPerson` is set.
   *  Already the server's own recordable answer intersected with who is
   *  visible (R-431, DEF-0035): this component applies no predicate of its
   *  own on top of it. */
  people: readonly AbsenceFormPerson[];
  /** When set, the Person control is this name as text, not a dropdown, and
   *  the form records for this person alone. */
  fixedPerson?: AbsenceFormPerson | null;
  /** R-431: whether the server's recordable answer names `fixedPerson` —
   *  `null` while that answer is still loading. Ignored when `fixedPerson`
   *  is not set (the dropdown already only offers recordable people). */
  fixedPersonRecordable?: boolean | null;
  /** Gates every query and the mutation, the same as both screens' own
   *  `canQueryAsUser` gate. */
  canQuery: boolean;
}

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

export function AbsenceForm({
  ariaLabel,
  people,
  fixedPerson = null,
  fixedPersonRecordable = null,
  canQuery,
}: AbsenceFormProps) {
  const queryClient = useQueryClient();
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

  const selectedPerson = useMemo(
    () => fixedPerson ?? people.find((p) => p.id === draft.operatorId) ?? null,
    [fixedPerson, people, draft.operatorId],
  );

  // R-359: the chosen person's OWN plant zone (decision 4) — resolved only
  // while the checkbox is on and somebody is chosen, so a whole-day entry
  // never fires this query at all.
  const zoneQuery = useQuery({
    queryKey: ["node-setting", selectedPerson?.siteNodeId ?? null, "timezone"],
    queryFn: () => fetchNodeSetting((selectedPerson as AbsenceFormPerson).siteNodeId, "timezone"),
    enabled: canQuery && draft.partOfDay && selectedPerson !== null,
  });
  const zone = coerceTimezone(zoneQuery.data ?? undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const operatorId = fixedPerson !== null ? fixedPerson.id : draft.operatorId;
    if (fixedPerson === null && operatorId === "") return setFormError("Choose a person.");
    if (draft.reason.trim() === "") return setFormError("Give a reason.");

    if (draft.partOfDay) {
      if (draft.from === "" || draft.startTime === "" || draft.endTime === "") {
        return setFormError("Give a date and a start and end time.");
      }
      if (draft.endTime <= draft.startTime) {
        return setFormError("The end time is not after the start time.");
      }
      if (zoneQuery.isLoading) {
        return setFormError("Still finding this person's time zone — try again in a moment.");
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
    addMutation.mutate({
      operatorId,
      from: draft.from,
      to: draft.to,
      reason: draft.reason.trim(),
    });
  }

  // R-431: nothing offered that the server refuses. A fixed person the
  // server's recordable answer does not name gets a person-wide sentence —
  // not describeSchedulerError's NotPermitted case ("You do not have edit
  // rights on this cell."), which names a cell this screen has none of — and
  // no Record button, no fields either, since there is nothing this screen
  // can do with them. See the header comment for why this is not the
  // server's own `set_absence` wording. While that answer is still loading
  // (`null`), the form says so rather than guessing which way it will land.
  if (fixedPerson !== null && fixedPersonRecordable !== true) {
    return fixedPersonRecordable === null ? (
      <p className={styles.muted}>Loading…</p>
    ) : (
      <p className={styles.error} role="alert">
        You cannot record an absence for this person from here.
      </p>
    );
  }

  return (
    <>
      <form className={styles.addRow} onSubmit={submit} aria-label={ariaLabel}>
        {fixedPerson === null ? (
          <select
            className={fieldStyles.select}
            aria-label="Person"
            value={draft.operatorId}
            onChange={(e) => setDraft((d) => ({ ...d, operatorId: e.target.value }))}
          >
            <option value="">Choose a person…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.fixedPerson}>{fixedPerson.displayName}</span>
        )}
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
      {draft.partOfDay && selectedPerson !== null && (
        <p className={styles.zoneNote}>
          {zoneQuery.isLoading ? "Finding their time zone…" : `Times are in ${zone}.`}
        </p>
      )}
      {formError !== null && (
        <p className={styles.error} role="alert">
          {formError}
        </p>
      )}
    </>
  );
}
