/**
 * Pure product-catalogue logic — the client half of migration 0023's
 * `products` (§19.62, D102).
 *
 * Dependency-free: `import type` only, no React, no CSS, no `supabase`, no
 * snake_case. Runs under `node --experimental-strip-types` with nothing to
 * resolve, which is what makes it the thing the vitest suite actually tests
 * (`src/test/products.test.ts`). Everything load-bearing on this screen lives
 * here for that reason; `ProductsPanel.tsx` renders what these functions
 * return and decides nothing itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AUTHORITATIVE. The DATABASE is, for every rule in this file. The
 * three policies in 0023 §5 decide who may insert, update and delete; the
 * `products_color_token_shape` CHECK and `app_pick_product_color()` decide
 * colours; `unique (org_id, sku)` decides duplicates. This module computes
 * PREVIEWS — what to offer, what to grey out, what to say instead — so the
 * screen stops offering things the server will refuse.
 *
 * The invariant is one-way, and it is `shapePicker.ts`'s and `siteAccess.ts`'s:
 * **anything the client hides, the server must also refuse; never the
 * converse.** `requireWritten` in `src/lib/api/errors.ts` is the backstop that
 * makes getting it wrong loud rather than silent.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE PARITY. `validateProductDraft` trims with plain `.trim()`.
 * Unlike names on `nodes`, `products.sku` and `products.name` have NO
 * server-side `app_trim_ws` trigger (migration 0011 touches the hierarchy RPCs
 * only — checked, not assumed), so what this function sends is what the table
 * stores, and `unique (org_id, sku)` will happily hold both `"WX"` and
 * `"WX "` forever. Trimming here is therefore the only trim there is.
 */
import type { AdminProduct, SchedulerError } from "@/lib/api";
import { isHexColorToken, productColorCss } from "@/lib/productColor";

/* ===========================================================================
 * §1. The palette.
 * ======================================================================== */

/**
 * ⭐⭐ EXACTLY FOUR, AND THIS IS NOT A PLACEHOLDER.
 *
 * `src/styles/tokens.css` defines `--product-1` through `--product-4` and
 * nothing else. A fifth token is a perfectly well-formed string that the CHECK
 * constraint accepts and that renders as **no colour at all** — 0023 §3
 * records that `app_product_palette()` shipped at eight entries against this
 * same four-wide stylesheet and only the upgrade test caught it.
 *
 * ⛔ THE SERVER'S COPY IS UNREADABLE FROM HERE. `app_product_palette()` is
 * `revoke execute ... from public` and granted to nobody (0023 §3), on purpose
 * — it is reachable only from the DEFINER trigger. So this list is a
 * DELIBERATE MIRROR of a database value, not a cache of one, and the only way
 * to keep the two honest is to move them together:
 *
 *   WIDENING THE PALETTE IS THREE EDITS IN ONE COMMIT —
 *     1. `src/styles/tokens.css`        (`--product-N`)
 *     2. `app_product_palette()`        (migration)
 *     3. THIS ARRAY
 *   plus the SQL case **Q31**, which pins that the function and the stylesheet
 *   are the same width. Changing any one alone gives some product no colour.
 */
export const PRODUCT_PALETTE: readonly string[] = [
  "product-1",
  "product-2",
  "product-3",
  "product-4",
];

/** The token used for anything this client cannot resolve. See `productColorVar`. */
export const FALLBACK_COLOR_TOKEN = PRODUCT_PALETTE[0];

/**
 * Does `tokens.css` define a custom property for this token?
 *
 * A type PREDICATE rather than a plain boolean, so `productColorVar` can use
 * the answer without a cast — the narrowing is the honest expression of what
 * this function establishes.
 */
export function isPaletteToken(token: string | null | undefined): token is string {
  return typeof token === "string" && PRODUCT_PALETTE.includes(token);
}

/**
 * A token name turned into the CSS value that renders it.
 *
 * ⭐ FALLS BACK ON AN UNKNOWN TOKEN, NOT ONLY ON A MISSING ONE. `product-5`
 * is the failure this exists for: it passes the CHECK constraint, it survives
 * every guard as a string, and `var(--product-5)` resolves to nothing — a
 * product rendered in no colour, which reads as a design choice rather than as
 * a bug. Anything outside the four falls back to the first token instead.
 */
export function productColorVar(token: string | null | undefined): string {
  // ⭐ ONE RULE, ONE FILE (`src/lib/productColor.ts`). This used to be written
  // out here AND in `BoardGrid.tsx` AND in `BoardToolbar.tsx`, with a comment
  // on the board copies saying they were "kept in step with" this one — which
  // is D100's defect exactly: every declaration correct, and the defect was
  // that there were three of them. 0025 §2 added a second branch to the rule,
  // which is the edit that would have made them disagree.
  return productColorCss(token);
}

/* ===========================================================================
 * §2. Where a product is MADE — the list `product_sites`, D115 / migration 0034.
 *
 * ⭐ D115. The single `site_node_id` is gone. A product belongs to a LIST of
 * places (`AdminProduct.siteNodeIds`), because a part number is company-wide and
 * the company decides which plants make it — one, several or all. Resolving a
 * place id to a NAME is the panel's job (it holds the node tree and uses
 * `scope.ts`'s `scopeLabel`); this module carries the ids through and owns the
 * skip-and-count and the permission previews.
 * ======================================================================== */

/* ===========================================================================
 * §3. The list — skip and count, never blank.
 * ======================================================================== */

/** One product as the panel renders it: the row, plus what the screen adds. */
export interface ProductRow extends AdminProduct {
  /** The CSS value for the swatch — already fallen back if the token is unknown. */
  colorVar: string;
  /** True when `colorToken` is not one `tokens.css` defines. Surfaced, not hidden. */
  colorUnknown: boolean;
}

export interface ProductView {
  rows: readonly ProductRow[];
  /** How many rows arrived in a shape this client could not read. */
  skipped: number;
}

/**
 * The skip-and-count guard (brief rule 3).
 *
 * `fetchAdminProducts` runs each raw row through `parseAdminProduct` and hands
 * the results on WITH THE NULLS STILL IN, precisely so this function can tell
 * "three rows I could not read" from "three rows that are not there". One
 * malformed product must never blank the catalogue, and it must never vanish
 * silently either — the panel prints the count.
 *
 * ⭐ D115 REMOVED THE "elsewhere" DROP. Before 0034 a product could arrive owned
 * by a site the reader could not see (the board-history read exception leaking
 * into the catalogue), and this function filtered it out and counted it. Under
 * 0034 `products_select` admits a product only when the reader is a company
 * admin or one of its plants is on their own branch — so every product that
 * arrives here legitimately belongs to this reader's world, and there is nothing
 * to drop. A part with an empty `siteNodeIds` (assigned to no plant, or all its
 * plants outside this reader's view) is still shown: it is a real catalogue
 * entry, and hiding it would be the silent-hiding failure `scope.ts` warns of.
 *
 * NEVER THROWS. It is called during render.
 *
 * Order is the server's (`ORDER BY sku`), deliberately preserved: re-sorting
 * here would mean two lists that can disagree, and the DB's collation is the
 * one the SQL tests assert on.
 */
export function productRows(parsed: ReadonlyArray<AdminProduct | null>): ProductView {
  const rows: ProductRow[] = [];
  let skipped = 0;
  for (const p of parsed) {
    if (p === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      ...p,
      colorVar: productColorVar(p.colorToken),
      // A HEX IS NOT UNKNOWN. This flag drives the "this colour is not one the
      // board defines" warning, and after 0025 a hand-set hex is both perfectly
      // legal and perfectly drawable — warning about it would be the screen
      // complaining about a value it just helped somebody choose.
      colorUnknown: !isPaletteToken(p.colorToken) && !isHexColorToken(p.colorToken),
    });
  }
  return { rows, skipped };
}

/**
 * The catalogue split the way the screen shows it: what is being made, and
 * what has been retired.
 *
 * Deactivate is the MAIN action here (the maintainer's call), so "inactive" is a
 * populated, ordinary part of this screen rather than an edge case — a
 * deactivated product is still on every run it has ever been on.
 */
export function partitionProducts(rows: readonly ProductRow[]): {
  active: readonly ProductRow[];
  inactive: readonly ProductRow[];
} {
  return {
    active: rows.filter((r) => r.active),
    inactive: rows.filter((r) => !r.active),
  };
}

/** Substring match on sku or name, both sides trimmed and case-folded. */
export function matchesProductQuery(row: ProductRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return row.sku.toLowerCase().includes(q) || row.name.toLowerCase().includes(q);
}

/* ===========================================================================
 * §4. Permission previews — the Split decision, migration 0034 §9.
 *
 * ⭐⭐ THE SPLIT (the maintainer, 1 Sept). A part number is company-wide, so a
 * rename touches every plant that makes it — that is COMPANY property. Which
 * plants make it is per-plant. So the two are governed differently:
 *
 *   THE SHARED RECORD  (create, rename, recolour, delete)  -> company admin only
 *   THE LIST OF MAKERS (add / remove a plant)              -> a plant admin may
 *                                                             manage THEIR OWN
 *
 * `products_insert/update/delete` are now `app_is_admin()`; `product_sites`
 * insert/delete are `app_is_admin() OR app_is_admin_for(node_id)`.
 * ======================================================================== */

/**
 * May this reader change the shared record — rename, recolour, retire, delete,
 * or create a product at all?
 *
 * ⭐ D115: THIS IS NOW SIMPLY "ARE YOU A COMPANY ADMIN", and the client knows
 * that for certain (`role === 'admin'`, no grant read needed). Under the Split
 * the part number is company property; a site admin manages which plants make a
 * part, never the part's own identity. `updateProduct` / `deleteProduct` /
 * `createProduct` all land on an `app_is_admin()` policy, and a site admin's
 * attempt is refused as `WriteRefused` — the loud, recoverable half of §19.63.
 *
 * (This replaced a fail-open `canEditProduct(row, isCompanyAdmin, adminSiteIds,
 * adminAnywhere)`: with the write narrowed to company admins there is nothing
 * uncertain left to fail open on, so the certain answer is the honest one.)
 */
export function canEditProduct(isCompanyAdmin: boolean): boolean {
  return isCompanyAdmin;
}

/** Why the shared-record controls on this row are absent, in the row's terms. */
export function editRefusalNote(isCompanyAdmin: boolean): string | null {
  if (canEditProduct(isCompanyAdmin)) return null;
  return "Only a company admin can change a part number — but you can add or remove your own plant below.";
}

/**
 * Does this reader CERTAINLY administer this plant — so a place control on it is
 * sure to be accepted? `product_sites_insert`/`_delete` = `app_is_admin() OR
 * app_is_admin_for(node_id)` (D115, the Split).
 *
 * ⭐ THIS IS A POSITIVE HINT, NOT A GATE, and the distinction is the `canEdit`
 * lesson (§19.72a) restated: `adminNodeIds` is the COARSE client set (roots this
 * person administers) and the server's `app_is_admin_for` walks ancestors, so a
 * LINE inside an administered plant is theirs to the server and NOT in this set.
 * Reading a `false` here as "hide the control" is exactly the fail-closed trap
 * that offered a site admin nothing at all. So the panel uses `true` to mark a
 * place it can show as certainly-yours, and still OFFERS place-adding broadly,
 * letting the server's `WriteRefused` be the answer for the uncertain rest — the
 * fail-open default every other preview in this file keeps.
 *
 * A `true` is a certainty (a company admin, or a node in the set); a `false` is
 * "not certain from here", never "refused".
 */
export function canManagePlace(
  nodeId: string,
  isCompanyAdmin: boolean,
  adminNodeIds: readonly string[],
): boolean {
  if (isCompanyAdmin) return true;
  return adminNodeIds.includes(nodeId);
}

/* ===========================================================================
 * §4b. COLOUR, WHEN IT IS NOT A PALETTE TOKEN (0025 §2, D102 amended).
 *
 * The maintainer, Aug 27: *"The color should show a colour picker and an ability to
 * enter hex code."*
 *
 * ⚠️ THE DATABASE ACCEPTS TWO SHAPES AND THIS CLIENT MUST DISTINGUISH THEM,
 * because they render differently: a token becomes `var(--product-N)` and
 * follows the stylesheet, a hex is used as written and does not. One character
 * tells them apart, and the CHECK guarantees nothing else can arrive.
 * ======================================================================== */

/**
 * Is this a literal colour rather than a palette token?
 *
 * ⚠️ ANCHORED, and mutation S8 on the server side is why. An unanchored test
 * calls `"teal #1baf7a"` a hex, and that string is exactly what a paste from a
 * design tool looks like.
 *
 * Delegates to `isHexColorShape` above rather than repeating the regex: two
 * copies of a shape rule is [[D100]]'s defect in miniature.
 */
export function isHexColor(token: string | null | undefined): token is string {
  return isHexColorToken(token);
}

/**
 * What a person typed, turned into what the column will accept — or `null` if
 * it will not.
 *
 * ⭐ IT IS LENIENT ABOUT THE THINGS A PERSON ACTUALLY TYPES AND STRICT ABOUT
 * WHAT IT STORES. `#1BAF7A`, `1baf7a` and ` #1baf7a ` are all the colour the
 * user meant and none of them is storable; the CHECK takes exactly one
 * spelling, so this is the one place that normalises to it. Rejecting a typed
 * `#1BAF7A` with "that value isn't allowed here" would be technically correct
 * and indefensible.
 *
 * ⚠️ THREE-DIGIT FORM IS EXPANDED, NOT REFUSED. `#1ba` is a colour every design
 * tool will hand you. Expanding it here keeps one canonical spelling in the
 * column, which is what stops `#FFF` and `#ffffff` being two rows meaning one
 * thing — the reason the server refuses the short form at all.
 */
export function normaliseHexInput(typed: string): string | null {
  const t = typed.trim().toLowerCase();
  const body = t.startsWith("#") ? t.slice(1) : t;
  if (/^[0-9a-f]{3}$/.test(body)) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(body)) return `#${body}`;
  return null;
}

/**
 * The value an `<input type="color">` needs, for any stored colour.
 *
 * That control has no concept of a token and no empty state — it must be handed
 * a six-digit hex or it silently shows black. A token has no hex on this side
 * (it lives in `tokens.css`), so the caller passes the computed value it
 * already reads off the row; this only guards the shape.
 */
export function colorInputValue(token: string, computedHex: string | null): string {
  if (isHexColor(token)) return token;
  return isHexColor(computedHex) ? computedHex : "#000000";
}

/* ===========================================================================
 * §5. The draft — what a form may send.
 * ======================================================================== */

export interface ProductDraft {
  sku: string;
  name: string;
}

export interface ProductDraftValues {
  sku: string;
  name: string;
}

export type ProductDraftResult =
  | { ok: true; value: ProductDraftValues }
  | { ok: false; skuError: string | null; nameError: string | null };

/**
 * `products.sku` and `products.name` are both plain `text NOT NULL` with no
 * length limit and no CHECK — the database will accept a 40 000-character sku
 * and a sku made entirely of spaces. These bounds are therefore the CLIENT's,
 * chosen so a typo cannot become permanent: `unique (org_id, sku)` is
 * case-sensitive and whitespace-sensitive, so `"WX "` and `"WX"` coexist
 * forever and the second one can never be created cleanly afterwards.
 */
export const SKU_MAX_LENGTH = 64;
export const NAME_MAX_LENGTH = 120;

/**
 * Trim, refuse blanks, refuse a sku with whitespace inside it.
 *
 * ⚠️ CASE IS **NOT** NORMALISED, and that is a decision rather than an
 * omission. Upper-casing here would silently rewrite what somebody typed, and
 * the unique index is case-SENSITIVE — so `wx-1` and `WX-1` are two products
 * either way, and the honest place to notice that is the duplicate the server
 * raises (`23505` -> `DuplicateValue`), not a silent transformation of the
 * user's input on the way in.
 *
 * Returns EVERY problem at once, not the first: a form that reveals its
 * second complaint only after you fix the first is the thing this shape
 * avoids.
 */
export function validateProductDraft(draft: ProductDraft): ProductDraftResult {
  const sku = draft.sku.trim();
  const name = draft.name.trim();

  let skuError: string | null = null;
  let nameError: string | null = null;

  if (sku === "") {
    skuError = "A product code is required.";
  } else if (sku.length > SKU_MAX_LENGTH) {
    skuError = `A product code can be at most ${SKU_MAX_LENGTH} characters.`;
  } else if (/\s/.test(sku)) {
    // Interior whitespace only — the ends are already gone. A code with a
    // space in it is almost always a paste artefact, and `unique (org_id, sku)`
    // makes it permanent.
    skuError = "A product code can't contain spaces.";
  }

  if (name === "") {
    nameError = "A name is required.";
  } else if (name.length > NAME_MAX_LENGTH) {
    nameError = `A name can be at most ${NAME_MAX_LENGTH} characters.`;
  }

  // ⭐ D115 REMOVED THE OWNER REQUIREMENT (0028 had made it required). A product
  // is the company-wide record — sku and name — and which plants make it is
  // managed separately through `product_sites`, so there is no place to choose
  // on the create form and nothing to refuse for its absence. A just-created
  // part offered nowhere is a legitimate state, not an incomplete form.
  if (skuError !== null || nameError !== null) {
    return { ok: false, skuError, nameError };
  }
  return { ok: true, value: { sku, name } };
}

/* ===========================================================================
 * §6. Saying what is in the way.
 * ======================================================================== */

/* ⚠️ `describeDeleteRefusal` LIVED HERE AND 0029 DELETED IT, rather than
 * fixing it. It turned a delete refusal into a sentence with a way out, and
 * both of its branches stopped being true:
 *
 *   - `StillInUse` said "Deactivate it instead — it stays on the work it's
 *     already on". That was the whole shape of delete before D110: anything
 *     ever scheduled could NEVER be deleted. `delete_owned_row` now removes
 *     what has not started and keeps what has, so the refusal it explained
 *     does not arrive any more.
 *   - `WriteRefused` said "Company-wide products can only be changed by a
 *     company admin." There has been no company-wide product since D108
 *     (0028). It compiled, it was tested, and it had been wrong for a day —
 *     which is §19.72a lesson 2 exactly: a compiler cannot see a sentence.
 *
 * Narrowing it would have left a helper that still knows how to say
 * "company-wide", which is the argument 0028 used for deleting `ownerOptions`
 * rather than filtering it. `DeleteDialog` asks the server what is at stake
 * and says that instead.
 */

/**
 * The same, for a create or an edit. A duplicate sku is the one refusal a
 * supervisor can act on themselves, and `DuplicateValue`'s generic sentence
 * ("Something here already uses that name or code.") does not say which field.
 */
export function describeWriteRefusal(err: SchedulerError, described: string): string {
  switch (err.kind) {
    case "DuplicateValue":
      return "Another product in this company already uses that product code.";
    case "InvalidValue":
      // `products_color_token_shape` is the only CHECK on this table, and the
      // client never sends that column — so this is a schema change nobody
      // taught this screen about, not something the user typed.
      return `${described} Nothing on this form should be able to cause that — please report it.`;
    default:
      return described;
  }
}
