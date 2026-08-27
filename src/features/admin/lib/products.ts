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
 * §2. Owners — `site_node_id`, where `null` is a value and not an absence.
 * ======================================================================== */

/** One site a product can belong to: a ROOT node of the org (0023 §2's trigger). */
export interface ProductSite {
  id: string;
  name: string;
}

/**
 * What a company-wide product is called on screen.
 *
 * `site_node_id IS NULL` means the whole company owns it (0023's own column
 * comment). Rendering that as an empty cell was the first draft and it read as
 * missing data; it is a deliberate, meaningful state and it says so.
 */
export const COMPANY_WIDE_LABEL = "Company-wide";

/** What an owner id that is not in the sites list is called. See `productRows`. */
export const UNKNOWN_SITE_LABEL = "Another site";

/**
 * ⚠️ AN UNRESOLVED OWNER IS NOT AN ERROR. Reads on `products` are org-wide but
 * `nodes_select` is not: a site admin can see every product in the company and
 * only the nodes inside their own site, so a product owned by Plant 2 arrives
 * with an owner id they cannot name. "Another site" is the truthful answer;
 * inventing a name or showing a raw uuid are both worse.
 */
export function ownerLabel(
  siteNodeId: string | null,
  sites: readonly ProductSite[],
): string {
  if (siteNodeId === null) return COMPANY_WIDE_LABEL;
  const site = sites.find((s) => s.id === siteNodeId);
  return site === undefined ? UNKNOWN_SITE_LABEL : site.name;
}

/* ===========================================================================
 * §3. The list — skip and count, never blank.
 * ======================================================================== */

/** One product as the panel renders it: the row, plus what the screen adds. */
export interface ProductRow extends AdminProduct {
  /** `ownerLabel(siteNodeId, sites)`, resolved once so the JSX has no logic. */
  owner: string;
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
 * NEVER THROWS. It is called during render.
 *
 * Order is the server's (`ORDER BY sku`), deliberately preserved: re-sorting
 * here would mean two lists that can disagree, and the DB's collation is the
 * one the SQL tests assert on.
 */
export function productRows(
  parsed: ReadonlyArray<AdminProduct | null>,
  sites: readonly ProductSite[],
): ProductView {
  const rows: ProductRow[] = [];
  let skipped = 0;
  for (const p of parsed) {
    if (p === null) {
      skipped += 1;
      continue;
    }
    rows.push({
      ...p,
      owner: ownerLabel(p.siteNodeId, sites),
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
 * Deactivate is the MAIN action here (Pratik's call), so "inactive" is a
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
 * §4. Permission previews — a mirror of the three policies in 0023 §5.
 * ======================================================================== */

/**
 * The insert/update/delete policies are all the same predicate:
 *
 *   org_id = app_current_org()
 *   AND (app_is_admin()
 *        OR (site_node_id IS NOT NULL AND app_is_admin_for(site_node_id)))
 *
 * Read plainly: **a site admin can create, edit and delete their own site's
 * products, and cannot touch a company-wide one.** The org term is not
 * mirrored here — every product this client ever sees came from an org-scoped
 * read, so a second copy of a check that always holds could not be tested
 * (gotcha 17) and would only be one more thing to keep in step.
 *
 * `adminSiteIds` is the set of SITE root nodes this person administers,
 * derived on screen from `editable_shape_ids()` (0021 §2) — itself a PREVIEW
 * that restricts nothing. Which is the whole point: this function answers
 * "should the button be live", never "may this write happen". The server
 * re-asks, and `requireWritten` catches the silent half of its answer.
 */
export function canOwnProduct(
  siteNodeId: string | null,
  isCompanyAdmin: boolean,
  adminSiteIds: readonly string[],
): boolean {
  if (isCompanyAdmin) return true;
  if (siteNodeId === null) return false;
  return adminSiteIds.includes(siteNodeId);
}

/**
 * Whether this person may rename, deactivate or delete this exact product.
 *
 * ⭐⭐ THIS FAILS OPEN FOR A SITE ADMIN NOW, AND THE CHANGE IS DELIBERATE.
 *
 * It used to be `canOwnProduct(...)`, i.e. "is this product's scope one of the
 * sites I administer" — with `adminSiteIds` derived from which STRUCTURES this
 * person may edit (`editable_shape_ids()`). The adversarial review of 27 Aug
 * measured that those are not the same question: the product policies ask
 * `app_is_admin_for(site_node_id)`, which reads node GRANTS and never touches
 * `hierarchy_templates`. A site whose root has no claimed structure — which
 * 0020's `having count(*) = 1` backfill deliberately creates for any shared
 * shape — dropped out of `adminSiteIds` while remaining fully writable on the
 * server. The error was one-directional and it was the CLOSED direction: a
 * whole screen dead for exactly the people the feature exists for.
 *
 * ⚠️ AND 0025 MADE IT WORSE BEFORE IT MADE IT BETTER. Under D103 a scope can be
 * any node, so "is the scope one of my sites" is not even the right shape of
 * question any more — a product scoped to a line inside a site I administer is
 * mine to edit, and a root-id list cannot say so.
 *
 * ⭐ SO THE DEFAULT FLIPS, AND [[verification-standard]] RULE 8b IS WHY: ask
 * what the answer buys. When this was written a refused write said
 * *"You need to sign in to do that"* or silently did nothing, so guessing
 * wrong meant a screen that lied. §19.63's contract changed that — a refusal
 * now arrives as `WriteRefused` and reads *"You don't have permission to change
 * this."* **A wrong "yes" is now one clear sentence; a wrong "no" is still
 * invisible and permanent.**
 *
 * A company admin is unaffected. Someone who administers NOWHERE still gets
 * `false`, because that answer needs no grant read to be certain of.
 */
export function canEditProduct(
  row: Pick<AdminProduct, "siteNodeId">,
  isCompanyAdmin: boolean,
  adminSiteIds: readonly string[],
  adminAnywhere = false,
): boolean {
  if (canOwnProduct(row.siteNodeId, isCompanyAdmin, adminSiteIds)) return true;
  // Company-wide rows stay company-admin-only: that one IS knowable from the
  // profile role alone, with no grant lookup, so there is nothing to fail open
  // about.
  if (row.siteNodeId === null) return false;
  return adminAnywhere;
}

/** Why the controls on this row are dead, in the row's own terms. */
export function editRefusalNote(
  row: Pick<AdminProduct, "siteNodeId">,
  isCompanyAdmin: boolean,
  adminSiteIds: readonly string[],
  adminAnywhere = false,
): string | null {
  if (canEditProduct(row, isCompanyAdmin, adminSiteIds, adminAnywhere)) return null;
  // With `canEditProduct` failing open for anyone who administers somewhere,
  // the only note left is the one that needs no grant read to be sure of.
  return row.siteNodeId === null
    ? "Company-wide — only a company admin can change this."
    : "You don't administer anywhere, so this is read-only.";
}

/**
 * The owners this person may create a product under, in the order the picker
 * offers them.
 *
 * A company admin gets company-wide plus every site; a site admin gets only
 * the sites they administer, and NOT company-wide — the insert policy refuses
 * that, and offering it would be a form that fails on submit.
 */
export function ownerOptions(
  sites: readonly ProductSite[],
  isCompanyAdmin: boolean,
  adminSiteIds: readonly string[],
): ReadonlyArray<{ value: string | null; label: string }> {
  const options: Array<{ value: string | null; label: string }> = [];
  if (isCompanyAdmin) options.push({ value: null, label: COMPANY_WIDE_LABEL });
  for (const site of sites) {
    if (isCompanyAdmin || adminSiteIds.includes(site.id)) {
      options.push({ value: site.id, label: site.name });
    }
  }
  return options;
}

/* ===========================================================================
 * §4b. COLOUR, WHEN IT IS NOT A PALETTE TOKEN (0025 §2, D102 amended).
 *
 * Pratik, Aug 27: *"The color should show a colour picker and an ability to
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
  /** `null` = company-wide. */
  siteNodeId: string | null;
}

export interface ProductDraftValues {
  sku: string;
  name: string;
  siteNodeId: string | null;
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

  if (skuError !== null || nameError !== null) {
    return { ok: false, skuError, nameError };
  }
  return { ok: true, value: { sku, name, siteNodeId: draft.siteNodeId } };
}

/* ===========================================================================
 * §6. Saying what is in the way.
 * ======================================================================== */

/**
 * What the panel says when a DELETE is refused.
 *
 * `described` is `describeSchedulerError(err)` — passed IN rather than
 * imported, because that function lives in `@/lib/api` and this module has no
 * runtime imports at all. It already names the referencing table for a
 * `StillInUse` ("It's still used by runs, so it can't be deleted."), lifted
 * from the `23503` detail line, so this function's whole job is to add the way
 * out rather than to re-describe the problem.
 *
 * ⭐ AND THE WAY OUT IS THE POINT. `runs` and `assignments` reference
 * `(org_id, product_id)` with NO `ON DELETE`, so any product that has ever
 * been scheduled can never be deleted — which is correct, and is exactly why
 * deactivate is the main action and delete is the secondary one. Telling
 * somebody only that it failed leaves them clicking it again.
 */
export function describeDeleteRefusal(err: SchedulerError, described: string): string {
  switch (err.kind) {
    case "StillInUse":
      return `${described} Deactivate it instead — it stays on the work it's already on, and stops being offered for new.`;
    case "WriteRefused":
      return `${described} Company-wide products can only be changed by a company admin.`;
    default:
      return described;
  }
}

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
