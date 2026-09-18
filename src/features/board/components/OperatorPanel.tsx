import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardOperator, Skill, BoardNode, ShiftTemplate } from "@/lib/api";
import { absenceGaps, type AbsenceRow } from "@/lib/absence";
import type { IndexedAssignment } from "../lib/boardIndex";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { bookingWords, rootBand } from "../lib/railWords";
import {
  clampRailWidth,
  railKey,
  readRailWidth,
  writeRailWidth,
  RAIL_MIN_WIDTH,
} from "../lib/railWidth";
import { PanelToggle } from "@/components/PanelToggle";
import fieldStyles from "@/components/Field.module.css";
import styles from "./OperatorPanel.module.css";

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * Left operator panel, read-only half (brief §8). Ported from the mockup's
 * `renderPanel`, with real-data substitutions.
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
 * ⭐⭐ S65-a (R-438) SUPERSEDES THE OLD SINGLE-LINE CHIP. The maintainer, 17
 * Sept, shown a capacity bar next to the plain count pill: "the bar is not
 * very useful, we don't know what a full bar would mean" -- `isFullyAllocated`
 * (`geometry.ts`) is a BOOLEAN over the whole loaded window (a week on a week
 * board), against which nobody is ever a full bar. Each chip is now two
 * lines: the avatar and the name alone (never truncated -- the rail's width
 * is the person's, R-439), then up to two skill badges (+n for the rest) and,
 * on the right, `railWords.ts`'s `bookingWords` in words -- "free", "free
 * 11:30", "booked" -- measured against `rootBand`'s reading of the board
 * ROOT's shift pattern. The count pill and the dimmed "full" chip are gone;
 * `src/test/absenceOnBoard.test.tsx`'s R-038b/R-038d, which pinned them, are
 * rewritten to the new contract there. "not from this area" and "on leave"
 * are unchanged, just moved onto the second line.
 *
 * ⭐ S65-a (R-439) ALSO GIVES THE RAIL A DRAG HANDLE ON ITS RIGHT EDGE, width
 * clamped and remembered per person through `railWidth.ts` (a thin wrapper
 * over S63's `panelSize.ts` -- see that file's own doc for why it doesn't
 * just call `clampPanelSize`). The panel restores its own width on mount and
 * keeps it in state across the once-only auto-collapse in `BoardPage`
 * (collapsing never touches this file's `width` state, only `open`).
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
  rootTemplate = null,
  open,
  onToggleOpen,
  draggingOperatorId,
  dragApi,
  widthStorageKey = null,
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
  /**
   * ⚠️ NO LONGER READ HERE. Kept in the prop shape (rather than trimming
   * `BoardPage`'s call site, out of scope for this lane) because
   * `isFullyAllocated` — the one thing that ever consumed it — went with the
   * count pill and the dimmed "full" chip, S65-a (R-438); it is not
   * destructured above, so nothing in this file references it.
   */
  capacityCap: number;
  /**
   * R-438: the board ROOT's own shift pattern (`index.templateForNode.get`
   * of the node whose path is `rootPath`, resolved in `BoardPage` — this file
   * never walks node ids to find it). `rootBand` (`railWords.ts`) reads its
   * first band; `null` (no pattern on the root, or the board not yet loaded)
   * falls back to measuring `bookingWords` against the window itself.
   */
  rootTemplate?: ShiftTemplate | null;
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
  /**
   * R-439: where the rail's dragged width is remembered — the SAME value
   * `BoardPage` gives `CommandLauncher` as `historyKey` (user id + board
   * root), never derived twice. `railWidth.ts`'s `railKey` prefixes it before
   * it reaches `panelSize.ts`'s storage, so the two remembered sizes never
   * collide. `null` (session/board not yet known, or a test that doesn't
   * care) means the width still resizes for the render but is never
   * persisted — `railWidth.ts`'s own contract.
   */
  widthStorageKey?: string | null;
}) {
  const [showOthers, setShowOthers] = useState(false);

  // R-438: the ONE band `bookingWords` measures every chip against —
  // `rootTemplate`'s first shift, or `null` (rootBand's own fallback,
  // `bookingWords` then reads the window itself). Recomputed only when the
  // template identity changes, not per chip.
  const band = useMemo(() => rootBand(rootTemplate), [rootTemplate]);

  // ---------------------------------------------------------------------
  // R-439: the rail's own remembered width. `null` until either a stored
  // value is loaded or a drag sets one — same convention S63's `size` in
  // `CommandLauncher` uses, and for the same reason: the panel sizes to its
  // CSS default (`.panel`'s `calc(190px * var(--ui-scale))`) until there is
  // a real number to override it with, rather than forcing one on a rail
  // nobody has ever dragged.
  const [width, setWidth] = useState<number | null>(null);

  // `railWidth.ts`'s own key, derived from the SAME `historyKey` value
  // `BoardPage` gives `CommandLauncher` — never a second derivation, and
  // never passed to `panelSize.ts` bare (that would collide with the command
  // panel's own stored size under the same key; `railKey`'s own doc says why).
  const storageKey = railKey(widthStorageKey ?? null);

  // `--ui-scale` is a CSS custom property this file cannot read as a number
  // directly — outside Fit mode it comes from a viewport-driven `clamp()` in
  // global.css, invisible to `getComputedStyle().getPropertyValue`, which
  // hands back the unresolved token stream, not a px number (P1-4c D47's own
  // finding, `BoardGrid.tsx`'s `railProbeRef`). This is that same trick: a
  // hidden probe whose CSS `width` IS `var(--ui-scale)` px, so ITS measured
  // (resolved) width is the scale as a plain number.
  const scaleProbeRef = useRef<HTMLSpanElement | null>(null);
  function currentUiScale(): number {
    return scaleProbeRef.current?.getBoundingClientRect().width || 1;
  }

  // Restore on mount and whenever the person/board changes (a fresh
  // `widthStorageKey`) — mirrors `CommandLauncher`'s own restore effect over
  // `panelSize.ts` exactly. Never re-runs on `open` toggling, so the once-only
  // auto-collapse in `BoardPage` (which only flips `open`) leaves this alone
  // and a reopen finds the same width still in state.
  useEffect(() => {
    const stored = readRailWidth(storageKey);
    setWidth(stored !== null ? clampRailWidth(stored, currentUiScale()) : null);
  }, [storageKey]);

  /**
   * R-439: a pointer drag on the rail's right-edge handle, tracked with
   * `setPointerCapture` on the handle itself (D33, `useDragGesture.ts`'s own
   * convention -- the SAME fix `CommandLauncher`'s own resize handles carry,
   * CR-2: a raw `document.addEventListener("pointermove"/"pointerup", ...)`
   * misses a release outside the browser window entirely, leaving the drag
   * stuck open). `railDragRef` (a ref, not state) holds `latest` -- `width`
   * itself would still read the value from BEFORE this render's `setWidth`,
   * a stale read `useState` warns about for exactly this reason. The rail
   * grows to the RIGHT (unlike the command panel's bottom-right anchor), so
   * the delta is (current - start), not (start - current).
   */
  const railDragRef = useRef<{
    startX: number;
    startWidth: number;
    uiScale: number;
    latest: number;
    pointerId: number;
  } | null>(null);

  function handleRailPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const uiScale = currentUiScale();
    const startWidth = width ?? RAIL_MIN_WIDTH * uiScale;
    railDragRef.current = {
      startX: e.clientX,
      startWidth,
      uiScale,
      latest: startWidth,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleRailPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = clampRailWidth(drag.startWidth + (e.clientX - drag.startX), drag.uiScale);
    drag.latest = next;
    setWidth(next);
  }

  /** Ends a resize on either `pointerup` or `pointercancel` -- see this
   *  section's own doc above for why both matter. */
  function endRailResize(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    railDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    writeRailWidth(storageKey, drag.latest);
  }

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
    const title = titles.get(o.id);
    const words = bookingWords(mine, { start: windowStart, minutes: windowMinutes }, band, zone);

    // R-438: "ordered by the skills the cell requires first" — this panel has
    // no notion of a cell being dragged over (that context lives in the
    // create/reassign pop-ups' own `requiredSkills`, not here), so there is
    // no required-skill order available to read. Falls back to the name, the
    // brief's own escape hatch — said here rather than silently guessed.
    const skills = o.skillIds
      .map((sid) => skillById.get(sid))
      .filter((s): s is Skill => s !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    const shownSkills = skills.slice(0, 2);
    const restSkills = skills.slice(2);

    return (
      <div
        key={o.id}
        className={`${styles.chip} ${draggingOperatorId === o.id ? styles.dragSrc : ""}`}
        title={title}
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={(e) => dragApi.beginPanelDrag(o, e)}
        onPointerMove={dragApi.updatePanelDrag}
        onPointerUp={dragApi.endPanelDrag}
        onPointerCancel={dragApi.cancelDrag}
      >
        {/* Line one (R-438): avatar and the name ALONE, never truncated — the
            rail's width is the person's (R-439), so there is no reason to
            ellipsise it. */}
        <span className={styles.avatar}>{initials(o.displayName)}</span>
        <span className={styles.nm}>{o.displayName}</span>
        {/* Line two: the area/leave marks (unchanged from before, just moved
            down here), up to two skill badges + "+n", and the booking words
            pushed to the right. */}
        <div className={styles.line2}>
          {/* R-346: said on the chip itself, so the mark travels with the
              person rather than depending on where the list happens to be
              scrolled. The wording is the panel's plain half of the pop-ups'
              "not from this area (override)" — the panel asks for nothing,
              the drop does. */}
          {outside && <span className={styles.outsideTag}>not from this area</span>}
          {/* R-357: the plain half of the pop-ups' "On leave" line — the
              panel says who is away over the shown window; placing them is
              where the warning or the refusal actually fires. */}
          {absentIds.has(o.id) && <span className={styles.leaveTag}>on leave</span>}
          {shownSkills.map((s) => (
            <span key={s.id} className={styles.sk}>
              {s.name}
            </span>
          ))}
          {restSkills.length > 0 && (
            <span
              className={styles.more}
              title={restSkills.map((s) => s.name).join(", ")}
            >{`+${restSkills.length}`}</span>
          )}
          <span className={styles.words}>{words}</span>
        </div>
      </div>
    );
  }

  return (
    <aside
      className={`${styles.panel} ${open ? "" : styles.collapsed}`}
      aria-label="Operators"
      // R-439: only an OPEN panel takes the dragged width — collapsed always
      // falls back to `.collapsed`'s own fixed CSS width, same as
      // `CommandLauncher`'s `size !== null` inline-style gate.
      style={open && width !== null ? { width } : undefined}
    >
      {/* See `currentUiScale`'s own comment above: a zero-size probe whose
          resolved `width` IS the current `--ui-scale`, as a real px number. */}
      <span ref={scaleProbeRef} className={styles.scaleProbe} aria-hidden="true" />
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
      {/* R-439: the rail's own drag handle, right edge only — the rail grows
          rightward (unlike the command panel's bottom-right anchor), and
          only makes sense to grab while open (a collapsed rail has nothing
          to widen into). */}
      {open && (
        <div
          className={styles.resizeHandle}
          onPointerDown={handleRailPointerDown}
          onPointerMove={handleRailPointerMove}
          onPointerUp={endRailResize}
          onPointerCancel={endRailResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize operators panel"
        />
      )}
    </aside>
  );
}
