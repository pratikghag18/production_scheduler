/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0017 — A LINE SUPERVISOR'S BOARD SHOWS THE COMPANY DATE FORMAT.
 *
 * Plant A sets `date_format = ymd_slash`; the company default is `d_mon_yyyy`.
 * `app_resolve_node_setting(line_1, 'date_format')` answers `ymd_slash` for
 * Ana (it is SECURITY DEFINER and walks the ancestry), but `useDateFormat`
 * reads only the ROOT NODE'S OWN override from `node_settings`, which for a
 * board rooted at a line is no row at all, so she gets the company format.
 *
 * ⚠️ WHY THIS PIN READS THE SOURCE. The hook's data comes from two PostgREST
 * reads that the unit suite mocks as inputs, and the missing row is missing
 * because of RLS, which no mock can show. The pin accepts either fix shape the
 * lead names: the hook (or the API module it calls) asks a server resolver, or
 * the last `board_window` definition carries a resolved `date_format`.
 */

const ROOT = process.cwd();
const HOOK = path.join(ROOT, "src/features/admin/hooks/useOrgSettings.ts");
const API_DIR = path.join(ROOT, "src/lib/api");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body of `export function useDateFormat(...)`, up to the next export. */
function useDateFormatBody(): string | null {
  const src = stripComments(readFileSync(HOOK, "utf8"));
  const start = src.indexOf("export function useDateFormat(");
  if (start === -1) return null;
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

function apiSource(): string {
  return readdirSync(API_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => stripComments(readFileSync(path.join(API_DIR, f), "utf8")))
    .join("\n");
}

/** The last definition of board_window, SQL comments stripped. */
function lastBoardWindow(): string | null {
  let body: string | null = null;
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?board_window\s*\(/gi;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const end = sql.indexOf("$function$;", m.index + 1);
      body = sql.slice(m.index, end === -1 ? sql.length : end);
    }
  }
  return body;
}

const RESOLVER_RPC = /rpc\(\s*["'](?:app_)?resolve_node_setting["']/;

describe("DEF-0017: the board's date format is the plant's resolved value, not the root node's own row", () => {
  it("useDateFormat does not decide a node's format from that node's own override alone", () => {
    const body = useDateFormatBody();
    expect(body, "useDateFormat is not exported from useOrgSettings.ts").not.toBeNull();
    const asksServer = RESOLVER_RPC.test(body!) || RESOLVER_RPC.test(apiSource());
    const bw = lastBoardWindow();
    const boardCarriesIt = bw !== null && /['"]date_format['"]/.test(bw);
    const ownRowOnly = /ownOverride\(\s*overrides\.data\s*,\s*plantNodeId\s*\)/.test(body!);
    expect(
      asksServer || boardCarriesIt || !ownRowOnly,
      "useDateFormat answers ownOverride(overrides.data, plantNodeId) ?? company: the root node's OWN node_settings row or the company value. A board rooted at a line inside a plant with a date_format override gets the company format, while app_resolve_node_setting(line, 'date_format') says the plant's (DEF-0017)",
    ).toBe(true);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The hook and the last board_window must both be
   * found, and the server's resolver must exist and be SECURITY DEFINER —
   * otherwise the case above is red for a broken reader, not for the defect.
   */
  it("...and the reader finds the hook, board_window, and a definer resolver on the server", () => {
    expect(useDateFormatBody()).not.toBeNull();
    expect(lastBoardWindow()).not.toBeNull();
    let header: string | null = null;
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?app_resolve_node_setting\s*\(/gi;
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const rest = sql.slice(m.index);
        const body = rest.search(/\$[A-Za-z_]*\$/);
        header = rest.slice(0, body === -1 ? 600 : body);
      }
    }
    expect(header).not.toBeNull();
    expect(/security\s+definer/i.test(header!)).toBe(true);
  });
});
