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
  if (!isStr(id) || !isStr(template_id) || !isNum(position) || !isStr(name) || !isBool(is_schedulable))
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
export interface Run {
  id: string;
  orgId: string;
  nodeId: string;
  productId: string;
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
    !isStr(product_id) ||
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
  operatorId: string;
  runId: string | null;
  productId: string | null;
  timerange: string;
  efficiency: number;
  eligibilityOverride: boolean;
  overrideReason: string | null;
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
    run_id,
    product_id,
    timerange,
    efficiency,
    eligibility_override,
    override_reason,
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
    !isStr(operator_id) ||
    !isStrOrNull(run_id) ||
    !isStrOrNull(product_id) ||
    !isStr(timerange) ||
    !isNum(efficiency) ||
    !isBool(eligibility_override) ||
    !isStrOrNull(override_reason) ||
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
    runId: run_id,
    productId: product_id,
    timerange,
    efficiency,
    eligibilityOverride: eligibility_override,
    overrideReason: override_reason,
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
  skillIds: string[];
}

function parseOperator(v: Json): BoardOperator | null {
  if (!isJsonObject(v)) return null;
  const { id, home_node_id, display_name, employee_ref, active, skill_ids } = v;
  if (
    !isStr(id) ||
    !isStrOrNull(home_node_id) ||
    !isStr(display_name) ||
    !isStrOrNull(employee_ref) ||
    !isBool(active)
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
    skillIds,
  };
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  active: boolean;
}

function parseProduct(v: Json): Product | null {
  if (!isJsonObject(v)) return null;
  const { id, sku, name, active } = v;
  if (!isStr(id) || !isStr(sku) || !isStr(name) || !isBool(active)) return null;
  return { id, sku, name, active };
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
    parsedNodeShiftMap === null
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
