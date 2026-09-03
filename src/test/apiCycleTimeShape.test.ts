/**
 * The two halves of the cycle-times read, held against each other (R-315).
 *
 * A read has a column list (`CYCLE_TIME_COLUMNS`) and a guard that decides what
 * is acceptable back (`parseAdminCycleTime`). When those drift apart every row
 * is rejected, counted quietly as unreadable, and the screen renders empty —
 * which looks like "nothing is measured yet" rather than like an error, and
 * "nothing is measured yet" is a LEGITIMATE state for this screen. That makes
 * the failure even quieter here than it was for trainings, where the same drift
 * blanked the panel and `apiSkillShape.test.ts` was written in response.
 *
 * ⚠️ NOTHING ELSE CAN CATCH IT. `tsc` sees a string on one side and a
 * hand-written predicate on the other.
 */
import { expect, it, describe } from "vitest";
import { CYCLE_TIME_COLUMNS, parseAdminCycleTime } from "@/lib/api/cycleTimes";

/** `"a, b, c"` -> `["a","b","c"]`. */
function selectedColumns(): string[] {
  return CYCLE_TIME_COLUMNS.split(",").map((c) => c.trim());
}

/** A row built FROM THE COLUMN LIST, never typed out by hand. */
function rowFromColumns(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    node_id: "30000000-0000-0000-0000-000000000007",
    product_id: "60000000-0000-0000-0000-000000000001",
    seconds_per_unit: 90,
  };
  const row: Record<string, unknown> = {};
  for (const col of selectedColumns()) row[col] = sample[col];
  return { ...row, ...overrides };
}

describe("the read asks for exactly what the guard requires", () => {
  it("every column the guard needs is one the read actually selects", () => {
    // If a column is added to the guard and not to the list, the row built
    // from the list below is missing it and the parse returns null.
    expect(parseAdminCycleTime(rowFromColumns())).toEqual({
      nodeId: "30000000-0000-0000-0000-000000000007",
      productId: "60000000-0000-0000-0000-000000000001",
      secondsPerUnit: 90,
    });
  });

  it("the column list has no duplicates and no stray whitespace", () => {
    const cols = selectedColumns();
    expect(new Set(cols).size).toBe(cols.length);
    expect(cols.every((c) => c === c.trim() && c !== "")).toBe(true);
  });

  it("rejects a row whose seconds are a string, not a number", () => {
    // PostgREST returns `numeric` as a number here, but a driver change or a
    // hand-built fixture could hand over "90" — which would then be compared
    // and summed as text.
    expect(parseAdminCycleTime(rowFromColumns({ seconds_per_unit: "90" }))).toBeNull();
  });

  it("rejects a row with a missing or non-finite value", () => {
    expect(parseAdminCycleTime(rowFromColumns({ seconds_per_unit: null }))).toBeNull();
    expect(parseAdminCycleTime(rowFromColumns({ seconds_per_unit: Number.NaN }))).toBeNull();
    expect(parseAdminCycleTime(rowFromColumns({ node_id: null }))).toBeNull();
  });

  it("rejects anything that is not an object at all", () => {
    for (const v of [null, undefined, 3, "row", []]) {
      expect(parseAdminCycleTime(v)).toBeNull();
    }
  });
});
