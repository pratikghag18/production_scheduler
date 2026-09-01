/**
 * productImport.ts — turn a parsed CSV grid into a PLAN of what an import would
 * do to the product catalogue, so the wizard can show it before it happens.
 *
 * ⭐ THE WIZARD IS "CHOOSE, PREVIEW, FIX, APPLY", AND THIS MODULE IS THE PREVIEW.
 * It decides, per row, whether the import would INSERT a new part, UPDATE an
 * existing one, or REFUSE the row and why — and it does it as pure data a test
 * can check and a screen can render, never as a side effect. Applying the plan
 * is `src/lib/api/productImport.ts`; this only describes it.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE MATCH KEY IS external_id, AND D115 IS WHY IT CAN BE. A part number is
 * company-wide (`unique (org_id, sku)`) and, since migration 0034, so is its
 * import id (`unique (org_id, external_id)`). So a re-upload of the same export
 * UPDATES rather than DUPLICATES: the external_id is the stable handle the source
 * system already has, and matching on it is what makes an import idempotent.
 * Before D115 a part was per-plant and this key would have been per-owner — the
 * whole reason the import screen was sequenced AFTER D115.
 *
 * THE RULES, in the order a row is judged:
 *   1. A row with an external_id that matches an existing part  -> UPDATE it
 *      (sku and name). ⚠️ Unless the new sku is already taken by a DIFFERENT
 *      part — a part number cannot move to another part, so that is an error.
 *   2. A row with an external_id that matches nothing           -> INSERT.
 *   3. A row with NO external_id but a sku that matches an existing part
 *      -> UPDATE that part's name (the sku is company-wide, so the same code IS
 *      the same part). A brand-new sku -> INSERT.
 *   4. Two rows in one file that claim the same external_id, or the same sku,
 *      are BOTH errors: an import that silently let the last one win would make
 *      the outcome depend on row order.
 *   5. The optional `plant` column names where the part is made. A name that
 *      resolves to a readable plant is assigned (D115's product_sites) after the
 *      insert/update; a name that resolves to nothing is an error, because
 *      "assign it somewhere I could not find" is not a thing to do silently. A
 *      blank plant is fine — a part offered nowhere is a legitimate state.
 *
 * Dependency-free at runtime apart from `./csv` and `./products`, both of which
 * are themselves dependency-free — so this runs under
 * `node --experimental-strip-types` and `src/test/productImport.test.ts` covers
 * it without a network.
 */
import type { AdminProduct } from "@/lib/api";
import type { CsvError, CsvTable } from "./csv";
import { validateProductDraft } from "./products";

/* ===========================================================================
 * §1. Column mapping. A header is matched case-insensitively against a set of
 * common aliases, so "SKU", "Part Number" and "part_number" all find the sku
 * column. The wizard lets a human override any of these; this only proposes.
 * ======================================================================== */

/** Which normalised header key holds each field. `null` = the column is absent. */
export interface ColumnMap {
  sku: string | null;
  name: string | null;
  externalId: string | null;
  plant: string | null;
}

const ALIASES: Record<keyof ColumnMap, readonly string[]> = {
  sku: ["sku", "part number", "part_number", "part no", "part", "code", "product code"],
  name: ["name", "product name", "description", "product", "title"],
  externalId: ["external_id", "external id", "id", "ref", "reference", "source id", "source_id"],
  plant: ["plant", "site", "location", "facility", "made in", "made_in"],
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
    sku: find(ALIASES.sku),
    name: find(ALIASES.name),
    externalId: find(ALIASES.externalId),
    plant: find(ALIASES.plant),
  };
}

/* ===========================================================================
 * §2. The plan.
 * ======================================================================== */

/** A plant the import may assign a part to — a node the reader can see. */
export interface ImportPlant {
  id: string;
  name: string;
}

export type RowOutcome =
  | {
      kind: "insert";
      sku: string;
      name: string;
      externalId: string | null;
      /** Resolved from the plant column; `null` when absent. Assigned after insert. */
      plantNodeId: string | null;
    }
  | {
      kind: "update";
      productId: string;
      sku: string;
      name: string;
      /** The existing part's external_id is left as-is; sku/name are the update. */
      externalId: string | null;
      plantNodeId: string | null;
    }
  | { kind: "error"; messages: string[] };

export interface PlannedRow {
  /** 1-based source line, for the wizard to point a human at. */
  line: number;
  /** The mapped, trimmed values, for display beside the outcome. */
  values: { sku: string; name: string; externalId: string; plant: string };
  outcome: RowOutcome;
}

export interface ImportPlan {
  rows: readonly PlannedRow[];
  counts: { insert: number; update: number; error: number };
  /** Parse-level problems (a malformed quote, a short row) — from `parseCsvTable`. */
  fileErrors: readonly CsvError[];
  /** True when the header is missing a REQUIRED column (sku or name). */
  missingRequired: readonly ("sku" | "name")[];
}

/**
 * Build the plan. Never throws.
 *
 * @param table    the parsed CSV (header + rows), from `parseCsvTable`.
 * @param existing every product the reader can see, from `fetchAdminProducts`.
 * @param columns  the column map (from `detectColumns`, possibly overridden).
 * @param plants   the plants a plant name can resolve to (readable roots/nodes).
 */
export function planProductImport(
  table: CsvTable,
  existing: readonly AdminProduct[],
  columns: ColumnMap,
  plants: readonly ImportPlant[],
): ImportPlan {
  const missingRequired: ("sku" | "name")[] = [];
  if (columns.sku === null) missingRequired.push("sku");
  if (columns.name === null) missingRequired.push("name");

  // Indexes over what already exists, so matching is O(1) per row.
  const byExternalId = new Map<string, AdminProduct>();
  const bySku = new Map<string, AdminProduct>();
  for (const p of existing) {
    if (p.externalId !== null) byExternalId.set(p.externalId, p);
    bySku.set(p.sku, p);
  }
  // Plant names, case-folded, for the optional plant column.
  const plantByName = new Map<string, ImportPlant>();
  for (const pl of plants) plantByName.set(pl.name.trim().toLowerCase(), pl);

  // First pass: collect the external_ids and skus this FILE uses, to catch
  // within-file collisions (rule 4) — a duplicate must fail BOTH rows, so the
  // count has to be known before any row is judged.
  const fileExtCounts = new Map<string, number>();
  const fileSkuCounts = new Map<string, number>();
  const cell = (row: Record<string, string>, key: string | null): string =>
    key === null ? "" : (row[key] ?? "").trim();

  for (const row of table.rows) {
    const ext = cell(row, columns.externalId);
    const sku = cell(row, columns.sku);
    if (ext !== "") fileExtCounts.set(ext, (fileExtCounts.get(ext) ?? 0) + 1);
    if (sku !== "") fileSkuCounts.set(sku, (fileSkuCounts.get(sku) ?? 0) + 1);
  }

  const rows: PlannedRow[] = [];
  let insert = 0;
  let update = 0;
  let error = 0;

  table.rows.forEach((row, idx) => {
    const sku = cell(row, columns.sku);
    const name = cell(row, columns.name);
    const externalId = cell(row, columns.externalId);
    const plantName = cell(row, columns.plant);
    const line = idx + 2; // +1 for 0-based, +1 for the header row
    const values = { sku, name, externalId, plant: plantName };

    const messages: string[] = [];

    // Shape validation reuses the exact rules the manual create form applies, so
    // an import cannot make a row a typed form would have refused.
    const draft = validateProductDraft({ sku, name });
    if (!draft.ok) {
      if (draft.skuError) messages.push(draft.skuError);
      if (draft.nameError) messages.push(draft.nameError);
    }

    // Within-file collisions (rule 4).
    if (externalId !== "" && (fileExtCounts.get(externalId) ?? 0) > 1) {
      messages.push(`the external id "${externalId}" is used by more than one row in this file`);
    }
    if (sku !== "" && (fileSkuCounts.get(sku) ?? 0) > 1) {
      messages.push(`the code "${sku}" is used by more than one row in this file`);
    }

    // Resolve the optional plant.
    let plantNodeId: string | null = null;
    if (plantName !== "") {
      const resolved = plantByName.get(plantName.toLowerCase());
      if (resolved === undefined) {
        messages.push(`no plant named "${plantName}" that you can see`);
      } else {
        plantNodeId = resolved.id;
      }
    }

    // Match to an existing part and decide insert vs update (rules 1-3).
    const byExt = externalId !== "" ? (byExternalId.get(externalId) ?? null) : null;
    const bySkuMatch = sku !== "" ? (bySku.get(sku) ?? null) : null;

    if (messages.length === 0) {
      if (byExt !== null) {
        // Rule 1: update the matched part. The new sku must not belong to a
        // DIFFERENT part.
        if (bySkuMatch !== null && bySkuMatch.id !== byExt.id) {
          messages.push(`the code "${sku}" already belongs to a different part`);
        }
      } else if (externalId !== "" && bySkuMatch !== null) {
        // A new external_id landing on an existing sku: the code is taken by a
        // part that has a different (or no) external id — refuse rather than
        // silently re-home the code.
        messages.push(`the code "${sku}" already belongs to a different part`);
      }
    }

    if (messages.length > 0) {
      rows.push({ line, values, outcome: { kind: "error", messages } });
      error += 1;
      return;
    }

    // ⭐ On an UPDATE, do not re-assign a plant the part already has — the
    // company admin doing the import sees every place (product_sites is only
    // scoped for non-admins), so "already there" is known here, and skipping it
    // keeps a re-upload idempotent instead of churning a duplicate the server
    // would refuse. An INSERT is a new part with no places, so its plant stays.
    const plantForUpdate = (matched: AdminProduct): string | null =>
      plantNodeId !== null && matched.siteNodeIds.includes(plantNodeId) ? null : plantNodeId;

    if (byExt !== null) {
      rows.push({
        line,
        values,
        outcome: {
          kind: "update",
          productId: byExt.id,
          sku,
          name,
          externalId,
          plantNodeId: plantForUpdate(byExt),
        },
      });
      update += 1;
    } else if (bySkuMatch !== null) {
      // Rule 3: no external_id (or a new one was excluded above), matched by sku.
      rows.push({
        line,
        values,
        outcome: {
          kind: "update",
          productId: bySkuMatch.id,
          sku,
          name,
          externalId: externalId === "" ? null : externalId,
          plantNodeId: plantForUpdate(bySkuMatch),
        },
      });
      update += 1;
    } else {
      rows.push({
        line,
        values,
        outcome: {
          kind: "insert",
          sku,
          name,
          externalId: externalId === "" ? null : externalId,
          plantNodeId,
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
