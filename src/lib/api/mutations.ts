/**
 * Write wrappers: create_run, create_assignment, move_run,
 * apply_split_coverage, delete_run, plus the plain-table updates that go
 * through ordinary PostgREST writes instead of an RPC (brief P1-3b §5,
 * docs/api.md §4).
 *
 * Same contract as board.ts: call, throw `toSchedulerError(error)` on a
 * PostgREST error, run the payload through its shapes.ts guard, throw a
 * loud `shapeMismatch` if that fails. `supabase.rpc` / `supabase.from` are
 * called nowhere outside src/lib/api/ (self-review §9 items 3 and 8).
 */
import { supabase } from "@/lib/supabase";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { shapeMismatch, toSchedulerError } from "./errors";
import {
  parseAssignment,
  parseCreateAssignmentResult,
  parseCreateRunResult,
  parseDeleteRunResult,
  parseMoveRunResult,
  parseRun,
  parseSplitCoverageResult,
  type Assignment,
  type CreateAssignmentResult,
  type CreateRunResult,
  type DeleteRunResult,
  type MoveRunResult,
  type Run,
  type SplitCoverageResult,
} from "./shapes";
import { toEfficiency, toTstzRange } from "./serde";

/**
 * Which of `run_id` / `product_id` this assignment attaches to (brief §2):
 * the database requires `num_nonnulls(run_id, product_id) = 1`, but the
 * generated RPC types both as required `string` because `ltree`/range
 * opacity aside, the generator has no way to express "exactly one of
 * these." A discriminated union here is what lets every call site below
 * avoid ever passing both, or neither.
 */
export type AssignmentTarget =
  { kind: "run"; runId: string } | { kind: "direct"; productId: string };

/**
 * THE single place that resolves an `AssignmentTarget` to the
 * null-for-the-unused-field pair the RPC needs (brief §2: "Your wrapper
 * must ... pass null for the unused one, casting at the single call site
 * with a comment explaining why. Do not push that null handling onto
 * callers."). Both `createAssignment` and `applySplitCoverage`'s
 * new-assignment payload call this instead of open-coding the resolution
 * themselves — see the comment at each call site for the actual cast.
 */
function resolveAssignmentTarget(target: AssignmentTarget): {
  runId: string | null;
  productId: string | null;
} {
  return target.kind === "run"
    ? { runId: target.runId, productId: null }
    : { runId: null, productId: target.productId };
}

export interface CreateRunInput {
  nodeId: string;
  productId: string;
  start: Date;
  end: Date;
  plannedHeadcount?: number;
  notes?: string;
}

/**
 * `create_run(p_node_id uuid, p_product_id uuid, p_timerange tstzrange,
 * p_planned_headcount int DEFAULT NULL, p_notes text DEFAULT NULL)`.
 * Generated signature: `{ p_node_id: string; p_notes?: string;
 * p_planned_headcount?: number; p_product_id: string; p_timerange: unknown
 * } -> Json`. Raises: invalid_argument, not_permitted, run_overlap.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  const { data, error } = await supabase.rpc("create_run", {
    p_node_id: input.nodeId,
    p_product_id: input.productId,
    p_timerange: toTstzRange(input.start, input.end),
    p_planned_headcount: input.plannedHeadcount,
    p_notes: input.notes,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseCreateRunResult(data);
  if (parsed === null)
    throw shapeMismatch("create_run", "expected a CreateRunResult object (see shapes.ts)");
  return parsed;
}

export interface CreateAssignmentInput {
  nodeId: string;
  operatorId: string;
  target: AssignmentTarget;
  start: Date;
  end: Date;
  /** UI percent (e.g. `50`); defaults to the DB's own DEFAULT 1.000 (100%) if omitted. */
  efficiencyPercent?: number;
  targetQty?: number;
  targetUnit?: string;
  eligibilityOverride?: boolean;
  overrideReason?: string;
  /**
   * D113 / migration 0030: place this person outside the part of the structure
   * they belong to, on purpose.
   *
   * ⚠️ A DIFFERENT DECISION FROM `eligibilityOverride`, AND THE SEPARATION IS
   * THE WHOLE POINT. That one waves through a missing training; this one waves
   * through "not from this line". A supervisor doing the first must not be
   * recorded as having done the second — the weaker permission would grant the
   * stronger one — so they are two flags, two reasons and two decisions.
   *
   * The server refuses `true` with no reason (`invalid_argument` naming
   * `p_area_override_reason`), and turns the flag back off if the row did not
   * actually need it, so sending it optimistically is safe but never a lie.
   */
  areaOverride?: boolean;
  areaOverrideReason?: string;
}

/**
 * `create_assignment(p_node_id uuid, p_operator_id uuid, p_run_id uuid,
 * p_product_id uuid, p_timerange tstzrange, p_efficiency numeric DEFAULT
 * 1.000, p_target_qty numeric DEFAULT NULL, p_target_unit text DEFAULT
 * NULL, p_eligibility_override boolean DEFAULT false, p_override_reason
 * text DEFAULT NULL)`. Generated signature: `{ p_efficiency?: number;
 * p_eligibility_override?: boolean; p_node_id: string; p_operator_id:
 * string; p_override_reason?: string; p_product_id: string; p_run_id:
 * string; p_target_qty?: number; p_target_unit?: string; p_timerange:
 * unknown } -> Json`. Raises: invalid_argument, not_permitted,
 * not_eligible, capacity_exceeded (via the trigger).
 */
export async function createAssignment(
  input: CreateAssignmentInput,
): Promise<CreateAssignmentResult> {
  const { runId, productId } = resolveAssignmentTarget(input.target);
  const { data, error } = await supabase.rpc("create_assignment", {
    p_node_id: input.nodeId,
    p_operator_id: input.operatorId,
    // Exactly one of these is ever non-null (see resolveAssignmentTarget /
    // brief §2); the generated types require both as `string`, so the
    // unused one is cast through at this call site.
    p_run_id: runId as unknown as string,
    p_product_id: productId as unknown as string,
    p_timerange: toTstzRange(input.start, input.end),
    p_efficiency:
      input.efficiencyPercent === undefined ? undefined : toEfficiency(input.efficiencyPercent),
    p_target_qty: input.targetQty,
    p_target_unit: input.targetUnit,
    p_eligibility_override: input.eligibilityOverride,
    p_override_reason: input.overrideReason,
    p_area_override: input.areaOverride,
    p_area_override_reason: input.areaOverrideReason,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseCreateAssignmentResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "create_assignment",
      "expected a CreateAssignmentResult object (see shapes.ts)",
    );
  }
  return parsed;
}

export interface MoveRunInput {
  runId: string;
  nodeId: string;
  start: Date;
  end: Date;
  /**
   * D113: move the run even though some of its crew do not belong at the target
   * cell. ⚠️ ONE REASON COVERS THE WHOLE MOVE, unlike `createAssignment` where
   * one reason covers one person — the supervisor is deciding about a move, not
   * about five people individually, and `move_run` refuses up front NAMING
   * everyone affected so the screen can ask about them together.
   */
  areaOverride?: boolean;
  areaOverrideReason?: string;
}

/**
 * `move_run(p_run_id uuid, p_node_id uuid, p_timerange tstzrange)`.
 * Generated signature: `{ p_node_id: string; p_run_id: string;
 * p_timerange: unknown } -> Json`. Raises: invalid_argument, not_permitted,
 * run_overlap, not_eligible (block only), capacity_exceeded (via the
 * trigger). A bare `23P01` here is the RaceLost case (docs/api.md §1);
 * `useMoveRun` (not this function) owns the retry-once policy.
 */
export async function moveRun(input: MoveRunInput): Promise<MoveRunResult> {
  const { data, error } = await supabase.rpc("move_run", {
    p_run_id: input.runId,
    p_node_id: input.nodeId,
    p_timerange: toTstzRange(input.start, input.end),
    p_area_override: input.areaOverride,
    p_area_override_reason: input.areaOverrideReason,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseMoveRunResult(data);
  if (parsed === null)
    throw shapeMismatch("move_run", "expected a MoveRunResult object (see shapes.ts)");
  return parsed;
}

export interface SplitAdjustment {
  assignmentId: string;
  /** UI percent — converted via `toEfficiency` here, same as everywhere else. */
  efficiencyPercent: number;
}

export interface SplitCoverageInput {
  adjustments: SplitAdjustment[];
  /** `null` for a pure rebalance (docs/api.md §3: "no new assignment"). */
  newAssignment: CreateAssignmentInput | null;
}

/**
 * `apply_split_coverage(p_adjustments jsonb, p_new_assignment jsonb)`.
 * Generated signature: `{ p_adjustments: Json; p_new_assignment: Json } ->
 * Json`. Raises: invalid_argument, not_permitted, plus anything
 * create_assignment can raise when `newAssignment` is not null.
 */
export async function applySplitCoverage(input: SplitCoverageInput): Promise<SplitCoverageResult> {
  const p_adjustments = input.adjustments.map((a) => ({
    assignment_id: a.assignmentId,
    efficiency: toEfficiency(a.efficiencyPercent),
  }));

  let p_new_assignment: Json = null;
  if (input.newAssignment !== null) {
    const na = input.newAssignment;
    const { runId, productId } = resolveAssignmentTarget(na.target);
    p_new_assignment = {
      node_id: na.nodeId,
      operator_id: na.operatorId,
      // Same single-resolution helper as createAssignment — see its
      // comment (brief §2). The cast happens here, at this call site.
      run_id: runId as unknown as string,
      product_id: productId as unknown as string,
      timerange: toTstzRange(na.start, na.end),
      efficiency:
        na.efficiencyPercent === undefined ? undefined : toEfficiency(na.efficiencyPercent),
      target_qty: na.targetQty,
      target_unit: na.targetUnit,
      eligibility_override: na.eligibilityOverride,
      override_reason: na.overrideReason,
      // D113: the middle of three layers, and the one a plumbing change
      // forgets — this envelope is unpacked by `apply_split_coverage` and
      // handed to `create_assignment`, so an override that stops here is an
      // override that works everywhere except in a split.
      area_override: na.areaOverride,
      area_override_reason: na.areaOverrideReason,
    } as unknown as Json;
  }

  const { data, error } = await supabase.rpc("apply_split_coverage", {
    p_adjustments: p_adjustments as unknown as Json,
    p_new_assignment,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseSplitCoverageResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "apply_split_coverage",
      "expected a SplitCoverageResult object (see shapes.ts)",
    );
  }
  return parsed;
}

/**
 * `delete_run(p_run_id uuid, p_mode text DEFAULT 'cascade')`. Generated
 * signature: `{ p_mode?: string; p_run_id: string } -> Json`. Raises:
 * invalid_argument (bad mode, run not found), not_permitted.
 */
export async function deleteRun(
  runId: string,
  mode?: "cascade" | "detach",
): Promise<DeleteRunResult> {
  const { data, error } = await supabase.rpc("delete_run", {
    p_run_id: runId,
    p_mode: mode,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseDeleteRunResult(data);
  if (parsed === null)
    throw shapeMismatch("delete_run", "expected a DeleteRunResult object (see shapes.ts)");
  return parsed;
}

// ---------------------------------------------------------------------------
// Plain PostgREST table writes (docs/api.md §4): simple field edits that
// don't need an RPC — no multi-row atomicity, no pre-write permission/
// overlap check beyond what RLS and the P1-2/0009 triggers already do.
// RLS and the triggers still guard every one of these, and the typed error
// contract still applies (migration 0009 amended the triggers themselves,
// not just the RPCs) — a capacity-busting PATCH on `efficiency` still comes
// back as `capacity_exceeded` through `toSchedulerError`, exactly like
// `create_assignment` would.
// ---------------------------------------------------------------------------

export interface RunFieldEdit {
  notes?: string | null;
  plannedHeadcount?: number | null;
  /** A resize that does not change node (docs/api.md §4). */
  timerange?: { start: Date; end: Date };
}

export async function updateRunFields(runId: string, edit: RunFieldEdit): Promise<Run> {
  const patch: TablesUpdate<"runs"> = {};
  if ("notes" in edit) patch.notes = edit.notes ?? null;
  if ("plannedHeadcount" in edit) patch.planned_headcount = edit.plannedHeadcount ?? null;
  if (edit.timerange) patch.timerange = toTstzRange(edit.timerange.start, edit.timerange.end);

  const { data, error } = await supabase
    .from("runs")
    .update(patch)
    .eq("id", runId)
    .select()
    .single();
  if (error) throw toSchedulerError(error);
  const parsed = parseRun(data as unknown as Json);
  if (parsed === null) throw shapeMismatch("runs.update", "expected a Run row (see shapes.ts)");
  return parsed;
}

export interface AssignmentFieldEdit {
  /** UI percent — converted via `toEfficiency` here, same as every other efficiency-writing call site. */
  efficiencyPercent?: number;
  targetQty?: number | null;
  targetUnit?: string | null;
  /**
   * ⭐ ONLY `"cancelled"`, AND THE NARROW TYPE IS THE POINT (R-322). This was
   * `status?: string`, which let the pop-up write planned / active / done. That
   * picker is gone: nothing read the value, no rule fired on it, and nothing
   * obliged a supervisor to touch it, so it could only ever sit at "planned" on
   * work that had finished — and a label nobody maintains is worse than no
   * label, because it reads as fact.
   *
   * ⚠️ THE FIELD ITSELF CANNOT GO, because `cancelled` is not a label: it is the
   * SOFT DELETE. `removeAssignment` writes it here (there is no
   * delete_assignment RPC, §5.4/§5.3), and it is what frees the cell's slot past
   * the overlap constraint, returns the operator's hours to the capacity guard,
   * and drops the row from every board map (`boardIndex.ts` rule 17) while
   * keeping it in history. So the field stays and the TYPE says what it is for:
   * a literal, so an attempt to set a progress label here does not compile
   * rather than reaching the database and going stale there.
   *
   * A future "the job actually started" belongs to shop-floor feedback, not to a
   * field edit, and would be designed then rather than left as an open string.
   */
  status?: "cancelled";
  /** A resize that does not change node (docs/api.md §4). */
  timerange?: { start: Date; end: Date };
  /**
   * P1-4e D66: "re-parenting an assignment between runs ... is
   * `useUpdateAssignmentFields` on `runId`/`productId` — there is no RPC
   * for this and none is needed." Neither field existed on this interface
   * before P1-4e — flagged as a deviation from that brief's own §2 scope
   * fence ("do not touch src/lib/api/") in the agent report, since D66 is
   * unreachable without it: there is no other call site anywhere in the
   * codebase that may call `supabase.from(...).update(...)` directly (see
   * this file's own header comment and docs/api-client.md's single-import
   * rule). The caller is responsible for exactly one of the two being
   * non-null in the FINAL patched row — same `num_nonnulls(run_id,
   * product_id) = 1` invariant `resolveAssignmentTarget` enforces for
   * `createAssignment`/`applySplitCoverage` above, just not funnelled
   * through that helper here since a re-parent only ever sets one of the
   * two per call (attach: `runId` set, `productId` left undefined =
   * unchanged from a prior direct assignment's own stored value, which the
   * caller must have already nulled in an earlier state — in practice this
   * feature always passes BOTH together, one as a real id and the other
   * explicitly `null`, exactly mirroring `delete_run`'s own detach-mode
   * `UPDATE` in docs/api.md §3, which sets `run_id = NULL, product_id =
   * <run's product>` in the very same statement).
   */
  runId?: string | null;
  productId?: string | null;
}

export async function updateAssignmentFields(
  assignmentId: string,
  edit: AssignmentFieldEdit,
): Promise<Assignment> {
  const patch: TablesUpdate<"assignments"> = {};
  if (edit.efficiencyPercent !== undefined) patch.efficiency = toEfficiency(edit.efficiencyPercent);
  if ("targetQty" in edit) patch.target_qty = edit.targetQty ?? null;
  if ("targetUnit" in edit) patch.target_unit = edit.targetUnit ?? null;
  if (edit.status !== undefined) patch.status = edit.status;
  if (edit.timerange) patch.timerange = toTstzRange(edit.timerange.start, edit.timerange.end);
  if ("runId" in edit) patch.run_id = edit.runId ?? null;
  if ("productId" in edit) patch.product_id = edit.productId ?? null;

  const { data, error } = await supabase
    .from("assignments")
    .update(patch)
    .eq("id", assignmentId)
    .select()
    .single();
  if (error) throw toSchedulerError(error);
  const parsed = parseAssignment(data as unknown as Json);
  if (parsed === null)
    throw shapeMismatch("assignments.update", "expected an Assignment row (see shapes.ts)");
  return parsed;
}
