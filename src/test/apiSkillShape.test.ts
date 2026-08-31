/**
 * The two halves of the trainings read, held against each other.
 *
 * ---------------------------------------------------------------------------
 * ⚠️⚠️ THIS FILE EXISTS BECAUSE THE TWO HALVES DRIFTED AND NOTHING NOTICED.
 *
 * A read has a column list (`SKILL_COLUMNS`) and a guard that decides what is
 * acceptable back (`parseSkillRecord`). Stage 22 added `active` to both — and
 * to a SECOND, inline copy of the column list three hundred lines further up
 * in the same file, which nobody updated. That read kept asking for three
 * columns; the guard began requiring four; **every training row was rejected,
 * counted quietly into `skipped`, and the Trainings screen rendered empty.**
 *
 * ⭐ It is §19.76's rule with the arrow reversed, and worth naming as its own
 * shape: there, a migration made a COLUMN nullable and broke a hand-written
 * guard. Here, a change made the GUARD stricter and broke a hand-written column
 * list. **Either half can move; the failure is always silent, and always looks
 * like "there is no data" rather than like an error.**
 *
 * ⚠️ NOTHING ELSE CAN CATCH IT. `tsc` sees a string on one side and a
 * hand-written predicate on the other. The panel suites mock the query layer,
 * so they hand the parser rows they invented rather than rows the read asked
 * for — which is exactly how every one of them stayed green while the screen
 * was blank.
 */
import { expect, it } from "vitest";
import { parseSkillRecord, SKILL_COLUMNS } from "@/lib/api/operators";

/** `"id, name, site_node_id, active"` -> `["id","name","site_node_id","active"]`. */
function selectedColumns(): string[] {
  return SKILL_COLUMNS.split(",").map((c) => c.trim());
}

/**
 * A row shaped the way PostgREST returns one for exactly these columns.
 *
 * ⭐ BUILT FROM `SKILL_COLUMNS` ITSELF, never from a hand-written literal. A
 * literal is a third copy of the same list and would drift the same way the
 * second one did — the whole point is that this fixture cannot disagree with
 * the read, because it IS the read.
 */
function rowFromSelect(over: Record<string, unknown> = {}): Record<string, unknown> {
  const sample: Record<string, unknown> = {
    id: "3f2a0000-0000-0000-0000-000000000001",
    name: "Forklift",
    site_node_id: "2b1a0000-0000-0000-0000-000000000001",
    active: true,
  };
  const row: Record<string, unknown> = {};
  for (const col of selectedColumns()) row[col] = sample[col];
  return { ...row, ...over };
}

it("K1 ⭐⭐: the guard accepts a row built from the columns the read actually asks for", () => {
  // The case that was red for the length of stage 22 and told nobody.
  const parsed = parseSkillRecord(rowFromSelect());
  expect(parsed).not.toBeNull();
  expect(parsed?.name).toBe("Forklift");
  expect(parsed?.active).toBe(true);
});

it("K2: every field the parser puts on its result was asked for in the select", () => {
  // ⚠️ THE OTHER DIRECTION, and it is not the same case. K1 fails when the
  // SELECT loses a column the guard needs. This one fails when the guard starts
  // returning a field nothing asked for — which parses fine and arrives
  // `undefined`, so the screen renders a blank where a value should be rather
  // than failing.
  const parsed = parseSkillRecord(rowFromSelect());
  const cols = new Set(selectedColumns());
  const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  for (const key of Object.keys(parsed ?? {})) {
    expect(cols.has(camelToSnake(key))).toBe(true);
  }
});

it("K3: a row missing `active` is REJECTED, not defaulted to true", () => {
  // ⭐ The strictness is deliberate and this pins it. `active` is NOT NULL with
  // a default in the database, so absent here can only mean the select forgot
  // to ask — and a silent `true` would render every retired training as live,
  // on the one screen whose job is telling them apart.
  const { active: _dropped, ...withoutActive } = rowFromSelect();
  expect(parseSkillRecord(withoutActive)).toBeNull();
});

it("K4: and a non-boolean `active` is rejected too", () => {
  // PostgREST returns a real JSON boolean. A string "true" means something
  // upstream changed shape, and guessing at it is how a screen starts lying.
  expect(parseSkillRecord(rowFromSelect({ active: "true" }))).toBeNull();
  expect(parseSkillRecord(rowFromSelect({ active: null }))).toBeNull();
});

it("K5: a retired training parses, and keeps its retirement", () => {
  expect(parseSkillRecord(rowFromSelect({ active: false }))?.active).toBe(false);
});

it("K6: the other required fields are still required", () => {
  for (const col of ["id", "name", "site_node_id"]) {
    expect(parseSkillRecord(rowFromSelect({ [col]: null }))).toBeNull();
  }
});
