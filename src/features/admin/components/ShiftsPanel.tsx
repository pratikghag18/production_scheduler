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
   ⭐⭐ WHICH PLANT THIS PANEL IS SHOWING — roadmap 1(c).

   The maintainer, 31 Aug: *"for the system admin, may be we need a filter for
   plants in all the sub tabs."* The CONTROL is `AdminPage`'s and there is
   exactly one of it; this panel only reads the choice through `usePlantFilter`
   and applies it. It therefore still TAKES NO PROPS, which is the invariant
   the top of this header states.

   ⚠️⚠️ AND THE FILTER RUNS ON `path`, WHICH IS NOT A STYLE PREFERENCE HERE —
   IT IS THE ONLY THING THAT WORKS IN THIS FILE. `patternRows` reshapes nodes
   into `NodeAttachmentView`, which has no `parentId` at all (see
   `shiftDraft.ts`), so a parent-walking filter cannot run over `view.nodes`.
   The ROOTS therefore come from the RAW `ShiftNodeRow[]` the query returned,
   which still carries the column `readablePlants` needs, and the trimming is
   done by `nodesInPlant` / `rowsInPlant`, which need only `path`.

   ⭐ IT NARROWS THE FORMS TOO, not only the lists (`plantFilter.ts` decision
   3): both scope pickers offer the chosen plant's subtree and nothing else.
   What you see is what you can create in — the alternative lets somebody
   create a pattern into a plant they have filtered away and then watch it not
   appear, which is silent hiding in a new costume.

   ⚠️ EVERYTHING TRIMMED IS COUNTED UNDERNEATH IT. `scope.ts`'s header records
   why: hiding is invisible and permanent, and a list that quietly shrank looks
   exactly like a list of things nobody created.

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
import { indentedLabel, scopeIndex, scopeOptions } from "../lib/scope";
import { nodesInPlant, rowsInPlant } from "../lib/plantFilter";
import { usePlantFilter } from "../hooks/usePlantFilter";
import {
  useAttachPattern,
  useCreateBreak,
  useCreatePattern,
  useCreateShift,
  useDeleteBreak,
  useUpdateBreak,
  useDeleteShift,
  useDetachPattern,
  useRenamePattern,
  useShiftPatterns,
  useUpdateShift,
} from "../hooks/useShifts";
import { DeleteDialog } from "./DeleteDialog";
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
    breaks: s.breaks.map((b): BreakDraft => ({
      id: b.id,
      name: b.name,
      startMin: b.startMin,
      endMin: b.endMin,
    })),
  };
}

function toPatternDraft(p: PatternView, shifts: readonly ShiftDraft[]): PatternDraft {
  return { id: p.id, name: p.name, shifts };
}

/* `addedProblems` now lives in `../lib/shiftDraft` — it is pure, it is the
   piece that carried the 27-Aug defect, and in here it had no test that could
   reach it. Group W pins it. */

function errorText(e: unknown): string {
  return isSchedulerError(e)
    ? describeSchedulerError(e)
    : "Something went wrong. Please try again.";
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

  /* -- which plant this panel is showing (roadmap 1(c); see the header) ----- */

  // ⚠️ THE RAW ROWS, NOT `view.nodes`. `ShiftNodeRow` carries `parentId`, and
  // `readablePlants` needs that column to tell a root from a line whose parent
  // this reader simply cannot see. `patternRows` throws it away a few lines
  // below and there is no way to get it back from what it returns.
  //
  // ⚠️ The `null`s are the rows `parseShiftNodeRow` refused. `fetchShiftPatterns`
  // leaves them in the array on purpose so `patternRows` can COUNT them into
  // `view.skipped` — the line at the bottom of the first card. They are dropped
  // here rather than coerced: a node that could not be read is not a plant, and
  // it must not become a filter option or an owner in `nodesById`.
  const readableNodes = (query.data?.nodes ?? []).filter((n) => n !== null);
  const plant = usePlantFilter(readableNodes);
  // Rebuilt every render, like `view` and `scopeChoices` around it — a Map over
  // a couple of dozen nodes, and memoising it here would only claim a stability
  // nothing in this component depends on.
  const nodesById = scopeIndex(readableNodes);

  // The nodes are trimmed BY PATH because they have nothing else left to trim
  // by; the patterns by their owner, which is what `rowsInPlant` resolves
  // through `nodesById`. Both counts are rendered underneath their own list.
  const visibleNodes = nodesInPlant(view.nodes, plant.choice, plant.plants);
  const hiddenNodes = view.nodes.length - visibleNodes.length;
  const visiblePatterns = rowsInPlant(view.patterns, plant.choice, plant.plants, nodesById);
  const hiddenPatterns = view.patterns.length - visiblePatterns.length;

  // ⭐ EVERY NODE, NOT JUST ROOTS (0025 / D103). `patternRows` already returns
  // every node with its depth and path for the attachment card below, so the
  // owner picker and the attachment picker now offer the same tree — which is
  // the point: a pattern owned by Assembly and attached to a cell under
  // Assembly is the ordinary case, and until 0025 the first half of that
  // sentence could not be said.
  //
  // ⭐ AND `visibleNodes`, NOT `view.nodes`, SINCE 1(c) — decision 3: the
  // filter narrows the FORMS too. ⚠️ This is a VIEW narrowing sitting on top of
  // a PERMISSION one and the two must stay distinguishable: `scopeOptions`'
  // `canEdit` says what the server will accept and is not reversible, while the
  // cut below is a preference the reader can undo in the header. Collapsing
  // them would make widening the filter silently widen what the form claims
  // this person may write.
  //
  // ⚠️ The fabricated `parentId: null` is the shape trap this panel is named
  // for in `plantFilter.ts` — it is a lie `scopeOptions` never reads (it sorts
  // and counts `path`), and it is exactly why the plant cut above had to be
  // taken from the raw rows instead of from here.
  const scopeChoices = scopeOptions(
    visibleNodes.map((n) => ({ id: n.nodeId, name: n.nodeName, parentId: null, path: n.path })),
  );

  // ⭐ RESOLVE-OR-FALL-BACK, THE HOUSE IDIOM (`ownerValue` in `ProductsPanel`,
  // `resolveSelectedShape` in `lib/shapePicker`): the picker's value is kept
  // legal by construction rather than by an effect that repairs it afterwards.
  // Without this, choosing an owner and then changing the plant left `newOwner`
  // naming a node with no `<option>` behind it — the control goes blank while
  // the state still holds the old id, and Create sends a site the reader can no
  // longer see. `""` survives only when the list itself is empty (the structure
  // read did not land), and `submitNewPattern` already refuses that.
  const ownerValue = scopeChoices.some((o) => o.value === newOwner)
    ? newOwner
    : (scopeChoices[0]?.value ?? "");

  /* ⭐⭐ EVERY OPEN EDITOR IS RESOLVED AGAINST THE VISIBLE LIST, NOT PRUNED BY
     AN EFFECT. All three of these hold a PATTERN id, and the filter can take
     that pattern off screen between two renders — which would leave a rename
     box, or worse an armed delete dialog, open over a row nobody can see.

     ⚠️ RESOLVED, NOT CLEARED, AND THAT IS THE DIFFERENCE THAT MATTERS. The
     plant choice is a VIEW choice and reversible (`plantFilter.ts`); throwing
     away what somebody had typed because they glanced at another plant would
     make a reversible control destructive. The editor goes away while its row
     is hidden and comes back with the row.

     `shiftEdit`, `breakFor` and `breakEdit` need no line of their own: they
     render only inside the open pattern's detail, so resolving `openPatternId`
     takes them off screen with it. Shift and break ids are unique across
     patterns, so nothing of theirs can land on a different row. */
  const visiblePatternIds = new Set(visiblePatterns.map((p) => p.id));
  const openPatternId = openId !== null && visiblePatternIds.has(openId) ? openId : null;
  const activeRename =
    renameDraft !== null && visiblePatternIds.has(renameDraft.id) ? renameDraft : null;
  const activeConfirmId = confirmId !== null && visiblePatternIds.has(confirmId) ? confirmId : null;

  // ⚠️ THE RENAME DRAFT CARRIES A NODE ID TOO, and the "Owned by" picker it
  // feeds is now narrowed. A visible pattern's owner is inside the chosen plant
  // by construction — that is what `rowsInPlant` selected on — so this should
  // only bite when that function FAILS OPEN on an owner this reader cannot
  // resolve. It is resolved anyway, and it is resolved to the value the
  // `<select>` will actually display: the control and the write have to agree,
  // or Save quietly stores an owner different from the one on screen.
  const renameOwnerValue =
    activeRename === null
      ? ""
      : scopeChoices.some((o) => o.value === activeRename.siteNodeId)
        ? activeRename.siteNodeId
        : (scopeChoices[0]?.value ?? "");

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
    // ⚠️ `view.patterns`, NOT `visiblePatterns` — uniqueness is a fact about
    // the company, not about what the plant filter happens to be showing.
    const named = validatePatternDraft(
      draft,
      view.patterns.map((p) => p.name),
    ).problems.filter((p) => p.field === "pattern-name");
    if (named.length > 0) {
      setRowError({ key: "new", message: named[0].message });
      return;
    }
    createPattern.mutate(
      // ⭐ 0028: `""` was company-wide and is now "nothing chosen"; the picker
      // has no empty entry to select, so this can only be empty when the
      // structure read did not land, and the server refuses it with a sentence.
      //
      // ⚠️ `ownerValue`, NOT `newOwner`: what the `<select>` is showing, which
      // after a plant change is not always what the state still holds.
      { orgId, name: newName.trim(), siteNodeId: ownerValue },
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
            breaks: [...s.breaks, { id: null, name: breakFor.form.name, startMin, endMin }],
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
              b.id === brk.id ? { id: b.id, name: breakEdit.form.name, startMin, endMin } : b,
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

  /**
   * @param chosen what the row's `<select>` is SHOWING — resolved by the row
   *   itself, not re-read from `attachDraft` here. ⚠️ It used to be re-read,
   *   and that is precisely how a draft naming a pattern the plant filter has
   *   since removed would get sent: the control had already fallen back to
   *   something else, and Apply sent the invisible id anyway. One resolution,
   *   at the place that renders it.
   */
  function applyAttachment(nodeId: string, current: string | null, chosen: string) {
    if (orgId === null) return;
    const key = `node-${nodeId}`;
    clear(key);
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
            onClick={() => setBreakFor(adding ? null : { shiftId: shift.id, form: BLANK_BREAK })}
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
              onChange={(start) =>
                setShiftEdit({ id: shift.id, form: { ...shiftEdit.form, start } })
              }
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
                  setBreakFor({
                    shiftId: shift.id,
                    form: { ...breakFor.form, name: e.target.value },
                  })
                }
              />
            </div>
            <TimeField
              label="Starts"
              value={breakFor.form.start}
              allowNextDay={shift.crossesMidnight}
              onChange={(start) =>
                setBreakFor({ shiftId: shift.id, form: { ...breakFor.form, start } })
              }
            />
            <TimeField
              label="Ends"
              value={breakFor.form.end}
              allowNextDay={shift.crossesMidnight}
              onChange={(end) =>
                setBreakFor({ shiftId: shift.id, form: { ...breakFor.form, end } })
              }
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
    // The RESOLVED ids, not the raw state — see where they are derived. A
    // pattern the plant filter has hidden never reaches this function anyway;
    // resolving here is what stops the editor re-appearing over the wrong row
    // if the filter and the list ever disagree for a render.
    const open = openPatternId === pattern.id;
    const renaming = activeRename !== null && activeRename.id === pattern.id;
    const confirming = activeConfirmId === pattern.id;
    return (
      <li
        className={open ? `${styles.patternRow} ${styles.patternRowOpen}` : styles.patternRow}
        key={pattern.id}
      >
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

        {renaming && activeRename !== null && (
          <div className={styles.confirm}>
            <input
              className={styles.input}
              aria-label="Pattern name"
              value={activeRename.name}
              onChange={(e) => setRenameDraft({ ...activeRename, name: e.target.value })}
            />
            {/* ⭐ AND WHERE IT BELONGS. Same gap as products and operators had:
                a picker on the create form and nothing on the edit, so the
                value was frozen at birth. Added here before it had to be
                reported a fourth time. */}
            {/* ⚠️ `renameOwnerValue`, not the draft's own field: the list this
                picker offers is now narrowed to the chosen plant, and a value
                with no option behind it displays as something else while the
                state still holds the old id. See where it is resolved. */}
            <select
              className={styles.select}
              aria-label="Owned by"
              value={renameOwnerValue}
              onChange={(e) => setRenameDraft({ ...activeRename, siteNodeId: e.target.value })}
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
                // ⚠️ `view.patterns`, NOT `visiblePatterns`. This is the
                // uniqueness check, and a name is taken whether or not the
                // filter is currently showing the pattern that took it.
                // Checking the trimmed list would let two patterns be given
                // the same name from two different plant views and leave the
                // server to refuse it with a less useful sentence.
                const others = view.patterns.filter((p) => p.id !== pattern.id).map((p) => p.name);
                const named = validatePatternDraft(
                  { id: pattern.id, name: activeRename.name, shifts: [] },
                  others,
                ).problems.filter((p) => p.field === "pattern-name");
                if (named.length > 0) {
                  setRowError({ key, message: named[0].message });
                  return;
                }
                renamePattern.mutate(
                  {
                    templateId: pattern.id,
                    name: activeRename.name.trim(),
                    siteNodeId: renameOwnerValue,
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

        {/* ⚠️ 0029 MADE THE SENTENCE THAT USED TO BE HERE FALSE. It read
            "detach it below before deleting it", because `node_shift_templates`'
            FK carried no `ON DELETE` and a pattern in use raised 23503.
            Migration 0029 gives that FK `ON DELETE CASCADE`: deleting a pattern
            now takes its attachments with it, and telling somebody to do work
            the database no longer needs is worse than saying nothing. The
            COUNT stays — it is this panel's own read of
            `node_shift_templates` and it is useful before the dialog opens —
            and the confirmation names the same number from the server.

            ⚠️ AND THERE IS STILL NO DEACTIVATE HERE. 0029 gives
            `shift_templates` an `active` column so all four owned lists mean
            the same thing, but nothing reads or writes it yet: the column is
            in the schema and the control is owed. Offering a Deactivate button
            that changed a flag no screen renders would be worse than the gap.
            See docs/roadmap.md. */}
        {pattern.attachedCount > 0 && (
          <p className={styles.rowNote}>
            {`Attached to ${pattern.attachedCount} ${
              pattern.attachedCount === 1 ? "place" : "places"
            }.`}
          </p>
        )}
        {confirming ? (
          <DeleteDialog
            kind="shift_template"
            id={pattern.id}
            name={pattern.name}
            onCancel={() => setConfirmId(null)}
            onDeleted={(message) => {
              setConfirmId(null);
              setRowError({ key: `delete-${pattern.id}`, message });
            }}
            onFailed={(message) => setRowError({ key: `delete-${pattern.id}`, message })}
          />
        ) : (
          <div className={styles.confirm}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                clear(`delete-${pattern.id}`);
                setConfirmId(pattern.id);
              }}
            >
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
          A pattern is the set of shifts a place runs. Everything here is a clock time; a shift that
          runs past midnight shows its end marked +1d, so 22:00–06:00 +1d is a night shift.
        </p>

        {pending && <p className={styles.status}>Loading shift patterns…</p>}
        {!pending && query.isError && <p className={styles.errorLine}>{errorText(query.error)}</p>}

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
                {/* ⚠️ `ownerValue`, not `newOwner`: the list is narrowed to the
                    chosen plant (decision 3), so the raw state can name a node
                    that is no longer on offer. See where it is resolved. */}
                <select
                  className={styles.select}
                  aria-label="Owning site"
                  value={ownerValue}
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

            {visiblePatterns.length === 0 ? (
              // ⚠️ TWO DIFFERENT EMPTY LISTS AND TWO DIFFERENT SENTENCES.
              // "No shift patterns yet." over a list the filter emptied is a
              // false statement about the company, and it is the exact failure
              // `scope.ts` names — a list that quietly shrank reading as a list
              // of things nobody created. The count underneath says how many.
              <p className={styles.status}>
                {view.patterns.length === 0
                  ? "No shift patterns yet."
                  : `No shift patterns in ${plant.label}.`}
              </p>
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
                <ul className={styles.list}>{visiblePatterns.map(renderPattern)}</ul>
              </>
            )}

            {/* ⚠️ TRIMMED, NOT SILENT — and named by `plant.label` rather than
                by the word "plant". The top level of the hierarchy is whatever
                this company called it, and `OperatorsPanel`'s own footnote
                makes the same point: another org's tree may say "Site" or
                "Works". The label is never blank, "All plants" included, and
                in that state this count is zero and the line does not render. */}
            {hiddenPatterns > 0 && (
              <p className={styles.footnote}>
                {hiddenPatterns === 1
                  ? `1 pattern outside ${plant.label} is not shown.`
                  : `${hiddenPatterns} patterns outside ${plant.label} are not shown.`}
              </p>
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
            {visibleNodes.map((n) => {
              /* ⭐ THE OPTIONS ARE THE VISIBLE PATTERNS PLUS, IF IT IS NOT
                 AMONG THEM, THE ONE THIS PLACE IS ACTUALLY RUNNING. A row that
                 dropped its own attachment from the list would render as
                 "Inherit from above" — a positive claim about this place that
                 is simply false, and one click from becoming true. Attaching
                 needs `app_is_admin_for(node_id)` and says nothing about who
                 owns the pattern, so a company admin can and does put one
                 plant's pattern on another's node; this is that case. */
              const options =
                n.templateId === null || visiblePatternIds.has(n.templateId)
                  ? visiblePatterns
                  : [...visiblePatterns, ...view.patterns.filter((p) => p.id === n.templateId)];

              /* ⚠️⚠️ THE DRAFT IS RESOLVED AGAINST THOSE OPTIONS, NOT TRUSTED.
                 `attachDraft` is keyed by node id and holds a PATTERN id, and
                 the filter can remove that pattern while the draft survives.
                 A `<select>` whose value matches no option shows the first one
                 instead — so the row would read "Inherit from above" while the
                 state still said "Nights", `changed` would be true, and Apply
                 would send the pattern nobody could see. Falling back to what
                 is attached today makes the control, the state and the write
                 the same answer. */
              const drafted = attachDraft[n.nodeId];
              const chosen =
                drafted !== undefined && (drafted === "" || options.some((p) => p.id === drafted))
                  ? drafted
                  : (n.templateId ?? "");
              const changed = chosen !== (n.templateId ?? "");
              return (
                <li className={styles.nodeRow} key={n.nodeId}>
                  <span className={styles.nodeName} style={{ paddingLeft: `${n.depth * 0.75}rem` }}>
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
                    {options.map((p) => (
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
                      onClick={() => applyAttachment(n.nodeId, n.templateId, chosen)}
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
          {/* ⚠️ TRIMMED, NOT SILENT. This is the largest node-derived table on
              the admin screen and the one a system admin most wants cut down,
              which is exactly why it is also the one where a quiet cut would be
              hardest to notice. "Places" rather than "nodes" — the word the
              rest of this panel uses ("Attached to 3 places"). */}
          {hiddenNodes > 0 && (
            <p className={styles.footnote}>
              {hiddenNodes === 1
                ? `1 place outside ${plant.label} is not shown.`
                : `${hiddenNodes} places outside ${plant.label} are not shown.`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
