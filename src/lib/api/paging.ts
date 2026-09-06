/**
 * Read a whole table or view to exhaustion, one PostgREST page at a time.
 *
 * ⚠️⚠️ THE 1000-ROW CEILING IS REAL AND IT IS SILENT. `supabase/config.toml`
 * sets `max_rows = 1000` for PostgREST, so EVERY `.from(...).select(...)` read
 * of a table or view stops at a thousand rows and says nothing — no error, no
 * flag, no short-count the caller can see. A plant large enough to cross that
 * line would show a partial catalogue that reads exactly like a complete one:
 * the newest thousand products, or the first thousand nodes, called "all of
 * them" for the rest of the product's life. `audit_log` was the first table to
 * meet this and got its own keyset pager (`audit.ts`); this is the general
 * answer for the catalogue reads, which are unbounded in principle even where
 * they are small today.
 *
 * ⭐ HOW IT WORKS: fetch `.range(0, 999)`, then `.range(1000, 1999)`, and so on,
 * until a page comes back SHORT — fewer rows than a full page. A short page is
 * the only honest signal that the list is exhausted; a full page might be the
 * end, or might be the ceiling, and the two are indistinguishable, so a full
 * page is never trusted as the end.
 *
 * ⛔⛔ AND IT REFUSES TO COMPUTE ON A SHORT READ. "Refuse" is the whole point
 * (CLAUDE.md §4: a write that reports success can have changed nothing — the
 * read half is a read that reports completeness can have stopped early). A read
 * that cannot be COMPLETED — an error on any page, or a row count past the
 * ceiling below — THROWS a typed `SchedulerError` rather than returning the
 * rows gathered so far. A partial list handed back as if whole is the exact
 * misrepresentation this file exists to prevent, so there is no code path that
 * returns one: either the whole list comes back, or nothing does and the screen
 * shows the refusal.
 *
 * AUTHOR-ONLY at the call sites — the callers import `@/lib/supabase`. This
 * file itself imports nothing at runtime but `./errors`, so its logic is
 * unit-tested directly (`src/test/paging.test.ts`) with a mocked query builder.
 */
import { toSchedulerError } from "./errors";

/**
 * PostgREST's response cap, mirrored from `supabase/config.toml`'s
 * `max_rows = 1000`.
 *
 * ⛔ THIS IS COUPLED TO THAT FILE AND NOTHING ENFORCES THE COUPLING BUT THIS
 * COMMENT. It is the size of one page BECAUSE it is the size the server will
 * serve: a page asked for larger than `max_rows` would be truncated by the
 * server to exactly this many, so a step of `max_rows` is the largest step that
 * never asks for a row the server will silently drop. If `config.toml` ever
 * changes `max_rows`, change this number in the same commit — a larger value
 * here would make `fetchAll` mistake a server-truncated full page for a short
 * one and STOP EARLY, which is the ceiling bug wearing the paging code's own
 * clothes.
 */
export const POSTGREST_MAX_ROWS = 1000;

/**
 * How many pages `fetchAll` will fetch before it refuses.
 *
 * ⛔ A SANE CEILING, CHOSEN NOT ROUND. Fifty pages is fifty thousand rows, and
 * the number is a deliberate line between two failures. Below it: a runaway —
 * a query that returns a full page forever (a bug, or a genuinely enormous
 * table) would otherwise loop until it exhausted memory or the request budget,
 * silently. Above it: nothing legitimate. Every caller of `fetchAll` renders
 * its whole result into one screen — an admin grid, the hierarchy tree, the
 * board's node list — and a list of fifty thousand rows is already past the
 * point any of those could draw or a person could read. So a read that crosses
 * this line is not a big screen, it is a broken one, and a refusal the reader
 * can see beats a fetch that runs for minutes and then freezes the tab. The
 * durable answer for a genuinely unbounded list is server-side paging, the way
 * `audit_log` got it — a migration, and a decision for the maintainer, not a
 * bigger number here.
 */
export const FETCH_ALL_MAX_PAGES = 50;

/** One page's worth of a PostgREST response, as `fetchAll` needs to read it. */
export interface PagedResult<Row> {
  data: Row[] | null;
  error: unknown;
}

/**
 * Builds the query for ONE page, applying `.range(from, to)` itself.
 *
 * ⚠️ IT IS A FACTORY, NOT A BUILDER, AND THAT IS FORCED BY postgrest-js. A
 * PostgREST builder is one-shot: awaiting it fires the request, and it cannot
 * be re-awaited with a different range. So `fetchAll` cannot hold one query and
 * page it; it has to be handed a way to build a FRESH query per page. Each
 * caller passes `(from, to) => supabase.from(...).select(...).range(from, to)`,
 * which also keeps every table name, column list and filter at the call site
 * where `src/lib/api/`'s single-import rule wants them.
 */
export type PagedQuery<Row> = (from: number, to: number) => PromiseLike<PagedResult<Row>>;

/**
 * Read every row `makeQuery` can return, paging to exhaustion.
 *
 * Throws a `SchedulerError` (never returns a partial list) when a page errors
 * or when the read crosses `FETCH_ALL_MAX_PAGES`. Returns the concatenated rows
 * in the order the pages returned them — which is `makeQuery`'s own `.order(...)`,
 * because `.range()` slices an already-ordered list.
 */
export async function fetchAll<Row>(makeQuery: PagedQuery<Row>): Promise<Row[]> {
  const pageSize = POSTGREST_MAX_ROWS;
  const out: Row[] = [];

  for (let page = 1; ; page += 1) {
    if (page > FETCH_ALL_MAX_PAGES) {
      // ⛔ REFUSE, do not return `out`. The rows gathered so far are a partial
      // list, and handing one back as if whole is precisely what this file
      // forbids. Routed through `toSchedulerError(new Error(...))` — the same
      // shape audit.ts uses for its own request-size refusal — so it arrives at
      // the screen as a typed SchedulerError and reads as "Something went
      // wrong", not as a short catalogue.
      throw toSchedulerError(
        new Error(
          `fetchAll: read did not exhaust within ${FETCH_ALL_MAX_PAGES} pages of ` +
            `${pageSize} (${FETCH_ALL_MAX_PAGES * pageSize} rows); refused rather than ` +
            `returning a partial list`,
        ),
      );
    }

    const from = (page - 1) * pageSize;
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) throw toSchedulerError(error);

    const rows = data ?? [];
    for (const row of rows) out.push(row);

    // A short page is the end of the list. A full page might be the end or the
    // ceiling, so we cannot stop on it — we ask for the next one, which is what
    // turns "exactly 1000 then 0" into 1000 rather than a guess.
    if (rows.length < pageSize) break;
  }

  return out;
}
