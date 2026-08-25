/**
 * Five typed RPC wrappers over migration `20260825000010_hierarchy_admin.sql`
 * (brief P1-5b §7.2): `saveHierarchyLevels`, `createNode`, `renameNode`,
 * `moveNode`, `deleteNode`.
 *
 * Same contract as every other file in this folder (board.ts, mutations.ts):
 * call `supabase.rpc`, throw `toSchedulerError(error)` on a PostgREST
 * error, run the payload through a hand-rolled runtime guard, throw a loud
 * `shapeMismatch` if that fails. camelCase in and out; snake_case is
 * confined to this file; RPC argument names match the migration's
 * signatures exactly (PostgREST binds by name, not position).
 *
 * AUTHOR-ONLY — not compiled or run in this container (brief §2.1: this
 * file imports React's `@/lib/supabase` client and `database.types.ts`,
 * neither of which `node --experimental-strip-types` can resolve here).
 * See the delivery report for what `tsc` would be expected to say.
 *
 * `HierarchyLevel` and `BoardNode` are reused from `./shapes` (both
 * already have exactly the shape these RPCs return/consume for a full
 * level/node) rather than duplicated. `shapes.ts` itself is NOT edited —
 * it is not in the brief's §3 file list — so the narrower per-RPC result
 * shapes (`rename_node`/`move_node`/`delete_node` each return a strict
 * subset of a full node's fields) get their own small local interfaces
 * and guards here, following shapes.ts's own style but not reaching into
 * its unexported helpers.
 */
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import { shapeMismatch, toSchedulerError } from "./errors";
import type { BoardNode, HierarchyLevel } from "./shapes";

// ---------------------------------------------------------------------------
// Local runtime guards (shapes.ts's equivalents are not exported — see file
// header). Deliberately minimal: just what this file's five payloads need.
// ---------------------------------------------------------------------------

type JsonRecord = { [key: string]: Json | undefined };

function isJsonObject(v: Json | undefined): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: Json | undefined): v is string {
  return typeof v === "string";
}

function isStrOrNull(v: Json | undefined): v is string | null {
  return v === null || typeof v === "string";
}

function isNum(v: Json | undefined): v is number {
  return typeof v === "number";
}

function isBool(v: Json | undefined): v is boolean {
  return typeof v === "boolean";
}

// ---------------------------------------------------------------------------
// saveHierarchyLevels — `save_hierarchy_levels(p_levels jsonb)`. Array index
// IS the position (D70); this wrapper never sends one. Raises:
// not_permitted, invalid_argument, level_in_use, schedulable_level_locked.
// ---------------------------------------------------------------------------

/** One entry of the whole-array payload `save_hierarchy_levels` expects. */
export interface HierarchyLevelDraftInput {
  /** `null` for a new level — the RPC inserts rather than updates. */
  id: string | null;
  name: string;
  isSchedulable: boolean;
}

function parseHierarchyLevel(v: Json): HierarchyLevel | null {
  if (!isJsonObject(v)) return null;
  const { id, template_id, position, name, is_schedulable } = v;
  if (!isStr(id) || !isStr(template_id) || !isNum(position) || !isStr(name) || !isBool(is_schedulable))
    return null;
  return { id, templateId: template_id, position, name, isSchedulable: is_schedulable };
}

function parseHierarchyLevelArray(json: Json): HierarchyLevel[] | null {
  if (!Array.isArray(json)) return null;
  const out: HierarchyLevel[] = [];
  for (const item of json) {
    const parsed = parseHierarchyLevel(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * `save_hierarchy_levels(p_levels jsonb, p_template_id uuid)`. The array's
 * order defines each level's final `position` (D70) — this function does not
 * accept or send one. Returns that TEMPLATE's full, saved level list.
 *
 * D86 / migration 0014: `templateId` is REQUIRED and has no default, on
 * purpose. The one-argument RPC was dropped rather than overloaded, and the
 * server refuses to guess which shape an admin meant — so neither does this.
 * Returns only the named template's levels, never the org's.
 */
export async function saveHierarchyLevels(
  levels: HierarchyLevelDraftInput[],
  templateId: string,
): Promise<HierarchyLevel[]> {
  const p_levels = levels.map((l) => ({
    id: l.id,
    name: l.name,
    is_schedulable: l.isSchedulable,
  })) as unknown as Json;

  const { data, error } = await supabase.rpc("save_hierarchy_levels", {
    p_levels,
    p_template_id: templateId,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseHierarchyLevelArray(data);
  if (parsed === null) {
    throw shapeMismatch(
      "save_hierarchy_levels",
      "expected a JSON array of {id,template_id,position,name,is_schedulable} (see shapes.ts HierarchyLevel)",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// createNode — `create_node(p_parent_id uuid, p_name text, p_sort_order int
// default 0)`. Raises: not_permitted, invalid_argument, level_mismatch (no
// level exists one position below the parent), path_collision.
// ---------------------------------------------------------------------------

export interface CreateNodeInput {
  /** `null` creates a root node (position-0 level). */
  parentId: string | null;
  name: string;
  /** Omit to use the RPC's own `DEFAULT 0`. */
  sortOrder?: number;
}

function parseBoardNode(v: Json): BoardNode | null {
  if (!isJsonObject(v)) return null;
  const { id, parent_id, level_id, name, path, sort_order, active } = v;
  if (
    !isStr(id) ||
    !isStrOrNull(parent_id) ||
    !isStr(level_id) ||
    !isStr(name) ||
    !isStr(path) ||
    !isNum(sort_order) ||
    !isBool(active)
  ) {
    return null;
  }
  return { id, parentId: parent_id, levelId: level_id, name, path, sortOrder: sort_order, active };
}

/**
 * `create_node(p_parent_id uuid, p_name text, p_sort_order int default 0)`.
 * Generated signature: `{ p_name: string; p_parent_id: string;
 * p_sort_order?: number } -> Json` -- see the nullability note below.
 */
/**
 * Postgres function parameters carry NO nullability, so `supabase gen types`
 * emits every required arg as non-null -- `p_parent_id: string`, never
 * `string | null`. But migration 0010 branches on `p_parent_id is null`
 * (create at the root) and `p_new_parent_id is null` (move to the root): both
 * are first-class supported paths, so the GENERATED TYPE IS TOO NARROW and
 * regenerating will never widen it. Cast at the single call site with this
 * comment, exactly as `mutations.ts` does for create_assignment's
 * `p_run_id`/`p_product_id` pair (P1-3b brief §2). Do not push the null
 * handling onto callers -- `parentId: string | null` is the honest input type.
 */
export async function createNode(input: CreateNodeInput): Promise<BoardNode> {
  const { data, error } = await supabase.rpc("create_node", {
    // null = create a root node (migration 0010 line 341). See the note above.
    p_parent_id: input.parentId as unknown as string,
    p_name: input.name,
    p_sort_order: input.sortOrder,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseBoardNode(data);
  if (parsed === null) {
    throw shapeMismatch("create_node", "expected a node object (see shapes.ts BoardNode)");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// renameNode — `rename_node(p_node_id uuid, p_name text)`. Raises:
// not_permitted, invalid_argument, path_collision. Descendant paths cascade
// server-side (migration 0001's `nodes_after_path` trigger) — this wrapper
// only reflects the renamed node's own row.
// ---------------------------------------------------------------------------

export interface RenameNodeResult {
  id: string;
  name: string;
  path: string;
}

function parseRenameNodeResult(v: Json): RenameNodeResult | null {
  if (!isJsonObject(v)) return null;
  const { id, name, path } = v;
  if (!isStr(id) || !isStr(name) || !isStr(path)) return null;
  return { id, name, path };
}

/** `rename_node(p_node_id uuid, p_name text)`. Generated signature:
 * `{ p_name: string; p_node_id: string } -> Json`. */
export async function renameNode(nodeId: string, name: string): Promise<RenameNodeResult> {
  const { data, error } = await supabase.rpc("rename_node", {
    p_node_id: nodeId,
    p_name: name,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseRenameNodeResult(data);
  if (parsed === null) {
    throw shapeMismatch("rename_node", "expected { id, name, path }");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// moveNode — `move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order
// int default null)`. Never changes level_id (D71). Raises: not_permitted,
// invalid_argument, node_cycle, level_mismatch, path_collision.
// ---------------------------------------------------------------------------

export interface MoveNodeInput {
  nodeId: string;
  /** `null` re-parents to root — legal only for a position-0 node. */
  newParentId: string | null;
  /** Omit to leave the node's existing `sort_order` unchanged (RPC coalesces). */
  sortOrder?: number;
}

export interface MoveNodeResult {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  sortOrder: number;
}

function parseMoveNodeResult(v: Json): MoveNodeResult | null {
  if (!isJsonObject(v)) return null;
  const { id, name, path, parent_id, sort_order } = v;
  if (!isStr(id) || !isStr(name) || !isStr(path) || !isStrOrNull(parent_id) || !isNum(sort_order)) {
    return null;
  }
  return { id, name, path, parentId: parent_id, sortOrder: sort_order };
}

/** `move_node(p_node_id uuid, p_new_parent_id uuid, p_sort_order int
 * default null)`. Generated signature: `{ p_new_parent_id: string;
 * p_node_id: string; p_sort_order?: number } -> Json` -- the same
 * generated-nullability gap as `createNode` above; the note there applies
 * verbatim and is the single explanation for both call sites. */
export async function moveNode(input: MoveNodeInput): Promise<MoveNodeResult> {
  const { data, error } = await supabase.rpc("move_node", {
    p_node_id: input.nodeId,
    // null = move to the root (migration 0010 line 485). See createNode's note.
    p_new_parent_id: input.newParentId as unknown as string,
    p_sort_order: input.sortOrder,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseMoveNodeResult(data);
  if (parsed === null) {
    throw shapeMismatch("move_node", "expected { id, name, path, parent_id, sort_order }");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// deleteNode — `delete_node(p_node_id uuid, p_mode text default
// 'deactivate')`. Raises: not_permitted, invalid_argument (unrecognised or
// NULL mode — D1's fix), node_in_use.
// ---------------------------------------------------------------------------

/** A union type, not `string` (brief §7.2, explicit). */
export type DeleteNodeMode = "deactivate" | "delete";

export type DeleteNodeResult =
  { mode: "deactivate"; deactivated: number } | { mode: "delete"; deleted: number };

function parseDeleteNodeResult(v: Json): DeleteNodeResult | null {
  if (!isJsonObject(v)) return null;
  const { mode, deactivated, deleted } = v;
  if (mode === "deactivate" && isNum(deactivated)) return { mode, deactivated };
  if (mode === "delete" && isNum(deleted)) return { mode, deleted };
  return null;
}

/**
 * `delete_node(p_node_id uuid, p_mode text default 'deactivate')`.
 * Generated signature: `{ p_mode?: string; p_node_id: string } -> Json`.
 * `mode` is left undefined (never defaulted client-side) so an omitted
 * call falls through to the RPC's own `DEFAULT 'deactivate'` — the single
 * source of truth for that default stays the database, same as
 * `deleteRun`'s existing `mode?: "cascade" | "detach"` in mutations.ts.
 */
export async function deleteNode(nodeId: string, mode?: DeleteNodeMode): Promise<DeleteNodeResult> {
  const { data, error } = await supabase.rpc("delete_node", {
    p_node_id: nodeId,
    p_mode: mode,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseDeleteNodeResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "delete_node",
      "expected { mode: 'deactivate', deactivated } or { mode: 'delete', deleted }",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The whole org's levels and nodes, for the hierarchy admin screens.
 *
 * `board_window` is the codebase's other hierarchy-shaped read and is the
 * wrong shape here: it is scoped to one root path and one time window, while
 * a tree EDITOR needs every node regardless of schedule activity.
 *
 * Lives here rather than in the admin feature because `src/lib/api/` is the
 * only place allowed to touch `supabase`, snake_case, or `database.types.ts`
 * (docs/conventions.md). P1-5d's file table authorised no file for this and
 * the build agent therefore, reasonably, put it in `AdminPage.tsx`; the
 * boundary is the rule, and the file table was the error.
 *
 * No manual `org_id` filter: RLS scopes both tables to the caller's org, and
 * as of migration 0012 that scoping is tenant-correct (design plan §19.15).
 * Adding a redundant filter here would be a second implementation of a rule
 * the database already owns.
 */
export async function fetchHierarchyTree(): Promise<{
  levels: HierarchyLevel[];
  nodes: BoardNode[];
}> {
  const [levelsRes, nodesRes] = await Promise.all([
    supabase
      .from("hierarchy_levels")
      .select("id, template_id, position, name, is_schedulable")
      .order("position"),
    supabase
      .from("nodes")
      .select("id, parent_id, level_id, name, path, sort_order, active")
      .order("sort_order"),
  ]);
  if (levelsRes.error) throw toSchedulerError(levelsRes.error);
  if (nodesRes.error) throw toSchedulerError(nodesRes.error);

  const levels: HierarchyLevel[] = (levelsRes.data ?? []).map((r) => ({
    id: r.id,
    templateId: r.template_id,
    position: r.position,
    name: r.name,
    isSchedulable: r.is_schedulable,
  }));
  const nodes: BoardNode[] = (nodesRes.data ?? []).map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    levelId: r.level_id,
    name: r.name,
    // `nodes.path` is a Postgres `ltree`, which has no JS mapping, so
    // `supabase gen types` emits it as `unknown` — the same class of gap as
    // the nullable-argument one above: the generated type cannot express
    // this and regenerating will never change it. It is a string over the
    // wire. Cast at the single boundary, with this comment.
    path: r.path as string,
    sortOrder: r.sort_order,
    active: r.active,
  }));
  return { levels, nodes };
}
