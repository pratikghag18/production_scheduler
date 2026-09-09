/**
 * absenceImport.ts — the PLAN for importing absences: who is away, between which
 * two dates, and why (R-357). A JOIN import, like `certificationImport.ts` — each
 * row names a PERSON and records a date range against them — so it is built in
 * that shape: detect columns, judge each row to insert / update / error as pure
 * data, and leave the writing to `import_absences` via `applyAbsenceImport`
 * (`src/lib/api/imports.ts`).
 *
 * ⭐ THE PERSON IS MATCHED THE WAY THE OPERATOR AND CERTIFICATION IMPORTS MATCH
 * ONE: by IMPORT ID first (operators.external_id, org-wide unique — the stable
 * handle a re-upload stays idempotent on), else EMPLOYEE REF, else NAME. Employee
 * ref and name carry NO uniqueness (the seed says so), so a value that matches
 * more than one person is an ERROR, not a guess — certifying the wrong person's
 * leave is worse than refusing the row.
 *
 * ⭐ THE ABSENCE'S OWN external_id IS DERIVED, `<person handle>:<from>`, so a
 * re-upload of the same sheet updates the same rows in place rather than adding
 * duplicates — the idempotency `operators.external_id` gives people, one level
 * down. `import_absences` upserts on it; the plan previews insert-vs-update by
 * looking for that id among the absences already recorded.
 *
 * ⭐⭐ R-359 -- AN IMPORTED ABSENCE CAN BE PART OF A DAY, AND THE HARD PART IS
 * THE CLOCK, NOT THE COLUMN. Typing an absence in learned about hours in
 * migration 0069; this sheet did not, so a morning-only appointment arriving by
 * CSV was stored as the WHOLE DAY OFF. Nothing was refused and nothing looked
 * wrong -- it was simply more absence than the truth, and someone had to find it
 * and fix it by hand. The promise from session 85 is that absence is BOTH typed
 * in and imported.
 *
 * ⛔ "09:00" IS NOT A TIME UNTIL YOU KNOW WHOSE CLOCK IT IS. The database stores
 * an instant; the sheet holds a wall-clock reading somebody typed meaning nine
 * o'clock at THEIR plant. So this planner is handed `zoneFor`, and the zone it
 * asks for is the ABSENT PERSON'S OWN plant (R-359 decision 4) -- NOT the
 * reader's plant filter, and not one zone for the whole file. A sheet from HR
 * routinely mixes plants, and reading Ana's 09:00 on the plant the READER
 * happens to be filtered to would silently shift her absence by the offset
 * between them. Per person, or the hours are a guess.
 *
 * ⚠️ AND THE ROW RULES ARE THE SERVER'S, TRANSCRIBED (migration 0073, which took
 * them from `set_absence`): both times or neither, the end after the start, and
 * a part-day absence is a SINGLE day. They are re-checked here so the preview
 * refuses what the server would refuse, rather than showing a row as fine and
 * having it come back failed -- the standing rule that a screen must decide by
 * the same test the server runs.
 *
 * Dependency-free at runtime apart from `./csv`, `./importView` and the pure
 * `zonedTimeToInstant` (types only from `@/lib/api`), so it runs under
 * `node --experimental-strip-types` and `src/test/absenceImport.test.ts` covers
 * it without a network.
 */
import type { AbsenceRecord, OperatorRecord } from "@/lib/api";
import type { AbsenceImportRow } from "@/lib/api";
import type { CsvError, CsvTable } from "./csv";
import type { FieldDef, ImportView } from "./importView";
import { zonedTimeToInstant } from "@/lib/format/timezones";

/* ===========================================================================
 * §1. Columns.
 * ======================================================================== */

export interface ColumnMap {
  externalId: string | null;
  employeeRef: string | null;
  displayName: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  /** R-359: optional part-day hours. Mapped together or not at all. */
  fromTime: string | null;
  toTime: string | null;
}

const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  externalId: ["import id", "import_id", "external_id", "external id", "id", "source id"],
  employeeRef: ["employee ref", "employee id", "emp ref", "emp id", "badge", "payroll", "ref no"],
  displayName: ["name", "full name", "display name", "person", "operator"],
  from: ["from", "start", "start date", "from date", "begins", "first day"],
  to: ["to", "end", "end date", "to date", "ends", "last day", "until"],
  reason: ["reason", "type", "note", "notes", "why", "category"],
  // R-359. Deliberately NOT "start"/"end" -- those are already the `from`/`to`
  // DATE aliases above, and `find` takes the first header that matches, so a
  // sheet with a "Start" column would have had its date column stolen by the
  // time column. Every alias here says "time" or is unambiguous.
  fromTime: ["from time", "start time", "time from", "starts at", "from_time", "start_time"],
  toTime: ["to time", "end time", "time to", "ends at", "to_time", "end_time", "until time"],
};

export function detectColumns(headerKeys: readonly string[]): ColumnMap {
  const find = (aliases: readonly string[]): string | null =>
    headerKeys.find((h) => aliases.includes(h)) ?? null;
  return {
    externalId: find(ALIASES.externalId),
    employeeRef: find(ALIASES.employeeRef),
    displayName: find(ALIASES.displayName),
    from: find(ALIASES.from),
    to: find(ALIASES.to),
    reason: find(ALIASES.reason),
    fromTime: find(ALIASES.fromTime),
    toTime: find(ALIASES.toTime),
  };
}

/** The mappable columns, in the order the wizard shows them. */
export const ABSENCE_FIELDS: FieldDef[] = [
  { key: "externalId", label: "Import ID", required: false },
  { key: "employeeRef", label: "Employee ref", required: false },
  { key: "displayName", label: "Name", required: false },
  { key: "from", label: "From", required: true },
  { key: "to", label: "To", required: true },
  { key: "reason", label: "Reason", required: true },
  // R-359. Optional: a sheet with neither column is every sheet that worked
  // before this landed, and it still means "away the whole day".
  { key: "fromTime", label: "From time", required: false },
  { key: "toTime", label: "To time", required: false },
];

export const ABSENCE_TEMPLATE: {
  headers: readonly string[];
  example: readonly string[];
  legend: ReadonlyArray<{ column: string; means: string }>;
} = {
  headers: ["Import ID", "Employee ref", "Name", "From", "To", "Reason", "From time", "To time"],
  // R-359: the example is a WHOLE-DAY row with the time cells left empty, which
  // is what most rows are and what the two columns must be safe to leave blank.
  example: ["EXT-100", "EMP-100", "Jane Smith", "2026-09-14", "2026-09-18", "Annual leave", "", ""],
  legend: [
    {
      column: "Import ID",
      means: "your system's id for the person, if you have one — matched first (optional)",
    },
    { column: "Employee ref", means: "their payroll or badge number — matched next (optional)" },
    { column: "Name", means: "their name — matched last, and only if it is unique (optional)" },
    { column: "From", means: "the first day away, YYYY-MM-DD (required)" },
    {
      column: "To",
      means: "the last day away, YYYY-MM-DD; the same as From for a single day (required)",
    },
    {
      column: "Reason",
      means: "why — free text, e.g. Sick, Annual leave, Jury service (required)",
    },
    {
      column: "From time",
      means:
        "for part of a day only: the time they go, HH:MM on a 24-hour clock — leave blank for a whole day (optional)",
    },
    {
      column: "To time",
      means:
        "for part of a day only: the time they are back, HH:MM — fill both time columns or neither, and From and To must be the same date (optional)",
    },
  ],
};

/* ===========================================================================
 * §2. The plan.
 * ======================================================================== */

/** R-359: the resolved part-day window, ISO instants, present together or not
 *  at all -- the same optionality the server's payload and `AbsenceHit` use. */
interface PartDay {
  startsAt?: string;
  endsAt?: string;
}

export type RowOutcome =
  | ({
      kind: "insert";
      operatorId: string;
      from: string;
      to: string;
      reason: string;
      externalId: string;
    } & PartDay)
  | ({
      kind: "update";
      operatorId: string;
      from: string;
      to: string;
      reason: string;
      externalId: string;
    } & PartDay)
  | { kind: "error"; messages: string[] };

export interface PlannedRow {
  line: number;
  values: {
    person: string;
    from: string;
    to: string;
    reason: string;
    /** R-359: as typed in the sheet, for the preview. Empty when not mapped. */
    fromTime: string;
    toTime: string;
  };
  outcome: RowOutcome;
}

export interface ImportPlan {
  rows: readonly PlannedRow[];
  counts: { insert: number; update: number; error: number };
  fileErrors: readonly CsvError[];
  /** Required-to-map columns the header did not map (from / to / reason). */
  missingRequired: readonly ("from" | "to" | "reason")[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in `YYYY-MM-DD`, checked at explicit UTC (no naive parse). */
function isValidDay(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * R-359. A wall-clock reading from the sheet, as hours and minutes, or null.
 *
 * Accepts `9:00`, `09:00` and `09:00:00` (a spreadsheet exporting a time cell
 * usually writes seconds), and nothing else -- no `9am`, no `0900`. A format
 * this planner cannot read is an ERROR on the row, never a guess: guessing
 * wrong writes an absence at a time the person is actually working.
 */
const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

function parseClock(s: string): { h: number; mi: number } | null {
  const m = CLOCK.exec(s);
  if (m === null) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** `YYYY-MM-DD` to its three numbers. Only called on an already-valid day. */
function ymd(day: string): { y: number; mo: number; d: number } {
  return {
    y: Number(day.slice(0, 4)),
    mo: Number(day.slice(5, 7)),
    d: Number(day.slice(8, 10)),
  };
}

/** The person's stable handle for the derived absence id: their import id, else their row id. */
function personHandle(op: OperatorRecord): string {
  return op.externalId !== null && op.externalId !== "" ? op.externalId : op.id;
}

/**
 * Build the plan. Never throws.
 *
 * @param table     the parsed CSV, from `parseCsvTable`.
 * @param operators every operator the reader can see (to resolve the person).
 * @param absences  every absence already recorded (to preview insert vs update).
 * @param columns   the column map (from `detectColumns`, possibly overridden).
 */
export function planAbsenceImport(
  table: CsvTable,
  operators: readonly OperatorRecord[],
  absences: readonly AbsenceRecord[],
  columns: ColumnMap,
  /**
   * R-359: which clock a row's times are read in -- the ABSENT PERSON'S own
   * plant zone, not the reader's filter (decision 4). Called once per part-day
   * row, after the person is resolved, so it never has to answer for a row that
   * is not going to be written anyway.
   *
   * ⚠️ OPTIONAL, AND ITS ABSENCE IS NOT A LICENCE TO GUESS. A caller that has
   * not resolved zones (or a row whose person's zone it does not know, which is
   * what a `null` answer means) cannot have its hours placed on the timeline at
   * all, so such a row is an ERROR rather than a whole-day fallback -- silently
   * widening a two-hour appointment to a whole day is the bug this piece exists
   * to close. Omitting `zoneFor` entirely is therefore only safe for a sheet
   * with no time columns, which is exactly how every existing caller and test
   * uses it.
   */
  zoneFor?: (op: OperatorRecord) => string | null,
): ImportPlan {
  const missingRequired: ("from" | "to" | "reason")[] = [];
  if (columns.from === null) missingRequired.push("from");
  if (columns.to === null) missingRequired.push("to");
  if (columns.reason === null) missingRequired.push("reason");

  // Person indexes. external_id is unique; the other two may collide, so they
  // map to a COUNT plus the single match, and a collision is an error not a pick.
  const byExternalId = new Map<string, OperatorRecord>();
  const byEmployeeRef = new Map<string, OperatorRecord[]>();
  const byDisplayName = new Map<string, OperatorRecord[]>();
  for (const op of operators) {
    if (op.externalId !== null && op.externalId !== "") byExternalId.set(op.externalId, op);
    if (op.employeeRef !== null && op.employeeRef !== "") {
      const key = op.employeeRef.trim().toLowerCase();
      (byEmployeeRef.get(key) ?? byEmployeeRef.set(key, []).get(key)!).push(op);
    }
    const nameKey = op.displayName.trim().toLowerCase();
    (byDisplayName.get(nameKey) ?? byDisplayName.set(nameKey, []).get(nameKey)!).push(op);
  }
  const existingExternalIds = new Set(
    absences.map((a) => a.externalId).filter((x): x is string => x !== null),
  );

  const cell = (row: Record<string, string>, key: string | null): string =>
    key === null ? "" : (row[key] ?? "").trim();

  const rows: PlannedRow[] = [];
  let insert = 0;
  let update = 0;
  let error = 0;

  table.rows.forEach((row, idx) => {
    const externalId = cell(row, columns.externalId);
    const employeeRef = cell(row, columns.employeeRef);
    const displayName = cell(row, columns.displayName);
    const from = cell(row, columns.from);
    const to = cell(row, columns.to);
    const reason = cell(row, columns.reason);
    const fromTime = cell(row, columns.fromTime);
    const toTime = cell(row, columns.toTime);
    const line = idx + 2; // +1 for 0-based, +1 for the header row
    const person = externalId || employeeRef || displayName;
    const values = { person, from, to, reason, fromTime, toTime };
    const messages: string[] = [];

    // Resolve the person: import id, then employee ref, then name.
    let op: OperatorRecord | null = null;
    if (externalId !== "") {
      op = byExternalId.get(externalId) ?? null;
      if (op === null) messages.push(`no person with import id "${externalId}" that you can see`);
    } else if (employeeRef !== "") {
      const hits = byEmployeeRef.get(employeeRef.toLowerCase()) ?? [];
      if (hits.length === 0)
        messages.push(`no person with employee ref "${employeeRef}" that you can see`);
      else if (hits.length > 1)
        messages.push(`the employee ref "${employeeRef}" matches more than one person`);
      else op = hits[0];
    } else if (displayName !== "") {
      const hits = byDisplayName.get(displayName.toLowerCase()) ?? [];
      if (hits.length === 0) messages.push(`no person named "${displayName}" that you can see`);
      else if (hits.length > 1)
        messages.push(
          `the name "${displayName}" matches more than one person — use an import id or employee ref`,
        );
      else op = hits[0];
    } else {
      messages.push("a person is required — give an import id, an employee ref or a name");
    }

    // Dates and reason.
    if (from === "") messages.push("a start date is required");
    else if (!isValidDay(from)) messages.push(`"${from}" is not a date (use YYYY-MM-DD)`);
    if (to === "") messages.push("an end date is required");
    else if (!isValidDay(to)) messages.push(`"${to}" is not a date (use YYYY-MM-DD)`);
    if (from !== "" && to !== "" && isValidDay(from) && isValidDay(to) && to < from) {
      messages.push("the end date is before the start date");
    }
    if (reason === "") messages.push("a reason is required");

    /*
     * R-359, the part-day window. These are migration 0073's rules, which are
     * `set_absence`'s rules, checked here so the PREVIEW refuses exactly what
     * the server would refuse rather than showing a row as fine and having it
     * come back failed.
     *
     * ⛔ THE ORDER MATTERS AND IT IS THE SERVER'S ORDER: both-or-neither, then
     * readable, then end-after-start, then single-day. A row that trips the
     * first rule is not also told its times are unreadable.
     */
    let partDay: PartDay = {};
    const hasFromTime = fromTime !== "";
    const hasToTime = toTime !== "";
    if (hasFromTime !== hasToTime) {
      messages.push("a part-day absence needs both a start and an end time");
    } else if (hasFromTime && hasToTime) {
      const st = parseClock(fromTime);
      const et = parseClock(toTime);
      if (st === null) messages.push(`"${fromTime}" is not a time (use HH:MM)`);
      if (et === null) messages.push(`"${toTime}" is not a time (use HH:MM)`);
      if (from !== to) {
        messages.push("a part-day absence is a single day — From and To must be the same date");
      }
      if (st !== null && et !== null && isValidDay(from) && from === to) {
        // The person must be resolved before their zone can be asked for, so
        // this runs only once `op` is known; a row with no person is already an
        // error and never reaches the write.
        const zone = op === null ? null : (zoneFor?.(op) ?? null);
        if (zone === null) {
          messages.push(
            "this row has times but the plant whose clock they are read in is not known — remove the time columns to record it as a whole day",
          );
        } else {
          const d = ymd(from);
          const startsAt = zonedTimeToInstant(zone, d.y, d.mo, d.d, st.h, st.mi).toISOString();
          const endsAt = zonedTimeToInstant(zone, d.y, d.mo, d.d, et.h, et.mi).toISOString();
          // Compared as INSTANTS, the way the server compares them -- so a
          // clock-change day is judged on real elapsed time, not on the digits.
          if (endsAt <= startsAt) {
            messages.push("the end time is not after the start time");
          } else {
            partDay = { startsAt, endsAt };
          }
        }
      }
    }

    if (messages.length > 0 || op === null) {
      rows.push({
        line,
        values,
        outcome: {
          kind: "error",
          messages: messages.length > 0 ? messages : ["the row could not be read"],
        },
      });
      error += 1;
      return;
    }

    const absenceExternalId = `${personHandle(op)}:${from}`;
    const kind: "insert" | "update" = existingExternalIds.has(absenceExternalId)
      ? "update"
      : "insert";
    rows.push({
      line,
      values,
      outcome: {
        kind,
        operatorId: op.id,
        from,
        to,
        reason,
        externalId: absenceExternalId,
        ...partDay,
      },
    });
    if (kind === "insert") insert += 1;
    else update += 1;
  });

  return { rows, counts: { insert, update, error }, fileErrors: table.errors, missingRequired };
}

/** The resolved rows a plan would write, for `importAbsences`. */
export function planToImportRows(plan: ImportPlan): AbsenceImportRow[] {
  const out: AbsenceImportRow[] = [];
  for (const r of plan.rows) {
    if (r.outcome.kind === "error") continue;
    out.push({
      line: r.line,
      operatorId: r.outcome.operatorId,
      from: r.outcome.from,
      to: r.outcome.to,
      reason: r.outcome.reason,
      externalId: r.outcome.externalId,
      // R-359: forwarded as a pair, absent on a whole-day row.
      ...(r.outcome.startsAt !== undefined && r.outcome.endsAt !== undefined
        ? { startsAt: r.outcome.startsAt, endsAt: r.outcome.endsAt }
        : {}),
    });
  }
  return out;
}

/* ===========================================================================
 * §3. The generic VIEW — flatten the plan to what `ImportWizard` draws.
 * ======================================================================== */

export function absencePlanToView(plan: ImportPlan): ImportView {
  return {
    counts: { ...plan.counts },
    fileErrors: plan.fileErrors.map((e) => ({ line: e.line, message: e.message })),
    missingRequired: plan.missingRequired.map((k) =>
      k === "from" ? "From" : k === "to" ? "To" : "Reason",
    ),
    rows: plan.rows.map((r) => ({
      line: r.line,
      cells: [
        r.values.person,
        r.values.from,
        r.values.to,
        r.values.reason,
        r.values.fromTime,
        r.values.toTime,
      ],
      kind: r.outcome.kind,
      messages: r.outcome.kind === "error" ? r.outcome.messages : [],
    })),
  };
}
