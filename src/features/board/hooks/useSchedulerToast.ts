/**
 * D37 — "One `useSchedulerToast` hook; every failure path calls it with
 * the typed `SchedulerError`. `describeSchedulerError` supplies the
 * sentence." (brief P1-4b §3/§7).
 *
 * A module-level zustand store (same pattern as `store/boardView.ts`) so
 * any component — `useDragGesture`, a popover's own onError handler, a
 * keyboard-commit path — can push a toast without needing a shared React
 * context provider wired through the whole board tree. `Toasts.tsx` is the
 * only component that reads `toasts`; every other call site only ever
 * calls the setters this file exports.
 *
 * ASSUMPTION (flagged in the agent report): the brief's §7 message table
 * needs operator/node/product **names**, but `SchedulerError` (brief
 * P1-3b) only ever carries ids — "the error layer has no access to the
 * operators list to resolve one" (docs/api-client.md). The brief does not
 * specify how a hook is supposed to reach the board's loaded operator/node
 * list, so `schedulerError` below takes that context as a same-call
 * argument (`ToastResolveCtx`) rather than baking it into the hook's
 * identity — every call site that has `BoardIndex` in scope (which is
 * every call site in this feature) passes its maps straight through.
 */
import { create } from "zustand";
import type { SchedulerError } from "@/lib/api";
import { describeSchedulerError } from "@/lib/api";

export type ToastKind = "" | "warn" | "crit";

export interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastStoreState {
  toasts: ToastEntry[];
  push: (message: string, kind: ToastKind) => void;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
/** Mockup's `#toasts` auto-dismiss: `setTimeout(() => t.remove(), 4200)`. */
const TOAST_DURATION_MS = 4200;

export const useToastStore = create<ToastStoreState>((set) => ({
  toasts: [],
  push: (message, kind) => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, TOAST_DURATION_MS);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** The maps a caller passes in to resolve an id to a display name — every
 *  field optional so a caller that only has a partial `BoardIndex` slice
 *  (e.g. a popover that never loaded operators) still degrades to the raw
 *  id rather than crashing. */
export interface ToastResolveCtx {
  operatorById?: Map<string, { displayName: string }>;
  nodeById?: Map<string, { name: string }>;
  productById?: Map<string, { name: string }>;
  /** Only needed for the RunOverlap fallback path — see the comment at
   *  its call below. Keyed by run id, not node id (unlike
   *  `BoardIndex.runsByNode`). */
  // D110: `productId` is nullable once the product has been deleted. This is a
  // STRUCTURAL type over `IndexedRun`, so it has to follow or the whole index
  // stops being assignable to it.
  runById?: Map<
    string,
    { productId: string | null; nodeId: string; startMin: number; endMin: number }
  >;
  /** Needed only to format a RunOverlap/CapacityExceeded timerange as a
   *  clock range; omit to fall back to the raw ISO text. */
  formatRange?: (startMin: number, endMin: number) => string;
}

function resolveOperatorName(ctx: ToastResolveCtx, operatorId: string): string {
  return ctx.operatorById?.get(operatorId)?.displayName ?? operatorId;
}

function resolveNodeName(ctx: ToastResolveCtx, nodeId: string): string {
  return ctx.nodeById?.get(nodeId)?.name ?? nodeId;
}

/**
 * §7's message-shape table, pure (exported for testing). `kind` picks the
 * toast's CSS treatment — the mockup's `""`/`"warn"`/`"crit"` classes.
 */
export function buildSchedulerErrorToast(
  err: SchedulerError,
  ctx: ToastResolveCtx = {},
): { message: string; kind: ToastKind } {
  switch (err.kind) {
    case "CapacityExceeded": {
      // P1-4e D61: the split popover now opens PROACTIVELY from a
      // `capacity_probe` before the write is even sent, so this path is
      // the race-only fallback — the probe said "fits" and the write
      // still failed. "Split coverage is coming in the next build" was
      // true in P1-4b/P1-4c/P1-4d; it is this build, so that sentence is
      // deleted rather than reworded (D57's own instruction for the
      // analogous run-move refusal message applies here too).
      const name = resolveOperatorName(ctx, err.operatorId);
      const peakPct = Math.round(err.peak * 100);
      const capPct = Math.round(err.cap * 100);
      return {
        message: `${name} would reach ${peakPct}% (cap ${capPct}%) — reverted. Someone else changed their load — try the split again.`,
        kind: "crit",
      };
    }
    case "NotEligible": {
      const name = resolveOperatorName(ctx, err.operatorId);
      const cell = resolveNodeName(ctx, err.nodeId);
      const missing = err.missingSkills.map((s) => s.name);
      const missingText = missing.length > 0 ? missing.join(", ") : "a required skill";
      return {
        message: `${name} is not certified for ${cell}: missing ${missingText} — reverted.`,
        kind: "warn",
      };
    }
    case "RunOverlap": {
      const cell = resolveNodeName(ctx, err.nodeId);
      // The typed error only carries `conflictingRunId` (an id), never the
      // conflicting run's product/time — the brief's §7 message shape
      // wants both (mirroring the mockup's `runOverlap` toast, which reads
      // straight off the in-memory conflicting run object). This path
      // fires only on the RARE server-side rejection that slips past the
      // client-side `findRunOverlap` pre-check (§4's own comment: "the UI
      // must refuse the drop before sending it" — this is the backstop for
      // a race, not the common case), so `runById` is best-effort: when the
      // caller has it (built once from `index.runsByNode`'s values), the
      // message names the conflicting run; otherwise it falls back to a
      // still-accurate but less specific sentence.
      const conflict = ctx.runById?.get(err.conflictingRunId);
      if (conflict) {
        // D110: the conflicting run may be drawing a product that no longer
        // exists, in which case its id is null and the name lives on the run.
        // `productSku` is not in this structural type — the toast context
        // deliberately knows the four fields it needs and no more — so the
        // fallback sentence is the honest answer here rather than a lookup
        // that would always miss.
        const product =
          conflict.productId === null
            ? "another product"
            : (ctx.productById?.get(conflict.productId)?.name ?? "another product");
        const range = ctx.formatRange?.(conflict.startMin, conflict.endMin) ?? err.timerange;
        return { message: `${cell} already runs ${product} ${range} — reverted.`, kind: "crit" };
      }
      return { message: `${cell} already has an overlapping run — reverted.`, kind: "crit" };
    }
    case "RaceLost":
      return { message: "Someone else changed this — refreshed, try again.", kind: "warn" };
    case "NotPermitted": {
      const cell = resolveNodeName(ctx, err.nodeId);
      return { message: `You don't have permission to edit ${cell}.`, kind: "crit" };
    }
    case "InvalidArgument":
    case "RunNodeMismatch":
    case "Unauthenticated":
    case "Unknown":
    default:
      return { message: describeSchedulerError(err), kind: "crit" };
  }
}

export function useSchedulerToast() {
  const push = useToastStore((s) => s.push);
  return {
    /** A plain informational toast — the mockup's no-class `toast(msg)`. */
    info: (message: string) => push(message, ""),
    /** T12: a rollback must still name the block even if its popover has
     *  since closed — call this instead of `schedulerError` when the
     *  caller wants to control the exact "<Block> ... — reverted" wording
     *  itself (e.g. §7's RunOverlap-caught-client-side path, which already
     *  has the full conflicting run in hand and doesn't need `runById`). */
    reverted: (message: string) => push(`${message} — reverted.`, "crit"),
    /** D37's one true path: a rejected edit's typed error -> a sentence,
     *  built by `buildSchedulerErrorToast` above. */
    schedulerError: (err: SchedulerError, ctx?: ToastResolveCtx) => {
      const { message, kind } = buildSchedulerErrorToast(err, ctx);
      push(message, kind);
    },
  };
}

export function useToasts(): ToastEntry[] {
  return useToastStore((s) => s.toasts);
}

export function useDismissToast(): (id: number) => void {
  return useToastStore((s) => s.dismiss);
}
