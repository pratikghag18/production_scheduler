/**
 * Read wrappers: board_window, capacity_probe, check_eligibility
 * (brief P1-3b §5).
 *
 * Every wrapper: call `supabase.rpc(...)`, throw `toSchedulerError(error)`
 * on a PostgREST error, else run the payload through its shapes.ts guard
 * and throw a loud `shapeMismatch` if that fails. `supabase.rpc` is called
 * nowhere else in the codebase (self-review §9 item 8).
 */
import { supabase } from "@/lib/supabase";
import { shapeMismatch, toSchedulerError } from "./errors";
import {
  parseBoardWindow,
  parseBlocksElsewhere,
  parseCapacityProbe,
  parseEligibilityResult,
  type BlockElsewhere,
  type BoardWindow,
  type CapacityProbe,
  type EligibilityResult,
} from "./shapes";
import type { Json } from "@/lib/database.types";
import { toEfficiency, toTstzRange } from "./serde";

/**
 * `board_window(p_root_path ltree, p_from timestamptz, p_to timestamptz)`.
 * Generated signature (database.types.ts): `{ p_from: string; p_root_path:
 * unknown; p_to: string } -> Json`. `p_root_path` is generated `unknown`
 * because `ltree` has no TS structure (brief §2) — PostgREST accepts it as
 * a plain string and casts server-side, so `rootPath` is just a string
 * here (e.g. `"plant_1"`), no serde helper needed.
 */
export async function fetchBoardWindow(
  rootPath: string,
  from: Date,
  to: Date,
): Promise<BoardWindow> {
  const { data, error } = await supabase.rpc("board_window", {
    p_root_path: rootPath,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseBoardWindow(data);
  if (parsed === null)
    throw shapeMismatch("board_window", "expected a BoardWindow object (see shapes.ts)");
  return parsed;
}

export interface CapacityProbeInput {
  operatorId: string;
  start: Date;
  end: Date;
  /** UI percent (e.g. `50`), converted to numeric(4,3) here via `toEfficiency`. */
  efficiencyPercent: number;
  excludeAssignmentId?: string;
}

/**
 * `capacity_probe(p_operator_id uuid, p_timerange tstzrange, p_efficiency
 * numeric, p_exclude_assignment_id uuid DEFAULT NULL)`. Generated signature:
 * `{ p_efficiency: number; p_exclude_assignment_id?: string; p_operator_id:
 * string; p_timerange: unknown } -> Json`. Never raises (docs/api.md §2) —
 * a pure probe — but the shape guard still applies to what it returns.
 */
export async function probeCapacity(input: CapacityProbeInput): Promise<CapacityProbe> {
  const { data, error } = await supabase.rpc("capacity_probe", {
    p_operator_id: input.operatorId,
    p_timerange: toTstzRange(input.start, input.end),
    p_efficiency: toEfficiency(input.efficiencyPercent),
    p_exclude_assignment_id: input.excludeAssignmentId,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseCapacityProbe(data);
  if (parsed === null)
    throw shapeMismatch("capacity_probe", "expected a CapacityProbe object (see shapes.ts)");
  return parsed;
}

/**
 * `operator_blocks_elsewhere(p_from timestamptz, p_to timestamptz, p_root_path
 * ltree)` (migration 0085, R-465; the root, 0087). Generated signature: `{ p_from: string;
 * p_to: string; p_root_path?: unknown } -> { operator_id, node_name, parent_name,
 * timerange, efficiency }[]`. The blocks of people the caller can read that are
 * not on the board rooted at `rootPath`; an empty set when everything is on it.
 */
export async function fetchBlocksElsewhere(
  from: Date,
  to: Date,
  rootPath: string,
): Promise<BlockElsewhere[]> {
  // DEF-0069 (migration 0087): the board's own root, the same ltree string
  // `board_window` takes. The set is every block of a readable person NOT at or below
  // that root, whether or not the caller can read its place (a readable place off her
  // board is no more on the rail than one she cannot read).
  const { data, error } = await supabase.rpc("operator_blocks_elsewhere", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_root_path: rootPath,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseBlocksElsewhere(data as Json);
  if (parsed === null) {
    throw shapeMismatch(
      "operator_blocks_elsewhere",
      "expected an array of BlockElsewhere rows (see shapes.ts)",
    );
  }
  return parsed;
}

export interface EligibilityInput {
  nodeId: string;
  operatorId: string;
  start: Date;
  end: Date;
}

/**
 * `check_eligibility(p_node_id uuid, p_operator_id uuid, p_timerange
 * tstzrange)`. Generated signature: `{ p_node_id: string; p_operator_id:
 * string; p_timerange: unknown } -> Json`. Never raises (docs/api.md §2).
 */
export async function fetchEligibility(input: EligibilityInput): Promise<EligibilityResult> {
  const { data, error } = await supabase.rpc("check_eligibility", {
    p_node_id: input.nodeId,
    p_operator_id: input.operatorId,
    p_timerange: toTstzRange(input.start, input.end),
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseEligibilityResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "check_eligibility",
      "expected an EligibilityResult object (see shapes.ts)",
    );
  }
  return parsed;
}
