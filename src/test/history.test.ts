/**
 * Acceptance suite for `src/features/board/lib/history.ts` — D110 (migration
 * 0029) drawn on the board, and D113's operator half.
 *
 * ⭐⭐ H4 AND H8 ARE THE CASES THIS FILE EXISTS FOR. D110 keeps a started run
 * after its product is deleted and copies the sku, name and colour onto it, so
 * last month's board still says what it made. Every board component looked the
 * product up by id, which for a deleted product resolves to `undefined` and
 * renders as **"(unknown product)" in grey** — precisely the outcome the
 * snapshot was added to prevent. The columns shipped and nothing read them.
 *
 * ⚠️ AND THE PARSER WAS WORSE, WHICH IS PINNED IN `shapes.test.ts` RATHER THAN
 * HERE: `Run.productId` was typed `string`, so a snapshotted run parsed as
 * `null`, and `parseArrayOf` nulls the WHOLE ARRAY on the first failure — one
 * deleted product with history and the board stopped loading for everyone.
 *
 * The fixture keeps a live product AND a deleted one on purpose: a suite where
 * every row is one or the other cannot tell "reads the snapshot" from "ignores
 * the id" ([[verification-standard]] rule 3g).
 */
import { describe, expect, it } from "vitest";
import {
  assignmentProductView,
  isDeletedProductView,
  operatorViewFor,
  productViewFor,
} from "@/features/board/lib/history";
import type { Assignment, BoardOperator, Product, Run } from "@/lib/api";

const LIVE: Product = {
  id: "p1",
  sku: "WX",
  name: "Widget X",
  active: true,
  siteNodeIds: ["n1"],
  offeredNodeIds: ["n1"],
  colorToken: "product-1",
};
const PRODUCTS: ReadonlyMap<string, Product> = new Map([["p1", LIVE]]);

const MARIA: BoardOperator = {
  id: "o1",
  homeNodeId: null,
  displayName: "Maria",
  employeeRef: "EMP-001",
  active: true,
  siteNodeId: "n1",
  skillIds: [],
};
const OPERATORS: ReadonlyMap<string, BoardOperator> = new Map([["o1", MARIA]]);

function run(over: Partial<Run>): Run {
  return {
    id: "r1",
    orgId: "org",
    nodeId: "n1",
    productId: "p1",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-18 06:00:00+00,2026-08-18 14:00:00+00)",
    plannedHeadcount: 1,
    notes: null,
    createdBy: null,
    createdAt: "x",
    updatedAt: "x",
    ...over,
  };
}

function asg(over: Partial<Assignment>): Assignment {
  return {
    id: "a1",
    orgId: "org",
    nodeId: "n1",
    operatorId: "o1",
    operatorDisplayName: null,
    runId: null,
    productId: "p1",
    productSku: null,
    productName: null,
    productColorToken: null,
    timerange: "[2026-08-18 06:00:00+00,2026-08-18 14:00:00+00)",
    efficiency: 1,
    eligibilityOverride: false,
    overrideReason: null,
    areaOverride: false,
    areaOverrideReason: null,
    targetQty: null,
    targetUnit: null,
    createdBy: null,
    createdAt: "x",
    updatedAt: "x",
    ...over,
  };
}

/** A product deleted after this run had already started (D110). */
const GONE = {
  productId: null,
  productSku: "WX",
  productName: "Widget X",
  productColorToken: "product-1",
} as const;

describe("a product that still exists", () => {
  it("H1: resolves to the live row, by id", () => {
    expect(productViewFor(run({}), PRODUCTS)?.name).toBe("Widget X");
  });

  it("H2: is not flagged as deleted", () => {
    expect(isDeletedProductView(productViewFor(run({}), PRODUCTS))).toBe(false);
  });

  it("H3: an id the map does not hold is undefined, not invented", () => {
    expect(productViewFor(run({ productId: "gone-from-the-window" }), PRODUCTS)).toBeUndefined();
  });
});

describe("a product that has been deleted", () => {
  it("H4 ⭐⭐: keeps its NAME, which is the whole of D110 on screen", () => {
    expect(productViewFor(run(GONE), PRODUCTS)?.name).toBe("Widget X");
  });

  it("H5 ⭐: keeps its COLOUR, so last week does not redraw grey", () => {
    // `productColorVar` reads this token. Before the snapshot was wired it got
    // a null id and returned `var(--muted)` — a whole month of history in one
    // flat colour, which is the "unknown product" look, arrived at a different
    // way.
    expect(productViewFor(run(GONE), PRODUCTS)?.colorToken).toBe("product-1");
  });

  it("H6: is flagged, so a screen can say so if it wants to", () => {
    expect(isDeletedProductView(productViewFor(run(GONE), PRODUCTS))).toBe(true);
  });

  it("H7: falls back to the sku when only the sku was remembered", () => {
    const view = productViewFor(run({ ...GONE, productName: null }), PRODUCTS);
    expect(view?.name).toBe("WX");
  });

  it("H7b: naming neither is undefined — a shape the database's own CHECK forbids", () => {
    expect(productViewFor(run({ productId: null, productSku: null }), PRODUCTS)).toBeUndefined();
  });
});

describe("an assignment, which may hold its product or inherit it", () => {
  const RUNS: ReadonlyMap<string, Run> = new Map([
    ["live", run({ id: "live" })],
    ["gone", run({ id: "gone", ...GONE })],
  ]);

  it("H8 ⭐⭐: a crew row reads its RUN's snapshot, not its own", () => {
    // The run-attached shape carries no product at all — the snapshot lives on
    // the run — so this cannot be answered by looking at the assignment alone,
    // which is the entire reason `assignmentProductView` exists.
    const crew = asg({ runId: "gone", productId: null });
    expect(assignmentProductView(crew, RUNS, PRODUCTS)?.name).toBe("Widget X");
  });

  it("H9: a crew row on a live run still resolves the live product", () => {
    const crew = asg({ runId: "live", productId: null });
    expect(assignmentProductView(crew, RUNS, PRODUCTS)?.id).toBe("p1");
  });

  it("H10: a DIRECT row reads its own snapshot", () => {
    const direct = asg({ runId: null, ...GONE, productName: "Gone Part", productSku: "QQ" });
    expect(assignmentProductView(direct, RUNS, PRODUCTS)?.name).toBe("Gone Part");
  });

  it("H11: a hand-set hex colour survives the delete too", () => {
    const direct = asg({ runId: null, ...GONE, productColorToken: "#1baf7a" });
    expect(assignmentProductView(direct, RUNS, PRODUCTS)?.colorToken).toBe("#1baf7a");
  });

  it("H12: a run this window does not contain is undefined, not a guess", () => {
    expect(assignmentProductView(asg({ runId: "not-here" }), RUNS, PRODUCTS)).toBeUndefined();
  });
});

describe("a person who has been deleted", () => {
  it("H13: the live person resolves by id", () => {
    expect(operatorViewFor(asg({}), OPERATORS)?.displayName).toBe("Maria");
  });

  it("H14 ⭐: their finished shifts keep their name", () => {
    const row = asg({ operatorId: null, operatorDisplayName: "Dana Departing" });
    expect(operatorViewFor(row, OPERATORS)?.displayName).toBe("Dana Departing");
  });

  it("H15: and are marked inactive, because they are not on the roster", () => {
    const row = asg({ operatorId: null, operatorDisplayName: "Dana Departing" });
    expect(operatorViewFor(row, OPERATORS)?.active).toBe(false);
  });

  it("H16: they hold no qualifications — an empty list, not an absent one", () => {
    // `undefined` here would make every eligibility read guess; `[]` is the
    // true statement about somebody who no longer exists.
    const row = asg({ operatorId: null, operatorDisplayName: "Dana Departing" });
    expect(operatorViewFor(row, OPERATORS)?.skillIds).toEqual([]);
  });

  it("H17: naming neither is undefined", () => {
    expect(operatorViewFor(asg({ operatorId: null }), OPERATORS)).toBeUndefined();
  });
});

describe("the synthesised rows carry no identity that anything could look up", () => {
  it("H18 ⭐: an empty id, because there is no row to point at", () => {
    expect(productViewFor(run(GONE), PRODUCTS)?.id).toBe("");
    const departed = asg({ operatorId: null, operatorDisplayName: "Dana" });
    expect(operatorViewFor(departed, OPERATORS)?.id).toBe("");
  });

  it("H19 ⚠️: a deleted product has an EMPTY places list, offered nowhere (D115)", () => {
    // ⭐ D115 made the empty list the SAFE value rather than a hazard: a
    // synthesised product carries `siteNodeIds: []`, which `productOfferedAt`
    // reads as "offered at no cell" — the honest zero, not the fail-open "cannot
    // tell" a single unreadable owner used to be. It still never reaches the
    // picker (`productsOfferedHere` filters the arrays `board_window` returns and
    // nothing synthesised is ever put in them); this case pins the empty list.
    // The departed OPERATOR still carries `siteNodeId: ""` — operators kept the
    // single owner, and there the empty string fails OPEN, so it must never reach
    // offeredAt (it does not, for the same construction reason).
    expect(productViewFor(run(GONE), PRODUCTS)?.siteNodeIds).toEqual([]);
    const departed = asg({ operatorId: null, operatorDisplayName: "Dana" });
    expect(operatorViewFor(departed, OPERATORS)?.siteNodeId).toBe("");
  });

  it("H20: and are marked inactive, so nothing offers them for new work", () => {
    expect(productViewFor(run(GONE), PRODUCTS)?.active).toBe(false);
  });
});
