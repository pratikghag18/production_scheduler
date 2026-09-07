/// <reference types="node" />
/**
 * THE 1000-ROW PAGING GUARDRAIL.
 *
 * `supabase/config.toml` sets `max_rows = 1000`, so every `.from(...).select(...)`
 * read of a table or view stops at a thousand rows and says nothing. `paging.ts`
 * is the answer — `fetchAll` pages to exhaustion and refuses a short read — but a
 * helper only helps the reads that actually go through it. The failure this file
 * exists to stop is the SILENT one: a new admin section, or a new read added to
 * an existing one, that fetches a catalogue with a bare
 * `supabase.from(...).select(...)` and no `.range(...)`. It compiles, it renders,
 * and it is wrong only once a plant grows past a thousand rows — at which point
 * the screen shows the first thousand and calls it all of them. `tsc` cannot see
 * a missing pager; nothing in the running app can either until it is too large.
 *
 * ⭐ THE RULE, IN ONE LINE: every LIST read in `src/lib/api/` — a
 * `.from("x").select(...)` — is routed through `fetchAll` with a stable order
 * (its chain carries an `.order(...)` BEFORE its `.range(from, to)`), or it is
 * NAMED HERE as an exemption with a reason.
 *
 * ⛔⛔ THE `.order(` IS NOT OPTIONAL AND IS NOT DECORATION. `.range()` slices an
 * already-ordered list; a read with NO order, or an order on a non-unique
 * column, lets Postgres return rows in a different sequence per page request, so
 * past 1000 rows a page can SKIP or REPEAT a row and the whole list still looks
 * complete. That is the exact silent-truncation failure `fetchAll` exists to
 * kill, wearing paging code. So the matcher requires an `.order(` before the
 * `.range(` in every routed read's chain; a read that pages without ordering
 * fails this audit, named by file and table. (The audit checks that an order is
 * PRESENT and comes first; that it ends in a UNIQUE key is verified against each
 * table's primary key in the migrations at the call site, not from source here.)
 *
 * ⚠️ A READ IS `.from(x)` IMMEDIATELY FOLLOWED BY `.select(`. A write is
 * `.from(x)` followed by `.insert` / `.update` / `.delete` / `.upsert` and only
 * THEN `.select(...)` to read back the row it wrote — so the matcher below,
 * which requires `.select(` to sit directly after `.from(x)`, sees reads and not
 * writes. Writes are capped at the rows they touch and are not subject to
 * `max_rows` the way an open list read is.
 *
 * ⚠️⚠️ "ROUTED" MEANS INSIDE A `fetchAll(...)` CALL, NOT MERELY IN A FILE THAT
 * IMPORTS IT. A read sitting next to a `fetchAll` call it does not use is exactly
 * what a copy-paste leaves behind, so the matcher checks that each read's
 * position falls inside a `fetchAll(` argument span, and that the span really
 * pages (`.range(` is present). Importing and ignoring fails.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const API_DIR = "src/lib/api";

/**
 * The list reads that are DELIBERATELY not paged, each with the argument for it.
 * Keyed `<file>:<table>`. An exemption is a reason, not a name on a list.
 */
export const PAGING_EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([
  [
    "audit.ts:audit_log",
    "The audit log is unbounded (one row per write, forever) and is KEYSET-paged " +
      "on its own in audit.ts: it reads one bounded page of AUDIT_PAGE_SIZE + 1 by " +
      "id-cursor, not a whole-list read, because .range() offsets shift under a " +
      "moving top. It is already proof against max_rows and must not be re-routed " +
      "through fetchAll, which would read the entire history into one screen.",
  ],
  [
    "access.ts:orgs",
    "fetchOrgSettings reads the caller's own org row with .single() — exactly one " +
      "row by orgs_select, not a list. max_rows caps a list; there is nothing here " +
      "to page, and fetchAll expects an array result rather than a single object.",
  ],
]);

/** The reason string has to be an argument, not a shrug. */
const MIN_REASON = 80;

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

/**
 * Comments out first — every file here discusses `.from(...).select(...)`,
 * `fetchAll` and `.range(...)` in prose, and a matcher that read comments would
 * pass a read whose only pager is a sentence describing one. CLAUDE.md §4
 * records that this mistake has been made in this repo before.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every `.from("table").select(` read in the source, with its char offset. */
export function listReads(src: string): Array<{ table: string; index: number }> {
  const clean = stripComments(src);
  const re = /\.from\(\s*"([^"]+)"\s*\)\s*\.select\(/g;
  const out: Array<{ table: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    out.push({ table: m[1], index: m.index });
  }
  return out;
}

/**
 * The [start, end) char span of each `fetchAll(` argument, by balancing parens
 * from the opening one. So a read's offset can be tested for "inside a fetchAll".
 */
export function fetchAllSpans(src: string): Array<{ start: number; end: number; text: string }> {
  const clean = stripComments(src);
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const marker = "fetchAll(";
  let from = 0;
  for (;;) {
    const at = clean.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + marker.length - 1; // sit on the '('
    const argStart = i + 1;
    for (; i < clean.length; i += 1) {
      const c = clean[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push({ start: argStart, end: i, text: clean.slice(argStart, i) });
    from = i + 1;
  }
  return spans;
}

/**
 * A fetchAll span that pages STABLY: it carries a `.range(` AND an `.order(`
 * that comes before the `.range(`. Range without a prior order is offset paging
 * over an unordered list — the skip/repeat hazard the header describes.
 */
export function stablyPaged(text: string): boolean {
  const range = text.indexOf(".range(");
  const order = text.indexOf(".order(");
  return range !== -1 && order !== -1 && order < range;
}

/** True when `index` falls inside a fetchAll span that pages stably. */
function insidePagedFetchAll(
  index: number,
  spans: Array<{ start: number; end: number; text: string }>,
): boolean {
  return spans.some((s) => index >= s.start && index < s.end && stablyPaged(s.text));
}

/** Reads in this source that are neither routed through a paging fetchAll nor exempt. */
export function unroutedReads(file: string, src: string): string[] {
  const spans = fetchAllSpans(src);
  return listReads(src)
    .filter((r) => !PAGING_EXEMPT.has(`${file}:${r.table}`))
    .filter((r) => !insidePagedFetchAll(r.index, spans))
    .map((r) => `${file}:${r.table}`);
}

function apiFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, API_DIR))
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

/* ===========================================================================
 * THE MATCHER, HELD AGAINST SOURCES WRITTEN TO BREAK IT.
 * ======================================================================== */

describe("the matcher tells a paged read from an unpaged one", () => {
  it("passes a read wrapped in a paging fetchAll", () => {
    const good = `
      const rows = await fetchAll((from, to) =>
        supabase.from("products").select(PRODUCT_COLUMNS).order("sku").range(from, to),
      );`;
    expect(unroutedReads("x.ts", good)).toEqual([]);
  });

  it("⭐ FAILS a bare list read with no pager — the case this file exists for", () => {
    const bad = `
      const { data } = await supabase.from("products").select(PRODUCT_COLUMNS).order("sku");`;
    expect(unroutedReads("x.ts", bad)).toEqual(["x.ts:products"]);
  });

  it("⚠️ FAILS a read inside a fetchAll that forgot to .range()", () => {
    const noRange = `
      const rows = await fetchAll(() => supabase.from("products").select("id"));`;
    expect(unroutedReads("x.ts", noRange)).toEqual(["x.ts:products"]);
  });

  it("⛔ FAILS a read that pages but does not .order() — the reviewer's gap", () => {
    const unordered = `
      const rows = await fetchAll((from, to) =>
        supabase.from("node_settings").select("node_id, value").eq("key", key).range(from, to));`;
    expect(unroutedReads("x.ts", unordered)).toEqual(["x.ts:node_settings"]);
  });

  it("⛔ FAILS a read whose .order() comes AFTER .range() — order must precede the slice", () => {
    const backwards = `
      const rows = await fetchAll((from, to) =>
        supabase.from("products").select("id").range(from, to).order("id"));`;
    expect(unroutedReads("x.ts", backwards)).toEqual(["x.ts:products"]);
  });

  it("does NOT flag a write that reads its own row back", () => {
    const write = `
      const { data } = await supabase.from("operators").insert(payload).select("id");`;
    expect(listReads(write)).toEqual([]);
    expect(unroutedReads("x.ts", write)).toEqual([]);
  });

  it("does NOT flag an update-then-select write", () => {
    const upd = `
      const { data } = await supabase.from("skills").update(patch).eq("id", id).select(SKILL_COLUMNS);`;
    expect(listReads(upd)).toEqual([]);
  });

  it("⚠️ is not fooled by a mention of the read in a comment", () => {
    const excuse = `
      // supabase.from("products").select(PRODUCT_COLUMNS) would need paging here.
      const rows = await fetchAll((from, to) =>
        supabase.from("products").select(PRODUCT_COLUMNS).order("sku").range(from, to));`;
    // The commented read is stripped; only the real, paged one remains.
    expect(unroutedReads("x.ts", excuse)).toEqual([]);
  });

  it("honours an exemption but only for its exact file and table", () => {
    const single = `const { data } = await supabase.from("orgs").select("settings").single();`;
    expect(unroutedReads("access.ts", single)).toEqual([]);
    // Same read in another file is NOT exempt.
    expect(unroutedReads("other.ts", single)).toEqual(["other.ts:orgs"]);
  });
});

/* ===========================================================================
 * THE FOLDER.
 * ======================================================================== */

describe("every list read in src/lib/api goes through the pager", () => {
  it("⭐⭐ no api file has an unpaged, unexempt list read", () => {
    const offenders = apiFiles().flatMap((f) => unroutedReads(f, read(`${API_DIR}/${f}`)));
    expect(offenders).toEqual([]);
  });

  /**
   * The full inventory of routed reads, pinned so a read cannot quietly vanish
   * (deleting a read is another way to make this audit green while breaking a
   * screen). A new list read is added here in the same commit that routes it.
   */
  it("the routed reads are exactly the known inventory", () => {
    const routed = apiFiles()
      .flatMap((f) => {
        const src = read(`${API_DIR}/${f}`);
        const spans = fetchAllSpans(src);
        return listReads(src)
          .filter((r) => insidePagedFetchAll(r.index, spans))
          .map((r) => `${f}:${r.table}`);
      })
      .sort();
    expect(routed).toEqual(
      [
        "absences.ts:absences",
        "access.ts:nodes",
        "access.ts:node_settings",
        "cycleTimes.ts:node_product_cycle_times",
        "hierarchy.ts:hierarchy_templates",
        "hierarchy.ts:hierarchy_levels",
        "hierarchy.ts:nodes",
        "operators.ts:operators",
        "operators.ts:skills",
        "operators.ts:operator_skills",
        "operators.ts:node_skill_requirements",
        "operators.ts:nodes",
        "operators.ts:hierarchy_levels",
        "products.ts:products",
        "shifts.ts:shift_templates",
        "shifts.ts:shifts",
        "shifts.ts:shift_breaks",
        "shifts.ts:node_shift_templates",
        "shifts.ts:nodes",
      ].sort(),
    );
  });

  it("an exemption names a read that still exists, so it cannot go stale", () => {
    const missing = [...PAGING_EXEMPT.keys()].filter((key) => {
      const [file, table] = key.split(":");
      return !listReads(read(`${API_DIR}/${file}`)).some((r) => r.table === table);
    });
    expect(missing).toEqual([]);
  });

  it("every exemption reason is an argument, not a shrug", () => {
    const thin = [...PAGING_EXEMPT.entries()]
      .filter(([, why]) => why.trim().length < MIN_REASON)
      .map(([k]) => k);
    expect(thin).toEqual([]);
  });
});
