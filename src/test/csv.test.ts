/**
 * Acceptance suite for `src/features/admin/lib/csv.ts` — the hand-rolled RFC 4180
 * parser every import entity shares (the module header explains why it is not a
 * library).
 *
 * A VITEST suite, because `npm run test` collects every `src/test/*.test.ts` and
 * this is what guards the parser permanently. One plain `it()` per RULE, never
 * `it.each`: a table-driven failure names the table, not the rule that broke, and
 * this file exists to name the rule — the rules are the ones enumerated in the
 * module's own header comment.
 *
 * ⭐ WHAT IS UNDER TEST IS THE PURE PARSER. It turns bytes into a grid and knows
 * nothing about products; `productImport.ts` is the half that reads the header.
 */
import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvTable, toCsv } from "../features/admin/lib/csv.ts";

/* ===========================================================================
 * Group F — fields. Comma-split, quoting, and the doubled-quote escape.
 *
 * ⭐ THE WHOLE REASON THIS IS NOT `text.split(",")`: a real export quotes any
 * field with a comma, a newline or a quote in it, and those are exactly the rows
 * a human cannot eyeball.
 * ======================================================================== */

describe("fields", () => {
  it("F1: splits a plain record on commas", () => {
    expect(parseCsv("a,b,c").records).toEqual([["a", "b", "c"]]);
  });

  // F2 — the case a naive split corrupts: the comma is inside the quotes and is
  // content, so this is ONE field, not two.
  it("F2: a comma inside a quoted field is content, not a separator", () => {
    expect(parseCsv('"a,b",c').records).toEqual([["a,b", "c"]]);
  });

  // F3 — a spreadsheet writes an interior `"` as `""`; it must collapse to one.
  it("F3: a doubled quote inside a quoted field becomes one literal quote", () => {
    expect(parseCsv('"a""b"').records).toEqual([['a"b']]);
  });

  // F4a/F4b/F4c — a quoted field may hold a line break of any flavour as content;
  // the record does NOT end until the closing quote.
  it("F4a: an LF inside a quoted field is kept as content", () => {
    expect(parseCsv('"a\nb"').records).toEqual([["a\nb"]]);
  });

  it("F4b: a CR inside a quoted field is kept as content", () => {
    expect(parseCsv('"a\rb"').records).toEqual([["a\rb"]]);
  });

  it("F4c: a CRLF inside a quoted field is kept verbatim, both characters", () => {
    expect(parseCsv('"a\r\nb"').records).toEqual([["a\r\nb"]]);
  });

  // F5 — trimming is the caller's decision (a field of all spaces and an empty
  // field can mean different things), so the parser returns every value verbatim.
  it("F5: whitespace inside and around a value is preserved", () => {
    expect(parseCsv(" a , b ").records).toEqual([[" a ", " b "]]);
  });

  // F6 — the other direction a naive parser gets wrong: a `"` in the MIDDLE of an
  // unquoted field is ordinary content, not the start of a quoted field.
  it("F6: a quote in the middle of an unquoted field is literal content", () => {
    expect(parseCsv('a"b').records).toEqual([['a"b']]);
  });
});

/* ===========================================================================
 * Group R — records. LF, CRLF and a bare CR all end a record.
 *
 * ⭐ RFC 4180 says CRLF; Unix tools say LF; a stray CR is tolerated too. The trap
 * is counting a CRLF as two breaks and emitting a phantom empty record between.
 * ======================================================================== */

describe("record separators", () => {
  it("R1: an LF ends a record", () => {
    expect(parseCsv("a\nb").records).toEqual([["a"], ["b"]]);
  });

  it("R2: a bare CR ends a record", () => {
    expect(parseCsv("a\rb").records).toEqual([["a"], ["b"]]);
  });

  // R3 — the phantom-record trap: a CRLF is consumed as a SINGLE break, so this
  // is two records, not three.
  it("R3: a CRLF pair is one break, not two", () => {
    const result = parseCsv("x\r\ny");
    expect(result.records).toEqual([["x"], ["y"]]);
    expect(result.records.length).toBe(2);
  });

  // R4 — a file that ends on a line break has nothing pending; there is no empty
  // final record to invent.
  it("R4: a trailing newline does not add a phantom empty final record", () => {
    expect(parseCsv("a\n").records).toEqual([["a"]]);
  });

  it("R5: a trailing newline after a multi-field record adds no phantom record", () => {
    expect(parseCsv("a,b\n").records).toEqual([["a", "b"]]);
  });

  it("R6: an empty string is an empty file — no records", () => {
    expect(parseCsv("").records).toEqual([]);
  });
});

/* ===========================================================================
 * Group B — the BOM. Excel's "CSV UTF-8" writes a U+FEFF that has to die HERE.
 *
 * ⭐ Without stripping it the first header cell is U+FEFF followed by `sku`, and
 * NO column maps — the failure is downstream of the parser and looks like a
 * mapping bug.
 * ======================================================================== */

describe("byte-order mark", () => {
  // B1 — the header key must come out clean so `detectColumns` can match it.
  it("B1: a leading BOM is stripped so the first header key is clean", () => {
    expect(parseCsvTable("﻿SKU,Name\nx,y").headerKeys[0]).toBe("sku");
  });

  it("B2: only the BOM is removed — the header text is otherwise untouched", () => {
    expect(parseCsvTable("﻿SKU,Name\nx,y").header[0]).toBe("SKU");
  });
});

/* ===========================================================================
 * Group Q — the tolerant failure. A bad quote is reported, never thrown.
 *
 * ⭐ A thrown parse would hide every good row behind one bad one; the wizard
 * shows the row and its problem side by side, so the parser keeps what it has.
 * ======================================================================== */

describe("an unterminated quote", () => {
  const BROKEN = 'a,b\n"c,d';

  it("Q1: is reported as an error rather than thrown", () => {
    expect(parseCsv(BROKEN).errors.length).toBe(1);
  });

  it("Q2: is reported against the last record it opened", () => {
    expect(parseCsv(BROKEN).errors[0].line).toBe(2);
  });

  // Q3 — the partial field is KEPT (comma and all, since it was inside quotes),
  // not discarded, so the human can see what they nearly imported.
  it("Q3: keeps the partial content it had read so far", () => {
    expect(parseCsv(BROKEN).records[1]).toEqual(["c,d"]);
  });
});

/* ===========================================================================
 * Group T — parseCsvTable. Header-to-row zipping, with matching normalisation.
 *
 * ⭐ THE HEADER IS TRIMMED AND LOWER-CASED FOR MATCHING ONLY. The values keep
 * their case and spaces — a column-mapper wants `" SKU "` to equal `"sku"`, but a
 * product name keeps every space it was given.
 * ======================================================================== */

describe("parseCsvTable", () => {
  const TABLE = parseCsvTable("  SKU ,Name\n  Wx1 ,Widget");

  it("T1: normalises header keys — trimmed and lower-cased — for matching", () => {
    expect(TABLE.headerKeys).toEqual(["sku", "name"]);
  });

  it("T2: leaves the header text itself verbatim, case and spaces intact", () => {
    expect(TABLE.header).toEqual(["  SKU ", "Name"]);
  });

  it("T3: keys each row value by the normalised header key", () => {
    expect(TABLE.rows[0].sku).toBe("  Wx1 ");
  });

  it("T4: leaves the row VALUES verbatim, so a name keeps its case and spaces", () => {
    expect(TABLE.rows[0]).toEqual({ sku: "  Wx1 ", name: "Widget" });
  });

  // T5/T6 — a wrong field count is not fatal: the row is reported AND still
  // included, because the wizard shows the offending row beside its problem.
  const RAGGED = parseCsvTable("SKU,Name\nx,y,z");

  it("T5: reports a row whose field count does not match the header", () => {
    expect(RAGGED.errors.length).toBe(1);
    expect(RAGGED.errors[0].line).toBe(2);
    expect(RAGGED.errors[0].message).toContain("column");
  });

  it("T6: still includes the mismatched row rather than dropping it", () => {
    expect(RAGGED.rows).toEqual([{ sku: "x", name: "y" }]);
  });

  // T7 — a fully blank line is the empty row a spreadsheet leaves behind; it is
  // skipped, NOT reported as a mismatch.
  it("T7: skips a fully blank line without reporting it as an error", () => {
    const table = parseCsvTable("SKU,Name\n\nx,y");
    expect(table.rows).toEqual([{ sku: "x", name: "y" }]);
    expect(table.errors).toEqual([]);
  });

  it("T8: an empty file yields no header, no rows and no errors", () => {
    expect(parseCsvTable("")).toEqual({ header: [], headerKeys: [], rows: [], errors: [] });
  });

  // T9 — a parse-level error (the unterminated quote) is carried onto the table's
  // errors, so a caller reading only the table still sees it.
  it("T9: carries a parse-level error through onto the table errors", () => {
    const table = parseCsvTable('SKU,Name\n"broken,row');
    expect(table.errors.some((e) => e.message.includes("never closed"))).toBe(true);
  });
});

describe("toCsv — the model-template writer, and it round-trips parseCsv", () => {
  it("W1: quotes ONLY fields that need it, and doubles an interior quote", () => {
    // A plain field is left bare; a comma, a quote or a newline forces quotes.
    const out = toCsv([
      ["sku", "name"],
      ["WX", "Widget, X"],
      ["WY", 'He said "hi"'],
    ]);
    expect(out).toBe('sku,name\r\nWX,"Widget, X"\r\nWY,"He said ""hi"""');
  });

  it("W2: what toCsv writes, parseCsv reads back identically", () => {
    // The whole point: a template the user downloads and re-uploads must survive.
    const records = [
      ["sku", "name", "external_id", "plant"],
      ["WX-100", "Widget, X", "EXT-100", "Plant A"],
      ["WY", 'Odd "quoted" name', "", ""],
    ];
    expect(parseCsv(toCsv(records)).records).toEqual(records);
  });
});
