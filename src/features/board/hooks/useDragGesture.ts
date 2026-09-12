/**
 * D29 — one drag controller, three gestures (create/move/resize), plus the
 * click-opens-a-popover fallback (D32) and the keyboard path (§8) reusing
 * the exact same Part A arithmetic. One instance of this hook lives in
 * `BoardPage`; every draggable element gets its pointer/keyboard handlers
 * from the factory functions this hook returns, never owns its own copy of
 * the state machine (brief §3: "Three separate copies of pointer handling
 * is how the mockup's four `start*Drag` functions ended up subtly
 * different from each other").
 *
 * D33: `setPointerCapture` is called on the ORIGINATING DOM element at
 * pointerdown; the browser then routes every subsequent pointermove/
 * pointerup/pointercancel for that pointerId to that same element even
 * once the pointer leaves it — so each draggable component's own
 * onPointerMove/onPointerUp/onPointerCancel (wired from this hook) never
 * needs to check "is this drag mine", and §5.1's "capture the track's
 * bounding rect once on pointerdown" (never in pointermove) falls out of
 * the same design: every candidate is computed from a delta off the
 * ORIGIN clientX, not from a re-measured rect.
 */ import { operatorViewFor, productViewFor } from "../lib/history";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ShiftTemplate,
  BoardOperator,
  CreateAssignmentInput,
  AssignmentFieldEdit,
  ReassignAssignmentInput,
  MoveAssignmentInput,
  CapacityProbe,
  AssignmentTarget,
} from "@/lib/api";
import {
  describeSchedulerError,
  isSchedulerError,
  toSchedulerError,
  probeCapacity,
  fromEfficiency,
} from "@/lib/api";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "../lib/boardIndex";
import { certificateGaps, policyForNode } from "../lib/boardIndex";
import { ZOOMS, pxToMinutes, shiftSnapPoints, type ZoomIndex } from "../lib/geometry";
import type { DayAxis } from "../lib/time";
import { formatClock, addMinutes } from "../lib/time";
import { leaveLine } from "../lib/leave";
import { absenceGaps } from "@/lib/absence";
import { useAbsences } from "./useAbsences";
import type { DateFormat } from "@/lib/format/dates";
import {
  MIN_DURATION_MINUTES,
  DRAG_THRESHOLD_PX,
  hitTestBlock,
  snapMinute,
  createRange,
  moveWithinTrack,
  resizeRange,
  findRunOverlap,
  classifyCrewAgainstRun,
  assignmentFitsRun,
  attachmentChangeMessage,
  splitEvenly,
  splitFits,
  type DragMode,
  targetResizeMessage,
} from "../lib/interaction";
import { scaledTarget } from "../lib/standardTarget";
import { useCreateRun, useUpdateRunFields, useDeleteRun, useMoveRun } from "./useRunMutations";
import {
  useCreateAssignment,
  useDeleteAssignment,
  useReassignAssignment,
  useMoveAssignment,
  useUpdateAssignmentFields,
  useApplySplitCoverage,
} from "./useAssignmentMutations";
import { useSchedulerToast, type ToastResolveCtx } from "./useSchedulerToast";

export type { DragMode };

type Range = { startMin: number; endMin: number };

export type DragSubject =
  | { kind: "run"; run: IndexedRun }
  | { kind: "assignment"; assignment: IndexedAssignment; homeRun: IndexedRun | null }
  | { kind: "new" }
  /** D65/§7 "panel-drag origin": a fresh operator picked up from
   *  `OperatorPanel`, not yet attached to anything on the board. */
  | { kind: "panel"; operator: BoardOperator };

/** Public shape a renderer reads to decide whether IT is the row/block
 *  currently mid-drag (D34) — a superset of brief §5.1's `ActiveDrag`. */
export interface ActiveDrag {
  mode: DragMode;
  nodeId: string;
  subject: DragSubject;
  original: Range | null;
  candidate: Range | null;
  moved: boolean;
  pointerId: number;
  /** D58/D59/D65: the node id of the track row currently under the pointer
   *  during a cross-cell run drag or a panel drag, when that row is not the
   *  drag's own origin row — `null` otherwise (including while hovering a
   *  group row, D59: "group rows are never drop targets"). Renderers add
   *  `.dropHint` to that row's track. */
  dropTargetNodeId: string | null;
  /** D59: true once the currently-hovered target row is known to already
   *  hold an overlapping active run — the drop will be refused. Only ever
   *  set for a run drag; always `false` for a panel drag (no overlap
   *  concept there). */
  dropRefused: boolean;
  /** T24: the live pointer position in VIEWPORT coordinates, updated on
   *  every panel-drag pointermove — the ghost renders from this, never
   *  from `originClientX/Y`, so it tracks the pointer through a scroll. */
  pointerClientX: number;
  pointerClientY: number;
}

export interface ShiftChip {
  name: string;
  startMin: number;
  endMin: number;
}

/** D62: one participant row in the split-coverage popover — either an
 *  EXISTING overlapping assignment (`assignmentId` set, dialled down) or
 *  the INCOMING one being created (`assignmentId` null). `efficiencyPercent`
 *  is the popover's own live-edited state, seeded from the probe. */
export interface SplitParticipant {
  assignmentId: string | null;
  label: string;
  efficiencyPercent: number;
}

export type PopoverState =
  | {
      kind: "create";
      /** A fresh number from every opener (`createSeqRef`), never reused --
       *  `BoardPage` keys `<CreatePopover>` on it so a second typed command
       *  opening this popover while an earlier one is still in flight is
       *  always a new mount, never a prop update on the same component
       *  instance (the review lane's finding: an unkeyed re-render would
       *  never re-arm the mount-only R-384 auto-press effect). */
      seq: number;
      nodeId: string;
      range: Range;
      anchor: { x: number; y: number };
      shiftChips: ShiftChip[];
      /** D65: set only when this popover was opened by a panel drop — the
       *  dropped operator, pre-selected, in forced "direct" mode. */
      presetOperatorId?: string;
      /** P1-7a: set when a typed command resolved to a direct product target
       *  (R-378) — preselects `CreatePopover`'s product select. */
      presetProductId?: string;
      /** P1-7a / R-383: set when a typed command resolved to an existing run
       *  instead — `CreatePopover` shows a read-only "Joining <label>" line in
       *  its place and sends this run as the target. `label` is `runLabelById`'s
       *  own D66 format, so this and a drag's confirm prompt never disagree. */
      presetRun?: { id: string; label: string };
      /**
       * S41-a: set when the typed "book a job" sentence resolved to a
       * BRAND-NEW job — forces `CreatePopover` into Product run mode with the
       * run/direct segment disabled, mirroring how `presetOperatorId` forces
       * direct mode (but, unlike that preset, this one also disables the
       * segment: there is no operator to pick for a job, so nothing on this
       * screen may flip back to direct).
       */
      presetMode?: "run";
      /** S41-a: "for 3 people" -- preselects `CreatePopover`'s planned
       *  headcount field when the sentence said a number. */
      presetHeadcount?: number;
      /**
       * S41-c: set when this popover was opened by the typed "move" sentence
       * resolving to a `move_cell` target (`openMoveFromCommand`) -- carries
       * the block being moved. `CreatePopover` forces direct mode (already
       * happens via `presetOperatorId`, which `openMoveFromCommand` also
       * sets), shows a read-only "Moving <person>'s block" line instead of
       * the operator select, and sends `moveAssignment` on submit instead of
       * `createAssignment` -- no second door, the SAME pop-up.
       */
      presetMove?: { assignmentId: string };
      /**
       * R-384: set ONLY by `openCreateFromCommand` — the typed command bar is
       * the sole opener that may auto-press Create when the pop-up would show
       * no warning. A drag or a keyboard create (`endTrackCreateDrag`,
       * `endPanelDrag`, `handleTrackKeyDown`) never sets this, so their
       * pop-ups always wait for a real press, as before.
       */
      autoCreate?: boolean;
    }
  | {
      kind: "run";
      nodeId: string;
      run: IndexedRun;
      crew: IndexedAssignment[];
      anchor: { x: number; y: number };
    }
  | {
      kind: "assignment";
      nodeId: string;
      assignment: IndexedAssignment;
      homeRun: IndexedRun | null;
      anchor: { x: number; y: number };
    }
  | {
      /** D61/D62: the split-coverage popover, opened PROACTIVELY from a
       *  `capacity_probe` before anything is sent (never from a rejection —
       *  D61). `cap`/`capPercent` are the same number in two units because
       *  `splitFits` (Part A) works in UI percent while the live peak
       *  readout's arithmetic is easiest to reason about in percent too. */
      kind: "split";
      operatorId: string;
      operatorName: string;
      capPercent: number;
      participants: SplitParticipant[];
      /** The full input `apply_split_coverage`'s new-assignment argument is
       *  built from on confirm — everything about the incoming assignment
       *  EXCEPT its efficiency, which lives in `participants` (the last
       *  entry, by construction — see `openSplitPopover` below) so the
       *  popover's own edits are the single source of truth for it. */
      incoming: Omit<CreateAssignmentInput, "efficiencyPercent">;
      anchor: { x: number; y: number };
    }
  | {
      /** §9 debt 2: the crew-outside-the-run-window warning, moved out of
       *  `window.confirm` (which cannot be styled or tested through the
       *  DOM) into the popover shell. */
      kind: "confirm";
      message: string;
      anchor: { x: number; y: number };
      onConfirm: () => void;
      /** R-031: when set, the prompt offers THESE buttons instead of a
       *  single Continue, and `confirmChoose(i)` fires one of them; Cancel
       *  is always there and always `confirmNo`. `confirmYes` does nothing
       *  on a prompt with choices — there is no default answer to "keep or
       *  scale?", and a stray Enter must not pick one. */
      choices?: readonly ConfirmChoice[];
      /** R-031: the popover's title; "Continue?" when absent. */
      title?: string;
    };

/** R-031: one button on a multi-choice confirm prompt. */
export interface ConfirmChoice {
  label: string;
  onChoose: () => void;
}

export interface SnapConfig {
  useShiftSnap: boolean;
  snapMinutes: number;
  shiftPoints: number[];
}

/** Exported for R-024/R-D16: proves which snap values each zoom level
 * actually wires up (interaction.test.ts proves snapMinute's own logic
 * with hand-supplied params; this is the zoomIndex -> params half). */
export function snapConfigFor(
  zoomIndex: ZoomIndex,
  template: ShiftTemplate | null,
  axis: DayAxis,
): SnapConfig {
  const zoom = ZOOMS[zoomIndex];
  const useShiftSnap = zoom.name === "Compact";
  const shiftPoints = template ? shiftSnapPoints(template, axis) : [];
  return { useShiftSnap, snapMinutes: zoom.snapMinutes, shiftPoints };
}

/** Internal bookkeeping the public `ActiveDrag` doesn't need to expose. */
interface InternalDragState extends ActiveDrag {
  pxPerHour: number;
  windowMinutes: number;
  snap: SnapConfig;
  originClientX: number;
  originClientY: number;
  altKey: boolean;
  runsOnNode: IndexedRun[]; // for overlap pre-check
  crew: IndexedAssignment[]; // for classifyCrewAgainstRun (run resize)
  homeRun: IndexedRun | null; // for a run-attached assignment's own bound
  /** create-mode only: the snapped anchor instant, fixed at pointerdown. */
  createAnchorMin: number;
  /** create-mode only: the latest SNAPPED current instant (pre-normalize —
   *  may be before or after `createAnchorMin`), so `endTrackCreateDrag` can
   *  call `createRange(anchor, current, windowMinutes)` directly instead of
   *  reconstructing it from the already-normalized `candidate`. */
  createCurrentMin: number;
}

/** The window each mode's candidate is clamped to.
 *
 *  P1-4e REVISES this from P1-4b: a run-attached chip's RESIZE still stays
 *  within its own run's bounds (unchanged — resizing across a run boundary
 *  never made sense and D66 says nothing about resize), but a chip's MOVE
 *  is no longer clamped to `homeRun` — it now slides freely across the
 *  whole loaded window, exactly like a direct assignment, so it can
 *  physically reach a different run's band or empty track to re-parent or
 *  detach on drop (D66). P1-4b's own comment on this function explained
 *  that its "clamp a MOVE to homeRun too" choice was a deliberate
 *  stand-in for exactly this future capability ("P1-4c's scope fence
 *  disables re-parenting here... so both gestures are clamped identically
 *  here" — this brief is what lifts that fence). Module-level and pure (no
 *  closed-over component state) so the `useCallback`s that call it need
 *  not list it as a dependency. */
function boundsFor(d: InternalDragState): Range {
  if (d.subject.kind === "assignment" && d.homeRun && d.mode !== "move") {
    return { startMin: d.homeRun.startMin, endMin: d.homeRun.endMin };
  }
  return { startMin: 0, endMin: d.windowMinutes };
}

export interface UseDragGestureArgs {
  rootPath: string;
  from: Date;
  to: Date;
  index: BoardIndex;
  defaultCreateMode: "run" | "direct";
  /** D65: the active zoom, needed only for a panel drop's snap (no track
   *  descriptor exists yet at that point the way every other gesture's
   *  begin-call already carries one from the row it started on). */
  zoomIndex: ZoomIndex;
  /** T13: the signed-in identity. A change cancels any in-flight drag with
   *  no mutation sent — the node the drag targeted may not even be visible
   *  to the new identity. */
  sessionUserId: string | null;
  /**
   * DEF-0015 / R-239 / R-346: the server's `can_place` for this person on this
   * board (`board_window`, migration 0058). When false the person is a viewer:
   * this hook opens no create pop-up (Enter on a track and a click-drag on a
   * track do nothing), starts no block move/resize and no panel drag. A click
   * or Enter on an existing block still opens its pop-up — read-only, decided
   * in `BoardPage` — because seeing a chip is not placing anyone.
   */
  canPlace: boolean;
  /**
   * R-357: the plant's resolved date format, used to phrase the leave a
   * warn-move went ahead over in the drag success toast (`leaveLine`) — the same
   * seam the create/reassign pop-ups read absences through, so the drag path
   * names the dates the way they do rather than staying silent.
   */
  dateFormat: DateFormat;
}

export interface BlockDragDescriptor {
  nodeId: string;
  subject: DragSubject;
  original: Range;
  pxPerHour: number;
  windowMinutes: number;
  template: ShiftTemplate | null;
  dayCount: number;
  dayAxis: DayAxis;
  zoomIndex: ZoomIndex;
  handlePx: number;
  blockWidthPx: number;
  offsetXPx: number;
  runsOnNode: IndexedRun[];
  crew: IndexedAssignment[];
}

export interface TrackCreateDescriptor {
  nodeId: string;
  pxPerHour: number;
  windowMinutes: number;
  template: ShiftTemplate | null;
  dayCount: number;
  dayAxis: DayAxis;
  zoomIndex: ZoomIndex;
  trackLeftPx: number;
  offsetXPx: number;
}

function toastCtx(index: BoardIndex, dateFormat: DateFormat): ToastResolveCtx {
  // P1-4e: `index.runById` (§9 debt 1) now carries exactly this shape —
  // the ad-hoc rebuild this function used to do is no longer needed.
  return {
    operatorById: index.operatorById,
    nodeById: index.nodeById,
    productById: index.productById,
    runById: index.runById,
    formatRange: (s, e) =>
      `${formatClock(addMinutes(index.windowStart, s), index.zone)}–${formatClock(addMinutes(index.windowStart, e), index.zone)}`,
    // R-359: so an `Absent` refusal's hours are read in the board's own zone
    // rather than UTC. The days follow the caller's date format at the call site.
    zone: index.zone,
    dateFormat,
  };
}

export function useDragGesture(args: UseDragGestureArgs) {
  const { rootPath, from, to, index, zoomIndex, dateFormat } = args;

  const createRun = useCreateRun(rootPath, from, to);
  const updateRunFields = useUpdateRunFields(rootPath, from, to);
  const deleteRun = useDeleteRun(rootPath, from, to);
  const moveRun = useMoveRun(rootPath, from, to); // D57 — first caller (brief §1 item 3)
  const createAssignment = useCreateAssignment(rootPath, from, to);
  const updateAssignmentFields = useUpdateAssignmentFields(rootPath, from, to);
  const reassign = useReassignAssignment(rootPath, from, to); // R-343, first caller
  const move = useMoveAssignment(rootPath, from, to); // S41-c, first caller
  const deleteAssignment = useDeleteAssignment(rootPath, from, to);
  const applySplitCoverage = useApplySplitCoverage(rootPath, from, to); // D61/D62 — first caller

  // R-361: the same absences list `BoardPage` already reads beside the board
  // (`useAbsences`, R-357) — a SECOND subscription to the identical query key
  // (`absenceKeys.all()`), not a new prop threaded down from `BoardPage`
  // (outside this lane's owned files). React Query dedupes by key: this
  // shares BoardPage's own cache entry and fetch rather than doubling the
  // network read. Gated the same shape `BoardPage` gates its own read with
  // (a resolved identity and a real root), close enough that an unauthenticated
  // or not-yet-placed board never fires it — the mirror is best-effort for the
  // toast under `warn` only, never the authority (the server's silent trigger
  // is), so a slightly different readiness window changes nothing about
  // correctness.
  const resizeAbsencesQuery = useAbsences(args.sessionUserId !== null && rootPath !== "");
  const resizeAbsences = useMemo(() => resizeAbsencesQuery.data ?? [], [resizeAbsencesQuery.data]);
  const toast = useSchedulerToast();

  const [activeDrag, setActiveDrag] = useState<InternalDragState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  // The race the review lane found: `<CreatePopover>` renders unkeyed at a
  // stable position in `BoardPage.tsx`, so a second typed command opening a
  // create popover while an earlier one is still in flight (its own write
  // not yet settled) would previously just UPDATE that component's props in
  // place -- the mount-only R-384 auto-press effect never re-arms, and the
  // second command's popover silently never presses Create. Every opener
  // that sets a `kind: "create"` popover stamps a fresh `seq` from this
  // ref; `BoardPage` keys `<CreatePopover>` on it, so each open is a new
  // mount with its own `autoFiredRef`, however similar its props are to the
  // last one's.
  const createSeqRef = useRef(0);
  // Mirrors `activeDrag` for handlers that must read the latest value
  // without depending on it (keeps the pointer handlers' identity stable
  // across renders, per §13 item 4 — one add, one matching cleanup).
  const dragRef = useRef<InternalDragState | null>(null);
  dragRef.current = activeDrag;

  // DEF-0015: the viewer answer, mirrored into a ref so the pointer/keyboard
  // handlers below can read the latest value without listing it as a
  // dependency (same pattern as `dragRef`, keeping their identity stable).
  const canPlaceRef = useRef(args.canPlace);
  canPlaceRef.current = args.canPlace;

  // D58: the drop-target row resolver. `BoardGrid` is the one place that
  // owns the scroll container, the row offsets, and the collapse-filtered
  // row list, so it registers a resolver HERE via `setDropRowResolver`
  // (returned below) instead of this hook reaching up into DOM geometry
  // itself. A ref, not state — every pointermove reads it without causing
  // this hook (or its consumers) to re-render when it is re-registered.
  const dropRowResolverRef = useRef<
    | ((
        clientX: number,
        clientY: number,
      ) => { nodeId: string; isTrack: boolean; minute: number } | null)
    | null
  >(null);
  const setDropRowResolver = useCallback((fn: typeof dropRowResolverRef.current) => {
    dropRowResolverRef.current = fn;
  }, []);

  const ctx = toastCtx(index, dateFormat);

  // --- T13: identity change cancels any in-flight drag, no mutation. -----
  // T25: a SPLIT popover open when identity changes is closed too, with
  // nothing sent — the assignments it references may not be visible to the
  // new identity (`DevProfileSwitcher` resets the query cache). Scoped to
  // "split" only, per T25's own literal text; the other popover kinds
  // (create/run/assignment) are unchanged from P1-4b's existing behaviour
  // on this transition — see the agent report's assumptions section.
  const lastUserIdRef = useRef(args.sessionUserId);
  useEffect(() => {
    if (lastUserIdRef.current !== args.sessionUserId) {
      lastUserIdRef.current = args.sessionUserId;
      if (dragRef.current) setActiveDrag(null);
      setPopover((p) => (p?.kind === "split" ? null : p));
    }
  }, [args.sessionUserId]);

  // --- DEF-0002 second door: the ROOT changed, so every popover is stale. ---
  // ⭐ EVERY KIND, not just "split", which is where this differs from T25
  // above. A popover names a `nodeId` in the board window it was opened over;
  // change the selected place and that node is not on the screen any more —
  // its lane, its shift times and its cell are all from somewhere else.
  //
  // ⚠️ THIS IS THE HALF OF DEF-0002 THE PICKER FIX DID NOT REACH, and it was
  // found by driving it rather than by reading it: with the create popover
  // open on Plant A, switching the picker to Plant B left the popover up, and
  // its Product dropdown went from Plant A's four parts to ALL THIRTEEN in the
  // company — because `BoardPage`'s `offeredProducts` cannot resolve a Plant A
  // node in Plant B's map and fell back to the whole catalogue. Scoping the
  // predicate fixed the reported path; this closes the one three clicks away.
  // Nothing is sent: an open popover has written nothing yet.
  const lastRootPathRef = useRef(args.rootPath);
  useEffect(() => {
    if (lastRootPathRef.current !== args.rootPath) {
      lastRootPathRef.current = args.rootPath;
      if (dragRef.current) setActiveDrag(null);
      setPopover(null);
    }
  }, [args.rootPath]);

  const revertLabel = useCallback(
    (subject: DragSubject): string => {
      if (subject.kind === "run") {
        const p = productViewFor(subject.run, index.productById);
        return `${p?.name ?? "Run"} ${ctx.formatRange?.(subject.run.startMin, subject.run.endMin) ?? ""}`;
      }
      if (subject.kind === "assignment") {
        const op = operatorViewFor(subject.assignment, index.operatorById);
        return `${op?.displayName ?? "Assignment"} ${ctx.formatRange?.(subject.assignment.startMin, subject.assignment.endMin) ?? ""}`;
      }
      return "New block";
    },
    [index, ctx],
  );

  /**
   * T12 — a revert must still say WHICH block snapped back.
   * `CapacityExceeded` / `NotEligible` / `RunOverlap` already name the
   * operator or the cell, so those go through D37's one true path
   * untouched. Every other kind (`NotPermitted`, `RaceLost`,
   * `InvalidArgument`, `Unknown`) would otherwise produce a bare sentence
   * with no clue which of a screenful of blocks just moved back — so those
   * get the block label prefixed.
   *
   * Wired in by the design session at P1-4b acceptance: `revertLabel` was
   * built but never called, which typecheck caught as dead code. Deleting
   * it would have silently dropped T12, so it was connected instead.
   */
  const failWith = useCallback(
    (err: unknown, label: string) => {
      const se = isSchedulerError(err) ? err : toSchedulerError(err);
      if (se.kind === "CapacityExceeded" || se.kind === "NotEligible" || se.kind === "RunOverlap") {
        toast.schedulerError(se, ctx);
        return;
      }
      toast.reverted(`${label}: ${describeSchedulerError(se)}`);
    },
    [toast, ctx],
  );

  // --------------------------------------------------------------------
  // Block drag (move / resize) — RunBand, AssignmentChip, DirectBlock.
  // --------------------------------------------------------------------

  const beginBlockDrag = useCallback((d: BlockDragDescriptor, e: React.PointerEvent) => {
    e.stopPropagation();
    setPopover(null);
    const hit = hitTestBlock(d.offsetXPx, d.blockWidthPx, d.handlePx);
    const mode: DragMode =
      hit === "body" ? "move" : hit === "start" ? "resize-start" : "resize-end";
    const homeRun = d.subject.kind === "assignment" ? d.subject.homeRun : null;

    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const next: InternalDragState = {
      mode,
      nodeId: d.nodeId,
      subject: d.subject,
      original: d.original,
      candidate: d.original,
      moved: false,
      pointerId: e.pointerId,
      pxPerHour: d.pxPerHour,
      windowMinutes: d.windowMinutes,
      snap: snapConfigFor(d.zoomIndex, d.template, d.dayAxis),
      originClientX: e.clientX,
      originClientY: e.clientY,
      altKey: e.altKey,
      runsOnNode: d.runsOnNode,
      crew: d.crew,
      homeRun,
      createAnchorMin: 0,
      createCurrentMin: 0,
      dropTargetNodeId: null,
      dropRefused: false,
      pointerClientX: e.clientX,
      pointerClientY: e.clientY,
    };
    setActiveDrag(next);
  }, []);

  const computeBlockCandidate = useCallback(
    (d: InternalDragState, clientX: number, altKey: boolean): Range => {
      const deltaPxRaw = clientX - d.originClientX;
      const deltaMinRaw = pxToMinutes(deltaPxRaw, d.pxPerHour);
      const bounds = boundsFor(d);
      // The window fed to Part A's clamp is expressed relative to minute 0 of
      // the FULL board window in every case (moveWithinTrack/resizeRange both
      // clamp against `[0, windowMinutes]`); for a run-bounded assignment we
      // additionally clamp the result into `bounds` afterward rather than
      // reparametrizing Part A's pure functions (kept exactly as validated by
      // the §11/§12 harness — see the agent report).
      const original = d.original!;
      if (d.mode === "move") {
        const snappedDelta =
          snapMinute(original.startMin + deltaMinRaw, {
            altKey,
            useShiftSnap: d.snap.useShiftSnap,
            snapMinutes: d.snap.snapMinutes,
            shiftPoints: d.snap.shiftPoints,
          }) - original.startMin;
        const moved = moveWithinTrack(original, snappedDelta, d.windowMinutes);
        if (bounds.startMin === 0 && bounds.endMin === d.windowMinutes) return moved;
        const duration = original.endMin - original.startMin;
        const clampedStart = Math.max(
          bounds.startMin,
          Math.min(moved.startMin, bounds.endMin - duration),
        );
        return { startMin: clampedStart, endMin: clampedStart + duration };
      }
      const edge = d.mode === "resize-start" ? "start" : "end";
      const rawTarget =
        edge === "start" ? original.startMin + deltaMinRaw : original.endMin + deltaMinRaw;
      const snapped = snapMinute(rawTarget, {
        altKey,
        useShiftSnap: d.snap.useShiftSnap,
        snapMinutes: d.snap.snapMinutes,
        shiftPoints: d.snap.shiftPoints,
      });
      const snappedDelta = snapped - (edge === "start" ? original.startMin : original.endMin);
      let candidate = resizeRange(original, edge, snappedDelta, d.windowMinutes);
      if (!(bounds.startMin === 0 && bounds.endMin === d.windowMinutes)) {
        candidate = {
          startMin: Math.max(candidate.startMin, bounds.startMin),
          endMin: Math.min(candidate.endMin, bounds.endMin),
        };
        if (edge === "start") {
          candidate.startMin = Math.min(candidate.startMin, original.endMin - MIN_DURATION_MINUTES);
        } else {
          candidate.endMin = Math.max(candidate.endMin, original.startMin + MIN_DURATION_MINUTES);
        }
      }
      return candidate;
    },
    [],
  );

  const updateBlockDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.subject.kind === "new" || d.subject.kind === "panel") return;
      // DEF-0015: a viewer's block never follows the pointer — the move/resize
      // does not start. `moved` stays false, so the pointerup opens the block's
      // read-only pop-up (the click fallback) rather than committing anything.
      if (!canPlaceRef.current) return;
      const movedPx = Math.hypot(e.clientX - d.originClientX, e.clientY - d.originClientY);
      const moved = d.moved || movedPx >= DRAG_THRESHOLD_PX;
      const candidate = computeBlockCandidate(d, e.clientX, e.altKey);

      // D58/D59: cross-cell target resolution — a RUN move only (D57's own
      // scope; an assignment chip's re-parenting, D66, is same-row/
      // horizontal-only and needs no vertical row resolution). T22: this
      // re-resolves against the CURRENT resolver/index on every move, never
      // a value cached from pointerdown.
      let dropTargetNodeId: string | null = null;
      let dropRefused = false;
      if (d.subject.kind === "run" && d.mode === "move" && dropRowResolverRef.current) {
        const hit = dropRowResolverRef.current(e.clientX, e.clientY);
        if (hit && hit.isTrack && hit.nodeId !== d.nodeId) {
          dropTargetNodeId = hit.nodeId;
          const targetRuns = index.runsByNode.get(hit.nodeId) ?? [];
          dropRefused = findRunOverlap(candidate, targetRuns, null) !== null;
        }
      }

      setActiveDrag({
        ...d,
        candidate,
        moved,
        altKey: e.altKey,
        dropTargetNodeId,
        dropRefused,
        pointerClientX: e.clientX,
        pointerClientY: e.clientY,
      });
    },
    [computeBlockCandidate, index],
  );

  const openEditPopoverFor = useCallback((d: InternalDragState, x: number, y: number) => {
    if (d.subject.kind === "run") {
      setPopover({
        kind: "run",
        nodeId: d.nodeId,
        run: d.subject.run,
        crew: d.crew,
        anchor: { x, y },
      });
    } else if (d.subject.kind === "assignment") {
      setPopover({
        kind: "assignment",
        nodeId: d.nodeId,
        assignment: d.subject.assignment,
        homeRun: d.subject.homeRun,
        anchor: { x, y },
      });
    }
  }, []);

  /** §9 debt 2: the crew-outside-the-run-window warning as an in-app
   *  confirm step (`PopoverState.kind === "confirm"`), replacing
   *  `window.confirm` — a blocking browser dialog that "cannot be styled
   *  or tested through the DOM as it stands" (brief §9 item 2). */
  const askConfirm = useCallback(
    (message: string, anchor: { x: number; y: number }, onConfirm: () => void) => {
      setPopover({ kind: "confirm", message, anchor, onConfirm });
    },
    [],
  );

  /** R-031: the same shell with more than one way to say yes. */
  const askChoice = useCallback(
    (
      title: string,
      message: string,
      anchor: { x: number; y: number },
      choices: readonly ConfirmChoice[],
    ) => {
      setPopover({ kind: "confirm", title, message, anchor, onConfirm: () => {}, choices });
    },
    [],
  );

  /**
   * R-385: `commitBlockDrag`'s assignment branch, EXTRACTED so an edge-resize
   * drag and the typed command bar's re-time path (`retimeAssignmentFromCommand`
   * below) commit through the SAME function — attachment by containment
   * (D66), the R-365 attachment prompt, the R-031 keep-or-scale prompt, the
   * R-361 warn mirrors and the one `updateAssignmentFields` PATCH are all the
   * drag's own code, never a second copy. Moved verbatim from the old
   * `else if (d.subject.kind === "assignment")` branch; the only
   * substitutions are `d.nodeId` -> `nodeId`, `d.homeRun` -> `homeRun`,
   * `d.subject.assignment` -> `a`, `revertLabel(d.subject)` -> `revert`
   * (each now a parameter instead of read off the drag descriptor).
   */
  const retimeAssignment = useCallback(
    (
      a: IndexedAssignment,
      nodeId: string,
      homeRun: IndexedRun | null,
      candidate: Range,
      anchor: { x: number; y: number },
      revert: string,
    ) => {
      // D66: does the candidate still fit its current run? A different
      // run on the SAME node? No run at all (detach, or stay direct)?
      // Picking the target by CONTAINMENT (assignmentFitsRun) is what
      // makes D66's "dropping onto a run whose time range does not
      // contain the assignment is refused before sending" hold BY
      // CONSTRUCTION here — we only ever select a run that already
      // contains the candidate, so there is no separate rejection branch
      // to write (see the agent report's assumptions section for the
      // fuller reasoning, including the direct-assignment-onto-a-run
      // direction this generalizes to, which the mockup's `startDirectDrag`
      // does not attempt but which reuses the identical mechanism).
      const stillFitsHome = homeRun !== null && assignmentFitsRun(candidate, homeRun);
      const runsHere = index.runsByNode.get(nodeId) ?? [];
      const otherFit = stillFitsHome
        ? null
        : (runsHere.find(
            (r) => (homeRun === null || r.id !== homeRun.id) && assignmentFitsRun(candidate, r),
          ) ?? null);

      const edit: AssignmentFieldEdit = {
        timerange: {
          start: minuteDate(index.windowStart, candidate.startMin),
          end: minuteDate(index.windowStart, candidate.endMin),
        },
      };
      if (!stillFitsHome) {
        if (otherFit) {
          edit.runId = otherFit.id;
          edit.productId = null;
        } else if (homeRun !== null) {
          // Detach: mirrors `delete_run`'s own detach-mode UPDATE
          // (docs/api.md §3) — `run_id = NULL, product_id = <run's
          // product>`, both in the same patch.
          edit.runId = null;
          edit.productId = homeRun.productId;
        }
        // else: was already direct and still fits no run — no
        // runId/productId change, just the time move.
      }

      // R-365 / D66: the RUN the candidate ends up attached to — the same
      // choice `edit` above already made (`stillFitsHome` keeps `homeRun`,
      // otherwise `otherFit`, which is `null` for a detach or an
      // already-direct chip that still fits nothing). Reusing the value
      // rather than recomputing it is what keeps the confirm prompt and
      // the write it guards from ever disagreeing about what is about to
      // happen.
      const targetRun = stillFitsHome ? homeRun : otherFit;
      const runLabel = (run: IndexedRun | null): string | null => {
        if (run === null) return null;
        const p = productViewFor(run, index.productById);
        return `${p?.name ?? "Run"} ${ctx.formatRange?.(run.startMin, run.endMin) ?? ""}`.trim();
      };
      // D110: a departed person's row has `operatorId === null` — nobody
      // to name in the prompt, so it falls back the same way the mirror
      // toasts below already do.
      const person =
        a.operatorId !== null
          ? (index.operatorById.get(a.operatorId)?.displayName ?? "This person")
          : "This person";
      // Decided on run IDS here, not on the labels the message shows: two
      // runs on one track cannot overlap (`findRunOverlap`), so equal labels
      // do imply the same run today -- but that is a rule living in another
      // function, and "is it the same run?" is a fact this branch already
      // holds. `attachmentChangeMessage`'s own label compare is a guard, not
      // the decision.
      const attachmentMessage =
        (homeRun?.id ?? null) === (targetRun?.id ?? null)
          ? null
          : attachmentChangeMessage({
              person,
              from: runLabel(homeRun),
              to: runLabel(targetRun),
            });

      // R-365: everything from the R-361 mirror toasts through the write
      // itself is deferred into this closure so a prompted drop toasts and
      // writes NOTHING until Continue — the mirrors must not run ahead of
      // the confirm, because a toast (unlike the mutation) cannot be
      // un-sent on Cancel.
      const commitAssignmentMove = () => {
        // P1-4e considered, and rejected, running a `capacity_probe` +
        // split-coverage popover ahead of an EXISTING chip's own time
        // move (brief §5 step 1 lists "chip move" as a split-coverage
        // trigger). `apply_split_coverage`'s `p_adjustments` shape
        // (docs/api.md §3) only ever carries `{assignment_id, efficiency}`
        // — no `timerange` — so an existing assignment that is both
        // MOVING and needing its efficiency dialled down cannot be
        // expressed as that call's `p_new_assignment` (reserved for a
        // brand-new INSERT) either. Making this case go through the split
        // flow would need a second write after `apply_split_coverage`,
        // which hazard #4 forbids ("never several calls"). Left as the
        // ordinary `updateAssignmentFields` PATCH below; the
        // `assignments_capacity` trigger still guards it exactly as
        // before P1-4e, and a rejection surfaces through the existing
        // `CapacityExceeded` toast path (`failWith`), unchanged.
        //
        // ⭐ R-361: this PATCH sets `timerange` (a resize on the block's edge,
        // or a same-cell nudge) — migration 0070's `assignments_resize_guard`
        // now asks `check_eligibility`/`absence_overlap` on it exactly as the
        // four scheduler RPCs do. Under `block` a refusal comes back as
        // `NotEligible`/`Absent` and `failWith` below shows it, unchanged. A
        // trigger cannot return a warning, so under `warn` the client runs
        // the SAME two mirrors the create/reassign pop-ups already run
        // (`certificateGaps`, `absenceGaps`) against the window it is about
        // to write, and on a hit toasts the SAME wording the crew-drag
        // success toast already uses above (`commitBlockDrag`'s `run`/`move`
        // branch) — count 1, not invented copy. A departed person's row
        // (`a.operatorId === null`, D110) has nobody to ask about and is
        // skipped, matching the trigger's own guard.
        if (a.operatorId !== null && policyForNode(index, nodeId) === "warn") {
          const operatorId = a.operatorId;
          const windowEnd = minuteDate(index.windowStart, candidate.endMin);
          const operatorRecord = index.operatorById.get(operatorId);
          const nodeName = index.nodeById.get(nodeId)?.name ?? nodeId;
          const operatorName = operatorRecord?.displayName ?? operatorId;

          if (operatorRecord) {
            const requiredSkills = index.skillsForNode.get(nodeId) ?? [];
            const gaps = certificateGaps(operatorRecord, requiredSkills, windowEnd);
            if (gaps.length > 0) {
              toast.info(
                `1 of the crew (${operatorName}) not certified for ${nodeName} — override recorded.`,
              );
            }
          }

          const absenceHit = absenceGaps(resizeAbsences, operatorId, {
            start: minuteDate(index.windowStart, candidate.startMin),
            end: windowEnd,
          });
          if (absenceHit !== null) {
            const when = leaveLine(absenceHit, dateFormat, index.zone);
            toast.info(
              `1 of the crew moved over leave — ${operatorName}: ${when}. Override recorded.`,
            );
          }
        }

        updateAssignmentFields.mutate(
          { assignmentId: a.id, edit },
          { onError: (err) => failWith(err, revert) },
        );
      };

      const proceed = () => {
        if (attachmentMessage === null) {
          // No attachment change (same run both sides, or an already-direct
          // chip staying direct) — R-365 only asks when the run a chip
          // belongs to would change, so this is the unchanged, un-prompted
          // path.
          commitAssignmentMove();
        } else {
          // R-365: Cancel needs no extra code here. `endBlockDrag` (above)
          // already cleared `activeDrag` before calling `commitBlockDrag`
          // (T11), and `commitAssignmentMove` has not run yet, so nothing
          // has been written or optimistically patched — the chip is
          // already back where the (untouched) index has it. `confirmNo`
          // just closes the popover.
          askConfirm(attachmentMessage, anchor, commitAssignmentMove);
        }
      };

      // R-031: a TYPED target is a total for the block's window, so a
      // resize that changes the window's length changes what the number
      // means. Ask which the person meant — keep the total, or scale it to
      // the new length — before anything is written. Only an edge drag
      // can get here with a different length (a move keeps it), only a
      // typed target asks (a derived one already follows the resize, R-316),
      // and a scaled figure that rounds back to the typed one has nothing
      // to ask about. `edit` is the same object `commitAssignmentMove`
      // reads, so choosing Scale sets the quantity on the very write the
      // prompt guards, and the unit stays as typed. Cancel writes nothing,
      // exactly as R-365's own prompt.
      const oldMinutes = a.endMin - a.startMin;
      const newMinutes = candidate.endMin - candidate.startMin;
      const scaled =
        a.targetQty !== null && newMinutes !== oldMinutes
          ? scaledTarget(a.targetQty, oldMinutes, newMinutes)
          : null;
      if (a.targetQty !== null && scaled !== null && scaled !== a.targetQty) {
        const typed = a.targetQty;
        const unitSuffix = a.targetUnit ? ` ${a.targetUnit}` : "";
        askChoice(
          "Keep or scale?",
          targetResizeMessage({
            person,
            qty: typed,
            unit: a.targetUnit,
            oldMinutes,
            newMinutes,
            scaled,
          }),
          anchor,
          [
            { label: `Keep ${typed}${unitSuffix}`, onChoose: proceed },
            {
              label: `Scale to ${scaled}${unitSuffix}`,
              onChoose: () => {
                edit.targetQty = scaled;
                proceed();
              },
            },
          ],
        );
        return;
      }
      proceed();
    },
    [
      index,
      ctx,
      toast,
      updateAssignmentFields,
      failWith,
      askConfirm,
      askChoice,
      dateFormat,
      resizeAbsences,
    ],
  );

  /**
   * S41-a: `commitBlockDrag`'s run-RESIZE branch, EXTRACTED so an edge-resize
   * drag and the typed command bar's re-time-a-job path
   * (`retimeRunFromCommand` below) commit through the SAME function — the
   * overlap refusal, the "N crew assignments fall outside the new run
   * window. Continue?" prompt and the one `updateRunFields` PATCH are all the
   * drag's own code, never a second copy. Moved verbatim from the old
   * "// Resize: unchanged from P1-4b except the confirm step" section; the
   * only substitutions are `d.nodeId` -> `nodeId`, `d.subject` in
   * `revertLabel(d.subject)` -> `revert` (a parameter instead of read off the
   * drag descriptor), and `currentRunsOnNode`/`currentCrew` recomputed here
   * from `index` (the move branch above still keeps its own copies of those
   * two lines — this function does not share the caller's locals).
   */
  const retimeRun = useCallback(
    (
      run: IndexedRun,
      nodeId: string,
      candidate: Range,
      anchor: { x: number; y: number },
      revert: string,
    ) => {
      const currentRunsOnNode = index.runsByNode.get(nodeId) ?? [];
      const currentCrew = index.assignmentsByRun.get(run.id) ?? [];

      // Resize: unchanged from P1-4b except the confirm step (§9 debt 2).
      const overlap = findRunOverlap(candidate, currentRunsOnNode, run.id);
      if (overlap) {
        const p = productViewFor(overlap, index.productById);
        toast.reverted(
          `${index.nodeById.get(nodeId)?.name ?? nodeId} already runs ${p?.name ?? "another product"} ${ctx.formatRange?.(overlap.startMin, overlap.endMin) ?? ""}`,
        );
        return;
      }
      const commitResize = () => {
        updateRunFields.mutate(
          {
            runId: run.id,
            edit: {
              timerange: {
                start: minuteDate(index.windowStart, candidate.startMin),
                end: minuteDate(index.windowStart, candidate.endMin),
              },
            },
          },
          { onError: (err) => failWith(err, revert) },
        );
      };
      if (currentCrew.length > 0) {
        const { clipped, stranded } = classifyCrewAgainstRun(candidate, currentCrew);
        const affected = clipped.length + stranded.length;
        if (affected > 0) {
          askConfirm(
            `${affected} crew assignment${affected === 1 ? "" : "s"} fall outside the new run window. Continue?`,
            anchor,
            commitResize,
          );
          return;
        }
      }
      commitResize();
    },
    [index, ctx, toast, updateRunFields, failWith, askConfirm],
  );

  const commitBlockDrag = useCallback(
    (d: InternalDragState, anchor: { x: number; y: number }) => {
      // DEF-0015: a viewer never commits a move/resize. In practice `moved`
      // can never become true for them (updateBlockDrag/handleBlockKeyDown are
      // both gated), so this is defence-in-depth on the one write path.
      if (!canPlaceRef.current) return;
      const candidate = d.candidate!;
      if (d.subject.kind === "run") {
        const run = d.subject.run;
        // T10: check against the CURRENT index, not the drag-start snapshot
        // (`d.runsOnNode`/`d.crew`) — a background refetch may have landed
        // mid-drag, and the mutation must be judged against what the
        // server actually has now, not what it had at pointerdown.
        const currentRunsOnNode = index.runsByNode.get(d.nodeId) ?? [];
        const currentCrew = index.assignmentsByRun.get(run.id) ?? [];

        if (d.mode === "move") {
          // D57: the refusal message is DELETED, not reworded — a staffed
          // run now moves, crew and all, in one `move_run` call. That
          // atomicity requirement applies just as much to a SAME-cell time
          // move of a staffed run (the crew still needs shifting by the
          // same delta) as to a cross-cell one, so `needsMoveRun` covers
          // both: crossing a cell boundary (`dropTargetNodeId` set) OR
          // carrying crew (regardless of whether the cell changes).
          const targetNodeId = d.dropTargetNodeId;
          // T22: the hovered target row vanished mid-drag (a refetch/
          // collapse) — cancel silently rather than moving to a node that
          // no longer exists in the loaded index.
          if (targetNodeId !== null && !index.nodeById.has(targetNodeId)) return;

          const needsMoveRun = targetNodeId !== null || currentCrew.length > 0;
          const destinationNodeId = targetNodeId ?? d.nodeId;
          const destinationRuns =
            targetNodeId !== null ? (index.runsByNode.get(targetNodeId) ?? []) : currentRunsOnNode;

          // D59: refuse a drop onto a row that already holds an
          // overlapping active run — checked here against the CURRENT
          // index (T10), not the drag-time `dropRefused` hint alone.
          const overlap = findRunOverlap(candidate, destinationRuns, run.id);
          if (overlap) {
            const p = productViewFor(overlap, index.productById);
            toast.reverted(
              `${index.nodeById.get(destinationNodeId)?.name ?? destinationNodeId} already runs ${p?.name ?? "another product"} ${ctx.formatRange?.(overlap.startMin, overlap.endMin) ?? ""}`,
            );
            return;
          }

          if (needsMoveRun) {
            moveRun.mutate(
              {
                runId: run.id,
                nodeId: destinationNodeId,
                start: minuteDate(index.windowStart, candidate.startMin),
                end: minuteDate(index.windowStart, candidate.endMin),
              },
              {
                // T23: `eligibilityWarnings` is informational — the move
                // has already SUCCEEDED (D60). Never treated as a failure.
                onSuccess: (result) => {
                  if (result.eligibilityWarnings.length > 0) {
                    const names = result.eligibilityWarnings
                      .map((w) => index.operatorById.get(w.operatorId)?.displayName ?? w.operatorId)
                      .join(", ");
                    const destName =
                      index.nodeById.get(destinationNodeId)?.name ?? destinationNodeId;
                    toast.info(
                      `${result.eligibilityWarnings.length} of the crew (${names}) not certified for ${destName} — override recorded.`,
                    );
                  }
                  // R-357: the TWIN of the eligibility warning above, and the one
                  // place the drag path used to swallow it. A warn-move carries
                  // `absence_warnings` for every crew member moved onto a window
                  // they are away for (D60: informational — the move already
                  // succeeded). Named the way the create/reassign pop-ups name it:
                  // the person, then `leaveLine`'s "On leave <dates>: reason" in
                  // the plant's own date format. An entry in `absence_warnings` is
                  // `absent:true` by construction (the server only emits away
                  // crew), so `from`/`to` are non-null — guarded anyway, a mirror
                  // never throws.
                  //
                  // R-359: `a.startsAt`/`a.endsAt` (present together on a
                  // part-day hit) must ride along into `leaveLine`'s argument —
                  // dropping them here is what silently turned a part-day
                  // absence into a whole-day one. `index.zone` is the same
                  // board zone `formatRange` above (line ~308) already reads;
                  // an absent hit's hours must never print in UTC just because
                  // this call site forgot to pass the zone it already has.
                  if (result.absenceWarnings.length > 0) {
                    const lines = result.absenceWarnings
                      .map((w) => {
                        const name =
                          index.operatorById.get(w.operatorId)?.displayName ?? w.operatorId;
                        const a = w.absence;
                        const when =
                          a.from !== null && a.to !== null
                            ? leaveLine(
                                {
                                  from: a.from,
                                  to: a.to,
                                  reason: a.reason ?? "",
                                  startsAt: a.startsAt,
                                  endsAt: a.endsAt,
                                },
                                dateFormat,
                                index.zone,
                              )
                            : "on leave";
                        return `${name}: ${when}`;
                      })
                      .join("; ");
                    toast.info(
                      `${result.absenceWarnings.length} of the crew moved over leave — ${lines}. Override recorded.`,
                    );
                  }
                },
                onError: (err) => failWith(err, revertLabel(d.subject)),
              },
            );
            return;
          }

          // Unstaffed, same cell: a plain time-only field edit — no RPC
          // needed (docs/api.md §4).
          updateRunFields.mutate(
            {
              runId: run.id,
              edit: {
                timerange: {
                  start: minuteDate(index.windowStart, candidate.startMin),
                  end: minuteDate(index.windowStart, candidate.endMin),
                },
              },
            },
            { onError: (err) => failWith(err, revertLabel(d.subject)) },
          );
          return;
        }

        // S41-a: the resize path itself is `retimeRun` (extracted above) —
        // the drag's run branch calls it for every mode but "move".
        retimeRun(run, d.nodeId, candidate, anchor, revertLabel(d.subject));
      } else if (d.subject.kind === "assignment") {
        retimeAssignment(
          d.subject.assignment,
          d.nodeId,
          d.homeRun,
          candidate,
          anchor,
          revertLabel(d.subject),
        );
      }
    },
    [
      index,
      ctx,
      toast,
      moveRun,
      updateRunFields,
      failWith,
      revertLabel,
      dateFormat,
      retimeRun,
      retimeAssignment,
    ],
  );

  const endBlockDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      const anchor = { x: e.clientX, y: e.clientY };
      // T11: clear activeDrag BEFORE calling .mutate() — the optimistic
      // patch must never be read back in as a new drag origin.
      setActiveDrag(null);
      if (!d.moved) {
        openEditPopoverFor(d, anchor.x, anchor.y);
        return;
      }
      commitBlockDrag(d, anchor);
    },
    [openEditPopoverFor, commitBlockDrag],
  );

  const cancelDrag = useCallback((e?: React.PointerEvent) => {
    if (e) {
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture may already be gone (pointercancel) — fine.
      }
    }
    setActiveDrag(null);
  }, []);

  // --- Escape / pointercancel (T16), global. ------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && dragRef.current) {
        setActiveDrag(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --------------------------------------------------------------------
  // Track create-drag (drag on empty track).
  // --------------------------------------------------------------------

  const beginTrackCreateDrag = useCallback(
    (d: TrackCreateDescriptor, e: React.PointerEvent) => {
      // DEF-0015: a viewer cannot create — a click-drag on an empty track does
      // nothing (the quiet choice: no drag begins, no status toast). Guarded
      // here, before pointer capture, so nothing on the track ever starts.
      if (!canPlaceRef.current) return;
      setPopover(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const snap = snapConfigFor(d.zoomIndex, d.template, d.dayAxis);
      const rawAnchor = pxToMinutes(e.clientX - d.trackLeftPx, d.pxPerHour);
      const anchorMin = Math.max(
        0,
        Math.min(
          d.windowMinutes,
          snapMinute(rawAnchor, {
            altKey: e.altKey,
            useShiftSnap: snap.useShiftSnap,
            snapMinutes: snap.snapMinutes,
            shiftPoints: snap.shiftPoints,
          }),
        ),
      );
      const next: InternalDragState = {
        mode: "create",
        nodeId: d.nodeId,
        subject: { kind: "new" },
        original: null,
        candidate: { startMin: anchorMin, endMin: anchorMin },
        moved: false,
        pointerId: e.pointerId,
        pxPerHour: d.pxPerHour,
        windowMinutes: d.windowMinutes,
        snap,
        originClientX: e.clientX,
        originClientY: e.clientY,
        altKey: e.altKey,
        runsOnNode: index.runsByNode.get(d.nodeId) ?? [],
        crew: [],
        homeRun: null,
        createAnchorMin: anchorMin,
        createCurrentMin: anchorMin,
        dropTargetNodeId: null,
        dropRefused: false,
        pointerClientX: e.clientX,
        pointerClientY: e.clientY,
      };
      setActiveDrag(next);
    },
    [index],
  );

  const updateTrackCreateDrag = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.mode !== "create") return;
    const movedPx = Math.hypot(e.clientX - d.originClientX, e.clientY - d.originClientY);
    const moved = d.moved || movedPx >= DRAG_THRESHOLD_PX;
    const deltaMin = pxToMinutes(e.clientX - d.originClientX, d.pxPerHour);
    const rawCurrent = d.createAnchorMin + deltaMin;
    const currentMin = snapMinute(rawCurrent, {
      altKey: e.altKey,
      useShiftSnap: d.snap.useShiftSnap,
      snapMinutes: d.snap.snapMinutes,
      shiftPoints: d.snap.shiftPoints,
    });
    // `createRange` returns null once the (still in-progress) span drops
    // under MIN_DURATION_MINUTES — that must not blank the ghost, so a
    // plain normalized min/max stands in until it clears the threshold.
    const range = createRange(d.createAnchorMin, currentMin, d.windowMinutes);
    const candidate = range ?? {
      startMin: Math.min(d.createAnchorMin, currentMin),
      endMin: Math.max(d.createAnchorMin, currentMin),
    };
    setActiveDrag({ ...d, candidate, moved, altKey: e.altKey, createCurrentMin: currentMin });
  }, []);

  const endTrackCreateDrag = useCallback(
    (e: React.PointerEvent, template: ShiftTemplate | null) => {
      const d = dragRef.current;
      if (!d || d.mode !== "create") return;
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      const nodeId = d.nodeId;
      const moved = d.moved;
      const anchorMin = d.createAnchorMin;
      const currentMin = d.createCurrentMin;
      const windowMinutes = d.windowMinutes;
      setActiveDrag(null);
      if (!moved) return; // a click on empty track does nothing (D32)
      const range = createRange(anchorMin, currentMin, windowMinutes);
      if (!range) return; // shorter than MIN_DURATION_MINUTES (D31, case 6)
      const chips = shiftChipsFor(template, range.startMin, windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId,
        range,
        anchor: { x: e.clientX, y: e.clientY },
        shiftChips: chips,
      });
    },
    [],
  );

  // --------------------------------------------------------------------
  // Keyboard path (§8): arrow keys move/resize a focused block by one
  // snap step, committing on keyup. Reuses the exact same drag state and
  // commit path as a pointer drag — the only difference is how the
  // candidate's delta is produced.
  // --------------------------------------------------------------------

  const handleBlockKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      ctxDescriptor: Omit<BlockDragDescriptor, "handlePx" | "blockWidthPx" | "offsetXPx">,
    ) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (ctxDescriptor.subject.kind === "run") {
          setPopover({
            kind: "run",
            nodeId: ctxDescriptor.nodeId,
            run: ctxDescriptor.subject.run,
            crew: ctxDescriptor.crew,
            anchor: { x: rect.left, y: rect.bottom },
          });
        } else if (ctxDescriptor.subject.kind === "assignment") {
          setPopover({
            kind: "assignment",
            nodeId: ctxDescriptor.nodeId,
            assignment: ctxDescriptor.subject.assignment,
            homeRun: ctxDescriptor.subject.homeRun,
            anchor: { x: rect.left, y: rect.bottom },
          });
        }
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // DEF-0015: Enter/Space above still opens the block's pop-up (read-only
      // for a viewer, decided in BoardPage) — but a viewer cannot nudge a block
      // with the arrow keys, so the move/resize path stops here.
      if (!canPlaceRef.current) return;
      e.preventDefault();
      const snap = snapConfigFor(
        ctxDescriptor.zoomIndex,
        ctxDescriptor.template,
        ctxDescriptor.dayAxis,
      );
      const step = snap.snapMinutes * (e.key === "ArrowLeft" ? -1 : 1);
      const existing = dragRef.current;
      const mode: DragMode = e.shiftKey ? "resize-end" : "move";
      const base: InternalDragState =
        existing && existing.mode === mode && existing.nodeId === ctxDescriptor.nodeId
          ? existing
          : {
              mode,
              nodeId: ctxDescriptor.nodeId,
              subject: ctxDescriptor.subject,
              original: ctxDescriptor.original,
              candidate: ctxDescriptor.original,
              moved: false,
              pointerId: -1,
              pxPerHour: ctxDescriptor.pxPerHour,
              windowMinutes: ctxDescriptor.windowMinutes,
              snap,
              originClientX: 0,
              originClientY: 0,
              altKey: false,
              runsOnNode: ctxDescriptor.runsOnNode,
              crew: ctxDescriptor.crew,
              homeRun:
                ctxDescriptor.subject.kind === "assignment" ? ctxDescriptor.subject.homeRun : null,
              createAnchorMin: 0,
              createCurrentMin: 0,
              dropTargetNodeId: null,
              dropRefused: false,
              pointerClientX: 0,
              pointerClientY: 0,
            };
      const original = base.original!;
      const cur = base.candidate ?? original;
      let candidate: Range;
      if (mode === "move") {
        candidate = moveWithinTrack(cur, step, base.windowMinutes);
      } else {
        candidate = resizeRange(cur, "end", step, base.windowMinutes);
      }
      setActiveDrag({ ...base, candidate, moved: true });
    },
    [],
  );

  const handleBlockKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const d = dragRef.current;
      if (!d || d.pointerId !== -1) return;
      setActiveDrag(null);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      commitBlockDrag(d, { x: rect.left, y: rect.bottom });
    },
    [commitBlockDrag],
  );

  const handleTrackKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      d: { nodeId: string; template: ShiftTemplate | null; windowMinutes: number },
    ) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // DEF-0015: Enter on an empty track opens the create pop-up, which a
      // viewer may not do — nothing happens (the quiet choice, matching the
      // click-drag path in beginTrackCreateDrag).
      if (!canPlaceRef.current) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const defaultRange = defaultShiftRange(d.template, d.windowMinutes);
      const chips = shiftChipsFor(d.template, defaultRange.startMin, d.windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId: d.nodeId,
        range: defaultRange,
        anchor: { x: rect.left + 8, y: rect.top + 8 },
        shiftChips: chips,
      });
    },
    [],
  );

  // --------------------------------------------------------------------
  // D65/§7 — panel drag origin. `OperatorPanel` wires these three from
  // pointerdown/move/up on each roster chip, the same D33 pointer-capture
  // pattern as every other drag in this file (one state machine, D29 — no
  // second controller). D65's own words: "On drop, open the create popover
  // pre-filled with that operator and the dropped time range, in DIRECT
  // mode, then follow D61/D64" — so there is no separate "auto-staff the
  // hovered run band" branch here (the mockup's `startPanelDrag` has one;
  // this brief's own decision text does not ask for it — see the agent
  // report's assumptions section). Row-level hover detection still exists,
  // for the `.dropHint` highlight and the D65-required `.ineligible` hint
  // (computed per-row in `TrackRow` from `skillsForNode` + the dragged
  // operator's own `skillIds`, never a `check_eligibility` round trip per
  // hovered row — D65's explicit instruction).
  // --------------------------------------------------------------------

  const beginPanelDrag = useCallback(
    (operator: BoardOperator, e: React.PointerEvent) => {
      // DEF-0015: a viewer has no panel to drag from (BoardPage hides it when
      // !canPlace), but the gesture layer refuses the drag too, so the answer
      // is decided in one place rather than resting on the panel being hidden.
      if (!canPlaceRef.current) return;
      setPopover(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const next: InternalDragState = {
        mode: "create",
        nodeId: "",
        subject: { kind: "panel", operator },
        original: null,
        candidate: null,
        moved: false,
        pointerId: e.pointerId,
        pxPerHour: 0,
        windowMinutes: index.windowMinutes,
        snap: { useShiftSnap: false, snapMinutes: 15, shiftPoints: [] },
        originClientX: e.clientX,
        originClientY: e.clientY,
        altKey: e.altKey,
        runsOnNode: [],
        crew: [],
        homeRun: null,
        createAnchorMin: 0,
        createCurrentMin: 0,
        dropTargetNodeId: null,
        dropRefused: false,
        pointerClientX: e.clientX,
        pointerClientY: e.clientY,
      };
      setActiveDrag(next);
    },
    [index],
  );

  const updatePanelDrag = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.subject.kind !== "panel") return;
    let dropTargetNodeId: string | null = null;
    if (dropRowResolverRef.current) {
      const hit = dropRowResolverRef.current(e.clientX, e.clientY);
      if (hit && hit.isTrack) dropTargetNodeId = hit.nodeId;
    }
    setActiveDrag({
      ...d,
      dropTargetNodeId,
      moved: true,
      pointerClientX: e.clientX, // T24: the ghost tracks THIS, every move.
      pointerClientY: e.clientY,
    });
  }, []);

  const endPanelDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.subject.kind !== "panel") return;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture may already be gone (pointercancel) — fine.
      }
      setActiveDrag(null);
      // T24: resolved fresh, from THIS event — never a row/minute cached
      // from an earlier pointermove — so it reflects the container's
      // scroll position at the instant of drop.
      const hit = dropRowResolverRef.current
        ? dropRowResolverRef.current(e.clientX, e.clientY)
        : null;
      // D59-style: not a valid track row (off the board, or a group row)
      // — cancel silently, mirroring T22's "target no longer exists".
      if (!hit || !hit.isTrack || !index.nodeById.has(hit.nodeId)) return;

      const template = index.templateForNode.get(hit.nodeId) ?? null;
      const windowMinutes = index.windowMinutes;
      const snap = snapConfigFor(zoomIndex, template, index.dayAxis);
      const rawStart = Math.max(0, Math.min(windowMinutes, hit.minute));
      const startMin = Math.max(
        0,
        Math.min(
          windowMinutes,
          snapMinute(rawStart, {
            altKey: e.altKey,
            useShiftSnap: snap.useShiftSnap,
            snapMinutes: snap.snapMinutes,
            shiftPoints: snap.shiftPoints,
          }),
        ),
      );
      // Mockup's panel-drop default duration (240 min), clamped to the
      // window — the same fallback `defaultShiftRange` already uses for a
      // keyboard create with no explicit drag distance.
      const endMin = Math.min(windowMinutes, startMin + 240);
      if (endMin - startMin < MIN_DURATION_MINUTES) return; // D31

      const chips = shiftChipsFor(template, startMin, windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId: hit.nodeId,
        range: { startMin, endMin },
        anchor: { x: e.clientX, y: e.clientY },
        shiftChips: chips,
        presetOperatorId: d.subject.operator.id,
      });
    },
    [index, zoomIndex],
  );

  // --------------------------------------------------------------------
  // Popover commit/cancel actions, used by the popover components.
  // --------------------------------------------------------------------

  const closePopover = useCallback(() => setPopover(null), []);

  // §9 debt 1: `saveRunFields`/`deleteRunWithMode`/`saveAssignmentFields`/
  // `removeAssignment` only ever receive an id — these two resolve a
  // revert label from it via `index.runById`/`index.assignmentById` (the
  // same maps `boardIndex.ts` now builds per that debt), so their onError
  // handlers can go through `failWith` (D37's one true path, T12) instead
  // of a bare `toast.schedulerError` with no clue which block reverted.
  const runLabelById = useCallback(
    (runId: string): string => {
      const run = index.runById.get(runId);
      if (!run) return "Run";
      const p = productViewFor(run, index.productById);
      return `${p?.name ?? "Run"} ${ctx.formatRange?.(run.startMin, run.endMin) ?? ""}`;
    },
    [index, ctx],
  );
  const assignmentLabelById = useCallback(
    (assignmentId: string): string => {
      const a = index.assignmentById.get(assignmentId);
      if (!a) return "Assignment";
      const op = operatorViewFor(a, index.operatorById);
      return `${op?.displayName ?? "Assignment"} ${ctx.formatRange?.(a.startMin, a.endMin) ?? ""}`;
    },
    [index, ctx],
  );

  /**
   * R-385: the typed command bar's re-time path — the SAME function an edge-resize
   * drag commits through (`retimeAssignment`), so attachment, the R-365 prompt, the
   * R-031 keep-or-scale prompt, the R-361 warn mirrors and the one PATCH are all the
   * drag's own.
   */
  const retimeAssignmentFromCommand = useCallback(
    (r: { assignmentId: string; range: Range; anchor: { x: number; y: number } }) => {
      if (!canPlaceRef.current) return; // DEF-0015, as commitBlockDrag
      const a = index.assignmentById.get(r.assignmentId);
      if (!a) {
        toast.reverted("That block is no longer on the board.");
        return;
      }
      const homeRun = a.runId !== null ? (index.runById.get(a.runId) ?? null) : null;
      retimeAssignment(a, a.nodeId, homeRun, r.range, r.anchor, assignmentLabelById(a.id));
    },
    [index, toast, retimeAssignment, assignmentLabelById],
  );

  /**
   * P1-7a: `CommandBar`'s whole write path — opens the SAME create popover a
   * drag opens, direct mode forced (`presetOperatorId`, exactly as D65's panel
   * drop already forces it), with the resolved product or run as a preset.
   * This is the tail of `endPanelDrag` (brief §6/§8) with the snapping removed
   * — the resolver's minutes are already exact, never a drag pixel to round —
   * and the target threaded through instead of always being the operator
   * alone. `endPanelDrag` itself is untouched; see its own comment for why the
   * five lines are deliberately duplicated rather than shared.
   */
  const openCreateFromCommand = useCallback(
    (r: {
      nodeId: string;
      range: Range;
      operatorId: string;
      target: AssignmentTarget;
      anchor: { x: number; y: number };
    }) => {
      const template = index.templateForNode.get(r.nodeId) ?? null;
      const chips = shiftChipsFor(template, r.range.startMin, index.windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId: r.nodeId,
        range: r.range,
        anchor: r.anchor,
        shiftChips: chips,
        presetOperatorId: r.operatorId,
        // R-384: the only opener that may auto-press Create.
        autoCreate: true,
        ...(r.target.kind === "direct"
          ? { presetProductId: r.target.productId }
          : { presetRun: { id: r.target.runId, label: runLabelById(r.target.runId) } }),
      });
    },
    [index, runLabelById],
  );

  /**
   * S41-c: the typed command bar's "move to another cell" write path --
   * opens the SAME create popover a drag/command-bar assign opens, direct
   * mode forced by `presetOperatorId` (exactly as `openCreateFromCommand`
   * already forces it), with `presetMove: { assignmentId }` marking this as
   * a MOVE rather than a create: `CreatePopover`'s `submitDirect()` then
   * sends `moveAssignment` instead of `createAssignment` (brief §2 -- no
   * second door, the SAME pop-up, a different door out of it).
   */
  const openMoveFromCommand = useCallback(
    (r: {
      assignmentId: string;
      nodeId: string;
      range: Range;
      operatorId: string;
      productId: string;
      anchor: { x: number; y: number };
    }) => {
      const template = index.templateForNode.get(r.nodeId) ?? null;
      const chips = shiftChipsFor(template, r.range.startMin, index.windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId: r.nodeId,
        range: r.range,
        anchor: r.anchor,
        shiftChips: chips,
        presetOperatorId: r.operatorId,
        presetProductId: r.productId,
        presetMove: { assignmentId: r.assignmentId },
        // R-384: the only opener that may auto-press Create.
        autoCreate: true,
      });
    },
    [index],
  );

  /**
   * S41-a: the typed command bar's "book a job" write path for a BRAND-NEW
   * job — opens the SAME create popover a track drag opens, forced into
   * Product run mode (`presetMode: "run"`) with the resolved product and
   * headcount preset, exactly as `openCreateFromCommand` forces direct mode
   * for an assignment. Create still goes through `submitCreateRun` ->
   * `createRun` -> `create_run`, the one door.
   */
  const openCreateRunFromCommand = useCallback(
    (r: {
      nodeId: string;
      range: Range;
      productId: string;
      headcount: number | null;
      anchor: { x: number; y: number };
    }) => {
      const template = index.templateForNode.get(r.nodeId) ?? null;
      const chips = shiftChipsFor(template, r.range.startMin, index.windowMinutes);
      setPopover({
        kind: "create",
        seq: (createSeqRef.current += 1),
        nodeId: r.nodeId,
        range: r.range,
        anchor: r.anchor,
        shiftChips: chips,
        presetMode: "run",
        presetProductId: r.productId,
        ...(r.headcount !== null ? { presetHeadcount: r.headcount } : {}),
        // R-384: the only opener that may auto-press Create.
        autoCreate: true,
      });
    },
    [index],
  );

  /**
   * S41-a: R-387's "change that job's hours?" answer -- the SAME function an
   * edge-resize drag commits through (`retimeRun`), so the overlap refusal,
   * the "N crew assignments fall outside..." prompt and the one
   * `updateRunFields` PATCH are all the drag's own.
   */
  const retimeRunFromCommand = useCallback(
    (r: { runId: string; range: Range; anchor: { x: number; y: number } }) => {
      if (!canPlaceRef.current) return; // DEF-0015, as commitBlockDrag
      const run = index.runById.get(r.runId);
      if (!run) {
        toast.reverted("That job is no longer on the board.");
        return;
      }
      retimeRun(run, run.nodeId, r.range, r.anchor, runLabelById(run.id));
    },
    [index, toast, retimeRun, runLabelById],
  );

  const submitCreateRun = useCallback(
    (nodeId: string, range: Range, productId: string, plannedHeadcount: number | undefined) => {
      const overlap = findRunOverlap(range, index.runsByNode.get(nodeId) ?? [], null);
      if (overlap) {
        const p = productViewFor(overlap, index.productById);
        toast.reverted(
          `${index.nodeById.get(nodeId)?.name ?? nodeId} already runs ${p?.name ?? "another product"} ${ctx.formatRange?.(overlap.startMin, overlap.endMin) ?? ""}`,
        );
        return;
      }
      createRun.mutate(
        {
          nodeId,
          productId,
          start: minuteDate(index.windowStart, range.startMin),
          end: minuteDate(index.windowStart, range.endMin),
          plannedHeadcount,
        },
        {
          onSuccess: () => toast.info("Run created — drag operators onto the band to staff it"),
          onError: (err) => {
            const se = isSchedulerError(err) ? err : toSchedulerError(err);
            toast.schedulerError(se, ctx);
          },
        },
      );
      setPopover(null);
    },
    [index, ctx, toast, createRun],
  );

  /**
   * D61/D64: opens PROACTIVELY from a `capacity_probe`, never from a
   * rejection. `incoming` is the FULL `CreateAssignmentInput` minus its own
   * efficiency (that lives in `participants`, D62) so `confirmSplit` below
   * can build `apply_split_coverage`'s `p_new_assignment` straight off it.
   */
  const openSplitPopover = useCallback(
    (probe: CapacityProbe, incoming: CreateAssignmentInput, anchor: { x: number; y: number }) => {
      const operator = index.operatorById.get(incoming.operatorId);
      const participants: SplitParticipant[] = probe.overlapping.map((o) => ({
        assignmentId: o.assignmentId,
        label: `${o.nodeName} · ${fromEfficiency(o.efficiency)}%`,
        efficiencyPercent: fromEfficiency(o.efficiency),
      }));
      participants.push({
        assignmentId: null,
        label: `${index.nodeById.get(incoming.nodeId)?.name ?? incoming.nodeId} · incoming`,
        efficiencyPercent: incoming.efficiencyPercent ?? 100,
      });
      setPopover({
        kind: "split",
        operatorId: incoming.operatorId,
        operatorName: operator?.displayName ?? incoming.operatorId,
        capPercent: Math.round(probe.cap * 100),
        participants,
        incoming,
        anchor,
      });
    },
    [index],
  );

  /**
   * D61: called by BOTH the create popover's direct-assignment submit AND
   * a panel drop's create popover (D65 routes every panel drop through the
   * create popover in direct mode, so there is exactly one code path here,
   * not two). Probes `capacity_probe` first; `fits` proceeds with the
   * ordinary create, `!fits` opens the split popover pre-populated —
   * never the other way around (D61 forbids opening it FROM a rejection).
   */
  const submitCreateDirect = useCallback(
    (
      nodeId: string,
      range: Range,
      operatorId: string,
      // P1-7a: was `productId: string`. `CreatePopover` now sends whichever
      // target the person actually chose — the product select's own choice
      // (D64, unchanged) or, when the popover opened with `presetRun`
      // (R-383), the run that was joined — and this passes it straight
      // through to `CreateAssignmentInput.target` instead of rebuilding a
      // `{ kind: "direct", … }` here, so the popover stays the ONE door and a
      // run target does not need a second submit path beside it.
      target: AssignmentTarget,
      efficiencyPercent: number,
      targetQty: number | undefined,
      targetUnit: string | undefined,
      eligibilityOverride: boolean,
      overrideReason: string | undefined,
      // D113 / migration 0030. A SEPARATE pair from the two above: waving
      // through a missing training must not also place somebody outside the
      // area they are cleared for.
      areaOverride: boolean,
      areaOverrideReason: string | undefined,
      anchor: { x: number; y: number },
    ) => {
      const start = minuteDate(index.windowStart, range.startMin);
      const end = minuteDate(index.windowStart, range.endMin);
      const input: CreateAssignmentInput = {
        nodeId,
        operatorId,
        target,
        start,
        end,
        efficiencyPercent,
        targetQty,
        targetUnit,
        eligibilityOverride,
        overrideReason,
        areaOverride,
        areaOverrideReason,
      };
      const sendCreate = () => {
        createAssignment.mutate(input, {
          onError: (err) => {
            const se = isSchedulerError(err) ? err : toSchedulerError(err);
            // §7: CapacityExceeded on create is not auto-retried, and the
            // brief explicitly wants this path exercised for real (§7).
            // With D61's proactive probe this is now the RACE fallback
            // (the probe said "fits", the write disagreed) rather than
            // the common path.
            toast.schedulerError(se, ctx);
          },
        });
        setPopover(null);
      };
      probeCapacity({ operatorId, start, end, efficiencyPercent })
        .then((probe) => {
          if (probe.fits) {
            sendCreate();
          } else {
            openSplitPopover(probe, input, anchor);
          }
        })
        .catch(() => {
          // The probe is a convenience, never a gate (docs/api.md §2: it
          // "raises nothing"; a thrown error here is a network blip, not a
          // capacity answer). Fall back to the authoritative write — its
          // own CapacityExceeded handling is still the backstop.
          sendCreate();
        });
    },
    [index, ctx, toast, createAssignment, openSplitPopover],
  );

  /** D62's "Split evenly" / live edits / confirm / cancel. */
  const updateSplitParticipant = useCallback((index_: number, efficiencyPercent: number) => {
    setPopover((p) => {
      if (!p || p.kind !== "split") return p;
      const participants = p.participants.map((row, i) =>
        i === index_ ? { ...row, efficiencyPercent } : row,
      );
      return { ...p, participants };
    });
  }, []);

  const splitEvenlyAction = useCallback(() => {
    setPopover((p) => {
      if (!p || p.kind !== "split") return p;
      const shares = splitEvenly(p.participants.length, p.capPercent);
      const participants = p.participants.map((row, i) => ({
        ...row,
        efficiencyPercent: shares[i] ?? row.efficiencyPercent,
      }));
      return { ...p, participants };
    });
  }, []);

  const confirmSplit = useCallback(() => {
    setPopover((p) => {
      if (!p || p.kind !== "split") return p;
      const percents = p.participants.map((row) => row.efficiencyPercent);
      if (!splitFits(percents, p.capPercent)) return p; // Confirm stays disabled while over cap (D62)

      const adjustments = p.participants
        .filter(
          (row): row is SplitParticipant & { assignmentId: string } => row.assignmentId !== null,
        )
        .map((row) => ({
          assignmentId: row.assignmentId,
          efficiencyPercent: row.efficiencyPercent,
        }));
      const incomingParticipant = p.participants.find((row) => row.assignmentId === null);

      // D63: NOT peak load — this is exactly the arithmetic `splitFits`
      // above already validated (the sum of what the user edited). The
      // authoritative peak re-check happens server-side inside
      // `apply_split_coverage` itself (`operator_peak_load()`), and T21
      // covers what happens when THAT disagrees with this client-side sum.
      applySplitCoverage.mutate(
        {
          adjustments,
          newAssignment: {
            ...p.incoming,
            efficiencyPercent: incomingParticipant?.efficiencyPercent ?? 100,
          },
        },
        {
          onError: (err) => {
            // T21: the probe was stale by the time the user confirmed.
            // `apply_split_coverage` is authoritative; a `CapacityExceeded`
            // here is normal, not exceptional — shown IN the popover
            // (re-open it with the user's edits intact) rather than
            // closing it and toasting, because re-editing is the natural
            // next step.
            const se = isSchedulerError(err) ? err : toSchedulerError(err);
            if (se.kind === "CapacityExceeded") {
              toast.info(
                `${p.operatorName} would still exceed capacity (peak ${Math.round(se.peak * 100)}%, cap ${Math.round(se.cap * 100)}%) — adjust and try again.`,
              );
              setPopover(p); // keep it open with the user's edits
              return;
            }
            toast.schedulerError(se, ctx);
          },
        },
      );
      return null; // optimistic close; re-opened above on a CapacityExceeded race
    });
  }, [applySplitCoverage, toast, ctx]);

  const cancelSplit = useCallback(() => setPopover(null), []); // D62: Cancel reverts, sends nothing.

  /* ⛔ F-128: `onConfirm()` used to run INSIDE the `setPopover` updater, and
   * `src/main.tsx` mounts the app in <StrictMode>, which invokes state
   * updaters TWICE in development to flush out exactly that -- so every
   * Continue sent its write twice. Seen as "2 PATCH to assignments" in
   * `loadSanity.spec.ts`'s own print line the first time R-365 put a prompt
   * in front of a real write; the run-resize confirm had the same shape from
   * the day it replaced `window.confirm`, and nothing counted its requests.
   * The updater now only clears; the side effect runs once, outside it, off
   * the rendered `popover` this callback closes over. */
  const confirmYes = useCallback(() => {
    if (popover === null || popover.kind !== "confirm") return;
    // R-031: a prompt with choices has no default answer.
    if (popover.choices !== undefined) return;
    const { onConfirm } = popover;
    setPopover(null);
    onConfirm();
  }, [popover]);
  const confirmNo = useCallback(() => setPopover(null), []);
  /** R-031: pick one of a multi-choice prompt's answers. Same shape as
   *  `confirmYes` (F-128): the updater only clears, the side effect runs
   *  once, outside it. */
  const confirmChoose = useCallback(
    (index: number) => {
      if (popover === null || popover.kind !== "confirm" || popover.choices === undefined) return;
      const choice = popover.choices[index];
      if (!choice) return;
      setPopover(null);
      choice.onChoose();
    },
    [popover],
  );

  const saveRunFields = useCallback(
    (runId: string, notes: string | null, plannedHeadcount: number | null) => {
      updateRunFields.mutate(
        { runId, edit: { notes, plannedHeadcount } },
        { onError: (err) => failWith(err, runLabelById(runId)) },
      );
      setPopover(null);
    },
    [updateRunFields, failWith, runLabelById],
  );

  const deleteRunWithMode = useCallback(
    (runId: string, mode: "cascade" | "detach") => {
      deleteRun.mutate({ runId, mode }, { onError: (err) => failWith(err, runLabelById(runId)) });
      setPopover(null);
    },
    [deleteRun, failWith, runLabelById],
  );

  const saveAssignmentFields = useCallback(
    (
      assignmentId: string,
      efficiencyPercent: number,
      targetQty: number | null,
      targetUnit: string | null,
    ) => {
      // R-322: no `status` here any more. The picker that set it is gone, and
      // `cancelled` never came through this path — Delete is what writes it.
      updateAssignmentFields.mutate(
        { assignmentId, edit: { efficiencyPercent, targetQty, targetUnit } },
        { onError: (err) => failWith(err, assignmentLabelById(assignmentId)) },
      );
      setPopover(null);
    },
    [updateAssignmentFields, failWith, assignmentLabelById],
  );

  /**
   * ⭐ R-343: CHANGE WHO IS ON THE ROW. The maintainer, session 76: *"once you
   * assign someone say Operator 1, there is no way to modify that assignment to
   * operator 2 unless you delete existing assignment, this is not practical."*
   *
   * Shaped like `saveAssignmentFields` above — the same revert label, the same
   * `failWith` (D37's one true path, T12) — with two differences the pop-up
   * depends on:
   *
   * ⭐ IT RETURNS A PROMISE AND RE-THROWS. `mutateAsync`, not `mutate`, because
   * the assignment pop-up has to know whether the write landed: it applies the
   * field edits only AFTER the person has actually changed, and it turns a
   * `not_eligible` answer into the override tick and reason box that
   * `CreatePopover` shows before it ever asks (D64/F-087). The pop-up has no
   * `requiredSkills` of its own to predict that answer from, so the server's
   * refusal IS the question — and its `policy` field is what says whether an
   * override may be offered at all, which is R-331's rule arriving by post
   * rather than by prop.
   *
   * ⭐ IT DOES NOT TOAST A `NotEligible`. Everything else goes through
   * `failWith` exactly as an edit does, because the pop-up closing or not, the
   * person deserves the sentence. But a `not_eligible` under `warn` is not a
   * failure, it is the screen asking for a reason — and the pop-up is still
   * open, holding the control that caused it. Toasting there is the dead-end
   * shape F-087 was filed for: a message about an override against a screen
   * with no box to supply one, except in reverse.
   *
   * ⭐ AND THE POP-UP STAYS OPEN ON A REFUSAL. `setPopover(null)` runs on
   * success only; a refused reassignment leaves the person picker up with the
   * choice still in it, which is the natural next step (the same reasoning
   * `confirmSplit` uses when the capacity probe turns out to have been stale).
   */
  const reassignAssignment = useCallback(
    async (input: ReassignAssignmentInput): Promise<void> => {
      try {
        await reassign.mutateAsync(input);
        setPopover(null);
      } catch (err) {
        // No toast here, on purpose. The pop-up is open and prints every
        // refusal itself (a capacity or area refusal as a sentence, not_eligible
        // as the override question), so a toast on top was the same refusal
        // twice, in the split feature's words -- measured on the live app,
        // session 76. reassignAssignment (mutations.ts) only ever throws a
        // SchedulerError, so there is no untyped failure to toast either.
        throw isSchedulerError(err) ? err : toSchedulerError(err);
      }
    },
    [reassign],
  );

  /**
   * S41-c: the create pop-up's move door -- shaped exactly like
   * `reassignAssignment` above (`mutateAsync`, re-thrown `SchedulerError`, no
   * toast: the pop-up prints every refusal itself through the SAME
   * training/area/leave boxes a create shows, resolved for the TARGET node).
   * Positional arguments, not an object: this is the literal shape
   * `CreatePopover`'s `onSubmitMove` prop calls, built here from `index.
   * windowStart` (which the pop-up does not have) rather than pushed onto
   * every caller.
   */
  const submitMove = useCallback(
    async (
      nodeId: string,
      range: Range,
      assignmentId: string,
      eligibilityOverride: boolean,
      overrideReason: string | undefined,
      areaOverride: boolean,
      areaOverrideReason: string | undefined,
    ): Promise<void> => {
      const input: MoveAssignmentInput = {
        assignmentId,
        nodeId,
        start: minuteDate(index.windowStart, range.startMin),
        end: minuteDate(index.windowStart, range.endMin),
        eligibilityOverride,
        overrideReason,
        areaOverride,
        areaOverrideReason,
      };
      try {
        await move.mutateAsync(input);
        setPopover(null);
      } catch (err) {
        // No toast, on the same reasoning as reassignAssignment above: the
        // pop-up is open and prints every refusal itself.
        throw isSchedulerError(err) ? err : toSchedulerError(err);
      }
    },
    [index, move],
  );

  /** ⭐ R-323: THIS DELETES THE ROW. The comment that stood here said there was
   *  "no delete_assignment RPC and no `useDeleteAssignment` hook", and that
   *  `status = "cancelled"` was "the one existing, D36-compliant path" — a gap
   *  flagged rather than worked around, and then lived with for months. The
   *  maintainer closed it by asking what the column was for: with the progress
   *  picker gone there was one bit left, and the same table already deleted
   *  outright whenever a RUN was deleted. So the soft delete is gone, the
   *  column with it, and this is a real delete under the `assignments_delete`
   *  policy that was there all along. */
  const removeAssignment = useCallback(
    (assignmentId: string) => {
      deleteAssignment.mutate(assignmentId, {
        onError: (err) => failWith(err, assignmentLabelById(assignmentId)),
      });
      setPopover(null);
    },
    [deleteAssignment, failWith, assignmentLabelById],
  );

  return {
    activeDrag: activeDrag as ActiveDrag | null,
    popover,
    closePopover,
    setDropRowResolver,
    beginBlockDrag,
    updateBlockDrag,
    endBlockDrag,
    cancelDrag,
    beginTrackCreateDrag,
    updateTrackCreateDrag,
    endTrackCreateDrag,
    beginPanelDrag,
    updatePanelDrag,
    endPanelDrag,
    handleBlockKeyDown,
    handleBlockKeyUp,
    handleTrackKeyDown,
    submitCreateRun,
    submitCreateDirect,
    openCreateFromCommand,
    retimeAssignmentFromCommand,
    openCreateRunFromCommand,
    retimeRunFromCommand,
    openMoveFromCommand,
    submitMove,
    saveRunFields,
    deleteRunWithMode,
    saveAssignmentFields,
    reassignAssignment,
    removeAssignment,
    updateSplitParticipant,
    splitEvenlyAction,
    confirmSplit,
    cancelSplit,
    confirmYes,
    confirmNo,
    confirmChoose,
  };
}

function minuteDate(windowStart: Date, minute: number): Date {
  return addMinutes(windowStart, minute);
}

/** The row's first shift instance intersecting the window, used for the
 *  create popover's default range when no drag distance was given (a
 *  keyboard-triggered create). Falls back to a flat 4-hour block starting
 *  at minute 0 when the row resolves no template — the mockup's panel-drop
 *  default duration (240 min) generalized to "no explicit range given". */
function defaultShiftRange(template: ShiftTemplate | null, windowMinutes: number): Range {
  if (template) {
    for (const sh of template.shifts) {
      if (sh.startMin >= 0 && sh.endMin <= windowMinutes) {
        return { startMin: sh.startMin, endMin: Math.min(windowMinutes, sh.endMin) };
      }
    }
  }
  return { startMin: 0, endMin: Math.min(windowMinutes, 240) };
}

/** Full-shift quick-action chips (§5.4), for the day the drag/keyboard
 *  create started on — fixed once, regardless of a later chip pick
 *  (mirrors the mockup's `openCreatePop`'s `dayOff`). */
function shiftChipsFor(
  template: ShiftTemplate | null,
  anchorMin: number,
  windowMinutes: number,
): ShiftChip[] {
  if (!template) return [];
  const dayOff = Math.floor(anchorMin / 1440) * 1440;
  return template.shifts.map((sh) => ({
    name: sh.name,
    startMin: Math.max(0, dayOff + sh.startMin),
    endMin: Math.min(windowMinutes, dayOff + sh.endMin),
  }));
}
