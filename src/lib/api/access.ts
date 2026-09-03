/**
 * One typed wrapper over migration `20260826000019_scoped_roles.sql`'s
 * `app_is_admin_anywhere()`.
 *
 * ⚠️ THIS ANSWERS A VISIBILITY QUESTION AND NOTHING ELSE. It is true for a
 * company admin OR for anyone holding a `role = 'admin'` grant on any node,
 * which is exactly the set of people for whom the admin screen is not a dead
 * end. **It never authorises a write.** Every admin RPC re-asks the real
 * question against the specific node or structure being changed
 * (`app_is_admin_for`, `app_is_admin_for_template`), and migration 0019's
 * case S14 exists to pin that this predicate cannot stand in for them. A
 * caller that used this to decide whether to show a Save button would be
 * showing one that the server then refuses.
 *
 * Quoted from `src/lib/database.types.ts`, so the argument shape is read
 * rather than predicted (doc-drift rule 2 / brief rule 12):
 *
 *     app_is_admin_anywhere: { Args: never; Returns: boolean }
 *
 * FAILS CLOSED. A PostgREST error resolves to `false` rather than throwing:
 * the only consumer is a nav link and a route guard, and the honest fallback
 * for "we could not ask" is "do not show it". A company admin is unaffected
 * either way, because `adminAccess` answers them from their profile role
 * without needing this at all.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so it is not runnable under
 * `node --experimental-strip-types` in the design container. `tsc` and
 * `eslint` do cover it.
 */
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";
import type { DateFormat } from "@/lib/format/dates";
import { toSchedulerError } from "./errors";

export async function fetchAdminAnywhere(): Promise<boolean> {
  const { data, error } = await supabase.rpc("app_is_admin_anywhere");
  if (error) return false;
  return data === true;
}

/* ===========================================================================
 * Migration `20260826000021_site_membership.sql` — "who can get in".
 *
 * Three wrappers. Signatures quoted from `src/lib/database.types.ts` so the
 * argument shapes are READ rather than predicted (doc-drift rule 2 / brief
 * rule 12):
 *
 *     site_people:        { Args: { p_node_id: string };                                   Returns: Json }
 *     set_site_member:    { Args: { p_node_id: string; p_profile_id: string; p_role: string }; Returns: Json }
 *     remove_site_member: { Args: { p_node_id: string; p_profile_id: string };             Returns: Json }
 *
 * ⚠️ THESE THREE FAIL **OPEN** — i.e. they THROW — while `fetchAdminAnywhere`
 * above fails closed, and the difference is deliberate. That one answers a
 * visibility question whose honest fallback is "do not show it". These are the
 * screen's content and its writes: a read that could not happen must reach the
 * user as an error, not as an empty list of colleagues, and a write that could
 * not happen must never look like it worked.
 *
 * ⚠️ AND `fetchSitePeople` RETURNS `unknown` ON PURPOSE. Every other read in
 * this layer runs its payload through a `parseXResult` guard and throws
 * `shapeMismatch` — right for a single row whose absence is an error, wrong
 * for a LIST a screen renders, where one malformed entry must not blank the
 * panel. The guard is `buildAccessRows` in
 * `src/features/admin/lib/siteAccess.ts`: pure, never throws, skips what it
 * cannot read and reports how many it skipped. Keeping it there is also what
 * makes it unit-testable without a network — this file is not runnable under
 * `node --experimental-strip-types` because it imports `@/lib/supabase`.
 * =========================================================================== */

/** The role a grant carries. Mirrors `profile_grants_role_check` (0019). */
export type SiteMemberRole = "admin" | "supervisor" | "viewer";

export interface SetSiteMemberInput {
  nodeId: string;
  profileId: string;
  role: SiteMemberRole;
}

export interface RemoveSiteMemberInput {
  nodeId: string;
  profileId: string;
}

/**
 * `site_people(p_node_id uuid)`. Raises: `invalid_argument` (no such node),
 * `not_permitted` (you do not administer this place).
 *
 * The payload is handed on unparsed — see the block comment above.
 */
export async function fetchSitePeople(nodeId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc("site_people", { p_node_id: nodeId });
  if (error) throw toSchedulerError(error);
  return data;
}

/**
 * `set_site_member(p_node_id, p_profile_id, p_role)`. Adds the person or
 * changes the role they already hold there — one row either way, because
 * `profile_grants` is keyed `(profile_id, node_id)`.
 *
 * Raises: `invalid_argument` (no such node, carrying `node_id`; no such
 * person, carrying `profile_id`; unknown or null role, carrying
 * `field: "role"`), `not_permitted` (not your place; or your own admin access
 * here).
 */
export async function setSiteMember(input: SetSiteMemberInput): Promise<void> {
  const { error } = await supabase.rpc("set_site_member", {
    p_node_id: input.nodeId,
    p_profile_id: input.profileId,
    p_role: input.role,
  });
  if (error) throw toSchedulerError(error);
}

/**
 * `remove_site_member(p_node_id, p_profile_id)`. Removes the grant sitting on
 * this exact node.
 *
 * Raises: `invalid_argument` (no such node; nothing here to remove),
 * `not_permitted` (not your place; or your own admin access here).
 *
 * ⚠️ The return value is DISCARDED, and that is not laziness. A refused
 * DELETE under RLS is a silent no-op, which is the whole reason this is an
 * RPC — but the loudness comes from the server's pre-check raising, not from
 * anything this wrapper could inspect. Migration 0021 §5 records that its own
 * post-write outcome check was deleted for being unreachable; reading the
 * payload back here to "confirm" would be that same dead code one layer up.
 */
export async function removeSiteMember(input: RemoveSiteMemberInput): Promise<void> {
  const { error } = await supabase.rpc("remove_site_member", {
    p_node_id: input.nodeId,
    p_profile_id: input.profileId,
  });
  if (error) throw toSchedulerError(error);
}

/* ===========================================================================
 * Which places may this caller WRITE to — the two halves of
 * `app_can_edit_node`, fetched so a screen can stop offering controls the
 * server will refuse (D114).
 *
 * ⭐⭐ IT LIVES HERE BECAUSE IT IS A READ, and `src/lib/api/` is the only
 * place allowed to know `supabase` exists. It was written inside
 * `features/admin/hooks/useEditRights.ts` first, with a comment saying it
 * should move the moment a second screen needed it — Operators is that second
 * screen, so it moved. **A deviation that names its own expiry condition is
 * worth honouring when the condition arrives**, rather than becoming the
 * second copy of a thing.
 *
 * ⚠⚠ THIS THROWS WHERE `fetchAdminAnywhere` SWALLOWS, and the difference is
 * deliberate. That one answers *should this screen exist*, whose honest
 * fallback is "no", so it fails closed to `false`. This one decides whether to
 * OFFER a control, and its honest fallback is "offer it and let the server
 * refuse" (`scope.ts`'s rule: hiding is invisible and permanent). **Returning
 * empty arrays on failure would be indistinguishable from a real answer of
 * "you hold no grants"** — the one result that must never be guessed, because
 * it silently removes every button on the screen.
 * ======================================================================== */

export interface GrantPaths {
  /** Paths covered by an ADMIN grant — arm (2) of `app_can_edit_node`. */
  adminPaths: string[];
  /** Paths covered by an admin OR supervisor grant — arm (3)'s second half. */
  writablePaths: string[];
}

/**
 * ltree over PostgREST, narrowed at the boundary.
 *
 * ⭐ MEASURED, NOT ASSUMED: called against the running stack as `ana` and
 * `marco`, `setof ltree` comes back as a plain JSON array of strings
 * (`["plant_a.area_1.line_1"]`). The generated types say `Returns: unknown[]`,
 * so the compiler cannot narrow it and something has to.
 *
 * ⚠️ A NON-STRING ENTRY IS SKIPPED, NOT THROWN ON. One malformed path must
 * not cost the reader every button on the screen — that is `parseArrayOf`'s
 * whole-array failure (§19.76) in a place where the blast radius is a screen
 * full of dead controls rather than a visible error.
 */
export function parseGrantPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is string => typeof p === "string" && p !== "");
}

export async function fetchGrantPaths(): Promise<GrantPaths> {
  // Both are already executable by `authenticated` (0019), so D114 needed no
  // migration to answer this question on the client.
  const [admin, writable] = await Promise.all([
    supabase.rpc("app_grant_paths_for", { p_roles: ["admin"] }),
    supabase.rpc("app_grant_paths", { require_edit: true }),
  ]);
  if (admin.error) throw toSchedulerError(admin.error);
  if (writable.error) throw toSchedulerError(writable.error);
  return {
    adminPaths: parseGrantPaths(admin.data),
    writablePaths: parseGrantPaths(writable.data),
  };
}

/* ===========================================================================
 * The org-wide settings bag — read for everyone, written by the system admin.
 *
 * `orgs.settings` (0001) is the flat jsonb that already carries `capacity_cap`
 * and `eligibility_policy`; migration 0037 added the ONE write function it never
 * had, for `date_format`. `orgs_select` (0008) returns the caller's own org row
 * to everyone, so the READ is a plain PostgREST select; the WRITE is an RPC
 * because a non-admin UPDATE is a silent zero-row no-op under `orgs_update`
 * (0037's header / api.md §4).
 *
 * ⚠️ THE READ THROWS, like `fetchSitePeople` and unlike `fetchAdminAnywhere`:
 * the format decides how every date on the screen reads, and a read that could
 * not happen must reach the caller as an error, not as a wrong default silently
 * applied. The DEFENSIVE fallback lives one layer up, in `coerceDateFormat`
 * (`src/lib/format/dates.ts`), which turns an absent or unknown key into the
 * default -- so a settings bag that has never had `date_format` set reads as the
 * default without this throwing.
 *
 * AUTHOR-ONLY — imports `@/lib/supabase`, so not runnable under
 * `node --experimental-strip-types`. `tsc`/`eslint` cover it.
 * ======================================================================== */

/** The caller's org settings bag (`orgs.settings`). Throws if the read fails. */
export async function fetchOrgSettings(): Promise<Json> {
  // `.single()` is right: `orgs_select` returns exactly the caller's own org.
  const { data, error } = await supabase.from("orgs").select("settings").single();
  if (error) throw toSchedulerError(error);
  return data.settings;
}

/**
 * `set_org_date_format(p_format)`. Sets the org-wide date-display format.
 * Raises: `not_permitted` (not a system admin), `invalid_argument` (unknown or
 * null token, carrying `field: "date_format"`).
 *
 * ⚠️ The returned settings are DISCARDED: the caller (`useOrgSettings`)
 * invalidates and refetches, and the loudness of a refusal comes from the
 * server RAISE, not from anything this wrapper could inspect — the same shape as
 * `setSiteMember`.
 */
export async function setOrgDateFormat(format: DateFormat): Promise<void> {
  const { error } = await supabase.rpc("set_org_date_format", { p_format: format });
  if (error) throw toSchedulerError(error);
}
