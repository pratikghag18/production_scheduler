/**
 * React Query mutations over the five hierarchy-admin RPC wrappers
 * (brief P1-5b §7.3, `src/lib/api/hierarchy.ts`), plus three more over the
 * hierarchy-TEMPLATE RPC wrappers (D87 / brief P1-5f §7.2).
 *
 * AUTHOR-ONLY — not compiled or run in this container (imports React
 * Query and, transitively through `@/lib/api`, the Supabase client and
 * `database.types.ts`). See the delivery report for what `tsc` would be
 * expected to say.
 *
 * Deliberately NO optimistic updates (brief §7.3, explicit): a node move
 * changes the paths of an entire subtree server-side, and reproducing that
 * cascade client-side would be exactly the duplicated logic §5 forbids —
 * `src/features/admin/lib/hierarchy.ts` computes a legal-drop-target
 * *preview*, never a subtree-path rewrite. Every hook below just calls its
 * wrapper and invalidates on success; the server's next read is the source
 * of truth for the new tree shape.
 *
 * Query key: `hierarchyKeys`, exported here so the admin tree's own read
 * hook (P1-5c, not built by this brief) can key its `useQuery` under the
 * same root and be found by these invalidations — see the ASSUMPTION note
 * below and the delivery report's deviations section.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createHierarchyTemplate,
  createNode,
  deleteHierarchyTemplate,
  deleteNode,
  moveNode,
  renameHierarchyTemplate,
  renameNode,
  saveHierarchyLevels,
  type BoardNode,
  type CreateNodeInput,
  type DeleteNodeMode,
  type DeleteNodeResult,
  type HierarchyLevel,
  type HierarchyLevelDraftInput,
  type HierarchyTemplateSummary,
  type MoveNodeInput,
  type MoveNodeResult,
  type RenameNodeResult,
  type SchedulerError,
} from "@/lib/api";

/**
 * ASSUMPTION (brief silent on the exact key — §7.3 only says "invalidate
 * whatever query key the admin tree will read"): no hierarchy-tree read
 * query exists yet, since fetching the org's levels/nodes for the admin
 * screens is P1-5c's job, not this brief's (§12: "no admin screens"). This
 * root key is the convention this brief establishes for that future hook
 * to key its `useQuery` under (e.g. `[...hierarchyKeys.all, "tree"]`) —
 * every mutation here invalidates the whole `hierarchyKeys.all` prefix
 * (React Query v5's default partial-match invalidation), so any query
 * keyed under it is covered without this file needing to know its exact
 * shape.
 */
export const hierarchyKeys = {
  all: ["hierarchy"] as const,
};

function invalidateHierarchy(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
}

/**
 * Hierarchy TEMPLATE CRUD (D87 / brief P1-5f §7.2) -- three hooks, same
 * shape as the five below: no optimistic update, invalidate the
 * `hierarchyKeys.all` prefix on success.
 */

/** `create_hierarchy_template`. Raises: not_permitted, invalid_argument. */
export function useCreateHierarchyTemplate() {
  const queryClient = useQueryClient();

  return useMutation<{ id: string; name: string; levels: [] }, SchedulerError, string>({
    mutationFn: (name) => createHierarchyTemplate(name),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/** `rename_hierarchy_template`. Raises: not_permitted, invalid_argument. */
export function useRenameHierarchyTemplate() {
  const queryClient = useQueryClient();

  return useMutation<
    HierarchyTemplateSummary,
    SchedulerError,
    { templateId: string; name: string }
  >({
    mutationFn: ({ templateId, name }) => renameHierarchyTemplate(templateId, name),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `delete_hierarchy_template`. Raises: not_permitted, invalid_argument
 * (not found), level_in_use (the shape still has nodes on it).
 */
export function useDeleteHierarchyTemplate() {
  const queryClient = useQueryClient();

  return useMutation<{ id: string; deleted: boolean }, SchedulerError, string>({
    mutationFn: (templateId) => deleteHierarchyTemplate(templateId),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `save_hierarchy_levels`. Raises: not_permitted, invalid_argument,
 * level_in_use, schedulable_level_locked.
 */
/**
 * D86: the variables are now a PAIR. `save_hierarchy_levels` edits one
 * hierarchy template's level list, and an org may hold several shapes, so the
 * caller must say which — there is no "the org's levels" any more.
 */
export interface SaveHierarchyLevelsVars {
  levels: HierarchyLevelDraftInput[];
  templateId: string;
}

export function useSaveHierarchyLevels() {
  const queryClient = useQueryClient();

  return useMutation<HierarchyLevel[], SchedulerError, SaveHierarchyLevelsVars>({
    mutationFn: ({ levels, templateId }) => saveHierarchyLevels(levels, templateId),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `create_node`. Raises: not_permitted, invalid_argument, level_mismatch,
 * path_collision.
 */
export function useCreateNode() {
  const queryClient = useQueryClient();

  return useMutation<BoardNode, SchedulerError, CreateNodeInput>({
    mutationFn: (input) => createNode(input),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `rename_node`. Raises: not_permitted, invalid_argument, path_collision.
 */
export function useRenameNode() {
  const queryClient = useQueryClient();

  return useMutation<RenameNodeResult, SchedulerError, { nodeId: string; name: string }>({
    mutationFn: ({ nodeId, name }) => renameNode(nodeId, name),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `move_node`. Raises: not_permitted, invalid_argument, node_cycle,
 * level_mismatch, path_collision. No optimistic update — see file header.
 */
export function useMoveNode() {
  const queryClient = useQueryClient();

  return useMutation<MoveNodeResult, SchedulerError, MoveNodeInput>({
    mutationFn: (input) => moveNode(input),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}

/**
 * `delete_node`. Raises: not_permitted, invalid_argument (unrecognised or
 * NULL mode), node_in_use.
 */
export function useDeleteNode() {
  const queryClient = useQueryClient();

  return useMutation<DeleteNodeResult, SchedulerError, { nodeId: string; mode?: DeleteNodeMode }>({
    mutationFn: ({ nodeId, mode }) => deleteNode(nodeId, mode),
    onSuccess: () => {
      void invalidateHierarchy(queryClient);
    },
  });
}
