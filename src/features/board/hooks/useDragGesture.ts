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
import type { ShiftTemplate } from "@/lib/api";
import { describeSchedulerError, isSchedulerError, toSchedulerError } from "@/lib/api";
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
  type DragMode,
} from "../lib/interaction";
import { useCreateRun, useUpdateRunFields, useDeleteRun } from "./useRunMutations";
import { useCreateAssignment, useUpdateAssignmentFields } from "./useAssignmentMutations";
import { useSchedulerToast, type ToastResolveCtx } from "./useSchedulerToast";

export type { DragMode };

type Range = { startMin: number; endMin: number };

export type DragSubject =
  | { kind: "run"; run: IndexedRun }
  | { kind: "assignment"; assignment: IndexedAssignment; homeRun: IndexedRun | null }
  | { kind: "new" };

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
}

export interface ShiftChip {
  name: string;
  startMin: number;
  endMin: number;
}

export type PopoverState =
  | {
      kind: "create";
      nodeId: string;
      range: Range;
      anchor: { x: number; y: number };
      shiftChips: ShiftChip[];
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

/** The window each mode's candidate is clamped to: a run-attached
 *  assignment stays within its OWN run's bounds for both move and resize
 *  (ASSUMPTION — see the agent report: the mockup only clamps a chip's
 *  RESIZE to its home run's bounds, letting a MOVE slide anywhere in the
 *  window and re-parent on drop. P1-4c's scope fence disables re-parenting
 *  here, and leaving a mid-drag MOVE unclamped would let a chip visually
 *  leave its band with no cross-run drop to land it anywhere sensible, so
 *  both gestures are clamped identically here). A direct assignment and a
 *  run both use the whole loaded window. Module-level and pure (no closed-
 *  over component state) so the `useCallback`s that call it need not list
 *  it as a dependency. */
function boundsFor(d: InternalDragState): Range {
  if (d.subject.kind === "assignment" && d.homeRun) {
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
  const runById = new Map<
    string,
    { productId: string; nodeId: string; startMin: number; endMin: number }
  >();
  for (const runs of index.runsByNode.values()) {
    for (const r of runs) runById.set(r.id, r);
  }
  return {
    operatorById: index.operatorById,
    nodeById: index.nodeById,
    productById: index.productById,
    runById,
    formatRange: (s, e) =>
      `${formatClock(addMinutes(index.windowStart, s))}–${formatClock(addMinutes(index.windowStart, e))}`,
  };
}

export function useDragGesture(args: UseDragGestureArgs) {
  const { rootPath, from, to, index } = args;

  const createRun = useCreateRun(rootPath, from, to);
  const updateRunFields = useUpdateRunFields(rootPath, from, to);
  const deleteRun = useDeleteRun(rootPath, from, to);
  const createAssignment = useCreateAssignment(rootPath, from, to);
  const updateAssignmentFields = useUpdateAssignmentFields(rootPath, from, to);
  const toast = useSchedulerToast();

  const [activeDrag, setActiveDrag] = useState<InternalDragState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  // Mirrors `activeDrag` for handlers that must read the latest value
  // without depending on it (keeps the pointer handlers' identity stable
  // across renders, per §13 item 4 — one add, one matching cleanup).
  const dragRef = useRef<InternalDragState | null>(null);
  dragRef.current = activeDrag;

  const ctx = toastCtx(index);

  // --- T13: identity change cancels any in-flight drag, no mutation. -----
  const lastUserIdRef = useRef(args.sessionUserId);
  useEffect(() => {
    if (lastUserIdRef.current !== args.sessionUserId) {
      lastUserIdRef.current = args.sessionUserId;
      if (dragRef.current) setActiveDrag(null);
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
      if (!d || d.subject.kind === "new") return;
      const movedPx = Math.hypot(e.clientX - d.originClientX, e.clientY - d.originClientY);
      const moved = d.moved || movedPx >= DRAG_THRESHOLD_PX;
      const candidate = computeBlockCandidate(d, e.clientX, e.altKey);
      setActiveDrag({ ...d, candidate, moved, altKey: e.altKey });
    },
    [computeBlockCandidate],
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

  const commitBlockDrag = useCallback(
    (d: InternalDragState) => {
      const candidate = d.candidate!;
      if (d.subject.kind === "run") {
        const run = d.subject.run;
        // T10: check against the CURRENT index, not the drag-start snapshot
        // (`d.runsOnNode`/`d.crew`) — a background refetch may have landed
        // mid-drag, and the mutation must be judged against what the
        // server actually has now, not what it had at pointerdown.
        const currentRunsOnNode = index.runsByNode.get(d.nodeId) ?? [];
        const currentCrew = index.assignmentsByRun.get(run.id) ?? [];
        // Brief §5.3: moving a STAFFED run is refused in P1-4b (crew moves
        // are a later brief's multi-row-transaction problem); resizing a
        // staffed run is allowed and only warns (classifyCrewAgainstRun).
        if (d.mode === "move" && currentCrew.length > 0) {
          toast.info(
            "Moving a staffed run is coming in the next build — detach or move the crew first.",
          );
          return;
        }
        const overlap = findRunOverlap(candidate, currentRunsOnNode, run.id);
        if (overlap) {
          const p = index.productById.get(overlap.productId);
          toast.reverted(
            `${index.nodeById.get(d.nodeId)?.name ?? d.nodeId} already runs ${p?.name ?? "another product"} ${ctx.formatRange?.(overlap.startMin, overlap.endMin) ?? ""}`,
          );
          return;
        }
        if (d.mode !== "move" && currentCrew.length > 0) {
          const { clipped, stranded } = classifyCrewAgainstRun(candidate, currentCrew);
          const affected = clipped.length + stranded.length;
          if (affected > 0) {
            const ok = window.confirm(
              `${affected} crew assignment${affected === 1 ? "" : "s"} fall outside the new run window. Continue?`,
            );
            if (!ok) return;
          }
        }
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
          {
            onError: (err) => failWith(err, revertLabel(d.subject)),
          },
        );
      } else if (d.subject.kind === "assignment") {
        const a = d.subject.assignment;
        updateAssignmentFields.mutate(
          {
            assignmentId: a.id,
            edit: {
              timerange: {
                start: minuteDate(index.windowStart, candidate.startMin),
                end: minuteDate(index.windowStart, candidate.endMin),
              },
            },
          },
          {
            onError: (err) => failWith(err, revertLabel(d.subject)),
          },
        );
      }
    },
    [index, ctx, toast, updateRunFields, updateAssignmentFields, failWith, revertLabel],
  );

  const endBlockDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      // T11: clear activeDrag BEFORE calling .mutate() — the optimistic
      // patch must never be read back in as a new drag origin.
      setActiveDrag(null);
      if (!d.moved) {
        openEditPopoverFor(d, e.clientX, e.clientY);
        return;
      }
      commitBlockDrag(d);
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
      commitBlockDrag(d);
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
  // Popover commit/cancel actions, used by the popover components.
  // --------------------------------------------------------------------

  const closePopover = useCallback(() => setPopover(null), []);

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

  const submitCreateDirect = useCallback(
    (
      nodeId: string,
      range: Range,
      operatorId: string,
      productId: string,
      efficiencyPercent: number,
      targetQty: number | undefined,
      targetUnit: string | undefined,
    ) => {
      createAssignment.mutate(
        {
          nodeId,
          operatorId,
          target: { kind: "direct", productId },
          start: minuteDate(index.windowStart, range.startMin),
          end: minuteDate(index.windowStart, range.endMin),
          efficiencyPercent,
          targetQty,
          targetUnit,
        },
        {
          onError: (err) => {
            const se = isSchedulerError(err) ? err : toSchedulerError(err);
            // §7: CapacityExceeded on create is not auto-retried, and the
            // brief explicitly wants this path exercised for real (§7).
            toast.schedulerError(se, ctx);
          },
        },
      );
      setPopover(null);
    },
    [index, ctx, toast, createAssignment],
  );

  const saveRunFields = useCallback(
    (runId: string, notes: string | null, plannedHeadcount: number | null) => {
      updateRunFields.mutate(
        { runId, edit: { notes, plannedHeadcount } },
        {
          onError: (err) =>
            toast.schedulerError(isSchedulerError(err) ? err : toSchedulerError(err), ctx),
        },
      );
      setPopover(null);
    },
    [updateRunFields, toast, ctx],
  );

  const deleteRunWithMode = useCallback(
    (runId: string, mode: "cascade" | "detach") => {
      deleteRun.mutate(
        { runId, mode },
        {
          onError: (err) =>
            toast.schedulerError(isSchedulerError(err) ? err : toSchedulerError(err), ctx),
        },
      );
      setPopover(null);
    },
    [deleteRun, toast, ctx],
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
        {
          onError: (err) =>
            toast.schedulerError(isSchedulerError(err) ? err : toSchedulerError(err), ctx),
        },
      );
      setPopover(null);
    },
    [updateAssignmentFields, toast, ctx],
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
        {
          onError: (err) =>
            toast.schedulerError(isSchedulerError(err) ? err : toSchedulerError(err), ctx),
        },
      );
      setPopover(null);
    },
    [updateAssignmentFields, toast, ctx],
  );

  return {
    activeDrag: activeDrag as ActiveDrag | null,
    popover,
    closePopover,
    beginBlockDrag,
    updateBlockDrag,
    endBlockDrag,
    cancelDrag,
    beginTrackCreateDrag,
    updateTrackCreateDrag,
    endTrackCreateDrag,
    handleBlockKeyDown,
    handleBlockKeyUp,
    handleTrackKeyDown,
    submitCreateRun,
    submitCreateDirect,
    saveRunFields,
    deleteRunWithMode,
    saveAssignmentFields,
    removeAssignment,
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
