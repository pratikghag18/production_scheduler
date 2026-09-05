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

/**
 * `auth.uid()` -> org-wide role, for every account in the caller's company.
 *
 * ⚠️⚠️ THIS IS AS FAR AS THE CLIENT CAN GET TOWARDS "WHO", AND THE LIMIT IS THE
 * DATABASE'S. `user_profiles` carries `id, org_id, user_id, role,
 * default_create_mode, created_at, updated_at` — **no name and no address.** The
 * email lives in `auth.users`, which PostgREST does not expose; the one function
 * that reaches it (`site_people`, 0021) is keyed by a NODE and returns a PROFILE
 * id rather than a user id, so it cannot answer "who is `auth.uid()` X" even
 * indirectly. Naming actors properly needs a new SECURITY DEFINER function —
 * flagged to the maintainer, not invented here.
 *
 * ⚠️ THE POLICY MATCHES THE AUDIENCE EXACTLY. `user_profiles_select` is
 * `user_id = auth.uid() OR (app_is_admin() AND org_id = app_current_org())`, so
 * the company admin who can read the audit log can read every profile in it, and
 * nobody else gains anything from this call.
 *
 * ⚠️ THE CALLER MUST TREAT A FAILURE AS COSMETIC. This decorates the actor
 * column; the CHANGES are the screen. `AuditPanel` keeps it in its own query for
 * that reason — see the case that renders the list with this read rejected.
 */
export async function fetchAuditActors(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("user_profiles").select("user_id, role");
  if (error) throw toSchedulerError(error);
  const out = new Map<string, string>();
  for (const row of data ?? []) {
    if (typeof row.user_id === "string" && typeof row.role === "string") {
      out.set(row.user_id, row.role);
    }
  }
  return out;
}
