/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0018 — THE SETTINGS RESOLVER HAS NO COMPANY BOUNDARY.
 *
 * `app_resolve_node_setting(node, key)` (0050) is SECURITY DEFINER, granted to
 * `authenticated`, and names the caller's company nowhere: as Ana (org 1, a
 * supervisor of one line) it answers the OTHER company's `date_format` and
 * `eligibility_policy` by uuid, while `app_node_exists_in_org` says false for
 * the same uuid. R-341 says a definer helper answers about another company's
 * node exactly what it answers about a uuid that does not exist. 0062 made this
 * helper the authority for every board's date format.
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS. vitest has no database; the psql
 * transcript in the defect file is the behaviour. The pin asserts the one
 * property the lead names — the last definition carries an `app_current_org()`
 * term — the way DEF-0013's pin did for `app_node_is_plant_root`.
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

const ORG_TERM = /app_current_org\s*\(\s*\)/i;

describe("DEF-0018: the settings resolver answers only about the caller's own company", () => {
  /**
   * ⛔ THE DEFECT. Red on 0050: the body reads nodes, node_settings and orgs by
   * the node's own org and never asks whose session is calling.
   */
  it("the last definition of app_resolve_node_setting carries an app_current_org() term", () => {
    const def = lastFunctionText("app_resolve_node_setting");
    expect(def, "no migration defines app_resolve_node_setting").not.toBeNull();
    expect(
      ORG_TERM.test(def!.text),
      `app_resolve_node_setting (last defined in ${def!.file}) names the caller's company nowhere: as a supervisor of one line in org 1 it answers the other company's date_format and eligibility_policy by uuid, while app_node_exists_in_org says false for the same uuid (DEF-0018, R-341)`,
    ).toBe(true);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. `app_node_exists_in_org` (0020) carries exactly
   * this term; if this case is red at the same time as the one above, the
   * reader is broken and the case above is telling you nothing.
   */
  it("...and the reader sees app_node_exists_in_org's existing org term", () => {
    const def = lastFunctionText("app_node_exists_in_org");
    expect(def).not.toBeNull();
    expect(ORG_TERM.test(def!.text)).toBe(true);
  });
});
