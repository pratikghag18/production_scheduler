import { describe, it, expect } from "vitest";
import {
  addDays,
  buildColumns,
  buildMatrix,
  cellStateFor,
  trainingApplies,
  type MatrixInput,
} from "@/features/admin/lib/matrix";
import type { BoardNode, HierarchyLevel } from "@/lib/api/shapes";
import type { OperatorRecord, OperatorSkillRecord, SkillRecord } from "@/lib/api/operators";

/* ----------------------------- fixture builders ----------------------------- */

function node(id: string, parentId: string | null, path: string, levelId: string, sortOrder = 0): BoardNode {
  return { id, parentId, levelId, name: id.toUpperCase(), path, sortOrder, active: true };
}
function level(id: string, name: string, position: number): HierarchyLevel {
  return { id, templateId: "T", position, name, isSchedulable: position === 3 };
}
function skill(id: string, name: string, siteNodeId: string, active = true): SkillRecord {
  return { id, name, siteNodeId, active, externalId: null };
}
function op(id: string, displayName: string, siteNodeId: string, active = true): OperatorRecord {
  return { id, displayName, employeeRef: null, active, siteNodeId, source: "manual", externalId: null };
}
function osk(operatorId: string, skillId: string, expiresAt: string | null): OperatorSkillRecord {
  return { operatorId, skillId, expiresAt, certifiedAt: null, signedOffBy: null };
}

// A company → 2 plants → areas → lines tree, with real ltree paths.
//   co
//   ├─ pa (Plant A)
//   │  ├─ a1 (Area 1) ─ l1, l2 (Lines)
//   │  └─ a2 (Area 2) ─ l3
//   └─ pb (Plant B) ─ b1 (Area) ─ bl1 (Line)
const LEVELS: HierarchyLevel[] = [
  level("L0", "Company", 0),
  level("L1", "Plant", 1),
  level("L2", "Area", 2),
  level("L3", "Line", 3),
];
const NODES: BoardNode[] = [
  node("co", null, "co", "L0", 0),
  node("pa", "co", "co.pa", "L1", 0),
  node("pb", "co", "co.pb", "L1", 1),
  node("a1", "pa", "co.pa.a1", "L2", 0),
  node("a2", "pa", "co.pa.a2", "L2", 1),
  node("l1", "a1", "co.pa.a1.l1", "L3", 0),
  node("l2", "a1", "co.pa.a1.l2", "L3", 1),
  node("l3", "a2", "co.pa.a2.l3", "L3", 0),
  node("b1", "pb", "co.pb.b1", "L2", 0),
  node("bl1", "b1", "co.pb.b1.bl1", "L3", 0),
];
const byId = new Map(NODES.map((n) => [n.id, n] as const));
const levelsById = new Map(LEVELS.map((l) => [l.id, l] as const));

// Plant A trainings.
const forklift = skill("forklift", "Forklift", "pa");
const fire = skill("fire", "Fire safety", "pa");
const loto = skill("loto", "Lock-out", "a1");
const crane = skill("crane", "Overhead crane", "a1");
const solder = skill("solder", "Hand soldering", "l1");
const torque = skill("torque", "Torque wrench", "l1");
const pallet = skill("pallet", "Palletiser", "l2");
const weld = skill("weld", "MIG welding", "a2");
// Plant B trainings.
const bFork = skill("b_fork", "Forklift", "pb");
const bPress = skill("b_press", "Press brake", "bl1");

const PLANT_A_SKILLS = [forklift, fire, loto, crane, solder, torque, pallet, weld];

/* ------------------------------- addDays ------------------------------- */

describe("addDays", () => {
  it("adds days across a month boundary in UTC", () => {
    expect(addDays("2026-09-02", 30)).toBe("2026-10-02");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 not a leap year
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

/* ---------------------------- cellStateFor ---------------------------- */

describe("cellStateFor", () => {
  const today = "2026-09-02";
  const w = 30; // threshold = 2026-10-02

  it("is na when the training does not apply", () => {
    expect(cellStateFor(undefined, false, today, w)).toBe("na");
    expect(cellStateFor(osk("o", "s", "2026-09-01"), false, today, w)).toBe("na");
  });
  it("is missing when it applies but there is no holding", () => {
    expect(cellStateFor(undefined, true, today, w)).toBe("missing");
  });
  it("is trained when held with no expiry", () => {
    expect(cellStateFor(osk("o", "s", null), true, today, w)).toBe("trained");
  });
  it("is expired strictly before today", () => {
    expect(cellStateFor(osk("o", "s", "2026-09-01"), true, today, w)).toBe("expired");
  });
  it("treats expiring-today as expiring, not expired", () => {
    expect(cellStateFor(osk("o", "s", "2026-09-02"), true, today, w)).toBe("expiring");
  });
  it("is expiring up to and including the window edge", () => {
    expect(cellStateFor(osk("o", "s", "2026-09-20"), true, today, w)).toBe("expiring");
    expect(cellStateFor(osk("o", "s", "2026-10-02"), true, today, w)).toBe("expiring"); // == threshold
  });
  it("is trained just past the window", () => {
    expect(cellStateFor(osk("o", "s", "2026-10-03"), true, today, w)).toBe("trained");
  });
});

/* --------------------------- trainingApplies --------------------------- */

describe("trainingApplies", () => {
  it("applies when the owner is an ancestor-or-self of the person", () => {
    expect(trainingApplies("co.pa", "co.pa.a1.l1")).toBe(true); // plant-wide to a line
    expect(trainingApplies("co.pa.a1", "co.pa.a1")).toBe(true); // reflexive
    expect(trainingApplies("co.pa.a1.l1", "co.pa.a1.l1")).toBe(true);
  });
  it("does not apply to a sibling or a deeper owner", () => {
    expect(trainingApplies("co.pa.a1.l2", "co.pa.a1.l1")).toBe(false); // line 2's training, on line 1
    expect(trainingApplies("co.pa.a1.l1", "co.pa.a1")).toBe(false); // line's training, on the area
    expect(trainingApplies("co.pa.a2", "co.pa.a1.l1")).toBe(false); // other area
  });
  it("is label-safe, not a string prefix", () => {
    // "co.pa.a1" must not be read as an ancestor of "co.pa.a10".
    expect(trainingApplies("co.pa.a1", "co.pa.a10.l1")).toBe(false);
  });
});

/* ---------------------------- buildColumns ---------------------------- */

describe("buildColumns — nested hierarchy header", () => {
  it("roots at the plant and nests areas and lines under it", () => {
    const { cols, bands, maxBands } = buildColumns(PLANT_A_SKILLS, byId, levelsById);
    expect(maxBands).toBe(3);

    // Top band: PA spanning every column, once.
    expect(bands[0]).toEqual([{ label: "PA", colspan: cols.length, rowspan: 1 }]);

    // Second band: the plant-wide bucket (spans down), then Area 1, then Area 2.
    const b1 = bands[1].map((c) => c.label);
    expect(b1).toEqual(["PA · plant-wide", "A1", "A2"]);
    const plantWide = bands[1].find((c) => c.label === "PA · plant-wide")!;
    expect(plantWide.rowspan).toBe(2); // no children -> spans to the name row
    expect(bands[1].find((c) => c.label === "A1")!.rowspan).toBe(1); // has lines -> one row
    // Area 2 owns only its own training (no line trainings), so it is a leaf and spans down.
    expect(bands[1].find((c) => c.label === "A2")!.rowspan).toBe(2);

    // Third band: Area 1 splits into its area-wide bucket, Line 1, Line 2.
    const b2 = bands[2].map((c) => c.label);
    expect(b2).toEqual(["A1 · area-wide", "L1", "L2"]);
  });

  it("orders columns depth-first: plant-wide, then area-wide, then lines, by sortOrder then name", () => {
    const { cols } = buildColumns(PLANT_A_SKILLS, byId, levelsById);
    expect(cols.map((c) => c.id)).toEqual([
      "fire", // PA own bucket, name "Fire safety" < "Forklift"
      "forklift",
      "loto", // A1 own bucket, name "Lock-out" < "Overhead crane"
      "crane",
      "solder", // L1, "Hand soldering" < "Torque wrench"
      "torque",
      "pallet", // L2
      "weld", // A2 (sortOrder after A1)
    ]);
  });

  it("climbs to the company root when trainings span two plants", () => {
    const { bands } = buildColumns([...PLANT_A_SKILLS, bFork, bPress], byId, levelsById);
    expect(bands[0]).toEqual([{ label: "CO", colspan: 10, rowspan: 1 }]);
    // Band 1 now splits into the two plants (no company-wide bucket exists).
    expect(bands[1].map((c) => c.label)).toEqual(["PA", "PB"]);
  });

  it("returns empty for no trainings", () => {
    expect(buildColumns([], byId, levelsById)).toEqual({ cols: [], bands: [], maxBands: 0 });
  });

  it("⭐ plants are ROOTS with no company node above them (the real schema): each column keeps its plant, groups stay contiguous, and an area training shows its plant", () => {
    // Reported from the app: with four plants (each a root, parentId null) the
    // header split one plant across two places and orphaned an Area 2 column from
    // its plant. Reproduce with two roots and the deeper training the maintainer
    // assigned. `byId` here has NO shared ancestor.
    const rootById = new Map<string, BoardNode>([
      ["px", node("px", null, "px", "L1", 0)], // Plant X, root
      ["pd", node("pd", null, "pd", "L1", 1)], // Plant D, root
      ["pd_a2", node("pd_a2", "pd", "pd.pd_a2", "L2", 1)], // Area 2 under Plant D
    ]);
    const pxWide = skill("px_w", "Zeta training", "px"); // name sorts LAST on purpose
    const pdWide = skill("pd_w", "Alpha training", "pd"); // name sorts FIRST on purpose
    const pdArea = skill("pd_a", "Area 2 training", "pd_a2");

    // Feed them in a deliberately jumbled order; the plant grouping must win over
    // the training name (the old bug sorted by name across plants).
    const { cols, bands } = buildColumns([pxWide, pdArea, pdWide], rootById, levelsById);

    // Contiguous by plant, ordered by root sortOrder (px=0 before pd=1). No stray
    // company band, no plant appearing twice.
    expect(cols.map((c) => c.id)).toEqual(["px_w", "pd_w", "pd_a"]);
    expect(bands[0].map((c) => c.label)).toEqual(["PX", "PD"]);
    const pdTop = bands[0].find((c) => c.label === "PD")!;
    expect(pdTop.colspan).toBe(2); // Plant D spans BOTH its columns (site-wide + Area 2)
    // The Area 2 column sits under Plant D — its area band (node name PD_A2)
    // exists beneath PD rather than floating with no plant.
    expect(bands.some((row) => row.some((c) => c.label === "PD_A2"))).toBe(true);
  });
});

/* ----------------------------- buildMatrix ----------------------------- */

const OPERATORS: OperatorRecord[] = [
  op("ana", "Ana", "l1"),
  op("ben", "Ben", "l1"),
  op("cara", "Cara", "l2"),
  op("eli", "Eli", "l3"),
  op("gus", "Gus", "bl1"),
  op("zoe", "Zoe", "l1", false), // inactive
];

const HOLDINGS: OperatorSkillRecord[] = [
  osk("ana", "forklift", null), // trained
  osk("ana", "crane", "2026-09-10"), // expiring (within 30d of 2026-09-02)
  osk("ana", "torque", "2026-01-01"), // expired
  osk("ben", "forklift", null), // trained
  // ben has no LOTO -> missing gap
  osk("cara", "pallet", null),
];

function makeInput(scopeNodeId: string | null, over: Partial<MatrixInput> = {}): MatrixInput {
  return {
    nodes: NODES,
    levels: LEVELS,
    operators: OPERATORS,
    skills: [...PLANT_A_SKILLS, bFork, bPress],
    operatorSkills: HOLDINGS,
    scopeNodeId,
    today: "2026-09-02",
    windowDays: 30,
    ...over,
  };
}

describe("buildMatrix — scope filtering", () => {
  it("scopes to a plant: its operators and its trainings only, dropping inactive people", () => {
    const m = buildMatrix(makeInput("pa"));
    expect(m.operators.map((o) => o.id).sort()).toEqual(["ana", "ben", "cara", "eli"]);
    // Plant B trainings are out of scope; Zoe is inactive.
    expect(m.columns.cols.every((c) => c.id !== "b_fork" && c.id !== "b_press")).toBe(true);
  });

  it("scopes to an area but the header still climbs to the plant via plant-wide trainings", () => {
    const m = buildMatrix(makeInput("a1"));
    // Only Area 1 operators (l1, l2), not l3.
    expect(m.operators.map((o) => o.id).sort()).toEqual(["ana", "ben", "cara"]);
    // Plant-wide trainings apply here, so the header root is still the plant.
    expect(m.columns.bands[0][0].label).toBe("PA");
  });

  it("null scope includes both plants and roots at the company", () => {
    const m = buildMatrix(makeInput(null));
    expect(m.operators.map((o) => o.id).sort()).toEqual(["ana", "ben", "cara", "eli", "gus"]);
    expect(m.columns.bands[0][0].label).toBe("CO");
  });
});

describe("buildMatrix — cell states, teams and counts", () => {
  it("derives each cell state, including cross-branch N/A", () => {
    const m = buildMatrix(makeInput("pa"));
    expect(m.cellState("ana", "forklift")).toBe("trained");
    expect(m.cellState("ana", "crane")).toBe("expiring");
    expect(m.cellState("ana", "torque")).toBe("expired");
    expect(m.cellState("ben", "loto")).toBe("missing"); // the team gap
    expect(m.cellState("ana", "pallet")).toBe("na"); // Line 2's training, Ana is on Line 1
    expect(m.cellState("ana", "weld")).toBe("na"); // Area 2's training
  });

  it("groups operators into teams labelled by their branch under the root", () => {
    const m = buildMatrix(makeInput("pa"));
    const teams = m.teams.map((t) => ({ label: t.label, ops: t.operators.map((o) => o.id) }));
    expect(teams).toEqual([
      { label: "A1 › L1", ops: ["ana", "ben"] },
      { label: "A1 › L2", ops: ["cara"] },
      { label: "A2 › L3", ops: ["eli"] },
    ]);
  });

  it("counts gaps and renewals over applicable cells only", () => {
    const m = buildMatrix(makeInput("pa"));
    expect(m.counts.people).toBe(4);
    expect(m.counts.needRenewal).toBe(2); // Ana's crane (expiring) + torque (expired)
    expect(m.counts.gaps).toBeGreaterThan(0);
  });

  it("can include retired trainings and inactive operators when asked", () => {
    const withRetired = buildMatrix(makeInput("pa", { includeInactive: true }));
    expect(withRetired.operators.some((o) => o.id === "zoe")).toBe(true);
  });
});
