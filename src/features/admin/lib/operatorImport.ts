/**
 * operatorImport.ts — turn a parsed CSV grid into a PLAN of what an import would
 * do to the people list, so the wizard can show it before it happens.
 *
 * ⭐ THE PEOPLE TWIN OF `productImport.ts`. The wizard is "choose, preview, fix,
 * apply", and this module is the PREVIEW half: it decides, per row, whether the
 * import would INSERT a new person, UPDATE an existing one, or REFUSE the row and
 * why — as pure data a test can check and a screen can render, never as a side
 * effect. Applying the plan is `src/lib/api/imports.ts`; this only describes it.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE MATCH KEY IS external_id, AND IT IS THE *ONLY* MATCH KEY. Products
 * had a second one — a company-wide `sku` — so a re-upload with no import id
 * could still find its part by code. People have no such thing: `employee_ref`
 * carries NO uniqueness (two sites may reuse a badge number, and nothing in the
 * schema forbids it), so it CANNOT be a match key. `operators.external_id` is
 * `unique (org_id, external_id)`, org-wide, so it is the one stable handle the
 * source system already has — and matching on it is the ONLY thing that makes a
 * re-upload of the same export idempotent for people. A row with no external_id
 * cannot be matched to anyone, so it can only ever INSERT.
 *
 * THE RULES, in the order a row is judged:
 *   1. A row with an external_id that matches an existing person -> UPDATE it
 *      (display name and employee ref). ⚠️⚠️ THE SITE IS LEFT ALONE — re-homing a
 *      person to another plant is a sensitive act and out of scope for import v1,
 *      so an update never touches `site_node_id` and never even consults the
 *      plant column.
 *   2. A row with an external_id that matches nothing -> INSERT.
 *   3. A row with NO external_id -> INSERT (there is no way to match, so it can
 *      never update; only an external_id makes a re-upload update-in-place
 *      instead of adding a duplicate person).
 *   4. Two rows in one file that claim the same external_id are BOTH errors: an
 *      import that silently let the last one win would make the outcome depend on
 *      row order.
 *   5. ⚠️⚠️ A PLANT IS REQUIRED FOR AN INSERT. `operators.site_node_id` is NOT
 *      NULL, so a NEW person must land somewhere. The `plant` column names a
 *      readable plant (a root, by name, case-insensitively, exactly as products
 *      resolve one). An INSERT row whose plant is blank or resolves to nothing is
 *      an ERROR. An UPDATE row needs no plant — the site is left alone — so a
 *      blank plant on an update is fine, and its plant column is simply ignored.
 *
 * Dependency-free at runtime apart from `./csv`, so this runs under
 * `node --experimental-strip-types` and `src/test/operatorImport.test.ts` covers
 * it without a network.
 */
import type { OperatorRecord } from "@/lib/api";
import type { CsvError, CsvTable } from "./csv";
import type { FieldDef, ImportView } from "./importView";

/* ===========================================================================
 * §1. Column mapping. A header is matched case-insensitively against a set of
 * common aliases, so "Name", "Full Name" and "person" all find the name column.
 * The wizard lets a human override any of these; this only proposes.
 * ======================================================================== */

/** Which normalised header key holds each field. `null` = the column is absent. */
export interface ColumnMap {
  name: string | null;
  employeeRef: string | null;
  externalId: string | null;
  plant: string | null;
}

const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  // ⭐ THE FRIENDLY, SELF-EXPLANATORY NAME IS FIRST in each list, so it is what
  // the downloadable template writes (see OPERATOR_TEMPLATE) — a person opening
  // the CSV a week later reads "Name", not a terse column key. The terse forms
  // stay in the list so an HR export or a hand-edited header still auto-detects.
  name: ["name", "full name", "display name", "person", "operator"],
  employeeRef: ["employee ref", "employee id", "emp ref", "emp id", "badge", "payroll", "ref no"],
  externalId: ["import id", "import_id", "external_id", "external id", "id", "source id"],
  plant: ["plant", "site", "location", "facility"],
};

/**
 * Propose a column map from the header. First alias hit wins per field; a field
 * with no matching header comes back `null` (the wizard then asks, or leaves it
 * unmapped where the field is optional).
 */
export function detectColumns(headerKeys: readonly string[]): ColumnMap {
  const find = (aliases: readonly string[]): string | null =>
    headerKeys.find((h) => aliases.includes(h)) ?? null;
  return {
    name: find(ALIASES.name),
    employeeRef: find(ALIASES.employeeRef),
    externalId: find(ALIASES.externalId),
    plant: find(ALIASES.plant),
  };
}

/**
 * The downloadable "model CSV" for people: a plain-English header row, one
 * example row, and a `legend` explaining what each column means.
 *
 * ⭐ THE HEADERS ARE SELF-EXPLANATORY, and each one is a `detectColumns` alias
 * (its lower-cased form is first in `ALIASES` above), so the guided path still
 * auto-detects; case `M1` in the tests pins that every template header maps to
 * the field it should. Required vs optional is spelled out in the `legend`, not
 * baked into the header (a header with "(required)" in it would not auto-detect).
 */
export const OPERATOR_TEMPLATE: {
  headers: readonly string[];
  example: readonly string[];
  legend: ReadonlyArray<{ column: string; means: string }>;
} = {
  headers: ["Name", "Employee ref", "Import ID", "Plant"],
  example: ["Jane Smith", "EMP-100", "EXT-100", "Plant A"],
  legend: [
    { column: "Name", means: "the person's name (required)" },
    {
      column: "Employee ref",
      means: "your own payroll or badge number for them (optional)",
    },
    {
      column: "Import ID",
      means:
        "your own system's id for this person — lets a re-upload update them instead of adding a duplicate (optional)",
    },
    {
      column: "Plant",
      means: "which plant they belong to; required when adding a new person (optional)",
    },
  ],
};

/* ===========================================================================
 * §2. The plan.
 * ======================================================================== */

/** A plant an inserted person can belong to — a root the reader can see. */
export interface ImportPlant {
  id: string;
  name: string;
}

/**
 * ⭐ Shape validation for a person, kept here rather than reused. Products
 * borrowed `validateProductDraft`; people have no create-form validator to
 * borrow (the create form validates inline), so the one rule that matters —
 * a non-blank, not-absurdly-long name — lives here as the single source. Trims
 * with plain `.trim()`, matching every other write in this app.
 */
export const DISPLAY_NAME_MAX_LENGTH = 120;

export type RowOutcome =
  | {
      kind: "insert";
      displayName: string;
      employeeRef: string | null;
      externalId: string | null;
      /** Required for an insert (`site_node_id` is NOT NULL); resolved from the plant column. */
      plantNodeId: string;
    }
  | {
      kind: "update";
      operatorId: string;
      displayName: string;
      employeeRef: string | null;
      /** The existing person's external_id is left as-is; name/ref are the update. */
      externalId: string | null;
    }
  | { kind: "error"; messages: string[] };

export interface PlannedRow {
  /** 1-based source line, for the wizard to point a human at. */
  line: number;
  /** The mapped, trimmed values, for display beside the outcome. */
  values: { name: string; employeeRef: string; externalId: string; plant: string };
  outcome: RowOutcome;
}

export interface ImportPlan {
  rows: readonly PlannedRow[];
  counts: { insert: number; update: number; error: number };
  /** Parse-level problems (a malformed quote, a short row) — from `parseCsvTable`. */
  fileErrors: readonly CsvError[];
  /** True when the header is missing the one REQUIRED-TO-MAP column (name). */
  missingRequired: readonly "name"[];
}

/**
 * Build the plan. Never throws.
 *
 * @param table    the parsed CSV (header + rows), from `parseCsvTable`.
 * @param existing every operator the reader can see, from `fetchOperatorsAdmin`.
 * @param columns  the column map (from `detectColumns`, possibly overridden).
 * @param plants   the plants a plant name can resolve to (readable roots).
 */
export function planOperatorImport(
  table: CsvTable,
  existing: readonly OperatorRecord[],
  columns: ColumnMap,
  plants: readonly ImportPlant[],
): ImportPlan {
  // ⭐ ONLY `name` IS REQUIRED-TO-MAP. The plant is NOT — it is required per
  // INSERT ROW instead (rule 5), because an update row legitimately has no
  // plant. So the column mapping does not force it; the plan does, row by row.
  const missingRequired: "name"[] = [];
  if (columns.name === null) missingRequired.push("name");

  // Index over what already exists, so matching is O(1) per row. There is only
  // ONE index — external_id — because employee_ref carries no uniqueness and so
  // cannot be a match key.
  const byExternalId = new Map<string, OperatorRecord>();
  for (const op of existing) {
    if (op.externalId !== null) byExternalId.set(op.externalId, op);
  }
  // Plant names, case-folded, for the plant column.
  const plantByName = new Map<string, ImportPlant>();
  for (const pl of plants) plantByName.set(pl.name.trim().toLowerCase(), pl);

  // First pass: count the external_ids this FILE uses, to catch within-file
  // collisions (rule 4) — a duplicate must fail BOTH rows, so the count has to
  // be known before any row is judged.
  const fileExtCounts = new Map<string, number>();
  const cell = (row: Record<string, string>, key: string | null): string =>
    key === null ? "" : (row[key] ?? "").trim();

  for (const row of table.rows) {
    const ext = cell(row, columns.externalId);
    if (ext !== "") fileExtCounts.set(ext, (fileExtCounts.get(ext) ?? 0) + 1);
  }

  const rows: PlannedRow[] = [];
  let insert = 0;
  let update = 0;
  let error = 0;

  table.rows.forEach((row, idx) => {
    const name = cell(row, columns.name);
    const employeeRef = cell(row, columns.employeeRef);
    const externalId = cell(row, columns.externalId);
    const plantName = cell(row, columns.plant);
    const line = idx + 2; // +1 for 0-based, +1 for the header row
    const values = { name, employeeRef, externalId, plant: plantName };

    const messages: string[] = [];

    // Shape validation for the name.
    if (name === "") {
      messages.push("a name is required");
    } else if (name.length > DISPLAY_NAME_MAX_LENGTH) {
      messages.push(`a name can be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
    }

    // Within-file collision (rule 4).
    if (externalId !== "" && (fileExtCounts.get(externalId) ?? 0) > 1) {
      messages.push(`the import id "${externalId}" is used by more than one row in this file`);
    }

    // Match to an existing person (rules 1-3). external_id is the only key.
    const byExt = externalId !== "" ? (byExternalId.get(externalId) ?? null) : null;

    // Resolve the plant. ⚠️ It is only CONSULTED for an INSERT — an update
    // leaves the site alone (rule 1), so a plant on an update row is ignored and
    // never even resolved. So the requirement is enforced only when byExt is null.
    let plantNodeId: string | null = null;
    if (byExt === null) {
      if (plantName === "") {
        messages.push("a plant is required for a new person");
      } else {
        const resolved = plantByName.get(plantName.toLowerCase());
        if (resolved === undefined) {
          messages.push(`no plant named "${plantName}" that you can see`);
        } else {
          plantNodeId = resolved.id;
        }
      }
    }

    if (messages.length > 0) {
      rows.push({ line, values, outcome: { kind: "error", messages } });
      error += 1;
      return;
    }

    if (byExt !== null) {
      // Rule 1: update the matched person. ⚠️ NO plantNodeId — the site is left
      // alone; only display name and employee ref move.
      rows.push({
        line,
        values,
        outcome: {
          kind: "update",
          operatorId: byExt.id,
          displayName: name,
          employeeRef: employeeRef === "" ? null : employeeRef,
          externalId,
        },
      });
      update += 1;
    } else {
      // Rules 2 & 3: no match (a new external_id, or none at all) -> insert. The
      // plant was required and resolved above, so plantNodeId is a real id here.
      rows.push({
        line,
        values,
        outcome: {
          kind: "insert",
          displayName: name,
          employeeRef: employeeRef === "" ? null : employeeRef,
          externalId: externalId === "" ? null : externalId,
          plantNodeId: plantNodeId as string,
        },
      });
      insert += 1;
    }
  });

  return {
    rows,
    counts: { insert, update, error },
    fileErrors: table.errors,
    missingRequired,
  };
}

/* ===========================================================================
 * §3. The generic VIEW — flatten the operators plan to what `ImportWizard` draws.
 *
 * The wizard is entity-agnostic (`importView.ts`); this is the one place an
 * operators plan becomes rows of cells + a verdict. The columns are in the same
 * order as `OPERATOR_FIELDS`.
 * ======================================================================== */

/** The mappable columns, in the order the wizard shows them. */
export const OPERATOR_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", required: true },
  { key: "employeeRef", label: "Employee ref", required: false },
  { key: "externalId", label: "Import ID", required: false },
  // ⚠️ required:false — the column mapping does not force a plant. The plan
  // enforces it per-insert-row (rule 5), because an update row needs none.
  { key: "plant", label: "Plant", required: false },
];

export function operatorPlanToView(plan: ImportPlan): ImportView {
  return {
    counts: { ...plan.counts },
    fileErrors: plan.fileErrors.map((e) => ({ line: e.line, message: e.message })),
    missingRequired: plan.missingRequired.map(() => "name"),
    rows: plan.rows.map((r) => ({
      line: r.line,
      cells: [r.values.name, r.values.employeeRef, r.values.externalId, r.values.plant],
      kind: r.outcome.kind,
      messages: r.outcome.kind === "error" ? r.outcome.messages : [],
    })),
  };
}
