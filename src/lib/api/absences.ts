/**
 * absences.ts — the api surface for R-357 (migration 0066): read a plant's
 * absences over a date window, record one, remove one, and apply an import.
 *
 * Same house rules as the rest of `src/lib/api/`: `supabase.rpc` / `.from` stops
 * here, snake_case stops here, reads go through a runtime guard that returns
 * `null` on a shape mismatch rather than trusting the generated types, and a
 * PostgREST error becomes `toSchedulerError(error)`. AUTHOR-ONLY — it imports
 * `@/lib/supabase`; the logic worth testing without a network is `absenceGaps`
 * (`src/lib/absence.ts`) and the import planner (`absenceImport.ts`).
 *
 * ⭐ ONE COLUMN LIST, `ABSENCE_COLUMNS`, and every read and every test fixture is
 * built from it (CLAUDE.md section 4: a column list that appears twice is a bug
 * with a delay on it). The stored shape is a `daterange`; PostgREST hands it back
 * in its canonical `[from,upper)` text, which this file turns into the
 * day-inclusive `{ from, to }` the screen and `absenceGaps` speak.
 */
import { supabase } from "@/lib/supabase";
import { shapeMismatch, toSchedulerError } from "./errors";
import { fetchAll } from "./paging";

/** The one column list. Reads and fixtures are built from this and nothing else. */
export const ABSENCE_COLUMNS = "id, operator_id, daterange, reason, source, external_id" as const;

/** One absence, camelCase out. `from`/`to` are inclusive `YYYY-MM-DD`. */
export interface AbsenceRecord {
  id: string;
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  source: string;
  externalId: string | null;
}

/** One resolved import row, for `importAbsences` (the planner produced these). */
export interface AbsenceImportRow {
  line: number;
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  externalId: string | null;
}

/** The `{inserted, updated, failed}` envelope `import_absences` returns. */
export interface AbsenceImportResult {
  inserted: number;
  updated: number;
  failed: { line: number; message: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strOrNull(v: unknown): string | null | undefined {
  return v === null || typeof v === "string" ? (v as string | null) : undefined;
}

/** The day before a `YYYY-MM-DD`, built at explicit UTC (never a naive parse). */
function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * PostgREST returns a `daterange` in canonical `[lower,upper)` text — always
 * lower-inclusive, upper-EXCLUSIVE. The screen speaks day-inclusive `to`, so the
 * upper bound is stepped back one day. Returns `null` on any other shape so a
 * changed read is rejected, not coerced.
 */
function parseDateRangeText(v: unknown): { from: string; to: string } | null {
  if (typeof v !== "string") return null;
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(v);
  if (m === null) return null;
  return { from: m[1], to: prevDay(m[2]) };
}

export function parseAbsenceRecord(v: unknown): AbsenceRecord | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const operatorId = str(v.operator_id);
  const reason = str(v.reason);
  const source = str(v.source);
  const externalId = strOrNull(v.external_id);
  const range = parseDateRangeText(v.daterange);
  if (id === null || operatorId === null || reason === null || source === null) return null;
  if (externalId === undefined || range === null) return null;
  return { id, operatorId, from: range.from, to: range.to, reason, source, externalId };
}

/**
 * Every absence the reader can see, newest first by start date. RLS scopes the
 * rows to the people the caller may read (`absences_select`), so the panel
 * narrows to the visible plant by intersecting with its own people list rather
 * than asking the server a second, weaker question.
 */
export async function fetchAbsences(): Promise<{ absences: AbsenceRecord[]; skipped: number }> {
  const rows = await fetchAll((from, to) =>
    supabase
      .from("absences")
      .select(ABSENCE_COLUMNS)
      .order("daterange", { ascending: false })
      .order("id")
      .range(from, to),
  );
  const out: AbsenceRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = parseAbsenceRecord(row);
    if (parsed === null) skipped += 1;
    else out.push(parsed);
  }
  return { absences: out, skipped };
}

export interface SetAbsenceInput {
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  externalId?: string | null;
}

/** `set_absence` — record or (on external_id) upsert one absence. */
export async function setAbsence(input: SetAbsenceInput): Promise<AbsenceRecord> {
  const { data, error } = await supabase.rpc("set_absence", {
    p_operator_id: input.operatorId,
    p_from: input.from,
    p_to: input.to,
    p_reason: input.reason,
    // The RPC arg is optional (`p_external_id text default null`): a null
    // externalId is sent as an OMITTED arg, not a JSON null, so the server
    // falls back to its own default. `?? undefined` maps the null explicitly.
    p_external_id: input.externalId ?? undefined,
  });
  if (error) throw toSchedulerError(error);
  const parsed = parseAbsenceRecord(data);
  if (parsed === null)
    throw shapeMismatch("set_absence", "expected an absence row (see absences.ts)");
  return parsed;
}

/** `remove_absence` — delete one absence by id. */
export async function removeAbsence(id: string): Promise<void> {
  const { error } = await supabase.rpc("remove_absence", { p_id: id });
  if (error) throw toSchedulerError(error);
}

/** `import_absences` — apply resolved import rows, returning per-row outcomes. */
export async function importAbsences(
  rows: readonly AbsenceImportRow[],
): Promise<AbsenceImportResult> {
  const payload = rows.map((r) => ({
    line: r.line,
    operator_id: r.operatorId,
    from: r.from,
    to: r.to,
    reason: r.reason,
    external_id: r.externalId,
  }));
  const { data, error } = await supabase.rpc("import_absences", { p_rows: payload });
  if (error) throw toSchedulerError(error);
  const parsed = parseAbsenceImportResult(data);
  if (parsed === null) {
    throw shapeMismatch(
      "import_absences",
      "expected {inserted, updated, failed} (see absences.ts)",
    );
  }
  return parsed;
}

export function parseAbsenceImportResult(v: unknown): AbsenceImportResult | null {
  if (!isRecord(v)) return null;
  const inserted = typeof v.inserted === "number" ? v.inserted : null;
  const updated = typeof v.updated === "number" ? v.updated : null;
  if (inserted === null || updated === null || !Array.isArray(v.failed)) return null;
  const failed: { line: number; message: string }[] = [];
  for (const f of v.failed as unknown[]) {
    if (!isRecord(f)) return null;
    const line = typeof f.line === "number" ? f.line : null;
    const message = str(f.message);
    if (line === null || message === null) return null;
    failed.push({ line, message });
  }
  return { inserted, updated, failed };
}
