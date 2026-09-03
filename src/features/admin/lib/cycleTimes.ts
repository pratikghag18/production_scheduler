/**
 * The cycle-times grid, as pure data (R-315, R-317).
 *
 * One block per plant. Rows are that plant's tree in path order; columns are
 * the parts that plant makes. A cell is EDITABLE where work is actually booked
 * (the schedulable level) and the part is offered there; every row above shows
 * the SUM of the editable cells beneath it, and everything else is blank.
 *
 * ⭐ WHY THE ROLL-UP IS A SUM, AND WHY IT IS ONLY EVER DISPLAYED.
 *
 * The maintainer's model: "for the same product the standard time at a
 * hierarchy 1 level above is the summation of standard cycle time in the level
 * below." As LABOUR CONTENT PER UNIT that is exactly right — two cells taking
 * 60 s and 90 s put 150 s of work into each unit, which is the number you cost
 * and staff against.
 *
 * It is NOT the line's output rate, and nothing here lets it become one. If the
 * cells are sequential stations the line ships a unit every 90 s (the slowest
 * cell), and if they run in parallel it ships one every 36 s — neither is 150.
 * So the sum is rendered, labelled as standard time per unit, and never fed to
 * `standardTargetQty`: a derived target always reads the cell's OWN number
 * (R-316). Computing the roll-up on read rather than storing it also means it
 * cannot go stale when one cell is re-measured.
 *
 * ⚠️ UNITS ARE AN INPUT AND DISPLAY CONVENIENCE ONLY. Seconds are what is
 * stored (the maintainer: "store it in the database in seconds so it is
 * consistent"), and `displayCycle` will only offer a larger unit when the
 * conversion is exact — otherwise opening a row and saving it unchanged would
 * quietly round 100 s into 1.7 min and back into 102 s.
 *
 * Pure: no imports that touch the network, so this is unit-testable whole.
 */
import { isAtOrBelow } from "./scope";

/* ===========================================================================
 * Units. Entered as seconds, minutes or hours; always stored as seconds.
 * ======================================================================== */

export type CycleUnit = "s" | "min" | "h";

export const CYCLE_UNITS: readonly CycleUnit[] = ["s", "min", "h"];

const SECONDS_IN: Record<CycleUnit, number> = { s: 1, min: 60, h: 3600 };

export function toSeconds(value: number, unit: CycleUnit): number {
  return value * SECONDS_IN[unit];
}

/** Is `x` written exactly with at most one decimal place? */
function exactAtOneDecimal(x: number): boolean {
  return Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * The friendliest EXACT way to write this many seconds.
 *
 * ⚠️ Exactness is the whole rule. 5400 s is unambiguously 1.5 h and 90 s is
 * 1.5 min, but 100 s is not any tidy number of minutes — showing it as 1.7 min
 * would make re-saving an untouched row change the stored value. When in doubt
 * it stays in seconds, which is always exact.
 */
export function displayCycle(seconds: number): { value: number; unit: CycleUnit } {
  if (seconds >= 3600 && exactAtOneDecimal(seconds / 3600)) {
    return { value: round1(seconds / 3600), unit: "h" };
  }
  if (seconds >= 60 && exactAtOneDecimal(seconds / 60)) {
    return { value: round1(seconds / 60), unit: "min" };
  }
  return { value: seconds, unit: "s" };
}

/** "1.5 h", "90 s" — the read-only rendering, including for a summed row. */
export function formatCycle(seconds: number): string {
  const { value, unit } = displayCycle(seconds);
  return `${value} ${unit}`;
}

/**
 * A typed entry in seconds, or a sentence saying why it is not one.
 *
 * Returns the message rather than throwing because the caller is a grid cell
 * that has to show it beside the input. Zero and negatives are refused here AND
 * by a CHECK constraint (case C4 of the SQL test): zero seconds a unit would
 * mean infinite output.
 */
export function validateCycleEntry(raw: string, unit: CycleUnit): number | string {
  const trimmed = raw.trim();
  if (trimmed === "") return "Enter a cycle time, or clear the cell to remove it.";
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "That is not a number.";
  if (value <= 0) return "A cycle time must be greater than zero.";
  const seconds = toSeconds(value, unit);
  if (!Number.isFinite(seconds) || seconds <= 0) return "A cycle time must be greater than zero.";
  // Thousandths of a second is far finer than any standard is measured to, and
  // it keeps float noise (0.1 * 3 = 0.30000000000000004) out of the database.
  return Math.round(seconds * 1000) / 1000;
}

/* ===========================================================================
 * The grid.
 * ======================================================================== */

export interface CycleGridNode {
  id: string;
  parentId: string | null;
  levelId: string;
  name: string;
  path: string;
}

export interface CycleGridLevel {
  id: string;
  isSchedulable: boolean;
}

export interface CycleGridProduct {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  siteNodeIds: readonly string[];
}

export interface CycleGridValue {
  nodeId: string;
  productId: string;
  secondsPerUnit: number;
}

export type CycleGridCell =
  /** A place work is booked and this part is made: the number lives here. */
  | { kind: "editable"; seconds: number | null }
  /** An ancestor row: the labour content of the cells beneath it. */
  | { kind: "sum"; seconds: number; contributors: number }
  /** Neither — this part is not made anywhere at or below this row. */
  | { kind: "na" };

export interface CycleGridRow {
  node: CycleGridNode;
  /** Depth relative to the plant root, for indenting. */
  depth: number;
  isSchedulable: boolean;
  /** Parallel to the block's `columns`. */
  cells: CycleGridCell[];
}

export interface CycleGridBlock {
  plant: { id: string; name: string; path: string };
  columns: CycleGridProduct[];
  rows: CycleGridRow[];
}

/**
 * One block per plant the reader can see, trimmed to the plant filter's choice.
 *
 * ⚠️ ANCESTRY IS `isAtOrBelow`, NEVER `startsWith`. `plant1.line1` is not an
 * ancestor of `plant1.line10`, and the label-wise test is the only one that
 * knows that — the trap `scope.ts` was written around and `scope.test.ts` pins.
 */
export function buildCycleGrid(input: {
  nodes: readonly CycleGridNode[];
  levels: readonly CycleGridLevel[];
  products: readonly CycleGridProduct[];
  values: readonly CycleGridValue[];
  /** null means "all plants". */
  choice: string | null;
}): CycleGridBlock[] {
  const { nodes, levels, products, values, choice } = input;

  const schedulableLevels = new Set(levels.filter((l) => l.isSchedulable).map((l) => l.id));
  const nodesById = new Map(nodes.map((n) => [n.id, n] as const));
  const valueByKey = new Map(values.map((v) => [`${v.nodeId}|${v.productId}`, v.secondsPerUnit]));

  const activeProducts = products.filter((p) => p.active);

  const plants = nodes
    .filter((n) => n.parentId === null)
    .filter((n) => choice === null || n.id === choice)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return plants.map((plant) => {
    const inPlant = nodes
      .filter((n) => isAtOrBelow(n.path, plant.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // A part is a column here when it is offered anywhere in this plant, not
    // only at its root: a part attached to one line belongs on that plant's
    // grid. Offering is the union over the part's places, the same question
    // `app_product_offered_at` asks.
    const offeredIn = (product: CycleGridProduct, node: CycleGridNode): boolean =>
      product.siteNodeIds.some((placeId) => {
        const place = nodesById.get(placeId);
        // Fail open on a place this reader cannot resolve, exactly as
        // `productOfferedAt` does: let the server be the one to refuse.
        if (place === undefined) return true;
        return isAtOrBelow(node.path, place.path);
      });

    const columns = activeProducts
      .filter((p) => inPlant.some((n) => offeredIn(p, n)))
      .sort((a, b) => a.sku.localeCompare(b.sku));

    const plantDepth = plant.path.split(".").length;

    const rows: CycleGridRow[] = inPlant.map((node) => {
      const isSchedulable = schedulableLevels.has(node.levelId);
      const cells: CycleGridCell[] = columns.map((product) => {
        if (isSchedulable) {
          if (!offeredIn(product, node)) return { kind: "na" };
          return { kind: "editable", seconds: valueByKey.get(`${node.id}|${product.id}`) ?? null };
        }
        // R-317: the sum of the measured cells beneath this row. Cells with no
        // number contribute nothing rather than a zero — an unmeasured station
        // is unknown work, not free work — and `contributors` lets the screen
        // say so when the total is only part of the picture.
        let total = 0;
        let contributors = 0;
        let anyEditable = false;
        for (const descendant of inPlant) {
          if (!schedulableLevels.has(descendant.levelId)) continue;
          if (!isAtOrBelow(descendant.path, node.path)) continue;
          if (!offeredIn(product, descendant)) continue;
          anyEditable = true;
          const seconds = valueByKey.get(`${descendant.id}|${product.id}`);
          if (seconds !== undefined) {
            total += seconds;
            contributors += 1;
          }
        }
        if (!anyEditable) return { kind: "na" };
        if (contributors === 0) return { kind: "sum", seconds: 0, contributors: 0 };
        return { kind: "sum", seconds: total, contributors };
      });
      return {
        node,
        depth: node.path.split(".").length - plantDepth,
        isSchedulable,
        cells,
      };
    });

    return { plant: { id: plant.id, name: plant.name, path: plant.path }, columns, rows };
  });
}

/** How many cells in a block are measured — the panel's one-line summary. */
export function countMeasured(block: CycleGridBlock): number {
  let n = 0;
  for (const row of block.rows) {
    for (const cell of row.cells) {
      if (cell.kind === "editable" && cell.seconds !== null) n += 1;
    }
  }
  return n;
}
