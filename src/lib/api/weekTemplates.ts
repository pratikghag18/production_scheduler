/**
 * Named week templates (R-356 / migration 0067): a whole week's runs with their
 * assignments, saved relative to its Monday and applied through Copy Week. This
 * module is the boundary over `save_week_template`, `list_week_templates`,
 * `rename_week_template` and `delete_week_template`; APPLYING a template is
 * `copyWeek.ts` with a `templateId`, not a function here, because nothing is
 * written that Copy Week would not write.
 *
 * Same conventions as `copyWeek.ts`: call `supabase.rpc(...)`, throw
 * `toSchedulerError` on a PostgREST error, else parse and throw a loud
 * `shapeMismatch`. Snake_case -> camelCase at the boundary.
 *
 * ⚠️ `tsc` IS INCONCLUSIVE ON THIS FILE UNTIL `npm run db:types` HAS RUN after
 * migration 0067 lands (CLAUDE.md section 4).
 */
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import { shapeMismatch, toSchedulerError } from "./errors";

/** A template as the list and the save result describe it. */
export interface WeekTemplate {
  id: string;
  name: string;
  /** `YYYY-MM-DD`: the Monday the week was saved from. */
  savedFrom: string;
  /** How many runs and assignments the snapshot holds. */
  runs: number;
  assignments: number;
}

/**
 * One row of a template's snapshot (`list_week_template_items`, migration
 * 0075, R-356 surface: the read-only "what's inside" view). A run item's
 * `runRef` is always null; an assignment item's `runRef` names the run
 * item's `itemRef` it belongs to, or is null for a standalone assignment.
 *
 * `week_template_items` carries NO foreign keys on node/product/operator
 * (0067 D110: a deleted row makes the snapshot item history, the same way a
 * deleted product makes a run history) — so every `*Name` here is a LEFT
 * JOIN result and comes back `null` when the thing it named is gone. The
 * client shows "(removed)"; it never drops the row.
 */
export interface WeekTemplateItem {
  /** The source row's id, as a string (a run's key; an assignment's own id). */
  itemRef: string;
  kind: "run" | "assignment";
  /** Set only on an assignment attached to a run item; null otherwise. */
  runRef: string | null;
  /** 0 = Monday .. 6 = Sunday, relative to the week the template was saved from. */
  dayOffset: number;
  /** Minutes from that day's midnight. An overnight item's `endMin` exceeds 1440. */
  startMin: number;
  endMin: number;
  /** Runs only; null on an assignment item. */
  plannedHeadcount: number | null;
  nodeId: string;
  /** Null when the node no longer exists. */
  nodeName: string | null;
  productId: string | null;
  /** Null when there is no product, or the product no longer exists. */
  productName: string | null;
  operatorId: string | null;
  /** Null when there is no operator, or the operator no longer exists. */
  operatorName: string | null;
}

/* ---------------------------------------------------------------------------
 * The wire columns, named ONCE. Every parser below reads through these keys, so
 * a field added on the server is added here and nowhere else (CLAUDE.md
 * section 4: a column list that appears twice is a bug with a delay on it).
 * ------------------------------------------------------------------------- */
const F = {
  id: "id",
  name: "name",
  savedFrom: "saved_from",
  runs: "runs",
  assignments: "assignments",
} as const;

/** `list_week_template_items`'s wire columns, named ONCE (see `F` above). */
const FI = {
  itemRef: "item_ref",
  kind: "kind",
  runRef: "run_ref",
  dayOffset: "day_offset",
  startMin: "start_min",
  endMin: "end_min",
  plannedHeadcount: "planned_headcount",
  nodeId: "node_id",
  nodeName: "node_name",
  productId: "product_id",
  productName: "product_name",
  operatorId: "operator_id",
  operatorName: "operator_name",
} as const;

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

/**
 * One template row. `save` returns its counts nested under `counts`; `list`
 * returns them flat. Read both shapes so the two callers share one parser.
 */
function parseTemplate(v: Json | undefined): WeekTemplate | null {
  if (!isJsonObject(v)) return null;
  const counts = isJsonObject(v.counts) ? v.counts : v;
  // Hoist each field into a local before guarding: TypeScript narrows a
  // guarded identifier but not a repeated element access (`v[F.id]`), so the
  // guards below have to carry through to the returned object (as in
  // copyWeek.ts's parseCopyWeekPlan). Read via `F` keeps the one column list.
  const id = v[F.id];
  const name = v[F.name];
  const savedFrom = v[F.savedFrom];
  const runs = counts[F.runs];
  const assignments = counts[F.assignments];
  if (!isStr(id) || !isStr(name) || !isStr(savedFrom) || !isNum(runs) || !isNum(assignments)) {
    return null;
  }
  return { id, name, savedFrom, runs, assignments };
}

function parseTemplateList(v: Json): WeekTemplate[] | null {
  if (!Array.isArray(v)) return null;
  const out: WeekTemplate[] = [];
  for (const item of v) {
    const parsed = parseTemplate(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** One row of `list_week_template_items`. Read via `FI` (one column list). */
function parseTemplateItem(v: Json | undefined): WeekTemplateItem | null {
  if (!isJsonObject(v)) return null;
  const itemRef = v[FI.itemRef];
  const kind = v[FI.kind];
  const runRef = v[FI.runRef];
  const dayOffset = v[FI.dayOffset];
  const startMin = v[FI.startMin];
  const endMin = v[FI.endMin];
  const plannedHeadcount = v[FI.plannedHeadcount];
  const nodeId = v[FI.nodeId];
  const nodeName = v[FI.nodeName];
  const productId = v[FI.productId];
  const productName = v[FI.productName];
  const operatorId = v[FI.operatorId];
  const operatorName = v[FI.operatorName];
  if (
    !isStr(itemRef) ||
    (kind !== "run" && kind !== "assignment") ||
    !isStrOrNull(runRef) ||
    !isNum(dayOffset) ||
    !isNum(startMin) ||
    !isNum(endMin) ||
    !isNumOrNull(plannedHeadcount) ||
    !isStr(nodeId) ||
    !isStrOrNull(nodeName) ||
    !isStrOrNull(productId) ||
    !isStrOrNull(productName) ||
    !isStrOrNull(operatorId) ||
    !isStrOrNull(operatorName)
  ) {
    return null;
  }
  return {
    itemRef,
    kind,
    runRef,
    dayOffset,
    startMin,
    endMin,
    plannedHeadcount,
    nodeId,
    nodeName,
    productId,
    productName,
    operatorId,
    operatorName,
  };
}

function parseTemplateItemList(v: Json): WeekTemplateItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: WeekTemplateItem[] = [];
  for (const item of v) {
    const parsed = parseTemplateItem(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** A Date at midnight UTC -> the `YYYY-MM-DD` a Postgres `date` argument takes. */
function toDateArg(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------------------
 * The wrappers.
 * ------------------------------------------------------------------------- */

/** `list_week_templates(p_plant_id)`. Readable by anyone who can read the plant. */
export async function listWeekTemplates(plantId: string): Promise<WeekTemplate[]> {
  const { data, error } = await supabase.rpc("list_week_templates", { p_plant_id: plantId });
  if (error) throw toSchedulerError(error);
  const parsed = parseTemplateList(data);
  if (parsed === null) {
    throw shapeMismatch(
      "list_week_templates",
      "expected an array of WeekTemplate (see weekTemplates.ts)",
    );
  }
  return parsed;
}

/**
 * `list_week_template_items(p_template_id)` (migration 0075, R-356 surface):
 * the read-only contents of one template's snapshot, one row per run/
 * assignment item. Readable by anyone who can read the plant — the same gate
 * `listWeekTemplates` uses — not gated on administering.
 *
 * ⚠️ `tsc` IS INCONCLUSIVE ON THIS FILE UNTIL `npm run db:types` HAS RUN after
 * migration 0075 lands (CLAUDE.md §4): `list_week_template_items` is typed
 * against `database.types.ts`, which does not know it until then.
 */
export async function listWeekTemplateItems(templateId: string): Promise<WeekTemplateItem[]> {
  const { data, error } = await supabase.rpc("list_week_template_items", {
    p_template_id: templateId,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseTemplateItemList(data);
  if (parsed === null) {
    throw shapeMismatch(
      "list_week_template_items",
      "expected an array of WeekTemplateItem (see weekTemplates.ts)",
    );
  }
  return parsed;
}

/**
 * `save_week_template(p_plant_id, p_source_start, p_name)`. Gated on placing:
 * an admin or a supervisor who can place on the plant may save.
 */
export async function saveWeekTemplate(input: {
  plantId: string;
  sourceStart: Date;
  name: string;
}): Promise<WeekTemplate> {
  const { data, error } = await supabase.rpc("save_week_template", {
    p_plant_id: input.plantId,
    p_source_start: toDateArg(input.sourceStart),
    p_name: input.name,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseTemplate(data);
  if (parsed === null) {
    throw shapeMismatch(
      "save_week_template",
      "expected a WeekTemplate object (see weekTemplates.ts)",
    );
  }
  return parsed;
}

/** `rename_week_template(p_template_id, p_name)`. Admins of the plant only. */
export async function renameWeekTemplate(templateId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc("rename_week_template", {
    p_template_id: templateId,
    p_name: name,
  });
  if (error) throw toSchedulerError(error);
}

/** `delete_week_template(p_template_id)`. Admins of the plant only. */
export async function deleteWeekTemplate(templateId: string): Promise<void> {
  const { error } = await supabase.rpc("delete_week_template", { p_template_id: templateId });
  if (error) throw toSchedulerError(error);
}
