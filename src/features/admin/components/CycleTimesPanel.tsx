/**
 * Cycle times — one grid per plant (R-315, R-317).
 *
 * Rows are the plant's tree, columns the parts it makes. The number is typed
 * only where work is booked; every row above shows the labour content of the
 * cells beneath it, and is never editable.
 *
 * ⭐ THE UNIT IS A CHOICE PER CELL, AND ONLY SECONDS ARE STORED. The maintainer
 * asked for seconds, minutes and hours on entry because a part can take a
 * second or half a day; the select converts, and `displayCycle` picks the
 * friendliest EXACT unit on the way back so re-saving an untouched row cannot
 * change what is stored.
 *
 * ⭐ NOTHING HERE IS REQUIRED. A blank cell is the ordinary state — its
 * assignments simply show no target, exactly as they did before this screen
 * existed — so there is no validation nagging an empty grid and no "not set"
 * warning anywhere.
 *
 * ⚠️ EDIT CONTROLS ARE OFFERED BROADLY AND THE SERVER IS THE ANSWER. `isAdminAt`
 * mirrors `app_is_admin_for`'s ancestor walk with `isAtOrBelow`, the rule
 * CLAUDE.md §4 states (what a client offers must be decided by the same test the
 * server runs), but it is built from a preview read that can itself fail. When
 * it does, the grid still offers the inputs and lets the write be refused,
 * rather than showing a read-only screen to someone who may in fact edit.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeSchedulerError, fetchHierarchyTree, isSchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useAdminProducts } from "../hooks/useProducts";
import {
  useCycleTimes,
  useSetCycleTime,
  useClearCycleTime,
  useSetNodeRollup,
} from "../hooks/useCycleTimes";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { isAtOrBelow, scopeIndex } from "../lib/scope";
import { InlineEdit } from "@/components/InlineEdit";
import fieldStyles from "@/components/Field.module.css";
import {
  buildCycleGrid,
  countMeasured,
  displayCycle,
  formatCycle,
  validateCycleEntry,
  CYCLE_UNITS,
  type CycleUnit,
} from "../lib/cycleTimes";
import styles from "./CycleTimesPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const CYCLE_TIMES_PANEL_READY = true;

const UNIT_LABEL: Record<CycleUnit, string> = { s: "sec", min: "min", h: "hr" };

export function CycleTimesPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const productsQuery = useAdminProducts(canQuery);
  const cycleQuery = useCycleTimes(canQuery);
  // The SAME key `AdminPage` and `ProductsPanel` use, so all three share one
  // request and one cache entry.
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });

  const setMutation = useSetCycleTime();
  const clearMutation = useClearCycleTime();
  const rollupMutation = useSetNodeRollup();

  // The unit the OPEN editor is using. One value, not one per cell: only one
  // cell is ever open, and `InlineEdit`'s `onOpen` seeds this from the stored
  // value so a box opens in the unit its number reads best in.
  const [unit, setUnit] = useState<CycleUnit>("s");
  const [cellError, setCellError] = useState<{ key: string; message: string } | null>(null);
  const [rowError, setRowError] = useState<{ nodeId: string; message: string } | null>(null);

  const isCompanyAdmin = profile?.role === "admin";
  const allNodes = treeQuery.data?.nodes ?? [];
  const nodesById = scopeIndex(allNodes);
  const plant = usePlantFilter(allNodes);

  // The client mirror of `app_is_admin_for`: an admin grant on an
  // ancestor-or-self of the node. Same shape as ProductsPanel's.
  const editableShapeIds = treeQuery.data?.editableShapeIds ?? null;
  const siteNodeIds: Record<string, string | null> = treeQuery.data?.siteNodeIds ?? {};
  const adminPaths =
    editableShapeIds === null
      ? []
      : editableShapeIds
          .map((shapeId) => siteNodeIds[shapeId] ?? null)
          .filter((id): id is string => id !== null)
          .map((id) => nodesById.get(id)?.path)
          .filter((p): p is string => p !== undefined);
  // Fails OPEN when the preview read failed: offer the input, let the server
  // refuse. A read-only grid shown to someone who may edit is the worse error.
  const previewUnavailable = !isCompanyAdmin && (treeQuery.isError || editableShapeIds === null);
  const isAdminAt = (nodeId: string): boolean => {
    if (isCompanyAdmin || previewUnavailable) return true;
    const node = nodesById.get(nodeId);
    if (node === undefined) return false;
    return adminPaths.some((p) => isAtOrBelow(node.path, p));
  };

  const products = (productsQuery.data ?? []).filter((p) => p !== null);
  const values = (cycleQuery.data ?? []).filter((v) => v !== null);
  const unreadable = (cycleQuery.data ?? []).filter((v) => v === null).length;

  const blocks = buildCycleGrid({
    nodes: allNodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      levelId: n.levelId,
      name: n.name,
      path: n.path,
    })),
    levels: (treeQuery.data?.levels ?? []).map((l) => ({
      id: l.id,
      isSchedulable: l.isSchedulable,
    })),
    products: products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      active: p.active,
      siteNodeIds: p.siteNodeIds,
    })),
    values: values.map((v) => ({
      nodeId: v.nodeId,
      productId: v.productId,
      secondsPerUnit: v.secondsPerUnit,
    })),
    sumsChildren: treeQuery.data?.sumsChildren ?? {},
    choice: plant.choice,
  });

  const cellKey = (nodeId: string, productId: string) => `${nodeId}|${productId}`;

  // R-319. The refusal lands on the row rather than a cell, because the choice
  // is the row's; `rowError` is keyed by node id for that reason.
  async function toggleRollup(nodeId: string, sumsChildren: boolean) {
    setRowError(null);
    try {
      await rollupMutation.mutateAsync({ nodeId, sumsChildren });
    } catch (err) {
      setRowError({ nodeId, message: describe(err) });
    }
  }

  async function commitEdit(
    nodeId: string,
    productId: string,
    draft: string,
    stored: number | null,
  ) {
    const key = cellKey(nodeId, productId);

    // ⚠️ THE DRAFT IS WHAT WAS TYPED, WHICH MAY BE A UNIT-CARRYING STRING. The
    // resting box shows "1.5 min", so re-opening it and saving unchanged hands
    // back "1.5 min", not "1.5". Stripping the unit word here means an
    // untouched save is a no-op rather than a hundred-fold error.
    const typed = draft.trim().replace(/\s*(s|sec|min|h|hr)$/i, "");

    // An emptied box CLEARS the cell — a real act, not a validation failure.
    // Its assignments go back to showing no target.
    if (typed === "") {
      if (stored === null) return;
      try {
        await clearMutation.mutateAsync({ nodeId, productId });
        setCellError(null);
      } catch (err) {
        setCellError({ key, message: describe(err) });
      }
      return;
    }

    const seconds = validateCycleEntry(typed, unit);
    if (typeof seconds === "string") {
      setCellError({ key, message: seconds });
      return;
    }
    if (seconds === stored) return;
    try {
      await setMutation.mutateAsync({
        orgId: profile?.orgId ?? "",
        nodeId,
        productId,
        secondsPerUnit: seconds,
      });
      setCellError(null);
    } catch (err) {
      setCellError({ key, message: describe(err) });
    }
  }

  if (cycleQuery.isError || productsQuery.isError) {
    return (
      <p className={styles.error}>
        Cycle times could not be loaded. {describe(cycleQuery.error ?? productsQuery.error ?? null)}
      </p>
    );
  }

  if (cycleQuery.isLoading || productsQuery.isLoading || treeQuery.isLoading) {
    return <p className={styles.muted}>Loading…</p>;
  }

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        The standard time to make one unit at each place work is scheduled. An assignment with no
        target of its own shows what this implies for the time it covers, less breaks. Leaving a
        cell blank is fine — those assignments simply show no target.
      </p>

      {unreadable > 0 && (
        <p className={styles.muted}>
          {unreadable} cycle time{unreadable === 1 ? "" : "s"} could not be read and{" "}
          {unreadable === 1 ? "is" : "are"} not shown.
        </p>
      )}

      {blocks.length === 0 && <p className={styles.muted}>No plants to show.</p>}

      {blocks.map((block) => (
        <section key={block.plant.id} className={styles.block}>
          <h2 className={styles.plantName}>{block.plant.name}</h2>
          {block.columns.length === 0 ? (
            <p className={styles.muted}>
              No parts are made in this plant yet. Add one on the Products screen first.
            </p>
          ) : (
            <>
              <p className={styles.count}>
                {countMeasured(block)} of{" "}
                {block.rows.reduce(
                  (n, r) => n + r.cells.filter((c) => c.kind === "editable").length,
                  0,
                )}{" "}
                places measured
              </p>
              <div className={styles.scroll}>
                <table className={styles.grid}>
                  <thead>
                    <tr>
                      <th scope="col" className={styles.rowHead}>
                        Place
                      </th>
                      {block.columns.map((product) => (
                        <th key={product.id} scope="col" className={styles.colHead}>
                          <span className={styles.sku}>{product.sku}</span>
                          <span className={styles.partName}>{product.name}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.node.id}>
                        <th scope="row" className={styles.rowHead}>
                          <span style={{ paddingLeft: `${row.depth * 0.85}rem` }}>
                            {row.node.name}
                          </span>
                          {/* R-319: the choice sits on the row whose number it
                              decides. Only where there is something to add up —
                              a cell has no children, and a row with no measured
                              places below has nothing to decide about. */}
                          {!row.isSchedulable &&
                            row.cells.some((c) => c.kind === "sum" || c.kind === "notsummed") && (
                              <label className={styles.rollup}>
                                <input
                                  type="checkbox"
                                  checked={row.sumsChildren}
                                  disabled={!isAdminAt(row.node.id)}
                                  onChange={(e) => void toggleRollup(row.node.id, e.target.checked)}
                                />
                                adds up
                              </label>
                            )}
                          {rowError?.nodeId === row.node.id && (
                            <p className={styles.cellError}>{rowError.message}</p>
                          )}
                        </th>
                        {row.cells.map((cell, i) => {
                          const product = block.columns[i]!;
                          const key = cellKey(row.node.id, product.id);

                          // Read-only cells wear the box's geometry with none
                          // of its skin, so they line up with the editable ones
                          // rather than sitting a border-and-padding to the left.
                          if (cell.kind === "na") {
                            return (
                              <td key={product.id} className={styles.na} aria-label="not made here">
                                <span className={`${fieldStyles.readonly} ${styles.dash}`}>—</span>
                              </td>
                            );
                          }

                          // R-319: children that are alternative routes are
                          // deliberately not added. Said in words, because a
                          // bare dash here would read as "nothing entered".
                          if (cell.kind === "notsummed") {
                            return (
                              <td key={product.id} className={styles.sum}>
                                <span
                                  className={fieldStyles.readonly}
                                  title={`Not added up: the places under ${row.node.name} are alternatives, so a unit passes through one of them, not all. ${cell.contributors} of ${cell.total} below are measured.`}
                                >
                                  <span className={styles.dash}>not added</span>
                                </span>
                              </td>
                            );
                          }

                          if (cell.kind === "sum") {
                            return (
                              <td key={product.id} className={styles.sum}>
                                <span
                                  className={fieldStyles.readonly}
                                  // Spelled out here rather than on screen: the
                                  // cell is 9.5rem wide and the sentence would
                                  // not fit without wrapping every summed row
                                  // to twice the height of the others.
                                  title={
                                    cell.contributors === 0
                                      ? `No cycle time set at any of the ${cell.total} places below`
                                      : `Standard time per unit, summed over ${cell.contributors} of ${cell.total} places below`
                                  }
                                >
                                  {cell.contributors === 0 ? (
                                    <span className={styles.dash}>—</span>
                                  ) : (
                                    <>
                                      {formatCycle(cell.seconds)}
                                      {/* Shown ONLY when the sum is partial.
                                          A complete total needs no annotation;
                                          an incomplete one must not be mistaken
                                          for the line's full labour content. */}
                                      {cell.contributors < cell.total && (
                                        <span className={styles.sumNote}>
                                          {" "}
                                          {cell.contributors}/{cell.total}
                                        </span>
                                      )}
                                    </>
                                  )}
                                </span>
                              </td>
                            );
                          }

                          const mayEdit = isAdminAt(row.node.id);
                          const shown = cell.seconds === null ? "" : formatCycle(cell.seconds);
                          // The box holds the NUMBER; the select beside it
                          // holds the unit. Seeding the box with "1.5 min"
                          // would state the unit twice and make clearing it to
                          // type a bare number quietly change what it means.
                          const editable =
                            cell.seconds === null ? "" : String(displayCycle(cell.seconds).value);
                          return (
                            <td key={product.id} className={styles.cell}>
                              <InlineEdit
                                value={shown}
                                editValue={editable}
                                ariaLabel={`Cycle time for ${product.sku} at ${row.node.name}`}
                                placeholder="0"
                                disabled={!mayEdit}
                                title={
                                  mayEdit
                                    ? "Set the standard cycle time"
                                    : "You do not administer this part of the structure"
                                }
                                error={cellError?.key === key ? cellError.message : null}
                                // The stored value decides which unit the box
                                // opens in, so 90 s opens as "1.5 min" and
                                // saving it untouched writes 90 s back.
                                onOpen={() => {
                                  setUnit(
                                    cell.seconds === null ? "s" : displayCycle(cell.seconds).unit,
                                  );
                                  setCellError(null);
                                }}
                                onCancel={() => setCellError(null)}
                                onSave={(draft) =>
                                  void commitEdit(row.node.id, product.id, draft, cell.seconds)
                                }
                                adornment={
                                  <select
                                    className={fieldStyles.select}
                                    aria-label="Unit"
                                    value={unit}
                                    onChange={(e) => setUnit(e.target.value as CycleUnit)}
                                  >
                                    {CYCLE_UNITS.map((u) => (
                                      <option key={u} value={u}>
                                        {UNIT_LABEL[u]}
                                      </option>
                                    ))}
                                  </select>
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

function describe(err: unknown): string {
  if (isSchedulerError(err)) {
    // The two the placement guard raises are worth naming plainly; everything
    // else already reads well through the shared describer.
    if (err.kind === "NotOfferedHere") {
      return "That part is not made in this part of the structure.";
    }
    if (err.kind === "WriteRefused") {
      return "You do not administer this part of the structure, so nothing was saved.";
    }
    return describeSchedulerError(err);
  }
  return "Something went wrong.";
}
