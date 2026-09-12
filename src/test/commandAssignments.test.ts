/**
 * R-385 — `src/features/board/lib/commandAssignments.ts` (brief §7, §9, A1-A4).
 *
 * `commandAssignments` is the command bar's view of the window's blocks: the
 * EFFECTIVE part (a run's product for a run-attached block, D110-safe), and
 * the same `formatClock` label pair the run label in `BoardPage` is built
 * from, without the name. Built here from a hand-rolled
 * `Pick<BoardIndex, "assignmentById" | "runById" | "windowStart" | "zone">` so
 * this file does not need the rest of `BoardIndex`'s many other fields.
 */
import { describe, it, expect } from "vitest";
import type { BoardIndex, IndexedAssignment, IndexedRun } from "@/features/board/lib/boardIndex";
import type { Product } from "@/lib/api";
import { commandAssignments } from "@/features/board/lib/commandAssignments";

const WINDOW_START = new Date("2026-08-24T00:00:00.000Z");

function baseAssignment(overrides: Partial<IndexedAssignment> = {}): IndexedAssignment {
  return {
    id: "asg-1",
    orgId: "org-1",
    nodeId: "cell-1",
    operatorId: "op-1",
    operatorDisplayName: null,
    runId: null,
    productId: "prod-1",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-24 06:00:00+00,2026-08-24 10:00:00+00)",
    efficiency: 1,
    eligibilityOverride: false,
    overrideReason: null,
    areaOverride: false,
    areaOverrideReason: null,
    targetQty: null,
    targetUnit: null,
    createdBy: null,
    createdAt: WINDOW_START.toISOString(),
    updatedAt: WINDOW_START.toISOString(),
    startMin: 360,
    endMin: 600,
    efficiencyPercent: 100,
    lane: 0,
    defaultTargetQty: null,
    ...overrides,
  };
}

function baseRun(overrides: Partial<IndexedRun> = {}): IndexedRun {
  return {
    id: "run-1",
    orgId: "org-1",
    nodeId: "cell-1",
    productId: "prod-run",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-24 06:00:00+00,2026-08-24 16:00:00+00)",
    plannedHeadcount: null,
    notes: null,
    createdBy: null,
    createdAt: WINDOW_START.toISOString(),
    updatedAt: WINDOW_START.toISOString(),
    startMin: 360,
    endMin: 960,
    ...overrides,
  };
}

function baseProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    sku: "SKU-1",
    name: "Housing A",
    active: true,
    siteNodeIds: [],
    offeredNodeIds: [],
    colorToken: "",
    ...overrides,
  };
}

function indexOf(
  assignments: IndexedAssignment[],
  runs: IndexedRun[] = [],
  products: Product[] = [],
): Pick<BoardIndex, "assignmentById" | "runById" | "productById" | "windowStart" | "zone"> {
  return {
    assignmentById: new Map(assignments.map((a) => [a.id, a] as const)),
    runById: new Map(runs.map((r) => [r.id, r] as const)),
    productById: new Map(products.map((p) => [p.id, p] as const)),
    windowStart: WINDOW_START,
    zone: "UTC",
  };
}

describe("commandAssignments (R-385, brief §7)", () => {
  it("A1: a direct block carries its own product and a '06:00-10:00' label", () => {
    const a = baseAssignment({ productId: "prod-1", runId: null, startMin: 360, endMin: 600 });
    const out = commandAssignments(indexOf([a], [], [baseProduct({ id: "prod-1" })]));
    expect(out).toEqual([
      {
        id: "asg-1",
        nodeId: "cell-1",
        operatorId: "op-1",
        productId: "prod-1",
        startMin: 360,
        endMin: 600,
        label: "06:00–10:00",
        productName: "Housing A",
      },
    ]);
  });

  it("A2: a run-attached block carries the run's product", () => {
    const a = baseAssignment({ productId: null, runId: "run-1" });
    const run = baseRun({ id: "run-1", productId: "prod-run" });
    const out = commandAssignments(indexOf([a], [run]));
    expect(out[0].productId).toBe("prod-run");
  });

  it("A3: a departed person's block is carried with operatorId null", () => {
    const a = baseAssignment({ operatorId: null });
    const out = commandAssignments(indexOf([a]));
    expect(out[0].operatorId).toBe(null);
  });

  it("A4: a run-attached block whose run is missing from runById carries productId null", () => {
    const a = baseAssignment({ productId: null, runId: "run-missing" });
    const out = commandAssignments(indexOf([a], []));
    expect(out[0].productId).toBe(null);
  });

  // -------------------------------------------------------------------------
  // S41-b: `productName`, brief s41-b-unassign-brief.md §3/§5 (A5-A7).
  // -------------------------------------------------------------------------

  it("A5: the direct block carries its product's name", () => {
    const a = baseAssignment({ productId: "prod-1", runId: null });
    const out = commandAssignments(
      indexOf([a], [], [baseProduct({ id: "prod-1", name: "Housing A" })]),
    );
    expect(out[0].productName).toBe("Housing A");
  });

  it("A6: the run-attached block carries its run's product's name", () => {
    const a = baseAssignment({ productId: null, runId: "run-1" });
    const run = baseRun({ id: "run-1", productId: "prod-run" });
    const out = commandAssignments(
      indexOf([a], [run], [baseProduct({ id: "prod-run", name: "Cover" })]),
    );
    expect(out[0].productName).toBe("Cover");
  });

  it("A7: an unknown product carries productName null", () => {
    const a = baseAssignment({ productId: "prod-missing", runId: null });
    const out = commandAssignments(indexOf([a], [], []));
    expect(out[0].productName).toBe(null);
  });
});
