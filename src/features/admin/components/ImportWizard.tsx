/* ---------------------------------------------------------------------------
   ImportWizard — the entity-agnostic "choose, preview, apply" chrome.

   ⭐ ONE WIZARD FOR EVERY ENTITY. Products import first (§19.82), operators
   next, the tree one day — all the same shape: choose a CSV, download a template
   if unsure, map the columns, preview what would change, apply. Only what a row
   MEANS differs, and that is the caller's `buildView` / `onApply`. This component
   holds the file + column-map state and the presentation; it knows nothing about
   products or people. See `../lib/importView.ts` for the contract.

   DECIDES NOTHING about a row — `buildView` returns the `ImportView` it renders,
   and the required-column check, the counts and the per-row verdict all come from
   there. The admin gate is the caller's `canImport` (importing creates
   company-wide rows, a company-admin act).
   --------------------------------------------------------------------------- */
import { useMemo, useRef, useState } from "react";
import { describeSchedulerError, type SchedulerError } from "@/lib/api";
import { toCsv, parseCsvTable, type CsvTable } from "../lib/csv";
import { hasWork, type FieldDef, type ImportTemplate, type ImportView } from "../lib/importView";
import styles from "./ImportPanel.module.css";

export interface ImportWizardProps {
  /** Plural noun for headings — "products", "people". */
  entityPlural: string;
  /** Singular noun for the admin note — "part", "person". */
  entityNoun: string;
  fields: FieldDef[];
  template: ImportTemplate;
  templateFileName: string;
  /** Propose a column map (field key -> header key) from the parsed headers. */
  detect: (headerKeys: string[]) => Record<string, string | null>;
  /** The preview, computed from the table + the current column map. */
  buildView: (table: CsvTable, columns: Record<string, string | null>) => ImportView;
  /** May this reader apply? Importing creates company-wide rows (company admin). */
  canImport: boolean;
  /** Fire the import; `sourceName` is the file name, recorded as the row source. */
  onApply: (table: CsvTable, columns: Record<string, string | null>, sourceName: string) => void;
  applyState: {
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: SchedulerError | null;
  };
  applyResult: {
    inserted: number;
    updated: number;
    failed: { line: number; message: string }[];
  } | null;
  onResetApply: () => void;
  /** The entity's own reads (existing rows + plants) — for the loading/error gates. */
  dataLoading: boolean;
  dataError: SchedulerError | null;
}

export function ImportWizard(props: ImportWizardProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [columns, setColumns] = useState<Record<string, string | null> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const view = useMemo<ImportView | null>(() => {
    if (table === null || columns === null) return null;
    return props.buildView(table, columns);
    // props.buildView closes over the entity's fetched data; the caller passes a
    // stable function (useCallback) so this recomputes only on file/column change.
  }, [table, columns, props]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    const parsed = parseCsvTable(await file.text());
    setTable(parsed);
    setColumns(props.detect(parsed.headerKeys));
    setFileName(file.name);
    props.onResetApply();
  }

  function setColumn(key: string, value: string) {
    setColumns((cur) => (cur === null ? cur : { ...cur, [key]: value === "" ? null : value }));
  }

  function downloadTemplate() {
    const text = toCsv([props.template.headers, props.template.example]);
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = props.templateFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function startOver() {
    setTable(null);
    setColumns(null);
    setFileName(null);
    props.onResetApply();
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  }

  if (props.dataLoading) {
    return <p className={styles.status}>Loading…</p>;
  }
  if (props.dataError !== null) {
    return (
      <p className={styles.error} role="alert">
        {describeSchedulerError(props.dataError)}
      </p>
    );
  }

  const result = props.applyState.isSuccess ? props.applyResult : null;
  const applied = result !== null;
  const canApply = view !== null && view.missingRequired.length === 0 && hasWork(view);

  return (
    <>
      {/* ---- Step 1: choose a file ------------------------------------------ */}
      <section className={styles.card}>
        <h2 className={styles.h2}>Import {props.entityPlural} from a CSV</h2>
        <p className={styles.hint}>
          Choose a spreadsheet exported as CSV. Nothing is written until you have seen the preview
          and pressed Apply. Not sure of the format?{" "}
          <button type="button" className={styles.linkButton} onClick={downloadTemplate}>
            Download a template
          </button>{" "}
          with the right columns and an example row.
        </p>
        <dl className={styles.legend}>
          {props.template.legend.map((entry) => (
            <div key={entry.column} className={styles.legendRow}>
              <dt className={styles.legendTerm}>{entry.column}</dt>
              <dd className={styles.legendDesc}>{entry.means}</dd>
            </div>
          ))}
        </dl>
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

      {view !== null && columns !== null && (
        <>
          {/* ---- Step 2: map the columns ------------------------------------ */}
          <section className={styles.card}>
            <h2 className={styles.h2}>Match the columns</h2>
            <p className={styles.hint}>
              We guessed which column is which from the header. Change any that is wrong.
            </p>
            <div className={styles.form}>
              {props.fields.map((f) => (
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
            {view.missingRequired.length > 0 && (
              <p className={styles.error}>
                {view.missingRequired.length === 1
                  ? `No column is mapped to the ${view.missingRequired[0]}. Map it above before you can import.`
                  : `No columns are mapped to the ${view.missingRequired.join(
                      " or the ",
                    )}. Map them above before you can import.`}
              </p>
            )}
          </section>

          {/* ---- Step 3: preview -------------------------------------------- */}
          <section className={styles.card}>
            <h2 className={styles.h2}>Preview</h2>
            <p className={styles.counts}>
              {view.counts.insert} to add · {view.counts.update} to update · {view.counts.error}{" "}
              problem {view.counts.error === 1 ? "row" : "rows"}
            </p>
            {view.counts.error > 0 && (
              <p className={styles.skippedLine}>
                {view.counts.error === 1
                  ? "1 row has problems and will be skipped."
                  : `${view.counts.error} rows have problems and will be skipped.`}
              </p>
            )}
            {view.fileErrors.length > 0 && (
              <ul className={styles.fileErrors}>
                {view.fileErrors.map((e, i) => (
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
                    {props.fields.map((f) => (
                      <th key={f.key}>{f.label}</th>
                    ))}
                    <th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.line}>
                      <td className={styles.lineCell}>{row.line}</td>
                      {row.cells.map((c, i) => (
                        <td key={i}>{c}</td>
                      ))}
                      <td>
                        {row.kind === "insert" && (
                          <span className={`${styles.badge} ${styles.badgeInsert}`}>New</span>
                        )}
                        {row.kind === "update" && (
                          <span className={`${styles.badge} ${styles.badgeUpdate}`}>Update</span>
                        )}
                        {row.kind === "error" && (
                          <span className={styles.rowError}>
                            <span className={`${styles.badge} ${styles.badgeError}`}>Problem</span>{" "}
                            {row.messages.join("; ")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---- Step 4: apply ---------------------------------------------- */}
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
            ) : !props.canImport ? (
              <p className={styles.status}>
                Only a company admin can import {props.entityPlural}. You can review the preview
                above, but applying it is a company-admin act.
              </p>
            ) : view.missingRequired.length > 0 ? (
              <p className={styles.status}>Map the required column above before you can import.</p>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!canApply || props.applyState.isPending}
                  onClick={() => {
                    if (table !== null && columns !== null)
                      props.onApply(table, columns, fileName ?? "import");
                  }}
                >
                  {props.applyState.isPending
                    ? "Applying…"
                    : `Apply — add ${view.counts.insert}, update ${view.counts.update}`}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={props.applyState.isPending}
                  onClick={startOver}
                >
                  Start over
                </button>
                {!hasWork(view) && (
                  <p className={styles.status}>
                    Nothing to import — no row would add or update a {props.entityNoun}.
                  </p>
                )}
                {props.applyState.isError && props.applyState.error !== null && (
                  <p className={styles.error} role="alert">
                    {describeSchedulerError(props.applyState.error)}
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
