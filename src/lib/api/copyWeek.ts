/**
 * Copy Week (R-339 / S35): the two wrappers over migration
 * `20260905000055_copy_week.sql`'s `copy_week_plan` and `apply_copy_week`.
 *
 * The maintainer's rule, verbatim: "For the copy week, if there are conflicts
 * lets present them to the user and let them decide what they want to keep, the
 * prior plan or the copied plan." So the read returns a PLAN — every source row
 * with its status and, for a clash, both candidates and the choices the server
 * will accept — and the write takes one decision per clash item and applies
 * them in one transaction. Nothing here decides anything: the choices a clash
 * offers are the server's (R-239), and the client renders exactly those.
 *
 * Same conventions as `board.ts`: call `supabase.rpc(...)`, throw
 * `toSchedulerError(error)` on a PostgREST error, else run the payload through
 * a guard and throw a loud `shapeMismatch` if it does not match the contract.
 * Snake_case -> camelCase happens here, at the boundary; timestamps are parsed
 * through `serde.ts`'s range parser so a Postgres `+00` offset is read the one
 * way the app already reads it, not a second way.
 *
 * ⚠️ `tsc` IS INCONCLUSIVE ON THIS FILE UNTIL `npm run db:types` HAS RUN after
 * the migration lands (CLAUDE.md §4): the two function names below are typed
 * against `database.types.ts`, which does not know them until then.
 */
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import { shapeMismatch, toSchedulerError } from "./errors";
import { parseTstzRange } from "./serde";

export type CopyWeekItemKind = "run" | "assignment";
export type CopyWeekItemStatus = "clean" | "clash";
export type CopyWeekClashReason = "run_overlap" | "operator_busy" | "not_eligible";
export type CopyWeekChoice = "prior" | "copied";
export type CopyWeekPolicy = "warn" | "block";

/** A source row, already shifted into the target week. */
export interface CopyWeekCopied {
  nodeId: string;
  nodeName: string;
  productId: string | null;
  productName: string | null;
  operatorId: string | null;
  operatorName: string | null;
  start: Date;
  end: Date;
  plannedHeadcount: number | null;
  notes: string | null;
  efficiency: number | null;
  targetQty: number | null;
  targetUnit: string | null;
}

/** A row the target week already holds that the copied one would collide with. */
export interface CopyWeekPrior {
  id: string;
  kind: CopyWeekItemKind;
  nodeName: string;
  productName: string | null;
  operatorName: string | null;
  start: Date;
  end: Date;
}

export interface CopyWeekClash {
  reason: CopyWeekClashReason;
  /** `not_eligible` only: the plant's effective policy. Null for the other two. */
  policy: CopyWeekPolicy | null;
  prior: CopyWeekPrior[];
  /**
   * R-239: the choices the writers would accept — `["prior", "copied"]`, or
   * `["prior"]` when the server would refuse the copied one outright. Rendered
   * as-is; never widened on the client.
   */
  choices: CopyWeekChoice[];
}

export interface CopyWeekItem {
  /** `run:<source id>` or `assignment:<source id>`. */
  key: string;
  kind: CopyWeekItemKind;
  /** An assignment attached to a copied run names that run's key. */
  parentKey: string | null;
  copied: CopyWeekCopied;
  status: CopyWeekItemStatus;
  clash: CopyWeekClash | null;
}

export interface CopyWeekPlan {
  plantId: string;
  /** `YYYY-MM-DD`, as the server echoed it. */
  sourceStart: string;
  targetStart: string;
  shiftDays: number;
  counts: { clean: number; clash: number };
  /**
   * Rows in the source week whose product or person has been deleted (D110).
   * No writer can take them, so they are not copied and not listed as items;
   * they are counted here so the screen can say they stay behind. Optional on
   * the wire and zero when absent, so a plan from a server that does not send
   * it still parses.
   */
  history: { runs: number; assignments: number };
  items: CopyWeekItem[];
}

export interface CopyWeekDecision {
  key: string;
  choice: CopyWeekChoice;
}

export interface CopyWeekResult {
  created: { runs: number; assignments: number };
  removed: { runs: number; assignments: number };
  skipped: number;
}

export interface CopyWeekPlanInput {
  plantId: string;
  /** Midnight UTC of the week's first day, the way the board holds its window start. */
  sourceStart: Date;
  targetStart: Date;
}

export interface ApplyCopyWeekInput extends CopyWeekPlanInput {
  decisions: CopyWeekDecision[];
}

/* ---------------------------------------------------------------------------
 * Guards. Same shape as shapes.ts's private helpers; kept here because the
 * plan is this module's contract and nothing else reads it.
 * ------------------------------------------------------------------------- */

type JsonRecord = { [key: string]: Json | undefined };

function isJsonObject(v: Json | undefined): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: Json | undefined): v is string {
  return typeof v === "string";
}

function isNum(v: Json | undefined): v is number {
  return typeof v === "number";
}

function isStrOrNull(v: Json | undefined): v is string | null {
  return v === null || typeof v === "string";
}

function isNumOrNull(v: Json | undefined): v is number | null {
  return v === null || typeof v === "number";
}

function parseArrayOf<T>(v: Json | undefined, parseItem: (item: Json) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const parsed = parseItem(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * Two timestamptz strings -> two Dates, through the app's one range parser so
 * a bare `+00` offset is normalised the way every other timestamp is. Returns
 * null on anything unparseable rather than letting `Invalid Date` reach a
 * screen.
 */
function parseInstants(
  start: Json | undefined,
  end: Json | undefined,
): { start: Date; end: Date } | null {
  if (!isStr(start) || !isStr(end)) return null;
  try {
    return parseTstzRange(`["${start}","${end}")`);
  } catch {
    return null;
  }
}

function parseCopied(v: Json | undefined): CopyWeekCopied | null {
  if (!isJsonObject(v)) return null;
  const when = parseInstants(v.start, v.end);
  if (
    when === null ||
    !isStr(v.node_id) ||
    !isStr(v.node_name) ||
    !isStrOrNull(v.product_id) ||
    !isStrOrNull(v.product_name) ||
    !isStrOrNull(v.operator_id) ||
    !isStrOrNull(v.operator_name) ||
    !isNumOrNull(v.planned_headcount) ||
    !isStrOrNull(v.notes) ||
    !isNumOrNull(v.efficiency) ||
    !isNumOrNull(v.target_qty) ||
    !isStrOrNull(v.target_unit)
  ) {
    return null;
  }
  return {
    nodeId: v.node_id,
    nodeName: v.node_name,
    productId: v.product_id,
    productName: v.product_name,
    operatorId: v.operator_id,
    operatorName: v.operator_name,
    start: when.start,
    end: when.end,
    plannedHeadcount: v.planned_headcount,
    notes: v.notes,
    efficiency: v.efficiency,
    targetQty: v.target_qty,
    targetUnit: v.target_unit,
  };
}

function parseKind(v: Json | undefined): CopyWeekItemKind | null {
  return v === "run" || v === "assignment" ? v : null;
}

function parsePrior(v: Json): CopyWeekPrior | null {
  if (!isJsonObject(v)) return null;
  const kind = parseKind(v.kind);
  const when = parseInstants(v.start, v.end);
  if (
    kind === null ||
    when === null ||
    !isStr(v.id) ||
    !isStr(v.node_name) ||
    !isStrOrNull(v.product_name) ||
    !isStrOrNull(v.operator_name)
  ) {
    return null;
  }
  return {
    id: v.id,
    kind,
    nodeName: v.node_name,
    productName: v.product_name,
    operatorName: v.operator_name,
    start: when.start,
    end: when.end,
  };
}

function parseChoice(v: Json): CopyWeekChoice | null {
  return v === "prior" || v === "copied" ? v : null;
}

function parseClash(v: Json | undefined): CopyWeekClash | null {
  if (!isJsonObject(v)) return null;
  const reason = v.reason;
  if (reason !== "run_overlap" && reason !== "operator_busy" && reason !== "not_eligible") {
    return null;
  }
  const policy = v.policy;
  if (policy !== null && policy !== undefined && policy !== "warn" && policy !== "block") {
    return null;
  }
  const prior = parseArrayOf(v.prior, parsePrior);
  const choices = parseArrayOf(v.choices, parseChoice);
  if (prior === null || choices === null || choices.length === 0) return null;
  return { reason, policy: policy ?? null, prior, choices };
}

function parseItem(v: Json): CopyWeekItem | null {
  if (!isJsonObject(v)) return null;
  const kind = parseKind(v.kind);
  const copied = parseCopied(v.copied);
  const status = v.status;
  if (
    kind === null ||
    copied === null ||
    !isStr(v.key) ||
    !isStrOrNull(v.parent_key) ||
    (status !== "clean" && status !== "clash")
  ) {
    return null;
  }
  // A clash item carries its clash; a clean one carries null. Either half
  // missing is a payload that does not say what it means.
  if (status === "clash") {
    const clash = parseClash(v.clash);
    if (clash === null) return null;
    return { key: v.key, kind, parentKey: v.parent_key ?? null, copied, status, clash };
  }
  if (v.clash !== null && v.clash !== undefined) return null;
  return { key: v.key, kind, parentKey: v.parent_key ?? null, copied, status, clash: null };
}

export function parseCopyWeekPlan(json: Json): CopyWeekPlan | null {
  if (!isJsonObject(json)) return null;
  const counts = json.counts;
  const items = parseArrayOf(json.items, parseItem);
  // Absent means none; present but malformed is a payload that does not say
  // what it means, and is refused like any other shape mismatch.
  const history =
    json.history === undefined || json.history === null
      ? { runs: 0, assignments: 0 }
      : parsePair(json.history);
  if (
    items === null ||
    history === null ||
    !isStr(json.plant_id) ||
    !isStr(json.source_start) ||
    !isStr(json.target_start) ||
    !isNum(json.shift_days) ||
    !isJsonObject(counts) ||
    !isNum(counts.clean) ||
    !isNum(counts.clash)
  ) {
    return null;
  }
  return {
    plantId: json.plant_id,
    sourceStart: json.source_start,
    targetStart: json.target_start,
    shiftDays: json.shift_days,
    counts: { clean: counts.clean, clash: counts.clash },
    history,
    items,
  };
}

function parsePair(v: Json | undefined): { runs: number; assignments: number } | null {
  if (!isJsonObject(v) || !isNum(v.runs) || !isNum(v.assignments)) return null;
  return { runs: v.runs, assignments: v.assignments };
}

export function parseCopyWeekResult(json: Json): CopyWeekResult | null {
  if (!isJsonObject(json)) return null;
  const created = parsePair(json.created);
  const removed = parsePair(json.removed);
  if (created === null || removed === null || !isNum(json.skipped)) return null;
  return { created, removed, skipped: json.skipped };
}

/* ---------------------------------------------------------------------------
 * The wrappers.
 * ------------------------------------------------------------------------- */

/** A Date at midnight UTC -> the `YYYY-MM-DD` a Postgres `date` argument takes. */
export function toDateArg(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `app_is_admin_for(p_node uuid) returns boolean` -- the exact predicate
 * `copy_week_plan` and `apply_copy_week` run before they do anything, asked
 * for the plant the board is showing. The toolbar offers "Copy week" on this
 * answer and nothing else (CLAUDE.md section 4: whatever a client offers is
 * decided by the same test the server runs). A site admin of Plant W who can
 * only view Plant V gets `false` here for V, where the session's coarser
 * `adminAnywhere` says `true`.
 *
 * Unlike `fetchAdminAnywhere`, a failure THROWS rather than resolving false:
 * the caller is a react-query hook whose loading and error states already
 * mean "not offered", and a swallowed error would make a refused read look
 * like a considered "no".
 */
export async function fetchIsAdminFor(plantId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("app_is_admin_for", { p_node: plantId });
  if (error) throw toSchedulerError(error);
  return data === true;
}

/**
 * `copy_week_plan(p_plant_id uuid, p_source_start date, p_target_start date)`.
 * Read-only: nothing is written until `applyCopyWeek`.
 */
export async function fetchCopyWeekPlan(input: CopyWeekPlanInput): Promise<CopyWeekPlan> {
  const { data, error } = await supabase.rpc("copy_week_plan", {
    p_plant_id: input.plantId,
    p_source_start: toDateArg(input.sourceStart),
    p_target_start: toDateArg(input.targetStart),
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseCopyWeekPlan(data);
  if (parsed === null) {
    throw shapeMismatch("copy_week_plan", "expected a CopyWeekPlan object (see copyWeek.ts)");
  }
  return parsed;
}

/**
 * `apply_copy_week(p_plant_id uuid, p_source_start date, p_target_start date,
 * p_decisions jsonb)`. The server recomputes the plan and refuses an
 * undecided clash, a choice it did not offer, or a key it does not know — so
 * the client's only job is to send one decision per clash item it was shown.
 */
export async function applyCopyWeek(input: ApplyCopyWeekInput): Promise<CopyWeekResult> {
  const decisions: Json = input.decisions.map((d) => ({ key: d.key, choice: d.choice }));
  const { data, error } = await supabase.rpc("apply_copy_week", {
    p_plant_id: input.plantId,
    p_source_start: toDateArg(input.sourceStart),
    p_target_start: toDateArg(input.targetStart),
    p_decisions: decisions,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseCopyWeekResult(data);
  if (parsed === null) {
    throw shapeMismatch("apply_copy_week", "expected a CopyWeekResult object (see copyWeek.ts)");
  }
  return parsed;
}
