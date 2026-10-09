/**
 * DEF-0053: the server's capacity rule (R-033, "full double-booking is still
 * refused") is computed from the CALLER'S view of `assignments`.
 * `operator_peak_load` is SECURITY INVOKER and the `assignments_select` policy
 * shows a caller only the places she can read, so a Line 1 supervisor asking
 * about a person who is working on Line 2 is told the person is free -- by
 * `capacity_probe`, and by the `assignments_capacity` trigger that guards the
 * write itself. Proved live on 30 Sept: Ana put Priya Shah on Cell 1 from 10 am
 * to noon while Priya was on Cell 4 from 6 am to 2 pm, and the database held
 * her at 2.000 against a cap of 1.0.
 *
 * THE LIVE PROOF is `DEF-0053.live.mjs` beside this file (it signs in as Ana
 * and as the plant admin and asks the server the same question twice); the
 * defect's Reproduction runs it. THIS file is the static half, so the suite
 * carries something red without a stack: the last definition of the function
 * that does the sum is read from the migrations (CLAUDE.md section 4, "take
 * the LAST hit") and must run as the server, not as the caller.
 *
 * If the fix takes another shape (a definer wrapper the trigger and the probe
 * call instead, say), this case is the wrong question and should be rewritten
 * by the tester; the live script is the judge either way.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

const MIGRATIONS = "supabase/migrations";

/** The text of the LAST `create [or replace] function [public.]<name>(` in the
 *  migrations, from its opening line to the end of its dollar-quoted body. */
function lastDefinition(name: string): { file: string; text: string } | null {
  const opener = new RegExp(
    `create\\s+(or\\s+replace\\s+)?function\\s+(public\\.)?${name}\\s*\\(`,
    "gi",
  );
  let found: { file: string; text: string } | null = null;
  for (const file of fs.readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = fs.readFileSync(`${MIGRATIONS}/${file}`, "utf-8");
    for (const m of sql.matchAll(opener)) {
      const rest = sql.slice(m.index);
      const tag = rest.match(/\$[A-Za-z_]*\$/);
      if (!tag || tag.index === undefined) continue;
      const close = rest.indexOf(tag[0], tag.index + tag[0].length);
      if (close === -1) continue;
      found = { file, text: rest.slice(0, close + tag[0].length + 200) };
    }
  }
  return found;
}

describe("DEF-0053: the capacity sum is the server's, not the caller's view", () => {
  it("operator_peak_load, as last defined, runs as a definer (it sums a person's blocks wherever they are)", () => {
    const def = lastDefinition("operator_peak_load");
    expect(def, "operator_peak_load should be defined in the migrations").not.toBeNull();
    if (!def) return;
    // The control: this really is the function that sums assignments.
    expect(def.text).toMatch(/from\s+assignments/i);
    expect(
      /security\s+definer/i.test(def.text),
      `${def.file} defines operator_peak_load without SECURITY DEFINER, so its sum over assignments is filtered by the caller's read policy: a supervisor's capacity check cannot see a block on a line outside her grant`,
    ).toBe(true);
  });
});
