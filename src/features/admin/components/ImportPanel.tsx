/* ---------------------------------------------------------------------------
   CSV import (Products) — "choose, preview, apply" (§19.62).

   ⭐ `IMPORT_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`. The nav entry
   reads it, so turning this section on is a one-line edit to THIS file — the
   lane that builds the panel is the lane that flips it, and a section cannot be
   switched on without a panel behind it because the switch is part of the
   panel. Group H in `scaleAudit.test.ts` asserts the other half: every id in
   `SECTIONS` has a branch rendering it.

   TAKES NO PROPS and DECIDES NOTHING, the same rule `ProductsPanel` follows.
   Every judgement on this screen — which column is which, whether a row is an
   insert, an update or an error, and why — is a pure function in
   `../lib/csv.ts` / `../lib/productImport.ts` (tested without a network). This
   file reads a File, hands its text to those functions, and renders the plan
   they return. The catalogue read and the hierarchy read use the SAME query
   keys `ProductsPanel` uses, so React Query serves them from one request each.

   ⚠️ APPLYING CREATES COMPANY-WIDE PARTS, so it is a company-admin act
   (`profile.role === "admin"`), the same gate `ProductsPanel` puts on creating
   a part. A plant admin may see the preview — it is only a description — but the
   Apply button is replaced with a note saying only a company admin can import.
   --------------------------------------------------------------------------- */
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeSchedulerError, fetchHierarchyTree, type AdminProduct } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { useAdminProducts } from "../hooks/useProducts";
import { useProductImport } from "../hooks/useProductImport";
import { parseCsvTable, toCsv, type CsvTable } from "../lib/csv";
import {
  detectColumns,
  planProductImport,
  PRODUCT_TEMPLATE,
  type ColumnMap,
} from "../lib/productImport";
import { readablePlants } from "../lib/plantFilter";
import styles from "./ImportPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const IMPORT_PANEL_READY = true;

/** The four mappable fields, in the order the controls show them. */
const FIELDS: { key: keyof ColumnMap; label: string; required: boolean }[] = [
  { key: "sku", label: "Product code", required: true },
  { key: "name", label: "Name", required: true },
  { key: "externalId", label: "Import id", required: false },
  { key: "plant", label: "Plant", required: false },
];

export function ImportPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  // ⭐ The SAME reads `ProductsPanel` makes, by the SAME keys — the catalogue we
  // match a row against, and the tree the plant column resolves a name in.
  const productsQuery = useAdminProducts(canQuery);
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });

  const importMutation = useProductImport();

  // The chosen file, its parsed grid, and the (overridable) column map.
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [columns, setColumns] = useState<ColumnMap | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCompanyAdmin = profile?.role === "admin";

  // ⭐ WHAT A ROW MATCHES AGAINST. The nulls are the products this reader could
  // not read; they cannot be an import target, so they are dropped here.
  const existing = useMemo<AdminProduct[]>(
    () => (productsQuery.data ?? []).filter((p): p is AdminProduct => p !== null),
    [productsQuery.data],
  );

  // ⭐ WHAT THE PLANT COLUMN RESOLVES AGAINST — the readable roots, by name
  // (`planProductImport` case-folds the match). `readablePlants` returns the
  // roots in tree order; we only need id + name here.
  const plants = useMemo(
    () =>
      readablePlants(treeQuery.data?.nodes ?? []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [treeQuery.data?.nodes],
  );

  // ⭐ THE PREVIEW. Pure, memoised on the file, the mapping, and what exists —
  // recomputed the instant a human re-maps a column, never as a side effect.
  const plan = useMemo(() => {
    if (table === null || columns === null) return null;
    return planProductImport(table, existing, columns, plants);
  }, [table, columns, existing, plants]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const text = await file.text();
    const parsed = parseCsvTable(text);
    setTable(parsed);
    setColumns(detectColumns(parsed.headerKeys));
    setFileName(file.name);
    // A new file starts a fresh preview — forget any earlier result.
    importMutation.reset();
  }

  function setColumn(key: keyof ColumnMap, value: string) {
    setColumns((cur) => (cur === null ? cur : { ...cur, [key]: value === "" ? null : value }));
  }

  /**
   * Hand the user the model CSV — the exact headers this importer looks for,
   * plus one example row — so filling it in is the guided path and the columns
   * are never a guess. A Blob + a transient object URL + a synthetic click is the
   * ordinary browser download; nothing here reaches the server.
   */
  function downloadTemplate() {
    const text = toCsv([PRODUCT_TEMPLATE.headers, PRODUCT_TEMPLATE.example]);
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "products-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function startOver() {
    setTable(null);
    setColumns(null);
    setFileName(null);
    importMutation.reset();
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }

  function apply() {
    if (plan === null || profile === null) return;
    importMutation.mutate({
      plan,
      ctx: { orgId: profile.orgId, source: fileName ?? "import" },
    });
  }

  const loading = !canQuery || productsQuery.isLoading || treeQuery.isLoading;

  if (loading) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>Loading…</p>
      </div>
    );
  }

  if (productsQuery.isError) {
    return (
      <div className={styles.panel}>
        <p className={styles.error} role="alert">
          {productsQuery.error
            ? describeSchedulerError(productsQuery.error)
            : "Something went wrong. Please try again."}
        </p>
      </div>
    );
  }

  const result = importMutation.isSuccess ? importMutation.data : null;
  const applied = result !== null;

  // Apply is offered only for a real, complete plan — at least one row to write,
  // and every required column mapped.
  const writable = plan !== null ? plan.counts.insert + plan.counts.update : 0;
  const canApply = plan !== null && plan.missingRequired.length === 0 && writable > 0;

  return (
    <div className={styles.panel}>
      {/* ---- Step 1: choose a file --------------------------------------- */}
      <section className={styles.card}>
        <h2 className={styles.h2}>Import products from a CSV</h2>
        <p className={styles.hint}>
          Choose a spreadsheet exported as CSV. Nothing is written until you have seen the preview
          and pressed Apply. Not sure of the format?{" "}
          <button type="button" className={styles.linkButton} onClick={downloadTemplate}>
            Download a template
          </button>{" "}
          with the right columns and an example row.
        </p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>CSV file</span>
          <input
            ref={fileInputRef}
            className={styles.file}
            type="file"
            accept=".csv,text/csv"
            aria-label="Choose a CSV file"
            onChange={onFile}
          />
        </label>
        {fileName !== null && <p className={styles.status}>Reading “{fileName}”.</p>}
      </section>

      {/* Everything below appears once a file has been parsed. */}
      {plan !== null && columns !== null && (
        <>
          {/* ---- Step 2: map the columns --------------------------------- */}
          <section className={styles.card}>
            <h2 className={styles.h2}>Match the columns</h2>
            <p className={styles.hint}>
              We guessed which column is which from the header. Change any that is wrong. Code and
              name are required; import id and plant are optional.
            </p>
            <div className={styles.form}>
              {FIELDS.map((f) => (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {f.label}
                    {f.required ? " (required)" : ""}
                  </span>
                  <select
                    className={styles.input}
                    aria-label={`Column for ${f.label}`}
                    value={columns[f.key] ?? ""}
                    onChange={(e) => setColumn(f.key, e.target.value)}
                  >
                    <option value="">— none —</option>
                    {(table?.headerKeys ?? []).map((key, i) => (
                      <option key={`${key}-${i}`} value={key}>
                        {table?.header[i] ?? key}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {plan.missingRequired.length > 0 && (
              <p className={styles.error}>
                {plan.missingRequired.length === 1
                  ? `No column is mapped to the ${labelFor(plan.missingRequired[0])}. Map it above before you can import.`
                  : `No columns are mapped to the ${plan.missingRequired
                      .map(labelFor)
                      .join(" or the ")}. Map them above before you can import.`}
              </p>
            )}
          </section>

          {/* ---- Step 3: preview ----------------------------------------- */}
          <section className={styles.card}>
            <h2 className={styles.h2}>Preview</h2>
            <p className={styles.counts}>
              {plan.counts.insert} to add · {plan.counts.update} to update · {plan.counts.error}{" "}
              problem {plan.counts.error === 1 ? "row" : "rows"}
            </p>
            {plan.counts.error > 0 && (
              <p className={styles.skippedLine}>
                {plan.counts.error === 1
                  ? "1 row has problems and will be skipped."
                  : `${plan.counts.error} rows have problems and will be skipped.`}
              </p>
            )}
            {plan.fileErrors.length > 0 && (
              <ul className={styles.fileErrors}>
                {plan.fileErrors.map((e, i) => (
                  <li key={i} className={styles.error}>
                    Line {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            )}

            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Import id</th>
                    <th>Plant</th>
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((row) => (
                    <tr key={row.line}>
                      <td className={styles.lineCell}>{row.line}</td>
                      <td>{row.values.sku}</td>
                      <td>{row.values.name}</td>
                      <td>{row.values.externalId}</td>
                      <td>{row.values.plant}</td>
                      <td>
                        {row.outcome.kind === "insert" && (
                          <span className={`${styles.badge} ${styles.badgeInsert}`}>New</span>
                        )}
                        {row.outcome.kind === "update" && (
                          <span className={`${styles.badge} ${styles.badgeUpdate}`}>Update</span>
                        )}
                        {row.outcome.kind === "error" && (
                          <span className={styles.rowError}>
                            <span className={`${styles.badge} ${styles.badgeError}`}>Problem</span>{" "}
                            {row.outcome.messages.join("; ")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---- Step 4: apply ------------------------------------------- */}
          <section className={styles.card}>
            {applied ? (
              <div>
                <p className={styles.status}>
                  Added {result.inserted}, updated {result.updated}.
                </p>
                {result.failed.length > 0 && (
                  <>
                    <p className={styles.error}>
                      {result.failed.length === 1
                        ? "1 row was refused:"
                        : `${result.failed.length} rows were refused:`}
                    </p>
                    <ul className={styles.fileErrors}>
                      {result.failed.map((f, i) => (
                        <li key={i} className={styles.error}>
                          Line {f.line}: {f.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button type="button" className={styles.primary} onClick={startOver}>
                  Import another file
                </button>
              </div>
            ) : !isCompanyAdmin ? (
              // ⚠️ The Split: importing makes company-wide parts, so a plant admin
              // sees the preview but not the button.
              <p className={styles.status}>
                Only a company admin can import parts. You can review the preview above, but
                applying it is a company-admin act.
              </p>
            ) : plan.missingRequired.length > 0 ? (
              // ⚠️ A required column is unmapped, so there is no plan to apply —
              // don't offer the button at all. The "which column" sentence is up
              // in the mapping step.
              <p className={styles.status}>Map the required column above before you can import.</p>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!canApply || importMutation.isPending}
                  onClick={apply}
                >
                  {importMutation.isPending
                    ? "Applying…"
                    : `Apply — add ${plan.counts.insert}, update ${plan.counts.update}`}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={importMutation.isPending}
                  onClick={startOver}
                >
                  Start over
                </button>
                {writable === 0 && (
                  <p className={styles.status}>
                    Nothing to import — no row would add or update a part.
                  </p>
                )}
                {importMutation.isError && (
                  <p className={styles.error} role="alert">
                    {describeSchedulerError(importMutation.error)}
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** The human word for a required field, for the "unmapped" sentence. */
function labelFor(field: "sku" | "name"): string {
  return field === "sku" ? "product code" : "name";
}
