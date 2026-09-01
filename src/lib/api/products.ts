/**
 * Products — the admin section's data layer (design plan §19.62, D102).
 *
 * `src/lib/api/` is the ONLY place allowed to touch `supabase`, snake_case
 * column names, or `database.types.ts` (docs/conventions.md). Everything past
 * this file — the hook, the pure module, the panel — works in camelCase and
 * never learns that `site_node_id` exists.
 *
 * ⚠️ THERE IS NO RPC FOR PRODUCTS, AND THAT CHANGES THE ERROR STORY. Every
 * other write in this layer calls a function that ends in `api_raise`, so a
 * refusal arrives with a machine code in `DETAIL`. Here the writes are plain
 * PostgREST table calls and RLS is the only gate, so a refusal arrives as a
 * bare SQLSTATE — which is exactly what §19.63's five extra `SchedulerError`
 * kinds (`WriteRefused`, `DuplicateValue`, `StillInUse`, `InvalidValue`,
 * `ShiftOverlap`) were added for. `toSchedulerError` already maps them.
 *
 * ⭐ AND THE HALF THAT RAISES NOTHING AT ALL. A policy's `WITH CHECK` clause
 * raises 42501; its `USING` clause merely FILTERS. So a refused INSERT is an
 * error, and a refused UPDATE or DELETE is a **success that changed nothing**.
 * Every write below therefore ends `.select()`, maps the error, and passes the
 * returned rows through `requireWritten` — which throws `WriteRefused` on an
 * empty result. That third step is not optional and not decorative: without
 * it, a site admin editing a company-wide product is told "saved".
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so it is not runnable under
 * `node --experimental-strip-types`. The logic that IS unit-tested lives in
 * `src/features/admin/lib/products.ts`, which imports nothing at runtime.
 */
import type { TablesInsert } from "@/lib/database.types";
import { supabase } from "@/lib/supabase";
import { requireWritten, shapeMismatch, toSchedulerError } from "./errors";

/**
 * One `products` row as the admin screen needs it.
 *
 * ⭐ D115 / migration 0034: a product BELONGS TO A LIST OF PLACES, not one. The
 * single `site_node_id` column is gone; `siteNodeIds` is the list of nodes this
 * product is made at, read from the `product_sites` join table. The company owns
 * the part number (`unique (org_id, sku)` is unchanged); which plants make it is
 * this list — one, several, or all.
 *
 * ⚠️ `siteNodeIds` IS "AS FAR AS THIS READER CAN SEE". `product_sites` is
 * RLS-scoped by `app_can_read_node`, so a Plant B admin reading a part made in
 * Plant A and Plant B gets ONLY the Plant B node id back — the whole list is a
 * company-admin view. An EMPTY list is a real, ordinary state: a company-wide
 * part not yet assigned to any plant, or one whose plants are all outside this
 * reader's view. It is never coerced or treated as an error.
 */
export interface AdminProduct {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  /** `'manual'` for anything typed on this screen; imports set their own. */
  source: string;
  externalId: string | null;
  /** The nodes this product is made at (product_sites), RLS-scoped. May be empty. */
  siteNodeIds: string[];
  colorToken: string;
}

/**
 * The columns every read below selects, in one place so they cannot drift.
 *
 * ⭐ `product_sites(node_id)` is a PostgREST EMBED, not a column — the join
 * table is reachable from `products` through its `(org_id, product_id)` foreign
 * key, and the embed is itself RLS-filtered, which is exactly the "as far as the
 * reader can see" the interface promises. `parseAdminProduct` reads the array.
 */
const PRODUCT_COLUMNS =
  "id, sku, name, active, source, external_id, color_token, product_sites(node_id)";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The shape guard: one raw row in, an `AdminProduct` or `null` out.
 *
 * Returns `null` rather than throwing, because the caller is a LIST a screen
 * renders and one malformed row must not blank the panel (brief rule 3). The
 * skip-and-count itself is `productRows()` in the pure module — this function
 * only answers "is this row readable", which is the half that has to know
 * snake_case and therefore has to live here.
 */
export function parseAdminProduct(row: unknown): AdminProduct | null {
  if (!isRecord(row)) return null;
  const { id, sku, name, active, source, external_id, color_token, product_sites } = row;
  if (
    typeof id !== "string" ||
    typeof sku !== "string" ||
    typeof name !== "string" ||
    typeof active !== "boolean" ||
    typeof source !== "string" ||
    !(external_id === null || typeof external_id === "string") ||
    typeof color_token !== "string" ||
    !Array.isArray(product_sites)
  ) {
    return null;
  }
  // ⭐ THE EMBED IS AN ARRAY OF `{ node_id }`, and a malformed entry REJECTS the
  // whole row rather than being dropped. Where a product is offered is identity,
  // not decoration (`scope.ts`'s header): a place silently missing would make
  // the product look un-offered in a plant it is actually made in. An empty
  // array is fine — that is a legitimate unassigned/foreign state — but a
  // non-string node id is a shape this client does not understand.
  const siteNodeIds: string[] = [];
  for (const entry of product_sites) {
    if (!isRecord(entry) || typeof entry.node_id !== "string") return null;
    siteNodeIds.push(entry.node_id);
  }
  return {
    id,
    sku,
    name,
    active,
    source,
    externalId: external_id,
    siteNodeIds,
    colorToken: color_token,
  };
}

/**
 * Every product in the org, ordered by sku — reads are org-wide and 0023 left
 * them that way on purpose (a site admin can SEE the whole catalogue; what
 * changed is what they may WRITE).
 *
 * ⚠️ RETURNS `(AdminProduct | null)[]`, NULLS INCLUDED, and the nulls are the
 * point. Dropping them here would make "three rows the client could not read"
 * indistinguishable from "three rows that do not exist", and the panel is
 * required to say how many it skipped. `productRows()` does the skipping and
 * the counting, in a module a unit test can reach without a network.
 *
 * THROWS on a failed read, unlike `fetchAdminAnywhere` which fails closed:
 * this is the screen's content, and an empty catalogue is a lie when the
 * truth is that the read did not happen (`access.ts`'s header states the same
 * split for the same reason).
 */
export async function fetchAdminProducts(): Promise<ReadonlyArray<AdminProduct | null>> {
  const { data, error } = await supabase.from("products").select(PRODUCT_COLUMNS).order("sku");
  if (error) throw toSchedulerError(error);
  return (data ?? []).map((row) => parseAdminProduct(row));
}

export interface CreateProductInput {
  /** `products.org_id` has NO DEFAULT — supplied from `useSession().profile.orgId`. */
  orgId: string;
  sku: string;
  name: string;
}

/**
 * ⭐ `color_token` IS OMITTED ON PURPOSE AND THE CAST IS WHY IT COMPILES.
 *
 * The column is `NOT NULL` with no default (0023 §3), so `supabase gen types`
 * emits it as REQUIRED on `Insert`. It is filled by the BEFORE INSERT trigger
 * `products_set_color_token`, which assigns unconditionally — anything sent
 * from here would be overwritten on the way in. The generated type cannot
 * express "a trigger supplies this", the same class of gap as `nodes.path`
 * being typed `unknown` in `hierarchy.ts`, and regenerating will never change
 * it. So the payload is built without the column and cast at this single
 * boundary, with this comment, rather than sending a value that is a lie.
 */
type ProductInsert = TablesInsert<"products">;

/**
 * The same row with the trigger-filled column made optional. Written this way
 * rather than as an `Omit`, so the assertion below is a legal narrowing of a
 * genuine supertype (`ProductInsert` IS a `ProductInsertDraft`) instead of a
 * `as unknown as` that would silence anything at all.
 */
type ProductInsertDraft = Omit<ProductInsert, "color_token"> &
  Partial<Pick<ProductInsert, "color_token">>;

/**
 * Creates the shared product record — sku, name, colour (trigger-picked).
 *
 * ⭐ D115: NO PLACES HERE. Creating a part is a company-admin act (the Split
 * decision, migration 0034 §9): it makes the company-wide record. Which plants
 * make it is managed separately through `assignProductSite`, so a just-created
 * part is offered nowhere until a plant is added — a legitimate state, not an
 * error. The returned row's `siteNodeIds` is therefore empty.
 */
export async function createProduct(input: CreateProductInput): Promise<AdminProduct> {
  const payload: ProductInsertDraft = {
    org_id: input.orgId,
    sku: input.sku,
    name: input.name,
  };

  const { data, error } = await supabase
    .from("products")
    .insert(payload as ProductInsert)
    .select(PRODUCT_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstProduct(requireWritten(data), "products.insert");
}

export interface UpdateProductInput {
  id: string;
  sku: string;
  name: string;
}

/**
 * Renames / re-skus one product — the shared, company-wide record.
 *
 * ⭐ D115: WHERE IT BELONGS IS NOT HERE ANY MORE. A product's places are the
 * `product_sites` list, changed through `assignProductSite` / `unassignProductSite`,
 * because they carry their own permission (a plant admin manages their own plant)
 * and their own refusal (removing a plant that still has work stranded). Folding
 * them into this rename would make a rename able to fail on a strand and a place
 * change able to fail on a duplicate sku — one write, one thing that can be wrong.
 *
 * ⚠️ AND UNDER THE SPLIT DECISION (0034 §9) THIS IS COMPANY-ADMIN ONLY. The
 * `products_update` policy is now `app_is_admin()`: the part number is company
 * property. A site admin's rename is refused by RLS and lands on `requireWritten`
 * as `WriteRefused`, exactly the shape §19.63 was built for.
 */
export async function updateProduct(input: UpdateProductInput): Promise<AdminProduct> {
  const { data, error } = await supabase
    .from("products")
    .update({ sku: input.sku, name: input.name })
    .eq("id", input.id)
    .select(PRODUCT_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstProduct(requireWritten(data), "products.update");
}

export interface ProductSiteInput {
  /** `product_sites.org_id` has no default — supplied from the session. */
  orgId: string;
  productId: string;
  /** The node (plant, line, area — any node) to add or remove. */
  nodeId: string;
}

/**
 * Adds a plant to a product's list of makers — one `product_sites` row.
 *
 * ⭐ D115 / the Split decision: a plant admin may add THEIR OWN plant
 * (`product_sites_insert` = `app_is_admin() OR app_is_admin_for(node_id)`); a
 * company admin may add any. A refusal is a plain RLS filter, so `.select()` +
 * `requireWritten` turns the silent empty result into `WriteRefused` — the same
 * backstop every write in this file relies on (see the header).
 *
 * Idempotent-ish: the PK is `(product_id, node_id)`, so adding a plant twice
 * raises `23505` -> `DuplicateValue`, which the panel treats as already-there.
 */
export async function assignProductSite(input: ProductSiteInput): Promise<void> {
  const { data, error } = await supabase
    .from("product_sites")
    .insert({ org_id: input.orgId, product_id: input.productId, node_id: input.nodeId })
    .select("node_id");
  if (error) throw toSchedulerError(error);
  requireWritten(data);
}

/**
 * Removes a plant from a product's list of makers.
 *
 * ⚠️ THIS CAN BE REFUSED FOR TWO DIFFERENT REASONS, and both are real. RLS
 * refuses a plant admin removing a plant that is not theirs (empty result ->
 * `WriteRefused`). The strand guard (`app_guard_product_site_remove`, 0034 §5)
 * raises `owner_change_blocked` when the product is still scheduled somewhere
 * only this plant covers — moving somebody else's schedule is not a side effect
 * an un-assign gets to have. The panel names each.
 */
export async function unassignProductSite(input: ProductSiteInput): Promise<void> {
  const { data, error } = await supabase
    .from("product_sites")
    .delete()
    .eq("product_id", input.productId)
    .eq("node_id", input.nodeId)
    .select("node_id");
  if (error) throw toSchedulerError(error);
  requireWritten(data);
}

export interface SetProductColorInput {
  id: string;
  /** A token this stylesheet actually defines — see `PRODUCT_PALETTE`. */
  colorToken: string;
}

/**
 * Sets a product's colour by hand.
 *
 * ⭐ THE AUTOMATIC PICK STAYS THE DEFAULT (the maintainer, Aug 27). 0023 §3 chooses the
 * least-used token in the owner's palette at INSERT and D102's whole point was
 * that a product's colour does not move under you — so nothing here re-picks,
 * and nothing here fires on a rename or a re-assignment. This is a person
 * deliberately overriding one row, which is a different act from the system
 * changing its mind, and it is the only thing that writes this column after
 * insert.
 *
 * ⚠️ A SEPARATE CALL FROM `updateProduct`, NOT AN EXTRA FIELD ON IT. The rename
 * form and the swatch picker are two controls with two refusals; folding them
 * into one statement would make a colour change able to fail on a duplicate SKU
 * and a rename able to fail on a colour. One write, one thing that can be
 * wrong with it.
 *
 * ⚠️ THE PALETTE CHECK IS THE CALLER'S, DELIBERATELY. The column is `NOT NULL`
 * and CHECKed against `^product-[1-9][0-9]*$`, so the database refuses nonsense
 * — but `product-9` PASSES that CHECK and renders as no colour at all, which is
 * the exact defect 0023's upgrade test caught. The narrower rule ("a token
 * `tokens.css` actually defines") lives in `features/admin/lib/products.ts`
 * beside the palette itself, and `ProductsPanel` applies it before calling.
 * It is NOT imported here: this module is what that file imports its types
 * from, so reaching back into it would make a real runtime import cycle for a
 * one-line guard.
 */
export async function setProductColor(input: SetProductColorInput): Promise<AdminProduct> {
  const { data, error } = await supabase
    .from("products")
    .update({ color_token: input.colorToken })
    .eq("id", input.id)
    .select(PRODUCT_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstProduct(requireWritten(data), "products.setColor");
}

export interface SetProductActiveInput {
  id: string;
  active: boolean;
}

/**
 * Deactivate / reactivate — the MAIN action on this screen (the maintainer's call).
 * A deactivated product keeps every run and assignment it has ever been on and
 * simply stops being offered for new work, which is what "we don't make that
 * any more" actually means. Delete is the secondary action below.
 */
export async function setProductActive(input: SetProductActiveInput): Promise<AdminProduct> {
  const { data, error } = await supabase
    .from("products")
    .update({ active: input.active })
    .eq("id", input.id)
    .select(PRODUCT_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstProduct(requireWritten(data), "products.setActive");
}

/**
 * Hard delete.
 *
 * `runs` and `assignments` reference `(org_id, product_id)` with NO
 * `ON DELETE` clause, so deleting a product that has ever been scheduled
 * fails with `23503` — which `toSchedulerError` turns into
 * `{ kind: "StillInUse", usedBy: "runs" }`, naming the table that is in the
 * way. The panel says exactly that instead of "something went wrong".
 *
 * `.select()` then `requireWritten` for the reason in the file header: a
 * DELETE the policy refuses removes zero rows and reports no error at all.
 */
export async function deleteProduct(id: string): Promise<void> {
  const { data, error } = await supabase.from("products").delete().eq("id", id).select("id");
  if (error) throw toSchedulerError(error);
  requireWritten(data);
}

/**
 * The written row, re-guarded. A write that comes back in a shape this client
 * cannot read is a real bug and must be loud — unlike the LIST read above,
 * there is no other row to fall back on, which is the same split
 * `shapes.ts`'s header draws between a single row and a rendered list.
 */
function firstProduct(rows: ReadonlyArray<unknown>, what: string): AdminProduct {
  const parsed = parseAdminProduct(rows[0]);
  if (parsed === null) {
    throw shapeMismatch(what, "expected a products row (see AdminProduct in products.ts)");
  }
  return parsed;
}
