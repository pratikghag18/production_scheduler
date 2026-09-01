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
import { supabase } from "@/lib/supabase";
import { assignProductSite, updateProduct } from "./products";
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
