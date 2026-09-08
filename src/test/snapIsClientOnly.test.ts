/// <reference types="node" />
/**
 * R-005: "Storage keeps exact timestamps; snapping is UI-only." A negative,
 * architectural claim -- proving it means proving an ABSENCE, the shape this
 * repo already uses in apiReadPaging.test.ts and scaleAudit.test.ts: read the
 * real source, and assert none of it does the forbidden thing.
 *
 * Two things would falsify this claim:
 *   1. A server-side write path (create_run, create_assignment, move_run,
 *      reassign_assignment) rounding or rejecting a timerange to a snap grid.
 *   2. A client call site sending a snap value to the server at all.
 *
 * The zoom-to-snap wiring itself (which increment the UI snaps a DRAG to) is
 * already proven by snapConfig.test.ts; this file proves the OTHER half --
 * that the resulting instant, once dropped, travels to the database and back
 * with nothing knowing or caring that it came from a snapped drag.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const MIGRATIONS_DIR = "supabase/migrations";
const API_DIR = "src/lib/api";

function migrationFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readMigration(file: string): string {
  return fs.readFileSync(path.join(repoRoot, MIGRATIONS_DIR, file), "utf8");
}

/**
 * The LAST `CREATE [OR REPLACE] FUNCTION <name>(...)` body across every
 * migration, in file order -- migrations are append-only, so a function can
 * be re-emitted later, and only the final shape is what actually runs.
 * Mirrors the extract-never-retype discipline the SQL suites use.
 */
function lastFunctionBody(name: string): string {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\([\\s\\S]*?\\$(?:function\\$|\\$)([\\s\\S]*?)\\$(?:function\\$|\\$)`,
    "gi",
  );
  let body: string | null = null;
  for (const file of migrationFiles()) {
    const text = readMigration(file);
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      body = m[3];
    }
  }
  if (body === null) throw new Error(`function ${name} not found in any migration`);
  return body;
}

// Every RPC that can write a runs/assignments.timerange.
const WRITE_PATHS = ["create_run", "create_assignment", "move_run", "reassign_assignment"] as const;

describe("R-005: no server-side write path rounds or rejects a timerange to a snap grid", () => {
  for (const fn of WRITE_PATHS) {
    it(`${fn}'s body contains no snap-related logic`, () => {
      const body = lastFunctionBody(fn);
      // Case-insensitive scan for "snap" as a word -- the real signal, not
      // decoration. `date_trunc('day', ...)` (absence day-boundary logic) is
      // a different concept and does not match "snap" at all, so no exemption
      // is needed for it.
      expect(body).not.toMatch(/\bsnap\w*/i);
    });
  }
});

describe("R-005: the client never sends a snap value to the server", () => {
  it("no src/lib/api call site passes a snap-shaped RPC parameter", () => {
    const files = fs
      .readdirSync(path.join(repoRoot, API_DIR))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(repoRoot, API_DIR, file), "utf8");
      // An RPC parameter would read `p_snap...` (server naming convention,
      // matching p_from/p_to/p_root_path above) or a bare `snap` key in an
      // .rpc(...) call's argument object.
      if (/p_snap\w*\s*:/i.test(text) || /\brpc\([^)]*\bsnap\w*\s*:/is.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("R-005: runs/assignments timerange bounds carry no alignment CHECK", () => {
  it("no migration adds a CHECK constraint requiring timerange bounds to fall on a minute grid", () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const text = readMigration(file);
      // A minute-grid CHECK would look like EXTRACT(MINUTE FROM ...) % n = 0,
      // or date_trunc('minute'/'hour', ...) compared back to the column --
      // day-truncation (absence logic) is a different grain and is excluded.
      const checkRe = /CHECK\s*\([^)]*(EXTRACT\s*\(\s*MINUTE|date_trunc\s*\(\s*'(minute|hour)')/is;
      if (checkRe.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
