/**
 * absences.ts — the api surface for R-357 (migration 0066) and R-359
 * (migration 0069, part-day absences): read a plant's absences over a date
 * window, record one (whole-day or part-day), remove one, apply an import, and
 * resolve a node's own setting the way the board resolves its root's.
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
 * day-inclusive `{ from, to }` the screen and `absenceGaps` speak. `timerange`
 * (0069) is a `tstzrange` or `null`; PostgREST hands a non-null one back in the
 * canonical `["<instant>","<instant>")` text, turned into the `startsAt`/
 * `endsAt` ISO instants `AbsenceRow`/`AbsenceHit` speak — present together on a
 * part-day row, absent on a whole-day one.
 */
import { supabase } from "@/lib/supabase";
import { shapeMismatch, toSchedulerError } from "./errors";
import { fetchAll } from "./paging";

/** The one column list. Reads and fixtures are built from this and nothing else. */
export const ABSENCE_COLUMNS =
  "id, operator_id, daterange, timerange, reason, source, external_id" as const;

/**
 * One absence, camelCase out. `from`/`to` are inclusive `YYYY-MM-DD` — the
 * single day a part-day absence falls on, or the whole span of a whole-day one.
 * `startsAt`/`endsAt` (ISO instants) are present together exactly when the row
 * is a part-day absence (R-359), absent on a whole-day row.
 */
export interface AbsenceRecord {
  id: string;
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  source: string;
  externalId: string | null;
  startsAt?: string;
  endsAt?: string;
}

/** One resolved import row, for `importAbsences` (the planner produced these). */
export interface AbsenceImportRow {
  line: number;
  operatorId: string;
  from: string;
  to: string;
  reason: string;
  externalId: string | null;
  /**
   * R-359: the part-day window, as ISO instants, present together or not at
   * all. Absent on a whole-day row, which is every row a sheet without time
   * columns produces -- `import_absences` (migration 0073) reads a missing key
   * as NULL and writes the whole-day row it always did.
   *
   * ⚠️ THESE ARE INSTANTS, NOT WALL CLOCK. The CSV says "09:00" and the person
   * who typed it meant nine o'clock at THEIR plant; turning that into an
   * instant needs a zone, and the zone is the absent PERSON'S own plant
   * (R-359 decision 4), not the reader's plant filter. `planAbsenceImport`
   * does that conversion and is handed the zones -- see its own header.
   */
  startsAt?: string;
  endsAt?: string;
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

/**
 * Postgres's timestamptz TEXT output — `2027-06-10 09:00:00+00`, and also
 * `...+05:30` (a non-whole-hour zone) or `...+00.123456` (fractional
 * seconds) — turned into a `Date`, or `null` if it does not match. ⚠️ NOT a
 * plain `s.replace(" ", "T")` then `new Date(...)`: V8's ISO 8601 parser
 * rejects a bare 2-digit offset with no minutes (`+00`, not `+00:00`) as
 * Invalid Date — measured live (a part-day `set_absence` call inserted the
 * row correctly and then reported "Something went wrong" on the very same
 * response, because THIS parser threw the read away). The offset's minutes
 * are supplied (`:00`) when Postgres omits them.
 */
function parsePgTimestamptz(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(
    s,
  );
  if (m === null) return null;
  const [, date, time, offHours, offMinutes] = m;
  const d = new Date(`${date}T${time}${offHours}:${offMinutes ?? "00"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * PostgREST returns a non-null `tstzrange` in canonical text, each bound
 * quoted (timestamptz text contains a space, which Postgres's range output
 * quotes): `["2027-06-10 09:00:00+00","2027-06-10 13:00:00+00")`. `null`
 * itself is a whole-day row (0069) and is a valid, expected shape here — this
 * returns `null` for it same as for anything unparseable, and the caller
 * (`parseAbsenceRecord`) is the one place that tells "whole-day" apart from "a
 * part-day row that failed to parse" (it never reaches the latter: a
 * malformed non-null `timerange` fails the whole record instead of silently
 * reading as whole-day).
 */
function parseTimeRangeText(v: unknown): { startsAt: string; endsAt: string } | null {
  if (v === null || typeof v !== "string") return null;
  const m = /^\[\s*"?([^",]+)"?\s*,\s*"?([^",]+)"?\s*\)$/.exec(v);
  if (m === null) return null;
  const start = parsePgTimestamptz(m[1]);
  const end = parsePgTimestamptz(m[2]);
  if (start === null || end === null) return null;
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
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
  const out: AbsenceRecord = {
    id,
    operatorId,
    from: range.from,
    to: range.to,
    reason,
    source,
    externalId,
  };
  if (v.timerange !== null && v.timerange !== undefined) {
    const timerange = parseTimeRangeText(v.timerange);
    if (timerange === null) return null; // a part-day row that failed to parse: reject, never silently whole-day
    out.startsAt = timerange.startsAt;
    out.endsAt = timerange.endsAt;
  }
  return out;
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
  /**
   * R-359: the part-day window, as ISO instants already converted from
   * wall-clock ON THE CLIENT (`zonedTimeToInstant`, the person's own plant
   * zone) — this file resolves no timezone. Both present makes the row
   * part-day; both absent (the default) is a whole-day absence, unchanged.
   */
  startsAt?: string;
  endsAt?: string;
}

/** `set_absence` — record or (on external_id) upsert one absence, whole-day or
 *  (0069) part-day. */
export async function setAbsence(input: SetAbsenceInput): Promise<AbsenceRecord> {
  const { data, error } = await supabase.rpc("set_absence", {
    p_operator_id: input.operatorId,
    p_from: input.from,
    p_to: input.to,
    p_reason: input.reason,
    // The RPC args below are optional (`default null`): a null/undefined value
    // is sent as an OMITTED arg, not a JSON null, so the server falls back to
    // its own default. `?? undefined` maps a null through explicitly.
    p_external_id: input.externalId ?? undefined,
    p_starts_at: input.startsAt ?? undefined,
    p_ends_at: input.endsAt ?? undefined,
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

/** A setting `app_resolve_node_setting` knows how to answer, for the two this
 *  lane's screens need at a person's own place. */
export type ResolvableNodeSetting = "timezone" | "date_format";

/**
 * What ONE setting says AT one node — `app_resolve_node_setting` (migrations
 * 0050/0068), the same SECURITY DEFINER resolver `board_window` uses for its
 * own root, walked on the SERVER. R-359/R-360: the Operators tab's absences
 * block, and the Absences panel's own form, need a specific PERSON's plant
 * zone (and, for display, their date format) resolved from their
 * `operators.site_node_id` — which need not be a plant root (D109), so reading
 * an override off it directly the way `usePlantOverrides` reads a ROOT's would
 * silently miss an ancestor's answer, exactly DEF-0016/DEF-0017's shape. This
 * asks the server instead: the real ancestor walk happens there, never in the
 * browser (CLAUDE.md section 4's definer rule). `null` when nothing resolves
 * anywhere (an org with no company-wide value either); the caller falls back
 * through `coerceTimezone` / `coerceDateFormat`, exactly as `board_window`'s
 * own COALESCE does for its `timezone`/`date_format` keys.
 */
export async function fetchNodeSetting(
  nodeId: string,
  key: ResolvableNodeSetting,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("app_resolve_node_setting", {
    p_node_id: nodeId,
    p_key: key,
  });
  if (error) throw toSchedulerError(error);
  return typeof data === "string" ? data : null;
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
    // R-359. Sent as a PAIR or not at all: 0073 fails a row carrying one
    // without the other, deliberately, because half a window cannot be stored.
    // A whole-day row omits both keys and the function reads them as NULL.
    ...(r.startsAt !== undefined && r.endsAt !== undefined
      ? { starts_at: r.startsAt, ends_at: r.endsAt }
      : {}),
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
