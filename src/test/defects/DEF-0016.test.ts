/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0016 — A LINE SUPERVISOR'S BOARD HAS NO SHIFT PATTERN.
 *
 * Plant A's template is attached at `plant_a`; Line 1 inherits it (R-039,
 * nearest ancestor wins). `board_window` maps each scoped node with
 * `resolve_shift_template(node)`, and that function is SECURITY INVOKER: under
 * a supervisor granted only the line, the ancestor node and its attachment row
 * are both filtered away by RLS, the walk finds nothing, and the board draws
 * no breaks, no boundaries and no shift chips. Measured live:
 *
 *   as Ana  resolve_shift_template(line_1) -> NULL      board_window: node_shift_map array(0)
 *   as Dana resolve_shift_template(line_1) -> ac127431  board_window: node_shift_map array(12)
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS. vitest has no database; the psql and
 * PostgREST transcripts in the defect file are the behaviour. This pin asserts
 * the one property the lead names: the resolver runs as the definer, the way
 * `app_resolve_node_setting` (0050) and `app_operator_homes` (0058) already do
 * for the same "owned above the grant" question.
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

/**
 * The HEADER of the last definition of a function: the text from `create ...
 * function name(` up to the body's opening dollar quote. Security and
 * search_path clauses live there.
 */
function lastFunctionHeader(name: string): { file: string; header: string } | null {
  let found: { file: string; header: string } | null = null;
  const re = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${name}\s*\(`,
    "gi",
  );
  for (const { file, sql } of migrationsInOrder()) {
    const text = withoutComments(sql);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const body = text.slice(start).search(/\$[A-Za-z_]*\$/);
      const header = text.slice(start, body === -1 ? start + 600 : start + body);
      found = { file, header };
    }
  }
  return found;
}

const DEFINER = /security\s+definer/i;

describe("DEF-0016: the shift resolver sees a template attached above the caller's grant", () => {
  /**
   * ⛔ THE DEFECT. `resolve_shift_template` runs as the invoker, so a
   * supervisor granted a line cannot resolve the plant's template for it.
   */
  it("the last definition of resolve_shift_template is SECURITY DEFINER", () => {
    const def = lastFunctionHeader("resolve_shift_template");
    expect(def, "no migration defines resolve_shift_template").not.toBeNull();
    expect(
      DEFINER.test(def!.header),
      `resolve_shift_template (last defined in ${def!.file}) runs as the INVOKER, so under a supervisor granted only a line the ancestor node and its attachment row are filtered away and the walk answers NULL for a node that inherits a template (DEF-0016)`,
    ).toBe(true);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. `app_resolve_node_setting` (0050) IS security
   * definer for exactly this reason; if this case is red at the same time as
   * the one above, the reader is broken and it is telling you nothing.
   */
  it("...and the reader sees app_resolve_node_setting's existing SECURITY DEFINER", () => {
    const def = lastFunctionHeader("app_resolve_node_setting");
    expect(def).not.toBeNull();
    expect(DEFINER.test(def!.header)).toBe(true);
  });
});
