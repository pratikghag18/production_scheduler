/**
 * Acceptance suite for `src/features/admin/lib/trainingImport.ts` — the PREVIEW
 * half of the import wizard's TRAININGS CATALOGUE lane. It turns a parsed CSV grid
 * into a plan of inserts, no-op "updates" (already-there) and refusals, as pure
 * data a test can check and a screen can render — applying the plan lives
 * elsewhere.
 *
 * A VITEST suite; one plain `it()` per rule, named after the numbered rules in
 * the module header. The realistic path is exercised throughout: a CSV string ->
 * `parseCsvTable` -> `detectColumns` -> `planTrainingImport`, exactly as the
 * wizard drives it.
 *
 * ⭐⭐ THE MATCH KEY IS (name, owning-plant), the WHOLE key. A training is unique
 * per `(org, site_node_id, name)` — two plants may each hold a "Forklift", one
 * plant may not hold it twice. Every row needs a plant (the owner is half the
 * key and `site_node_id` is NOT NULL); an already-existing (name, plant) is a
 * no-op update so a re-upload is idempotent.
 */
import { describe, expect, it } from "vitest";
import type { SkillRecord } from "@/lib/api";
import { parseCsvTable } from "../features/admin/lib/csv.ts";
import {
  detectColumns,
  planTrainingImport,
  trainingPlanToView,
  TRAINING_TEMPLATE,
  TRAINING_NAME_MAX_LENGTH,
  type ImportPlant,
} from "../features/admin/lib/trainingImport.ts";

/* ---- fixtures ----------------------------------------------------------- */

function skill(over: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "S1",
    name: "Forklift",
    siteNodeId: "N1",
    active: true,
    externalId: null,
    ...over,
  };
}

const FORKLIFT_AT_A = skill();

const PLANT_A: ImportPlant = { id: "N1", name: "Plant A" };
const PLANT_B: ImportPlant = { id: "N2", name: "Plant B" };

/**
 * The wizard's real path: parse the text, propose columns from the header, plan.
 * Column overrides are the wizard's job; the default detection is what we test.
 */
function planFrom(csv: string, existing: SkillRecord[] = [], plants: ImportPlant[] = []) {
  const table = parseCsvTable(csv);
  const columns = detectColumns(table.headerKeys);
  return planTrainingImport(table, existing, columns, plants);
}

const only = (plan: ReturnType<typeof planFrom>) => plan.rows[0].outcome;

/* ===========================================================================
 * Group C — detectColumns. Aliases, in, propose a mapping (the wizard overrides).
 * ======================================================================== */

describe("detectColumns", () => {
  it("C1: maps name from any of its aliases", () => {
    expect(detectColumns(["training name"]).name).toBe("training name");
    expect(detectColumns(["name"]).name).toBe("name");
    expect(detectColumns(["training"]).name).toBe("training");
    expect(detectColumns(["course"]).name).toBe("course");
    expect(detectColumns(["skill"]).name).toBe("skill");
  });

  it("C2: maps plant from plant, site or location", () => {
    expect(detectColumns(["plant"]).plant).toBe("plant");
    expect(detectColumns(["site"]).plant).toBe("site");
    expect(detectColumns(["location"]).plant).toBe("location");
  });

  it("C3: leaves an unmatched column null", () => {
    expect(detectColumns(["training name"]).plant).toBe(null);
    expect(detectColumns(["plant"]).name).toBe(null);
    // The document number is optional — absent, it maps to null and is NOT in
    // missingRequired.
    expect(detectColumns(["training name", "plant"]).documentNumber).toBe(null);
  });

  it("C6: maps the document number from any of its aliases", () => {
    expect(detectColumns(["document number"]).documentNumber).toBe("document number");
    expect(detectColumns(["doc number"]).documentNumber).toBe("doc number");
    expect(detectColumns(["doc no"]).documentNumber).toBe("doc no");
    expect(detectColumns(["training number"]).documentNumber).toBe("training number");
    expect(detectColumns(["document no"]).documentNumber).toBe("document no");
  });

  // C4 — BOTH columns are required-to-map, so an absent one is named in
  // missingRequired for the wizard to block on.
  it("C4: lists an absent name AND plant column in missingRequired", () => {
    const plan = planFrom("foo,bar\n1,2");
    expect([...plan.missingRequired].sort()).toEqual(["name", "plant"]);
  });

  it("C5: a header with only a name still lists the missing plant", () => {
    const plan = planFrom("training name\nForklift");
    expect([...plan.missingRequired]).toEqual(["plant"]);
  });
});

/* ===========================================================================
 * Group 4 — rule 4: a (name, plant) that does NOT exist -> INSERT.
 * ======================================================================== */

describe("rule 4 — a new (name, plant) inserts", () => {
  it("I1: inserts, carrying the name and the resolved owning plant", () => {
    const plan = planFrom("training name,plant\nWelding,Plant A", [FORKLIFT_AT_A], [PLANT_A]);
    expect(only(plan)).toEqual({
      kind: "insert",
      name: "Welding",
      plantNodeId: "N1",
      documentNumber: null,
    });
  });

  it("I2: the SAME name at a DIFFERENT plant is a new training, so it inserts", () => {
    // "Forklift" exists at Plant A (N1); the same name at Plant B (N2) is a
    // distinct training under 0031's (org, site, name) key.
    const plan = planFrom(
      "training name,plant\nForklift,Plant B",
      [FORKLIFT_AT_A],
      [PLANT_A, PLANT_B],
    );
    expect(only(plan)).toEqual({
      kind: "insert",
      name: "Forklift",
      plantNodeId: "N2",
      documentNumber: null,
    });
  });
});

/* ===========================================================================
 * Group 5 — rule 5: a (name, plant) that ALREADY exists -> no-op "update".
 * ======================================================================== */

describe("rule 5 — an existing (name, plant) is a no-op update", () => {
  it("I3: an already-present training is an update carrying the existing id", () => {
    const plan = planFrom("training name,plant\nForklift,Plant A", [FORKLIFT_AT_A], [PLANT_A]);
    expect(only(plan)).toEqual({
      kind: "update",
      skillId: "S1",
      name: "Forklift",
      documentNumber: null,
    });
  });

  it("I4: the name matches case-insensitively (so a re-upload is idempotent)", () => {
    const plan = planFrom("training name,plant\nFORKLIFT,plant a", [FORKLIFT_AT_A], [PLANT_A]);
    expect(only(plan).kind).toBe("update");
  });
});

/* ===========================================================================
 * Group 1/2 — a plant is REQUIRED on every row, and must resolve.
 * ======================================================================== */

describe("rules 1 & 2 — a plant is required and must resolve", () => {
  it("I5: refuses a row whose plant is blank", () => {
    const plan = planFrom("training name,plant\nWelding,", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("plant is required");
  });

  it("I6: refuses a row whose plant resolves to nothing the reader can see", () => {
    const plan = planFrom("training name,plant\nWelding,Nowhere", [], [PLANT_A]);
    const outcome = only(plan);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.messages.join(" ")).toContain("Nowhere");
  });
});

/* ===========================================================================
 * Group V — name validation. A blank or absurd name is refused.
 * ======================================================================== */

describe("name validation", () => {
  it("I7: refuses a blank name", () => {
    expect(only(planFrom("training name,plant\n,Plant A", [], [PLANT_A])).kind).toBe("error");
  });

  it("I8: refuses a name past the max length", () => {
    const long = "x".repeat(TRAINING_NAME_MAX_LENGTH + 1);
    const plan = planFrom(`training name,plant\n${long},Plant A`, [], [PLANT_A]);
    expect(only(plan).kind).toBe("error");
  });
});

/* ===========================================================================
 * Group 3 — rule 3: an in-FILE duplicate (name, plant) fails BOTH rows.
 * ======================================================================== */

describe("rule 3 — within-file duplicates", () => {
  it("I9: two rows with the same (name, plant) are both errors", () => {
    const plan = planFrom("training name,plant\nWelding,Plant A\nWelding,Plant A", [], [PLANT_A]);
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["error", "error"]);
    expect(plan.counts.error).toBe(2);
  });

  it("I10: the same name at DIFFERENT plants is fine — the plant is part of the key", () => {
    const plan = planFrom(
      "training name,plant\nWelding,Plant A\nWelding,Plant B",
      [],
      [PLANT_A, PLANT_B],
    );
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["insert", "insert"]);
  });
});

/* ===========================================================================
 * Group T — the tally: insert, update and error counted correctly.
 * ======================================================================== */

describe("counts", () => {
  it("I11: counts insert, update and error across a mixed file", () => {
    const plan = planFrom(
      "training name,plant\nForklift,Plant A\nWelding,Plant A\nBad,Nowhere",
      [FORKLIFT_AT_A],
      [PLANT_A],
    );
    expect(plan.counts).toEqual({ insert: 1, update: 1, error: 1 });
  });
});

/* ===========================================================================
 * Group D — the optional "Document number" column. It is a settable ATTRIBUTE,
 * NOT part of the match key (a row is still matched by name + plant). It is
 * recorded on an insert, set on an update when it DIFFERS, and left alone when
 * blank or unchanged; a within-file clash on the same plant fails both rows.
 * ======================================================================== */

describe("the document number column", () => {
  it("D1: a document number is recorded on an insert", () => {
    const plan = planFrom(
      "training name,plant,document number\nWelding,Plant A,DOC-1",
      [],
      [PLANT_A],
    );
    expect(only(plan)).toEqual({
      kind: "insert",
      name: "Welding",
      plantNodeId: "N1",
      documentNumber: "DOC-1",
    });
  });

  it("D2: an existing training gets its document number set when the row differs", () => {
    // Forklift at Plant A currently has no document number; the row gives one, so
    // the update carries it for apply to set.
    const plan = planFrom(
      "training name,plant,document number\nForklift,Plant A,DOC-9",
      [FORKLIFT_AT_A],
      [PLANT_A],
    );
    expect(only(plan)).toEqual({
      kind: "update",
      skillId: "S1",
      name: "Forklift",
      documentNumber: "DOC-9",
    });
  });

  it("D3: an unchanged document number on an existing training is a pure no-op", () => {
    // The training already carries "DOC-9"; the row repeats it, so nothing is set.
    const existing = skill({ externalId: "DOC-9" });
    const plan = planFrom(
      "training name,plant,document number\nForklift,Plant A,DOC-9",
      [existing],
      [PLANT_A],
    );
    expect(only(plan)).toEqual({
      kind: "update",
      skillId: "S1",
      name: "Forklift",
      documentNumber: null,
    });
  });

  it("D4: a blank document number leaves an insert's at null", () => {
    const plan = planFrom(
      "training name,plant,document number\nWelding,Plant A,",
      [],
      [PLANT_A],
    );
    expect(only(plan)).toEqual({
      kind: "insert",
      name: "Welding",
      plantNodeId: "N1",
      documentNumber: null,
    });
  });

  it("D5: a blank leaves an existing training's document number alone", () => {
    // The training carries "DOC-9"; a blank row is NOT a request to clear it.
    const existing = skill({ externalId: "DOC-9" });
    const plan = planFrom(
      "training name,plant,document number\nForklift,Plant A,",
      [existing],
      [PLANT_A],
    );
    expect(only(plan)).toEqual({
      kind: "update",
      skillId: "S1",
      name: "Forklift",
      documentNumber: null,
    });
  });

  it("D6: two rows giving the SAME document number to the same plant are both errors", () => {
    const plan = planFrom(
      "training name,plant,document number\nWelding,Plant A,DOC-1\nForklift,Plant A,DOC-1",
      [],
      [PLANT_A],
    );
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["error", "error"]);
    expect(plan.counts.error).toBe(2);
    const msg = plan.rows[0].outcome;
    expect(msg.kind === "error" && msg.messages.join(" ")).toContain("DOC-1");
  });

  it("D7: the SAME document number at DIFFERENT plants is fine", () => {
    const plan = planFrom(
      "training name,plant,document number\nWelding,Plant A,DOC-1\nForklift,Plant B,DOC-1",
      [],
      [PLANT_A, PLANT_B],
    );
    expect(plan.rows.map((r) => r.outcome.kind)).toEqual(["insert", "insert"]);
  });

  it("D8: the document number is NOT a match key — a new number on a new (name, plant) inserts", () => {
    // A document number that no existing training carries does not turn an insert
    // into an update; the match is still (name, plant).
    const plan = planFrom(
      "training name,plant,document number\nWelding,Plant A,DOC-1",
      [FORKLIFT_AT_A],
      [PLANT_A],
    );
    expect(only(plan).kind).toBe("insert");
  });
});

/* ===========================================================================
 * Group E — file-level errors ride along to the plan.
 * ======================================================================== */

describe("file errors", () => {
  it("I12: carries a parse-level error from the CSV onto plan.fileErrors", () => {
    const plan = planFrom('training name,plant\n"Welding,Plant A', [], [PLANT_A]);
    expect(plan.fileErrors.some((e) => e.message.includes("never closed"))).toBe(true);
  });
});

/* ===========================================================================
 * The plan -> view mapping. Cells are in TRAINING_FIELDS order.
 * ======================================================================== */

describe("trainingPlanToView", () => {
  it("I13: flattens rows to cells in field order with the right verdict", () => {
    const plan = planFrom("training name,plant\nWelding,Plant A", [], [PLANT_A]);
    const view = trainingPlanToView(plan);
    expect(view.counts).toEqual({ insert: 1, update: 0, error: 0 });
    expect(view.rows[0].cells).toEqual(["Welding", "Plant A", ""]);
    expect(view.rows[0].kind).toBe("insert");
  });

  it("I14: names an unmapped name column as 'training name' in missingRequired", () => {
    const view = trainingPlanToView(planFrom("plant\nPlant A"));
    expect(view.missingRequired).toEqual(["training name"]);
  });
});

/* ===========================================================================
 * TRAINING_TEMPLATE — the model CSV cannot drift from what the detector looks for.
 * ======================================================================== */

describe("TRAINING_TEMPLATE", () => {
  it("M1: every friendly template header still auto-detects to the right field", () => {
    const keys = TRAINING_TEMPLATE.headers.map((h) => h.toLowerCase());
    const map = detectColumns(keys);
    expect(map).toEqual({ name: keys[0], plant: keys[1], documentNumber: keys[2] });
    expect(TRAINING_TEMPLATE.headers).toEqual(["Training name", "Plant", "Document number"]);
  });

  it("M2: the example row and the legend both cover every header", () => {
    expect(TRAINING_TEMPLATE.example.length).toBe(TRAINING_TEMPLATE.headers.length);
    expect(TRAINING_TEMPLATE.legend.map((l) => l.column)).toEqual([...TRAINING_TEMPLATE.headers]);
  });
});
