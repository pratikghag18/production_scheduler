import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEF-0035 — REOPENED by the tester (21 Sept, session 183t), and the contract of the
 * fix changed with it, so this pin is REWRITTEN rather than patched (CLAUDE.md
 * section 4: say in writing whether the case was wrong or the contract changed).
 *
 * What the tester measured: as Ana (a Line 1 supervisor) on a fresh seed, the form
 * offered all six of Plant A's people while `set_absence` accepted two. The first fix
 * filtered the list with `canEditNode` over the person's home node; the four off-line
 * people's owning cells are nodes Ana cannot read, so the client held no path for them
 * and the preview failed open, by its own rule. The tester's pin ran that filter over
 * the measured data and was red.
 *
 * What changed: the client no longer guesses. Migration 0084's
 * `absence_recordable_people()` (SECURITY DEFINER) runs the same expression
 * `set_absence` gates on and returns the ids the writer accepts; the form offers the
 * visible people intersected with that answer. So the property the tester's pin asked
 * for — "the form offers exactly the people the server accepts" — is now held in two
 * places, and this pin asserts both halves exist and are wired:
 *
 *   1. the SERVER half: `88_absences_test.sql` AB35 holds the function to
 *      `set_absence` person by person, for a supervisor, another supervisor, a viewer
 *      and the company admin, and for a caller with no profile;
 *   2. the CLIENT half: `AbsencesPanel.tsx` builds its Person list from
 *      `fetchRecordableAbsencePeople` and no longer applies `canEdit` to it;
 *      `DEF-0035.test.tsx` renders the tester's six-people scenario against the server's
 *      answer and asserts the two are offered and the four are not.
 *
 * A reintroduced client preview (a `canEdit(` on the Person list) or a dropped server
 * read turns this red again.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("DEF-0035 (reopened): the Absences form offers a supervisor only people set_absence accepts", () => {
  it("the migration defines the definer function on the same gate set_absence runs", () => {
    const sql = read("supabase/migrations/20260921000084_absence_recordable_people.sql");
    expect(sql).toMatch(
      /create or replace function absence_recordable_people\(\) returns setof uuid/,
    );
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/app_can_edit_node\(coalesce\(o\.home_node_id, o\.site_node_id\)\)/);
    expect(sql).toMatch(/o\.org_id = app_current_org\(\)/);
  });

  it("the SQL suite holds the function to set_absence person by person (AB35)", () => {
    const sql = read("supabase/tests/88_absences_test.sql");
    expect(sql).toContain("PASS AB35");
    expect(sql).toContain("absence_recordable_people()");
    // parity: membership in the set equals whether set_absence accepts
    expect(sql).toMatch(/IF v_in <> v_accepts THEN/);
  });

  it("the panel's Person list is the server's answer, not a client preview", () => {
    const panel = read("src/features/admin/components/AbsencesPanel.tsx").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      "",
    );
    expect(panel).toContain("fetchRecordableAbsencePeople");
    expect(panel).toMatch(/recordableIds\.has\(p\.id\)/);
    expect(panel).not.toMatch(/canEdit\(/);
    expect(panel).not.toMatch(/useEditRights/);
  });

  it("the api read exists and refuses a malformed answer rather than reading it as nobody", () => {
    const api = read("src/lib/api/absences.ts");
    expect(api).toMatch(/supabase\.rpc\("absence_recordable_people"\)/);
    expect(api).toMatch(/shapeMismatch\("absence_recordable_people"/);
  });
});
