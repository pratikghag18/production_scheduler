/**
 * importView.ts — the ENTITY-AGNOSTIC shape the import wizard renders, and the
 * descriptor that drives it.
 *
 * ⭐ WHY THIS EXISTS. Products import shipped first (§19.82); operators (and one
 * day the tree) import the same way — choose a CSV, map columns, preview, apply.
 * The wizard CHROME is identical; only "what a row means" differs. So the chrome
 * is one generic component (`ImportWizard`) parameterised by a per-entity
 * descriptor, and each entity's plan is mapped to the common `ImportView` below.
 * Duplicating the wizard body per entity would be the "written twice" defect at
 * component scale.
 *
 * The entity-specific PLAN types (`productImport.ts`'s `ImportPlan`,
 * `operatorImport.ts`'s) stay their own thing; the descriptor's `toView` is the
 * one place each is flattened to what the screen draws.
 */

/** One mappable field: a column the entity expects. */
export interface FieldDef {
  /** Stable key the entity's column map is keyed by. */
  key: string;
  /** Human label shown in the mapping control and the preview header. */
  label: string;
  required: boolean;
}

/** One row of the preview, already flattened for rendering. */
export interface ImportViewRow {
  /** 1-based source line, to point a human at the CSV row. */
  line: number;
  /** The mapped values in `fields` order, for the table cells. */
  cells: string[];
  kind: "insert" | "update" | "error";
  /** Non-empty only for an error row. */
  messages: string[];
}

/** Everything the wizard needs to render a preview — no entity types leak in. */
export interface ImportView {
  rows: ImportViewRow[];
  counts: { insert: number; update: number; error: number };
  fileErrors: { line: number; message: string }[];
  /** Human labels of REQUIRED columns the header did not map. */
  missingRequired: string[];
}

/** The downloadable model CSV for an entity. */
export interface ImportTemplate {
  headers: readonly string[];
  example: readonly string[];
  legend: ReadonlyArray<{ column: string; means: string }>;
}

/** True when a plan has at least one row that would write. */
export function hasWork(view: ImportView): boolean {
  return view.counts.insert + view.counts.update > 0;
}
