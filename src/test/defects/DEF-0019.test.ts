/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0019 — THE SHIFT RESOLVER'S OWNER EXEMPTION ADMITS ANY PROFILE-LESS
 * SESSION.
 *
 * 0061 bounds `resolve_shift_template` with
 * `(app_current_org() IS NULL OR target.org_id = app_current_org())` so the
 * superuser test cases keep resolving. But `app_current_org()` is NULL for any
 * `authenticated` session whose user has no `user_profiles` row — a fresh
 * sign-up — and such a session resolves both companies' templates while
 * `app_node_exists_in_org` and `app_node_is_plant_root` answer false for it.
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS. The psql transcript in the defect file
 * is the behaviour; the pin asserts that the last definition does not key its
 * exemption on the org being null. A fix that keys the exemption on the
 * session role (or drops it) is green; a fix that keeps this predicate is not.
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

const NULL_ORG_EXEMPTION = /app_current_org\s*\(\s*\)\s+is\s+null/i;
const ORG_TERM = /target\.org_id\s*=\s*app_current_org\s*\(\s*\)/i;

describe("DEF-0019: the shift resolver's boundary is not switched off by a null company", () => {
  /**
   * ⛔ THE DEFECT. Red on 0061: the first predicate is `app_current_org() IS
   * NULL OR ...`, which is true for every signed-in session without a profile.
   */
  it("the last definition of resolve_shift_template does not exempt a null app_current_org()", () => {
    const def = lastFunctionText("resolve_shift_template");
    expect(def, "no migration defines resolve_shift_template").not.toBeNull();
    expect(
      NULL_ORG_EXEMPTION.test(def!.text),
      `resolve_shift_template (last defined in ${def!.file}) switches its company boundary off when app_current_org() is NULL, which is every authenticated session with no user_profiles row and not only the owner; such a session resolves every company's templates (DEF-0019, R-341)`,
    ).toBe(false);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. 0061 did add the org term; if the reader cannot
   * see it, the case above is red for a blind reader and not for the defect.
   */
  it("...and the reader sees the org term 0061 put on the target scan", () => {
    const def = lastFunctionText("resolve_shift_template");
    expect(def).not.toBeNull();
    expect(ORG_TERM.test(def!.text)).toBe(true);
  });
});
