/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0011 — MIGRATION 0053 RE-EMITTED `set_site_member` FROM 0021 AND LOST
 * 0022's RULE ON THE WAY.
 *
 * `set_site_member` has been written out whole three times. Each re-emission is
 * a copy of the previous one plus a block, and CLAUDE.md says so in one line:
 * *"Extract, never retype. `grep -n "function <name>" supabase/migrations/*.sql`
 * and take the LAST hit."* 0053's own header says it did that — *"Extracted
 * from 0021 §4 and re-emitted whole with one block added"* — and 0021 is not
 * the last hit. 0022 is.
 *
 * What 0022 added, and what is now gone from the live function:
 *
 *   IF app_profile_is_company_admin(p_profile_id) AND NOT app_is_admin() THEN
 *     PERFORM api_raise('not_permitted', 'company admins are not managed from a site',
 *                       jsonb_build_object('profile_id', p_profile_id,
 *                                          'reason', 'company_admin'));
 *
 * ⛔ THIS IS NOT A STYLE CHECK, AND IT IS NOT A GUESS. The project's own SQL
 * suite already says so. `49_company_admin_rows_test.sql` X42 — *"...nor change
 * the role they hold"* — is red on this build, and it was red in the commit that
 * shipped 0053:
 *
 *   psql:<stdin>:122: NOTICE:  FAIL X42: detail=<NULL> role_now=viewer
 *   ---- 49_company_admin_rows_test.sql : 8 passed, 1 failed, 0 hard-errors ----
 *
 * Measured over a real session as Dana, a site admin whose org-wide role is
 * `viewer` and who administers Plant A: `set_site_member(Plant A, <the company
 * admin>, 'viewer')` returns `{"role": "viewer", ...}` and the row is there when
 * it is read back. 0022's header calls that a role inversion — the person with
 * less authority editing the record of the person with more.
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS RATHER THAN THE DATABASE. vitest has no
 * database here, and the SQL suite that DOES have one is not on the developer's
 * committed path (X42 shipped red). A pin that reads the last definition off
 * disk is the one that runs on every `npm run test`, which is the run that was
 * green while this shipped.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

/**
 * Every definition of a function across the migrations, oldest first, as the
 * text from `function <name>(` to the end of its body. Append-only migrations
 * mean file order is definition order, and the LAST entry is what the database
 * has.
 *
 * ⚠️ `comment on function <name>(...)` MATCHES THE SAME WORDS and every one of
 * these migrations ends with one. Left in, the last "definition" would be a
 * comment with no guards in it, and the first case below would go red for the
 * wrong reason — which it did, on the first run of this file.
 */
function definitionsOf(name: string): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const re = new RegExp(
      String.raw`(?:create or replace\s+)?function\s+(?:public\.)?${name}\s*\(`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const start = m.index;
      if (/comment\s+on\s+$/i.test(sql.slice(Math.max(0, start - 20), start))) continue;
      const end = sql.indexOf("END $", start);
      out.push({ file, body: sql.slice(start, end === -1 ? sql.length : end) });
    }
  }
  return out;
}

/** Every `'reason', '<word>'` a definition raises — its guards, by name. */
function reasonsIn(body: string): string[] {
  return [...new Set([...body.matchAll(/'reason',\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

describe("DEF-0011: a function re-emitted by a later migration keeps the guards an earlier one added", () => {
  /**
   * ⛔ THE DEFECT. The last definition wins, and the last definition of
   * `set_site_member` no longer refuses a site admin editing a company admin's
   * row.
   */
  it("the last definition of set_site_member still refuses a company admin's row", () => {
    const defs = definitionsOf("set_site_member");
    const last = defs[defs.length - 1];
    expect(
      reasonsIn(last.body),
      `the last definition of set_site_member is in ${last.file} and raises ${JSON.stringify(
        reasonsIn(last.body),
      )}`,
    ).toContain("company_admin");
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD, FIRST HALF. The case above would pass trivially
   * if the rule had never existed, or if this file's extraction found nothing
   * at all. An EARLIER definition must have raised it, or there is nothing to
   * have lost.
   */
  it("an earlier definition did raise it, so this is a loss and not an absence", () => {
    const defs = definitionsOf("set_site_member");
    expect(defs.length).toBeGreaterThan(1);
    const earlier = defs.slice(0, -1).filter((d) => reasonsIn(d.body).includes("company_admin"));
    expect(
      earlier.map((d) => d.file),
      "no earlier definition raised company_admin — check the extraction before the code",
    ).not.toEqual([]);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD, SECOND HALF, AND IT IS THE ONE THAT MATTERS.
   * `remove_site_member` is the other half of the same pair and 0053 did not
   * touch it, so its copy of the rule is still there. If THIS case ever goes
   * red at the same time as the first, the extraction is broken and the first
   * case is telling you nothing. It is the difference between "the guard is
   * gone" and "this file cannot see a guard".
   */
  it("remove_site_member's copy of the same rule is still found, so the reader works", () => {
    const defs = definitionsOf("remove_site_member");
    const last = defs[defs.length - 1];
    expect(reasonsIn(last.body)).toContain("company_admin");
  });
});
