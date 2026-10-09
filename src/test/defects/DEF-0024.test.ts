import { describe, expect, it } from "vitest";

/**
 * DEF-0024: `src/test/boardWindowScoping.test.ts`'s two field-scoping cases
 * ("the runs sub-select is scoped by scoped_nodes ... and && v_window", and
 * its assignments twin) extract each field with:
 *
 *   /FROM\s+runs\s+\w[\s\S]{0,300}/i
 *
 * 300 characters of lookahead is enough to run past the end of the `runs`
 * JSON field and into the START of the next one (`'assignments', COALESCE((
 * ... a.timerange && v_window ...`), because `board_window`'s own JSON
 * literal builds `runs` immediately followed by `assignments` (read the
 * migration: `supabase/migrations/20260907000063_plant_timezone.sql`, the
 * two COALESCE blocks sit back to back). The case for `runs` can therefore
 * pass on a body where the RUNS query itself carries no time-window
 * predicate at all, as long as the NEXT field still has one -- which is
 * exactly the situation a maintainer who breaks the runs clause and leaves
 * the assignments clause alone would produce.
 *
 * This pin reproduces the bleed directly, without touching any migration
 * file or the live database: a synthetic body shaped exactly like
 * `board_window`'s (runs field is un-scoped by time; assignments field is,
 * as today), passed through the SAME regex `boardWindowScoping.test.ts`
 * uses. The buggy regex says the runs field passes; a regex properly bounded
 * to the runs field's own closing `)` says it does not -- which is what the
 * requirement (R-006) actually needs proven.
 */

// Extracted verbatim from src/test/boardWindowScoping.test.ts's "the runs
// sub-select is scoped..." case -- the regex under test, not retyped from
// memory.
const BUGGY_RUNS_BLOCK_RE = /FROM\s+runs\s+\w[\s\S]{0,300}/i;

// A regex bounded to the runs field's own COALESCE close, matching the exact
// closing shape both fields share in the real migration
// (`), '[]'::jsonb),`).
const BOUNDED_RUNS_BLOCK_RE = /FROM\s+runs\s+\w[\s\S]*?\),\s*'\[\]'::jsonb\)/i;

function syntheticBoardWindowBody(runsHasWindow: boolean): string {
  return `
    'runs', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.timerange)
      FROM runs r
      WHERE r.node_id IN (SELECT id FROM scoped_nodes)${runsHasWindow ? " AND r.timerange && v_window" : ""}
    ), '[]'::jsonb),

    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.timerange)
      FROM assignments a
      WHERE a.node_id IN (SELECT id FROM scoped_nodes) AND a.timerange && v_window
    ), '[]'::jsonb),
  `;
}

describe("DEF-0024: boardWindowScoping's runs-field regex bleeds into the assignments field", () => {
  it("a runs field with NO time-window predicate at all still matches the buggy 300-char regex, because it bleeds into assignments", () => {
    const body = syntheticBoardWindowBody(false);
    const block = BUGGY_RUNS_BLOCK_RE.exec(body);
    expect(block).not.toBeNull();
    // This is the exact assertion boardWindowScoping.test.ts makes, and it
    // wrongly passes: the "&& v_window" it finds belongs to the NEXT field.
    expect(block![0]).toMatch(/&&\s*v_window/);
  });

  it("a regex bounded to the runs field's own close correctly says NO when the runs field alone drops the window", () => {
    const body = syntheticBoardWindowBody(false);
    const block = BOUNDED_RUNS_BLOCK_RE.exec(body);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/&&\s*v_window/);
  });

  it("control: the bounded regex still says YES on the real (unbroken) shape", () => {
    const body = syntheticBoardWindowBody(true);
    const block = BOUNDED_RUNS_BLOCK_RE.exec(body);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/&&\s*v_window/);
  });
});
