/// <reference types="node" />
// Node types are referenced per-file rather than added to the app tsconfig, for
// the reason `scaleAudit.ts` gives: this is a browser app and only the audits
// touch the filesystem.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * DEF-0014 — A PLAIN UPDATE OF `runs.node_id` MOVES THE RUN AND STRANDS ITS CREW.
 *
 * `assignments_run_consistency` (0003) refuses a crew row whose cell is not
 * its run's cell; nothing on the runs side refuses a run that walks away from
 * its crew. `move_run` (0050) carries the crew, but the table takes the bare
 * move from anyone `runs_update` lets edit the cell. Measured live as Dana
 * inside a rolled-back transaction:
 *
 *   raw UPDATE runs.node_id as Dana: rows=1
 *   after: run on plant_a.area_2.line_3.cell_5 ; its crew on plant_a.area_1.line_1.cell_1
 *
 * ⚠️ WHY THIS PIN READS THE MIGRATIONS RATHER THAN THE DATABASE. vitest has
 * no database here; the reproduction that proves the behaviour is the psql
 * block in the defect file. This pin runs on every `npm run test` and asserts
 * the shape the queue item names: the runs side has a guard of its own. It
 * accepts either fix — a trigger that refuses a run with crew, or one that
 * carries the crew — because both must read `assignments`.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

function migrationsInOrder(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS, file), "utf8") }));
}

/** Strip `-- ...` comments so a trigger described in prose does not count. */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

interface TriggerDef {
  name: string;
  table: string;
  events: string;
  fn: string;
}

/**
 * The LAST definition of every trigger, across the migrations in order, with
 * later `drop trigger` statements removing it again. `create trigger` is
 * matched case-insensitively and with or without `public.` on the table.
 */
function lastTriggers(): Map<string, TriggerDef> {
  const out = new Map<string, TriggerDef>();
  const re =
    /create\s+(?:or\s+replace\s+)?trigger\s+(\w+)\s+((?:before|after|instead\s+of)\s+[\s\S]*?)\s+on\s+(?:public\.)?(\w+)[\s\S]*?execute\s+(?:function|procedure)\s+(?:public\.)?(\w+)\s*\(/gi;
  const drop = /drop\s+trigger\s+(?:if\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)/gi;
  for (const { sql } of migrationsInOrder()) {
    const text = withoutComments(sql);
    // Walk creates and drops in file order so a drop after a create wins.
    const events: Array<{ at: number; kind: "create" | "drop"; def?: TriggerDef; key?: string }> =
      [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const def = { name: m[1], events: m[2].replace(/\s+/g, " ").toLowerCase(), table: m[3].toLowerCase(), fn: m[4] };
      events.push({ at: m.index, kind: "create", def, key: `${def.table}.${def.name}` });
    }
    while ((m = drop.exec(text)) !== null) {
      events.push({ at: m.index, kind: "drop", key: `${m[2].toLowerCase()}.${m[1]}` });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === "create" && e.def) out.set(e.key!, e.def);
      else if (e.kind === "drop") out.delete(e.key!);
    }
  }
  return out;
}

/** The body of the LAST definition of a function, comments stripped. */
function lastFunctionBody(name: string): string | null {
  let body: string | null = null;
  const re = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${name}\s*\(`,
    "gi",
  );
  for (const { sql } of migrationsInOrder()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const start = m.index;
      const endSql = sql.indexOf("$$;", start + 1);
      const endPl = sql.indexOf("$function$;", start + 1);
      const candidates = [endSql, endPl].filter((i) => i !== -1);
      const end = candidates.length ? Math.min(...candidates) : sql.length;
      body = withoutComments(sql.slice(start, end));
    }
  }
  return body;
}

function firesOnNodeIdUpdate(t: TriggerDef): boolean {
  if (!/update/.test(t.events)) return false;
  // `update` with no column list fires on every column; `update of a, b`
  // fires only on those.
  const of = /update\s+of\s+([\w\s,]+?)(?:\s+on\b|$)/.exec(t.events + " on");
  if (!of) return true;
  return of[1].split(",").map((c) => c.trim()).includes("node_id");
}

describe("DEF-0014: the runs side refuses or carries the crew when a run's cell changes", () => {
  /**
   * ⛔ THE DEFECT. No trigger on `runs` that fires on an update of `node_id`
   * reads `assignments`, so a bare UPDATE moves the run and leaves the crew
   * where it was. Red on this build: the only such trigger is
   * `runs_scope_guard` -> `app_guard_run_scope`, which is about product places.
   */
  it("some trigger on runs firing on UPDATE OF node_id has a function that reads assignments", () => {
    const onRuns = [...lastTriggers().values()].filter(
      (t) => t.table === "runs" && firesOnNodeIdUpdate(t),
    );
    expect(onRuns.length, "no trigger on runs fires on an update of node_id at all").toBeGreaterThan(0);
    const readers = onRuns.filter((t) => {
      const body = lastFunctionBody(t.fn);
      return body !== null && /\bassignments\b/i.test(body);
    });
    expect(
      readers.map((t) => `${t.name} -> ${t.fn}`),
      `triggers on runs that fire on node_id: ${onRuns.map((t) => `${t.name} -> ${t.fn}`).join(", ")} — none of their functions reads assignments, so a plain UPDATE of runs.node_id strands the crew (DEF-0014)`,
    ).not.toHaveLength(0);
  });

  /**
   * ⚠️ THE GUARD ON THE GUARD. The case above would pass trivially if the
   * reader found no triggers or no function bodies. The other side of the
   * same invariant already exists: `assignments_run_consistency` (0003) on
   * `assignments`, whose function reads `runs`. If THIS case ever goes red
   * with the first, the reader is broken and the first is telling you nothing.
   */
  it("the reader finds assignments_run_consistency on the other side, and its function reads runs", () => {
    const t = lastTriggers().get("assignments.assignments_run_consistency");
    expect(t, "assignments_run_consistency not found on assignments").toBeDefined();
    expect(firesOnNodeIdUpdate(t!)).toBe(true);
    const body = lastFunctionBody(t!.fn);
    expect(body).not.toBeNull();
    expect(body!).toMatch(/\bruns\b/i);
  });
});
