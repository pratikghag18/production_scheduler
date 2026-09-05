/**
 * The audit log — the read half.
 *
 * `src/lib/api/` is the ONLY place allowed to touch `supabase`, snake_case
 * column names, or `database.types.ts` (docs/conventions.md). Everything past
 * this file works in camelCase and never learns that `table_name` exists.
 *
 * ⭐⭐ THERE IS NO WRITE HERE AND THERE NEVER WILL BE. `audit_log` has a SELECT
 * policy and no write policy at all (0008): rows arrive only through the
 * SECURITY DEFINER `write_audit_log()` trigger, which runs as the table owner
 * and bypasses RLS. A client that could insert into this table could forge
 * history, so the surface is deliberately one function wide.
 *
 * ⭐⭐ THE READER IS A COMPANY ADMIN AND ONLY A COMPANY ADMIN.
 * `audit_log_select` is
 *
 *     app_is_admin() and org_id = app_current_org()
 *
 * and `app_is_admin()` is `user_profiles.role = 'admin'` for the caller's own
 * profile (0018) — the ORG-WIDE role. A SITE admin carries the org-wide role
 * `viewer` plus an admin GRANT, so `app_is_admin()` is FALSE for them and this
 * read returns ZERO ROWS: not an error, not a refusal, an empty list that reads
 * exactly like "nothing has ever changed here". `AdminPage`'s `companyAdminOnly`
 * flag and `AuditPanel`'s own gate both test `profile.role === "admin"`, which
 * is the same predicate — see `auditAccess.test.tsx`.
 *
 * ⚠️⚠️ THE THOUSAND-ROW CEILING IS REAL AND THIS IS THE FIRST TABLE TO MEET IT.
 * PostgREST caps every response at `max_rows = 1000`, and before this file there
 * was no `.range(` and no `.limit(` paging anywhere in `src/lib/api/` — every
 * other read is of a catalogue with a natural, small size. An audit log has no
 * such size: it grows by one row per write, forever. A screen that fetched
 * "everything" would show the newest thousand changes and call it the history,
 * and would keep saying that for the rest of the product's life.
 *
 * ⚠️ SO IT IS KEYSET-PAGED, NOT OFFSET-PAGED, and the difference matters here
 * more than almost anywhere. `.range(n, m)` counts from the top of a list whose
 * top MOVES: a change landing while somebody reads shifts every later row down
 * one, so page 2 repeats a row and page 3 skips one. `id` is
 * `bigint GENERATED ALWAYS AS IDENTITY` — monotonic, unique, and the primary
 * key — so `id < cursor` is a boundary that cannot move.
 *
 * ⚠️ ORDERED BY `id`, NOT BY `at`. They agree in practice (`at` defaults to
 * `now()`), but `at` is the transaction's start time: two rows written in one
 * transaction share it exactly, and a tie has no stable cursor. `id` breaks
 * every tie by construction. (The `(org_id, at DESC)` index is therefore not the
 * one serving this query; at this table's size the primary key is ample, and a
 * matching index is a migration to add if the log ever grows enough to need it.)
 *
 * ⭐⭐ AND THE PAGE IS NARROWED BY THE SERVER, NOT BY THE SCREEN. `AuditFilter`
 * puts the period, the action and the table into the query itself, so a page is
 * fifty MATCHES rather than fifty rows the browser then throws most of away.
 * The measured `at` index (`audit_log_org_at_idx`) serves the period bound; the
 * ordering is still `id`, and the two never interfere because one is a
 * predicate and the other is a boundary. What this bought is not only round
 * trips: a filtered `hasMore` means *"older MATCHES exist"*, which is a fact
 * the screen can print an answer from, and a period with BOTH ends — "August",
 * "yesterday" — becomes expressible where before it could not be finished at
 * all.
 */
import { supabase } from "@/lib/supabase";
import { toSchedulerError } from "./errors";

/**
 * The three values `audit_log_action_check` allows (0007).
 *
 * Named so the FILTER below can be typed on it: a caller cannot ask the server
 * for an action the CHECK constraint forbids without `tsc` saying so.
 */
export type AuditAction = "insert" | "update" | "delete";

/** One recorded change, as the screen needs it. */
export interface AuditEntry {
  /** The paging cursor as well as the identity — see the header. */
  id: number;
  /** ISO timestamptz. */
  at: string;
  /** `auth.uid()` at write time. NULL for a seed or server-side write. */
  actorId: string | null;
  tableName: string;
  rowId: string;
  action: AuditAction;
  /** The whole row as it was. NULL on an insert. */
  before: Record<string, unknown> | null;
  /** The whole row as it became. NULL on a delete. */
  after: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /**
   * Whether older MATCHING changes exist beyond this page — measured, not
   * guessed.
   *
   * ⭐⭐ "MATCHING" IS THE WORD THAT CHANGED, AND THE SCREEN'S HONESTY RESTS ON
   * IT. While the filter was applied to rows already fetched, this meant "the
   * log has more rows" and said nothing about whether any of them could match;
   * the Activity panel therefore had to PROVE completeness itself, by reading
   * past the period's edge and arguing from the ordering. Now that the query
   * carries the filter, `false` here means the server found no older row that
   * satisfies it — which is the whole of the proof, for any period, bounded or
   * not.
   */
  hasMore: boolean;
}

/**
 * How a read is narrowed. Every field is optional and an absent one narrows
 * nothing, so `fetchAuditPage(cursor)` is exactly the read it always was.
 *
 * ⛔⛔ THIS IS NARROWING AND IT IS NOT AUTHORISATION. `audit_log_select` is
 * `app_is_admin() AND org_id = app_current_org()` and RLS has already decided
 * which rows exist for this caller before any of these clauses is looked at. A
 * filter is a convenience for a reader; nothing here may ever be relied on to
 * keep a row away from somebody, and a bug in this function can only ever show
 * a company admin too many of their OWN company's rows.
 */
export interface AuditFilter {
  /** Inclusive lower bound on `at`, ISO. Absent means "back to the beginning". */
  since?: string | null;
  /**
   * EXCLUSIVE upper bound on `at`, ISO. Absent means "up to now".
   *
   * ⚠️ EXCLUSIVE ON PURPOSE. Two adjacent periods (yesterday / today) must not
   * both claim the instant on their shared boundary, or one change appears in
   * both and every count is one out on the day it lands at midnight.
   */
  until?: string | null;
  /** Restrict to these actions. Absent or EMPTY restricts nothing — see below. */
  actions?: readonly AuditAction[] | null;
  /** Restrict to these `table_name`s. Absent or EMPTY restricts nothing. */
  tables?: readonly string[] | null;
  /**
   * ⭐⭐ THE PLACES THAT ARE **NOT** THE PLANT BEING SHOWN — every readable node
   * id outside the chosen plant's subtree. Absent or EMPTY restricts nothing,
   * which is exactly "All plants".
   *
   * ⚠️⚠️ IT IS THE COMPLEMENT, AND THAT IS THE WHOLE DESIGN. See
   * `buildPlaceClause` for why sending the plant's OWN ids would quietly delete
   * a third of this database's history.
   */
  elsewhere?: readonly string[] | null;
}

/* ===========================================================================
 * WHICH PLANT A RECORDED CHANGE HAPPENED IN.
 *
 * ⭐⭐ `audit_log` HAS NO PLACE COLUMN. Its nine columns are `id, org_id,
 * actor_id, table_name, row_id, action, before, after, at` — the place, when
 * there is one at all, is a key INSIDE the jsonb snapshot, and which key it is
 * depends on the table:
 *
 *     assignments (73)      node_id           in the snapshot
 *     runs        (55)      node_id
 *     operators   (46)      site_node_id
 *     skills      (19)      site_node_id
 *     shift_templates (8)   site_node_id
 *     products    (31)      ⛔ NOTHING AT ALL
 *
 * ⭐⭐ AND `products` CANNOT BE ATTRIBUTED, EVER. Migration 0034 deliberately
 * removed `products.site_node_id`; a product belongs to its plants through the
 * separate `product_sites` table, which the snapshot does not carry — and for a
 * DELETED product the links are gone as well. There is no query, however
 * clever, that places a product's audit row in a plant.
 *
 * ⭐⭐⭐ WORSE, AND MEASURED RATHER THAN IMAGINED: **64 of the 201 attributable
 * rows in the live database name a node that no longer exists.** A seed rebuild
 * or a deleted line leaves the audit row behind — that is the point of an audit
 * log — pointing at an id `nodes` can no longer resolve. Nobody can say which
 * plant those changes happened in either.
 *
 * ⭐⭐⭐ SO THE CLAUSE IS WRITTEN AS A COMPLEMENT: **hide a change only when
 * every place it names is a place this company still has, and none of them is
 * in the chosen plant.** Everything else is shown — changes in the plant,
 * changes that name no place at all, and changes naming a place that has since
 * been removed. The maintainer's rule for a log, and the rule `scope.ts` and
 * `rowsInPlant` already keep everywhere else: *"I cannot tell" must never
 * become "hidden"*, because over-showing is a nuisance and hiding is deleting
 * evidence.
 *
 * ⚠️ THE OBVIOUS VERSION IS THE WRONG ONE. Sending the plant's OWN node ids —
 * `after->>node_id.in.(…the plant…)` plus "carries no place at all" — reads
 * better and is a lie: every one of those 64 rows falls out of every plant's
 * view at once, silently, under a footer claiming the whole log had been
 * searched.
 * ======================================================================== */

/**
 * The keys a snapshot can carry a place in.
 *
 * ⚠️ IN ONE PLACE BECAUSE IT APPEARS FOUR TIMES IN THE QUERY (CLAUDE.md §4: a
 * column list that appears twice is a bug with a delay on it). A seventh
 * audited table arriving with a third key name is one edit here and the clause,
 * the guard and `entryPlaceIds` all move together.
 */
export const PLACE_KEYS: readonly string[] = ["node_id", "site_node_id"];

/** The two jsonb columns a snapshot lives in. An insert has only `after`, a
 *  delete only `before`, an update both — so both are always tested. */
export const SNAPSHOT_COLUMNS: readonly string[] = ["after", "before"];

/**
 * Every `<snapshot>->><key>` path the clause tests, built from the two lists
 * above so a third key or a third snapshot column cannot be added to one and
 * forgotten in the other.
 */
export const PLACE_PATHS: readonly string[] = SNAPSHOT_COLUMNS.flatMap((col) =>
  PLACE_KEYS.map((key) => `${col}->>${key}`),
);

/**
 * Every place id this entry names, from either snapshot.
 *
 * The SCREEN's half of the same question the clause asks the server: a row for
 * which this returns nothing that the reader can resolve is a row that cannot
 * be placed, and the panel marks it as such. Lives here rather than in
 * `auditView` because `src/lib/api/` is the only place allowed to know that
 * `site_node_id` is spelled that way (docs/conventions.md).
 */
export function entryPlaceIds(entry: AuditEntry): string[] {
  const out: string[] = [];
  for (const snap of [entry.after, entry.before]) {
    if (snap === null) continue;
    for (const key of PLACE_KEYS) {
      const v = snap[key];
      if (typeof v === "string" && v !== "" && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/**
 * How long the place clause is allowed to get.
 *
 * ⛔⛔ THIS IS A MEASURED CEILING, NOT A ROUND NUMBER. Supabase serves
 * PostgREST behind Kong, whose request line caps at 8 KB, and this clause
 * repeats the id list once per path in `PLACE_PATHS`. Measured against the
 * running stack, with the WHOLE of a real page request beside it — the eight
 * columns, the order, the limit, both period bounds, the action list and the
 * table list — a clause of 7328 characters is served and one of 7624 comes back
 * **414 URI Too Long**. A 414 is a failed read, which this screen already
 * renders honestly; but it is a failure a size check can see coming, and a
 * reader is better told the filter could not be applied than shown a read
 * error under a header still naming one plant.
 *
 * ⚠️ THE BUDGET IS ON THE CLAUSE, NOT ON A NUMBER OF NODES, because what the
 * server rejects is a length. 6800 sits 528 characters below the largest
 * request measured to work.
 *
 * ⚠️⚠️ AND IT IS A REAL LIMIT ON THIS FEATURE, WORTH SAYING OUT LOUD. It works
 * out at roughly 44 places OUTSIDE the chosen plant; the live database's four
 * plants each leave 36, so this is comfortable today and not by a wide margin.
 * The durable fix is a place column on `audit_log`, written by
 * `write_audit_log` — one indexed `in` on one column instead of four id lists —
 * which is a migration and therefore a decision for the maintainer rather than
 * one to take here.
 */
export const PLACE_CLAUSE_BUDGET = 6800;

/**
 * The PostgREST `or=` logic tree that narrows the log to one plant.
 *
 * `elsewhere` is every readable node id **outside** the chosen plant. Returns
 * `null` when there is nothing to narrow.
 *
 * The shape, for `PLACE_PATHS` = `[a, b, c, d]`:
 *
 *     or( a.not.in.(…), b.not.in.(…), c.not.in.(…), d.not.in.(…),
 *         and( a.is.null, b.is.null, c.is.null, d.is.null ) )
 *
 * ⭐ READ IT AS: *shown if any place it names is not somewhere else, or if it
 * names no place at all.*
 *
 * ⚠️⚠️ THE `is.null` BRANCH IS NOT BELT-AND-BRACES AND SQL IS THE REASON.
 * `NULL NOT IN (…)` is NULL, not TRUE, so an absent key contributes **false**
 * to the four `not.in` tests — which is exactly right for a row that names a
 * place in one column and nothing in the other three, and exactly wrong for a
 * products row, which names nothing anywhere and would otherwise vanish from
 * every plant. The `and(…is.null)` branch is the whole of what keeps those 31
 * rows on screen.
 *
 * ⚠️ A CHANGE THAT MOVED SOMETHING BETWEEN PLANTS APPEARS UNDER BOTH. `before`
 * places it where it was and `after` where it went, and either one being "not
 * elsewhere" is enough. That is deliberate: "this person left Plant B" is a
 * Plant B change and "this person arrived in Plant A" is a Plant A change, and
 * they are the same row.
 *
 * ⚠️ IDS ARE SENT UNQUOTED. A uuid holds only hex and hyphens — none of
 * PostgREST's reserved characters — so quoting would cost four encoded bytes
 * per id against a ceiling this clause is already pressing on. `assertUuids`
 * is what makes that safe rather than merely true today.
 */
export function buildPlaceClause(elsewhere: readonly string[] | null | undefined): string | null {
  const ids = restriction(elsewhere);
  if (ids === null) return null;
  const list = [...ids].join(",");
  const outside = PLACE_PATHS.map((p) => `${p}.not.in.(${list})`);
  const nowhere = `and(${PLACE_PATHS.map((p) => `${p}.is.null`).join(",")})`;
  return `${outside.join(",")},${nowhere}`;
}

/** Whether the clause for this list fits under the measured ceiling. The panel
 *  asks BEFORE it asks the server, so it can say what it could not do. */
export function placeFilterFits(elsewhere: readonly string[] | null | undefined): boolean {
  const clause = buildPlaceClause(elsewhere);
  return clause === null || clause.length <= PLACE_CLAUSE_BUDGET;
}

/** A uuid, and nothing that could carry a comma or a paren into the clause. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The columns every read below selects, in one place so they cannot drift.
 *
 * Exported so `apiAuditShape.test.ts` can hold it against `parseAuditEntry`:
 * the two halves of a read are a column list and a guard, and when they drift
 * every row is rejected quietly and the screen renders empty. Empty is a
 * LEGITIMATE state for an audit log on a fresh org, which makes that drift
 * quieter here than anywhere it has bitten before.
 */
export const AUDIT_COLUMNS = "id, at, actor_id, table_name, row_id, action, before, after";

/**
 * How many changes one page carries.
 *
 * Well under PostgREST's `max_rows = 1000`, deliberately: a page at or above the
 * ceiling would be truncated BY THE SERVER, and a server-truncated page is
 * indistinguishable from the end of the log — the exact misrepresentation the
 * paging exists to prevent. Fifty is about a screenful of a dense table.
 */
export const AUDIT_PAGE_SIZE = 50;

/** The same three, as a runtime guard — `AuditAction` is not one at runtime. */
const ACTIONS: ReadonlySet<string> = new Set<AuditAction>(["insert", "update", "delete"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `before`/`after` are jsonb of a TABLE ROW, so anything that is not an object
 * cannot be walked field by field. Normalised to null rather than thrown on: one
 * odd snapshot must not blank a page of perfectly readable history.
 */
function asSnapshot(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/**
 * The shape guard: one raw row in, an `AuditEntry` or `null` out.
 *
 * Returns `null` rather than throwing — the caller is a list one malformed row
 * must not take down. `id` and `action` are the two hard requirements: `id` is
 * the paging cursor (a row without a usable one would break the "load older"
 * chain rather than merely render oddly), and an action outside the three the
 * CHECK constraint allows has no rendering at all.
 */
export function parseAuditEntry(row: unknown): AuditEntry | null {
  if (!isRecord(row)) return null;
  const { id, at, actor_id, table_name, row_id, action, before, after } = row;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (typeof at !== "string" || typeof table_name !== "string" || typeof row_id !== "string") {
    return null;
  }
  if (typeof action !== "string" || !ACTIONS.has(action)) return null;
  // ⚠️ NULL IS A REAL AND COMMON ACTOR. `audit_current_actor()` degrades to NULL
  // for a seed or server-side write (0007's own comment) and the live table has
  // such rows; rejecting them would hide changes from the one screen that exists
  // to show them.
  if (actor_id !== null && typeof actor_id !== "string") return null;
  return {
    id,
    at,
    actorId: actor_id,
    tableName: table_name,
    rowId: row_id,
    action: action as AuditEntry["action"],
    before: asSnapshot(before),
    after: asSnapshot(after),
  };
}

/**
 * A list to narrow on, or `null` when it would narrow nothing.
 *
 * ⚠️⚠️ AN EMPTY LIST MEANS "NO RESTRICTION" HERE, AND THE CHOICE IS DELIBERATE.
 * `.in(col, [])` renders as `col=in.()`, which matches no row at all — so an
 * empty array arriving by accident (a `.filter()` that removed everything, a
 * state that has not loaded) would empty the one screen whose entire job is to
 * show that things happened, under a footer that would then say the search was
 * complete. Widening is the recoverable direction: the reader sees more than
 * they asked for and can see that they did.
 */
function restriction<T>(values: readonly T[] | null | undefined): readonly T[] | null {
  return values !== null && values !== undefined && values.length > 0 ? values : null;
}

/**
 * A timestamp bound to send, or `null` when there is nothing to send.
 *
 * ⚠️ A BLANK IS NOT A BOUND. `at=gte.` reaches Postgres as an empty string and
 * comes back `22007 invalid input syntax for type timestamp with time zone` —
 * a 400 on the whole page, so an unset bound arriving as "" would not narrow
 * the log, it would EMPTY the screen and print a read failure over it.
 */
function bound(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * One page of MATCHING changes, newest first.
 *
 * `beforeId` is the cursor: `null` for the newest page, otherwise the `id` of
 * the oldest row already on screen. See the header for why this is keyset rather
 * than `.range()`.
 *
 * ⭐⭐ THE FILTER IS APPLIED HERE, BY THE SERVER, AND THAT IS WHAT MAKES THE
 * SCREEN ABOVE HONEST CHEAPLY. Filtered in the browser, fifty rows read might
 * hold three matches and say nothing whatever about the rest of the log, so the
 * panel had to keep a scan and a match apart and reason its way to the word
 * "all". With the clauses in the query, a page is fifty MATCHES and `hasMore`
 * answers the only question the footer ever needed to ask.
 *
 * ⚠️ THE CURSOR AND THE FILTER ARE INDEPENDENT, and it matters that they are.
 * The ordering is by `id` alone; the filter is a predicate on rows, not on the
 * ordering. So `id < cursor` still names exactly the rows already shown,
 * however the `at` bounds fall — including the case the OLD proof quietly
 * assumed away, where two rows written in one transaction share an `at` and a
 * row inside the period sits BELOW one outside it.
 *
 * ⚠️ IT ASKS FOR ONE MORE ROW THAN IT RETURNS. `hasMore` is then a fact about
 * the database rather than a guess from "the page came back full" — which is
 * wrong exactly once, at the boundary where the matching set's size is a
 * multiple of the page size, and wrong in the direction that offers a button
 * fetching nothing.
 *
 * ⚠️ AND THE LIMIT STAYS ON A FILTERED READ. PostgREST caps a response at
 * `max_rows = 1000`; a narrow filter is the tempting place to drop the paging
 * ("it only returns a handful"), and the day it does not, the server truncates
 * the page and the screen calls that the end of the log.
 */
export async function fetchAuditPage(
  beforeId: number | null = null,
  filter: AuditFilter = {},
): Promise<AuditPage> {
  let query = supabase
    .from("audit_log")
    .select(AUDIT_COLUMNS)
    .order("id", { ascending: false })
    .limit(AUDIT_PAGE_SIZE + 1);
  if (beforeId !== null) query = query.lt("id", beforeId);
  const since = bound(filter.since);
  if (since !== null) query = query.gte("at", since);
  const until = bound(filter.until);
  if (until !== null) query = query.lt("at", until);
  const actions = restriction(filter.actions);
  if (actions !== null) query = query.in("action", [...actions]);
  const tables = restriction(filter.tables);
  if (tables !== null) query = query.in("table_name", [...tables]);

  /* ⭐⭐ THE PLANT, IN THE QUERY LIKE EVERYTHING ELSE. A plant filter applied to
     rows already fetched would put back precisely the lie R-330 removed: a page
     is fifty MATCHES, so `hasMore` means "older MATCHES exist" and the footer's
     "all" stays a fact about the filtered set rather than an argument about
     ordering. Narrowing here changes nothing about that proof — it is one more
     predicate on rows, and the cursor is still a boundary on `id`. */
  const elsewhere = restriction(filter.elsewhere);
  if (elsewhere !== null) {
    /* ⛔ EVERY ID IS CHECKED BEFORE IT IS INTERPOLATED. Unlike `.in()`, which
       postgrest-js escapes for us, this clause is a STRING we build; a value
       carrying a comma or a paren would not inject a row into anyone's result
       (RLS decided that long before this predicate is read) but it would
       silently rewrite the logic tree into a different question. Refusing is
       loud; a quietly different filter is not. */
    for (const id of elsewhere) {
      if (!UUID.test(id)) {
        throw toSchedulerError(new Error(`audit place filter: ${id} is not a node id`));
      }
    }
    /* ⛔ AND AN OVER-LONG LIST IS REFUSED RATHER THAN DROPPED. Silently sending
       an unnarrowed read would hand the screen a page of the whole company
       under a header naming one plant — the exact failure this filter exists to
       fix. `placeFilterFits` is exported so the caller can ask first and say
       what it could not do; reaching this line is a bug, and it is loud. */
    if (!placeFilterFits(elsewhere)) {
      throw toSchedulerError(
        new Error(
          `audit place filter: ${elsewhere.length} places is past the request-size ceiling`,
        ),
      );
    }
    const clause = buildPlaceClause(elsewhere);
    if (clause !== null) query = query.or(clause);
  }

  const { data, error } = await query;
  if (error) throw toSchedulerError(error);

  const rows = data ?? [];
  const hasMore = rows.length > AUDIT_PAGE_SIZE;
  const entries: AuditEntry[] = [];
  for (const row of rows.slice(0, AUDIT_PAGE_SIZE)) {
    const parsed = parseAuditEntry(row);
    if (parsed !== null) entries.push(parsed);
  }
  return { entries, hasMore };
}

/*
 * ⚠️ `fetchAuditActors()` USED TO SIT HERE AND IS GONE. It read
 * `user_profiles(user_id, role)` and returned one role per account -- the
 * whole of what the Who column could say before migration 0046, which is why
 * it said "Supervisor · 0000a2" at a reader who wanted a person.
 * `fetchActorIdentities()` below returns that same role AND the address, so
 * this was strictly the poorer half of one read. Removed in the same commit
 * as the screen moved across, rather than left behind as the narrower of two
 * functions that look interchangeable -- which is the trap `renameSkill` had
 * been sitting in until earlier today.
 */

/* ===========================================================================
 * WHO, PROPERLY — `audit_actor_identities()` (migration 0046, R-329).
 *
 * ⭐ THE DECISION IT SERVES: *"the who needs to show a user, it is currently not
 * that helpful."* Before this the screen could render `You`, `System`, or
 * `Supervisor · 0000b2` — a role and six characters of a uuid — because
 * `user_profiles` carries `id, org_id, user_id, role, default_create_mode,
 * created_at, updated_at` and **no name and no address**.
 *
 * ⚠️ THE IDENTITY IS AN EMAIL BECAUSE IT IS THE ONLY ONE THAT EXISTS. There is
 * nowhere in this schema to put a person's name; that is a schema question,
 * raised with the maintainer separately and deliberately not invented here. The
 * address lives in `auth.users`, which PostgREST does not expose, so this is an
 * RPC and could not have been anything else.
 *
 * ⛔⛔ IT IS A NARROWER DOOR THAN IT LOOKS, AND THAT IS THE WHOLE DESIGN. 0046
 * is gated on `app_is_admin() AND org_id = app_current_org()` — the SAME
 * predicate as `audit_log_select`, so it can name exactly the people whose
 * changes the caller can already read and nobody else. A SITE admin (org-wide
 * `viewer` plus an admin GRANT) fails `app_is_admin()` and is REFUSED with
 * `not_permitted` rather than handed an empty list: a refusal that reads as
 * "nobody works here" would be indistinguishable from a broken call.
 * `69_actor_identities_test.sql` proves the gate from outside.
 *
 * ⭐ SO THE MAP HOLDS AN OBJECT, NOT A STRING, and that is the one thing in this
 * file worth defending. The identity that is coming is a real name; when a
 * `display_name` column lands it becomes one more expression in 0046 and one
 * more optional field on `ActorIdentity`, with no change to this function's
 * signature, no change to the Map it returns, and no change to any caller that
 * already reads `.email`. A `Map<string, string>` of addresses would have to be
 * rewritten everywhere on that day.
 *
 * ⭐⭐ AND THAT DAY WAS THE NEXT ONE — migration 0047, R-330. The maintainer:
 * *"add display_name to user_profiles too."* The promise above was kept
 * exactly: `fetchActorIdentities()` has the same signature, `actorIdentityMap`
 * returns the same Map, `AuditPanel` reads `.email` unchanged, and the diff on
 * this side is one column in `ACTOR_IDENTITY_COLUMNS`, one field on
 * `ActorIdentity` and two lines in the guard.
 *
 * ⚠️ WHICH ONE THE SCREEN SAYS IS NOT DECIDED HERE. This file reports what the
 * server knows; `describeActor` picks (name, then address, then role-and-tail)
 * and is the single place that argument lives.
 * ======================================================================== */

/**
 * What the app knows about one account.
 *
 * ⚠️ `email` IS NULLABLE AND `database.types.ts` DISAGREES. The generated type
 * says `email: string`, because `supabase gen types` cannot tell that a column
 * of a `RETURNS TABLE` may come back NULL. `auth.users.email` has no NOT NULL
 * constraint — a phone-only signup carries none — and 0046 lists such a person
 * anyway rather than shrinking the company. So the declaration here is the
 * honest one, `parseActorIdentity` is what makes it true, and `tsc` is no help
 * on either.
 */
export interface ActorIdentity {
  /** The org-wide role from `user_profiles`, the screen's fallback label. */
  role: string;
  /** `auth.users.email`, or null when the account has no address. */
  email: string | null;
  /**
   * `user_profiles.display_name` (0047), or null when nobody has named this
   * person.
   *
   * ⚠️⚠️ NULL IS THE NORMAL VALUE TODAY, NOT AN EDGE. 0047 adds the column and
   * NO WRITER: `user_profiles_update` is `app_is_admin() AND org_id =
   * app_current_org()`, which would let an admin name everybody and let nobody
   * name themselves, so the write was deliberately left for the maintainer to
   * decide. Every row in every live database is null until then, and the same
   * F-085 lie applies as to `email` — the generated type says `string`.
   */
  displayName: string | null;
}

/**
 * The columns `audit_actor_identities()` returns, in one place so they cannot
 * drift from the guard below — the same discipline, and the same reason, as
 * `AUDIT_COLUMNS`. Exported for `apiAuditShape.test.ts`.
 *
 * ⚠️ It is NOT passed to `.select()`; an RPC has no column list to send. It is
 * a written-down copy of migration 0047's `returns table (...)`, and a column
 * added there is added here in the same commit — which is what happened when
 * `display_name` landed. `69_actor_identities_test.sql` E12 reads the
 * function's declared result columns out of `pg_proc` and is the server-side
 * half of this pair.
 */
export const ACTOR_IDENTITY_COLUMNS = "user_id, role, email, display_name";

/**
 * A value that is a usable piece of text, or null.
 *
 * ⚠️ A BLANK IS NORMALISED AWAY, and that is the whole reason this is a
 * function rather than a `typeof` in two places. `describeActor` reads
 * "present" as "this is who it was", so an empty `display_name` would WIN the
 * precedence and render an empty Who cell — a present answer meaning nothing,
 * which is worse than the null it would have displaced. There is no CHECK
 * constraint on the column (migration 0047 says why: a form clearing a name
 * sends "" and should not get a 400 back), so this is where a blank stops.
 */
function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : v;
}

/**
 * One raw row in, an `ActorIdentity` or `null` out — the guard.
 *
 * `role` is required: it is NOT NULL server-side and it is the label the screen
 * falls back to, so a row without one has nothing left to say. `email` and
 * `display_name` are NORMALISED rather than required — null, undefined, a
 * blank and anything that is not a string all become `null`, which is the one
 * value every caller has to handle anyway.
 *
 * ⚠️ NEITHER IDENTITY COLUMN MAY REJECT A ROW. `display_name` is null on every
 * live row today (0047 adds the column and no writer) and `email` is null for a
 * phone-only signup; a guard that required either would empty the map and send
 * the Who column back to "Supervisor · 0000b2" for people the server can
 * perfectly well place.
 */
export function parseActorIdentity(row: unknown): ActorIdentity | null {
  if (!isRecord(row)) return null;
  const { role, email, display_name } = row;
  if (typeof role !== "string") return null;
  return { role, email: textOrNull(email), displayName: textOrNull(display_name) };
}

/**
 * Rows -> `auth.uid()` -> identity.
 *
 * ⚠️ KEYED ON `user_id`, NOT ON THE PROFILE ID. `audit_log.actor_id` is
 * `auth.uid()`; `user_profiles.id` is a different uuid entirely, and a map keyed
 * on it would never match a single row while looking perfectly healthy.
 *
 * ⚠️ A ROW IT CANNOT READ COSTS ONE NAME, NOT THE LIST — `fetchAuditPage`'s own
 * rule. This read decorates a column; the CHANGES are the screen. A non-list
 * payload yields an empty map for the same reason.
 */
export function actorIdentityMap(rows: unknown): Map<string, ActorIdentity> {
  const out = new Map<string, ActorIdentity>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { user_id } = row;
    if (typeof user_id !== "string") continue;
    const identity = parseActorIdentity(row);
    if (identity !== null) out.set(user_id, identity);
  }
  return out;
}

/**
 * Every account in the caller's company, by `auth.uid()`.
 *
 * Raises (via `toSchedulerError`): `not_permitted` when the caller is not a
 * COMPANY admin — see the block above for why that is a refusal and not an
 * empty map.
 *
 * ⚠️ THE CALLER MUST TREAT A FAILURE AS COSMETIC, as must the three name
 * lookups beside it: keep each in its own query, and render the list with names
 * missing rather than not at all. The CHANGES are the screen, and a log that
 * refused to draw because an address lookup returned 401 would be the worse
 * answer by a distance.
 */
export async function fetchActorIdentities(): Promise<Map<string, ActorIdentity>> {
  const { data, error } = await supabase.rpc("audit_actor_identities");
  if (error) throw toSchedulerError(error);
  return actorIdentityMap(data);
}
