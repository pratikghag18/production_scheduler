import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createRun,
  deleteRun,
  isSchedulerError,
  moveRun,
  toSchedulerError,
  toTstzRange,
  updateRunFields,
  type BoardWindow,
  type CreateRunInput,
  type DeleteRunResult,
  type MoveRunInput,
  type Run,
  type RunFieldEdit,
} from "@/lib/api";
import { boardKeys } from "./useBoardWindow";

type BoardKey = ReturnType<typeof boardKeys.window>;

/**
 * The shared four-step optimistic pattern (brief §6): 1) onMutate cancels
 * in-flight fetches for the board key and snapshots the cached
 * `BoardWindow`; 2) onError restores that snapshot and lets the original
 * (typed) error keep propagating — nothing here catches or replaces it,
 * so `mutate`/`mutateAsync` callers still see the real `SchedulerError`;
 * 3) onSettled invalidates the key so the server's actual state wins;
 * 4) no mutation below swallows an error. Duplicated per-hook (rather than
 * factored into a shared, unlisted helper file) because brief §3's
 * deliverables list names exactly `useBoardWindow.ts`, `useRunMutations.ts`
 * and `useAssignmentMutations.ts` for this folder.
 */
function snapshotBoard(queryClient: QueryClient, key: BoardKey): BoardWindow | undefined {
  return queryClient.getQueryData<BoardWindow>(key);
}

export function useCreateRun(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: (input: CreateRunInput) => createRun(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        // Best-effort optimistic row: a temp id stands in for the
        // server-generated one until onSettled's invalidate replaces it.
        const optimisticRun: Run = {
          id: `optimistic-${crypto.randomUUID()}`,
          orgId: previous.org.id,
          nodeId: input.nodeId,
          productId: input.productId,
          // D110: a new run names its product by id; the remembered fields are
          // written only when that product is deleted.
          productSku: null,
          productName: null,
          productColorToken: null,
          timerange: toTstzRange(input.start, input.end),
          plannedHeadcount: input.plannedHeadcount ?? null,
          notes: input.notes ?? null,
          status: "planned",
          createdBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        queryClient.setQueryData<BoardWindow>(key, {
          ...previous,
          runs: [...previous.runs, optimisticRun],
        });
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useMoveRun(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    // docs/api.md §1: a bare 23P01 on `runs` means "you lost the race" —
    // refetch and retry once, not in a loop. The second attempt's failure
    // (RaceLost again, or anything else) propagates from this catch block
    // with no further retry.
    mutationFn: async (input: MoveRunInput) => {
      try {
        return await moveRun(input);
      } catch (err) {
        const schedulerErr = isSchedulerError(err) ? err : toSchedulerError(err);
        if (schedulerErr.kind !== "RaceLost") throw schedulerErr;
        await queryClient.invalidateQueries({ queryKey: key });
        return await moveRun(input);
      }
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        const newTimerange = toTstzRange(input.start, input.end);
        queryClient.setQueryData<BoardWindow>(key, {
          ...previous,
          runs: previous.runs.map((r) =>
            r.id === input.runId ? { ...r, nodeId: input.nodeId, timerange: newTimerange } : r,
          ),
          assignments: previous.assignments.map((a) =>
            a.runId === input.runId ? { ...a, nodeId: input.nodeId } : a,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useDeleteRun(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: ({
      runId,
      mode,
    }: {
      runId: string;
      mode?: "cascade" | "detach";
    }): Promise<DeleteRunResult> => deleteRun(runId, mode),
    onMutate: async ({ runId, mode }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        if (mode === "detach") {
          // Detached assignments become direct (run_id -> null); the run's
          // product id isn't known client-side without a lookup, so this
          // leaves productId untouched here and lets onSettled's
          // invalidate fetch the authoritative post-detach row.
          queryClient.setQueryData<BoardWindow>(key, {
            ...previous,
            runs: previous.runs.filter((r) => r.id !== runId),
            assignments: previous.assignments.map((a) =>
              a.runId === runId ? { ...a, runId: null } : a,
            ),
          });
        } else {
          queryClient.setQueryData<BoardWindow>(key, {
            ...previous,
            runs: previous.runs.filter((r) => r.id !== runId),
            assignments: previous.assignments.filter((a) => a.runId !== runId),
          });
        }
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useUpdateRunFields(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: ({ runId, edit }: { runId: string; edit: RunFieldEdit }) =>
      updateRunFields(runId, edit),
    onMutate: async ({ runId, edit }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        queryClient.setQueryData<BoardWindow>(key, {
          ...previous,
          runs: previous.runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  ...("notes" in edit ? { notes: edit.notes ?? null } : {}),
                  ...("plannedHeadcount" in edit
                    ? { plannedHeadcount: edit.plannedHeadcount ?? null }
                    : {}),
                  ...(edit.timerange
                    ? { timerange: toTstzRange(edit.timerange.start, edit.timerange.end) }
                    : {}),
                }
              : r,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
