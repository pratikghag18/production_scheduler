/**
 * csv.ts — an RFC 4180 CSV parser, entity-agnostic, dependency-free.
 *
 * ⭐ WHY A HAND-ROLLED PARSER AND NOT A LIBRARY. This is the one piece of the
 * import that every entity (products first, operators and the tree next) shares,
 * and it must be unit-testable with no network and no bundle — it runs under
 * `node --experimental-strip-types` like the rest of `features/admin/lib`. A
 * split-on-comma "parser" is the thing this exists to not be: a real spreadsheet
 * export quotes any field containing a comma, a newline, or a quote, and doubles
 * an interior quote (`""`). Getting that wrong silently corrupts exactly the rows
 * a human could not eyeball — the long product names with commas in them.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE RULES IT IMPLEMENTS (RFC 4180, plus the two real-world tolerances):
 *
 *  - Fields are separated by commas; records by a line break.
 *  - A field may be wrapped in double quotes; inside quotes a comma, a CR, an LF
 *    and a doubled `""` (one literal quote) are all ordinary content.
 *  - RECORDS MAY BE SEPARATED BY CRLF OR LF. RFC 4180 says CRLF; every export
 *    from a Unix tool says LF, and Windows Excel says CRLF. A CR that is not part
 *    of a line break (a bare CR mid-file) is treated as a line break too.
 *  - ⚠️ A BOM (U+FEFF) at the very start is stripped. Excel writes one on "CSV
 *    UTF-8", and without this the first header cell becomes U+FEFF followed by
 *    `sku` and no column maps. (The server's `app_trim_ws` strips U+FEFF from
 *    names, but that is downstream of column mapping — the BOM has to die here or
 *    the HEADER is already wrong.)
 *  - A trailing line break does not produce a final empty record.
 *  - Whitespace is PRESERVED here (each field is returned verbatim); trimming is
 *    the caller's decision, because a field that is all spaces and a field that
 *    is empty can mean different things to different importers.
 *
 * ⚠️ WHAT IT DOES NOT DO: it does not interpret the header, map columns, or know
 * what a product is. It turns bytes into a grid. `productImport.ts` is the half
 * that knows the columns. Keeping the two apart is what lets the same grid feed
 * operators and the tree next.
 */

/** One thing that went wrong at a specific place in the file. */
export interface CsvError {
  /** 1-based record number (a data-or-header row as the user would count it). */
  line: number;
  message: string;
}

export interface CsvParseResult {
  /** Every record as an array of raw field strings. `[]` for an empty file. */
  records: string[][];
  errors: CsvError[];
}

/**
 * Parse CSV text into a grid of records. Never throws.
 *
 * A field-count MISMATCH is not fatal here — it is returned as an error and the
 * short/long record is still included, because the import wizard shows the row
 * and its problem side by side and a thrown parse would hide every good row
 * behind one bad one (the skip-and-count rule, one layer down).
 */
export function parseCsv(text: string): CsvParseResult {
  const records: string[][] = [];
  const errors: CsvError[] = [];

  // Strip a leading BOM before anything else looks at the first character.
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let sawAny = false; // has the current record any content or field yet?
  let i = 0;
  const n = src.length;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    sawAny = false;
  };

  while (i < n) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          // An escaped quote: consume both, emit one.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      // A quote opens a quoted field ONLY at the field's start (field still
      // empty). A quote in the middle of an unquoted field (`a"b`) is ordinary
      // content — which is what a naive parser gets wrong the other way.
      if (field === "") {
        inQuotes = true;
        sawAny = true;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === ",") {
      endField();
      sawAny = true;
      i += 1;
      continue;
    }

    if (c === "\r" || c === "\n") {
      // Consume a CRLF pair as one break.
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      endRecord();
      i += 1;
      continue;
    }

    field += c;
    sawAny = true;
    i += 1;
  }

  // Flush the final field/record unless the file ended exactly on a line break
  // (in which case there is nothing pending and no phantom empty record).
  if (inQuotes) {
    // An unterminated quote runs to end of file: keep what we have, and say so.
    endField();
    records.push(record);
    errors.push({ line: records.length, message: "a quoted field was never closed" });
  } else if (field !== "" || record.length > 0 || sawAny) {
    endRecord();
  }

  return { records, errors };
}

/**
 * A convenience over `parseCsv` for the common shape: a header row plus data
 * rows, each data row zipped to the header names (TRIMMED, lower-cased for
 * matching) with a per-row field-count check.
 *
 * ⚠️ THE HEADER IS TRIMMED AND LOWER-CASED FOR MATCHING ONLY. The values are
 * returned verbatim — a column-mapper compares `"SKU"`, `"Sku"` and `" sku "`
 * as the same header, but a product name keeps its spaces and case.
 */
export interface CsvTable {
  /** Header names as written, in column order. */
  header: string[];
  /** Header names normalised for matching (trimmed, lower-cased), same order. */
  headerKeys: string[];
  /** Each data row as `{ headerKey: rawValue }`. Missing cells are `""`. */
  rows: Array<Record<string, string>>;
  errors: CsvError[];
}

export function parseCsvTable(text: string): CsvTable {
  const { records, errors } = parseCsv(text);
  if (records.length === 0) {
    return { header: [], headerKeys: [], rows: [], errors };
  }
  const header = records[0];
  const headerKeys = header.map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];
  const rowErrors: CsvError[] = [...errors];

  for (let r = 1; r < records.length; r += 1) {
    const cells = records[r];
    // A row that is entirely empty (one empty field, no content) is a blank line
    // a spreadsheet leaves behind; skip it rather than reporting a mismatch.
    if (cells.length === 1 && cells[0] === "") continue;
    if (cells.length !== header.length) {
      rowErrors.push({
        line: r + 1,
        message: `row has ${cells.length} value${cells.length === 1 ? "" : "s"} but the header has ${header.length} column${header.length === 1 ? "" : "s"}`,
      });
    }
    const row: Record<string, string> = {};
    for (let c = 0; c < headerKeys.length; c += 1) {
      row[headerKeys[c]] = cells[c] ?? "";
    }
    rows.push(row);
  }

  return { header, headerKeys, rows, errors: rowErrors };
}
