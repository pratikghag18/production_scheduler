/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0013 — `app_node_is_plant_root` ANSWERS FOR ANOTHER COMPANY'S NODES.
 *
 * Migration 0054 added a SECURITY DEFINER helper so the new trigger on
 * `profile_grants` can ask "is this node a plant root?" without the caller's
 * row-level view getting in the way. Its header says it is *"in the shape of
 * `app_node_exists_in_org` (0020)"*. It is not: 0020's helper is org-scoped
 * (`n.org_id = app_current_org()`) and its comment says why — *"it grants
 * nothing and is org-scoped, so it says nothing about another tenant."* The
 * new one has no org term, is granted to `authenticated`, and is therefore an
 * RPC any signed-in person of any company can call.
 *
 * Measured over PostgREST as `ana@example.test`, a supervisor with no admin
 * grant anywhere, asking about the OTHER company's plant root:
 *
 *   rpc/app_node_is_plant_root  -> true
 *   rpc/app_node_exists_in_org  -> false
 *
 * One bit, and only about a uuid the caller already holds — which is why the
 * defect is `minor`. But it is the bit this schema's own definer helpers are
 * written not to give (0020 §8.0; 65's X4–X6), and the trigger itself leaks
 * it too: a direct INSERT of `admin` on a foreign LEAF is refused by the
 * trigger (`admin_below_root`, PT400) while the same on a foreign ROOT is
 * refused by the policy (42501).
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS RATHER THAN THE DATABASE. vitest has
 * no database here. The reproduction that proves the behaviour is the curl in
 * the defect file; this pin is the one that runs on every `npm run test`, and
 * it asserts the shape 0054's own header claims: the helper is org-scoped.
 * If the helper is removed altogether the disclosure goes with it, and this
 * file says so rather than failing for a reason nobody has.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

/**
 * Every definition of a function across the migrations, oldest first, as the
 * text from `function <name>(` to the end of its body. Same reader as
 * DEF-0011's pin: case-insensitive and schema-tolerant, and it skips the
 * `comment on function` lines that would otherwise count as a definition.
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
      if (
        /(revoke|grant)\s+(all|execute)\s+on\s+$/i.test(sql.slice(Math.max(0, start - 30), start))
      )
        continue;
      // A SQL-language body ends at the closing `$$;`; a plpgsql one at `END $`.
      const endSql = sql.indexOf("$$;", start + 1);
      const endPl = sql.indexOf("END $", start);
      const candidates = [endSql, endPl].filter((i) => i !== -1);
      const end = candidates.length ? Math.min(...candidates) : sql.length;
      out.push({ file, body: sql.slice(start, end) });
    }
  }
  return out;
}

const ORG_SCOPED = /app_current_org\s*\(\s*\)/;

describe("DEF-0013: a SECURITY DEFINER helper says nothing about another company's nodes", () => {
  /**
   * ⛔ THE DEFECT. The last definition of `app_node_is_plant_root` answers
   * about any node in the database. If the helper is gone, the disclosure is
   * gone with it and the case passes for that reason.
   */
  it("the last definition of app_node_is_plant_root is scoped to the caller's org", () => {
    const defs = definitionsOf("app_node_is_plant_root");
    if (defs.length === 0) return; // removed altogether: nothing left to disclose
    const last = defs[defs.length - 1];
    expect(
      last.body,
      `the last definition of app_node_is_plant_root is in ${last.file} and has no app_current_org() term, so it answers for another company's nodes`,
    ).toMatch(ORG_SCOPED);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The case above would pass trivially if this
   * file's reader found nothing, or if `app_current_org()` were not how this
   * schema scopes a definer helper. 0020's `app_node_exists_in_org` is the
   * helper 0054 says it copied, and it IS scoped that way; if this case ever
   * goes red at the same time as the first, the reader is broken and the
   * first case is telling you nothing.
   */
  it("app_node_exists_in_org, the helper 0054 says it copied, is found and is org-scoped", () => {
    const defs = definitionsOf("app_node_exists_in_org");
    expect(defs.length).toBeGreaterThan(0);
    const last = defs[defs.length - 1];
    expect(last.body).toMatch(ORG_SCOPED);
  });

  /**
   * ⚠️ AND THE DEFINER IS STILL A DEFINER. The obvious wrong fix is to make
   * the helper SECURITY INVOKER, which the migration header measured as
   * breaking 47's W28 (a foreign root becomes invisible and the trigger
   * speaks before the policy). Scoping the answer to the org is the fix;
   * dropping the definer is a different change with a red case behind it.
   */
  it("...and it stays SECURITY DEFINER, because the fix is scope and not privilege", () => {
    const defs = definitionsOf("app_node_is_plant_root");
    if (defs.length === 0) return;
    const last = defs[defs.length - 1];
    expect(last.body).toMatch(/security\s+definer/i);
  });
});
