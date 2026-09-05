/**
 * The two halves of the shift-pattern read, held against each other.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ THIS IS `apiSkillShape.test.ts`'S RULE, APPLIED BEFORE IT COSTS ANYTHING
 * RATHER THAN AFTER.
 *
 * That file exists because the trainings read drifted from its own guard and
 * nobody noticed: the column list gained `active` in one place, a second inline
 * copy of the same list three hundred lines away did not, the guard began
 * requiring four columns while the read went on asking for three, and **every
 * training row was rejected into `skipped` and the screen rendered empty.** Not
 * an error — an empty list, which reads as "there is no data".
 *
 * S21 has just put `shift_templates` in exactly that position. `active` is now
 * required by `parseShiftTemplateRow`, and `SHIFT_TEMPLATE_COLUMNS` is read by
 * `fetchShiftPatterns` AND by three separate writes that select the row back.
 * The column list was a literal in four places before S21 collapsed it into the
 * constant; this pins the constant to the guard so the next column cannot be
 * added to one and not the other.
 *
 * ⚠️ NOTHING ELSE CAN CATCH IT. `tsc` sees a string on one side and a
 * hand-written predicate on the other, and it has no opinion about whether they
 * describe the same row. `shiftsPanel.test.tsx` mocks the query layer, so it
 * hands the parser rows a test author invented rather than rows the read
 * actually asked for — which is precisely how the trainings suite stayed green
 * while the trainings screen was blank.
 */
import { expect, it } from "vitest";
import { parseShiftTemplateRow, SHIFT_TEMPLATE_COLUMNS } from "@/lib/api/shifts";

/** `"id, name, site_node_id, active"` -> `["id","name","site_node_id","active"]`. */
function selectedColumns(): string[] {
  return SHIFT_TEMPLATE_COLUMNS.split(",").map((c) => c.trim());
}

/**
 * A row shaped the way PostgREST returns one for exactly these columns.
 *
 * ⭐ BUILT FROM `SHIFT_TEMPLATE_COLUMNS` ITSELF, never from a hand-written
 * literal. A literal would be a third copy of the same list and would drift the
 * same way the second one did; the point is that this fixture CANNOT disagree
 * with the read, because it is derived from it.
 */
function rowFromSelect(over: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    id: "7c3a0000-0000-0000-0000-000000000001",
    name: "Plant 1 nights",
    site_node_id: "2b1a0000-0000-0000-0000-000000000001",
    active: true,
  };
  const row: Record<string, unknown> = {};
  for (const col of selectedColumns()) row[col] = sample[col];
  return { ...row, ...over };
}

it("P1 ⭐⭐: the guard accepts a row built from the columns the read actually asks for", () => {
  // The case that was red for the length of stage 22 on the trainings side and
  // told nobody. If a column is ever added to the guard and not to the constant,
  // this is the assertion that goes red.
  const parsed = parseShiftTemplateRow(rowFromSelect());
  expect(parsed).not.toBeNull();
  expect(parsed?.name).toBe("Plant 1 nights");
  expect(parsed?.active).toBe(true);
});

it("P2: every column the guard needs is one the read asks for", () => {
  // The other direction, and the one a passing P1 can hide: P1 would still pass
  // if the constant asked for columns the guard ignores. This names the four the
  // guard actually consumes and asserts the read requests each of them.
  const asked = selectedColumns();
  for (const needed of ["id", "name", "site_node_id", "active"]) {
    expect(asked).toContain(needed);
  }
});

it("P3 ⭐: `active` is REQUIRED, not defaulted — a row without it is rejected", () => {
  // ⚠️ THE FAIL-OPEN THIS FORBIDS IS THE TEMPTING ONE. `active: row.active ?? true`
  // looks harmless and is a positive claim — "this pattern is in use" — about a
  // row whose flag this client could not read. The column is `not null default
  // true`, so its absence means the database is not the one this client was
  // built against, and the honest answer is to reject the row and let it be
  // counted into `skipped` where somebody sees it.
  const row = rowFromSelect();
  delete row.active;
  expect(parseShiftTemplateRow(row)).toBeNull();

  // and a non-boolean is not coerced either — "false" is a truthy string.
  expect(parseShiftTemplateRow(rowFromSelect({ active: "false" }))).toBeNull();
  expect(parseShiftTemplateRow(rowFromSelect({ active: 0 }))).toBeNull();
});

it("P4: a retired row parses, and says it is retired", () => {
  // The whole point of S21 is that `false` is an ordinary value rather than an
  // error. A guard that rejected it would empty the Retired list instead.
  const parsed = parseShiftTemplateRow(rowFromSelect({ active: false }));
  expect(parsed).not.toBeNull();
  expect(parsed?.active).toBe(false);
});
