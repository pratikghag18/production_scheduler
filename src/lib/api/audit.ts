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
 */
import { supabase } from "@/lib/supabase";
import { toSchedulerError } from "./errors";

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
  action: "insert" | "update" | "delete";
  /** The whole row as it was. NULL on an insert. */
  before: Record<string, unknown> | null;
  /** The whole row as it became. NULL on a delete. */
  after: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Whether older changes exist beyond this page — measured, not guessed. */
  hasMore: boolean;
}

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

/** The three values `audit_log_action_check` allows (0007). */
const ACTIONS: ReadonlySet<string> = new Set(["insert", "update", "delete"]);

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
 * One page of changes, newest first.
 *
 * `beforeId` is the cursor: `null` for the newest page, otherwise the `id` of
 * the oldest row already on screen. See the header for why this is keyset rather
 * than `.range()`.
 *
 * ⚠️ IT ASKS FOR ONE MORE ROW THAN IT RETURNS. `hasMore` is then a fact about
 * the database rather than a guess from "the page came back full" — which is
 * wrong exactly once, at the boundary where the log's size is a multiple of the
 * page size, and wrong in the direction that offers a button fetching nothing.
 */
export async function fetchAuditPage(beforeId: number | null = null): Promise<AuditPage> {
  let query = supabase
    .from("audit_log")
    .select(AUDIT_COLUMNS)
    .order("id", { ascending: false })
    .limit(AUDIT_PAGE_SIZE + 1);
  if (beforeId !== null) query = query.lt("id", beforeId);

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
