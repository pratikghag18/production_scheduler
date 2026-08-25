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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ShiftTemplate,
  BoardOperator,
  CreateAssignmentInput,
  AssignmentFieldEdit,
  CapacityProbe,
} from "@/lib/api";
import {
  describeSchedulerError,
  isSchedulerError,
  toSchedulerError,
  probeCapacity,
  fromEfficiency,
} from "@/lib/api";
import type { BoardIndex, IndexedRun, IndexedAssignment } from "../lib/boardIndex";
import { ZOOMS, pxToMinutes, shiftSnapPoints, type ZoomIndex } from "../lib/geometry";
import { formatClock, addMinutes } from "../lib/time";
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
  splitEvenly,
  splitFits,
  type DragMode,
} from "../lib/interaction";
import { useCreateRun, useUpdateRunFields, useDeleteRun, useMoveRun } from "./useRunMutations";
import {
  useCreateAssignment,
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
      nodeId: string;
      range: Range;
      anchor: { x: number; y: number };
      shiftChips: ShiftChip[];
      /** D65: set only when this popover was opened by a panel drop — the
       *  dropped operator, pre-selected, in forced "direct" mode. */
      presetOperatorId?: string;
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
    };

interface SnapConfig {
  useShiftSnap: boolean;
  snapMinutes: number;
  shiftPoints: number[];
}

function snapConfigFor(
  zoomIndex: ZoomIndex,
  template: ShiftTemplate | null,
  dayCount: number,
): SnapConfig {
  const zoom = ZOOMS[zoomIndex];
  const useShiftSnap = zoom.name === "Compact";
  const shiftPoints = template ? shiftSnapPoints(template, dayCount) : [];
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
}

export interface BlockDragDescriptor {
  nodeId: string;
  subject: DragSubject;
  original: Range;
  pxPerHour: number;
  windowMinutes: number;
  template: ShiftTemplate | null;
  dayCount: number;
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
  zoomIndex: ZoomIndex;
  trackLeftPx: number;
  offsetXPx: number;
}

function toastCtx(index: BoardIndex): ToastResolveCtx {
  // P1-4e: `index.runById` (§9 debt 1) now carries exactly this shape —
  // the ad-hoc rebuild this function used to do is no longer needed.
  return {
    operatorById: index.operatorById,
    nodeById: index.nodeById,
    productById: index.productById,
    runById: index.runById,
    formatRange: (s, e) =>
      `${formatClock(addMinutes(index.windowStart, s))}–${formatClock(addMinutes(index.windowStart, e))}`,
  };
}

export function useDragGesture(args: UseDragGestureArgs) {
  const { rootPath, from, to, index, zoomIndex } = args;

  const createRun = useCreateRun(rootPath, from, to);
  const updateRunFields = useUpdateRunFields(rootPath, from, to);
  const deleteRun = useDeleteRun(rootPath, from, to);
  const moveRun = useMoveRun(rootPath, from, to); // D57 — first caller (brief §1 item 3)
  const createAssignment = useCreateAssignment(rootPath, from, to);
  const updateAssignmentFields = useUpdateAssignmentFields(rootPath, from, to);
  const applySplitCoverage = useApplySplitCoverage(rootPath, from, to); // D61/D62 — first caller
  const toast = useSchedulerToast();

  const [activeDrag, setActiveDrag] = useState<InternalDragState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Mirrors `activeDrag` for handlers that must read the latest value
  // without depending on it (keeps the pointer handlers' identity stable
  // across renders, per §13 item 4 — one add, one matching cleanup).
  const dragRef = useRef<InternalDragState | null>(null);
  dragRef.current = activeDrag;

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

  const ctx = toastCtx(index);

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

  const revertLabel = useCallback(
    (subject: DragSubject): string => {
      if (subject.kind === "run") {
        const p = index.productById.get(subject.run.productId);
        return `${p?.name ?? "Run"} ${ctx.formatRange?.(subject.run.startMin, subject.run.endMin) ?? ""}`;
      }
      if (subject.kind === "assignment") {
        const op = index.operatorById.get(subject.assignment.operatorId);
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
      snap: snapConfigFor(d.zoomIndex, d.template, d.dayCount),
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

  const commitBlockDrag = useCallback(
    (d: InternalDragState, anchor: { x: number; y: number }) => {
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
            const p = index.productById.get(overlap.productId);
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

        // Resize: unchanged from P1-4b except the confirm step (§9 debt 2).
        const overlap = findRunOverlap(candidate, currentRunsOnNode, run.id);
        if (overlap) {
          const p = index.productById.get(overlap.productId);
          toast.reverted(
            `${index.nodeById.get(d.nodeId)?.name ?? d.nodeId} already runs ${p?.name ?? "another product"} ${ctx.formatRange?.(overlap.startMin, overlap.endMin) ?? ""}`,
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
            { onError: (err) => failWith(err, revertLabel(d.subject)) },
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
      } else if (d.subject.kind === "assignment") {
        const a = d.subject.assignment;
        const nodeId = d.nodeId; // D66 is same-row only — a chip never crosses cells.
        const homeRun = d.homeRun;

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
        updateAssignmentFields.mutate(
          { assignmentId: a.id, edit },
          { onError: (err) => failWith(err, revertLabel(d.subject)) },
        );
      }
    },
    [
      index,
      ctx,
      toast,
      moveRun,
      updateRunFields,
      updateAssignmentFields,
      failWith,
      revertLabel,
      askConfirm,
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
      setPopover(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const snap = snapConfigFor(d.zoomIndex, d.template, d.dayCount);
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
      e.preventDefault();
      const snap = snapConfigFor(
        ctxDescriptor.zoomIndex,
        ctxDescriptor.template,
        ctxDescriptor.dayCount,
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
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const defaultRange = defaultShiftRange(d.template, d.windowMinutes);
      const chips = shiftChipsFor(d.template, defaultRange.startMin, d.windowMinutes);
      setPopover({
        kind: "create",
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
      const snap = snapConfigFor(zoomIndex, template, index.dayCount);
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
      const p = index.productById.get(run.productId);
      return `${p?.name ?? "Run"} ${ctx.formatRange?.(run.startMin, run.endMin) ?? ""}`;
    },
    [index, ctx],
  );
  const assignmentLabelById = useCallback(
    (assignmentId: string): string => {
      const a = index.assignmentById.get(assignmentId);
      if (!a) return "Assignment";
      const op = index.operatorById.get(a.operatorId);
      return `${op?.displayName ?? "Assignment"} ${ctx.formatRange?.(a.startMin, a.endMin) ?? ""}`;
    },
    [index, ctx],
  );

  const submitCreateRun = useCallback(
    (nodeId: string, range: Range, productId: string, plannedHeadcount: number | undefined) => {
      const overlap = findRunOverlap(range, index.runsByNode.get(nodeId) ?? [], null);
      if (overlap) {
        const p = index.productById.get(overlap.productId);
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
      productId: string,
      efficiencyPercent: number,
      targetQty: number | undefined,
      targetUnit: string | undefined,
      eligibilityOverride: boolean,
      overrideReason: string | undefined,
      anchor: { x: number; y: number },
    ) => {
      const start = minuteDate(index.windowStart, range.startMin);
      const end = minuteDate(index.windowStart, range.endMin);
      const input: CreateAssignmentInput = {
        nodeId,
        operatorId,
        target: { kind: "direct", productId },
        start,
        end,
        efficiencyPercent,
        targetQty,
        targetUnit,
        eligibilityOverride,
        overrideReason,
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

  const confirmYes = useCallback(() => {
    setPopover((p) => {
      if (!p || p.kind !== "confirm") return p;
      p.onConfirm();
      return null;
    });
  }, []);
  const confirmNo = useCallback(() => setPopover(null), []);

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
      status: string,
    ) => {
      updateAssignmentFields.mutate(
        { assignmentId, edit: { efficiencyPercent, targetQty, targetUnit, status } },
        { onError: (err) => failWith(err, assignmentLabelById(assignmentId)) },
      );
      setPopover(null);
    },
    [updateAssignmentFields, failWith, assignmentLabelById],
  );

  /** §5.4/§5.3: there is no delete_assignment RPC and no `useDeleteAssignment`
   *  hook anywhere in P1-3b (see the agent report — flagged as a gap, not
   *  silently worked around). `status = "cancelled"` is the one existing,
   *  D36-compliant path: `useUpdateAssignmentFields` already accepts
   *  `status`, and `boardIndex.ts`'s rule 17 already drops every row whose
   *  `status === "cancelled"` from every map. */
  const removeAssignment = useCallback(
    (assignmentId: string) => {
      updateAssignmentFields.mutate(
        { assignmentId, edit: { status: "cancelled" } },
        { onError: (err) => failWith(err, assignmentLabelById(assignmentId)) },
      );
      setPopover(null);
    },
    [updateAssignmentFields, failWith, assignmentLabelById],
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
    saveRunFields,
    deleteRunWithMode,
    saveAssignmentFields,
    removeAssignment,
    updateSplitParticipant,
    splitEvenlyAction,
    confirmSplit,
    cancelSplit,
    confirmYes,
    confirmNo,
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
