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
 * Dependency-free at runtime apart from `./csv` and `./importView` (types only
 * from `@/lib/api`), so it runs under `node --experimental-strip-types` and
 * `src/test/absenceImport.test.ts` covers it without a network.
 */
import type { AbsenceRecord, OperatorRecord } from "@/lib/api";
import type { AbsenceImportRow } from "@/lib/api";
import type { CsvError, CsvTable } from "./csv";
import type { FieldDef, ImportView } from "./importView";

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
}

const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  externalId: ["import id", "import_id", "external_id", "external id", "id", "source id"],
  employeeRef: ["employee ref", "employee id", "emp ref", "emp id", "badge", "payroll", "ref no"],
  displayName: ["name", "full name", "display name", "person", "operator"],
  from: ["from", "start", "start date", "from date", "begins", "first day"],
  to: ["to", "end", "end date", "to date", "ends", "last day", "until"],
  reason: ["reason", "type", "note", "notes", "why", "category"],
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
];

export const ABSENCE_TEMPLATE: {
  headers: readonly string[];
  example: readonly string[];
  legend: ReadonlyArray<{ column: string; means: string }>;
} = {
  headers: ["Import ID", "Employee ref", "Name", "From", "To", "Reason"],
  example: ["EXT-100", "EMP-100", "Jane Smith", "2026-09-14", "2026-09-18", "Annual leave"],
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
  ],
};

/* ===========================================================================
 * §2. The plan.
 * ======================================================================== */

export type RowOutcome =
  | {
      kind: "insert";
      operatorId: string;
      from: string;
      to: string;
      reason: string;
      externalId: string;
    }
  | {
      kind: "update";
      operatorId: string;
      from: string;
      to: string;
      reason: string;
      externalId: string;
    }
  | { kind: "error"; messages: string[] };

export interface PlannedRow {
  line: number;
  values: { person: string; from: string; to: string; reason: string };
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
    const line = idx + 2; // +1 for 0-based, +1 for the header row
    const person = externalId || employeeRef || displayName;
    const values = { person, from, to, reason };
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
      outcome: { kind, operatorId: op.id, from, to, reason, externalId: absenceExternalId },
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
      cells: [r.values.person, r.values.from, r.values.to, r.values.reason],
      kind: r.outcome.kind,
      messages: r.outcome.kind === "error" ? r.outcome.messages : [],
    })),
  };
}
