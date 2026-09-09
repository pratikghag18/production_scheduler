import { useMemo, useState } from "react";
import type { BoardOperator, Skill, BoardNode } from "@/lib/api";
import { absenceGaps, type AbsenceRow } from "@/lib/absence";
import type { IndexedAssignment } from "../lib/boardIndex";
import { isFullyAllocated } from "../lib/geometry";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { PanelToggle } from "@/components/PanelToggle";
import fieldStyles from "@/components/Field.module.css";
import styles from "./OperatorPanel.module.css";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Left operator panel, read-only half (brief §8). Ported from the mockup's
 * `renderPanel`, with real-data substitutions: `isFullyAllocated` now
 * compares against the *loaded* window and `capacityCap` (a fraction)
 * instead of the mockup's hardcoded Tue 06:00-22:00 test window and `100`.
 *
 * P1-4e D65: each chip is now also a drag SOURCE — `onPointerDown` starts a
 * "panel" drag via `dragApi.beginPanelDrag`, exactly like every other
 * draggable element on the board routes through the one shared gesture
 * state machine (D29); this file never tracks pointer state itself. Uses
 * `setPointerCapture`-backed handlers, so `onPointerMove`/`onPointerUp` are
 * wired on the chip itself (D33: capture always routes back to the
 * originating element regardless of what's visually under the pointer).
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ R-346: TWO LISTS, NOT ONE. The maintainer, 6 Sept: *"If a operator is
 * assigned to higher hierarchy they should automatically become available to
 * all lower hierarchy within that hierarchy ... That should be the default
 * behaviour. For other operators in the plant we need to give an option to the
 * supervisor to click through something so show remaining operators so they can
 * make that decision to assign someone outside of that area."*
 *
 * So the panel opens on the people whose home covers this board's place (or
 * sits inside it), and the rest of the PLANT — never another plant, R-345 —
 * waits behind one control. Dragging one of those onto a cell is not a special
 * path: it starts the same panel drag, and the create pop-up it opens marks
 * them and asks for the D113 reason, exactly as it would for anyone the cell
 * does not cover.
 *
 * ⚠️ THE SPLIT IS DECIDED IN `BoardPage`, from `lib/outsideArea.ts`. This file
 * renders a decision; it does not make one. That is the same arrangement as
 * `requiredSkills` and `outsideAreaOperatorIds` in the pop-ups, and it is why
 * the panel and the pickers cannot disagree about who is a default offer.
 */
export function OperatorPanel({
  operators,
  hereOperatorIds,
  absences = [],
  skillById,
  nodeById,
  assignmentsByOperator,
  windowStart,
  windowMinutes,
  zone,
  capacityCap,
  open,
  onToggleOpen,
  draggingOperatorId,
  dragApi,
}: {
  /**
   * ⭐ THE PLANT'S PEOPLE, AS THE SERVER SENT THEM (`operatorPool` in
   * `BoardPage`, migration 0058). Not a client-side cut: the one this replaced
   * kept only people whose owner node was on this board, and a supervisor
   * granted a line has no node for the plant her people are homed at, so she
   * saw an empty panel.
   */
  operators: BoardOperator[];
  /**
   * R-346: of `operators`, the ones offered HERE by default — home covers this
   * board's place, or sits inside it. Everyone else in `operators` is "the rest
   * of the plant" and appears only after the control below is pressed.
   */
  hereOperatorIds: ReadonlySet<string>;
  /**
   * R-357: every absence the board can see (RLS-scoped to this board's people
   * upstream, so nothing here is filtered by grant). The chip is marked when the
   * person is on leave for ANY part of the shown window — `absenceGaps` answers
   * exactly that overlap, the same predicate the server refuses on. Optional
   * with an empty default so a test with no absences renders the pre-R-357 panel.
   */
  absences?: readonly AbsenceRow[];
  skillById: Map<string, Skill>;
  nodeById: Map<string, BoardNode>;
  assignmentsByOperator: Map<string, IndexedAssignment[]>;
  windowStart: Date;
  windowMinutes: number;
  zone?: string;
  capacityCap: number;
  open: boolean;
  onToggleOpen: () => void;
  /** P1-4e D65: the operator id of the in-flight panel drag, if any — its
   *  own source chip dims (mockup's `.chip.drag-src`) while `BoardPage`
   *  renders the pointer-following ghost. `null`/`undefined` outside a
   *  panel drag. */
  draggingOperatorId?: string | null;
  dragApi: {
    beginPanelDrag: (operator: BoardOperator, e: React.PointerEvent) => void;
    updatePanelDrag: (e: React.PointerEvent) => void;
    endPanelDrag: (e: React.PointerEvent) => void;
    cancelDrag: (e?: React.PointerEvent) => void;
  };
}) {
  const [showOthers, setShowOthers] = useState(false);

  // R-357: who is on leave for ANY part of the shown window. The window is the
  // board's whole span — [windowStart, windowStart + windowMinutes) — and
  // `absenceGaps` returns a hit exactly when an absence overlaps the days it
  // touches, so this is the same overlap the server would refuse a placement on.
  const absentIds = useMemo(() => {
    const end = addMinutes(windowStart, windowMinutes);
    const ids = new Set<string>();
    for (const o of operators) {
      if (absenceGaps(absences, o.id, { start: windowStart, end }) !== null) ids.add(o.id);
    }
    return ids;
    // The window instants are what the answer turns on; key on their time.
  }, [operators, absences, windowStart.getTime(), windowMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(
    () =>
      operators.filter((o) => o.active).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [operators],
  );
  const here = useMemo(
    () => visible.filter((o) => hereOperatorIds.has(o.id)),
    [visible, hereOperatorIds],
  );
  const elsewhere = useMemo(
    () => visible.filter((o) => !hereOperatorIds.has(o.id)),
    [visible, hereOperatorIds],
  );

  // F-125: every chip's tooltip `title`, computed once per change instead of
  // once per render. Before this memo, `chip()` built the string in render —
  // 5,760 assignments' worth on the 384-cell profiled board, ~4
  // `Intl.DateTimeFormat` constructions each (`formatFull` alone is three:
  // `formatDayLabel`, its inner `named`, and `formatClock`) — and did it
  // again on EVERY render, including the settle after a single drag that
  // changes one assignment, which measured 3.6-4.2 s. `OperatorPanel` owned
  // 64% of the board's inclusive wait by that path. Keyed the same shape as
  // `absentIds` above (`windowStart.getTime()`, not the `Date` object, so a
  // same-instant re-render doesn't invalidate the cache).
  const titles = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const [operatorId, mine] of assignmentsByOperator) {
      m.set(
        operatorId,
        mine.length
          ? mine
              .map((a) => {
                const nodeName = nodeById.get(a.nodeId)?.name ?? a.nodeId;
                return `${nodeName} · ${formatFull(addMinutes(windowStart, a.startMin), undefined, zone)}–${formatClock(addMinutes(windowStart, a.endMin), zone)} · ${a.efficiencyPercent}%`;
              })
              .join("\n")
          : undefined,
      );
    }
    return m;
    // The window instant is what the strings turn on; key on its time.
  }, [assignmentsByOperator, nodeById, windowStart.getTime(), zone]); // eslint-disable-line react-hooks/exhaustive-deps

  function chip(o: BoardOperator, outside: boolean) {
    const mine = assignmentsByOperator.get(o.id) ?? [];
    const full = isFullyAllocated(mine, windowMinutes, capacityCap);
    const title = titles.get(o.id);
    return (
      <div
        key={o.id}
        className={`${styles.chip} ${full ? styles.full : ""} ${draggingOperatorId === o.id ? styles.dragSrc : ""}`}
        title={title}
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={(e) => dragApi.beginPanelDrag(o, e)}
        onPointerMove={dragApi.updatePanelDrag}
        onPointerUp={dragApi.endPanelDrag}
        onPointerCancel={dragApi.cancelDrag}
      >
        <span className={styles.avatar}>{initials(o.displayName)}</span>
        <span className={styles.nm}>{o.displayName}</span>
        {/* R-346: said on the chip itself, so the mark travels with the person
            rather than depending on where the list happens to be scrolled. The
            wording is the panel's plain half of the pop-ups' "not from this
            area (override)" — the panel asks for nothing, the drop does. */}
        {outside && <span className={styles.outsideTag}>not from this area</span>}
        {/* R-357: the plain half of the pop-ups' "On leave" line — the panel
            says who is away over the shown window; placing them is where the
            warning or the refusal actually fires. */}
        {absentIds.has(o.id) && <span className={styles.leaveTag}>on leave</span>}
        {o.skillIds.map((sid) => {
          const skill = skillById.get(sid);
          return skill ? (
            <span key={sid} className={styles.sk}>
              {skill.name}
            </span>
          ) : null;
        })}
        {mine.length > 0 && <span className={styles.pill}>{mine.length}</span>}
      </div>
    );
  }

  return (
    <aside className={`${styles.panel} ${open ? "" : styles.collapsed}`} aria-label="Operators">
      <div className={styles.panelHd}>
        <span className={styles.lbl}>OPERATORS</span>
        <PanelToggle
          collapsed={!open}
          onToggle={onToggleOpen}
          label="operators"
          className={styles.toggle}
        />
      </div>
      <div className={styles.list}>
        {here.map((o) => chip(o, false))}
        {/* ⚠️ ABSENT WHEN THERE IS NOBODY BEHIND IT. On a plant admin's board
            every person in the plant is a default offer, so a control reading
            "(0)" would be a door onto an empty room. */}
        {elsewhere.length > 0 && (
          <>
            <button
              type="button"
              className={`${fieldStyles.btn} ${styles.othersBtn}`}
              aria-expanded={showOthers}
              onClick={() => setShowOthers((v) => !v)}
            >
              {showOthers ? "Hide" : "Show"} other people in this plant ({elsewhere.length})
            </button>
            {showOthers && elsewhere.map((o) => chip(o, true))}
          </>
        )}
      </div>
    </aside>
  );
}
