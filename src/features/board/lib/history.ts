/**
 * Drawing history after the thing it names has been deleted (D110, migration
 * 0029).
 *
 * ⭐⭐ WHY THIS MODULE EXISTS, AND IT IS NOT A NICETY. D110 keeps a started run
 * after its product is deleted: `product_id` is released to NULL and the sku,
 * name and colour are copied onto the run itself, so last month's board still
 * says what it made. Every board component looked the product up by id —
 * `productById.get(run.productId)` — which for a deleted product resolves to
 * `undefined`, and `undefined` renders as **"(unknown product)" in grey**.
 *
 * That is precisely the outcome the snapshot was added to prevent. The columns
 * shipped, and nothing read them.
 *
 * ⚠️ AND THE PARSER WAS WORSE. `Run.productId` was typed `string` with a
 * runtime guard demanding one, so a snapshotted run parsed as `null` — and
 * `parseArrayOf` nulls the WHOLE ARRAY on the first item that fails, so the
 * board would have stopped loading entirely, for everyone, with an error about
 * a shape rather than about a product. Fixed in `shapes.ts` in the same change
 * as this file.
 *
 * PURE. Imports one type and nothing at runtime, so a probe can call it against
 * real rows without a network.
 */
import type { Assignment, BoardOperator, Product, Run } from "@/lib/api";

/** The four fields D110 writes onto a run, and onto a direct assignment. */
export interface ProductHistory {
  productId: string | null;
  productSku: string | null;
  productName: string | null;
  productColorToken: string | null;
}

/**
 * ⭐ A DELETED PRODUCT IS RETURNED AS A `Product` WITH AN EMPTY `id`, AND THE
 * EMPTINESS IS THE SIGNAL. It cannot carry the real id — there is no row to
 * point at any more — and inventing one would put a value in front of a
 * component that no lookup anywhere could resolve.
 *
 * ⚠️ `siteNodeIds` AND `offeredNodeIds` ARE BOTH EMPTY, AND THAT IS THE SAFE
 * VALUE RATHER THAN A HAZARD. `offeredNodeIds` is the one the picker asks
 * (0042 / DEF-0005), and an empty one means offered at no node in this window —
 * so even if a synthesised row reached the picker it would simply not be
 * offered; it still never does, because `productsOfferedAtNode`
 * filters the catalogue array `board_window` returns and nothing synthesised is
 * ever put in it.
 */
function deletedProduct(row: ProductHistory): Product | undefined {
  if (row.productSku === null) return undefined;
  return {
    id: "",
    sku: row.productSku,
    name: row.productName ?? row.productSku,
    active: false,
    siteNodeIds: [],
    offeredNodeIds: [],
    colorToken: row.productColorToken ?? "",
  };
}

/**
 * The product to draw for a run or a direct assignment: the live row while it
 * exists, the remembered one afterwards, `undefined` only when the row names
 * neither — which the database's own `runs_product_identified` check makes
 * impossible, so `undefined` here means a payload this client cannot read.
 */
export function productViewFor(
  row: ProductHistory,
  productById: ReadonlyMap<string, Product>,
): Product | undefined {
  if (row.productId !== null) return productById.get(row.productId);
  return deletedProduct(row);
}

/**
 * The same question for an assignment, which may hold its product directly or
 * inherit it from its run — and the run is where the snapshot lives for the
 * run-attached shape, so this cannot be done by looking at the assignment
 * alone.
 */
export function assignmentProductView(
  a: Assignment,
  runById: ReadonlyMap<string, Run>,
  productById: ReadonlyMap<string, Product>,
): Product | undefined {
  if (a.runId !== null) {
    const run = runById.get(a.runId);
    return run === undefined ? undefined : productViewFor(run, productById);
  }
  return productViewFor(a, productById);
}

/**
 * The person to draw: the live row while they exist, otherwise the name
 * remembered at the moment they were deleted.
 *
 * ⚠️ The synthesised row is marked `active: false` and carries an empty `id`,
 * for the same reasons as `deletedProduct`. `skillIds` is empty rather than
 * absent: a departed person holds no qualifications, and an empty list is a
 * true statement where `undefined` would make every eligibility read guess.
 * ⚠️ `siteNodeId` IS EMPTY AND MUST NEVER REACH `offeredAt`, for the same
 * reason as `deletedProduct` above: that predicate FAILS OPEN on an owner it
 * cannot resolve, so a departed person handed to it would read as belonging
 * everywhere. Nothing synthesised here is ever put in the operators array the
 * popover filters — that array comes straight from `board_window`.
 */
export function operatorViewFor(
  a: Pick<Assignment, "operatorId" | "operatorDisplayName">,
  operatorById: ReadonlyMap<string, BoardOperator>,
): BoardOperator | undefined {
  if (a.operatorId !== null) return operatorById.get(a.operatorId);
  if (a.operatorDisplayName === null) return undefined;
  return {
    id: "",
    homeNodeId: null,
    displayName: a.operatorDisplayName,
    employeeRef: null,
    active: false,
    siteNodeId: "",
    skillIds: [],
    // F-087 / 0048. Empty for the same reason `skillIds` is: a departed person
    // holds no certificate, so none of theirs can be expiring, and an empty
    // list is a true statement where `undefined` would make every eligibility
    // read guess.
    skillExpiries: [],
  };
}

/**
 * True when this row is drawing something that no longer exists — for a badge,
 * a tooltip, or simply for a test to be able to tell the two apart.
 */
export function isDeletedProductView(p: Product | undefined): boolean {
  return p !== undefined && p.id === "";
}
