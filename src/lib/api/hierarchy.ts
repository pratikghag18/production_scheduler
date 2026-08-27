/**
 * Five typed RPC wrappers over migration `20260825000010_hierarchy_admin.sql`
 * (brief P1-5b §7.2): `saveHierarchyLevels`, `createNode`, `renameNode`,
 * `moveNode`, `deleteNode`. Plus three more over the template RPCs added by
 * migration `20260825000014_hierarchy_templates.sql` (brief P1-5f §7.1):
 * `createHierarchyTemplate`, `renameHierarchyTemplate`,
 * `deleteHierarchyTemplate`. `createNode` itself gained an optional
 * `templateId` (migration `20260825000015_create_node_template.sql`, D87) —
 * see that function's own doc comment below.
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
// Hierarchy TEMPLATE CRUD (D87 / brief P1-5f §7.1) — three thin wrappers
// over migration 20260825000014_hierarchy_templates.sql's
// create_/rename_/delete_hierarchy_template. Same shape as every other RPC
// in this file: `supabase.rpc`, `toSchedulerError` on a PostgREST error, a
// hand-rolled runtime guard, `shapeMismatch` if the guard fails, camelCase
// out. Raises for all three: not_permitted, invalid_argument (blank/
// duplicate name for create/rename; not found for rename/delete);
// `delete_hierarchy_template` additionally raises `level_in_use` (§9 of
// migration 0014) when the shape still has nodes on it.
// ---------------------------------------------------------------------------

export interface HierarchyTemplateSummary {
  id: string;
  name: string;
}

function parseHierarchyTemplateSummary(v: Json): HierarchyTemplateSummary | null {
  if (!isJsonObject(v)) return null;
  const { id, name } = v;
  if (!isStr(id) || !isStr(name)) return null;
  return { id, name };
}

/**
 * `create_hierarchy_template(p_name text)`. Always returns an EMPTY
 * template (migration 0014's own comment: seeding a starter level would
 * decide the site's shape on the admin's behalf) — `levels` is therefore
 * typed as the literal `[]`, not `HierarchyLevel[]`, so a caller cannot
 * accidentally read levels off a payload that never carries any.
 */
export async function createHierarchyTemplate(
  name: string,
): Promise<{ id: string; name: string; levels: [] }> {
  const { data, error } = await supabase.rpc("create_hierarchy_template", {
    p_name: name,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseHierarchyTemplateSummary(data);
  const levelsOk =
    isJsonObject(data) && Array.isArray(data.levels) && data.levels.length === 0;
  if (parsed === null || !levelsOk) {
    throw shapeMismatch(
      "create_hierarchy_template",
      "expected { id, name, levels: [] }",
    );
  }
  return { id: parsed.id, name: parsed.name, levels: [] };
}

/** `rename_hierarchy_template(p_template_id uuid, p_name text)`. */
export async function renameHierarchyTemplate(
  templateId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase.rpc("rename_hierarchy_template", {
    p_template_id: templateId,
    p_name: name,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseHierarchyTemplateSummary(data);
  if (parsed === null) {
    throw shapeMismatch("rename_hierarchy_template", "expected { id, name }");
  }
  return parsed;
}

function parseDeleteTemplateResult(v: Json): { id: string; deleted: boolean } | null {
  if (!isJsonObject(v)) return null;
  const { id, deleted } = v;
  if (!isStr(id) || !isBool(deleted)) return null;
  return { id, deleted };
}

/** `delete_hierarchy_template(p_template_id uuid)`. */
export async function deleteHierarchyTemplate(
  templateId: string,
): Promise<{ id: string; deleted: boolean }> {
  const { data, error } = await supabase.rpc("delete_hierarchy_template", {
    p_template_id: templateId,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseDeleteTemplateResult(data);
  if (parsed === null) {
    throw shapeMismatch("delete_hierarchy_template", "expected { id, deleted }");
  }
  return parsed;
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
  /**
   * D87 (migration 20260825000015): which hierarchy template a ROOT node
   * belongs to. Required when `parentId` is `null` and the org holds more
   * than one template (server-refused `invalid_argument` otherwise);
   * ignored for a child, whose shape is fixed by its parent — and must not
   * CONTRADICT the parent's own template, which the RPC also refuses.
   * OMIT entirely (never pass `undefined` explicitly) when the caller did
   * not choose one, exactly as `deleteNode` already does for `p_mode`, so
   * the RPC's own `DEFAULT null` / one-template-in-the-org inference stays
   * the single source of that default.
   */
  templateId?: string | null;
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
    // D87: same cast as p_parent_id above, and the same omit-when-absent
    // rule as p_mode in deleteNode below — an omitted `templateId` sends no
    // key at all (JSON.stringify drops an `undefined` property), so the
    // RPC's own DEFAULT/inference is what runs, not a client-side guess.
    p_template_id: input.templateId as unknown as string,
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
// placeNode — `place_node(p_node_id uuid, p_new_parent_id uuid, p_index int)`
// (D94, migration 0017, re-issued by 0020 §8). ONE RPC, not two: it calls
// `move_node` first — so it raises everything `move_node` raises, with the same
// codes and no new ones — and then densely renumbers the DESTINATION parent's
// children 0..n-1. It carries no permission check of its own, deliberately
// (0020 §8, gotcha 17): `move_node` runs first and checks both ends of the move.
//
// Returns the destination parent's children AFTER the renumber, in the new
// order — a JSON ARRAY, which is the one payload shape in this file that is not
// an object, so it gets its own guard rather than reusing `isJsonObject`.
//
// Raises: not_permitted, invalid_argument, node_cycle, level_mismatch,
// path_collision. No new error codes (brief P1-5l §2.6).
// ---------------------------------------------------------------------------

export interface PlaceNodeInput {
  nodeId: string;
  /** `null` places among the ROOTS — legal only for a position-0 node, and
   * only for a company admin. Reordering plants is a real operation. */
  newParentId: string | null;
  /**
   * Counted among the destination parent's children WITH THE DRAGGED NODE
   * REMOVED, which is exactly the list `place_node` splices into. The RPC
   * clamps to `[0, n]` and treats NULL as 0, so an out-of-range index is not an
   * error — "before everything" and "after everything" are unambiguous.
   */
  index: number;
}

/** One sibling as `place_node` reports it back. Same five fields
 * `move_node` returns, because they are the same row. */
export interface PlacedSibling {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  sortOrder: number;
}

function parsePlaceNodeResult(v: Json): PlacedSibling[] | null {
  if (!Array.isArray(v)) return null;
  const out: PlacedSibling[] = [];
  for (const entry of v) {
    if (!isJsonObject(entry)) return null;
    const { id, name, path, parent_id, sort_order } = entry;
    if (!isStr(id) || !isStr(name) || !isStr(path) || !isStrOrNull(parent_id) || !isNum(sort_order)) {
      return null;
    }
    out.push({ id, name, path, parentId: parent_id, sortOrder: sort_order });
  }
  return out;
}

/** Generated signature: `{ p_index: number; p_new_parent_id: string;
 * p_node_id: string } -> Json`. `p_new_parent_id` is nullable in SQL and the
 * generator does not say so — the same generated-nullability gap `createNode`
 * and `moveNode` document above; the note there is the single explanation for
 * all three call sites. */
export async function placeNode(input: PlaceNodeInput): Promise<PlacedSibling[]> {
  const { data, error } = await supabase.rpc("place_node", {
    p_node_id: input.nodeId,
    p_new_parent_id: input.newParentId as unknown as string,
    p_index: input.index,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parsePlaceNodeResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "place_node",
      "expected [{ id, name, path, parent_id, sort_order }, ...]",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// promoteNode / demoteNode — `promote_node(p_node_id uuid)` and
// `demote_node(p_node_id uuid, p_new_parent_id uuid)` (P1-5k, migration 0017,
// re-issued by 0020 §8; error contract fixed by 0024).
//
// TWO FUNCTIONS, NOT ONE WITH A NULLABLE ARGUMENT, and the asymmetry is the
// design (§19.33 §5): promote DERIVES its destination (the grandparent, or the
// top level) while demote is GIVEN one. One shared signature with
// `newParentId?: string | null` would invite demoting with no target, and would
// hit the generated-nullability gap `createNode` documents above at a third
// call site. Both signatures here are non-nullable, so neither needs the cast.
//
// Both return THE MOVED SUBTREE, every row of it, because every row's level
// changed -- a caller that refetches only the moved node would redraw a tree
// whose children still claim their old rung.
//
// Raises: not_permitted, invalid_argument, node_cycle, level_mismatch,
// path_collision (0024), schedulable_level_locked (0024's payload). No new
// error codes.
// ---------------------------------------------------------------------------

/** One row of the moved subtree, as `app_relevel_subtree` reports it back.
 * `levelId` is the field that makes this different from `PlacedSibling`: a
 * re-level is the one node write that changes it. */
export interface ReleveledNode {
  id: string;
  name: string;
  levelId: string;
  parentId: string | null;
  path: string;
}

function parseReleveledNodes(v: Json): ReleveledNode[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReleveledNode[] = [];
  for (const entry of v) {
    if (!isJsonObject(entry)) return null;
    const { id, name, level_id, parent_id, path } = entry;
    if (!isStr(id) || !isStr(name) || !isStr(level_id) || !isStrOrNull(parent_id) || !isStr(path)) {
      return null;
    }
    out.push({ id, name, levelId: level_id, parentId: parent_id, path });
  }
  return out;
}

/** Generated signature: `{ p_node_id: string } -> Json`. */
export async function promoteNode(nodeId: string): Promise<ReleveledNode[]> {
  const { data, error } = await supabase.rpc("promote_node", { p_node_id: nodeId });
  if (error) throw toSchedulerError(error);
  const parsed = parseReleveledNodes(data);
  if (parsed === null) {
    throw shapeMismatch("promote_node", "expected [{ id, name, level_id, parent_id, path }, ...]");
  }
  return parsed;
}

export interface DemoteNodeInput {
  nodeId: string;
  /** NOT nullable, unlike every other destination in this file: a demote has
   * to land under something at the node's own level, and there is no such
   * thing at the top. */
  newParentId: string;
}

/** Generated signature: `{ p_new_parent_id: string; p_node_id: string } -> Json`. */
export async function demoteNode(input: DemoteNodeInput): Promise<ReleveledNode[]> {
  const { data, error } = await supabase.rpc("demote_node", {
    p_node_id: input.nodeId,
    p_new_parent_id: input.newParentId,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseReleveledNodes(data);
  if (parsed === null) {
    throw shapeMismatch("demote_node", "expected [{ id, name, level_id, parent_id, path }, ...]");
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
 * The whole org's templates, levels and nodes, for the hierarchy admin
 * screens.
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
 * No manual `org_id` filter: RLS scopes all three tables to the caller's
 * org, and as of migration 0012 that scoping is tenant-correct (design plan
 * §19.15). Adding a redundant filter here would be a second implementation
 * of a rule the database already owns.
 *
 * D87 (brief P1-5f §7.1): the `hierarchy_templates` read is NEW and is NOT
 * OPTIONAL — it cannot be replaced by deriving the shape list from the
 * distinct `template_id`s already present in `levels`. A freshly-created,
 * still-empty template (`create_hierarchy_template` returns one on purpose,
 * migration 0014's own comment) has no rows in `levels` at all, so a
 * derived list would make it vanish from the picker the instant it is
 * created — see `shapePicker.ts`'s own `buildShapeSummaries` doc comment
 * for the full reasoning; this read is what makes that function's
 * `templates`/`levels` split possible in the first place.
 */
export async function fetchHierarchyTree(): Promise<{
  templates: HierarchyTemplateSummary[];
  levels: HierarchyLevel[];
  nodes: BoardNode[];
  /**
   * Which structures this person may EDIT (0021 §2), or `null` when the
   * server did not answer. `null` is a real value here, not an error state —
   * see `filterEditableShapes`, which fails OPEN on it.
   */
  editableShapeIds: string[] | null;
  /**
   * Which SITE each structure belongs to — `hierarchy_templates.site_node_id`,
   * added by migration 0020 §1 — keyed by template id, `null` for a structure
   * no site has claimed.
   *
   * ⚠️ A SEPARATE MAP RATHER THAN A FIELD ON `HierarchyTemplateSummary`, and
   * the reason is that the summary type is SHARED with
   * `create_hierarchy_template` and `rename_hierarchy_template`, whose
   * payloads carry no `site_node_id` at all. Adding a required field there
   * would make two parsers reject every response they have ever received;
   * adding an optional one would make "absent" and "unowned" the same value.
   * The map keeps both honest and leaves `buildShapeSummaries` untouched.
   */
  siteNodeIds: Record<string, string | null>;
}> {
  const [templatesRes, levelsRes, nodesRes, editableRes] = await Promise.all([
    supabase.from("hierarchy_templates").select("id, name, site_node_id").order("name"),
    supabase
      .from("hierarchy_levels")
      .select("id, template_id, position, name, is_schedulable")
      .order("position"),
    supabase
      .from("nodes")
      .select("id, parent_id, level_id, name, path, sort_order, active")
      .order("sort_order"),
    // ⭐ IN THE SAME `Promise.all`, DELIBERATELY, AND NOT A SECOND `useQuery`.
    // §19.47 settled this one level up: a second unresolved window is a second
    // thing to fold into the loading state, and D91 is the standing reminder
    // that `enabled: false` leaves `isLoading` FALSE. One read, one spinner.
    supabase.rpc("editable_shape_ids"),
  ]);
  if (templatesRes.error) throw toSchedulerError(templatesRes.error);
  if (levelsRes.error) throw toSchedulerError(levelsRes.error);
  if (nodesRes.error) throw toSchedulerError(nodesRes.error);

  const templates: HierarchyTemplateSummary[] = (templatesRes.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
  }));
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
  // ⚠️ THIS ONE DOES NOT THROW, and the asymmetry with the three reads above
  // is the point. The three are the screen's content; without them there is
  // nothing to render and an error is the honest answer. This is a PREVIEW —
  // it decides which structures to offer, and the server refuses the rest on
  // its own either way — so an error here degrades the picker rather than the
  // page. `filterEditableShapes` fails open on `null` and says why.
  const editableShapeIds: string[] | null =
    editableRes.error || !Array.isArray(editableRes.data)
      ? null
      : (editableRes.data as unknown[]).filter(
          (v): v is string => typeof v === "string",
        );

  const siteNodeIds: Record<string, string | null> = {};
  for (const r of templatesRes.data ?? []) {
    siteNodeIds[r.id] = r.site_node_id ?? null;
  }

  return { templates, levels, nodes, editableShapeIds, siteNodeIds };
}
