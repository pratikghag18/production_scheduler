/**
 * trainingImport.ts — turn a parsed CSV grid into a PLAN of what an import would
 * do to the TRAININGS CATALOGUE, so the wizard can show it before it happens.
 *
 * ⭐ THE TRAININGS TWIN OF `operatorImport.ts` / `productImport.ts`. The wizard is
 * "choose, preview, fix, apply", and this module is the PREVIEW half: it decides,
 * per row, whether the import would INSERT a new training TYPE (Forklift,
 * Welding…), leave one that already exists ALONE, or REFUSE the row and why — as
 * pure data a test can check and a screen can render, never as a side effect.
 * Applying the plan is `src/lib/api/imports.ts`; this only describes it.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE MATCH KEY IS (name, owning-plant), AND THAT IS THE WHOLE KEY. A
 * training is unique per `(org_id, site_node_id, name)` — 0031: two plants may
 * each hold a "Forklift", one plant may not hold it twice. A supervisor's CSV is
 * therefore just a training NAME and a PLANT, and those two together are the
 * handle. Matching NEVER uses the document number: it is a settable ATTRIBUTE the
 * import can record, not a second key.
 *
 * ⭐ THE OPTIONAL "DOCUMENT NUMBER" COLUMN carries the training's own document
 * number (`skills.external_id`, nullable, unique per owner). It is not part of the
 * match key — a row is still matched by (name, plant). Where present it is
 * RECORDED: set on the new training when the row inserts, and set on the existing
 * training when the row updates and the number DIFFERS from what it already has (a
 * blank leaves the existing number alone, the same way an update never re-assigns
 * a plant the training already owns). Server uniqueness is the server's job — this
 * only catches an author mistake before it gets there: two rows handing the SAME
 * document number to trainings on the SAME plant are both refused.
 *
 * THE RULES, in the order a row is judged:
 *   1. A row whose plant is blank -> ERROR ("a plant is required"). Unlike a
 *      person's update, EVERY training row needs an owner: `skills.site_node_id`
 *      is NOT NULL, and the owner is half the match key, so a row cannot even be
 *      matched without one.
 *   2. A row whose plant names nothing the reader can see -> ERROR.
 *   3. Two rows in one file with the SAME (name, plant) are BOTH errors: an
 *      import that silently let the last one win would make the outcome depend on
 *      row order. The same is true of two rows handing the SAME document number to
 *      trainings on the SAME plant — a within-file clash the server would refuse.
 *   4. A row whose (name, plant) does NOT already exist -> INSERT (create the
 *      training, carrying the document number when the row gives one).
 *   5. A row whose (name, plant) ALREADY exists -> "update". The training itself
 *      is left alone (apply does NOT touch its `active` flag), but where the row
 *      gives a document number that DIFFERS from the one the training already
 *      carries, the number is set. A row whose number is unchanged, or blank, is a
 *      pure NO-OP — the wizard's "X to update" still reads as "X already there".
 *
 * Dependency-free at runtime apart from `./csv`, so this runs under
 * `node --experimental-strip-types` and `src/test/trainingImport.test.ts` covers
 * it without a network.
 */
import type { SkillRecord } from "@/lib/api";
import type { CsvError, CsvTable } from "./csv";
import type { FieldDef, ImportView } from "./importView";

/* ===========================================================================
 * §1. Column mapping. A header is matched case-insensitively against a set of
 * common aliases, so "Training name", "Course" and "skill" all find the name
 * column. The wizard lets a human override any of these; this only proposes.
 * ======================================================================== */

/** Which normalised header key holds each field. `null` = the column is absent. */
export interface ColumnMap {
  name: string | null;
  plant: string | null;
  documentNumber: string | null;
}

const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  // ⭐ THE FRIENDLY, SELF-EXPLANATORY NAME IS FIRST in each list, so it is what
  // the downloadable template writes (see TRAINING_TEMPLATE) — a supervisor
  // opening the CSV a week later reads "Training name", not a terse key. The
  // terse forms stay so a hand-edited header still auto-detects.
  name: ["training name", "name", "training", "course", "skill"],
  plant: ["plant", "site", "location"],
  documentNumber: ["document number", "doc number", "doc no", "training number", "document no"],
};

/**
 * Propose a column map from the header. First alias hit wins per field; a field
 * with no matching header comes back `null` (the wizard then asks).
 */
export function detectColumns(headerKeys: readonly string[]): ColumnMap {
  const find = (aliases: readonly string[]): string | null =>
    headerKeys.find((h) => aliases.includes(h)) ?? null;
  return {
    name: find(ALIASES.name),
    plant: find(ALIASES.plant),
    documentNumber: find(ALIASES.documentNumber),
  };
}

/**
 * The downloadable "model CSV" for trainings: a plain-English header row, one
 * example row, and a `legend` explaining what each column means.
 *
 * ⭐ THE HEADERS ARE SELF-EXPLANATORY, and each one is a `detectColumns` alias
 * (its lower-cased form is first in `ALIASES` above), so the guided path still
 * auto-detects; case `M1` in the tests pins that every template header maps to
 * the field it should. Name and plant are required; the document number is
 * optional — the `legend` spells that out.
 */
export const TRAINING_TEMPLATE: {
  headers: readonly string[];
  example: readonly string[];
  legend: ReadonlyArray<{ column: string; means: string }>;
} = {
  headers: ["Training name", "Plant", "Document number"],
  example: ["Forklift", "Plant A", "DOC-100"],
  legend: [
    {
      column: "Training name",
      means: "the training type to add, e.g. Forklift or Welding (required)",
    },
    { column: "Plant", means: "which plant owns this training (required)" },
    {
      column: "Document number",
      means: "the training's document number, if it has one (optional)",
    },
  ],
};

/* ===========================================================================
 * §2. The plan.
 * ======================================================================== */

/** A plant a training can belong to — a root the reader can see. */
export interface ImportPlant {
  id: string;
  name: string;
}

/**
 * ⭐ Shape validation for a training name: non-blank after trim, and not
 * absurdly long. The single source of truth for the max, so the test and the
 * message cannot drift. Trims with plain `.trim()`, matching every other write.
 */
export const TRAINING_NAME_MAX_LENGTH = 120;

export type RowOutcome =
  | {
      kind: "insert";
      name: string;
      /** Required — `site_node_id` is NOT NULL; resolved from the plant column. */
      plantNodeId: string;
      /** The training's document number to record, or `null` when the row is blank. */
      documentNumber: string | null;
    }
  | {
      kind: "update";
      /** The training that already exists at (name, plant). */
      skillId: string;
      name: string;
      /**
       * The document number to set on the existing training, or `null` for a
       * pure NO-OP (the row is blank, or its number already matches). A non-null
       * value here means apply calls `setSkillDocumentNumber`; the training's
       * `active` flag is never touched.
       */
      documentNumber: string | null;
    }
  | { kind: "error"; messages: string[] };

export interface PlannedRow {
  /** 1-based source line, for the wizard to point a human at. */
  line: number;
  /** The mapped, trimmed values, for display beside the outcome. */
  values: { name: string; plant: string; documentNumber: string };
  outcome: RowOutcome;
}

export interface ImportPlan {
  rows: readonly PlannedRow[];
  counts: { insert: number; update: number; error: number };
  /** Parse-level problems (a malformed quote, a short row) — from `parseCsvTable`. */
  fileErrors: readonly CsvError[];
  /** The REQUIRED-TO-MAP columns the header did not map. */
  missingRequired: readonly ("name" | "plant")[];
}

/** Composite key for (name, owning-plant): case-folded name + resolved node id. */
function matchKey(nameLower: string, plantNodeId: string): string {
  return `${nameLower} ${plantNodeId}`;
}

/**
 * Build the plan. Never throws.
 *
 * @param table    the parsed CSV (header + rows), from `parseCsvTable`.
 * @param existing every training the reader can see (`useOperatorsAdmin().skills`).
 * @param columns  the column map (from `detectColumns`, possibly overridden).
 * @param plants   the plants a plant name can resolve to (readable roots).
 */
export function planTrainingImport(
  table: CsvTable,
  existing: readonly SkillRecord[],
  columns: ColumnMap,
  plants: readonly ImportPlant[],
): ImportPlan {
  // Both columns are REQUIRED-TO-MAP: a training must have a name and, unlike a
  // person's update, EVERY row needs an owner (the owner is half the match key).
  const missingRequired: ("name" | "plant")[] = [];
  if (columns.name === null) missingRequired.push("name");
  if (columns.plant === null) missingRequired.push("plant");

  // Index what already exists by (name, owning-plant), so matching is O(1).
  const bySkillKey = new Map<string, SkillRecord>();
  for (const sk of existing) {
    bySkillKey.set(matchKey(sk.name.trim().toLowerCase(), sk.siteNodeId), sk);
  }
  // Plant names, case-folded, for the plant column.
  const plantByName = new Map<string, ImportPlant>();
  for (const pl of plants) plantByName.set(pl.name.trim().toLowerCase(), pl);

  const cell = (row: Record<string, string>, key: string | null): string =>
    key === null ? "" : (row[key] ?? "").trim();

  // First pass: count the (name, plant) keys this FILE uses, to catch within-file
  // collisions (rule 3) — a duplicate must fail BOTH rows, so the count has to be
  // known before any row is judged. Only rows that resolve to a real key count;
  // a blank/unresolvable plant is already its own error. The same pass counts the
  // (document number, plant) pairs the file hands out, so two rows giving the same
  // document number to trainings on the same plant fail both — a clash the
  // per-owner unique index would refuse, caught here before it gets there.
  const fileKeyCounts = new Map<string, number>();
  const fileDocCounts = new Map<string, number>();
  for (const row of table.rows) {
    const name = cell(row, columns.name);
    const plantName = cell(row, columns.plant);
    const documentNumber = cell(row, columns.documentNumber);
    const resolved = plantName === "" ? undefined : plantByName.get(plantName.toLowerCase());
    if (resolved === undefined) continue;
    if (name !== "") {
      const key = matchKey(name.toLowerCase(), resolved.id);
      fileKeyCounts.set(key, (fileKeyCounts.get(key) ?? 0) + 1);
    }
    if (documentNumber !== "") {
      // Case-SENSITIVE: the per-owner unique index is on the exact text, so
      // "DOC-1" and "doc-1" do not clash on the server and must not here either
      // (the client only hides what the server refuses).
      const docKey = `${documentNumber} ${resolved.id}`;
      fileDocCounts.set(docKey, (fileDocCounts.get(docKey) ?? 0) + 1);
    }
  }

  const rows: PlannedRow[] = [];
  let insert = 0;
  let update = 0;
  let error = 0;

  table.rows.forEach((row, idx) => {
    const name = cell(row, columns.name);
    const plantName = cell(row, columns.plant);
    const documentNumber = cell(row, columns.documentNumber);
    const line = idx + 2; // +1 for 0-based, +1 for the header row
    const values = { name, plant: plantName, documentNumber };

    const messages: string[] = [];

    // Shape validation for the name.
    if (name === "") {
      messages.push("a training name is required");
    } else if (name.length > TRAINING_NAME_MAX_LENGTH) {
      messages.push(`a training name can be at most ${TRAINING_NAME_MAX_LENGTH} characters`);
    }

    // Resolve the owning plant (rules 1 & 2). Required on EVERY row.
    let plantNodeId: string | null = null;
    if (plantName === "") {
      messages.push("a plant is required");
    } else {
      const resolved = plantByName.get(plantName.toLowerCase());
      if (resolved === undefined) {
        messages.push(`no plant named "${plantName}" that you can see`);
      } else {
        plantNodeId = resolved.id;
      }
    }

    // Within-file collision (rule 3), only meaningful once name + plant resolved.
    if (name !== "" && plantNodeId !== null) {
      const key = matchKey(name.toLowerCase(), plantNodeId);
      if ((fileKeyCounts.get(key) ?? 0) > 1) {
        messages.push(
          `the training "${name}" is listed for that plant more than once in this file`,
        );
      }
    }

    // Within-file document-number collision (rule 3): the same document number
    // handed to two trainings on the same plant is a clash the per-owner unique
    // index would refuse. Only meaningful once the plant resolves.
    if (documentNumber !== "" && plantNodeId !== null) {
      const docKey = `${documentNumber} ${plantNodeId}`;
      if ((fileDocCounts.get(docKey) ?? 0) > 1) {
        messages.push(
          `the document number "${documentNumber}" is given to more than one training for that plant in this file`,
        );
      }
    }

    if (messages.length > 0) {
      rows.push({ line, values, outcome: { kind: "error", messages } });
      error += 1;
      return;
    }

    // "" -> no document number recorded.
    const docNumber = documentNumber === "" ? null : documentNumber;

    // plantNodeId is a real id here (name non-blank, plant resolved, no dup).
    const existingSkill = bySkillKey.get(matchKey(name.toLowerCase(), plantNodeId as string));
    if (existingSkill !== undefined) {
      // Rule 5: already there -> "update". The training itself is left alone (its
      // active flag is never touched); the document number is set ONLY when the
      // row gives one that DIFFERS from what the training already carries. A blank
      // row, or an unchanged number, is a pure no-op (documentNumber: null), the
      // same way an update never re-assigns a plant the training already owns.
      const setDoc =
        docNumber !== null && docNumber !== existingSkill.externalId ? docNumber : null;
      rows.push({
        line,
        values,
        outcome: { kind: "update", skillId: existingSkill.id, name, documentNumber: setDoc },
      });
      update += 1;
    } else {
      // Rule 4: new (name, plant) -> insert, carrying the document number if any.
      rows.push({
        line,
        values,
        outcome: {
          kind: "insert",
          name,
          plantNodeId: plantNodeId as string,
          documentNumber: docNumber,
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
 * §3. The generic VIEW — flatten the trainings plan to what `ImportWizard` draws.
 *
 * The wizard is entity-agnostic (`importView.ts`); this is the one place a
 * trainings plan becomes rows of cells + a verdict. The columns are in the same
 * order as `TRAINING_FIELDS`.
 * ======================================================================== */

/**
 * The mappable columns, in the order the wizard shows them. Name and plant are
 * required; the document number is optional.
 */
export const TRAINING_FIELDS: FieldDef[] = [
  { key: "name", label: "Training name", required: true },
  { key: "plant", label: "Plant", required: true },
  { key: "documentNumber", label: "Document number", required: false },
];

export function trainingPlanToView(plan: ImportPlan): ImportView {
  return {
    counts: { ...plan.counts },
    fileErrors: plan.fileErrors.map((e) => ({ line: e.line, message: e.message })),
    missingRequired: plan.missingRequired.map((k) => (k === "name" ? "training name" : "plant")),
    rows: plan.rows.map((r) => ({
      line: r.line,
      cells: [r.values.name, r.values.plant, r.values.documentNumber],
      kind: r.outcome.kind,
      messages: r.outcome.kind === "error" ? r.outcome.messages : [],
    })),
  };
}
