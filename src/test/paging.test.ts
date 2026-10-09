/**
 * `fetchAll` — the 1000-row pager (src/lib/api/paging.ts).
 *
 * The one thing this file has to prove is that the helper NEVER hands back a
 * partial list dressed as a whole one. That splits into two halves that matter
 * equally: it must page a full result to exhaustion (a full page is never the
 * end), and it must REFUSE — throw, return nothing — the moment it cannot finish
 * (a page errors, or the read runs past the ceiling). A pager that stopped early
 * and returned what it had would be the exact silent truncation
 * `max_rows = 1000` already does; the whole point of the helper is that it does
 * not.
 *
 * The query builder is mocked: `fetchAll` takes a `(from, to) => PromiseLike<{
 * data, error }>` factory, so no supabase and no network are needed. The mock
 * is scripted with a list of page outcomes and records the ranges it was asked
 * for, which is how the range arithmetic is pinned too.
 */
import { describe, expect, it } from "vitest";
import { fetchAll, FETCH_ALL_MAX_PAGES, POSTGREST_MAX_ROWS } from "@/lib/api/paging";
import { isSchedulerError } from "@/lib/api/errors";

/** A page of `n` distinct rows, tagged with a base so order can be checked. */
function page(n: number, base = 0): Array<{ id: number }> {
  return Array.from({ length: n }, (_, i) => ({ id: base + i }));
}

/** A mocked builder scripted with one outcome per page, recording its ranges. */
function scripted(pages: Array<{ data: Array<{ id: number }> | null; error: unknown }>) {
  const ranges: Array<[number, number]> = [];
  let call = 0;
  const makeQuery = (from: number, to: number) => {
    ranges.push([from, to]);
    const outcome = pages[call] ?? { data: [], error: null };
    call += 1;
    return Promise.resolve(outcome);
  };
  return { makeQuery, ranges, calls: () => call };
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("fetchAll pages a read to exhaustion", () => {
  it("a single short page is returned whole, in one request", async () => {
    const q = scripted([{ data: page(500), error: null }]);
    const rows = await fetchAll(q.makeQuery);
    expect(rows).toHaveLength(500);
    expect(q.calls()).toBe(1);
    // Asked for the first page only, [0, 999].
    expect(q.ranges).toEqual([[0, POSTGREST_MAX_ROWS - 1]]);
  });

  it("exactly 1000 then 300 returns 1300 — a full page is never trusted as the end", async () => {
    const q = scripted([
      { data: page(POSTGREST_MAX_ROWS, 0), error: null },
      { data: page(300, POSTGREST_MAX_ROWS), error: null },
    ]);
    const rows = await fetchAll(q.makeQuery);
    expect(rows).toHaveLength(1300);
    expect(q.calls()).toBe(2);
    // Second page asked for [1000, 1999]; order preserved across the seam.
    expect(q.ranges).toEqual([
      [0, POSTGREST_MAX_ROWS - 1],
      [POSTGREST_MAX_ROWS, 2 * POSTGREST_MAX_ROWS - 1],
    ]);
    expect(rows[0]?.id).toBe(0);
    expect(rows[1299]?.id).toBe(POSTGREST_MAX_ROWS + 299);
  });

  it("exactly 1000 then 0 returns 1000 — the empty second page is the honest end", async () => {
    const q = scripted([
      { data: page(POSTGREST_MAX_ROWS, 0), error: null },
      { data: [], error: null },
    ]);
    const rows = await fetchAll(q.makeQuery);
    expect(rows).toHaveLength(POSTGREST_MAX_ROWS);
    expect(q.calls()).toBe(2);
  });

  it("an error on the second page throws the typed error and returns nothing", async () => {
    const q = scripted([
      { data: page(POSTGREST_MAX_ROWS, 0), error: null },
      { data: null, error: { code: "PGRST500", message: "boom", details: null, hint: null } },
    ]);
    const thrown = await capture(() => fetchAll(q.makeQuery));
    // A SchedulerError, not the raw PostgREST error and not a partial list.
    expect(isSchedulerError(thrown)).toBe(true);
    // It stopped at the failing page; the first page's rows are discarded, not
    // returned.
    expect(q.calls()).toBe(2);
  });

  it("the ceiling throws rather than looping or returning a partial list", async () => {
    // A query that returns a full page forever: fetchAll must refuse after
    // FETCH_ALL_MAX_PAGES rather than run on.
    const ranges: Array<[number, number]> = [];
    let call = 0;
    const makeQuery = (from: number, to: number) => {
      ranges.push([from, to]);
      call += 1;
      return Promise.resolve({ data: page(POSTGREST_MAX_ROWS, from), error: null });
    };
    const thrown = await capture(() => fetchAll(makeQuery));
    expect(isSchedulerError(thrown)).toBe(true);
    // Fetched exactly the ceiling's worth of pages, then refused before the
    // next request — never an unbounded loop.
    expect(call).toBe(FETCH_ALL_MAX_PAGES);
  });
});
