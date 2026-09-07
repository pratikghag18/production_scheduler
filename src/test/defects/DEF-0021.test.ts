/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0021 — RENAMING OR DELETING A WEEK TEMPLATE BY ID ANSWERS DIFFERENTLY
 * FOR "DOES NOT EXIST" AND "EXISTS, IN ANOTHER COMPANY".
 *
 * `rename_week_template` and `delete_week_template` (migration 0067) are
 * SECURITY DEFINER, so their first `SELECT plant_id, org_id FROM
 * week_templates WHERE id = p_template_id` bypasses `week_templates_select`'s
 * RLS entirely and finds a row belonging to ANY org. A bogus id (`v_plant IS
 * NULL`) answers `invalid_argument / no_such_template`; a real id belonging
 * to another company reaches `app_is_admin_for(v_plant)`, which is org-scoped
 * and refuses -- but with a DIFFERENT answer, `not_permitted / not_admin`.
 * The two are distinguishable, so a caller who guesses or otherwise obtains a
 * template id can learn "this id belongs to a real template somewhere,
 * outside my org" -- verified live (see DEF-0021.md's Reproduction) by
 * inserting a fixture row for org 2 and calling both functions as an org-1
 * admin: a bogus uuid answers "no such template", the real other-org id
 * answers "only this plant's admins may rename/delete a template".
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS. The psql transcript in the defect
 * file is the behaviour; the pin asserts that the last definition's existence
 * lookup is itself org-scoped (the same shape `list_week_templates` already
 * uses, `wt.org_id = app_current_org()`), so a foreign-org id can no longer
 * be told apart from a bogus one before the fetch. A fix that adds that term
 * is green; the current text, which has none, is red.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

function migrationsInOrder(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS, file), "utf8") }));
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The LAST `create [or replace] function [public.]name(` through the end of its body. */
function lastFunctionText(name: string): { file: string; text: string } | null {
  let found: { file: string; text: string } | null = null;
  const re = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${name}\s*\(`,
    "gi",
  );
  for (const { file, sql } of migrationsInOrder()) {
    const text = withoutComments(sql);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const rest = text.slice(m.index);
      const open = rest.search(/\$[A-Za-z_]*\$/);
      if (open === -1) {
        found = { file, text: rest.slice(0, 800) };
        continue;
      }
      const tag = rest.slice(open).match(/^\$[A-Za-z_]*\$/)![0];
      const close = rest.indexOf(tag, open + tag.length);
      found = { file, text: rest.slice(0, close === -1 ? rest.length : close + tag.length) };
    }
  }
  return found;
}

/** The lookup, up to (and including) the "IS NULL -> no_such_template" check,
 *  where an org filter would have to sit to change the answer for a foreign id. */
function lookupClause(text: string): string {
  const idx = text.search(/no_such_template/i);
  return idx === -1 ? text : text.slice(0, idx);
}

const ORG_SCOPED_LOOKUP = /org_id\s*=\s*app_current_org\s*\(\s*\)/i;

describe("DEF-0021: rename/delete week template distinguish a bogus id from another company's real one", () => {
  it("rename_week_template's existence lookup is org-scoped", () => {
    const def = lastFunctionText("rename_week_template");
    expect(def, "no migration defines rename_week_template").not.toBeNull();
    const lookup = lookupClause(def!.text);
    expect(
      ORG_SCOPED_LOOKUP.test(lookup),
      `rename_week_template (last defined in ${def!.file}) reads plant_id/org_id from week_templates with no org_id = app_current_org() term before deciding "no such template" versus "not permitted" -- a template id belonging to another company answers not_permitted/not_admin instead of the bogus-id invalid_argument/no_such_template, which is a cross-tenant existence leak (DEF-0021, R-356)`,
    ).toBe(true);
  });

  it("delete_week_template's existence lookup is org-scoped", () => {
    const def = lastFunctionText("delete_week_template");
    expect(def, "no migration defines delete_week_template").not.toBeNull();
    const lookup = lookupClause(def!.text);
    expect(
      ORG_SCOPED_LOOKUP.test(lookup),
      `delete_week_template (last defined in ${def!.file}) has the same unscoped lookup (DEF-0021, R-356)`,
    ).toBe(true);
  });

  /** The guard on the guard: list_week_templates already gets this right
   *  (`wt.org_id = app_current_org()` in its own query), so the reader is not
   *  blind to the pattern this pin looks for. */
  it("...and the reader can see the org-scoped shape list_week_templates already uses", () => {
    const def = lastFunctionText("list_week_templates");
    expect(def).not.toBeNull();
    expect(ORG_SCOPED_LOOKUP.test(def!.text)).toBe(true);
  });
});
