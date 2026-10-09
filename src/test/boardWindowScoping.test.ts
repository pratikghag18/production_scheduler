/// <reference types="node" />
/**
 * R-006: "Board loads are one subtree-by-time-window query." Another
 * negative/architectural claim -- proving it means proving there is no OTHER
 * way runs/assignments reach the board, and that the one path there is
 * actually scoped, not merely named as if it were.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(rel);
    }
  }
  return out;
}

describe("R-006: board_window is the only path runs/assignments reach the client", () => {
  it("no src/lib/api or src/features file reads runs/assignments as an unbounded list", () => {
    const offenders: string[] = [];
    for (const file of walk("src/lib/api").concat(walk("src/features"))) {
      const text = readFile(file);
      // A LIST read is .from("runs"|"assignments") followed by .select(
      // before any .insert/.update/.delete/.upsert -- a write's own
      // .select() (to read back the row it wrote) always follows one of
      // those verbs first, and is always scoped by .eq("id", ...).
      const re = /\.from\((["'])(runs|assignments)\1\)\s*\n?\s*\.select\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        offenders.push(`${file}: unscoped .from("${m[2]}").select(...)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("fetchBoardWindow calls the board_window RPC with root path and both time bounds, nothing broader", () => {
    const text = readFile("src/lib/api/board.ts");
    const m = /supabase\.rpc\(\s*["']board_window["']\s*,\s*\{([\s\S]*?)\}/.exec(text);
    expect(m).not.toBeNull();
    const args = m![1];
    expect(args).toMatch(/p_root_path/);
    expect(args).toMatch(/p_from/);
    expect(args).toMatch(/p_to/);
  });
});

describe("R-006: the server-side board_window function scopes both by subtree and by time window", () => {
  function lastFunctionBody(name: string): string {
    const re = new RegExp(
      `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\([\\s\\S]*?\\$(?:function\\$|\\$)([\\s\\S]*?)\\$(?:function\\$|\\$)`,
      "gi",
    );
    let body: string | null = null;
    for (const file of fs
      .readdirSync(path.join(repoRoot, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const fileText = readFile(path.join("supabase/migrations", file));
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(fileText)) !== null) body = m[3];
    }
    if (body === null) throw new Error(`function ${name} not found`);
    return body;
  }

  /**
   * DEF-0024. Slicing the body with a CHARACTER BUDGET ("300 characters after
   * FROM runs") cannot tell one JSON field from the next: `board_window`
   * builds `runs` and `assignments` back to back, so a runs field that had
   * lost its time-window predicate entirely still matched `&& v_window` --
   * the assignments field's. The slice must end where the thing being asserted
   * ends, so these two walk the body's own parentheses instead of counting
   * characters. Quoted literals and `--` comments are skipped so a paren
   * inside either cannot throw the count off.
   */
  function balancedGroupAfter(body: string, from: number): string {
    const open = body.indexOf("(", from);
    if (open < 0) throw new Error(`no '(' after offset ${from}`);
    let depth = 0;
    for (let k = open; k < body.length; k++) {
      const c = body[k];
      if (c === "'") {
        const close = body.indexOf("'", k + 1);
        k = close < 0 ? body.length : close;
        continue;
      }
      if (c === "-" && body[k + 1] === "-") {
        const nl = body.indexOf("\n", k);
        k = nl < 0 ? body.length : nl;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return body.slice(open, k + 1);
    }
    throw new Error("unbalanced parentheses");
  }

  /** The COALESCE argument list of one top-level JSON field, and nothing after it. */
  function jsonField(body: string, key: string): string {
    const at = body.search(new RegExp(`'${key}'\\s*,\\s*COALESCE`, "i"));
    if (at < 0) throw new Error(`board_window has no '${key}' field`);
    return balancedGroupAfter(body, at + key.length + 2);
  }

  /** One CTE's own body, and nothing after it. */
  function cte(body: string, name: string): string {
    const at = body.search(new RegExp(`\\b${name}\\s+AS\\s*\\(`, "i"));
    if (at < 0) throw new Error(`board_window has no ${name} CTE`);
    return balancedGroupAfter(body, at);
  }

  it("the runs sub-select is scoped by scoped_nodes (subtree) and && v_window (time)", () => {
    const runsBlock = jsonField(lastFunctionBody("board_window"), "runs");
    // The bound is the assertion's foundation, so prove it holds: the runs
    // field must not have swallowed the assignments field that follows it.
    expect(runsBlock).not.toMatch(/'assignments'/i);
    expect(runsBlock).toMatch(/FROM\s+runs\s+\w/i);
    expect(runsBlock).toMatch(/scoped_nodes/);
    expect(runsBlock).toMatch(/&&\s*v_window/);
  });

  it("the assignments sub-select is scoped by scoped_nodes (subtree) and && v_window (time)", () => {
    const assignmentsBlock = jsonField(lastFunctionBody("board_window"), "assignments");
    expect(assignmentsBlock).not.toMatch(/'operators'/i);
    expect(assignmentsBlock).toMatch(/FROM\s+assignments\s+\w/i);
    expect(assignmentsBlock).toMatch(/scoped_nodes/);
    expect(assignmentsBlock).toMatch(/&&\s*v_window/);
  });

  it("scoped_nodes itself is bounded by an org filter and a path ancestor/descendant test, not the whole table", () => {
    const scopedNodesBlock = cte(lastFunctionBody("board_window"), "scoped_nodes");
    expect(scopedNodesBlock).toMatch(/org_id\s*=\s*v_org_id/);
    expect(scopedNodesBlock).toMatch(/path\s*<@\s*p_root_path/);
  });
});
