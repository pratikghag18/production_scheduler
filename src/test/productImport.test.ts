/**
 * Acceptance suite for `src/features/admin/lib/productImport.ts` — the PREVIEW
 * half of the import wizard (D115 §19.81, migration 0034). It turns a parsed CSV
 * grid into a plan of inserts, updates and refusals, as pure data a test can
 * check and a screen can render — applying the plan lives elsewhere.
 *
 * A VITEST suite; one plain `it()` per rule, named after the numbered rules in
 * the module header (match key is external_id; rules 1–5). The realistic path is
 * exercised throughout: a CSV string -> `parseCsvTable` -> `detectColumns` ->
 * `planProductImport`, exactly as the wizard drives it.
 *
 * ⭐⭐ THE MATCH KEY IS external_id (D115 made `unique (org_id, external_id)`
 * possible), so a re-upload UPDATES rather than DUPLICATES. Shape validation
 * reuses `validateProductDraft`, so an import cannot make a row a typed form
 * would have refused.
 */
import { describe, expect, it } from "vitest";
import type { AdminProduct } from "@/lib/api";
import { parseCsvTable } from "../features/admin/lib/csv.ts";
import {
  detectColumns,
  planProductImport,
  type ImportPlant,
} from "../features/admin/lib/productImport.ts";

/* ---- fixtures ----------------------------------------------------------- */

function product(over: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: "P1",
    sku: "WX",
    name: "Widget X",
    active: true,
    source: "import",
    externalId: "EXT-1",
    siteNodeIds: [],
    colorToken: "product-1",
    ...over,
  };
}

const P1 = product();
const P2 = product({ id: "P2", sku: "GZ", name: "Gadget Z", externalId: "EXT-2" });

const PLANT_A: ImportPlant = { id: "N1", name: "Plant A" };

/**
 * The wizard's real path: parse the text, propose columns from the header, plan.
 * Column overrides are the wizard's job; the default detection is what we test.
 */
function planFrom(csv: string, existing: AdminProduct[] = [], plants: ImportPlant[] = []) {
  const table = parseCsvTable(csv);
  const columns = detectColumns(table.headerKeys);
  return planProductImport(table, existing, columns, plants);
}

const only = (plan: ReturnType<typeof planFrom>) => plan.rows[0].outcome;

/* ===========================================================================
 * Group C — detectColumns. Aliases, in, propose a mapping (the wizard overrides).
 *
 * ⭐ headerKeys arrive already normalised (trimmed + lower-cased) from
 * `parseCsvTable`, so the aliases are matched against the lower-cased forms.
 * ======================================================================== */

describe("detectColumns", () => {
  it("C1: maps sku from any of its aliases", () => {
    expect(detectColumns(["sku"]).sku).toBe("sku");
    expect(detectColumns(["part number"]).sku).toBe("part number");
    expect(detectColumns(["part_number"]).sku).toBe("part_number");
  });

  it("C2: maps name from Product Name or Description", () => {
    expect(detectColumns(["product name"]).name).toBe("product name");
    expect(detectColumns(["description"]).name).toBe("description");
  });

  it("C3: maps external id from external id, ref or id", () => {
    expect(detectColumns(["external id"]).externalId).toBe("external id");
    expect(detectColumns(["ref"]).externalId).toBe("ref");
    expect(detectColumns(["id"]).externalId).toBe("id");
  });

  it("C4: maps plant from plant, site or made in", () => {
    expect(detectColumns(["plant"]).plant).toBe("plant");
    expect(detectColumns(["site"]).plant).toBe("site");
    expect(detectColumns(["made in"]).plant).toBe("made in");
  });

  // C5 — an optional field with no matching header comes back null; the wizard
  // leaves it unmapped rather than guessing.
  it("C5: leaves an unmatched optional column null", () => {
    const map = detectColumns(["sku", "name"]);
    expect(map.externalId).toBe(null);
    expect(map.plant).toBe(null);
  });

  // C6 — a REQUIRED column absent is not a null to shrug at: the plan names it in
  // missingRequired so the wizard can block until it is mapped.
  it("C6: lists an absent required column in the plan's missingRequired", () => {
    const plan = planFrom("foo,bar\n1,2");
    expect([...plan.missingRequired]).toEqual(["sku", "name"]);
  });
});

/* ===========================================================================
 * Group 1 — rule 1: an external_id that matches an existing part -> UPDATE it.
 * ======================================================================== */

describe("rule 1 — external_id matches an existing part", () => {
  // The re-upload case: same external_id, a changed sku and name -> update the
  // matched part, carrying the new values.
  it("I1: updates the matched part, carrying the new sku and name", () => {
    const plan = planFrom("external_id,sku,name\nEXT-1,WX-2,Renamed", [P1]);
    expect(only(plan)).toEqual({
      kind: "update",
      productId: "P1",
      sku: "WX-2",
      name: "Renamed",
      externalId: "EXT-1",
      plantNodeId: null,
    });
  });
});

/* ===========================================================================
 * Group 2 — rule 2: an external_id that matches nothing -> INSERT.
 * ======================================================================== */

describe("rule 2 — external_id matches nothing", () => {
  it("I2: inserts, carrying the new external_id", () => {
    const plan = planFrom("external_id,sku,name\nEXT-NEW,NEW1,New Part", [P1]);
    expect(only(plan)).toEqual({
      kind: "insert",
      sku: "NEW1",
      name: "New Part",
      externalId: "EXT-NEW",
      plantNodeId: null,
    });
  });
});

/* ===========================================================================
 * Group 3 — rule 3: NO external_id, matched by sku (the code IS the part).
 * ======================================================================== */

describe("rule 3 — no external_id, matched by sku", () => {
  // The sku is company-wide, so the same code is the same part -> update its name.
  it("I3: updates the part the sku already names", () => {
    const plan = planFrom("sku,name\nWX,Renamed", [P1]);
    expect(only(plan)).toEqual({
      kind: "update",
      productId: "P1",
      sku: "WX",
      name: "Renamed",
      externalId: null,
      plantNodeId: null,
    });
  });

  // A brand-new sku with no external_id is a fresh part; externalId comes out null.
  it("I4: inserts a brand-new sku with a null external_id", () => {
    const plan = planFrom("sku,name\nZZ,Brand New", [P1]);
    expect(only(plan)).toEqual({
      kind: "insert",
      sku: "ZZ",
      name: "Brand New",
      externalId: null,
      plantNodeId: null,
    });
  });
});

/* ===========================================================================
 * Group X — the sku-collision refusal. A part number cannot move to another part.
 *
 * ⭐ Both faces of it: an external_id row whose sku belongs to a DIFFERENT part,
 * and a NEW external_id that lands on an existing sku. Silently re-homing the code
 * is what this refuses.
 * ======================================================================== */

describe("the sku collision", () => {
  it("I5: refuses an external_id row whose sku belongs to a different part", () => {
    const plan = planFrom("external_id,sku,name\nEXT-1,GZ,X", [P1, P2]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("different part");
  });

  it("I6: refuses a new external_id that lands on an existing sku", () => {
    const plan = planFrom("external_id,sku,name\nEXT-NEW,WX,X", [P1]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("different part");
  });
});

/* ===========================================================================
 * Group 4 — rule 4: an in-FILE duplicate fails BOTH rows.
 *
 * ⭐ Letting the last one win would make the outcome depend on row order, so a
 * repeated external_id (or sku) is an error on every row that shares it.
 * ======================================================================== */

describe("rule 4 — within-file duplicates", () => {
  it("I7: two rows sharing an external_id are both errors", () => {
    const plan = planFrom("external_id,sku,name\nEXT-D,AAA,One\nEXT-D,BBB,Two");
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["error", "error"]);
    expect(plan.counts.error).toBe(2);
  });

  it("I8: two rows sharing a sku are both errors", () => {
    const plan = planFrom("sku,name\nDUP,One\nDUP,Two");
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["error", "error"]);
    expect(plan.counts.error).toBe(2);
  });
});

/* ===========================================================================
 * Group V — validation reuse. The import cannot smuggle in a row a form refuses.
 * ======================================================================== */

describe("validation reuse (validateProductDraft)", () => {
  it("I9: refuses a blank sku", () => {
    expect(only(planFrom("sku,name\n,No Code")).kind).toBe("error");
  });

  it("I10: refuses a sku with a space inside it", () => {
    expect(only(planFrom("sku,name\nWX 1,Name")).kind).toBe("error");
  });

  // I11 — the tally: one update, one insert, one refusal, counted correctly.
  it("I11: counts insert, update and error correctly across a mixed file", () => {
    const plan = planFrom("sku,name\nWX,Renamed\nNEW,New Part\n,Blank", [P1]);
    expect(plan.counts).toEqual({ insert: 1, update: 1, error: 1 });
  });
});

/* ===========================================================================
 * Group 5 — rule 5: the optional plant column.
 *
 * ⭐ A name that resolves (case-insensitively) is assigned; one that resolves to
 * nothing is an error ("assign it somewhere I could not find" is not silent); a
 * blank plant is a legitimate "made nowhere yet".
 * ======================================================================== */

describe("rule 5 — the plant column", () => {
  it("I12: assigns the plant a name resolves to, case-insensitively", () => {
    const plan = planFrom("sku,name,plant\nNEW,New Part,plant a", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("insert");
    expect(outcome.kind === "insert" && outcome.plantNodeId).toBe("N1");
  });

  it("I13: refuses a plant name that resolves to nothing", () => {
    const plan = planFrom("sku,name,plant\nNEW,New Part,Nowhere", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("plant");
  });

  it("I14: treats a blank plant as no plant, not an error", () => {
    const plan = planFrom("sku,name,plant\nNEW,New Part,", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("insert");
    expect(outcome.kind === "insert" && outcome.plantNodeId).toBe(null);
  });
});

/* ===========================================================================
 * Group E — file-level errors ride along to the plan.
 *
 * ⭐ A malformed CSV (an unterminated quote) is a parse-level problem the wizard
 * must surface; it is carried onto plan.fileErrors, not swallowed.
 * ======================================================================== */

describe("file errors", () => {
  it("I15: carries a parse-level error from the CSV onto plan.fileErrors", () => {
    const plan = planFrom('sku,name\n"WX,Widget', [P1]);
    expect(plan.fileErrors.some((e) => e.message.includes("never closed"))).toBe(true);
  });
});
