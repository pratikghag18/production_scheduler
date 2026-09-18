import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardOperator, Shift, Skill, BoardNode, ShiftTemplate } from "@/lib/api";
import { absenceGaps, type AbsenceRow } from "@/lib/absence";
import type { IndexedAssignment } from "../lib/boardIndex";
import { formatClock, formatFull, addMinutes } from "../lib/time";
import { bookingWords, rootBand, resolveHomeBand } from "../lib/railWords";
import { bandCoveringNow } from "../lib/shiftNow";
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

/** S66-c: a stable empty default for `templateForNode` — a fresh `new Map()`
 *  literal in the destructuring default would be a new object every render,
 *  which is harmless here (it is only ever read, never a dependency by
 *  itself) but is avoided anyway so nothing downstream is tempted to key a
 *  memo on it later and get a cache miss every render for free. */
const EMPTY_TEMPLATE_FOR_NODE: ReadonlyMap<string, ShiftTemplate | null> = new Map();

/** S66-c (R-448): how many grid columns the shift-chip row uses, per R-447 —
 *  "two bands -> two columns, three -> three, four -> a 2x2 matrix ...,
 *  five or more -> two columns wrapping". */
function shiftChipColumns(count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 2;
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
 * 11:30", "booked" -- measured, since S66-c (R-448), against the PERSON'S OWN
 * band where one resolves, else `rootBand`'s interim reading of the board
 * ROOT's whole shift pattern (see the S66-c section below). The count pill
 * and the dimmed "full" chip are gone;
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
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ S66-c (R-448) — "THE RAIL SHOWS THE PEOPLE ON SHIFT NOW." Two more
 * pieces land on the "here" bucket only (R-346's "the rest of the plant"
 * control, above, stays exactly what it was — a person's AREA, not their
 * shift, decides whether the "Show other people" door has to be opened at
 * all; a decision named plainly in the S66-c report rather than made
 * quietly, since the brief does not say the two filters compose):
 *
 *  1. A row of shift chips under the "OPERATORS" heading, one per band of
 *     `rootTemplate`'s pattern in band order — the one `shiftNow.ts`'s
 *     `bandCoveringNow` says covers the plant's clock NOW is filled and
 *     always showing; the others are outlined and TOGGLE a person's shift
 *     into (or back out of) the list. `now` is this component's own state,
 *     refreshed once a minute (`useEffect`/`setInterval`) rather than a
 *     value threaded down from `BoardPage` — nothing in the tree keeps a
 *     live-ticking clock today (`BoardPage`'s own `now = new Date()`, inside
 *     `commandCtx`, is a one-shot read on every board-data refetch, not a
 *     per-minute tick), and this lane's file fence stops at the
 *     `<OperatorPanel` render line, so a shared ticking clock is BoardPage's
 *     call to make later, not this lane's to reach past its own fence for.
 *     A `now` PROP is accepted and wins over the internal clock when given
 *     (tests pin it; production never passes one).
 *  2. Each person's own line-two `words` (R-438's `bookingWords`) now reads
 *     against THEIR OWN band —
 *     `railWords.ts`'s `resolveHomeBand`, id then cross-pattern name against
 *     `rootTemplate` — falling back to the old interim whole-pattern-span
 *     reading (`rootBand`) exactly as before when no personal band resolves,
 *     which is what keeps `absenceOnBoard.test.tsx`'s R-038/R-438 cases (all
 *     written with `homeShiftId: null`) passing unchanged. A person with NO
 *     resolvable band ALSO gets a small "No shift" mark on line two (a new
 *     tag beside `.outsideTag`/`.leaveTag`, not a replacement for the booking
 *     words) and sorts to the END of the default list, after everyone whose
 *     band matches a currently-shown chip — a plain reading of "listed too,
 *     at the end" that keeps the words computation and the grouping as two
 *     separate questions rather than overloading one string to answer both.
 * ---------------------------------------------------------------------------
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
  templateForNode = EMPTY_TEMPLATE_FOR_NODE,
  now: nowProp,
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
  /**
   * S66-c (R-441/R-443/R-448): the SAME map `BoardIndex.templateForNode`
   * already is — every node in the window resolved to its own nearest-
   * ancestor pattern — handed straight through from `BoardPage`'s
   * `index.templateForNode`, never rebuilt here. `resolveHomeBand`
   * (`railWords.ts`) uses it for exactly one lookup: a person's OWN home
   * node's template, to read the NAME of a home band that is not a row in
   * `rootTemplate` at all (a cross-pattern match, R-443). Defaults to an
   * empty map so every existing caller (`absenceOnBoard.test.tsx`,
   * `operatorPanel.test.tsx`'s OP-1..4) keeps working unchanged — an absent
   * map just means the cross-pattern half of the match never finds anything,
   * which is this file's own "where the client cannot know" fallback, not a
   * crash.
   */
  templateForNode?: ReadonlyMap<string, ShiftTemplate | null>;
  /**
   * S66-c (R-448): the instant the shift chips and the default listing are
   * read against. Omitted in production — `BoardPage` keeps no live-ticking
   * clock today (see this file's own header note) — in which case the panel
   * keeps its OWN `now`, refreshed once a minute. A test passes a literal
   * `Date` to pin `bandCoveringNow`'s answer instead of racing the real
   * clock; passing one also skips the internal timer entirely, so no test
   * leaks a running interval.
   */
  now?: Date;
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
  // S66-c: renamed from `band` -- this is now the FALLBACK a chip's words
  // fall back to when the person has no personal band of their own
  // (`resolveHomeBand` below answers `null`), not the band every chip reads.
  const fallbackBand = useMemo(() => rootBand(rootTemplate), [rootTemplate]);

  // -----------------------------------------------------------------------
  // S66-c (R-448): THE LIVE CLOCK, THE SHIFT CHIPS, AND EACH PERSON'S OWN
  // BAND. See this file's own header note for why the ticking clock lives
  // HERE rather than in `BoardPage` (no shared "now" exists anywhere in the
  // tree yet, and this lane's fence stops at the `<OperatorPanel` render
  // line) and why `templateForNode` defaults to empty.
  // -----------------------------------------------------------------------

  const [internalNow, setInternalNow] = useState<Date>(() => new Date());
  useEffect(() => {
    // A `now` prop (tests, and any future caller with its own clock) always
    // wins and starts no timer of its own -- nothing here leaks an interval
    // past a test's own render.
    if (nowProp !== undefined) return;
    const id = setInterval(() => setInternalNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [nowProp]);
  const now = nowProp ?? internalNow;
  const effectiveZone = zone ?? "UTC";

  // R-447: band order -- the pattern's own shifts, earliest start first, so
  // the chip row and the "Showing: ..." heading always name them the same
  // way regardless of how the admin screen happened to save them.
  const sortedShifts = useMemo(
    () => (rootTemplate ? [...rootTemplate.shifts].sort((a, b) => a.startMin - b.startMin) : []),
    [rootTemplate],
  );

  const nowBand = useMemo(
    () => bandCoveringNow(rootTemplate, now, effectiveZone),
    [rootTemplate, now, effectiveZone],
  );

  // The shifts a person has clicked IN beyond the one on now -- "they stay
  // until clicked again" (R-448 DECIDED). Clicking the filled (on-now) chip
  // is a no-op, so its id never needs to appear here at all.
  const [toggledShiftIds, setToggledShiftIds] = useState<ReadonlySet<string>>(new Set());

  function toggleShift(shift: Shift): void {
    if (nowBand && shift.id === nowBand.id) return; // the filled chip: always shown, never toggled
    setToggledShiftIds((prev) => {
      const next = new Set(prev);
      if (next.has(shift.id)) next.delete(shift.id);
      else next.add(shift.id);
      return next;
    });
  }

  const activeShiftIds = useMemo(() => {
    const ids = new Set(toggledShiftIds);
    if (nowBand) ids.add(nowBand.id);
    return ids;
  }, [toggledShiftIds, nowBand]);

  const shownShiftNames = sortedShifts.filter((s) => activeShiftIds.has(s.id)).map((s) => s.name);

  // R-448 DECIDED: "the list should automatically show people from current
  // shift based on time with a selectable option to assign people from other
  // shifts" -- the heading says which reading is in effect, in plain words,
  // rather than leaving a person to infer it from which chips look filled.
  const shiftHeading =
    shownShiftNames.length === 0
      ? "No one on shift now"
      : toggledShiftIds.size === 0 && nowBand
        ? `On shift now: ${shownShiftNames[0]}`
        : `Showing: ${shownShiftNames.join(", ")}`;

  // Every operator's own band, resolved once per (person, pattern) change --
  // not recomputed inside `chip()` per render, the same discipline `titles`/
  // `absentIds` below already keep. `null` = no personal band answerable
  // (R-448's "No shift"), which `chip()` reads for both the tag and the
  // sort below.
  const personBand = useMemo(() => {
    const m = new Map<string, Shift | null>();
    for (const o of operators) {
      m.set(o.id, resolveHomeBand(o, rootTemplate, templateForNode));
    }
    return m;
  }, [operators, rootTemplate, templateForNode]);

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
  // R-346's own split (area) stays untouched by R-448's split (shift): "the
  // rest of the plant" behind `showOthers` below is unaffected by which
  // shift chips are showing, exactly as it was before this lane -- the
  // brief names only "the rail['s] default[ list]", and widening the shift
  // filter onto `elsewhere` too is not something it asks for, so it is left
  // alone rather than guessed at.
  const elsewhere = useMemo(
    () => visible.filter((o) => !hereOperatorIds.has(o.id)),
    [visible, hereOperatorIds],
  );

  // R-448: of `here`, the people whose OWN band is one of the currently
  // shown chips, THEN (at the end) everyone with no resolvable band at all —
  // "people with no shift are listed too, at the end". Each half keeps
  // `here`'s own alphabetical order; with no pattern on the root at all
  // (`sortedShifts` empty), `personBand` is `null` for everyone and this
  // reduces to `here` unchanged, which is why no separate "no pattern"
  // branch is needed here.
  const hereShown = useMemo(() => {
    const matched: BoardOperator[] = [];
    const noShift: BoardOperator[] = [];
    for (const o of here) {
      const b = personBand.get(o.id) ?? null;
      if (b === null) noShift.push(o);
      else if (activeShiftIds.has(b.id)) matched.push(o);
    }
    return [...matched, ...noShift];
  }, [here, personBand, activeShiftIds]);

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
    // R-448: THIS person's own band when one resolves, else the old interim
    // whole-pattern-span reading (`fallbackBand`) exactly as before R-441 —
    // `bookingWords` itself is unchanged; only which band it is handed here
    // is new.
    const ownBand = personBand.get(o.id) ?? null;
    const words = bookingWords(
      mine,
      { start: windowStart, minutes: windowMinutes },
      ownBand ?? fallbackBand,
      zone,
    );

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
          {/* R-448: "people with no shift are listed too, at the end" — this
              is the "at the end" grouping's own visible reason, alongside
              (never instead of) the booking words above, which keep reading
              against `fallbackBand` for exactly this person. */}
          {ownBand === null && <span className={styles.noShiftTag}>No shift</span>}
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
      {/* R-448/R-447: the shift chips, one per band of the root's pattern —
          absent entirely when the root carries no pattern at all (nothing to
          pick between), same "absent when there is nobody behind it" rule
          `.othersBtn` below already follows. */}
      {sortedShifts.length > 0 && (
        <div className={styles.shiftChipsWrap}>
          <div className={styles.shiftChipsHeading}>{shiftHeading}</div>
          <div
            className={styles.shiftChips}
            style={{
              gridTemplateColumns: `repeat(${shiftChipColumns(sortedShifts.length)}, minmax(0, 1fr))`,
            }}
          >
            {sortedShifts.map((s) => {
              const filled = nowBand !== null && s.id === nowBand.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`${fieldStyles.btn} ${styles.shiftChip} ${filled ? styles.shiftChipFilled : ""}`}
                  aria-pressed={filled || toggledShiftIds.has(s.id)}
                  onClick={() => toggleShift(s)}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className={styles.list}>
        {hereShown.map((o) => chip(o, false))}
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
