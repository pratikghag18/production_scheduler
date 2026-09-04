/**
 * imports.ts — applying a CSV import PLAN to the database (§19.62's pre-seated
 * home for import wrappers; the barrel already exports it).
 *
 * The plan itself (what each row would do) is decided in
 * `src/features/admin/lib/productImport.ts`, which is pure and tested without a
 * network. THIS file is the half that writes: it walks the plan's insert and
 * update outcomes, performs each write, assigns the optional plant, and returns
 * a summary of what actually happened. AUTHOR-ONLY — it imports `@/lib/supabase`.
 *
 * ⚠️ NOT AN RPC, DESPITE THIS FILE'S ORIGINAL HOUSE NOTE. The pre-seat expected
 * "every wrapper calls one RPC", but products have no RPC and an import's value
 * is telling a human which rows landed and which did not — which a per-row apply
 * produces and a single bulk statement cannot. So this is row-at-a-time by
 * design; the summary counts what happened, not what the plan predicted.
 *
 * ⭐ IT REUSES THE ORDINARY WRITES. An imported UPDATE is `updateProduct` (the
 * same rename/re-sku the panel uses); an imported plant assignment is
 * `assignProductSite`. Only the INSERT is new here, because a manual create does
 * not set `external_id` or a non-'manual' `source`, and an import must set both:
 * `external_id` is the match key that makes a re-upload idempotent (D115 made it
 * company-wide), and `source` records that this row came from a file.
 */
import type { ImportPlan } from "@/features/admin/lib/productImport";
import type { ImportPlan as OperatorImportPlan } from "@/features/admin/lib/operatorImport";
import type { ImportPlan as TrainingImportPlan } from "@/features/admin/lib/trainingImport";
import type { ImportPlan as CertificationImportPlan } from "@/features/admin/lib/certificationImport";
import { supabase } from "@/lib/supabase";
import { assignProductSite, updateProduct } from "./products";
import {
  createSkill,
  grantSkill,
  setSkillDocumentNumber,
  updateOperator,
  updateSkillRecord,
} from "./operators";
import { describeSchedulerError, requireWritten, toSchedulerError } from "./errors";
import type { SchedulerError } from "./errors";
import type { TablesInsert } from "@/lib/database.types";

/**
 * ⚠️ THE api WRITES ALREADY THROW A `SchedulerError`, NOT A RAW POSTGREST ERROR.
 * `updateProduct` / `assignProductSite` end in `throw toSchedulerError(error)`,
 * so a value CAUGHT from them is already converted. Calling `toSchedulerError`
 * on it a SECOND time re-wraps `{kind:"DuplicateValue"}` — which has no `.code`
 * — into `{kind:"Unknown"}`, which is exactly how a re-import of an
 * already-assigned plant surfaced as "Something went wrong" instead of being the
 * silent no-op it is. This preserves an already-converted error and only
 * converts a genuinely raw one (a network throw).
 */
function asSchedulerError(e: unknown): SchedulerError {
  return e !== null && typeof e === "object" && "kind" in e
    ? (e as SchedulerError)
    : toSchedulerError(e);
}

export interface ImportContext {
  /** `products.org_id` has no default — supplied from the session. */
  orgId: string;
  /** Recorded on every inserted row's `source`; the file name or "import". */
  source: string;
}

export interface ImportRowFailure {
  /** The plan's source line, so the wizard can point back at the CSV row. */
  line: number;
  message: string;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  /** Rows the plan meant to write that the server refused, each with a reason. */
  failed: ImportRowFailure[];
}

type ProductInsert = TablesInsert<"products">;
type ProductInsertDraft = Omit<ProductInsert, "color_token"> &
  Partial<Pick<ProductInsert, "color_token">>;

/**
 * Insert one imported product. Sets `external_id` and `source`, which a manual
 * create leaves at null/'manual'. `color_token` is omitted for the trigger to
 * fill, the same cast `createProduct` documents. Returns the new id, needed to
 * assign its plant.
 */
async function insertImportedProduct(input: {
  orgId: string;
  sku: string;
  name: string;
  externalId: string | null;
  source: string;
}): Promise<string> {
  const payload: ProductInsertDraft = {
    org_id: input.orgId,
    sku: input.sku,
    name: input.name,
    source: input.source,
    external_id: input.externalId,
  };
  const { data, error } = await supabase
    .from("products")
    .insert(payload as ProductInsert)
    .select("id");
  if (error) throw toSchedulerError(error);
  const rows = requireWritten(data);
  const first = rows[0] as { id?: unknown } | undefined;
  if (first === undefined || typeof first.id !== "string") {
    throw toSchedulerError(new Error("products.import.insert returned no id"));
  }
  return first.id;
}

/**
 * Apply the plan. Never throws for a single bad row — it collects them. It DOES
 * propagate a failure of the whole call (a dropped connection), because that is
 * not a row-level fact the summary can honestly report.
 *
 * Error rows in the plan are already excluded here: they were never going to be
 * written, and the preview counted them separately.
 */
export async function applyProductImport(
  plan: ImportPlan,
  ctx: ImportContext,
): Promise<ImportResult> {
  let inserted = 0;
  let updated = 0;
  const failed: ImportRowFailure[] = [];

  for (const row of plan.rows) {
    const o = row.outcome;
    if (o.kind === "error") continue;
    try {
      let productId: string;
      if (o.kind === "insert") {
        productId = await insertImportedProduct({
          orgId: ctx.orgId,
          sku: o.sku,
          name: o.name,
          externalId: o.externalId,
          source: ctx.source,
        });
        inserted += 1;
      } else {
        await updateProduct({ id: o.productId, sku: o.sku, name: o.name });
        productId = o.productId;
        updated += 1;
      }
      if (o.plantNodeId !== null) {
        try {
          await assignProductSite({ orgId: ctx.orgId, productId, nodeId: o.plantNodeId });
        } catch (e) {
          // The row's own write succeeded; the plant is a follow-on. A duplicate
          // (the part was already made there) is not a failure — anything else is
          // reported against the row without undoing the part it already wrote.
          const err = asSchedulerError(e);
          if (err.kind !== "DuplicateValue") {
            failed.push({
              line: row.line,
              message: `saved, but its plant was not: ${describeSchedulerError(err)}`,
            });
          }
        }
      }
    } catch (e) {
      failed.push({ line: row.line, message: describeSchedulerError(asSchedulerError(e)) });
    }
  }

  return { inserted, updated, failed };
}

/* ===========================================================================
 * §2. People. The operators lane of the same wizard.
 *
 * ⭐ THE SAME SHAPE AS PRODUCTS, WITH TWO PEOPLE-SPECIFIC TWISTS:
 *   - There is NO plant follow-on. A product's plant is a separate
 *     `product_sites` row assigned AFTER the insert; a person's plant IS their
 *     `site_node_id`, set in the one insert below and NOT NULL — so the plan
 *     guarantees an inserted row has one, and there is nothing to assign after.
 *   - ⚠️⚠️ AN IMPORTED UPDATE OMITS `siteNodeId`, on purpose. `updateOperator`
 *     leaves the site alone when the field is absent (its own header says why);
 *     re-homing a person is out of scope for import v1, so the update carries
 *     only the name and employee ref, never a plant.
 * =========================================================================== */

type OperatorInsert = TablesInsert<"operators">;

/**
 * Insert one imported person. Sets `external_id` and `source`, which a manual
 * create (`createOperator`) leaves at null/'manual'. `site_node_id` is required
 * (NOT NULL) and the plan resolved it; returns the new id for parity with
 * `insertImportedProduct` (people have no plant follow-on to use it for).
 */
async function insertImportedOperator(input: {
  orgId: string;
  displayName: string;
  employeeRef: string | null;
  externalId: string | null;
  siteNodeId: string;
  source: string;
}): Promise<string> {
  const payload: OperatorInsert = {
    org_id: input.orgId,
    display_name: input.displayName,
    employee_ref: input.employeeRef,
    site_node_id: input.siteNodeId,
    external_id: input.externalId,
    source: input.source,
  };
  const { data, error } = await supabase.from("operators").insert(payload).select("id");
  if (error) throw toSchedulerError(error);
  const rows = requireWritten(data);
  const first = rows[0] as { id?: unknown } | undefined;
  if (first === undefined || typeof first.id !== "string") {
    throw toSchedulerError(new Error("operators.import.insert returned no id"));
  }
  return first.id;
}

/**
 * Apply the people plan. Collects per-row failures like `applyProductImport`;
 * propagates a whole-call failure (a dropped connection). Error rows in the plan
 * are already excluded — they were never going to be written.
 */
export async function applyOperatorImport(
  plan: OperatorImportPlan,
  ctx: ImportContext,
): Promise<ImportResult> {
  let inserted = 0;
  let updated = 0;
  const failed: ImportRowFailure[] = [];

  for (const row of plan.rows) {
    const o = row.outcome;
    if (o.kind === "error") continue;
    try {
      if (o.kind === "insert") {
        await insertImportedOperator({
          orgId: ctx.orgId,
          displayName: o.displayName,
          employeeRef: o.employeeRef,
          externalId: o.externalId,
          siteNodeId: o.plantNodeId,
          source: ctx.source,
        });
        inserted += 1;
      } else {
        // ⚠️ siteNodeId OMITTED — leave the person's plant alone (rule 1).
        await updateOperator({
          id: o.operatorId,
          displayName: o.displayName,
          employeeRef: o.employeeRef,
        });
        updated += 1;
      }
    } catch (e) {
      failed.push({ line: row.line, message: describeSchedulerError(asSchedulerError(e)) });
    }
  }

  return { inserted, updated, failed };
}

/* ===========================================================================
 * §3. Trainings. The catalogue lane of the same wizard — bulk-adding training
 * TYPES (Forklift, Welding…), one per plant.
 *
 * ⭐ THE SIMPLEST LANE OF THE THREE:
 *   - An INSERT is `createSkill`, carrying the optional document number as
 *     `externalId` (there is no source on a training, and no plant follow-on: the
 *     owner IS `site_node_id`, set in the one insert, and the plan resolved it).
 *   - An "update" outcome means the (name, plant) training is ALREADY THERE. The
 *     training itself is left alone — the active flag is never touched — so a
 *     re-upload stays idempotent. The one thing an update may do is record a
 *     document number: the plan sets `documentNumber` to a non-null value only
 *     when the row gives one that DIFFERS from what the training already carries,
 *     and that is the only case that calls `setSkillDocumentNumber`. A null there
 *     is a pure no-op that just counts as `updated`.
 * =========================================================================== */

/**
 * Apply the trainings plan. Collects per-row failures like the lanes above;
 * propagates a whole-call failure (a dropped connection). Error rows in the plan
 * are already excluded — they were never going to be written.
 */
export async function applyTrainingImport(
  plan: TrainingImportPlan,
  ctx: ImportContext,
): Promise<ImportResult> {
  let inserted = 0;
  let updated = 0;
  const failed: ImportRowFailure[] = [];

  for (const row of plan.rows) {
    const o = row.outcome;
    if (o.kind === "error") continue;
    try {
      if (o.kind === "insert") {
        await createSkill({
          orgId: ctx.orgId,
          name: o.name,
          siteNodeId: o.plantNodeId,
          externalId: o.documentNumber,
        });
        inserted += 1;
      } else {
        // The (name, plant) training already exists — its active flag is never
        // touched. The plan set `documentNumber` to a non-null value only when the
        // row gives one that DIFFERS from the training's current number, so that
        // is the only case that writes; a null is a pure no-op.
        if (o.documentNumber !== null) {
          await setSkillDocumentNumber({ id: o.skillId, externalId: o.documentNumber });
        }
        updated += 1;
      }
    } catch (e) {
      failed.push({ line: row.line, message: describeSchedulerError(asSchedulerError(e)) });
    }
  }

  return { inserted, updated, failed };
}

/* ===========================================================================
 * §4. Training records (certifications). Each row grants a training to a
 * person, or updates the sign-off/dates of one they already hold.
 *
 * ⭐ The plan already resolved the person and the training to ids and refused
 * the ambiguous rows; this only writes. An INSERT is `grantSkill`, an UPDATE is
 * `updateSkillRecord` — both existing writes, so nothing new is needed here. The
 * CSV is authoritative for the three record fields, so all three are sent on
 * both paths (a blank cell is `null`).
 * ======================================================================== */
export async function applyCertificationImport(
  plan: CertificationImportPlan,
  ctx: ImportContext,
): Promise<ImportResult> {
  let inserted = 0;
  let updated = 0;
  const failed: ImportRowFailure[] = [];

  for (const row of plan.rows) {
    const o = row.outcome;
    if (o.kind === "error") continue;
    try {
      if (o.kind === "insert") {
        await grantSkill({
          orgId: ctx.orgId,
          operatorId: o.operatorId,
          skillId: o.skillId,
          expiresAt: o.expiresAt,
          certifiedAt: o.certifiedAt,
          signedOffBy: o.signedOffBy,
        });
        inserted += 1;
      } else {
        await updateSkillRecord({
          operatorId: o.operatorId,
          skillId: o.skillId,
          expiresAt: o.expiresAt,
          certifiedAt: o.certifiedAt,
          signedOffBy: o.signedOffBy,
        });
        updated += 1;
      }
    } catch (e) {
      failed.push({ line: row.line, message: describeSchedulerError(asSchedulerError(e)) });
    }
  }

  return { inserted, updated, failed };
}
