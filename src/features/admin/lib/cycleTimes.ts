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

/**
 * R-319: does this node add up its children, when nobody has said?
 *
 * ⭐ TRUE ONLY WHERE SUMMING IS RELIABLY RIGHT: a node whose OWN children are
 * the places work is booked. Those are a line's cells, sequential stations that
 * every unit passes through, so their times really do add. Anything higher —
 * an area over its lines, a plant over its areas — is treated as alternative
 * routes, because a unit goes down one line or the other and no unit ever costs
 * both. That was the maintainer's objection to the original blanket sum and it
 * is correct.
 *
 * Asked of the node's actual children rather than of level positions, so an
 * unevenly shaped tree answers honestly instead of by arithmetic on depths.
 *
 * A default, never a verdict: `sums_children` overrides it in either direction,
 * and a plant whose cells run in parallel is one toggle away from right.
 */
export function resolveSumsChildren(
  node: CycleGridNode,
  stored: boolean | null | undefined,
  nodes: readonly CycleGridNode[],
  schedulableLevelIds: ReadonlySet<string>,
): boolean {
  if (stored !== null && stored !== undefined) return stored;
  return nodes.some((n) => n.parentId === node.id && schedulableLevelIds.has(n.levelId));
}

export type CycleGridCell =
  /** A place work is booked and this part is made: the number lives here. */
  | { kind: "editable"; seconds: number | null }
  /**
   * An ancestor row: the labour content of the cells beneath it.
   *
   * `contributors` and `total` are both here so the screen can say when a sum
   * is only part of the picture. A total over 3 of 5 measured cells is not
   * wrong, but it is not the line's full labour content either, and a reader
   * who cannot tell the two apart will plan against the smaller number.
   */
  | { kind: "sum"; seconds: number; contributors: number; total: number }
  /**
   * R-319: an ancestor whose children are ALTERNATIVE ROUTES, so their times
   * are deliberately not added. `total` still says how many measured places sit
   * below, so the row reads as "not added up" rather than as "nothing here".
   */
  | { kind: "notsummed"; contributors: number; total: number }
  /** Neither — this part is not made anywhere at or below this row. */
  | { kind: "na" };

export interface CycleGridRow {
  node: CycleGridNode;
  /** Depth relative to the plant root, for indenting. */
  depth: number;
  isSchedulable: boolean;
  /** R-319: the effective answer for this row, stored or resolved. */
  sumsChildren: boolean;
  /** R-319: true when that answer came from `nodes.sums_children` rather than
   *  from the default, so the screen can show a chosen setting as chosen. */
  sumsChildrenIsSet: boolean;
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
  /** R-319: `nodes.sums_children` by node id. Missing or null resolves. */
  sumsChildren?: Readonly<Record<string, boolean | null>>;
  /** null means "all plants". */
  choice: string | null;
}): CycleGridBlock[] {
  const { nodes, levels, products, values, choice, sumsChildren = {} } = input;

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
      const stored = sumsChildren[node.id] ?? null;
      const sums = resolveSumsChildren(node, stored, nodes, schedulableLevels);
      const cells: CycleGridCell[] = columns.map((product) => {
        if (isSchedulable) {
          if (!offeredIn(product, node)) return { kind: "na" };
          return { kind: "editable", seconds: valueByKey.get(`${node.id}|${product.id}`) ?? null };
        }
        // R-317: the sum of the measured cells beneath this row. Cells with no
        // number contribute nothing rather than a zero — an unmeasured station
        // is unknown work, not free work — and `contributors` lets the screen
        // say so when the total is only part of the picture.
        //
        // ⭐ A ROW THAT ADDS UP TOTALS EVERY MEASURED PLACE BELOW IT, not the
        // values of its immediate children. So a plant set to add up gives the
        // same figure whether or not the areas between say they add up
        // themselves. The alternative — composing each level from the one under
        // it — makes a parent blank whenever any child declines, which is a
        // number disappearing for a reason two levels away. Ticking a row is a
        // statement about that row: "units pass through everything under me."
        let sum = 0;
        let contributors = 0;
        let total = 0;
        for (const descendant of inPlant) {
          if (!schedulableLevels.has(descendant.levelId)) continue;
          if (!isAtOrBelow(descendant.path, node.path)) continue;
          if (!offeredIn(product, descendant)) continue;
          total += 1;
          const seconds = valueByKey.get(`${descendant.id}|${product.id}`);
          if (seconds !== undefined) {
            sum += seconds;
            contributors += 1;
          }
        }
        if (total === 0) return { kind: "na" };
        // R-319: the children are alternative routes, so there is nothing to
        // add. The counts still travel, so the row can say it is not adding up
        // rather than looking like a place nothing was ever entered.
        if (!sums) return { kind: "notsummed", contributors, total };
        return { kind: "sum", seconds: sum, contributors, total };
      });
      return {
        node,
        depth: node.path.split(".").length - plantDepth,
        isSchedulable,
        sumsChildren: sums,
        sumsChildrenIsSet: stored !== null,
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
