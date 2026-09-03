/**
 * R-315 / R-317: the cycle-times grid and its units.
 *
 * The tree mirrors the seed's shape (Plant 1 > Assembly > Line 1 > Cell 1/2)
 * and deliberately includes a `line_10` beside `line_1`, because ancestry here
 * must be label-wise: a `startsWith` test would put Line 10's cells under Line
 * 1 and silently inflate every roll-up. That trap is the one `scope.test.ts`
 * was built around and it is re-run here against this module's own walk.
 */
import { describe, it, expect } from "vitest";
import {
  buildCycleGrid,
  countMeasured,
  displayCycle,
  formatCycle,
  toSeconds,
  validateCycleEntry,
  type CycleGridLevel,
  type CycleGridNode,
  type CycleGridProduct,
} from "@/features/admin/lib/cycleTimes";

const LEVELS: CycleGridLevel[] = [
  { id: "lvl-site", isSchedulable: false },
  { id: "lvl-dept", isSchedulable: false },
  { id: "lvl-line", isSchedulable: false },
  { id: "lvl-cell", isSchedulable: true },
];

const NODES: CycleGridNode[] = [
  { id: "plant1", parentId: null, levelId: "lvl-site", name: "Plant 1", path: "plant_1" },
  {
    id: "assembly",
    parentId: "plant1",
    levelId: "lvl-dept",
    name: "Assembly",
    path: "plant_1.assembly",
  },
  {
    id: "line1",
    parentId: "assembly",
    levelId: "lvl-line",
    name: "Line 1",
    path: "plant_1.assembly.line_1",
  },
  // ⚠️ The trap: `plant_1.assembly.line_1` is a string prefix of
  // `plant_1.assembly.line_10` but is NOT its ancestor.
  {
    id: "line10",
    parentId: "assembly",
    levelId: "lvl-line",
    name: "Line 10",
    path: "plant_1.assembly.line_10",
  },
  {
    id: "cell1",
    parentId: "line1",
    levelId: "lvl-cell",
    name: "Cell 1",
    path: "plant_1.assembly.line_1.cell_1",
  },
  {
    id: "cell2",
    parentId: "line1",
    levelId: "lvl-cell",
    name: "Cell 2",
    path: "plant_1.assembly.line_1.cell_2",
  },
  {
    id: "cell10",
    parentId: "line10",
    levelId: "lvl-cell",
    name: "Cell 10",
    path: "plant_1.assembly.line_10.cell_10",
  },
  { id: "plant2", parentId: null, levelId: "lvl-site", name: "Plant 2", path: "plant_2" },
  {
    id: "p2dept",
    parentId: "plant2",
    levelId: "lvl-dept",
    name: "P2 Dept",
    path: "plant_2.p2_dept",
  },
  {
    id: "p2line",
    parentId: "p2dept",
    levelId: "lvl-line",
    name: "P2 Line",
    path: "plant_2.p2_dept.p2_line",
  },
  {
    id: "p2cell",
    parentId: "p2line",
    levelId: "lvl-cell",
    name: "P2 Cell",
    path: "plant_2.p2_dept.p2_line.p2_cell",
  },
];

const PRODUCTS: CycleGridProduct[] = [
  { id: "wx", sku: "WX", name: "Widget X", active: true, siteNodeIds: ["plant1"] },
  { id: "gz", sku: "GZ", name: "Gadget Z", active: true, siteNodeIds: ["plant2"] },
  // Attached to one LINE rather than a whole plant.
  { id: "ln", sku: "LN", name: "Line Only", active: true, siteNodeIds: ["line10"] },
  { id: "old", sku: "OLD", name: "Retired", active: false, siteNodeIds: ["plant1"] },
];

function grid(values: { nodeId: string; productId: string; secondsPerUnit: number }[] = []) {
  return buildCycleGrid({
    nodes: NODES,
    levels: LEVELS,
    products: PRODUCTS,
    values,
    choice: null,
  });
}

function cellFor(block: ReturnType<typeof grid>[number], nodeId: string, sku: string) {
  const col = block.columns.findIndex((c) => c.sku === sku);
  const row = block.rows.find((r) => r.node.id === nodeId);
  return row && col >= 0 ? row.cells[col] : undefined;
}

describe("G1-G4: what a plant's grid offers, and what it rolls up", () => {
  it("G1: a plant's columns are the parts made there, active only, and never another plant's", () => {
    const [plant1, plant2] = grid();
    expect(plant1?.columns.map((c) => c.sku)).toEqual(["LN", "WX"]);
    expect(plant2?.columns.map((c) => c.sku)).toEqual(["GZ"]);
    // The retired part is offered at Plant 1 but is not a column anywhere.
    expect(grid().every((b) => b.columns.every((c) => c.sku !== "OLD"))).toBe(true);
  });

  it("G2: a line shows the SUM of its cells — the labour content of one unit", () => {
    const [plant1] = grid([
      { nodeId: "cell1", productId: "wx", secondsPerUnit: 60 },
      { nodeId: "cell2", productId: "wx", secondsPerUnit: 90 },
    ]);
    expect(cellFor(plant1!, "line1", "WX")).toEqual({
      kind: "sum",
      seconds: 150,
      contributors: 2,
      total: 2,
    });
    // And it keeps rolling up: the plant sees the same 150, over the three
    // cells that make WX anywhere in it.
    expect(cellFor(plant1!, "plant1", "WX")).toEqual({
      kind: "sum",
      seconds: 150,
      contributors: 2,
      total: 3,
    });
  });

  it("G3: an unmeasured cell contributes nothing, and the row says how partial it is", () => {
    const [plant1] = grid([{ nodeId: "cell1", productId: "wx", secondsPerUnit: 60 }]);
    // 1 of the line's 2 cells is measured. Both numbers are carried so the
    // screen can distinguish a complete total from a partial one — a reader who
    // cannot tell will plan against the smaller number.
    expect(cellFor(plant1!, "line1", "WX")).toEqual({
      kind: "sum",
      seconds: 60,
      contributors: 1,
      total: 2,
    });
    expect(cellFor(plant1!, "cell2", "WX")).toEqual({ kind: "editable", seconds: null });
  });

  it("G3b: a row with nothing measured below it still knows how many places there are", () => {
    const [plant1] = grid();
    expect(cellFor(plant1!, "line1", "WX")).toEqual({
      kind: "sum",
      seconds: 0,
      contributors: 0,
      total: 2,
    });
  });

  it("G4: a part attached to one line is editable there and blank on a sibling line", () => {
    const [plant1] = grid();
    expect(cellFor(plant1!, "cell10", "LN")).toEqual({ kind: "editable", seconds: null });
    // Cell 1 is under Line 1, which does not make LN.
    expect(cellFor(plant1!, "cell1", "LN")).toEqual({ kind: "na" });
    expect(cellFor(plant1!, "line1", "LN")).toEqual({ kind: "na" });
  });

  it("G4b: only the schedulable level is editable — a line is never typed into", () => {
    const [plant1] = grid();
    const line = plant1!.rows.find((r) => r.node.id === "line1");
    const cell = plant1!.rows.find((r) => r.node.id === "cell1");
    expect(line?.isSchedulable).toBe(false);
    expect(cell?.isSchedulable).toBe(true);
    expect(line?.cells.every((c) => c.kind !== "editable")).toBe(true);
  });
});

describe("G5-G6: entry validation, and the ancestry trap", () => {
  it("G5: blank, zero, negative and nonsense are all refused, in every unit", () => {
    for (const unit of ["s", "min", "h"] as const) {
      expect(typeof validateCycleEntry("", unit)).toBe("string");
      expect(typeof validateCycleEntry("   ", unit)).toBe("string");
      expect(typeof validateCycleEntry("0", unit)).toBe("string");
      expect(typeof validateCycleEntry("-5", unit)).toBe("string");
      expect(typeof validateCycleEntry("abc", unit)).toBe("string");
    }
    expect(validateCycleEntry("1.5", "min")).toBe(90);
  });

  it("G6: Line 10 is not inside Line 1 — a prefix test would merge them", () => {
    const [plant1] = grid([
      { nodeId: "cell1", productId: "wx", secondsPerUnit: 60 },
      { nodeId: "cell10", productId: "wx", secondsPerUnit: 999 },
    ]);
    // Line 1's roll-up must see ONLY Cell 1's 60, never Cell 10's 999 — and
    // its total must be 2 (its own cells), not 3.
    expect(cellFor(plant1!, "line1", "WX")).toEqual({
      kind: "sum",
      seconds: 60,
      contributors: 1,
      total: 2,
    });
    // The plant above both sees the pair.
    expect(cellFor(plant1!, "plant1", "WX")).toEqual({
      kind: "sum",
      seconds: 1059,
      contributors: 2,
      total: 3,
    });
  });
});

describe("G7-G9: seconds are stored, friendlier units are shown", () => {
  it("G7: entry converts to seconds", () => {
    expect(toSeconds(1.5, "min")).toBe(90);
    expect(toSeconds(2, "h")).toBe(7200);
    expect(toSeconds(45, "s")).toBe(45);
    expect(validateCycleEntry("12", "h")).toBe(43200);
  });

  it("G8: display picks the largest EXACT unit, and never a lossy one", () => {
    expect(displayCycle(5400)).toEqual({ value: 1.5, unit: "h" });
    expect(displayCycle(3600)).toEqual({ value: 1, unit: "h" });
    expect(displayCycle(90)).toEqual({ value: 1.5, unit: "min" });
    expect(displayCycle(45)).toEqual({ value: 45, unit: "s" });
    // ⚠️ 100 s is not a tidy number of minutes. Showing 1.7 min would make
    // re-saving an untouched row write 102 s.
    expect(displayCycle(100)).toEqual({ value: 100, unit: "s" });
  });

  it("G8b: a round trip through display and entry never changes the value", () => {
    for (const seconds of [1, 45, 90, 100, 150, 3600, 5400, 43200]) {
      const { value, unit } = displayCycle(seconds);
      expect(validateCycleEntry(String(value), unit)).toBe(seconds);
    }
  });

  it("G9: a summed row formats in the same friendly units", () => {
    expect(formatCycle(150)).toBe("2.5 min");
    expect(formatCycle(45)).toBe("45 s");
    expect(formatCycle(43200)).toBe("12 h");
  });
});

describe("G10: the plant filter and the summary", () => {
  it("G10a: choosing one plant returns only that plant's block", () => {
    const only = buildCycleGrid({
      nodes: NODES,
      levels: LEVELS,
      products: PRODUCTS,
      values: [],
      choice: "plant2",
    });
    expect(only).toHaveLength(1);
    expect(only[0]?.plant.name).toBe("Plant 2");
  });

  it("G10b: countMeasured counts typed cells, not rolled-up rows", () => {
    const [plant1] = grid([
      { nodeId: "cell1", productId: "wx", secondsPerUnit: 60 },
      { nodeId: "cell2", productId: "wx", secondsPerUnit: 90 },
    ]);
    expect(countMeasured(plant1!)).toBe(2);
  });

  it("G10c: rows carry a depth relative to their own plant, for indenting", () => {
    const [plant1] = grid();
    const depths = new Map(plant1!.rows.map((r) => [r.node.id, r.depth]));
    expect(depths.get("plant1")).toBe(0);
    expect(depths.get("assembly")).toBe(1);
    expect(depths.get("line1")).toBe(2);
    expect(depths.get("cell1")).toBe(3);
  });
});
