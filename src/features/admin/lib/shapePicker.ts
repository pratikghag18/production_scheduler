/**
 * Pure hierarchy-SHAPE-picker logic (brief P1-5f §6).
 *
 * Dependency-free: `import type` only, no runtime import of any kind — no
 * React, no CSS, no `supabase`, no snake_case. Runs under
 * `node --experimental-strip-types` with nothing to resolve, because
 * `import type` is erased entirely at strip time and never loaded.
 *
 * WHAT IS AUTHORITATIVE, AND WHY THIS DUPLICATES ANYTHING AT ALL (§6.1): the
 * DATABASE is the authority for every rule this module touches --
 * `create_node` + `nodes_check_level_adjacency` decide which shape a node
 * belongs to, `delete_hierarchy_template` decides whether a shape can be
 * deleted (`level_in_use`), `create_/rename_hierarchy_template` decide
 * whether a name is legal (`invalid_argument`). This module computes
 * PREVIEWS ONLY -- what to show, what to pre-select, which button to grey
 * out -- so a disabled button reads better than a round trip to a server
 * error. The invariant is one-way: anything the client rejects, the server
 * must also reject; never the converse. Every server failure still surfaces
 * through `describeSchedulerError` (`src/lib/api/errors.ts`), not through
 * anything in this file.
 *
 * WHITESPACE PARITY, SETTLED -- do not re-derive it. `app_trim_ws`
 * (migration 20260825000011_trim_whitespace.sql) is a code-point-exact
 * reimplementation of JavaScript's `String.prototype.trim()` (ECMA-262
 * WhiteSpace + LineTerminator, including U+FEFF, excluding U+200B, named by
 * code point so it is collation-independent). The mirror here is therefore
 * plain `.trim()` on an already-confirmed `string` -- no character class,
 * no `\s` regex; both have been tried in this project and both were wrong.
 */
import type { BoardNode, HierarchyLevel } from "@/lib/api";

export interface HierarchyTemplateRef {
  id: string;
  name: string;
}

export interface ShapeSummary {
  id: string;
  name: string;
  levelCount: number;
  /** level names in ascending position order; [] for a template with no levels */
  levelNames: readonly string[];
  /** null when the shape has no levels yet, or none is marked schedulable */
  schedulableLevelName: string | null;
  /** true when any node sits on one of this shape's levels — a PREVIEW of level_in_use */
  hasNodes: boolean;
}

/**
 * Driven by `templates`, NOT by `levels` (§6.3 -- the single most likely
 * bug in this module). Deriving the shape list from the distinct
 * `templateId`s present in `levels` is the cheap path and it makes a
 * newly-created shape vanish the instant it is created --
 * `create_hierarchy_template` returns an EMPTY template on purpose (0014's
 * own comment: seeding a starter level would decide the site's shape on the
 * admin's behalf). A shape with zero levels must still appear, with
 * `levelCount: 0`, or the create flow looks broken and the admin has no way
 * to give it levels.
 */
export function buildShapeSummaries(
  templates: readonly HierarchyTemplateRef[],
  levels: readonly HierarchyLevel[],
  nodes: readonly BoardNode[],
): ShapeSummary[] {
  const summaries: ShapeSummary[] = templates.map((t) => {
    const mine = levels
      .filter((l) => l.templateId === t.id)
      .slice()
      .sort((a, b) => a.position - b.position);
    const levelNames = mine.map((l) => l.name);
    const schedulable = mine.find((l) => l.isSchedulable);
    const mineLevelIds = new Set(mine.map((l) => l.id));
    const hasNodes = nodes.some((n) => mineLevelIds.has(n.levelId));

    return {
      id: t.id,
      name: t.name,
      levelCount: mine.length,
      levelNames,
      schedulableLevelName: schedulable ? schedulable.name : null,
      hasNodes,
    };
  });

  // Deterministic, locale-independent ordering: plain code-unit comparison
  // on `name` (never `localeCompare` -- this project has already been
  // burned once by a collation-dependent comparison producing different
  // answers on two machines, migration 0011's header records it),
  // tie-broken by `id` so two shapes that happen to share a name still sort
  // the same way on every run.
  return summaries.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/**
 * The shape picker's filter (0021 §2). `editableIds` is what
 * `editable_shape_ids()` answered: the structures this person may actually
 * edit — every structure in the company for a company admin, their own
 * site's for a site admin.
 *
 * ⭐ IT FAILS **OPEN**, AND THAT IS THE OPPOSITE OF `fetchAdminAnywhere`,
 * WHICH FAILS CLOSED. The difference is what the answer buys. `adminAccess`
 * decides whether a screen OPENS, so an unanswered question there has to mean
 * "no". This decides only what a list OFFERS, and the server refuses every
 * edit on its own regardless (0020's W6/W7) — so an unanswered question here
 * degrades to exactly the behaviour that shipped before this function
 * existed: every structure listed, and a `not_permitted` on the ones that
 * are not yours. Failing closed would instead hide a site admin's OWN
 * structure from them the moment one RPC hiccups, which is a broken screen
 * bought for no safety at all.
 *
 * `null`, `undefined`, and anything that is not an array all mean "no answer"
 * — the value crosses a network boundary and `Array.isArray` is the only
 * honest test of what came back. NEVER THROWS.
 *
 * The invariant in this file's header still holds and is worth restating
 * because this function is the first one that could break it: anything the
 * client hides, the server must also refuse. It does — the same predicate,
 * `app_is_admin_for_template`, decides both.
 */
export function filterEditableShapes(
  summaries: readonly ShapeSummary[],
  editableIds: readonly string[] | null | undefined,
): ShapeSummary[] {
  if (!Array.isArray(editableIds)) return summaries.slice();
  const allowed = new Set<string>(editableIds);
  return summaries.filter((s) => allowed.has(s.id));
}

/**
 * Falls back, never sticks (§6.3). The case that matters is deleting the
 * shape currently being viewed: the selection must move to a surviving
 * shape, not point at nothing.
 */
export function resolveSelectedShape(
  summaries: readonly ShapeSummary[],
  selectedId: string | null,
): string | null {
  if (selectedId !== null && summaries.some((s) => s.id === selectedId)) {
    return selectedId;
  }
  return summaries.length > 0 ? summaries[0].id : null;
}

/** `null` -> `[]`. Otherwise the named template's levels, ascending by position. */
export function levelsForShape(
  levels: readonly HierarchyLevel[],
  templateId: string | null,
): HierarchyLevel[] {
  if (templateId === null) return [];
  return levels
    .filter((l) => l.templateId === templateId)
    .slice()
    .sort((a, b) => a.position - b.position);
}

export type ShapeNameProblem = "blank_name" | "duplicate_name";

/**
 * Trims per the file header, rejects `blank_name` for empty-after-trim AND
 * for any non-string input (`null`, `undefined`, a number, a missing key --
 * a missing object key arrives here as `undefined`) -- NEVER THROWS. P1-5b
 * shipped `validateLevelDraft` throwing on exactly those four inputs where
 * the server returns a typed reason; found by a probe, not by that brief's
 * own acceptance table. `duplicate_name` compares TRIMMED names,
 * CASE-SENSITIVELY (the server's uniqueness is a plain `=` on the trimmed
 * name, migration 20260825000014_hierarchy_templates.sql), excluding
 * `currentId` so renaming a shape to its own name is allowed.
 */
export function validateShapeName(
  name: unknown,
  summaries: readonly ShapeSummary[],
  currentId: string | null,
): { ok: true } | { ok: false; reason: ShapeNameProblem } {
  if (typeof name !== "string") {
    return { ok: false, reason: "blank_name" };
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    return { ok: false, reason: "blank_name" };
  }
  const isDuplicate = summaries.some(
    (s) => s.id !== currentId && s.name.trim() === trimmed,
  );
  if (isDuplicate) {
    return { ok: false, reason: "duplicate_name" };
  }
  return { ok: true };
}
