/**
 * Acceptance suite for `src/features/admin/lib/operatorImport.ts` — the PREVIEW
 * half of the import wizard's people lane. It turns a parsed CSV grid into a plan
 * of inserts, updates and refusals, as pure data a test can check and a screen
 * can render — applying the plan lives elsewhere.
 *
 * A VITEST suite; one plain `it()` per rule, named after the numbered rules in
 * the module header. The realistic path is exercised throughout: a CSV string ->
 * `parseCsvTable` -> `detectColumns` -> `planOperatorImport`, exactly as the
 * wizard drives it.
 *
 * ⭐⭐ THE MATCH KEY IS external_id, AND IT IS THE ONLY ONE. `employee_ref`
 * carries no uniqueness, so a re-upload without an import id can only ever
 * INSERT. And a NEW person needs a plant (`site_node_id` is NOT NULL), while an
 * UPDATE leaves the site alone — the two people-specific twists these cases pin.
 */
import { describe, expect, it } from "vitest";
import type { OperatorRecord } from "@/lib/api";
import { parseCsvTable } from "../features/admin/lib/csv.ts";
import {
  detectColumns,
  planOperatorImport,
  OPERATOR_TEMPLATE,
  type ImportPlant,
} from "../features/admin/lib/operatorImport.ts";

/* ---- fixtures ----------------------------------------------------------- */

function operator(over: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    id: "O1",
    displayName: "Jane Smith",
    employeeRef: "EMP-1",
    active: true,
    siteNodeId: "N1",
    source: "import",
    externalId: "EXT-1",
    ...over,
  };
}

const O1 = operator();

const PLANT_A: ImportPlant = { id: "N1", name: "Plant A" };

/**
 * The wizard's real path: parse the text, propose columns from the header, plan.
 * Column overrides are the wizard's job; the default detection is what we test.
 */
function planFrom(csv: string, existing: OperatorRecord[] = [], plants: ImportPlant[] = []) {
  const table = parseCsvTable(csv);
  const columns = detectColumns(table.headerKeys);
  return planOperatorImport(table, existing, columns, plants);
}

const only = (plan: ReturnType<typeof planFrom>) => plan.rows[0].outcome;

/* ===========================================================================
 * Group C — detectColumns. Aliases, in, propose a mapping (the wizard overrides).
 * ======================================================================== */

describe("detectColumns", () => {
  it("C1: maps name from any of its aliases", () => {
    expect(detectColumns(["name"]).name).toBe("name");
    expect(detectColumns(["full name"]).name).toBe("full name");
    expect(detectColumns(["person"]).name).toBe("person");
  });

  it("C2: maps employee ref from employee ref, badge or payroll", () => {
    expect(detectColumns(["employee ref"]).employeeRef).toBe("employee ref");
    expect(detectColumns(["badge"]).employeeRef).toBe("badge");
    expect(detectColumns(["payroll"]).employeeRef).toBe("payroll");
  });

  it("C3: maps external id from import id, external id or id", () => {
    expect(detectColumns(["import id"]).externalId).toBe("import id");
    expect(detectColumns(["external id"]).externalId).toBe("external id");
    expect(detectColumns(["id"]).externalId).toBe("id");
  });

  it("C4: maps plant from plant, site or location", () => {
    expect(detectColumns(["plant"]).plant).toBe("plant");
    expect(detectColumns(["site"]).plant).toBe("site");
    expect(detectColumns(["location"]).plant).toBe("location");
  });

  // C5 — an optional field with no matching header comes back null; the wizard
  // leaves it unmapped rather than guessing.
  it("C5: leaves an unmatched optional column null", () => {
    const map = detectColumns(["name"]);
    expect(map.employeeRef).toBe(null);
    expect(map.externalId).toBe(null);
    expect(map.plant).toBe(null);
  });

  // C6 — the one REQUIRED-TO-MAP column absent is named in missingRequired so the
  // wizard can block until it is mapped. The plant is NOT required to map.
  it("C6: lists an absent name column in the plan's missingRequired, but not plant", () => {
    const plan = planFrom("foo,bar\n1,2");
    expect([...plan.missingRequired]).toEqual(["name"]);
  });
});

/* ===========================================================================
 * Group 1 — rule 1: an external_id that matches an existing person -> UPDATE it.
 *
 * ⭐ THE SITE IS LEFT ALONE. The update outcome carries name and employee ref
 * only; there is no plantNodeId on it, and the plant column is not even consulted.
 * ======================================================================== */

describe("rule 1 — external_id matches an existing person", () => {
  it("I1: updates the matched person, carrying the new name and employee ref", () => {
    const plan = planFrom("import id,name,employee ref\nEXT-1,Jane Renamed,EMP-9", [O1]);
    expect(only(plan)).toEqual({
      kind: "update",
      operatorId: "O1",
      displayName: "Jane Renamed",
      employeeRef: "EMP-9",
      externalId: "EXT-1",
    });
  });

  it("I1b: an update needs no plant and never carries a site — a plant column on an update is ignored", () => {
    // The row names a plant, but because it MATCHES by external_id it updates,
    // and the update leaves the site alone: no plantNodeId, no error.
    const plan = planFrom("import id,name,plant\nEXT-1,Jane,Plant A", [O1], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("update");
    expect(outcome).not.toHaveProperty("plantNodeId");
  });

  it("I1c: an unresolvable plant on an update row is NOT an error — the plant is not consulted", () => {
    const plan = planFrom("import id,name,plant\nEXT-1,Jane,Nowhere", [O1], [PLANT_A]);
    expect(only(plan).kind).toBe("update");
  });
});

/* ===========================================================================
 * Group 2 — rule 2: an external_id that matches nothing -> INSERT.
 * ======================================================================== */

describe("rule 2 — external_id matches nothing", () => {
  it("I2: inserts, carrying the new external_id and the resolved plant", () => {
    const plan = planFrom("import id,name,plant\nEXT-NEW,New Person,Plant A", [O1], [PLANT_A]);
    expect(only(plan)).toEqual({
      kind: "insert",
      displayName: "New Person",
      employeeRef: null,
      externalId: "EXT-NEW",
      plantNodeId: "N1",
    });
  });
});

/* ===========================================================================
 * Group 3 — rule 3: NO external_id -> INSERT (there is no way to match a person).
 *
 * ⭐ Unlike products, there is NO secondary match key. A row with no import id
 * cannot find anyone, so it always inserts — and the inserted external_id is null.
 * ======================================================================== */

describe("rule 3 — no external_id always inserts", () => {
  it("I3: inserts a person with no import id, external_id null", () => {
    const plan = planFrom("name,employee ref,plant\nBrand New,EMP-5,Plant A", [O1], [PLANT_A]);
    expect(only(plan)).toEqual({
      kind: "insert",
      displayName: "Brand New",
      employeeRef: "EMP-5",
      externalId: null,
      plantNodeId: "N1",
    });
  });

  it("I4: even a name that matches an existing person's name still inserts (name is not a key)", () => {
    // O1 is "Jane Smith"; a row with the same name but no import id is a DIFFERENT
    // person as far as the import can tell, so it inserts rather than updates.
    const plan = planFrom("name,plant\nJane Smith,Plant A", [O1], [PLANT_A]);
    expect(only(plan).kind).toBe("insert");
  });
});

/* ===========================================================================
 * Group 4 — rule 4: an in-FILE duplicate external_id fails BOTH rows.
 * ======================================================================== */

describe("rule 4 — within-file duplicates", () => {
  it("I5: two rows sharing an external_id are both errors", () => {
    const plan = planFrom(
      "import id,name,plant\nEXT-D,One,Plant A\nEXT-D,Two,Plant A",
      [],
      [PLANT_A],
    );
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["error", "error"]);
    expect(plan.counts.error).toBe(2);
  });

  it("I6: two rows sharing a NAME are fine — a name carries no uniqueness", () => {
    const plan = planFrom("name,plant\nDup,Plant A\nDup,Plant A", [], [PLANT_A]);
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["insert", "insert"]);
  });
});

/* ===========================================================================
 * Group V — name validation. A blank or absurd name is refused.
 * ======================================================================== */

describe("name validation", () => {
  it("I7: refuses a blank name", () => {
    expect(only(planFrom("name,plant\n,Plant A", [], [PLANT_A])).kind).toBe("error");
  });

  // I8 — the tally: one update, one insert, one refusal, counted correctly.
  it("I8: counts insert, update and error correctly across a mixed file", () => {
    const plan = planFrom(
      "import id,name,plant\nEXT-1,Renamed,\nEXT-NEW,New Person,Plant A\nEXT-BAD,,Plant A",
      [O1],
      [PLANT_A],
    );
    expect(plan.counts).toEqual({ insert: 1, update: 1, error: 1 });
  });
});

/* ===========================================================================
 * Group 5 — rule 5: a plant is REQUIRED for an insert.
 *
 * ⭐ `operators.site_node_id` is NOT NULL, so a NEW person must land somewhere.
 * A resolvable plant name is assigned; a blank one is an error; an unresolvable
 * one is an error. (An UPDATE needs none — see Group 1.)
 * ======================================================================== */

describe("rule 5 — a plant is required for an insert", () => {
  it("I9: assigns the plant a name resolves to, case-insensitively", () => {
    const plan = planFrom("import id,name,plant\nEXT-NEW,New Person,plant a", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("insert");
    expect(outcome.kind === "insert" && outcome.plantNodeId).toBe("N1");
  });

  it("I10: refuses an insert whose plant is blank", () => {
    const plan = planFrom("import id,name,plant\nEXT-NEW,New Person,", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("plant is required");
  });

  it("I11: refuses an insert whose plant resolves to nothing", () => {
    const plan = planFrom("import id,name,plant\nEXT-NEW,New Person,Nowhere", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("Nowhere");
  });
});

/* ===========================================================================
 * Group E — file-level errors ride along to the plan.
 * ======================================================================== */

describe("file errors", () => {
  it("I12: carries a parse-level error from the CSV onto plan.fileErrors", () => {
    const plan = planFrom('name,plant\n"Jane,Plant A', [O1], [PLANT_A]);
    expect(plan.fileErrors.some((e) => e.message.includes("never closed"))).toBe(true);
  });
});

/* ===========================================================================
 * The plan -> view mapping. Cells are in OPERATOR_FIELDS order.
 * ======================================================================== */

describe("operatorPlanToView", () => {
  it("I13: flattens rows to cells in field order with the right verdict", async () => {
    const { operatorPlanToView } = await import("../features/admin/lib/operatorImport.ts");
    const plan = planFrom(
      "import id,name,employee ref,plant\nEXT-NEW,New Person,EMP-7,Plant A",
      [],
      [PLANT_A],
    );
    const view = operatorPlanToView(plan);
    expect(view.counts).toEqual({ insert: 1, update: 0, error: 0 });
    expect(view.rows[0].cells).toEqual(["New Person", "EMP-7", "EXT-NEW", "Plant A"]);
    expect(view.rows[0].kind).toBe("insert");
  });

  it("I14: names an unmapped name column as 'name' in missingRequired", async () => {
    const { operatorPlanToView } = await import("../features/admin/lib/operatorImport.ts");
    const view = operatorPlanToView(planFrom("foo,bar\n1,2"));
    expect(view.missingRequired).toEqual(["name"]);
  });
});

/* ===========================================================================
 * OPERATOR_TEMPLATE — the model CSV cannot drift from what the detector looks for.
 * ======================================================================== */

describe("OPERATOR_TEMPLATE", () => {
  it("M1: every friendly template header still auto-detects to the right field", () => {
    const keys = OPERATOR_TEMPLATE.headers.map((h) => h.toLowerCase());
    const map = detectColumns(keys);
    expect(map).toEqual({
      name: keys[0],
      employeeRef: keys[1],
      externalId: keys[2],
      plant: keys[3],
    });
    expect(OPERATOR_TEMPLATE.headers).toEqual(["Name", "Employee ref", "Import ID", "Plant"]);
  });

  it("M2: the example row and the legend both cover every header", () => {
    expect(OPERATOR_TEMPLATE.example.length).toBe(OPERATOR_TEMPLATE.headers.length);
    expect(OPERATOR_TEMPLATE.legend.map((l) => l.column)).toEqual([...OPERATOR_TEMPLATE.headers]);
  });
});
