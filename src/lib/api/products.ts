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
 * `siteNodeId` is the ROOT node whose site owns this product; **`null` means
 * company-wide** (0023 §1's own column comment), which is a real value and not
 * a missing one — a site admin may edit their own site's products and may not
 * touch a company-wide one, so the null is load-bearing for permissions.
 *
 * `colorToken` is a palette token like `product-3`, NEVER a hex: the board
 * resolves it through `tokens.css` (0023 §3). It is chosen by a BEFORE INSERT
 * trigger and deliberately never re-picked, not even when the owner changes.
 */
export interface AdminProduct {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  /** `'manual'` for anything typed on this screen; imports set their own. */
  source: string;
  externalId: string | null;
  /** `null` = company-wide. See the interface comment. */
  siteNodeId: string | null;
  colorToken: string;
}

/** The columns every read below selects, in one place so they cannot drift. */
const PRODUCT_COLUMNS = "id, sku, name, active, source, external_id, site_node_id, color_token";

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
  const { id, sku, name, active, source, external_id, site_node_id, color_token } = row;
  if (
    typeof id !== "string" ||
    typeof sku !== "string" ||
    typeof name !== "string" ||
    typeof active !== "boolean" ||
    typeof source !== "string" ||
    !(external_id === null || typeof external_id === "string") ||
    !(site_node_id === null || typeof site_node_id === "string") ||
    typeof color_token !== "string"
  ) {
    return null;
  }
  return {
    id,
    sku,
    name,
    active,
    source,
    externalId: external_id,
    siteNodeId: site_node_id,
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
  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .order("sku");
  if (error) throw toSchedulerError(error);
  return (data ?? []).map((row) => parseAdminProduct(row));
}

export interface CreateProductInput {
  /** `products.org_id` has NO DEFAULT — supplied from `useSession().profile.orgId`. */
  orgId: string;
  sku: string;
  name: string;
  /** `null` = company-wide, which the insert policy allows only to a company admin. */
  siteNodeId: string | null;
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

export async function createProduct(input: CreateProductInput): Promise<AdminProduct> {
  const payload: ProductInsertDraft = {
    org_id: input.orgId,
    sku: input.sku,
    name: input.name,
    site_node_id: input.siteNodeId,
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
  /** Where it belongs. Omit to leave alone; `null` moves it company-wide. */
  siteNodeId?: string | null;
}

/**
 * Renames / re-skus one product.
 *
 * ⚠️ IT TOUCHES `site_node_id` NOW, AND THE OLD REASONING IS DEAD. This
 * function used to say, in writing, that "owner is set once, at creation" —
 * because moving a product between owners would leave it holding a colour token
 * drawn from the OLD owner's palette, possibly a duplicate within the new one,
 * and D102 exists to stop colours changing under people.
 *
 * That argument had a premise, and 0025 removed it: a colour can now be set by
 * hand, so "the palette picked this for you and it might collide" is no longer
 * a reason to freeze the owner — it is a reason to let someone change the
 * colour, which they can. [[decision-record-drift]] rule 6: when you correct a
 * premise, go back and re-examine the decision it was supporting.
 *
 * ⚠️ AND PRATIK ASKED THREE TIMES. Where something belongs is not a property of
 * its birth; a line gets reorganised and its products move with it. A create
 * form without a matching edit is the same defect as a break you could only
 * delete and retype (§19.65) — build the edit path at the same time as the
 * create path, every time.
 *
 * `siteNodeId` is OPTIONAL: omit it to leave the scope alone, pass `null` to
 * move the product company-wide. `null` is a real value in this column, so
 * "not supplied" cannot be spelled the same way.
 */
export async function updateProduct(input: UpdateProductInput): Promise<AdminProduct> {
  const patch: { sku: string; name: string; site_node_id?: string | null } = {
    sku: input.sku,
    name: input.name,
  };
  if ("siteNodeId" in input) patch.site_node_id = input.siteNodeId ?? null;

  const { data, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", input.id)
    .select(PRODUCT_COLUMNS);
  if (error) throw toSchedulerError(error);
  return firstProduct(requireWritten(data), "products.update");
}

export interface SetProductColorInput {
  id: string;
  /** A token this stylesheet actually defines — see `PRODUCT_PALETTE`. */
  colorToken: string;
}

/**
 * Sets a product's colour by hand.
 *
 * ⭐ THE AUTOMATIC PICK STAYS THE DEFAULT (Pratik, Aug 27). 0023 §3 chooses the
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
 * Deactivate / reactivate — the MAIN action on this screen (Pratik's call).
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
  const { data, error } = await supabase
    .from("products")
    .delete()
    .eq("id", id)
    .select("id");
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
