/**
 * Pin for DEF-0006 — `supabase/dev_demo.sql` still writes `runs.status`, which
 * migration 0044 dropped, so the demo world stops building.
 *
 * R-D112: "`dev_demo.sql` clears org 1's seeded content and builds three
 * identically shaped plants ... no run using a product owned outside it."
 *
 * WHY A TEXT AUDIT AND NOT A SQL TEST. `supabase/tests/*` runs against a scratch
 * database built from the harness, every migration and `seed.sql` —
 * `dev_demo.sql` is not on that path and no runner touches it, which is exactly
 * why a schema change could land without anything going red. This is the same
 * shape as `scaleAudit` and `dateSeam`: a committed file is read as text and
 * held against a rule `tsc` cannot see.
 *
 * ⚠️ THE ASSERTION IS NARROW ON PURPOSE. The general rule — every column a
 * fixture names still exists — needs the schema, and the schema lives in the
 * database. This pins the two columns migrations 0043 and 0044 actually dropped,
 * which is what the defect is about. A broader audit is the developer's to build
 * if they want one, and belongs beside the migrations rather than here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// `process.cwd()` is the project root under vitest, the same anchor
// `dateSeam.test.ts` uses for its own audit of committed files.
const DEV_DEMO = `${process.cwd()}/supabase/dev_demo.sql`;

/**
 * Every `INSERT INTO <table> (…)` column list in `sql`, as written.
 *
 * A literal regex rather than one built from a string: the table name is
 * captured and compared afterwards, so there is no escaping to get wrong.
 */
function insertColumnLists(sql: string): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  for (const m of sql.matchAll(/insert\s+into\s+(\w+)\s*\(([^)]*)\)/gis)) {
    out.push({
      table: m[1].toLowerCase(),
      columns: m[2].split(",").map((c) => c.trim().toLowerCase()),
    });
  }
  return out;
}

/** Columns dropped by 0043 (`assignments.status`) and 0044 (`runs.status`). */
const DROPPED = ["runs", "assignments"] as const;

describe("DEF-0006: the demo world does not name a column the migrations dropped", () => {
  const sql = readFileSync(DEV_DEMO, "utf8");
  const inserts = insertColumnLists(sql);

  it("reads dev_demo.sql and finds the inserts it is about", () => {
    // A guard on the fixture itself: if the file stops inserting runs at all,
    // the cases below would pass by finding nothing, which is not the same as
    // passing. That is the "every row is the same kind" trap in reverse.
    expect(inserts.filter((i) => i.table === "runs").length).toBeGreaterThan(0);
    expect(inserts.filter((i) => i.table === "assignments").length).toBeGreaterThan(0);
  });

  for (const table of DROPPED) {
    it(`does not write ${table}.status`, () => {
      const offenders = inserts
        .filter((i) => i.table === table && i.columns.includes("status"))
        .map((i) => `INSERT INTO ${i.table} (${i.columns.join(", ")})`);
      expect(offenders).toEqual([]);
    });
  }
});
