import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  applySplitCoverage,
  createAssignment,
  toEfficiency,
  toTstzRange,
  updateAssignmentFields,
  type Assignment,
  type AssignmentFieldEdit,
  type BoardWindow,
  type CreateAssignmentInput,
  type SplitCoverageInput,
} from "@/lib/api";
import { boardKeys } from "./useBoardWindow";

type BoardKey = ReturnType<typeof boardKeys.window>;

// Same four-step optimistic pattern as useRunMutations.ts — see the
// comment there for why it's duplicated per-hook rather than shared.
function snapshotBoard(queryClient: QueryClient, key: BoardKey): BoardWindow | undefined {
  return queryClient.getQueryData<BoardWindow>(key);
}

/**
 * Deliberately no retry logic here (brief §6): a `CapacityExceeded` is not
 * auto-retried. `onError` rolls the optimistic row back and lets the
 * original typed error — carrying `peak`/`cap`/`operatorId` — propagate
 * untouched, which is exactly the payload P1-4's split-coverage popover
 * needs; opening that popover is P1-4's job, not this hook's.
 */
export function useCreateAssignment(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: (input: CreateAssignmentInput) => createAssignment(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        const optimistic: Assignment = {
          id: `optimistic-${crypto.randomUUID()}`,
          orgId: previous.org.id,
          nodeId: input.nodeId,
          operatorId: input.operatorId,
          runId: input.target.kind === "run" ? input.target.runId : null,
          productId: input.target.kind === "direct" ? input.target.productId : null,
          timerange: toTstzRange(input.start, input.end),
          efficiency:
            input.efficiencyPercent === undefined ? 1 : toEfficiency(input.efficiencyPercent),
          eligibilityOverride: input.eligibilityOverride ?? false,
          overrideReason: input.overrideReason ?? null,
          targetQty: input.targetQty ?? null,
          targetUnit: input.targetUnit ?? null,
          status: "planned",
          createdBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        queryClient.setQueryData<BoardWindow>(key, {
          ...previous,
          assignments: [...previous.assignments, optimistic],
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

export function useApplySplitCoverage(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: (input: SplitCoverageInput) => applySplitCoverage(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        const adjustmentsById = new Map(
          input.adjustments.map((a) => [a.assignmentId, toEfficiency(a.efficiencyPercent)]),
        );
        let assignments = previous.assignments.map((a) =>
          adjustmentsById.has(a.id) ? { ...a, efficiency: adjustmentsById.get(a.id)! } : a,
        );
        if (input.newAssignment) {
          const na = input.newAssignment;
          const optimistic: Assignment = {
            id: `optimistic-${crypto.randomUUID()}`,
            orgId: previous.org.id,
            nodeId: na.nodeId,
            operatorId: na.operatorId,
            runId: na.target.kind === "run" ? na.target.runId : null,
            productId: na.target.kind === "direct" ? na.target.productId : null,
            timerange: toTstzRange(na.start, na.end),
            efficiency: na.efficiencyPercent === undefined ? 1 : toEfficiency(na.efficiencyPercent),
            eligibilityOverride: na.eligibilityOverride ?? false,
            overrideReason: na.overrideReason ?? null,
            targetQty: na.targetQty ?? null,
            targetUnit: na.targetUnit ?? null,
            status: "planned",
            createdBy: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          assignments = [...assignments, optimistic];
        }
        queryClient.setQueryData<BoardWindow>(key, { ...previous, assignments });
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

export function useUpdateAssignmentFields(rootPath: string, from: Date, to: Date) {
  const queryClient = useQueryClient();
  const key = boardKeys.window(rootPath, from, to);

  return useMutation({
    mutationFn: ({ assignmentId, edit }: { assignmentId: string; edit: AssignmentFieldEdit }) =>
      updateAssignmentFields(assignmentId, edit),
    onMutate: async ({ assignmentId, edit }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = snapshotBoard(queryClient, key);
      if (previous) {
        queryClient.setQueryData<BoardWindow>(key, {
          ...previous,
          assignments: previous.assignments.map((a) =>
            a.id === assignmentId
              ? {
                  ...a,
                  ...(edit.efficiencyPercent !== undefined
                    ? { efficiency: toEfficiency(edit.efficiencyPercent) }
                    : {}),
                  ...("targetQty" in edit ? { targetQty: edit.targetQty ?? null } : {}),
                  ...("targetUnit" in edit ? { targetUnit: edit.targetUnit ?? null } : {}),
                  ...(edit.status !== undefined ? { status: edit.status } : {}),
                  ...(edit.timerange
                    ? { timerange: toTstzRange(edit.timerange.start, edit.timerange.end) }
                    : {}),
                }
              : a,
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
