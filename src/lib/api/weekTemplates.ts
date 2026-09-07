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
