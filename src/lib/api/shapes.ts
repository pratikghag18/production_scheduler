/**
 * Result interfaces and runtime narrowing guards (brief P1-3b §5).
 *
 * Every RPC in database.types.ts returns `Json` — Postgres jsonb has no
 * TypeScript structure, so the generated type is opaque (brief §2). These
 * `parseX` functions are the runtime guards that narrow a raw `Json`
 * payload into the typed interfaces below, or return `null` if it doesn't
 * match what docs/api.md documents that RPC as returning. board.ts and
 * mutations.ts throw a loud `shapeMismatch` SchedulerError (errors.ts) on
 * `null` rather than silently coercing.
 *
 * Snake_case -> camelCase conversion happens here, at this boundary
 * (brief §5) — nothing past this file should ever read a `node_id`.
 *
 * Shapes are read from supabase/migrations/20260821000009_api_surface.sql
 * (the actual `jsonb_build_object(...)` calls), cross-checked against
 * docs/api.md's worked examples — not guessed from the prose alone.
 */
import type { Json } from "@/lib/database.types";

type JsonRecord = { [key: string]: Json | undefined };

function isJsonObject(v: Json | undefined): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArr(v: Json | undefined): v is Json[] {
  return Array.isArray(v);
}

function isStr(v: Json | undefined): v is string {
  return typeof v === "string";
}

function isNum(v: Json | undefined): v is number {
  return typeof v === "number";
}

function isBool(v: Json | undefined): v is boolean {
  return typeof v === "boolean";
}

function isStrOrNull(v: Json | undefined): v is string | null {
  return v === null || typeof v === "string";
}

function isNumOrNull(v: Json | undefined): v is number | null {
  return v === null || typeof v === "number";
}

function parseArrayOf<T>(v: Json | undefined, parseItem: (item: Json) => T | null): T[] | null {
  if (!isArr(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parseItem(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entities (board_window's building blocks — §2 of migration 0009).
// ---------------------------------------------------------------------------

export interface Org {
  id: string;
  name: string;
  settings: Json;
}

function parseOrg(v: Json | undefined): Org | null {
  if (!isJsonObject(v)) return null;
  const { id, name, settings } = v;
  if (!isStr(id) || !isStr(name) || settings === undefined) return null;
  return { id, name, settings };
}

export interface HierarchyLevel {
  id: string;
  /** D86: which hierarchy shape this level belongs to (migration 0014). */
  templateId: string;
  position: number;
  name: string;
  isSchedulable: boolean;
}

function parseLevel(v: Json): HierarchyLevel | null {
  if (!isJsonObject(v)) return null;
  const { id, template_id, position, name, is_schedulable } = v;
  if (
    !isStr(id) ||
    !isStr(template_id) ||
    !isNum(position) ||
    !isStr(name) ||
    !isBool(is_schedulable)
  )
    return null;
  return { id, templateId: template_id, position, name, isSchedulable: is_schedulable };
}

/** Named `BoardNode` (not `Node`) to avoid colliding with the DOM `Node` type. */
export interface BoardNode {
  id: string;
  parentId: string | null;
  levelId: string;
  name: string;
  path: string;
  sortOrder: number;
  active: boolean;
}

function parseNode(v: Json): BoardNode | null {
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

/** `runs` row shape, as returned by `to_jsonb(r)` (raw table row). */
/**
 * ⚠️ `productId` AND `operatorId` BELOW BECAME NULLABLE IN MIGRATION 0029 AND
 * THIS FILE DID NOT FOLLOW, WHICH WOULD HAVE BROKEN THE WHOLE BOARD.
 *
 * D110 keeps a started run after its product is deleted, releasing `product_id`
 * to NULL and copying the sku, name and colour onto the run itself. The guard
 * here still demanded a string, so such a row parsed as `null` — and
 * `parseArrayOf` returns null for the WHOLE ARRAY on the first item that fails,
 * so `parseBoardWindow` would return null and `fetchBoardWindow` would throw
 * `shapeMismatch`. **One deleted product with history and the board stops
 * loading at all, for everyone, with an error about a shape rather than about
 * a product.** Found by reading the parser while adding a different field.
 *
 * The lesson for next time: a migration that makes a column NULLABLE is a
 * client change too, and `tsc` cannot see it — the generated types describe the
 * database, but a hand-written runtime guard is where the assumption actually
 * lives.
 */
export interface Run {
  id: string;
  orgId: string;
  nodeId: string;
  /** NULL once the product has been deleted; `productSku` then names it. */
  productId: string | null;
  /** D110 snapshot, set at the moment the product was deleted. */
  productSku: string | null;
  productName: string | null;
  productColorToken: string | null;
  timerange: string;
  plannedHeadcount: number | null;
  notes: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Exported (unlike the other entity parsers) because mutations.ts's plain
 * PostgREST table updates on `runs` return a bare row, not a `{ run: ... }`
 * wrapper — there's no top-level RPC result shape for that case to hang
 * this off of. */
export function parseRun(v: Json): Run | null {
  if (!isJsonObject(v)) return null;
  const {
    id,
    org_id,
    node_id,
    product_id,
    product_sku,
    product_name,
    product_color_token,
    timerange,
    planned_headcount,
    notes,
    status,
    created_by,
    created_at,
    updated_at,
  } = v;
  if (
    !isStr(id) ||
    !isStr(org_id) ||
    !isStr(node_id) ||
    !isStrOrNull(product_id) ||
    !isStrOrNull(product_sku) ||
    !isStrOrNull(product_name) ||
    !isStrOrNull(product_color_token) ||
    !isStr(timerange) ||
    !isNumOrNull(planned_headcount) ||
    !isStrOrNull(notes) ||
    !isStr(status) ||
    !isStrOrNull(created_by) ||
    !isStr(created_at) ||
    !isStr(updated_at)
  ) {
    return null;
  }
  return {
    id,
    orgId: org_id,
    nodeId: node_id,
    productId: product_id,
    productSku: product_sku,
    productName: product_name,
    productColorToken: product_color_token,
    timerange,
    plannedHeadcount: planned_headcount,
    notes,
    status,
    createdBy: created_by,
    createdAt: created_at,
    updatedAt: updated_at,
  };
}

/** `assignments` row shape, as returned by `to_jsonb(a)` (raw table row). */
export interface Assignment {
  id: string;
  orgId: string;
  nodeId: string;
  /** NULL once the person has been deleted; `operatorDisplayName` then names them. */
  operatorId: string | null;
  /** D110 snapshot, set at the moment the person was deleted. */
  operatorDisplayName: string | null;
  runId: string | null;
  productId: string | null;
  /** D110 snapshot for a DIRECT assignment whose product has been deleted. */
  productSku: string | null;
  productName: string | null;
  productColorToken: string | null;
  timerange: string;
  efficiency: number;
  eligibilityOverride: boolean;
  overrideReason: string | null;
  /**
   * D113 / migration 0030: this assignment deliberately places somebody
   * outside the part of the structure they belong to.
   *
   * ⚠️ NOT THE SAME FIELD AS `eligibilityOverride`, and the board must never
   * render them with the same words. That one means "no Welding ticket, waved
   * through"; this one means "not from this line, placed here anyway". A
   * supervisor waving the first must not be shown as having waved the second.
   *
   * The database NORMALISES this off when the row did not actually need it, so
   * `true` always means an override really happened — see 0030 §2.
   */
  areaOverride: boolean;
  areaOverrideReason: string | null;
  targetQty: number | null;
  targetUnit: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Exported for the same reason as `parseRun` above: mutations.ts's plain
 * PostgREST update on `assignments` returns a bare row. */
export function parseAssignment(v: Json): Assignment | null {
  if (!isJsonObject(v)) return null;
  const {
    id,
    org_id,
    node_id,
    operator_id,
    operator_display_name,
    run_id,
    product_id,
    product_sku,
    product_name,
    product_color_token,
    timerange,
    efficiency,
    eligibility_override,
    override_reason,
    area_override,
    area_override_reason,
    target_qty,
    target_unit,
    status,
    created_by,
    created_at,
    updated_at,
  } = v;
  if (
    !isStr(id) ||
    !isStr(org_id) ||
    !isStr(node_id) ||
    !isStrOrNull(operator_id) ||
    !isStrOrNull(operator_display_name) ||
    !isStrOrNull(run_id) ||
    !isStrOrNull(product_id) ||
    !isStrOrNull(product_sku) ||
    !isStrOrNull(product_name) ||
    !isStrOrNull(product_color_token) ||
    !isStr(timerange) ||
    !isNum(efficiency) ||
    !isBool(eligibility_override) ||
    !isStrOrNull(override_reason) ||
    !isBool(area_override) ||
    !isStrOrNull(area_override_reason) ||
    !isNumOrNull(target_qty) ||
    !isStrOrNull(target_unit) ||
    !isStr(status) ||
    !isStrOrNull(created_by) ||
    !isStr(created_at) ||
    !isStr(updated_at)
  ) {
    return null;
  }
  return {
    id,
    orgId: org_id,
    nodeId: node_id,
    operatorId: operator_id,
    operatorDisplayName: operator_display_name,
    runId: run_id,
    productId: product_id,
    productSku: product_sku,
    productName: product_name,
    productColorToken: product_color_token,
    timerange,
    efficiency,
    eligibilityOverride: eligibility_override,
    overrideReason: override_reason,
    // `area_override` is NOT NULL with a default, so a row without it is a
    // payload from a database older than 0030 rather than a legal shape; the
    // guard below rejects rather than coercing, like every other required
    // field here.
    areaOverride: area_override,
    areaOverrideReason: area_override_reason,
    targetQty: target_qty,
    targetUnit: target_unit,
    status,
    createdBy: created_by,
    createdAt: created_at,
    updatedAt: updated_at,
  };
}

export interface BoardOperator {
  id: string;
  homeNodeId: string | null;
  displayName: string;
  employeeRef: string | null;
  active: boolean;
  /**
   * D109 / migration 0028: the part of the structure this person belongs to.
   * `board_window` has sent it since 0025 and this parser dropped it, so the
   * board could not tell whether a person belonged at the cell being scheduled
   * — which is the question D113's override is about. Same gap `Product` had.
   *
   * ⚠️ `""` for a SYNTHESISED row only (a departed person drawn from D110's
   * snapshot, `history.ts`). It must never reach `offeredAt`, which fails OPEN
   * on an owner it cannot resolve.
   */
  siteNodeId: string;
  skillIds: string[];
}

function parseOperator(v: Json): BoardOperator | null {
  if (!isJsonObject(v)) return null;
  const { id, home_node_id, display_name, employee_ref, active, site_node_id, skill_ids } = v;
  if (
    !isStr(id) ||
    !isStrOrNull(home_node_id) ||
    !isStr(display_name) ||
    !isStrOrNull(employee_ref) ||
    !isBool(active) ||
    // NOT NULL since 0028, so a row without it is a payload from a database
    // this client does not understand — rejected, not coerced.
    !isStr(site_node_id)
  ) {
    return null;
  }
  const skillIds = parseArrayOf(skill_ids, (item) => (isStr(item) ? item : null));
  if (skillIds === null) return null;
  return {
    id,
    homeNodeId: home_node_id,
    displayName: display_name,
    employeeRef: employee_ref,
    active,
    siteNodeId: site_node_id,
    skillIds,
  };
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  /**
   * The nodes this product is MADE AT — `product_sites`, D115 / migration 0034 —
   * and therefore the nodes at or below any of which it may be run
   * (`scope.ts`'s `productOfferedAt`). `board_window` emits `site_node_ids` (an
   * array) since 0034; before that it was a single `site_node_id`.
   *
   * ⭐ This is not decoration: `app_guard_run_scope` / `app_guard_assignment_scope`
   * REFUSE a run or assignment whose product is offered in NO plant covering the
   * target cell (`not_offered_here`), and there is no override for products. A
   * picker that does not read this list offers work the server is guaranteed to
   * reject. An EMPTY list is a real state (a part not assigned to any plant), and
   * it means the product is offered NOWHERE — the picker must not show it.
   */
  siteNodeIds: string[];
  /**
   * The nodes IN THIS BOARD WINDOW where this product is OFFERED — the server's
   * own answer, from `board_window`'s `offered_node_ids` (migration 0042).
   *
   * ⭐⭐ THIS EXISTS BECAUSE `siteNodeIds` CANNOT ANSWER THE QUESTION, AND A
   * SUPERVISOR PAID FOR THE DIFFERENCE (DEF-0005). `product_sites` is
   * RLS-filtered on read: reading is downward from a grant, so a supervisor
   * granted a LINE cannot read the PLANT, and a plant-wide part arrives with
   * `siteNodeIds: []`. The picker read that as "made nowhere" and offered her
   * ONE part out of the four on her own legend, while the server accepted all
   * four. Two states — "assigned to no plant" and "every place is above your
   * grant" — arrived as the same empty array, and nothing downstream could tell
   * them apart, because the information was gone before it got here.
   *
   * So the client stopped deriving the answer and started being told it. This
   * list is computed by `app_offered_product_nodes`, the set form of the same
   * `app_product_offered_at` the write guard runs, under SECURITY DEFINER —
   * CLAUDE.md §4: whatever a client hides or offers must be decided by the same
   * test the server runs.
   *
   * ⚠️ IT IS SCOPED TO THE WINDOW, so membership is the whole test: a node id
   * in here is a node where a run of this product would be ACCEPTED. An empty
   * list here really does mean "nowhere in this window", because the server
   * answered it rather than a filtered list implying it.
   */
  offeredNodeIds: string[];
  /**
   * The palette token this product renders in — `product-1` .. `product-4`
   * (0023 §3, D102). A TOKEN NAME, NEVER A HEX: the board resolves it through
   * `tokens.css`, which is what lets the palette be re-pointed in one place.
   *
   * ⭐ `board_window` has emitted this since 0023 and NOTHING READ IT. The
   * board computed `var(--product-${(i % 4) + 1})` from a product's position
   * in an org-wide, sku-ordered list instead — so a product's colour changed
   * when a product it has nothing to do with was added or renamed, and the
   * colour editor in the admin section would have been a lie. `BoardGrid` and
   * `BoardToolbar` now read this field.
   */
  colorToken: string;
}

/**
 * ⚠️ `color_token` IS THE ONE FIELD HERE THAT DOES NOT REJECT THE ROW, and the
 * asymmetry is deliberate rather than an oversight.
 *
 * Every other field is identity or state: a product with no `sku` is not a
 * product, and the whole payload failing is the honest answer. A colour is
 * PRESENTATION — and this parser's failure mode is total, because
 * `parseBoardWindow` returns `null` for the whole window if any one product
 * fails, which `board.ts` turns into a thrown `shapeMismatch` and an empty
 * board. Blanking an entire plant's schedule because one product's swatch is
 * missing is not a trade anyone would make.
 *
 * ⭐ `site_node_ids` is the counter-example, and it goes the other way for the
 * same reason: it is where the product is MADE, which is identity. But an EMPTY
 * array is not a failure — a part assigned to no plant is a legitimate state
 * (D115), and it correctly means "offered nowhere", which `productOfferedAt`
 * reads as "show it at no cell". What is rejected is a MALFORMED array or a
 * non-string entry: that is a payload this client does not understand, unlike an
 * honestly-empty list. (Before 0034 the field was a single required owner and an
 * absent one rejected the row; the array's empty case is the new, honest zero.)
 *
 * So an absent or null `color_token` becomes `""`, and the two board call
 * sites fall back to the first palette token for anything that is not a token
 * `tokens.css` defines. That fallback is what makes this safe, and it is the
 * same fallback that covers the OTHER way this goes wrong: 0023 §3 records
 * that `app_product_palette()` shipped at eight entries against a stylesheet
 * defining four, so `product-5` — a perfectly well-formed string — renders as
 * no colour at all. A `isStr` check would not have caught that one either.
 */
function parseProduct(v: Json): Product | null {
  if (!isJsonObject(v)) return null;
  const { id, sku, name, active, color_token, site_node_ids, offered_node_ids } = v;
  if (
    !isStr(id) ||
    !isStr(sku) ||
    !isStr(name) ||
    !isBool(active) ||
    // Required as a shape, unlike `color_token` — see above. An empty array is
    // accepted; a non-array, or an array with a non-string entry, is not.
    !Array.isArray(site_node_ids) ||
    // ⚠️ REQUIRED FOR THE SAME REASON, AND THE COUPLING IS DELIBERATE (0042 /
    // DEF-0005). A server that does not send this key is one whose board_window
    // predates the fix, and a client that quietly carried on would go back to
    // deriving the offer from an RLS-filtered list — which is the defect, made
    // silent. Failing the whole payload is loud, immediate and says which half
    // is behind; the alternative is a picker that is wrong for exactly the
    // roles least able to report it.
    !Array.isArray(offered_node_ids)
  ) {
    return null;
  }
  const siteNodeIds: string[] = [];
  for (const n of site_node_ids) {
    if (!isStr(n)) return null;
    siteNodeIds.push(n);
  }
  const offeredNodeIds: string[] = [];
  for (const n of offered_node_ids) {
    if (!isStr(n)) return null;
    offeredNodeIds.push(n);
  }
  return {
    id,
    sku,
    name,
    active,
    siteNodeIds,
    offeredNodeIds,
    colorToken: isStr(color_token) ? color_token : "",
  };
}

export interface Skill {
  id: string;
  name: string;
}

function parseSkill(v: Json): Skill | null {
  if (!isJsonObject(v)) return null;
  const { id, name } = v;
  if (!isStr(id) || !isStr(name)) return null;
  return { id, name };
}

/** A skill with the expiry it carries in `check_eligibility`'s `expiring_skills`. */
export interface ExpiringSkill extends Skill {
  expiresAt: string;
}

function parseExpiringSkill(v: Json): ExpiringSkill | null {
  if (!isJsonObject(v)) return null;
  const { id, name, expires_at } = v;
  if (!isStr(id) || !isStr(name) || !isStr(expires_at)) return null;
  return { id, name, expiresAt: expires_at };
}

export interface NodeSkillRequirement {
  nodeId: string;
  skillId: string;
}

function parseNodeSkillRequirement(v: Json): NodeSkillRequirement | null {
  if (!isJsonObject(v)) return null;
  const { node_id, skill_id } = v;
  if (!isStr(node_id) || !isStr(skill_id)) return null;
  return { nodeId: node_id, skillId: skill_id };
}

/**
 * R-315: the standard cycle time for one product at one schedulable node.
 * ALWAYS SECONDS — the admin screen offers seconds/minutes/hours and converts
 * before it writes, so nothing downstream has to ask which unit this is.
 */
export interface CycleTime {
  nodeId: string;
  productId: string;
  secondsPerUnit: number;
}

function parseCycleTime(v: Json): CycleTime | null {
  if (!isJsonObject(v)) return null;
  const { node_id, product_id, seconds_per_unit } = v;
  if (!isStr(node_id) || !isStr(product_id) || !isNum(seconds_per_unit)) return null;
  return { nodeId: node_id, productId: product_id, secondsPerUnit: seconds_per_unit };
}

export interface ShiftBreak {
  id: string;
  name: string;
  startMin: number;
  endMin: number;
}

function parseShiftBreak(v: Json): ShiftBreak | null {
  if (!isJsonObject(v)) return null;
  const { id, name, start_min, end_min } = v;
  if (!isStr(id) || !isStr(name) || !isNum(start_min) || !isNum(end_min)) return null;
  return { id, name, startMin: start_min, endMin: end_min };
}

export interface Shift {
  id: string;
  name: string;
  startMin: number;
  endMin: number;
  breaks: ShiftBreak[];
}

function parseShift(v: Json): Shift | null {
  if (!isJsonObject(v)) return null;
  const { id, name, start_min, end_min, breaks } = v;
  if (!isStr(id) || !isStr(name) || !isNum(start_min) || !isNum(end_min)) return null;
  const parsedBreaks = parseArrayOf(breaks, parseShiftBreak);
  if (parsedBreaks === null) return null;
  return { id, name, startMin: start_min, endMin: end_min, breaks: parsedBreaks };
}

export interface ShiftTemplate {
  id: string;
  name: string;
  shifts: Shift[];
}

function parseShiftTemplate(v: Json): ShiftTemplate | null {
  if (!isJsonObject(v)) return null;
  const { id, name, shifts } = v;
  if (!isStr(id) || !isStr(name)) return null;
  const parsedShifts = parseArrayOf(shifts, parseShift);
  if (parsedShifts === null) return null;
  return { id, name, shifts: parsedShifts };
}

export interface NodeShiftMapEntry {
  nodeId: string;
  templateId: string | null;
}

function parseNodeShiftMapEntry(v: Json): NodeShiftMapEntry | null {
  if (!isJsonObject(v)) return null;
  const { node_id, template_id } = v;
  if (!isStr(node_id) || !isStrOrNull(template_id)) return null;
  return { nodeId: node_id, templateId: template_id };
}

// ---------------------------------------------------------------------------
// Top-level RPC results.
// ---------------------------------------------------------------------------

export interface BoardWindow {
  org: Org;
  levels: HierarchyLevel[];
  nodes: BoardNode[];
  runs: Run[];
  assignments: Assignment[];
  operators: BoardOperator[];
  products: Product[];
  skills: Skill[];
  nodeSkillRequirements: NodeSkillRequirement[];
  shiftTemplates: ShiftTemplate[];
  nodeShiftMap: NodeShiftMapEntry[];
  /** R-315: standard seconds-per-unit for the scoped nodes. Empty is normal —
   *  a cycle time is optional everywhere, and most orgs will set none. */
  cycleTimes: CycleTime[];
}

export function parseBoardWindow(json: Json): BoardWindow | null {
  if (!isJsonObject(json)) return null;
  const {
    org,
    levels,
    nodes,
    runs,
    assignments,
    operators,
    products,
    skills,
    node_skill_requirements,
    shift_templates,
    node_shift_map,
    cycle_times,
  } = json;

  const parsedOrg = parseOrg(org);
  const parsedLevels = parseArrayOf(levels, parseLevel);
  const parsedNodes = parseArrayOf(nodes, parseNode);
  const parsedRuns = parseArrayOf(runs, parseRun);
  const parsedAssignments = parseArrayOf(assignments, parseAssignment);
  const parsedOperators = parseArrayOf(operators, parseOperator);
  const parsedProducts = parseArrayOf(products, parseProduct);
  const parsedSkills = parseArrayOf(skills, parseSkill);
  const parsedNodeSkillRequirements = parseArrayOf(
    node_skill_requirements,
    parseNodeSkillRequirement,
  );
  const parsedShiftTemplates = parseArrayOf(shift_templates, parseShiftTemplate);
  const parsedNodeShiftMap = parseArrayOf(node_shift_map, parseNodeShiftMapEntry);
  // Strict like every sibling key, deliberately: board_window COALESCEs this to
  // '[]', so it is missing only against a database that has not run migration
  // 0040. Defaulting to [] there would leave every derived target silently
  // absent and the board otherwise working — the `silent-empty` defect class.
  const parsedCycleTimes = parseArrayOf(cycle_times, parseCycleTime);

  if (
    parsedOrg === null ||
    parsedLevels === null ||
    parsedNodes === null ||
    parsedRuns === null ||
    parsedAssignments === null ||
    parsedOperators === null ||
    parsedProducts === null ||
    parsedSkills === null ||
    parsedNodeSkillRequirements === null ||
    parsedShiftTemplates === null ||
    parsedNodeShiftMap === null ||
    parsedCycleTimes === null
  ) {
    return null;
  }

  return {
    org: parsedOrg,
    levels: parsedLevels,
    nodes: parsedNodes,
    runs: parsedRuns,
    assignments: parsedAssignments,
    operators: parsedOperators,
    products: parsedProducts,
    skills: parsedSkills,
    nodeSkillRequirements: parsedNodeSkillRequirements,
    shiftTemplates: parsedShiftTemplates,
    nodeShiftMap: parsedNodeShiftMap,
    cycleTimes: parsedCycleTimes,
  };
}

export interface CapacityProbeOverlap {
  assignmentId: string;
  nodeId: string;
  nodeName: string;
  productName: string | null;
  timerange: string;
  efficiency: number;
}

function parseCapacityProbeOverlap(v: Json): CapacityProbeOverlap | null {
  if (!isJsonObject(v)) return null;
  const { assignment_id, node_id, node_name, product_name, timerange, efficiency } = v;
  if (
    !isStr(assignment_id) ||
    !isStr(node_id) ||
    !isStr(node_name) ||
    !isStrOrNull(product_name) ||
    !isStr(timerange) ||
    !isNum(efficiency)
  ) {
    return null;
  }
  return {
    assignmentId: assignment_id,
    nodeId: node_id,
    nodeName: node_name,
    productName: product_name,
    timerange,
    efficiency,
  };
}

export interface CapacityProbe {
  fits: boolean;
  peak: number;
  cap: number;
  overlapping: CapacityProbeOverlap[];
}

export function parseCapacityProbe(json: Json): CapacityProbe | null {
  if (!isJsonObject(json)) return null;
  const { fits, peak, cap, overlapping } = json;
  if (!isBool(fits) || !isNum(peak) || !isNum(cap)) return null;
  const parsedOverlapping = parseArrayOf(overlapping, parseCapacityProbeOverlap);
  if (parsedOverlapping === null) return null;
  return { fits, peak, cap, overlapping: parsedOverlapping };
}

export interface EligibilityResult {
  eligible: boolean;
  policy: "warn" | "block";
  missingSkills: Skill[];
  expiringSkills: ExpiringSkill[];
}

export function parseEligibilityResult(json: Json): EligibilityResult | null {
  if (!isJsonObject(json)) return null;
  const { eligible, policy, missing_skills, expiring_skills } = json;
  if (!isBool(eligible) || (policy !== "warn" && policy !== "block")) return null;
  const parsedMissing = parseArrayOf(missing_skills, parseSkill);
  const parsedExpiring = parseArrayOf(expiring_skills, parseExpiringSkill);
  if (parsedMissing === null || parsedExpiring === null) return null;
  return { eligible, policy, missingSkills: parsedMissing, expiringSkills: parsedExpiring };
}

export interface CreateRunResult {
  run: Run;
}

export function parseCreateRunResult(json: Json): CreateRunResult | null {
  if (!isJsonObject(json)) return null;
  const run = parseRun(json.run as Json);
  if (run === null) return null;
  return { run };
}

export interface CreateAssignmentResult {
  assignment: Assignment;
  eligibility: EligibilityResult;
}

export function parseCreateAssignmentResult(json: Json): CreateAssignmentResult | null {
  if (!isJsonObject(json)) return null;
  const assignment = parseAssignment(json.assignment as Json);
  const eligibility = parseEligibilityResult(json.eligibility as Json);
  if (assignment === null || eligibility === null) return null;
  return { assignment, eligibility };
}

export interface MoveRunEligibilityWarning {
  operatorId: string;
  missingSkills: Skill[];
}

function parseMoveRunEligibilityWarning(v: Json): MoveRunEligibilityWarning | null {
  if (!isJsonObject(v)) return null;
  const { operator_id, missing_skills } = v;
  if (!isStr(operator_id)) return null;
  const parsedMissing = parseArrayOf(missing_skills, parseSkill);
  if (parsedMissing === null) return null;
  return { operatorId: operator_id, missingSkills: parsedMissing };
}

export interface MoveRunResult {
  run: Run;
  assignments: Assignment[];
  eligibilityWarnings: MoveRunEligibilityWarning[];
}

export function parseMoveRunResult(json: Json): MoveRunResult | null {
  if (!isJsonObject(json)) return null;
  const run = parseRun(json.run as Json);
  const assignments = parseArrayOf(json.assignments, parseAssignment);
  const eligibilityWarnings = parseArrayOf(
    json.eligibility_warnings,
    parseMoveRunEligibilityWarning,
  );
  if (run === null || assignments === null || eligibilityWarnings === null) return null;
  return { run, assignments, eligibilityWarnings };
}

export interface SplitCoverageResult {
  adjusted: Assignment[];
  /** `null` only when `apply_split_coverage` was called with a null `p_new_assignment` (pure rebalance). */
  assignment: Assignment | null;
}

export function parseSplitCoverageResult(json: Json): SplitCoverageResult | null {
  if (!isJsonObject(json)) return null;
  const adjusted = parseArrayOf(json.adjusted, parseAssignment);
  if (adjusted === null) return null;
  if (json.assignment === null) {
    return { adjusted, assignment: null };
  }
  const assignment = parseAssignment(json.assignment as Json);
  if (assignment === null) return null;
  return { adjusted, assignment };
}

export interface DeleteRunResult {
  deletedRunId: string;
  detachedAssignmentIds: string[];
}

export function parseDeleteRunResult(json: Json): DeleteRunResult | null {
  if (!isJsonObject(json)) return null;
  const { deleted_run_id, detached_assignment_ids } = json;
  if (!isStr(deleted_run_id)) return null;
  const ids = parseArrayOf(detached_assignment_ids, (item) => (isStr(item) ? item : null));
  if (ids === null) return null;
  return { deletedRunId: deleted_run_id, detachedAssignmentIds: ids };
}

// ---------------------------------------------------------------------------
// D110 / migration 0029 — `deletion_preview` and `delete_owned_row`.
//
// ⭐ THE `what` VALUES ARE TABLE NAMES AND THEY STAY THAT WAY. This file's
// header says snake_case stops here, and it means COLUMN names: `node_id`
// becomes `nodeId` because it is a field of this shape. A `what` is a VALUE
// the database chose from a closed set (`runs`, `assignments`,
// `operator_skills`, …), and camel-casing a value would make the client and
// `56_delete_keeps_the_past_test.sql` disagree about the same string. Turning
// it into English is `features/admin/lib/deletion.ts`'s job.
// ---------------------------------------------------------------------------

/**
 * The four things a site owns and can therefore delete. Deliberately the same
 * four words migration 0028's `not_offered_here` payload uses for its `kind`,
 * so one vocabulary covers "you may not put that here" and "you are deleting
 * that".
 */
export type DeletableKind = "product" | "operator" | "skill" | "shift_template";

const DELETABLE_KINDS: readonly string[] = ["product", "operator", "skill", "shift_template"];

/** One line of the dialog: a table name and how many of its rows. */
export interface DeletionCount {
  what: string;
  count: number;
}

/**
 * What deleting this row would do — or, from `delete_owned_row`, what it did.
 *
 * `removes` and `keeps` are both about rows the deletion TOUCHES, which is what
 * makes the two numbers comparable on screen: "1 of the 3 jobs that use this
 * goes, 2 stay". A `keeps` of `[]` is a real answer and means there is no past
 * to keep at all — trainings and shift patterns are configuration, and nothing
 * records which one a finished run used.
 */
export interface DeletionPreview {
  kind: DeletableKind;
  id: string;
  name: string;
  /** A product's sku, a person's employee ref. `null` for trainings and patterns. */
  code: string | null;
  active: boolean;
  removes: DeletionCount[];
  keeps: DeletionCount[];
  /** Only ever `true`, and only on the answer from `delete_owned_row`. */
  deleted: boolean;
}

function parseDeletionCounts(json: Json | undefined): DeletionCount[] | null {
  if (!isArr(json)) return null;
  const out: DeletionCount[] = [];
  for (const row of json) {
    if (!isJsonObject(row)) return null;
    const { what, count } = row;
    // ⚠️ NOT COERCED AND NOT SKIPPED. A line this client cannot read is a line
    // whose count would silently become zero — and zero is the number that
    // makes somebody press Delete.
    if (!isStr(what) || !isNum(count) || !Number.isInteger(count)) return null;
    out.push({ what, count });
  }
  return out;
}

export function parseDeletionPreview(json: Json): DeletionPreview | null {
  if (!isJsonObject(json)) return null;
  const { kind, id, name, code, active, removes, keeps, deleted } = json;
  if (!isStr(kind) || !DELETABLE_KINDS.includes(kind)) return null;
  if (!isStr(id) || !isStr(name) || !isBool(active)) return null;
  if (!(code === null || isStr(code))) return null;
  const parsedRemoves = parseDeletionCounts(removes);
  const parsedKeeps = parseDeletionCounts(keeps);
  if (parsedRemoves === null || parsedKeeps === null) return null;
  return {
    kind: kind as DeletableKind,
    id,
    name,
    code,
    active,
    removes: parsedRemoves,
    keeps: parsedKeeps,
    // Absent means false. `delete_owned_row` is the only caller that sets it,
    // so a preview must not come back with it undefined and read as truthy
    // anywhere downstream.
    deleted: deleted === true,
  };
}
