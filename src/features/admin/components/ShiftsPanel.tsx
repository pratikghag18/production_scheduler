/* ---------------------------------------------------------------------------
   Shift patterns — the admin section for `shift_templates` and what is inside
   them (migration 0005; owners and write policies from 0023).

   ⭐ `SHIFTS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`, and it is flipped
   in the same commit that gives this panel a real body — that is the whole
   point of §19.62's pre-seat. Nothing in `AdminPage.tsx`, `REM_SURFACES` or
   R10's copy of that list is edited by this lane.

   ⭐ THIS PANEL TAKES NO PROPS. It reads the session itself and gates its own
   query on `canQueryAsUser`, so `AdminPage.tsx` never grows a prop list for
   it — every table behind `fetchShiftPatterns` is RLS-scoped to the caller and
   firing the read before the session resolves can only be a 401 (D91: a query
   with `enabled: false` reports `isLoading === false`, so the gate has to be
   folded into the pending branch by hand, which `panelState` does).

   ---------------------------------------------------------------------------
   ⭐ TIMES ARE THE WHOLE EXPERIENCE HERE, AND MINUTES NEVER REACH THE SCREEN.

   `start_min` / `end_min` are minutes from the pattern's midnight. A
   supervisor reads `06:00–14:00`. Every label on this screen comes from
   `shiftDraft.ts`'s `describeSpan`/`minutesToLabel`, and every control is an
   `<input type="time">` — a clock face — paired with a "next day" checkbox
   where the value may cross midnight. The checkbox exists because a time input
   cannot express a day: 22:00–06:00 is stored `1320..1800`, and without
   somewhere to say "+1 day" the only thing a person could type for the end is
   06:00, which is `360`, which the CHECK constraint refuses. So the day is
   asked for explicitly rather than guessed from "the end looks earlier than
   the start" — that guess is wrong for a 24-hour shift and silently right for
   the wrong reason on every other one.

   ---------------------------------------------------------------------------
   ⭐ TWO PERMISSIONS, TWO PLACES ON THE SCREEN, DELIBERATELY NOT ONE.

   EDITING a pattern needs to own it (company admin, or the admin of the site
   in `site_node_id`). ATTACHING a pattern to a node needs
   `app_is_admin_for(node_id)` and says nothing about the pattern. A site's
   admin can attach the company-wide pattern to their own plant and cannot
   rename it. So the pattern list and the "where patterns apply" list are
   separate cards with separate refusals, and neither is hidden on a guess
   about permission — the server is asked and its refusal
   (`{kind:"WriteRefused"}`) is shown in place. Hiding a control the server
   would have allowed is a feature nobody can reach and looks exactly like a
   broken screen.

   ---------------------------------------------------------------------------
   NO OPTIMISTIC UPDATES: every mutation invalidates and the refetch redraws
   (see `useShifts.ts` for why this one genuinely cannot be faked).

   StrictMode: every mutation is fired from an event handler, never from inside
   a `useState` updater, so React's development double-invocation of updaters
   cannot double-fire a write.
   --------------------------------------------------------------------------- */
import { useState } from "react";
import { canQueryAsUser } from "@/features/auth/session";
import { useSession } from "@/features/auth/useSession";
import { describeSchedulerError, isSchedulerError } from "@/lib/api";
import {
  addedProblems,
  clockToMinutes,
  dayOffset,
  minutesToClock,
  patternRows,
  validatePatternDraft,
  type BreakDraft,
  type BreakView,
  type PatternDraft,
  type PatternView,
  type ShiftDraft,
  type ShiftView,
} from "../lib/shiftDraft";
import { indentedLabel, scopeOptions } from "../lib/scope";
import {
  useAttachPattern,
  useCreateBreak,
  useCreatePattern,
  useCreateShift,
  useDeleteBreak,
  useUpdateBreak,
  useDeletePattern,
  useDeleteShift,
  useDetachPattern,
  useRenamePattern,
  useShiftPatterns,
  useUpdateShift,
} from "../hooks/useShifts";
import styles from "./ShiftsPanel.module.css";

/** Flipped in the same commit that gave this panel a real body (§19.62). */
export const SHIFTS_PANEL_READY = true;

/* ---------------------------------------------------------------------------
   Control state. A time control holds a CLOCK FACE plus a day flag, not a
   number: that is what the person typed, and converting on every keystroke
   turns a half-entered "0" into midnight.
   --------------------------------------------------------------------------- */

interface TimeValue {
  clock: string;
  nextDay: boolean;
}

const NO_TIME: TimeValue = { clock: "", nextDay: false };

function timeMinutes(v: TimeValue): number | null {
  return clockToMinutes(v.clock, v.nextDay ? 1 : 0);
}

function timeOf(minutes: number): TimeValue {
  return { clock: minutesToClock(minutes), nextDay: dayOffset(minutes) === 1 };
}

interface ShiftForm {
  name: string;
  start: TimeValue;
  end: TimeValue;
}

const BLANK_SHIFT: ShiftForm = { name: "", start: NO_TIME, end: NO_TIME };

interface BreakForm {
  name: string;
  start: TimeValue;
  end: TimeValue;
}

const BLANK_BREAK: BreakForm = { name: "Break", start: NO_TIME, end: NO_TIME };

function toShiftDraft(s: ShiftView): ShiftDraft {
  return {
    id: s.id,
    name: s.name,
    startMin: s.startMin,
    endMin: s.endMin,
    breaks: s.breaks.map(
      (b): BreakDraft => ({ id: b.id, name: b.name, startMin: b.startMin, endMin: b.endMin }),
    ),
  };
}

function toPatternDraft(p: PatternView, shifts: readonly ShiftDraft[]): PatternDraft {
  return { id: p.id, name: p.name, shifts };
}

/* `addedProblems` now lives in `../lib/shiftDraft` — it is pure, it is the
   piece that carried the 27-Aug defect, and in here it had no test that could
   reach it. Group W pins it. */

function errorText(e: unknown): string {
  return isSchedulerError(e) ? describeSchedulerError(e) : "Something went wrong. Please try again.";
}

/**
 * One time control: a clock face, plus the day it lands on where that is a
 * question the schema allows.
 *
 * `allowNextDay` is FALSE for a shift's start, because `start_min < 1440` is a
 * CHECK constraint — offering a "+1 day" there would offer a save the server
 * refuses.
 */
function TimeField({
  label,
  value,
  onChange,
  allowNextDay,
}: {
  label: string;
  value: TimeValue;
  onChange: (next: TimeValue) => void;
  allowNextDay: boolean;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.timeGroup}>
        <input
          className={styles.timeInput}
          type="time"
          aria-label={label}
          value={value.clock}
          onChange={(e) => onChange({ ...value, clock: e.target.value })}
        />
        {allowNextDay && (
          <label className={styles.dayCheck}>
            <input
              type="checkbox"
              checked={value.nextDay}
              onChange={(e) => onChange({ ...value, nextDay: e.target.checked })}
            />
            next day
          </label>
        )}
      </div>
    </div>
  );
}

export function ShiftsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const orgId = profile?.orgId ?? null;
  const query = useShiftPatterns(canQuery);

  const createPattern = useCreatePattern();
  const renamePattern = useRenamePattern();
  const deletePattern = useDeletePattern();
  const createShift = useCreateShift();
  const updateShift = useUpdateShift();
  const deleteShift = useDeleteShift();
  const createBreak = useCreateBreak();
  const deleteBreak = useDeleteBreak();
  const updateBreak = useUpdateBreak();
  const attachPattern = useAttachPattern();
  const detachPattern = useDetachPattern();

  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<{
    id: string;
    name: string;
    siteNodeId: string;
  } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState<ShiftForm>(BLANK_SHIFT);
  const [shiftEdit, setShiftEdit] = useState<{ id: string; form: ShiftForm } | null>(null);
  const [breakFor, setBreakFor] = useState<{ shiftId: string; form: BreakForm } | null>(null);
  const [breakEdit, setBreakEdit] = useState<{
    id: string;
    shiftId: string;
    form: BreakForm;
  } | null>(null);
  const [attachDraft, setAttachDraft] = useState<Readonly<Record<string, string>>>({});
  /** Keyed by the row the message belongs to, so it never lands on a stranger. */
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

  const view = patternRows(query.data);
  const pending = !canQuery || query.isLoading;
  // ⭐ EVERY NODE, NOT JUST ROOTS (0025 / D103). `patternRows` already returns
  // every node with its depth and path for the attachment card below, so the
  // owner picker and the attachment picker now offer the same tree — which is
  // the point: a pattern owned by Assembly and attached to a cell under
  // Assembly is the ordinary case, and until 0025 the first half of that
  // sentence could not be said.
  const scopeChoices = scopeOptions(
    view.nodes.map((n) => ({ id: n.nodeId, name: n.nodeName, parentId: null, path: n.path })),
  );

  function fail(key: string, e: unknown) {
    setRowError({ key, message: errorText(e) });
  }
  function clear(key: string) {
    setRowError((cur) => (cur !== null && cur.key === key ? null : cur));
  }
  function errorFor(key: string): string | null {
    return rowError !== null && rowError.key === key ? rowError.message : null;
  }

  function submitNewPattern() {
    if (orgId === null) return;
    clear("new");
    const draft: PatternDraft = { id: null, name: newName, shifts: [] };
    const named = validatePatternDraft(draft, view.patterns.map((p) => p.name)).problems.filter(
      (p) => p.field === "pattern-name",
    );
    if (named.length > 0) {
      setRowError({ key: "new", message: named[0].message });
      return;
    }
    createPattern.mutate(
      // ⭐ 0028: `""` was company-wide and is now "nothing chosen"; the picker
      // has no empty entry to select, so this can only be empty when the
      // structure read did not land, and the server refuses it with a sentence.
      { orgId, name: newName.trim(), siteNodeId: newOwner },
      {
        onSuccess: () => setNewName(""),
        onError: (e) => fail("new", e),
      },
    );
  }

  function submitShift(pattern: PatternView) {
    if (orgId === null) return;
    const key = `add-shift-${pattern.id}`;
    clear(key);
    const startMin = timeMinutes(shiftForm.start);
    const endMin = timeMinutes(shiftForm.end);
    const existing = pattern.shifts.map(toShiftDraft);
    const added: ShiftDraft = {
      id: null,
      name: shiftForm.name,
      startMin,
      endMin,
      breaks: [],
    };
    const problems = addedProblems(
      toPatternDraft(pattern, existing),
      toPatternDraft(pattern, [...existing, added]),
    );
    if (problems.length > 0 || startMin === null || endMin === null) {
      setRowError({ key, message: problems[0] ?? "Enter a start and an end time." });
      return;
    }
    createShift.mutate(
      { orgId, templateId: pattern.id, name: shiftForm.name.trim(), startMin, endMin },
      { onSuccess: () => setShiftForm(BLANK_SHIFT), onError: (e) => fail(key, e) },
    );
  }

  function submitShiftEdit(pattern: PatternView, shift: ShiftView) {
    if (shiftEdit === null) return;
    const key = `edit-shift-${shift.id}`;
    clear(key);
    const startMin = timeMinutes(shiftEdit.form.start);
    const endMin = timeMinutes(shiftEdit.form.end);
    const existing = pattern.shifts.map(toShiftDraft);
    const edited = existing.map((s) =>
      s.id === shift.id ? { ...s, name: shiftEdit.form.name, startMin, endMin } : s,
    );
    const problems = addedProblems(
      toPatternDraft(pattern, existing),
      toPatternDraft(pattern, edited),
    );
    if (problems.length > 0 || startMin === null || endMin === null) {
      setRowError({ key, message: problems[0] ?? "Enter a start and an end time." });
      return;
    }
    updateShift.mutate(
      { shiftId: shift.id, name: shiftEdit.form.name.trim(), startMin, endMin },
      { onSuccess: () => setShiftEdit(null), onError: (e) => fail(key, e) },
    );
  }

  function submitBreak(pattern: PatternView, shift: ShiftView) {
    if (orgId === null || breakFor === null) return;
    const key = `add-break-${shift.id}`;
    clear(key);
    const startMin = timeMinutes(breakFor.form.start);
    const endMin = timeMinutes(breakFor.form.end);
    const existing = pattern.shifts.map(toShiftDraft);
    const withBreak = existing.map((s) =>
      s.id === shift.id
        ? {
            ...s,
            breaks: [
              ...s.breaks,
              { id: null, name: breakFor.form.name, startMin, endMin },
            ],
          }
        : s,
    );
    const problems = addedProblems(
      toPatternDraft(pattern, existing),
      toPatternDraft(pattern, withBreak),
    );
    if (problems.length > 0 || startMin === null || endMin === null) {
      setRowError({ key, message: problems[0] ?? "Enter a start and an end time." });
      return;
    }
    createBreak.mutate(
      {
        orgId,
        shiftId: shift.id,
        name: breakFor.form.name.trim() === "" ? "Break" : breakFor.form.name.trim(),
        startMin,
        endMin,
      },
      { onSuccess: () => setBreakFor(null), onError: (e) => fail(key, e) },
    );
  }

  /* ⭐ EDITING A BREAK IN PLACE. The write has existed since this panel was
     built (`useUpdateBreak` -> `shift_breaks.update`) and nothing on screen
     reached it, so the only way to move a break by five minutes was to delete
     it and retype it -- which loses the name, and which is a DESTRUCTIVE action
     offered for a non-destructive intent.

     It validates exactly like the shift edit does: build the pattern as it
     stands, build it with this break moved, and report only the problems the
     MOVE is responsible for. `addedProblems` compares by (field, shift, break)
     coordinates, so a different break already sitting outside its shift does
     not block this one -- that was the defect found on 27 Aug. */
  function submitBreakEdit(pattern: PatternView, shift: ShiftView, brk: BreakView) {
    if (breakEdit === null) return;
    const key = `edit-break-${brk.id}`;
    clear(key);
    const startMin = timeMinutes(breakEdit.form.start);
    const endMin = timeMinutes(breakEdit.form.end);
    const existing = pattern.shifts.map(toShiftDraft);
    const edited = existing.map((sh) =>
      sh.id === shift.id
        ? {
            ...sh,
            breaks: sh.breaks.map((b) =>
              b.id === brk.id
                ? { id: b.id, name: breakEdit.form.name, startMin, endMin }
                : b,
            ),
          }
        : sh,
    );
    const problems = addedProblems(
      toPatternDraft(pattern, existing),
      toPatternDraft(pattern, edited),
    );
    if (problems.length > 0 || startMin === null || endMin === null) {
      setRowError({ key, message: problems[0] ?? "Enter a start and an end time." });
      return;
    }
    updateBreak.mutate(
      {
        breakId: brk.id,
        name: breakEdit.form.name.trim() === "" ? "Break" : breakEdit.form.name.trim(),
        startMin,
        endMin,
      },
      { onSuccess: () => setBreakEdit(null), onError: (e) => fail(key, e) },
    );
  }

  function applyAttachment(nodeId: string, current: string | null) {
    if (orgId === null) return;
    const key = `node-${nodeId}`;
    clear(key);
    const chosen = attachDraft[nodeId] ?? current ?? "";
    if (chosen === current || (chosen === "" && current === null)) return;
    const done = () => setAttachDraft((cur) => ({ ...cur, [nodeId]: chosen }));
    if (chosen === "") {
      detachPattern.mutate({ nodeId }, { onSuccess: done, onError: (e) => fail(key, e) });
      return;
    }
    attachPattern.mutate(
      { orgId, nodeId, templateId: chosen },
      { onSuccess: done, onError: (e) => fail(key, e) },
    );
  }

  function renderShift(pattern: PatternView, shift: ShiftView) {
    const editing = shiftEdit !== null && shiftEdit.id === shift.id;
    const adding = breakFor !== null && breakFor.shiftId === shift.id;
    return (
      <li className={styles.shiftRow} key={shift.id}>
        <div className={styles.shiftHead}>
          <span className={styles.shiftName}>{shift.name}</span>
          <span className={styles.shiftSpan}>{shift.span}</span>
          <span className={styles.meta}>{shift.duration}</span>
          {shift.crossesMidnight && <span className={styles.nextDayTag}>overnight</span>}
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.btn}
            onClick={() =>
              setShiftEdit(
                editing
                  ? null
                  : {
                      id: shift.id,
                      form: {
                        name: shift.name,
                        start: timeOf(shift.startMin),
                        end: timeOf(shift.endMin),
                      },
                    },
              )
            }
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() =>
              setBreakFor(adding ? null : { shiftId: shift.id, form: BLANK_BREAK })
            }
          >
            {adding ? "Cancel break" : "Add break"}
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            disabled={deleteShift.isPending}
            onClick={() => {
              clear(`shift-${shift.id}`);
              deleteShift.mutate(
                { shiftId: shift.id },
                { onError: (e) => fail(`shift-${shift.id}`, e) },
              );
            }}
          >
            Delete
          </button>
        </div>

        {editing && shiftEdit !== null && (
          <div className={styles.editRow}>
            <div className={styles.field}>
              <span className={styles.label}>Name</span>
              <input
                className={styles.input}
                aria-label="Shift name"
                value={shiftEdit.form.name}
                onChange={(e) =>
                  setShiftEdit({ id: shift.id, form: { ...shiftEdit.form, name: e.target.value } })
                }
              />
            </div>
            <TimeField
              label="Starts"
              value={shiftEdit.form.start}
              allowNextDay={false}
              onChange={(start) => setShiftEdit({ id: shift.id, form: { ...shiftEdit.form, start } })}
            />
            <TimeField
              label="Ends"
              value={shiftEdit.form.end}
              allowNextDay
              onChange={(end) => setShiftEdit({ id: shift.id, form: { ...shiftEdit.form, end } })}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={updateShift.isPending}
              onClick={() => submitShiftEdit(pattern, shift)}
            >
              Save
            </button>
          </div>
        )}

        {shift.problems.map((p) => (
          <p className={styles.problem} key={`${p.breakId}-${p.kind}-${p.otherBreakId ?? ""}`}>
            {p.message}
          </p>
        ))}
        {errorFor(`shift-${shift.id}`) !== null && (
          <p className={styles.rowError}>{errorFor(`shift-${shift.id}`)}</p>
        )}
        {errorFor(`edit-shift-${shift.id}`) !== null && (
          <p className={styles.rowError}>{errorFor(`edit-shift-${shift.id}`)}</p>
        )}

        {/* ⭐ A TABLE, NOT A SENTENCE. Break names, clock spans and durations are
            three columns a person reads DOWN -- "which one is the long one",
            "do these two collide" -- and a flex row put every column at a
            different x on every line, so nothing could be compared at a glance.
            The header row is drawn once per shift because the list it labels is
            nested two levels in; without it "15m" beside "08:00–08:15" reads as
            a second time rather than a duration. */}
        {shift.breaks.length > 0 && (
          <ul className={styles.breakList}>
            <li className={styles.breakHead} aria-hidden="true">
              <span>Break</span>
              <span>Clock</span>
              <span>Length</span>
              <span />
            </li>
            {shift.breaks.map((b) => {
              const editingBreak = breakEdit !== null && breakEdit.id === b.id;
              return (
                <li className={styles.breakRow} key={b.id}>
                  <span className={styles.breakName}>{b.name}</span>
                  <span className={styles.shiftSpan}>{b.span}</span>
                  <span className={styles.meta}>{b.duration}</span>
                  <span className={styles.breakActions}>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => {
                        clear(`edit-break-${b.id}`);
                        setBreakEdit(
                          editingBreak
                            ? null
                            : {
                                id: b.id,
                                shiftId: shift.id,
                                form: {
                                  name: b.name,
                                  start: timeOf(b.startMin),
                                  end: timeOf(b.endMin),
                                },
                              },
                        );
                      }}
                    >
                      {editingBreak ? "Cancel" : "Edit"}
                    </button>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      disabled={deleteBreak.isPending}
                      onClick={() => {
                        clear(`break-${b.id}`);
                        deleteBreak.mutate(
                          { breakId: b.id },
                          { onError: (e) => fail(`break-${b.id}`, e) },
                        );
                      }}
                    >
                      Remove
                    </button>
                  </span>
                  {editingBreak && breakEdit !== null && (
                    <div className={styles.editRow}>
                      <div className={styles.field}>
                        <span className={styles.label}>Name</span>
                        <input
                          className={styles.input}
                          aria-label="Break name"
                          value={breakEdit.form.name}
                          onChange={(e) =>
                            setBreakEdit({
                              ...breakEdit,
                              form: { ...breakEdit.form, name: e.target.value },
                            })
                          }
                        />
                      </div>
                      <TimeField
                        label="Starts"
                        value={breakEdit.form.start}
                        allowNextDay={shift.crossesMidnight}
                        onChange={(start) =>
                          setBreakEdit({ ...breakEdit, form: { ...breakEdit.form, start } })
                        }
                      />
                      <TimeField
                        label="Ends"
                        value={breakEdit.form.end}
                        allowNextDay={shift.crossesMidnight}
                        onChange={(end) =>
                          setBreakEdit({ ...breakEdit, form: { ...breakEdit.form, end } })
                        }
                      />
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        disabled={updateBreak.isPending}
                        onClick={() => submitBreakEdit(pattern, shift, b)}
                      >
                        Save
                      </button>
                    </div>
                  )}
                  {errorFor(`break-${b.id}`) !== null && (
                    <span className={styles.rowError}>{errorFor(`break-${b.id}`)}</span>
                  )}
                  {errorFor(`edit-break-${b.id}`) !== null && (
                    <span className={styles.rowError}>{errorFor(`edit-break-${b.id}`)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {adding && breakFor !== null && (
          <div className={styles.editRow}>
            <div className={styles.field}>
              <span className={styles.label}>Break name</span>
              <input
                className={styles.input}
                aria-label="Break name"
                value={breakFor.form.name}
                onChange={(e) =>
                  setBreakFor({ shiftId: shift.id, form: { ...breakFor.form, name: e.target.value } })
                }
              />
            </div>
            <TimeField
              label="Starts"
              value={breakFor.form.start}
              allowNextDay={shift.crossesMidnight}
              onChange={(start) => setBreakFor({ shiftId: shift.id, form: { ...breakFor.form, start } })}
            />
            <TimeField
              label="Ends"
              value={breakFor.form.end}
              allowNextDay={shift.crossesMidnight}
              onChange={(end) => setBreakFor({ shiftId: shift.id, form: { ...breakFor.form, end } })}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={createBreak.isPending}
              onClick={() => submitBreak(pattern, shift)}
            >
              Add break
            </button>
          </div>
        )}
        {errorFor(`add-break-${shift.id}`) !== null && (
          <p className={styles.rowError}>{errorFor(`add-break-${shift.id}`)}</p>
        )}
      </li>
    );
  }

  function renderPattern(pattern: PatternView) {
    const open = openId === pattern.id;
    const renaming = renameDraft !== null && renameDraft.id === pattern.id;
    const confirming = confirmId === pattern.id;
    return (
      <li className={open ? `${styles.patternRow} ${styles.patternRowOpen}` : styles.patternRow} key={pattern.id}>
        {/* ⚠️ IT HAS TO LOOK LIKE IT OPENS. This was a bare <button> styled with
            `border:0; background:none`, i.e. indistinguishable from the text in
            the column beside it — and the whole shift list of a pattern sits
            behind it. The maintainer found it by clicking on the off-chance. A caret
            that turns, and a name that underlines on hover and focus, is the
            smallest thing that says "there is more under here". */}
        <button
          type="button"
          className={styles.patternName}
          aria-expanded={open}
          onClick={() => setOpenId(open ? null : pattern.id)}
        >
          <span className={styles.caret} aria-hidden="true">
            {open ? "\u25be" : "\u25b8"}
          </span>
          <span className={styles.patternNameText}>{pattern.name}</span>
          <span className={styles.openHint}>{open ? "hide shifts" : "show shifts"}</span>
        </button>
        <span className={styles.owner}>{pattern.ownerLabel}</span>
        <span className={styles.meta}>
          {pattern.shifts.length === 1 ? "1 shift" : `${pattern.shifts.length} shifts`}
        </span>
        <span className={styles.meta}>
          {pattern.attachedCount === 1 ? "1 place" : `${pattern.attachedCount} places`}
        </span>
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.btn}
            title="Change its name or where it belongs"
            onClick={() =>
              setRenameDraft(
                renaming
                  ? null
                  : {
                      id: pattern.id,
                      name: pattern.name,
                      siteNodeId: pattern.siteNodeId ?? "",
                    },
              )
            }
          >
            {/* ⭐ "Edit", not "Rename" — D106. The draft this opens carries
                the pattern's name AND its "Owned by" scope, so the old label
                named half of it. Same defect as the products row, same fix. */}
            {renaming ? "Cancel" : "Edit"}
          </button>
        </div>

        {renaming && renameDraft !== null && (
          <div className={styles.confirm}>
            <input
              className={styles.input}
              aria-label="Pattern name"
              value={renameDraft.name}
              onChange={(e) => setRenameDraft({ ...renameDraft, name: e.target.value })}
            />
            {/* ⭐ AND WHERE IT BELONGS. Same gap as products and operators had:
                a picker on the create form and nothing on the edit, so the
                value was frozen at birth. Added here before it had to be
                reported a fourth time. */}
            <select
              className={styles.select}
              aria-label="Owned by"
              value={renameDraft.siteNodeId}
              onChange={(e) => setRenameDraft({ ...renameDraft, siteNodeId: e.target.value })}
            >
              {scopeChoices.map((o) => (
                <option key={o.value ?? "company"} value={o.value ?? ""}>
                  {indentedLabel(o)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={renamePattern.isPending}
              onClick={() => {
                const key = `rename-${pattern.id}`;
                clear(key);
                const others = view.patterns.filter((p) => p.id !== pattern.id).map((p) => p.name);
                const named = validatePatternDraft(
                  { id: pattern.id, name: renameDraft.name, shifts: [] },
                  others,
                ).problems.filter((p) => p.field === "pattern-name");
                if (named.length > 0) {
                  setRowError({ key, message: named[0].message });
                  return;
                }
                renamePattern.mutate(
                  {
                    templateId: pattern.id,
                    name: renameDraft.name.trim(),
                    siteNodeId: renameDraft.siteNodeId,
                  },
                  { onSuccess: () => setRenameDraft(null), onError: (e) => fail(key, e) },
                );
              }}
            >
              Save
            </button>
          </div>
        )}
        {errorFor(`rename-${pattern.id}`) !== null && (
          <p className={styles.rowError}>{errorFor(`rename-${pattern.id}`)}</p>
        )}

        {/* ⚠️ DELETE IS THE ONLY REMOVAL THERE IS. The maintainer's standing decision is
            that deactivating is the main action wherever a thing has an on/off
            flag — `shift_templates` has none, so there is nothing to deactivate
            here and this is the whole of it.

            ⭐ IT IS STILL OFFERED WHEN THE PATTERN IS ATTACHED, and the note
            below is a warning rather than a locked door. The server is the one
            that decides: `node_shift_templates`' FK carries no `ON DELETE`, so
            Postgres raises 23503 → `{kind:"StillInUse"}`. Hiding the button
            would mean this screen was guessing, and a guess that says "you
            can't" when the server would have said yes is a feature nobody can
            reach. The COUNT comes from this panel's own read of
            `node_shift_templates`, which is what lets the refusal say how many
            places are in the way instead of only that something is. */}
        {pattern.attachedCount > 0 && (
          <p className={styles.rowNote}>
            {`Attached to ${pattern.attachedCount} ${
              pattern.attachedCount === 1 ? "place" : "places"
            } — detach it below before deleting it.`}
          </p>
        )}
        {confirming ? (
          <div className={styles.confirm}>
            <span>{`Delete "${pattern.name}" and its shifts?`}</span>
            <button
              type="button"
              className={styles.dangerBtn}
              disabled={deletePattern.isPending}
              onClick={() => {
                const key = `delete-${pattern.id}`;
                clear(key);
                deletePattern.mutate(
                  { templateId: pattern.id },
                  {
                    onSuccess: () => setConfirmId(null),
                    onError: (e) =>
                      setRowError({
                        key,
                        message:
                          isSchedulerError(e) && e.kind === "StillInUse"
                            ? `${pattern.attachedCount} ${
                                pattern.attachedCount === 1 ? "place uses" : "places use"
                              } this pattern, so it can't be deleted. Detach it below first.`
                            : errorText(e),
                      }),
                  },
                );
              }}
            >
              Delete
            </button>
            <button type="button" className={styles.btn} onClick={() => setConfirmId(null)}>
              Keep
            </button>
          </div>
        ) : (
          <div className={styles.confirm}>
            <button type="button" className={styles.linkBtn} onClick={() => setConfirmId(pattern.id)}>
              Delete this pattern
            </button>
          </div>
        )}
        {errorFor(`delete-${pattern.id}`) !== null && (
          <p className={styles.rowError}>{errorFor(`delete-${pattern.id}`)}</p>
        )}

        {pattern.overlaps.length > 0 && (
          <p className={styles.problem}>
            {/* Counted, not "two". `overlaps` is a list of PAIRS, and four
                shifts in a row can produce four of them — a fixed "Two of
                these shifts" then under-reports the mess by half. */}
            {pattern.overlaps.length === 1
              ? "Two of these shifts share minutes. Fix them before adding another."
              : `${pattern.overlaps.length} pairs of these shifts share minutes. Fix them before adding another.`}
          </p>
        )}

        {open && (
          <div className={styles.detail}>
            <h3 className={styles.h3}>Shifts in this pattern</h3>
            {pattern.shifts.length === 0 ? (
              <p className={styles.status}>No shifts yet.</p>
            ) : (
              <ul className={styles.shiftList}>
                {pattern.shifts.map((s) => renderShift(pattern, s))}
              </ul>
            )}
            <div className={styles.editRow}>
              <div className={styles.field}>
                <span className={styles.label}>New shift</span>
                <input
                  className={styles.input}
                  aria-label="New shift name"
                  placeholder="Nights"
                  value={shiftForm.name}
                  onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })}
                />
              </div>
              <TimeField
                label="Starts"
                value={shiftForm.start}
                allowNextDay={false}
                onChange={(start) => setShiftForm({ ...shiftForm, start })}
              />
              <TimeField
                label="Ends"
                value={shiftForm.end}
                allowNextDay
                onChange={(end) => setShiftForm({ ...shiftForm, end })}
              />
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={createShift.isPending || orgId === null}
                onClick={() => submitShift(pattern)}
              >
                Add shift
              </button>
            </div>
            {errorFor(`add-shift-${pattern.id}`) !== null && (
              <p className={styles.rowError}>{errorFor(`add-shift-${pattern.id}`)}</p>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>Shift patterns</h2>
        <p className={styles.hint}>
          A pattern is the set of shifts a place runs. Everything here is a clock time; a shift
          that runs past midnight shows its end marked +1d, so 22:00–06:00 +1d is a night shift.
        </p>

        {pending && <p className={styles.status}>Loading shift patterns…</p>}
        {!pending && query.isError && (
          <p className={styles.errorLine}>{errorText(query.error)}</p>
        )}

        {!pending && !query.isError && (
          <>
            <div className={styles.toolbar}>
              <div className={styles.field}>
                <span className={styles.label}>New pattern</span>
                <input
                  className={styles.input}
                  aria-label="New pattern name"
                  placeholder="Standard 3-shift"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Owned by</span>
                {/* ⚠️ WHO OWNS IT DECIDES WHO MAY EDIT IT, and "Company-wide"
                    is not a neutral default: `site_node_id IS NULL` can only be
                    created and edited by a COMPANY admin (0023's INSERT policy
                    is `app_is_admin() or (site_node_id is not null and
                    app_is_admin_for(site_node_id))`). Only ROOT nodes are
                    offered, because the `shift_templates_check_site` trigger
                    refuses anything else. */}
                <select
                  className={styles.select}
                  aria-label="Owning site"
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                >
                  {scopeChoices.map((o) => (
                    <option value={o.value ?? ""} key={o.value ?? "company"}>
                      {indentedLabel(o)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={createPattern.isPending || orgId === null}
                onClick={submitNewPattern}
              >
                Create
              </button>
            </div>
            {errorFor("new") !== null && <p className={styles.errorLine}>{errorFor("new")}</p>}

            {view.patterns.length === 0 ? (
              <p className={styles.status}>No shift patterns yet.</p>
            ) : (
              <>
                <div className={styles.listHead}>
                  <span>Pattern</span>
                  <span>Owned by</span>
                  <span>Shifts</span>
                  {/* "Attached to", not "Used by": this counts DIRECT rows in
                      `node_shift_templates`, and `resolve_shift_template` is
                      nearest-ancestor-wins, so every descendant without an
                      attachment of its own also USES the pattern. The delete
                      warning below is right to count only the direct rows --
                      the FK counts those -- but the column header was making a
                      claim the panel’s own hint contradicts. */}
                  <span>Attached to</span>
                  <span />
                </div>
                <ul className={styles.list}>{view.patterns.map(renderPattern)}</ul>
              </>
            )}

            {/* Reported rather than swallowed: a silently shortened list is
                indistinguishable from a company with fewer patterns in it. */}
            {view.skipped > 0 && (
              <p className={styles.skippedLine}>
                {view.skipped === 1
                  ? "1 row couldn't be read and isn't shown."
                  : `${view.skipped} rows couldn't be read and aren't shown.`}
              </p>
            )}
          </>
        )}
      </section>

      {!pending && !query.isError && (
        <section className={styles.card}>
          <h2 className={styles.h2}>Where patterns apply</h2>
          {/* ⚠️ ATTACHING IS A DIFFERENT PERMISSION FROM OWNING. This list is
              gated by `app_is_admin_for(node_id)`, which is why a site admin
              can put the company-wide pattern on their own plant without being
              able to rename it. And an attachment here is not the last word on
              which pattern a place RUNS: `resolve_shift_template` walks up the
              ltree and the NEAREST ancestor wins, so a place with nothing of
              its own inherits from above. */}
          <p className={styles.hint}>
            One pattern per place. A place with nothing of its own runs the pattern attached to the
            nearest place above it.
          </p>
          <ul className={styles.nodeList}>
            {view.nodes.map((n) => {
              const chosen = attachDraft[n.nodeId] ?? n.templateId ?? "";
              const changed = chosen !== (n.templateId ?? "");
              return (
                <li className={styles.nodeRow} key={n.nodeId}>
                  <span
                    className={styles.nodeName}
                    style={{ paddingLeft: `${n.depth * 0.75}rem` }}
                  >
                    {n.nodeName}
                  </span>
                  <select
                    className={styles.nodeSelect}
                    aria-label={`Shift pattern for ${n.nodeName}`}
                    value={chosen}
                    onChange={(e) =>
                      setAttachDraft((cur) => ({ ...cur, [n.nodeId]: e.target.value }))
                    }
                  >
                    <option value="">Inherit from above</option>
                    {view.patterns.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <div className={styles.nodeActions}>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={!changed || attachPattern.isPending || detachPattern.isPending}
                      onClick={() => applyAttachment(n.nodeId, n.templateId)}
                    >
                      Apply
                    </button>
                  </div>
                  {errorFor(`node-${n.nodeId}`) !== null && (
                    <p className={styles.rowError}>{errorFor(`node-${n.nodeId}`)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
