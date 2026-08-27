/**
 * Acceptance suite for `src/features/admin/lib/products.ts` — the client half
 * of migration 0023's `products` (D102, §19.62).
 *
 * A VITEST suite, because `npm run test` is what guards this permanently and
 * vitest collects every `src/test/*.test.ts`. One plain `it()` per case, never
 * `it.each`: a table-driven case that fails names the table, not the rule that
 * broke, and this file exists to name the rule.
 *
 * ⭐ WHAT IS UNDER TEST IS THE PURE MODULE, NOT THE PANEL. `ProductsPanel.tsx`
 * renders what these functions return and decides nothing itself; the api
 * layer (`src/lib/api/products.ts`) imports `@/lib/supabase` and is covered by
 * `tsc`/`eslint` rather than here. That split is the same one `siteAccess.ts`
 * and `siteAccess.test.ts` already draw.
 *
 * THE FIXTURE:
 *
 *   Plant 1  — the site the viewer administers, in most cases
 *   Plant 2  — a site they do not
 *   (null)   — company-wide, which is a VALUE and not an absence
 *
 *   WX  company-wide   product-1   active
 *   WY  Plant 1        product-2   active
 *   GZ  Plant 2        product-3   inactive
 *   RW  Plant 1        product-9   active     <- a token tokens.css never defines
 */
import { describe, expect, it } from "vitest";
import type { AdminProduct, SchedulerError } from "@/lib/api";
import {
  COMPANY_WIDE_LABEL,
  FALLBACK_COLOR_TOKEN,
  NAME_MAX_LENGTH,
  PRODUCT_PALETTE,
  SKU_MAX_LENGTH,
  UNKNOWN_SITE_LABEL,
  canEditProduct,
  canOwnProduct,
  describeDeleteRefusal,
  describeWriteRefusal,
  editRefusalNote,
  isHexColor,
  isPaletteToken,
  matchesProductQuery,
  normaliseHexInput,
  ownerLabel,
  ownerOptions,
  partitionProducts,
  productColorVar,
  productRows,
  validateProductDraft,
  type ProductRow,
  type ProductSite,
} from "../features/admin/lib/products.ts";

const PLANT_1 = "30000000-0000-0000-0000-000000000001";
const PLANT_2 = "30000000-0000-0000-0000-000000000002";

const SITES: readonly ProductSite[] = [
  { id: PLANT_1, name: "Plant 1" },
  { id: PLANT_2, name: "Plant 2" },
];

function product(over: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "60000000-0000-0000-0000-000000000001",
    sku: "WX",
    name: "Widget X",
    active: true,
    source: "manual",
    externalId: null,
    siteNodeId: null,
    colorToken: "product-1",
    ...over,
  };
}

const WX = product();
const WY = product({ id: "p-wy", sku: "WY", name: "Widget Y", siteNodeId: PLANT_1, colorToken: "product-2" });
const GZ = product({ id: "p-gz", sku: "GZ", name: "Gadget Z", siteNodeId: PLANT_2, colorToken: "product-3", active: false });
const RW = product({ id: "p-rw", sku: "RW", name: "Rework", siteNodeId: PLANT_1, colorToken: "product-9" });

const ALL = [WX, WY, GZ, RW];

function rowsOf(parsed: ReadonlyArray<AdminProduct | null> = ALL): readonly ProductRow[] {
  return productRows(parsed, SITES).rows;
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

/* ===========================================================================
 * Group O — owners. `site_node_id IS NULL` is company-wide, not missing.
 * ======================================================================== */

describe("owner labelling", () => {
  it("O1: a null owner is company-wide, not blank", () => {
    expect(ownerLabel(null, SITES)).toBe(COMPANY_WIDE_LABEL);
  });

  it("O2: a known site is named", () => {
    expect(ownerLabel(PLANT_1, SITES)).toBe("Plant 1");
  });

  // O3 — reads on `products` are org-wide; `nodes_select` is not. A site admin
  // sees Plant 2's products and cannot name Plant 2.
  it("O3: an owner outside the visible nodes is named as another site", () => {
    expect(ownerLabel(PLANT_2, [{ id: PLANT_1, name: "Plant 1" }])).toBe(UNKNOWN_SITE_LABEL);
  });

  it("O4: an unresolved owner never leaks the raw uuid", () => {
    expect(ownerLabel(PLANT_2, []).includes(PLANT_2)).toBe(false);
  });

  it("O5: a company-wide owner is still company-wide with no sites loaded", () => {
    expect(ownerLabel(null, [])).toBe(COMPANY_WIDE_LABEL);
  });
});

/* ===========================================================================
 * Group L — the list. Skip and count; never blank, never silent.
 * ======================================================================== */

describe("productRows", () => {
  it("L1: keeps every readable row", () => {
    expect(productRows(ALL, SITES).rows.length).toBe(4);
  });

  it("L2: counts nothing skipped when every row parsed", () => {
    expect(productRows(ALL, SITES).skipped).toBe(0);
  });

  // L3/L4 — the pair that matters: a malformed row must not blank the panel,
  // and must not vanish without a trace either.
  it("L3: a malformed row does not remove the readable ones", () => {
    expect(productRows([WX, null, WY], SITES).rows.map((r) => r.sku)).toEqual(["WX", "WY"]);
  });

  it("L4: a malformed row is counted", () => {
    expect(productRows([WX, null, WY], SITES).skipped).toBe(1);
  });

  it("L5: counts every malformed row, not just the first", () => {
    expect(productRows([null, WX, null, null], SITES).skipped).toBe(3);
  });

  it("L6: an all-malformed payload yields no rows and a full count", () => {
    expect(productRows([null, null], SITES)).toEqual({ rows: [], skipped: 2 });
  });

  it("L7: an empty payload is not an error", () => {
    expect(productRows([], SITES)).toEqual({ rows: [], skipped: 0 });
  });

  it("L8: preserves the server's sku ordering rather than re-sorting", () => {
    expect(rowsOf().map((r) => r.sku)).toEqual(["WX", "WY", "GZ", "RW"]);
  });

  it("L9: resolves each row's owner label", () => {
    expect(rowFor("WY").owner).toBe("Plant 1");
  });

  it("L10: resolves a company-wide row's owner label", () => {
    expect(rowFor("WX").owner).toBe(COMPANY_WIDE_LABEL);
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

  it("L15: carries the underlying row through unchanged", () => {
    expect(rowFor("GZ").id).toBe("p-gz");
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
});

/* ===========================================================================
 * Group W — who may write. A mirror of the three policies in 0023 §5.
 * ======================================================================== */

describe("canOwnProduct / canEditProduct", () => {
  it("W1: a company admin may edit a company-wide product", () => {
    expect(canEditProduct(WX, true, [])).toBe(true);
  });

  it("W2: a company admin may edit any site's product, with no grants at all", () => {
    expect(canEditProduct(GZ, true, [])).toBe(true);
  });

  // W3 — the headline of 0023 §5: a site admin owns their own site's list.
  it("W3: a site admin may edit their own site's product", () => {
    expect(canEditProduct(WY, false, [PLANT_1])).toBe(true);
  });

  // W4 — and the other half, which is the one a collapse would break.
  it("W4: a site admin may NOT edit a company-wide product", () => {
    expect(canEditProduct(WX, false, [PLANT_1])).toBe(false);
  });

  it("W5: a site admin may NOT edit another site's product", () => {
    expect(canEditProduct(GZ, false, [PLANT_1])).toBe(false);
  });

  it("W6: somebody who administers no site may edit nothing", () => {
    expect(canEditProduct(WY, false, [])).toBe(false);
  });

  it("W7: a site admin of two sites may edit either", () => {
    expect(canEditProduct(GZ, false, [PLANT_1, PLANT_2])).toBe(true);
  });

  it("W8: canOwnProduct refuses company-wide to a site admin, matching the insert policy", () => {
    expect(canOwnProduct(null, false, [PLANT_1])).toBe(false);
  });

  it("W9: canOwnProduct allows company-wide to a company admin", () => {
    expect(canOwnProduct(null, true, [])).toBe(true);
  });
});

describe("editRefusalNote", () => {
  it("W10: says nothing when the row is editable", () => {
    expect(editRefusalNote(WY, false, [PLANT_1])).toBe(null);
  });

  it("W11: names company-wide as the reason, not a generic refusal", () => {
    expect(editRefusalNote(WX, false, [PLANT_1])).toContain("company admin");
  });

  it("W12: someone who administers NOWHERE is told exactly that", () => {
    // ⚠️ RULE 1b-ii: THIS CASE WAS RIGHT AND THE CONTRACT CHANGED. It used to
    // assert the note said "another site", which was correct while
    // `canEditProduct` decided from `adminSiteIds` alone. The 27-Aug review
    // measured that `adminSiteIds` (derived from STRUCTURE ownership) is not
    // the question the policy asks (node GRANTS), so a site admin could be
    // locked out of their own products — a wrong "no", which is invisible and
    // permanent. With §19.63's contract in place a wrong "yes" is one clear
    // sentence, so the default flipped. The note that remains is the one that
    // needs no grant read to be certain of.
    expect(editRefusalNote(GZ, false, [PLANT_1], false)).toContain("administer anywhere");
  });

  it("W12b: and someone who administers SOMEWHERE is no longer refused on a guess", () => {
    // The half W12 cannot see. Without this, flipping the default back to
    // fail-closed would leave the whole group green.
    expect(editRefusalNote(GZ, false, [PLANT_1], true)).toBe(null);
    expect(canEditProduct(GZ, false, [PLANT_1], true)).toBe(true);
  });

  it("W12c: company-wide stays company-admin-only, however wide the grants", () => {
    // ⭐ THE ONE REFUSAL THAT IS STILL CERTAIN. It comes from the profile role,
    // with no grant lookup, so there is nothing to fail open about — and it is
    // what stops the flip above from handing every site admin the company's
    // shared rows.
    expect(canEditProduct(WX, false, [PLANT_1], true)).toBe(false);
    expect(editRefusalNote(WX, false, [PLANT_1], true)).toContain("company admin");
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
    const view = productRows(
      [{ ...WY, colorToken: "#1baf7a" }, { ...WX, colorToken: "product-5" }],
      SITES,
    );
    expect(view.rows.map((r) => r.colorUnknown)).toEqual([false, true]);
  });
});

describe("ownerOptions", () => {
  it("W13: offers a company admin company-wide first", () => {
    expect(ownerOptions(SITES, true, [])[0]).toEqual({ value: null, label: COMPANY_WIDE_LABEL });
  });

  it("W14: offers a company admin every site", () => {
    expect(ownerOptions(SITES, true, []).length).toBe(3);
  });

  // W15 — offering company-wide to a site admin would be a form that fails on
  // submit, which is the exact defect `editable_shape_ids` was added to close
  // one screen over.
  it("W15: never offers company-wide to a site admin", () => {
    expect(ownerOptions(SITES, false, [PLANT_1]).some((o) => o.value === null)).toBe(false);
  });

  it("W16: offers a site admin only the sites they administer", () => {
    expect(ownerOptions(SITES, false, [PLANT_1]).map((o) => o.label)).toEqual(["Plant 1"]);
  });

  it("W17: offers nothing to somebody who administers no site", () => {
    expect(ownerOptions(SITES, false, [])).toEqual([]);
  });
});

/* ===========================================================================
 * Group V — the draft. `unique (org_id, sku)` makes a typo permanent.
 * ======================================================================== */

function draft(over: Partial<{ sku: string; name: string; siteNodeId: string | null }> = {}) {
  return { sku: "WX-1", name: "Widget X", siteNodeId: null, ...over };
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

  it("V4: carries the owner through untouched", () => {
    const result = validateProductDraft(draft({ siteNodeId: PLANT_1 }));
    expect(result.ok === true && result.value.siteNodeId).toBe(PLANT_1);
  });

  it("V5: carries a null owner through as null, not as a blank string", () => {
    const result = validateProductDraft(draft({ siteNodeId: null }));
    expect(result.ok === true && result.value.siteNodeId).toBe(null);
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
 *
 * `describeSchedulerError` is passed IN rather than imported: the module under
 * test has no runtime imports. These cases use its real sentences so the two
 * halves cannot drift into repeating each other.
 * ======================================================================== */

const STILL_IN_USE: SchedulerError = { kind: "StillInUse", usedBy: "runs" };
const STILL_IN_USE_TEXT = "It's still used by runs, so it can't be deleted.";
const REFUSED: SchedulerError = { kind: "WriteRefused" };
const REFUSED_TEXT = "You don't have permission to change that.";
const DUPLICATE: SchedulerError = { kind: "DuplicateValue", constraint: "products_org_id_sku_key" };
const DUPLICATE_TEXT = "Something here already uses that name or code.";
const UNKNOWN: SchedulerError = { kind: "Unknown", raw: new Error("boom") };
const UNKNOWN_TEXT = "Something went wrong. Please try again.";

describe("describeDeleteRefusal", () => {
  // R1 — the referencing TABLE, already lifted from the 23503 detail line, is
  // what makes this different from "something went wrong".
  it("R1: keeps the table that is in the way", () => {
    expect(describeDeleteRefusal(STILL_IN_USE, STILL_IN_USE_TEXT)).toContain("runs");
  });

  // R2 — `runs`/`assignments` reference (org_id, product_id) with NO ON
  // DELETE, so a scheduled product can NEVER be deleted. Saying only that it
  // failed leaves somebody clicking it again.
  it("R2: offers deactivate as the way out", () => {
    expect(describeDeleteRefusal(STILL_IN_USE, STILL_IN_USE_TEXT)).toContain("Deactivate");
  });

  it("R3: says the work already done is kept", () => {
    expect(describeDeleteRefusal(STILL_IN_USE, STILL_IN_USE_TEXT)).toContain("already on");
  });

  it("R4: explains a refused delete as an ownership question", () => {
    expect(describeDeleteRefusal(REFUSED, REFUSED_TEXT)).toContain("company admin");
  });

  it("R5: keeps the underlying sentence for a refusal", () => {
    expect(describeDeleteRefusal(REFUSED, REFUSED_TEXT)).toContain(REFUSED_TEXT);
  });

  it("R6: passes an unrecognised failure through unchanged", () => {
    expect(describeDeleteRefusal(UNKNOWN, UNKNOWN_TEXT)).toBe(UNKNOWN_TEXT);
  });

  it("R7: never invents a table when the error names none", () => {
    const bare: SchedulerError = { kind: "StillInUse" };
    const text = "Something else still uses this, so it can't be deleted.";
    expect(describeDeleteRefusal(bare, text)).toContain(text);
  });
});

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
    const invalid: SchedulerError = { kind: "InvalidValue", constraint: "products_color_token_shape" };
    expect(describeWriteRefusal(invalid, "That value isn't allowed here.")).toContain("report");
  });
});
