import { useMemo, useState } from "react";
import type { Product, BoardOperator, ReassignAssignmentInput, SchedulerError } from "@/lib/api";
import { describeSchedulerError, isSchedulerError, toSchedulerError } from "@/lib/api";
import type { IndexedAssignment, IndexedRun } from "../lib/boardIndex";
import { absenceGaps, type AbsenceRow } from "@/lib/absence";
import { leaveLine } from "../lib/leave";
import { formatClock, formatFull, addMinutes, BOARD_ZONE } from "../lib/time";
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@/lib/format/dates";
import { BoardPopover } from "./BoardPopover";
import { TargetField, normalizeTarget } from "./TargetField";
import fieldStyles from "@/components/Field.module.css";
import styles from "./AssignmentPopover.module.css";

/**
 * Port of the mockup's `openChipPop` (run-attached) / `openDirectPop`
 * (direct) — brief §5.4 combines both into one component keyed on whether
 * `homeRun` is set. The delete label differs in the mockup ("Remove" for
 * a chip vs "Delete" for a direct block); unified here as "Delete".
 *
 * Two flagged deviations from a literal port (see the agent report):
 * - The mockup's `openDirectPop` has an editable product `<select>` for a
 *   direct assignment ("Product (one edit = whole crew changes over)" on
 *   the run popover; a plain product select here). `AssignmentFieldEdit`/
 *   `updateAssignmentFields` (P1-3b, not to be extended per D36) has no
 *   `productId` field, so product is read-only here for BOTH a
 *   run-attached chip and a direct assignment, same reasoning as
 *   `RunPopover`'s read-only product field — see that file's header
 *   comment.
 * - ⭐ THERE IS NO STATUS CONTROL, AND ITS REMOVAL IS THE MAINTAINER'S
 *   DECISION (R-322). It was here once: a planned / active / done picker,
 *   which this comment already recorded as "a brief-only addition —
 *   neither `openChipPop` nor `openDirectPop` has a status control in the
 *   mockup". Nothing read the value. No rule fired on it, no screen showed
 *   it, and nothing obliged a supervisor to touch it — so in practice it
 *   would sit at "planned" on work that had long finished, and a label
 *   nobody maintains is worse than no label, because it reads as fact.
 *   The maintainer, 4 Sept: *"the supervisor will be like I'll just delete
 *   the assignment or modify it if there is a change."*
 *   ⚠️ `cancelled` IS UNAFFECTED AND IS NOT A LABEL. It is the soft delete
 *   — it frees the cell's slot past the overlap constraint, returns the
 *   operator's hours to the capacity guard, and drops the row from every
 *   board map (`boardIndex.ts` rule 17) while keeping it in history. It
 *   was never offered here anyway: Delete is the one path to it.
 *
 * ⭐⭐ R-343 — THE PERSON SELECT, AND WHY IT IS NOT AN `AssignmentFieldEdit`.
 * The maintainer, session 76: *"once you assign someone say Operator 1, there
 * is no way to modify that assignment to operator 2 unless you delete existing
 * assignment, this is not practical."* Save's ordinary path is
 * `updateAssignmentFields`, a plain PostgREST PATCH — and the eligibility
 * check lives in `create_assignment`, not in a trigger, so a person column
 * added to that patch would have moved an uncertified operator onto a cell that
 * requires the ticket with nothing to stop it. Changing the person therefore
 * goes through its own writer (`reassign_assignment`, migration 0057) and the
 * field edits follow it, only if there were any.
 *
 * ⚠️ THIS POP-UP LEARNS ABOUT INELIGIBILITY FROM THE ANSWER, NOT BEFOREHAND,
 * AND THAT IS THE ONE PLACE IT DIFFERS FROM `CreatePopover`. That screen is
 * handed `requiredSkills` and the node's `eligibilityPolicy` and draws the
 * override tick before it asks anything; this one is opened over an existing
 * chip and has neither. Rather than grow two more props (and a second place for
 * F-087's `certificateGaps` rule and R-331's policy lookup to drift), it sends
 * the change, and a `not_eligible` refusal IS the question: its `policy` field
 * says whether an override may be offered at all — `warn` draws the same tick
 * and required reason `CreatePopover` draws, `block` draws the same sentence
 * and no tick. So a person with no ticket can still be placed with a reason
 * under `warn`, and never under `block`, which is the rule either way.
 *
 * The AREA half is predicted rather than discovered, exactly as `CreatePopover`
 * predicts it: `outsideAreaOperatorIds` is resolved in `BoardPage` by the same
 * helper both pop-ups call, so a person from another area is marked in the LIST
 * before they are picked and the reason is asked for before Save is offered.
 */
/**
 * The refusal sentence, with the person named. The contract's own sentence
 * for a capacity refusal carries the operator's id, because the contract
 * does not know names; this pop-up does, so it says "Operator A2 would reach
 * 200%" rather than a uuid (measured on the live app, session 76).
 */
export function describeRefusal(
  refusal: SchedulerError,
  personName: string,
  dateFormat: DateFormat = DEFAULT_DATE_FORMAT,
  zone: string = BOARD_ZONE,
): string {
  if (refusal.kind === "CapacityExceeded") {
    return `${personName} would reach ${Math.round(refusal.peak * 100)}% of capacity at this time (limit ${Math.round(refusal.cap * 100)}%).`;
  }
  // R-357: this pop-up reassigns one person, so an `absent` refusal names that
  // one. Say it with the name it knows rather than the id `describeSchedulerError`
  // is left with.
  //
  // ⭐ R-359: AND THROUGH `leaveLine`, WHICH IS THE POINT. This sentence used to
  // build its own ` ${from} – ${to}` from the two date fields, so a refusal
  // against a PART-DAY absence read "10 Jun – 10 Jun" — true about the day and
  // silent about the hours, which reads as the whole day being gone when only
  // the morning is. `leaveLine` is the one place a board surface phrases an
  // absence, and it already knows how to say "10 Jun 2026, 09:00–13:00"; the
  // hours now reach here because `AbsentOperator` lifts the server's own
  // `starts_at`/`ends_at`. Routing through it means this sentence and the
  // pop-up's own leave line CANNOT drift into two phrasings of the same fact.
  if (refusal.kind === "Absent" && refusal.operators.length === 1) {
    const o = refusal.operators[0];
    // `leaveLine` needs the days; without them there is no sentence to phrase
    // and the bare form is all that is true.
    if (o.from === null || o.to === null) {
      const reason = o.reason !== null ? `: ${o.reason}` : "";
      return `${personName} is on leave${reason}.`;
    }
    const line = leaveLine(
      { from: o.from, to: o.to, reason: o.reason ?? "", startsAt: o.startsAt, endsAt: o.endsAt },
      dateFormat,
      zone,
    );
    // "On leave 10 Jun 2026, 09:00–13:00: sick" -> "Ana is on leave 10 Jun ...".
    return `${personName} is ${line.charAt(0).toLowerCase()}${line.slice(1)}.`;
  }
  return describeSchedulerError(refusal);
}

export function AssignmentPopover({
  assignment,
  homeRun,
  operator,
  operators,
  hereOperatorIds,
  outsideAreaOperatorIds,
  products,
  anchor,
  windowStart,
  dateFormat = DEFAULT_DATE_FORMAT,
  zone,
  absences = [],
  eligibilityPolicy = "warn",
  readOnly = false,
  onCancel,
  onSave,
  onReassign,
  onDelete,
  defaultTargetFor,
}: {
  assignment: IndexedAssignment;
  homeRun: IndexedRun | null;
  operator: BoardOperator | undefined;
  /**
   * R-343: who this row could be given to instead.
   *
   * ⚠️ THE POOL, NOT EVERY OPERATOR THE WINDOW CARRIES. The maintainer, 6
   * Sept: *"Operators from other plants should not be shown in the list,
   * period, it is the same as the operators shown on the left panel."* This is
   * the left panel's own variable (`operatorPool`), and since migration 0058 it
   * is the plant's people as the SERVER counted them. A person from another
   * AREA of THIS plant is still in it — they are marked and a reason is asked
   * for (D113) — because that refusal has a door and a cross-plant one does
   * not: R-345's table guard refuses it, override or no override.
   */
  operators: BoardOperator[];
  /**
   * ⭐⭐ R-346: of `operators`, the ones offered at THIS CELL by default. The
   * select opens on exactly these, and the rest of the plant is added by the
   * "Show other people in this plant" control under it. Resolved in `BoardPage`
   * by `lib/outsideArea.ts`, the same helper and the same place as the create
   * pop-up's, so the two pickers and the panel cannot disagree.
   */
  hereOperatorIds: ReadonlySet<string>;
  /**
   * D113: the people in `operators` who do not belong at THIS cell. Resolved in
   * `BoardPage` by `lib/outsideArea.ts`, the same helper the create pop-up
   * uses, so the two pickers cannot disagree about who is marked.
   *
   * ⚠️ NOT THE COMPLEMENT OF `hereOperatorIds`. Being offered by default and
   * needing no reason are different questions: somebody homed in a cell under
   * this line is a default offer on the line's board and still marked on the
   * cell next door. `outsideArea.ts` states the difference at both definitions.
   */
  outsideAreaOperatorIds: ReadonlySet<string>;
  products: Product[];
  anchor: { x: number; y: number };
  windowStart: Date;
  dateFormat?: DateFormat;
  zone?: string;
  /**
   * R-357: every absence the board can see (RLS-scoped upstream to this board's
   * own people). `absenceGaps` narrows it to the CHOSEN person and this row's
   * own window — the window `reassign_assignment` re-checks — so a person on
   * leave is named before Save and Save is refused in place under `block`, the
   * same shape as the certificate gap. Only the picked person and only when the
   * person is actually being changed: an already-placed person's leave is not a
   * reason to block a plain field edit the server never re-checks.
   *
   * Optional with an empty default so a caller or test with no absences loaded
   * renders exactly the pre-R-357 pop-up; `BoardPage` always passes the list.
   */
  absences?: readonly AbsenceRow[];
  /**
   * R-357: the eligibility policy resolved FOR THIS CHIP'S CELL (the twin of the
   * value the create pop-up is handed), so this pop-up can refuse an absent
   * placement in place under `block` instead of offering a Save the server would
   * reject. Unlike the certificate gap — which this pop-up learns from the
   * server's answer because it has no `requiredSkills` — absence needs no
   * required-skill context, so it is decided here with the same predicate the
   * create pop-up uses. Optional, defaulting to `warn` (no absence block) so a
   * caller or test that does not set it keeps the pre-R-357 behaviour;
   * `BoardPage` resolves and passes the cell's real policy.
   */
  eligibilityPolicy?: "warn" | "block";
  /**
   * DEF-0015 / R-239 / R-346: true for a viewer (someone the server answers
   * `can_place: false` for). The pop-up then SHOWS the assignment — person,
   * efficiency, target, time — but offers no Person select, no editable field,
   * and no Save or Delete, only Close. Every write it would offer is refused by
   * the `assignments_*` policies, so a control for one must not be drawn
   * (R-239). Decided in `BoardPage` from the server's own answer, never here.
   */
  readOnly?: boolean;
  onCancel: () => void;
  onSave: (
    assignmentId: string,
    efficiencyPercent: number,
    targetQty: number | null,
    targetUnit: string | null,
  ) => void;
  /**
   * R-343: change who is on the row. Resolves when the server took it and
   * REJECTS with the typed refusal when it did not — which is how this pop-up
   * learns that the new person has no ticket for this cell, and under which
   * policy. `useDragGesture`'s action closes the pop-up on success and leaves
   * it open on a refusal.
   */
  onReassign: (input: ReassignAssignmentInput) => Promise<void>;
  onDelete: (assignmentId: string) => void;
  /**
   * R-316: the TARGET this assignment works out to at a given efficiency, from
   * its cell's standard cycle time — or null when that cell has no cycle time
   * for the part. A target, not a standard: the standard is the seconds per
   * unit and does not move; this number does.
   *
   * A function rather than a number because efficiency is editable right here
   * and scales the result. Passing the already-computed
   * `assignment.defaultTargetQty` would show the figure for the SAVED
   * efficiency while the user is typing a different one.
   */
  defaultTargetFor?: (efficiencyPercent: number) => number | null;
}) {
  const isDirect = homeRun === null;
  const currentProductId = isDirect ? (assignment.productId ?? "") : homeRun.productId;
  const [efficiencyPercent, setEfficiencyPercent] = useState(String(assignment.efficiencyPercent));
  const [targetQty, setTargetQty] = useState(
    assignment.targetQty == null ? "" : String(assignment.targetQty),
  );
  const [targetUnit, setTargetUnit] = useState(assignment.targetUnit ?? "");

  // ---- R-343: the person ------------------------------------------------
  const currentOperatorId = assignment.operatorId ?? "";
  const [operatorId, setOperatorId] = useState(currentOperatorId);
  // The server's last word about THIS choice. Cleared the moment the choice
  // changes: an answer about Rita says nothing about Ray.
  const [refusal, setRefusal] = useState<SchedulerError | null>(null);
  // The eligibility answer, kept APART from the latest refusal. The first
  // draft derived the override question from `refusal` alone, so when the
  // resend with the override was then refused for capacity, the training
  // message and the tick vanished, and the next Save went out without the
  // override -- the two refusals alternated forever (the reviewer's finding,
  // session 77; AP9 pins it). An answer about this person's training stands
  // until a different person is picked.
  const [notEligibleAnswer, setNotEligibleAnswer] = useState<Extract<
    SchedulerError,
    { kind: "NotEligible" }
  > | null>(null);
  const [sending, setSending] = useState(false);
  const [overrideChecked, setOverrideChecked] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // D113. A SECOND pair, deliberately not reusing the one above, for the reason
  // CreatePopover gives: waving through "no Welding ticket" must not silently
  // also place somebody in a part of the structure they are not cleared for.
  const [areaChecked, setAreaChecked] = useState(false);
  const [areaReason, setAreaReason] = useState("");

  function pickPerson(nextId: string) {
    setOperatorId(nextId);
    setRefusal(null);
    setNotEligibleAnswer(null);
    setOverrideChecked(false);
    setOverrideReason("");
    setAreaChecked(false);
    setAreaReason("");
  }

  /**
   * ⭐⭐ R-346: THE LIST THE SELECT OFFERS IS `here` PLUS WHAT THE READER ASKED
   * FOR. The maintainer's rule, 6 Sept: a person is available by default
   * everywhere under their home, and *"for other operators in the plant we need
   * to give an option to the supervisor to click through something so show
   * remaining operators so they can make that decision to assign someone
   * outside of that area."* Pressing the control below adds them, marked, and
   * picking one runs the D113 reason flow unchanged.
   *
   * ⚠️ THE PERSON ALREADY ON THE ROW IS ALWAYS IN IT, AND THE REASON HAS
   * NARROWED. It used to cover "somebody on loan from another plant" as well as
   * D110's ghost; the loan case cannot exist any more (R-345 — the table refuses
   * a cross-plant placement, so no live row holds one) and `operators` is the
   * whole plant, so a LIVE person is always somewhere in this list: in `here`,
   * or pinned out of `elsewhere` by the filter below whether the control has
   * been pressed or not. What is left is the D110 ghost, `operatorId` null with
   * only a name remembered, which is in no pool by construction. Without the pin
   * the select would show the FIRST person while the row held someone else, and
   * Save would look like a no-op that quietly reassigned the work (AP8).
   */
  const here = useMemo(
    () => operators.filter((o) => o.active && hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  const elsewhere = useMemo(
    () => operators.filter((o) => o.active && !hereOperatorIds.has(o.id)),
    [operators, hereOperatorIds],
  );
  const [showOthers, setShowOthers] = useState(false);

  const people = useMemo(() => {
    const offered = showOthers
      ? [...here, ...elsewhere]
      : [...here, ...elsewhere.filter((o) => o.id === currentOperatorId || o.id === operatorId)];
    const rows = offered.map((o) => ({ id: o.id, label: o.displayName }));
    if (currentOperatorId === "") {
      // D110: the person was deleted and only their name remains. The select
      // must say so and hold that as its value, or it would show the first
      // person in the pool as if they were on the row, and a Save with
      // nothing picked would quietly do nothing (the reviewer's first
      // finding, session 77; AP8). Picking anyone real is a reassignment.
      rows.unshift({
        id: "",
        label: `${assignment.operatorDisplayName ?? "(unknown operator)"} — no longer in the system`,
      });
    } else if (!rows.some((r) => r.id === currentOperatorId)) {
      // ⚠️ THE LAST RESORT, AND IT SHOULD NOW BE UNREACHABLE FOR A LIVE PERSON:
      // `operators` is the whole plant and nobody outside it can be on the row.
      // It is kept because "unreachable" is a claim about the server, and this
      // is what the reader sees if it stops being true — a named row rather
      // than a silent swap.
      rows.unshift({
        id: currentOperatorId,
        label: operator?.displayName ?? assignment.operatorDisplayName ?? "(unknown operator)",
      });
    }
    return rows;
  }, [
    here,
    elsewhere,
    showOthers,
    operatorId,
    currentOperatorId,
    operator,
    assignment.operatorDisplayName,
  ]);

  const personChanged = operatorId !== currentOperatorId;
  const chosenName =
    operators.find((o) => o.id === operatorId)?.displayName ??
    operator?.displayName ??
    "This person";
  const selectedOutsideArea = outsideAreaOperatorIds.has(operatorId);
  // R-357: is the CHOSEN person on leave for this row's own window? Only asked
  // when the person is being changed — a field-only edit is not re-checked by
  // the server, so an already-placed person's leave is not a wall to it. The
  // window is the assignment's own [start, end); `absenceGaps` answers the same
  // overlap `reassign_assignment` refuses on.
  const selectedAbsence =
    personChanged && operatorId !== ""
      ? absenceGaps(absences, operatorId, {
          start: addMinutes(windowStart, assignment.startMin),
          end: addMinutes(windowStart, assignment.endMin),
        })
      : null;
  // Under `block` the reassignment cannot go through (no absence override);
  // under `warn` it is a warning and Save is still offered.
  const absenceBlocked = selectedAbsence !== null && eligibilityPolicy === "block";
  // The refusal that has an answer on this screen; every other kind is a
  // sentence and nothing more.
  const notEligible = notEligibleAnswer;
  const blocked = notEligible !== null && notEligible.policy === "block";
  const needsOverride = notEligible !== null && notEligible.policy === "warn";
  const saveDisabled =
    sending ||
    blocked ||
    // R-357: a person on leave cannot be placed under `block` — no override.
    absenceBlocked ||
    (needsOverride && (!overrideChecked || overrideReason.trim() === "")) ||
    // D113: the server refuses an override with no reason, so the button must
    // not offer to send one. Same shape as the line above it.
    (selectedOutsideArea && personChanged && (!areaChecked || areaReason.trim() === ""));

  async function save() {
    const eff = Math.max(10, Math.min(150, Number(efficiencyPercent) || 100));
    const { qty, unit } = normalizeTarget(targetQty, targetUnit);
    const fieldsChanged =
      eff !== assignment.efficiencyPercent ||
      qty !== (assignment.targetQty ?? null) ||
      unit !== (assignment.targetUnit ?? null);

    if (!personChanged) {
      onSave(assignment.id, eff, qty, unit);
      return;
    }
    setSending(true);
    try {
      // D64's rule, restated: never send an override the user did not tick.
      // `needsOverride` is only true once the server has actually refused, so
      // the first attempt for any person carries no flags at all.
      await onReassign({
        assignmentId: assignment.id,
        operatorId,
        eligibilityOverride: needsOverride && overrideChecked,
        overrideReason: needsOverride && overrideChecked ? overrideReason.trim() : undefined,
        areaOverride: selectedOutsideArea && areaChecked,
        areaOverrideReason: selectedOutsideArea && areaChecked ? areaReason.trim() : undefined,
      });
      // Only AFTER the person landed, and only if there is anything to say.
      // The two writes are not one transaction and cannot be made one, so the
      // order is chosen to fail safe: a refused reassignment leaves the row
      // exactly as it was rather than half-edited.
      // The field path closes the pop-up itself (the hook clears it after the
      // PATCH). A person-only save has no second write, so it closes here --
      // measured on the live app, session 76: without this line the pop-up
      // stayed open over a row that had already changed under it.
      if (fieldsChanged) onSave(assignment.id, eff, qty, unit);
      else onCancel();
    } catch (err) {
      const se = isSchedulerError(err) ? err : toSchedulerError(err);
      setRefusal(se);
      if (se.kind === "NotEligible") setNotEligibleAnswer(se);
    } finally {
      setSending(false);
    }
  }

  // R-316: follows the efficiency box as it is typed. An unparseable or empty
  // box falls back to the saved efficiency rather than to 100, so a
  // half-deleted number never makes the standard jump.
  const typedEfficiency = Number(efficiencyPercent);
  const derivedQty =
    defaultTargetFor?.(
      Number.isFinite(typedEfficiency) && typedEfficiency > 0
        ? typedEfficiency
        : assignment.efficiencyPercent,
    ) ?? assignment.defaultTargetQty;

  const product = products.find((p) => p.id === currentProductId);
  const name = operator?.displayName ?? "(unknown operator)";
  const timeLabel = `${formatFull(addMinutes(windowStart, assignment.startMin), dateFormat, zone)} – ${formatClock(addMinutes(windowStart, assignment.endMin), zone)}${assignment.eligibilityOverride ? " · certification override" : ""}`;

  // DEF-0015 / R-239 / R-346: the viewer's pop-up. The details are shown — who,
  // how hard, what target, when — but there is no Person select, no editable
  // field, and no Save or Delete, only Close, because the server refuses every
  // one of those writes for this person. No `save`/`onReassign`/`onDelete` wiring
  // is reachable from here.
  if (readOnly) {
    const targetLabel =
      assignment.targetQty == null
        ? null
        : `${assignment.targetQty}${assignment.targetUnit ? ` ${assignment.targetUnit}` : ""}`;
    return (
      <BoardPopover anchor={anchor} onClose={onCancel} title={`${name} — ${product?.name ?? "—"}`}>
        <div className={styles.body}>
          <div className={styles.time}>Person: {name}</div>
          <div className={styles.time}>Efficiency: {assignment.efficiencyPercent}%</div>
          {targetLabel !== null && <div className={styles.time}>Target: {targetLabel}</div>}
          <div className={styles.time}>{timeLabel}</div>
          <div className={styles.row}>
            <button type="button" onClick={onCancel}>
              Close
            </button>
          </div>
        </div>
      </BoardPopover>
    );
  }

  return (
    <BoardPopover anchor={anchor} onClose={onCancel} title={`${name} — ${product?.name ?? "—"}`}>
      <div className={styles.body}>
        <label htmlFor="ap-person">Person</label>
        <select id="ap-person" value={operatorId} onChange={(e) => pickPerson(e.target.value)}>
          {people.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {/* D113, word for word the create pop-up's: a person outside
                  this area is OFFERED, not hidden, because that refusal has
                  a door. Somebody from another PLANT is not in this list at
                  all -- see the `operators` prop. */}
              {outsideAreaOperatorIds.has(o.id) ? " — not from this area (override)" : ""}
            </option>
          ))}
        </select>
        {/* R-346. ABSENT WHEN THERE IS NOBODY BEHIND IT -- on a plant admin's
            board every home in the plant is covered, so a control reading "(0)"
            would be a door onto an empty room. Skin from the shared field
            module (R-318); deliberately not inside `.row`, whose `.row button`
            rule would repaint it as a dialog action. */}
        {elsewhere.length > 0 && (
          <button
            type="button"
            className={`${fieldStyles.btn} ${styles.othersBtn}`}
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
          >
            {showOthers ? "Hide" : "Show"} other people in this plant ({elsewhere.length})
          </button>
        )}

        <label htmlFor="ap-eff">Efficiency %</label>
        <input
          id="ap-eff"
          type="number"
          min={10}
          max={150}
          step={5}
          value={efficiencyPercent}
          onChange={(e) => setEfficiencyPercent(e.target.value)}
        />

        <TargetField
          idPrefix="ap"
          qty={targetQty}
          unit={targetUnit}
          onQtyChange={setTargetQty}
          onUnitChange={setTargetUnit}
          derivedQty={derivedQty}
        />

        {selectedOutsideArea && personChanged && (
          <div className={styles.eligWarn}>
            {/* D113: "the area rule becomes a strong warning rather than a
                wall, and the audit log carries who waved it through." */}
            <p>This person doesn&rsquo;t belong to this part of the structure.</p>
            <label className={styles.overrideLbl}>
              <input
                type="checkbox"
                checked={areaChecked}
                onChange={(e) => setAreaChecked(e.target.checked)}
              />
              Place them here anyway
            </label>
            {areaChecked && (
              <>
                <label htmlFor="ap-area-reason">Reason (required)</label>
                <input
                  id="ap-area-reason"
                  type="text"
                  value={areaReason}
                  onChange={(e) => setAreaReason(e.target.value)}
                  placeholder="Why are they working here?"
                />
              </>
            )}
          </div>
        )}

        {notEligible !== null && (
          <div className={styles.eligWarn}>
            {/* ⛔ THE SERVER'S OWN ANSWER, NAMED. `missingSkills` is "never
                trained"; `expiringSkills` is "trained, and the certificate runs
                out before this window ends" -- two problems needing a course
                and a renewal respectively, which F-087 was filed for printing
                as one sentence and then as none. */}
            {notEligible.missingSkills.length > 0 && (
              <p>
                <strong>Never trained:</strong>{" "}
                {notEligible.missingSkills.map((sk) => sk.name).join(", ")}. Booking the training is
                what fixes this.
              </p>
            )}
            {notEligible.expiringSkills.length > 0 && (
              <p>
                <strong>Certificate expired:</strong>{" "}
                {notEligible.expiringSkills.map((sk) => sk.name).join(", ")}. They held this — it
                needs renewing before this shift ends.
              </p>
            )}
            {notEligible.missingSkills.length === 0 && notEligible.expiringSkills.length === 0 && (
              <p>This person is not certified for this cell.</p>
            )}
            {blocked ? (
              // R-331: the plant this cell sits in refuses, whatever the plant
              // next door allows. The server said so; this is not a guess.
              <p>Certification is required at this place, so there is no override.</p>
            ) : (
              <>
                <label className={styles.overrideLbl}>
                  <input
                    type="checkbox"
                    checked={overrideChecked}
                    onChange={(e) => setOverrideChecked(e.target.checked)}
                  />
                  Override — I&rsquo;m certifying this placement anyway
                </label>
                {overrideChecked && (
                  <>
                    <label htmlFor="ap-override-reason">Reason (required)</label>
                    <input
                      id="ap-override-reason"
                      type="text"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder="Why is this OK?"
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}

        {selectedAbsence !== null && (
          <div className={styles.eligWarn}>
            {/* R-357: named and dated through the app's date seam (R-338). No
                override box — the server takes no absence override, so under
                `warn` this is a warning and Save stays enabled; under `block`
                there is nothing to tick and Save is off. */}
            <p>
              <strong>{leaveLine(selectedAbsence, dateFormat, zone)}</strong>
            </p>
            {absenceBlocked ? (
              <p>This person is on leave for this window, so there is no override.</p>
            ) : (
              <p>Placing them anyway records the assignment over their leave.</p>
            )}
          </div>
        )}

        {refusal !== null && refusal.kind !== "NotEligible" && (
          // Every other refusal: the sentence the error contract already writes
          // for it, in the pop-up rather than only in a toast, because the
          // control that caused it is still on screen. `Absent` is one of these
          // — a race backstop, since Save is already refused in place under
          // block; `describeRefusal` names the person and the leave (R-357).
          <p className={styles.refusal} role="alert">
            {describeRefusal(refusal, chosenName, dateFormat, zone)}
          </p>
        )}

        <div className={styles.time}>{timeLabel}</div>

        <div className={styles.row}>
          <button type="button" onClick={() => onDelete(assignment.id)}>
            Delete
          </button>
          <button type="button" onClick={onCancel}>
            Close
          </button>
          <button
            type="button"
            className={styles.pri}
            disabled={saveDisabled}
            onClick={() => {
              void save();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </BoardPopover>
  );
}
