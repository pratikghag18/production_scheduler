/**
 * Acceptance suite for `src/features/admin/lib/products.ts` — the client half
 * of the products catalogue (D102 §19.62; D115 §19.81, migration 0034).
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`. One plain `it()` per case, never
 * `it.each`: a table-driven case that fails names the table, not the rule that
 * broke, and this file exists to name the rule.
 *
 * ⭐ WHAT IS UNDER TEST IS THE PURE MODULE, NOT THE PANEL. `ProductsPanel.tsx`
 * renders what these functions return and decides nothing itself; the api
 * layer (`src/lib/api/products.ts`) imports `@/lib/supabase` and is covered by
 * `tsc`/`eslint` rather than here.
 *
 * ⭐⭐ D115 / migration 0034 RESHAPED THIS FILE. A product no longer has a single
 * owner: `site_node_id` became a LIST, `AdminProduct.siteNodeIds`. So:
 *   - `productRows` no longer takes a `sites` list and has no "elsewhere" drop:
 *     the read policy now admits only products that legitimately belong to this
 *     reader's world (see the lib header). Owner-name resolution moved to the
 *     PANEL (`scope.ts`'s `scopeLabel`), so `ownerLabel`/`ProductSite` are gone.
 *   - The write preview is the SPLIT decision: the shared record is company-admin
 *     only (`canEditProduct(isCompanyAdmin)`), and a plant admin manages their own
 *     plant's membership (`canManagePlace`). `canOwnProduct` is gone.
 *   - `validateProductDraft` no longer has an owner field or an ownerError.
 * Every case that turned on the single owner was rewritten or removed with a
 * note; grep for "D115".
 *
 *   WX  product-1   active
 *   WY  product-2   active
 *   GZ  product-3   inactive
 *   RW  product-9   active     <- a token tokens.css never defines
 */
import { describe, expect, it } from "vitest";
import type { AdminProduct, SchedulerError } from "@/lib/api";
import {
  FALLBACK_COLOR_TOKEN,
  NAME_MAX_LENGTH,
  PRODUCT_PALETTE,
  SKU_MAX_LENGTH,
  canEditProduct,
  canManagePlace,
  describeWriteRefusal,
  editRefusalNote,
  isHexColor,
  isPaletteToken,
  matchesProductQuery,
  normaliseHexInput,
  partitionProducts,
  productColorVar,
  productRows,
  validateProductDraft,
  type ProductRow,
} from "../features/admin/lib/products.ts";

const PLANT_1 = "30000000-0000-0000-0000-000000000001";
const PLANT_2 = "30000000-0000-0000-0000-000000000002";
const LINE_1 = "30000000-0000-0000-0000-00000000000a";

function product(over: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "60000000-0000-0000-0000-000000000001",
    sku: "WX",
    name: "Widget X",
    active: true,
    source: "manual",
    externalId: null,
    siteNodeIds: [PLANT_1],
    colorToken: "product-1",
    ...over,
  };
}

const WX = product();
const WY = product({ id: "p-wy", sku: "WY", name: "Widget Y", colorToken: "product-2" });
const GZ = product({
  id: "p-gz",
  sku: "GZ",
  name: "Gadget Z",
  siteNodeIds: [PLANT_2],
  colorToken: "product-3",
  active: false,
});
const RW = product({ id: "p-rw", sku: "RW", name: "Rework", colorToken: "product-9" });

const ALL = [WX, WY, GZ, RW];

function rowsOf(parsed: ReadonlyArray<AdminProduct | null> = ALL): readonly ProductRow[] {
  return productRows(parsed).rows;
}

function rowFor(sku: string): ProductRow {
  const row = rowsOf().find((r) => r.sku === sku);
  if (row === undefined) throw new Error(`fixture has no ${sku}`);
  return row;
}

/* ===========================================================================
 * Group P — the palette. Four, because tokens.css defines four.
 * ======================================================================== */

describe("the palette", () => {
  // P1 — the case that would have caught the eight-vs-four ship (0023 §3).
  it("P1: is exactly four tokens wide", () => {
    expect(PRODUCT_PALETTE.length).toBe(4);
  });

  it("P2: is product-1 through product-4, in order", () => {
    expect([...PRODUCT_PALETTE]).toEqual(["product-1", "product-2", "product-3", "product-4"]);
  });

  it("P3: every token matches the products_color_token_shape CHECK", () => {
    const shape = /^product-[1-9][0-9]*$/;
    expect(PRODUCT_PALETTE.every((t) => shape.test(t))).toBe(true);
  });

  it("P4: the fallback token is one the palette actually contains", () => {
    expect(PRODUCT_PALETTE.includes(FALLBACK_COLOR_TOKEN)).toBe(true);
  });

  it("P5: isPaletteToken accepts a token the stylesheet defines", () => {
    expect(isPaletteToken("product-3")).toBe(true);
  });

  // P6 — `product-5` passes the DB CHECK and renders as nothing at all.
  it("P6: isPaletteToken rejects a well-formed token beyond the fourth", () => {
    expect(isPaletteToken("product-5")).toBe(false);
  });

  it("P7: isPaletteToken rejects an empty string", () => {
    expect(isPaletteToken("")).toBe(false);
  });

  it("P8: isPaletteToken rejects null", () => {
    expect(isPaletteToken(null)).toBe(false);
  });

  it("P9: isPaletteToken rejects a hex colour, which is never a token", () => {
    expect(isPaletteToken("#2a78d6")).toBe(false);
  });

  it("P10: productColorVar renders a known token as its custom property", () => {
    expect(productColorVar("product-2")).toBe("var(--product-2)");
  });

  // P11 — the whole reason the fallback exists: no colour reads as a design
  // choice, not as a bug.
  it("P11: productColorVar falls back for a token past the fourth", () => {
    expect(productColorVar("product-9")).toBe("var(--product-1)");
  });

  it("P12: productColorVar falls back for an absent token", () => {
    expect(productColorVar(null)).toBe("var(--product-1)");
  });

  it("P13: productColorVar falls back for an empty token", () => {
    expect(productColorVar("")).toBe("var(--product-1)");
  });
});

/* ⭐ GROUP O — owner labelling (O1–O5) WENT WITH `ownerLabel` IN D115.
 *
 * A product had a single owner and this module resolved its NAME. Now a product
 * has a LIST of places, and resolving a place id to a name is the panel's job
 * (`scope.ts`'s `scopeLabel`, exercised by `scope.test.ts` and the panel suite).
 * There is nothing left in this module to label.
 */

/* ===========================================================================
 * Group L — the list. Skip and count; never blank, never silent.
 *
 * ⭐ D115 REMOVED THE `sites` ARGUMENT AND THE "elsewhere" DROP. Before 0034 a
 * product could arrive owned by a site the reader could not see (the board's
 * history read exception leaking into the catalogue) and this function filtered
 * and counted it. 0034's `products_select` admits a product only when the reader
 * is a company admin or one of its plants is on their own branch, so every
 * product that arrives here belongs here. What remains is skip-and-count.
 * ======================================================================== */

describe("productRows", () => {
  it("L1: keeps every readable row", () => {
    expect(productRows(ALL).rows.length).toBe(4);
  });

  it("L2: counts nothing skipped when every row parsed", () => {
    expect(productRows(ALL).skipped).toBe(0);
  });

  // L3/L4 — the pair that matters: a malformed row must not blank the panel,
  // and must not vanish without a trace either.
  it("L3: a malformed row does not remove the readable ones", () => {
    expect(productRows([WX, null, WY]).rows.map((r) => r.sku)).toEqual(["WX", "WY"]);
  });

  it("L4: a malformed row is counted", () => {
    expect(productRows([WX, null, WY]).skipped).toBe(1);
  });

  it("L5: counts every malformed row, not just the first", () => {
    expect(productRows([null, WX, null, null]).skipped).toBe(3);
  });

  it("L6: an all-malformed payload yields no rows and a full count", () => {
    expect(productRows([null, null])).toEqual({ rows: [], skipped: 2 });
  });

  it("L7: an empty payload is not an error", () => {
    expect(productRows([])).toEqual({ rows: [], skipped: 0 });
  });

  it("L8: preserves the server's sku ordering rather than re-sorting", () => {
    expect(rowsOf().map((r) => r.sku)).toEqual(["WX", "WY", "GZ", "RW"]);
  });

  // L9 (owner label) went with the single owner — see the Group O note.

  it("L10 ⭐ (D115): a product assigned to NO plant is still shown — it is a real state", () => {
    // An empty places list is a legitimate catalogue entry (a part not yet
    // assigned to any plant), never a reason to hide it. `productRows` no longer
    // drops anything for where it belongs; that is the board's offering, not the
    // catalogue's listing.
    const placeless = product({ sku: "PL", siteNodeIds: [] });
    const view = productRows([WX, placeless]);
    expect(view.rows.map((r) => r.sku)).toEqual(["WX", "PL"]);
    expect(view.skipped).toBe(0);
  });

  it("L11: resolves each row's colour to a CSS value", () => {
    expect(rowFor("GZ").colorVar).toBe("var(--product-3)");
  });

  it("L12: flags a row whose token the stylesheet does not define", () => {
    expect(rowFor("RW").colorUnknown).toBe(true);
  });

  it("L13: a flagged row still gets a renderable colour", () => {
    expect(rowFor("RW").colorVar).toBe("var(--product-1)");
  });

  it("L14: a row with a known token is not flagged", () => {
    expect(rowFor("WX").colorUnknown).toBe(false);
  });

  it("L15: carries the underlying row through unchanged, places and all", () => {
    expect(rowFor("GZ").id).toBe("p-gz");
    expect(rowFor("GZ").siteNodeIds).toEqual([PLANT_2]);
  });
});

describe("partitionProducts", () => {
  it("L16: puts what is still made in `active`", () => {
    expect(partitionProducts(rowsOf()).active.map((r) => r.sku)).toEqual(["WX", "WY", "RW"]);
  });

  it("L17: puts what has been retired in `inactive`", () => {
    expect(partitionProducts(rowsOf()).inactive.map((r) => r.sku)).toEqual(["GZ"]);
  });

  it("L18: loses nothing across the split", () => {
    const { active, inactive } = partitionProducts(rowsOf());
    expect(active.length + inactive.length).toBe(4);
  });
});

describe("matchesProductQuery", () => {
  it("L19: an empty query matches everything", () => {
    expect(matchesProductQuery(rowFor("WX"), "")).toBe(true);
  });

  it("L20: a whitespace-only query matches everything", () => {
    expect(matchesProductQuery(rowFor("WX"), "   ")).toBe(true);
  });

  it("L21: matches on sku, case-insensitively", () => {
    expect(matchesProductQuery(rowFor("WY"), "wy")).toBe(true);
  });

  it("L22: matches on name", () => {
    expect(matchesProductQuery(rowFor("GZ"), "gadget")).toBe(true);
  });

  it("L23: does not match an unrelated term", () => {
    expect(matchesProductQuery(rowFor("GZ"), "widget")).toBe(false);
  });

  /* ⭐ L24–L29 (the "foreign product is not your catalogue" filter) WENT WITH
   * the "elsewhere" drop in D115 — see the Group L header. There is no foreign
   * product in a reader's catalogue any more: the read policy does not admit
   * one, so there is nothing for this module to filter. */
});

/* ===========================================================================
 * Group W — who may write. The SPLIT (D115) as reopened by D116 (2 Sept).
 *
 * D115 made the shared record (create/rename/recolour/delete) COMPANY property
 * and the list of makers per-plant. D116 hands a site admin the WHOLE lifecycle
 * of a part made only within their own plants: they may create it (at a plant
 * they administer) and rename/recolour/delete it while no other plant makes it.
 * The moment a second plant adopts it, its identity is company property again.
 * ======================================================================== */

describe("canEditProduct — a part wholly made in your own plants (D116)", () => {
  // The reader administers Plant 1 and, by ancestor walk, the line under it.
  const adminOfPlant1 = (nodeId: string) => nodeId === PLANT_1 || nodeId === LINE_1;

  it("W1: a company admin may change any shared record, whatever its makers", () => {
    expect(canEditProduct(true, [PLANT_2], () => false)).toBe(true);
    expect(canEditProduct(true, [], () => false)).toBe(true);
  });

  // W2 ⭐ (D116): the headline change. A site admin MAY rename/recolour/delete a
  // part — but only one made entirely within plants they administer (the client
  // mirror of the server's app_can_edit_product_record).
  it("W2 ⭐: a site admin may change a part made only in plants they administer", () => {
    expect(canEditProduct(false, [PLANT_1], adminOfPlant1)).toBe(true);
    expect(canEditProduct(false, [PLANT_1, LINE_1], adminOfPlant1)).toBe(true);
  });

  it("W2b ⭐: but NOT once another plant also makes it — company property again", () => {
    expect(canEditProduct(false, [PLANT_1, PLANT_2], adminOfPlant1)).toBe(false);
  });

  it("W2c: nor a part they make none of", () => {
    expect(canEditProduct(false, [PLANT_2], adminOfPlant1)).toBe(false);
  });

  // W3 ⭐ — an orphan part (assigned to no plant, or all its plants foreign to
  // this reader) is company property, matching the server's "at least one maker
  // AND I administer every one". A company admin is unaffected.
  it("W3 ⭐: an orphan part (no visible makers) is company property to a site admin", () => {
    expect(canEditProduct(false, [], adminOfPlant1)).toBe(false);
    expect(canEditProduct(true, [], adminOfPlant1)).toBe(true);
  });
});

describe("canManagePlace — a plant admin manages their own plant's membership", () => {
  it("W4: a company admin may manage any plant, with no grants at all", () => {
    expect(canManagePlace(PLANT_2, true, [])).toBe(true);
  });

  it("W5: a plant admin may manage a plant they administer", () => {
    expect(canManagePlace(PLANT_1, false, [PLANT_1])).toBe(true);
  });

  it("W6: and is not CERTAIN about a plant they do not administer", () => {
    expect(canManagePlace(PLANT_2, false, [PLANT_1])).toBe(false);
  });

  // W7 ⭐ — the `canEdit` lesson pinned. A `false` here is "not certain from
  // here", NEVER "refused": `adminNodeIds` is the coarse set (roots), so a LINE
  // inside an administered plant is theirs to the server and false here. The
  // panel must still OFFER place-adding and let the server decide — reading this
  // false as "hide it" is exactly the fail-closed trap §19.72a records.
  it("W7 ⭐: a line inside an administered plant is not CERTAIN from the coarse set", () => {
    expect(canManagePlace(LINE_1, false, [PLANT_1])).toBe(false);
    // ...and a company admin is certain regardless.
    expect(canManagePlace(LINE_1, true, [])).toBe(true);
  });
});

describe("editRefusalNote (D116)", () => {
  const adminOfPlant1 = (nodeId: string) => nodeId === PLANT_1;

  it("W8: says nothing when the reader may change the record", () => {
    expect(editRefusalNote(true, [PLANT_2], () => false)).toBe(null);
    expect(editRefusalNote(false, [PLANT_1], adminOfPlant1)).toBe(null);
  });

  it("W9 ⭐: a part another plant shares is company-owned, and points at what they CAN do", () => {
    const note = editRefusalNote(false, [PLANT_1, PLANT_2], adminOfPlant1);
    expect(note).not.toBe(null);
    expect(note).toContain("Another plant");
    // ⭐ names the way through — a note that only refuses invites a support
    // ticket; this one says "you can add or remove your own plant".
    expect(note).toContain("plant");
  });

  it("W9b: a part they make none of is company-admin only, still pointing the way", () => {
    const note = editRefusalNote(false, [PLANT_2], adminOfPlant1);
    expect(note).not.toBe(null);
    expect(note).toContain("company admin");
    expect(note).toContain("plant");
  });
});

describe("colour: a token or a hex (0025 §2)", () => {
  it("W12d: a lower-case six-digit hex is a hex", () => {
    expect(isHexColor("#1baf7a")).toBe(true);
  });

  it("W12e: and nothing else is — the test is ANCHORED", () => {
    // ⚠️ Mutation S8 on the server found the unanchored version. A string that
    // CONTAINS a hex is what a paste from a design tool looks like.
    expect([
      isHexColor("teal #1baf7a"),
      isHexColor("#1BAF7A"),
      isHexColor("#1ba"),
      isHexColor("1baf7a"),
      isHexColor("product-1"),
      isHexColor(null),
    ]).toEqual([false, false, false, false, false, false]);
  });

  it("W12f: a hex renders as itself, not through var()", () => {
    // The defect this exists to prevent: a hand-set colour falling through the
    // unknown-token path and drawing every such product in --product-1, which
    // is a colour picker that appears to do nothing.
    expect(productColorVar("#1baf7a")).toBe("#1baf7a");
  });

  it("W12g: a palette token still renders through var()", () => {
    expect(productColorVar("product-3")).toBe("var(--product-3)");
  });

  it("W12h: an unknown token still falls back to the first palette entry", () => {
    // `product-5` passes the database CHECK and resolves to NO COLOUR AT ALL.
    expect(productColorVar("product-5")).toBe("var(--product-1)");
  });

  it("W12i: what a person types is normalised to the one spelling the CHECK takes", () => {
    // ⭐ LENIENT ABOUT INPUT, STRICT ABOUT STORAGE. Refusing a typed `#1BAF7A`
    // with "that value isn't allowed here" would be technically correct and
    // indefensible.
    expect([
      normaliseHexInput("#1BAF7A"),
      normaliseHexInput("1baf7a"),
      normaliseHexInput("  #1baf7a  "),
      normaliseHexInput("#1ba"),
    ]).toEqual(["#1baf7a", "#1baf7a", "#1baf7a", "#11bbaa"]);
  });

  it("W12j: and anything that is not a colour comes back null, not a guess", () => {
    expect([
      normaliseHexInput("teal"),
      normaliseHexInput(""),
      normaliseHexInput("#12345"),
      normaliseHexInput("#1baf7ax"),
      // ⭐ FOUND BY MUTATION Z6, NOT BY READING. Every string above fails on
      // LENGTH as well as on content, so none of them can tell a length check
      // from a hex-digit check — `body.length === 6` passes all four. Six
      // characters that are not hex digits is the only input that separates
      // them, and "zzzzzz" is what a half-finished paste looks like.
      normaliseHexInput("zzzzzz"),
      normaliseHexInput("#nofill"),
    ]).toEqual([null, null, null, null, null, null]);
  });

  it("W12k: a row with a hand-set hex is not flagged as an unknown colour", () => {
    // ⭐ FOUND BY MUTATION Z8. `colorUnknown` drives the "this colour is not one
    // the board defines" warning, and after 0025 a hex is both legal and
    // drawable — warning about it would be the screen complaining about a value
    // it just helped somebody choose. Nothing asserted the flag for a hex row,
    // so reverting it to `!isPaletteToken(...)` alone was invisible.
    const view = productRows([
      { ...WY, colorToken: "#1baf7a" },
      { ...WX, colorToken: "product-5" },
    ]);
    expect(view.rows.map((r) => r.colorUnknown)).toEqual([false, true]);
  });
});

/* ===========================================================================
 * Group V — the draft. `unique (org_id, sku)` makes a typo permanent.
 *
 * ⭐ D115 REMOVED THE OWNER FIELD. A product is the company-wide record — sku
 * and name — and which plants make it is managed separately through
 * `product_sites`, so there is no place to choose on the create form.
 * ======================================================================== */

function draft(over: Partial<{ sku: string; name: string }> = {}) {
  return { sku: "WX-1", name: "Widget X", ...over };
}

describe("validateProductDraft", () => {
  it("V1: accepts a well-formed draft", () => {
    expect(validateProductDraft(draft()).ok).toBe(true);
  });

  it("V2: returns the trimmed sku, not the typed one", () => {
    const result = validateProductDraft(draft({ sku: "  WX-1  " }));
    expect(result.ok === true && result.value.sku).toBe("WX-1");
  });

  it("V3: returns the trimmed name", () => {
    const result = validateProductDraft(draft({ name: "  Widget X  " }));
    expect(result.ok === true && result.value.name).toBe("Widget X");
  });

  // V4/V5 (the owner field, and "no owner chosen is a refusal") WENT WITH the
  // owner in D115: there is no owner on the create form to carry or to refuse.

  it("V4 ⭐ (D115): a draft is valid with sku and name alone — no place required", () => {
    // The create form makes the company-wide record; a just-created part offered
    // nowhere is a legitimate state, not an incomplete form.
    const result = validateProductDraft({ sku: "NEW-1", name: "New Part" });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value).toEqual({ sku: "NEW-1", name: "New Part" });
  });

  it("V6: refuses a blank sku", () => {
    expect(validateProductDraft(draft({ sku: "" })).ok).toBe(false);
  });

  // V7 — the DB would take it: `sku` is plain `text not null`.
  it("V7: refuses a whitespace-only sku", () => {
    expect(validateProductDraft(draft({ sku: "   " })).ok).toBe(false);
  });

  it("V8: names the sku when the sku is blank", () => {
    const result = validateProductDraft(draft({ sku: "" }));
    expect(result.ok === false && result.skuError !== null).toBe(true);
  });

  it("V9: does not blame the name when only the sku is blank", () => {
    const result = validateProductDraft(draft({ sku: "" }));
    expect(result.ok === false && result.nameError).toBe(null);
  });

  it("V10: refuses a blank name", () => {
    expect(validateProductDraft(draft({ name: "  " })).ok).toBe(false);
  });

  // V11 — both complaints at once; a form that reveals the second only after
  // you fix the first is the thing this shape avoids.
  it("V11: reports both problems together when both fields are blank", () => {
    const result = validateProductDraft(draft({ sku: "", name: "" }));
    expect(result.ok === false && result.skuError !== null && result.nameError !== null).toBe(true);
  });

  it("V12: refuses a sku with a space inside it", () => {
    expect(validateProductDraft(draft({ sku: "WX 1" })).ok).toBe(false);
  });

  it("V13: refuses a sku with a tab inside it", () => {
    expect(validateProductDraft(draft({ sku: "WX\t1" })).ok).toBe(false);
  });

  it("V14: allows a hyphenated sku, which is the ordinary case", () => {
    expect(validateProductDraft(draft({ sku: "WX-1-A" })).ok).toBe(true);
  });

  it("V15: allows spaces inside a name", () => {
    expect(validateProductDraft(draft({ name: "Widget X Mk II" })).ok).toBe(true);
  });

  it("V16: accepts a sku exactly at the length limit", () => {
    expect(validateProductDraft(draft({ sku: "a".repeat(SKU_MAX_LENGTH) })).ok).toBe(true);
  });

  it("V17: refuses a sku one character past the limit", () => {
    expect(validateProductDraft(draft({ sku: "a".repeat(SKU_MAX_LENGTH + 1) })).ok).toBe(false);
  });

  it("V18: accepts a name exactly at the length limit", () => {
    expect(validateProductDraft(draft({ name: "a".repeat(NAME_MAX_LENGTH) })).ok).toBe(true);
  });

  it("V19: refuses a name one character past the limit", () => {
    expect(validateProductDraft(draft({ name: "a".repeat(NAME_MAX_LENGTH + 1) })).ok).toBe(false);
  });

  // V20 — the unique index is case-sensitive, so normalising here would be a
  // silent rewrite of what somebody typed. The duplicate is the server's to
  // report.
  it("V20: does not upper-case the sku", () => {
    const result = validateProductDraft(draft({ sku: "wx-1" }));
    expect(result.ok === true && result.value.sku).toBe("wx-1");
  });

  it("V21: length is measured after trimming, not before", () => {
    const padded = `  ${"a".repeat(SKU_MAX_LENGTH)}  `;
    expect(validateProductDraft(draft({ sku: padded })).ok).toBe(true);
  });
});

/* ===========================================================================
 * Group R — saying what is in the way.
 * ======================================================================== */

const REFUSED: SchedulerError = { kind: "WriteRefused" };
const REFUSED_TEXT = "You don't have permission to change that.";
const DUPLICATE: SchedulerError = { kind: "DuplicateValue", constraint: "products_org_id_sku_key" };
const DUPLICATE_TEXT = "Something here already uses that name or code.";
const UNKNOWN: SchedulerError = { kind: "Unknown", raw: new Error("boom") };
const UNKNOWN_TEXT = "Something went wrong. Please try again.";

describe("describeWriteRefusal", () => {
  // R8 — the generic sentence does not say WHICH field, and the sku is the one
  // a supervisor can fix themselves.
  it("R8: names the product code for a duplicate", () => {
    expect(describeWriteRefusal(DUPLICATE, DUPLICATE_TEXT)).toContain("product code");
  });

  it("R9: does not fall back to the generic duplicate sentence", () => {
    expect(describeWriteRefusal(DUPLICATE, DUPLICATE_TEXT)).not.toBe(DUPLICATE_TEXT);
  });

  it("R10: passes a plain refusal through unchanged", () => {
    expect(describeWriteRefusal(REFUSED, REFUSED_TEXT)).toBe(REFUSED_TEXT);
  });

  it("R11: passes an unrecognised failure through unchanged", () => {
    expect(describeWriteRefusal(UNKNOWN, UNKNOWN_TEXT)).toBe(UNKNOWN_TEXT);
  });

  // R12 — the only CHECK on this table is on a column this client never
  // sends, so a 23514 here is a schema change nobody taught the screen about.
  it("R12: flags a CHECK violation as something to report", () => {
    const invalid: SchedulerError = {
      kind: "InvalidValue",
      constraint: "products_color_token_shape",
    };
    expect(describeWriteRefusal(invalid, "That value isn't allowed here.")).toContain("report");
  });
});
